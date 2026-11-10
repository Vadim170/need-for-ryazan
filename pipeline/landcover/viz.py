"""Проверка: картинки «спутник | Esri | классы» по местам, листы для ручной разметки точек, точность по точкам."""
import json

import numpy as np
import rasterio
from PIL import Image, ImageDraw, ImageFont
from rasterio.windows import from_bounds

def _font(size):
    try:
        return ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", size)   # кириллица (macOS)
    except OSError:
        return ImageFont.load_default(size=size)


from .classes import C, CLASSES, MANUAL, NAMES, NCLS, ORTHO, OUT, PALETTE, Grid1m

# места проверки (центр x, y мира, сторона м) — docs/stage3/landcover.md
SPOTS = {
    "lybed_south": (-420, -3020, 300),        # овраг Лыбеди у Скорбященской (заросли, частный сектор)
    "lybed_ravine": (-560, -1900, 300),       # Лыбедь, средняя часть оврага
    "lesopark_edge": (760, 260, 300),         # край Лесопарка (сосны)
    "allotments": (1160, -2960, 300),         # сады у Ряжской ж/д ветки
    "private_sector": (-1900, 2100, 300),     # частный сектор на севере (огороды)
    "oka_floodplain": (1000, 2500, 500),      # пойма Оки (луга, поля)
    "industrial": (-2900, -300, 300),         # промзона у Рязани-II
    "railway_verge": (-1700, -800, 300),      # насыпь у ж/д (Московское шоссе)
    "trubezh": (-1250, 300, 300),             # берега Трубежа
    "beach": (2230, 1500, 300),               # пляж у Солотчинского моста
    "yards_center": (-300, -1300, 300),       # дворы центра (газоны)
    "scrub_floodplain": (2500, 1980, 300),    # кустарник в пойме
}


def ortho(src, x0, y0, x1, y1, px):
    with rasterio.open(ORTHO / f"{src}.tif") as r:
        a = r.read(window=from_bounds(x0, y0, x1, y1, r.transform), boundless=True, out_shape=(3, px, px))
    return Image.fromarray(np.transpose(a, (1, 2, 0))).convert("RGB")


def lc_crop(x0, y0, x1, y1, px):
    with rasterio.open(OUT / "lc_1m.tif") as r:
        a = r.read(1, window=from_bounds(x0, y0, x1, y1, r.transform), boundless=True, out_shape=(px, px),
                   resampling=rasterio.enums.Resampling.nearest)
    pal = np.array(PALETTE, np.uint8)
    return a, Image.fromarray(pal[a])


def legend(h):
    im = Image.new("RGB", (190, h), "white")
    d = ImageDraw.Draw(im)
    f = _font(13)
    for i, (n, ru, col) in enumerate(CLASSES):
        d.rectangle([6, 8 + i * 22, 24, 24 + i * 22], fill=col, outline=(0, 0, 0))
        d.text((30, 9 + i * 22), n, fill=(0, 0, 0), font=f)
    return im


def crops(log, spots=None, out_dir=None):
    out_dir = out_dir or OUT / "check"
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, (cx, cy, s) in (spots or SPOTS).items():
        x0, y0, x1, y1 = cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2
        px = 600
        y = ortho("yandex_0.5m", x0, y0, x1, y1, px)
        e = ortho("esri_0.5m", x0, y0, x1, y1, px)
        a, lc = lc_crop(x0, y0, x1, y1, px)
        ov = Image.blend(y, lc, 0.5)
        W = Image.new("RGB", (px * 3 + 20 + 190, px), "white")
        W.paste(y, (0, 0)); W.paste(ov, (px + 10, 0)); W.paste(lc, (2 * px + 20, 0)); W.paste(legend(px), (3 * px + 20, 0))
        d = ImageDraw.Draw(W)
        d.text((6, 6), f"{name} ({cx:.0f},{cy:.0f}) {s:.0f} м: Яндекс | наложение | классы", fill=(255, 255, 0), font=_font(14))
        W.save(out_dir / f"{name}.png")
        e.resize((300, 300)).save(out_dir / f"{name}_esri.png")
    log(f"  картинки: {out_dir}")


# ------------------------------------------------------------------ точки проверки
def sheets(log, n_per_class=30, seed=11, kind="val"):
    """Кандидаты точек проверки: стратифицировано по предсказанному классу (только «открытая земля» мира: не здания
    и не проезжая часть OSM), листы по 20 точек — data/processed/landcover/val_sheets/*.png, список — val_candidates.json.
    Метку ставит человек (глазами по листу) в data/landcover/validation_points.json."""
    from . import context
    g = Grid1m()
    with rasterio.open(OUT / "lc_1m.tif") as r:
        L = r.read(1)
    ctx = context.load()
    B = context.B
    M = ctx["M"]
    rng = np.random.default_rng(seed)
    man = json.loads((MANUAL / "manual_labels.json").read_text()) if (MANUAL / "manual_labels.json").exists() else []
    from shapely.geometry import box
    from shapely.strtree import STRtree
    train_geoms = [box(*it["rect"]).buffer(30) for it in man if "rect" in it]
    if kind == "train":   # точки для обучения — не ближе 40 м к точкам проверки
        vp = json.loads((MANUAL / "validation_points.json").read_text()) if (MANUAL / "validation_points.json").exists() else []
        train_geoms = [box(p["x"] - 40, p["y"] - 40, p["x"] + 40, p["y"] + 40) for p in vp]
    tree = STRtree(train_geoms) if train_geoms else None
    pts = []
    open_ground = (M & np.uint32(B["bld"] | B["road"])) == 0
    for k in range(1, NCLS + 1):
        if NAMES[k - 1] in ("building", "paved", "water"):
            nk = n_per_class // 3
        else:
            nk = n_per_class
        idx = np.flatnonzero(((L == k) & open_ground).ravel())
        if len(idx) == 0:
            continue
        for i in rng.choice(idx, min(len(idx), nk * 3), replace=False):
            r, c = divmod(int(i), g.cols)
            x, y = g.xy(r, c)
            if tree is not None and len(tree.query(box(x - 1, y - 1, x + 1, y + 1))):
                continue    # не рядом с ручными метками обучения
            pts.append({"id": len(pts), "x": round(float(x), 1), "y": round(float(y), 1), "pred": NAMES[k - 1]})
            if sum(p["pred"] == NAMES[k - 1] for p in pts) >= nk:
                break
    rng.shuffle(pts)
    for i, p in enumerate(pts):
        p["id"] = i
    d = OUT / ("val_sheets" if kind == "val" else "train_sheets")
    d.mkdir(parents=True, exist_ok=True)
    (OUT / ("val_candidates.json" if kind == "val" else "train_candidates.json")).write_text(json.dumps(pts, ensure_ascii=False, indent=0))
    f = _font(14)
    for s0 in range(0, len(pts), 20):
        sheet = Image.new("RGB", (5 * 250, 4 * 270), "white")
        dr = ImageDraw.Draw(sheet)
        for j, p in enumerate(pts[s0:s0 + 20]):
            x, y = p["x"], p["y"]
            im = ortho("yandex_0.5m", x - 30, y - 30, x + 30, y + 30, 240)
            e = ortho("esri_0.5m", x - 30, y - 30, x + 30, y + 30, 80)
            dd = ImageDraw.Draw(im)
            dd.ellipse([114, 114, 126, 126], outline=(255, 0, 255), width=2)
            im.paste(e, (160, 0))
            ox, oy = (j % 5) * 250, (j // 5) * 270
            sheet.paste(im, (ox + 5, oy + 25))
            dr.text((ox + 5, oy + 5), f"#{p['id']}", fill=(0, 0, 0), font=f)
        sheet.save(d / f"sheet_{s0 // 20:02d}.png")
    log(f"  точек-кандидатов {len(pts)}, листов {(len(pts) + 19) // 20}: {d}")


def validate(log):
    pts = json.loads((MANUAL / "validation_points.json").read_text()) if (MANUAL / "validation_points.json").exists() else []
    if not pts:
        log("  нет data/landcover/validation_points.json")
        return None
    # точки рядом (≤ 30 м) с ручными метками обучения не считаем — проверка только на независимых местах
    man = json.loads((MANUAL / "manual_labels.json").read_text()) if (MANUAL / "manual_labels.json").exists() else []
    rects = [it["rect"] for it in man if "rect" in it]
    near = lambda x, y: any(r[0] - 30 <= x <= r[2] + 30 and r[1] - 30 <= y <= r[3] + 30 for r in rects)
    n0 = len(pts)
    pts = [p for p in pts if not near(p["x"], p["y"])]
    log(f"  точек проверки {n0}, у ручных меток отброшено {n0 - len(pts)}")
    g = Grid1m()
    with rasterio.open(OUT / "lc_1m.tif") as r:
        L = r.read(1)
    names = NAMES
    cm = np.zeros((NCLS, NCLS), int)
    for p in pts:
        if p["cls"] not in C:
            continue
        r, c = g.rc(p["x"], p["y"])
        pr = int(L[r, c])
        if pr == 0:
            continue
        cm[C[p["cls"]] - 1, pr - 1] += 1
    # оценка по площади (выборка стратифицирована по классу исходной карты): вес точки = площадь страты / точек в ней
    sf = MANUAL / "validation_strata.json"
    wacc = None
    if sf.exists():
        area = json.loads(sf.read_text())["area"]
        ns = {}
        for p in pts:
            ns[p.get("stratum")] = ns.get(p.get("stratum"), 0) + 1
        num = den = 0.0
        for p in pts:
            if p["cls"] not in C or p.get("stratum") not in area:
                continue
            r, c = g.rc(p["x"], p["y"])
            w = area[p["stratum"]] / ns[p["stratum"]]
            den += w
            num += w * (int(L[r, c]) == C[p["cls"]])
        wacc = num / max(den, 1e-9)
    tot = cm.sum()
    acc = np.trace(cm) / max(tot, 1)
    gi = [k for k in range(NCLS) if names[k] != "building"]
    cg = cm[np.ix_(gi, gi)]
    acc_ground = np.trace(cg) / max(cm[gi].sum(), 1)   # без «крыш вне OSM» (их карта не знает: здания — только из OSM)
    rows = []
    for k in range(NCLS):
        n = cm[k].sum()
        if n == 0 and cm[:, k].sum() == 0:
            continue
        rec = cm[k, k] / n if n else float("nan")
        prec = cm[k, k] / cm[:, k].sum() if cm[:, k].sum() else float("nan")
        rows.append({"cls": names[k], "n": int(n), "recall": round(float(rec), 3), "precision": round(float(prec), 3)})
    res = {"points": int(tot), "overall_accuracy": round(float(acc), 3), "ground_accuracy": round(float(acc_ground), 3), "area_weighted_accuracy": None if wacc is None else round(float(wacc), 3), "per_class": rows,
           "confusion": {names[k]: {names[j]: int(cm[k, j]) for j in range(NCLS) if cm[k, j]} for k in range(NCLS) if cm[k].sum()}}
    groups = {"woody": ["canopy", "conifer", "thicket"], "grass": ["meadow", "lawn"], "soil": ["garden", "bare", "sand", "gravel"],
              "water": ["water"], "paved": ["paved"], "building": ["building"]}
    gof = {c: gname for gname, cs in groups.items() for c in cs}
    gm = sum(cm[k, j] for k in range(NCLS) for j in range(NCLS) if gof[names[k]] == gof[names[j]])
    res["group_accuracy"] = round(float(gm / max(tot, 1)), 3)
    res["groups"] = groups
    log(f"  по группам (заросли+кроны, трава, грунт, вода, асфальт, крыши): {gm / max(tot, 1):.3f}")
    (OUT / "validation.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    log(f"  точек {tot}, доля верных {acc:.3f}, без крыш вне OSM {acc_ground:.3f}, по площади {wacc if wacc is None else round(wacc, 3)}")
    for r_ in rows:
        log(f"    {r_['cls']:9s} n={r_['n']:3d} recall={r_['recall']:.2f} precision={r_['precision']:.2f}")
    return res
