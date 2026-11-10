"""Слабые метки (OSM ∩ спектральные правила) + ручные полигоны → выборка → LightGBM → вероятности по чанкам."""
import json

import numpy as np
from rasterio import features as rfeatures
from scipy.ndimage import distance_transform_edt
from shapely.geometry import Polygon, box, shape

from . import context, features as FT
from .classes import C, MANUAL, NAMES, NCLS, OUT, Grid1m

CHUNK = 1000        # м
PER_CLASS_CHUNK = 2500
PER_CLASS_MAX = 120000
MANUAL_PER_CLASS_CHUNK = 6000    # ручные метки — точнее, их берём больше


def chunks(g):
    for y1 in np.arange(g.max_y, g.min_y, -CHUNK):
        for x0 in np.arange(g.min_x, g.max_x, CHUNK):
            x1, y0 = min(x0 + CHUNK, g.max_x), max(y1 - CHUNK, g.min_y)
            r0, c0 = int(round(g.max_y - y1)), int(round(x0 - g.min_x))
            yield float(x0), float(y0), float(x1), float(y1), r0, c0


def ctx_slice(ctx, r0, c0, h, w):
    return {k: v[r0:r0 + h, c0:c0 + w] for k, v in ctx.items()}


# ------------------------------------------------------------------ ручные метки
def load_manual(kind="train"):
    """data/landcover/manual_labels.json: [{"cls": имя, "rect": [x0, y0, x1, y1]} | {"cls", "poly": [[x, y], ...]}, ...]
    kind='val' → validation_points.json: [{"x", "y", "cls"}]."""
    f = MANUAL / ("manual_labels.json" if kind == "train" else "validation_points.json")
    if not f.exists():
        return []
    return json.loads(f.read_text())


def manual_raster(g, items, x0, y0, x1, y1):
    h, w = int(round(y1 - y0)), int(round(x1 - x0))
    from rasterio.transform import from_origin
    tr = from_origin(x0, y1, 1.0, 1.0)
    out = np.zeros((h, w), np.uint8)
    win = box(x0, y0, x1, y1)
    shapes = []
    for it in items:
        geo = box(*it["rect"]) if "rect" in it else Polygon(it["poly"])
        if not geo.intersects(win):
            continue
        code = 255 if it["cls"] == "none" else C[it["cls"]]
        shapes.append((geo, code))
    if shapes:
        out = rfeatures.rasterize(shapes, out_shape=(h, w), transform=tr, dtype="uint8")
    return out


# ------------------------------------------------------------------ слабые метки
def weak_labels(F, names, sl):
    f = {n: F[i] for i, n in enumerate(names)}
    M = sl["M"]
    B = context.B
    has = lambda *bits: (M & np.uint32(sum(B[b] for b in bits))) != 0
    inner = lambda m, d: distance_transform_edt(m) > d
    lab = np.zeros(M.shape, np.uint8)
    valid = f["valid"] > 0.99
    exg3, std5, lum, sat = f["y_exg_s3"], f["y_std5"], f["y_lum"], f["y_sat"]
    bld, road = has("bld"), has("road")
    near_hard = distance_transform_edt(~(bld | road)) < 2.5
    hgt = f["y_sh2"] + f["y_sh4"] + f["y_sh8"]
    # порядок: позже — главнее
    lab[has("wood", "park", "cemetery") & ~near_hard & (exg3 > 0.08) & ((std5 > 0.05) | (hgt > 0.25)) & (f["e_exg_s1"] > 0.2)] = C["canopy"]
    # хвойные: в OSM 1 полигон, на снимках почти не отделимы — класс не обучаем (кроны → canopy)
    lab[has("scrub") & ~near_hard & (exg3 > 0.08) & (hgt < 0.4)] = C["thicket"]
    lab[has("grassland") & ~has("wood", "scrub") & ~near_hard & (exg3 > 0.02) & (std5 < 0.035) & (hgt < 0.05)] = C["meadow"]
    lawnz = has("lawnpoly") | (has("pitch") & ~has("hard"))
    lab[lawnz & (sl["d_apt"] < 80) & ~near_hard & (exg3 > 0.05) & (std5 < 0.035) & (hgt < 0.05)] = C["lawn"]
    lab[has("allot") & ~near_hard & (exg3 < 0.03) & (f["y_rratio_s3"] > 0.345) & (lum > 0.2)] = C["garden"]
    lab[has("constr") & ~near_hard & (exg3 < 0.015) & (f["y_rratio_s3"] > 0.35) & (lum > 0.25)] = C["bare"]
    lab[has("track") & ~has("wood") & (exg3 < 0.015) & (f["y_rratio_s3"] > 0.35) & (lum > 0.25)] = C["bare"]
    lab[has("beach") & (lum > 0.45) & (exg3 < 0.03)] = C["sand"]
    lab[has("rail") & ~bld & ~road & (exg3 < 0.02)] = C["gravel"]
    lab[has("indus", "garages") & ~near_hard & ~has("parking") & (exg3 < 0.0) & (sat < 0.15) & (lum > 0.3) & (lum < 0.65)] = C["gravel"]
    lab[inner(has("water"), 6) & (exg3 < 0.06)] = C["water"]
    lab[inner(road, 1.5) & (exg3 < 0.03)] = C["paved"]
    lab[inner(has("parking"), 2) & (exg3 < 0.03)] = C["paved"]
    lab[inner(bld, 1.5)] = C["building"]
    lab[~valid] = 0
    return lab


def sample(lab, man, rng):
    """Индексы пикселей для обучения: слабые метки (до PER_CLASS_CHUNK на класс) + ручные (больше).
    Ручная метка «none» (255) гасит слабые метки под собой."""
    out = []
    is_man = (man > 0) & (man < 255)
    weak = np.where(is_man | (man == 255), 0, lab)
    for k in range(1, NCLS + 1):
        for src, lim, m in ((weak, PER_CLASS_CHUNK, False), (np.where(is_man, man, 0), MANUAL_PER_CLASS_CHUNK, True)):
            idx = np.flatnonzero(src.ravel() == k)
            if len(idx) == 0:
                continue
            if len(idx) > lim:
                idx = rng.choice(idx, lim, replace=False)
            out.append((idx, k, m))
    return out


def train(log):
    import lightgbm as lgb
    g = Grid1m()
    ctx = context.load()
    man = load_manual("train")
    rng = np.random.default_rng(7)
    X, Y, W, names = [], [], [], None
    for x0, y0, x1, y1, r0, c0 in chunks(g):
        h, w = int(round(y1 - y0)), int(round(x1 - x0))
        sl = ctx_slice(ctx, r0, c0, h, w)
        lab_mask = sl["M"]
        mr = manual_raster(g, man, x0, y0, x1, y1)
        if not (lab_mask.any() or mr.any()):
            continue
        F, names, sh = FT.chunk(x0, y0, x1, y1, sl)
        lab = weak_labels(F, names, sl)
        mr[F[names.index("valid")] < 0.99] = 0
        n = 0
        for idx, k, is_man in sample(lab, mr, rng):
            X.append(F.reshape(F.shape[0], -1)[:, idx].T.astype(np.float32))
            Y.append(np.full(len(idx), k - 1, np.int32))
            W.append(np.full(len(idx), 8.0 if is_man else 1.0, np.float32))
            n += len(idx)
        log(f"  чанк {x0:.0f},{y0:.0f}: выборка {n}, сдвиг Esri {sh}")
    X, Y, W = np.concatenate(X), np.concatenate(Y), np.concatenate(W)
    # ограничение на класс
    keep = []
    for k in range(NCLS):
        idx = np.flatnonzero(Y == k)
        if len(idx) > PER_CLASS_MAX:
            idx = rng.choice(idx, PER_CLASS_MAX, replace=False)
        keep.append(idx)
        log(f"  класс {NAMES[k]}: {len(idx)} (ручных {int((W[idx] > 1).sum())})")
    keep = np.concatenate(keep)
    X, Y, W = X[keep], Y[keep], W[keep]
    # баланс классов
    cnt = np.bincount(Y, minlength=NCLS).astype(float)
    W *= (cnt.sum() / np.maximum(cnt, 1) / NCLS)[Y] ** 0.5
    ds = lgb.Dataset(X, Y, weight=W, feature_name=names, free_raw_data=False)
    params = dict(objective="multiclass", num_class=NCLS, learning_rate=0.1, num_leaves=40, min_data_in_leaf=60,
                  feature_fraction=0.7, bagging_fraction=0.7, bagging_freq=1, lambda_l2=1.0, verbose=-1, num_threads=10)
    bst = lgb.train(params, ds, num_boost_round=140)
    OUT.mkdir(parents=True, exist_ok=True)
    bst.save_model(str(OUT / "model.txt"))
    imp = sorted(zip(bst.feature_importance("gain"), names), reverse=True)
    log("важность: " + ", ".join(f"{n} {v / 1e3:.0f}k" for v, n in imp[:20]))
    (OUT / "features.json").write_text(json.dumps(names))
    return bst


def predict(log):
    import lightgbm as lgb
    g = Grid1m()
    ctx = context.load()
    bst = lgb.Booster(model_file=str(OUT / "model.txt"))
    P = np.lib.format.open_memmap(OUT / "proba.npy", mode="w+", dtype=np.uint8, shape=(NCLS, g.rows, g.cols))
    SH = np.lib.format.open_memmap(OUT / "shadow.npy", mode="w+", dtype=np.uint8, shape=(g.rows, g.cols))
    for x0, y0, x1, y1, r0, c0 in chunks(g):
        h, w = int(round(y1 - y0)), int(round(x1 - x0))
        sl = ctx_slice(ctx, r0, c0, h, w)
        F, names, sh = FT.chunk(x0, y0, x1, y1, sl)
        # внутренности зданий и проезжей части OSM не предсказываем (известны)
        known = np.zeros((h, w), np.uint8)
        Mi = sl["M"]
        known[distance_transform_edt((Mi & np.uint32(context.B["road"])) != 0) > 2.5] = C["paved"]
        known[distance_transform_edt((Mi & np.uint32(context.B["bld"])) != 0) > 2.5] = C["building"]
        todo = (known == 0).ravel() & (F[names.index("valid")].ravel() > 0.99)
        X = F.reshape(F.shape[0], -1)[:, todo].T.astype(np.float32)
        p = np.zeros((NCLS, h * w), np.float32)
        if len(X):
            p[:, todo] = bst.predict(X, num_threads=10).T
        kn = known.ravel()
        for k in (C["paved"], C["building"]):
            p[k - 1, kn == k] = 1.0
        p = p.reshape(NCLS, h, w)
        P[:, r0:r0 + h, c0:c0 + w] = np.round(p * 255).astype(np.uint8)
        SH[r0:r0 + h, c0:c0 + w] = np.round(np.clip(F[names.index("y_shadow")], 0, 1) * 255).astype(np.uint8)
        log(f"  предсказание {x0:.0f},{y0:.0f}")
    P.flush(); SH.flush()


def shadow_dirs(log):
    g = Grid1m()
    ctx = context.load()
    for (x0, y0) in [(-1500, -2000), (500, -3000)]:
        r0, c0 = int(g.max_y - (y0 + 800)), int(x0 - g.min_x)
        bm = (ctx["M"][r0:r0 + 800, c0:c0 + 800] & context.B["bld"]) != 0
        for s in ("yandex_0.5m", "esri_0.5m"):
            log(x0, y0, s, FT.estimate_shadow_dir(s, x0, y0, x0 + 800, y0 + 800, bm))
