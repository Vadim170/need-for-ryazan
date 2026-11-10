"""Здания по ортофото Яндекса (data/processed/ortho): цвет крыши, тип крыши (скатная/плоская), длина тени -> высота.

Запуск: cd pipeline && uv run python -m world.ortho_buildings   (пишет data/processed/building_ortho.json, ~2-4 мин)

Метод (docs/stage2/buildings.md):
- цвет крыши: медиана RGB внутри футпринта, сжатого на 1 м (ядро 0.25 м, вне ядра 0.5 м);
- тип крыши: для почти прямоугольных футпринтов — контраст яркости двух половин вдоль длинной оси (скаты по разные
  стороны конька освещены по-разному) против разброса внутри половин; плюс насыщенность (крашеный металл);
- тень: от стен на теневой стороне пускаются лучи вдоль направления тени; профиль средней относительной яркости
  по лучам (чужие футпринты исключены) -> расстояние, где профиль возвращается к яркости земли (sh_prof). Азимут —
  максимум корреляции sh_prof с этажностью по зданиям с известными этажами. Перевод длины в высоту — регрессия по зданиям с известной высотой (делает archetypes.py, тут только длины).
"""
import json
import math
import time

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.windows import from_bounds
from shapely.geometry import LineString
from shapely.strtree import STRtree

from config import DATA_PROCESSED

ORTHO = DATA_PROCESSED / "ortho" / "yandex_0.5m.tif"
CORE = DATA_PROCESSED / "ortho" / "yandex_core_0.25m.tif"
OUT = DATA_PROCESSED / "building_ortho.json"
RAY_STEP = 0.5
RAY_MAX = 45.0
DARK_K, DARK_K2 = 0.55, 0.7
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


class Ortho:
    """Ортофото целиком в памяти (uint8 RGB) + выборка по мировым координатам."""

    def __init__(self, path):
        r = rasterio.open(path)
        self.a = r.read().transpose(1, 2, 0)   # H, W, 3
        self.tf = r.transform
        self.res = r.res[0]
        self.x0, self.y1 = r.bounds.left, r.bounds.top
        self.h, self.w = self.a.shape[:2]
        self.lum = (self.a[..., 0] * 0.299 + self.a[..., 1] * 0.587 + self.a[..., 2] * 0.114).astype(np.float32)
        self.bounds = r.bounds

    def ij(self, x, y):
        return ((self.y1 - np.asarray(y)) / self.res).astype(np.int64), ((np.asarray(x) - self.x0) / self.res).astype(np.int64)

    def covers(self, poly, pad=0.0):
        b = self.bounds
        x0, y0, x1, y1 = poly.bounds
        return x0 - pad > b.left and x1 + pad < b.right and y0 - pad > b.bottom and y1 + pad < b.top

    def window(self, x0, y0, x1, y1):
        """Индексы окна (r0, c0, r1, c1) в пределах растра."""
        r0 = max(int((self.y1 - y1) / self.res), 0); r1 = min(int((self.y1 - y0) / self.res) + 1, self.h)
        c0 = max(int((x0 - self.x0) / self.res), 0); c1 = min(int((x1 - self.x0) / self.res) + 1, self.w)
        return r0, c0, r1, c1


def _mask(o, polys, win, values=None):
    r0, c0, r1, c1 = win
    tf = rasterio.transform.from_origin(o.x0 + c0 * o.res, o.y1 - r0 * o.res, o.res, o.res)
    shapes = [(p, v) for p, v in zip(polys, values if values is not None else [1] * len(polys))]
    return rasterize(shapes, out_shape=(r1 - r0, c1 - c0), transform=tf, fill=0, dtype=np.int32, all_touched=False)


def rect_frame(poly):
    """Минимальный повёрнутый прямоугольник: (центр, ось длинной стороны u, длина, ширина, прямоугольность)."""
    mrr = poly.minimum_rotated_rectangle
    c = np.asarray(mrr.exterior.coords)[:4]
    e1, e2 = c[1] - c[0], c[2] - c[1]
    l1, l2 = np.hypot(*e1), np.hypot(*e2)
    if l1 >= l2:
        u, L, W = e1 / max(l1, 1e-9), l1, l2
    else:
        u, L, W = e2 / max(l2, 1e-9), l2, l1
    return c.mean(axis=0), u, L, W, poly.area / max(mrr.area, 1e-9)


def roof_features(o, poly, others_mask_fn):
    """Цвет крыши и признаки скатности. None — футпринт слишком мал/вне снимка."""
    inner = poly.buffer(-1.0)
    if inner.is_empty or inner.area < 6:
        inner = poly.buffer(-0.4)
        if inner.is_empty or inner.area < 3:
            return None
    x0, y0, x1, y1 = poly.bounds
    win = o.window(x0 - 1, y0 - 1, x1 + 1, y1 + 1)
    m = _mask(o, [inner], win) > 0
    if m.sum() < 8:
        return None
    r0, c0, r1, c1 = win
    rgb = o.a[r0:r1, c0:c1][m].astype(np.float32)
    lum = o.lum[r0:r1, c0:c1][m]
    if (rgb.max(axis=1) < 8).mean() > 0.3:   # вне покрытия (чёрное)
        return None
    med = np.median(rgb, axis=0)
    mx, mn = rgb.max(axis=1), rgb.min(axis=1)
    sat = float(np.median((mx - mn) / np.maximum(mx, 1)))
    # координаты пикселей маски в мировых
    rr, cc = np.nonzero(m)
    px = o.x0 + (c0 + cc + 0.5) * o.res
    py = o.y1 - (r0 + rr + 0.5) * o.res
    ctr, u, L, W, rect = rect_frame(poly)
    v = np.array([-u[1], u[0]])
    du = (px - ctr[0]) * u[0] + (py - ctr[1]) * u[1]
    dv = (px - ctr[0]) * v[0] + (py - ctr[1]) * v[1]

    def contrast(sel_a, sel_b):
        if sel_a.sum() < 4 or sel_b.sum() < 4:
            return 0.0
        a, b = lum[sel_a], lum[sel_b]
        s = math.sqrt((a.var() + b.var()) / 2) + 4.0
        return float(abs(np.median(a) - np.median(b)) / s)

    # конёк вдоль длинной оси: половины по знаку dv (отступ 0.6 м от линии конька)
    c_long = contrast(dv > 0.6, dv < -0.6)
    c_short = contrast(du > 0.6, du < -0.6)
    # вальма: торцевые треугольники (|du| > L/2 - W/2) против боковых скатов
    end = np.abs(du) > (L / 2 - W / 2) + 0.5
    c_hip = contrast(end & (du > 0), ~end & (dv > 0.6)) if L > W * 1.15 else 0.0
    return {
        "roof_rgb": [int(round(float(c))) for c in med],
        "roof_lum": round(float(np.median(lum)), 1),
        "roof_tex": round(float(np.std(lum)), 1),
        "roof_sat": round(sat, 3),
        "c_long": round(c_long, 2), "c_short": round(c_short, 2), "c_hip": round(c_hip, 2),
        "rect": round(rect, 3), "L": round(L, 1), "W": round(W, 1),
    }


def shadow_rays(o, poly, sdir, occ_polys, step=1.0):
    """Длины тёмных участков от стен теневой стороны вдоль sdir. Возвращает (длины, цензурированные)."""
    ext = np.asarray(poly.exterior.coords)
    # точки на рёбрах, наружная нормаль которых смотрит в сторону тени
    pts = []
    ccw = poly.exterior.is_ccw
    for a, b in zip(ext[:-1], ext[1:]):
        d = b - a
        Ln = math.hypot(*d)
        if Ln < 1.0:
            continue
        nrm = np.array([d[1], -d[0]]) / Ln if ccw else np.array([-d[1], d[0]]) / Ln
        if nrm @ sdir < 0.45:
            continue
        k = max(int(Ln / step), 1)
        for t in (np.arange(k) + 0.5) / k:
            pts.append(a + d * t + nrm * 0.3)
    if len(pts) < 3:
        return None
    pts = np.array(pts)
    if len(pts) > 60:
        pts = pts[np.linspace(0, len(pts) - 1, 60).astype(int)]
    s = np.arange(0, RAY_MAX, RAY_STEP)
    X = pts[:, 0:1] + sdir[0] * s
    Y = pts[:, 1:2] + sdir[1] * s
    x0, y0, x1, y1 = X.min(), Y.min(), X.max(), Y.max()
    win = o.window(x0 - 2, y0 - 2, x1 + 2, y1 + 2)
    r0, c0, r1, c1 = win
    occ = _mask(o, occ_polys, win) if occ_polys else np.zeros((r1 - r0, c1 - c0), np.int32)
    self_m = _mask(o, [poly], win)
    rr = ((o.y1 - Y) / o.res).astype(np.int64) - r0
    cc = ((X - o.x0) / o.res).astype(np.int64) - c0
    ok = (rr >= 0) & (rr < r1 - r0) & (cc >= 0) & (cc < c1 - c0)
    rr = np.clip(rr, 0, r1 - r0 - 1); cc = np.clip(cc, 0, c1 - c0 - 1)
    lum = o.lum[r0:r1, c0:c1][rr, cc]
    rgb = o.a[r0:r1, c0:c1][rr, cc].astype(np.float32)
    blocked = (occ[rr, cc] > 0) | ~ok
    inself = self_m[rr, cc] > 0
    # опорная яркость «освещённой земли»: верхний квартиль вокруг
    wl = o.lum[r0:r1, c0:c1][(occ == 0) & (self_m == 0)]
    if wl.size < 50:
        return None
    ref = float(np.percentile(wl, 70))
    # тень: темно и не зелено (кроны в тени тоже темные — пусть; зелень на солнце отсекается)
    green = (rgb[..., 1] > rgb[..., 2] * 1.12) & (rgb[..., 1] > rgb[..., 0] * 1.05) & (lum > ref * 0.45)
    bluish = rgb[..., 2] >= rgb[..., 1]
    dark = ((lum < ref * DARK_K) | ((lum < ref * DARK_K2) & bluish)) & ~green
    # профиль: средняя относительная яркость по лучам (чужие футпринты — пропуск); длина тени = где профиль
    # поднимается выше середины между минимумом и «землёй» (устойчиво к машинам/кронам на отдельных лучах)
    rel = np.where(blocked | inself, np.nan, np.minimum(lum / ref, 1.3))
    valid = (~np.isnan(rel)).sum(axis=0)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        prof = np.nanmean(rel, axis=0)
    prof_len = None
    good = valid >= max(3, len(pts) // 3)
    if good[:12].any():
        k0 = int(np.nanargmin(np.where(good[:16], prof[:16], np.nan)))
        mn = prof[k0]
        if mn < 0.6:
            thr = mn + 0.55 * (1.0 - mn)
            k = k0
            while k < len(s) and good[k] and prof[k] < thr:
                k += 1
            if k < len(s) and good[k]:
                prof_len = float(s[k])
    out, cens = [], []
    out_prof = prof_len
    for i in range(len(pts)):
        j0 = 0
        while j0 < len(s) and inself[i, j0]:
            j0 += 1
        if j0 >= 8 or j0 >= len(s) or not dark[i, j0:j0 + 4].any():
            continue
        j, gap = j0, 0
        while j < len(s):
            if blocked[i, j]:
                break
            if dark[i, j]:
                gap = 0
            else:
                gap += 1
                if gap >= 3:
                    break
            j += 1
        end = j - gap
        L = (end - j0) * RAY_STEP
        c = j < len(s) and blocked[i, j] or j >= len(s)
        (cens if c else out).append(L)
    return out, cens, out_prof


def iter_buildings(osm):
    """(key 'w123'/'r123', polygon, tags) для зданий (как OsmData.buildings, но с типом объекта в ключе)."""
    for wid, (refs, tg) in osm.ways.items():
        if tg.get("building", "no") != "no" and len(refs) > 3 and refs[0] == refs[-1]:
            p = osm.way_polygon(wid)
            if p is not None:
                yield f"w{wid}", p, tg
    for rid, tg, mem in osm.rels:
        if tg.get("type") == "multipolygon" and tg.get("building", "no") != "no":
            p = osm.rel_polygon(mem)
            if p is not None:
                yield f"r{rid}", p, tg


def _largest(p):
    if p.geom_type == "Polygon":
        return p
    return max(getattr(p, "geoms", []), key=lambda g: g.area, default=None)


def main():
    import sys
    sys.path.insert(0, str(DATA_PROCESSED.parent.parent / "pipeline"))
    from config import DATA_RAW
    from world.osm import OsmData, parse_numbers
    osm = OsmData(DATA_RAW / "osm" / "ryazan.osm")
    B = []
    for key, p, tg in iter_buildings(osm):
        if tg.get("building") in ("roof", "carport", "no", "ruins", "entrance"):
            continue
        q = _largest(p)
        if q is not None and q.area > 4:
            B.append((key, q.simplify(0.2, preserve_topology=True), tg))
    log(f"зданий {len(B)}")
    o = Ortho(ORTHO)
    log("ортофото 0.5 м загружено")
    try:
        oc = Ortho(CORE)
        log("ядро 0.25 м загружено")
    except Exception:
        oc = None
    tree = STRtree([p for _, p, _ in B])
    known = [i for i, (k, p, tg) in enumerate(B) if parse_numbers(tg.get("building:levels")) and 4 <= max(parse_numbers(tg.get("building:levels"))) <= 16
             and p.area > 200]
    rng = np.random.default_rng(1)
    rng.shuffle(known)
    # азимут тени: максимум корреляции «длина тени ↔ этажность» по зданиям с известной этажностью
    # (простой контраст сторон путается из-за завала крыш; см. docs/stage2/buildings.md)
    cal = known[:500]
    best = (-1, 0)
    for az_try in range(320, 375, 5):
        a = math.radians(az_try)
        sd = np.array([math.sin(a), math.cos(a)])
        xs, ys = [], []
        for i in cal:
            k, p, tg = B[i]
            occ = [B[j][1] for j in tree.query(p.buffer(RAY_MAX)) if j != i]
            sr = shadow_rays(o, p, sd, occ)
            if sr and sr[2] is not None:
                xs.append(sr[2]); ys.append(max(parse_numbers(tg["building:levels"])))
        cr = float(np.corrcoef(xs, ys)[0, 1]) if len(xs) > 30 else -1
        log(f"  азимут {az_try % 360}°: n={len(xs)} corr={cr:.3f}")
        if cr > best[0]:
            best = (cr, az_try % 360)
    az = best[1]
    log(f"азимут тени ≈ {az}° (куда падает тень, от севера по часовой), corr {best[0]:.3f}")
    a = math.radians(az)
    sdir = np.array([math.sin(a), math.cos(a)])
    res = {}
    for n, (key, p, tg) in enumerate(B):
        if not o.covers(p, 50):
            continue
        rec = {}
        src = oc if oc is not None and oc.covers(p, 2) else o
        f = roof_features(src, p, None)
        if f:
            rec.update(f)
            rec["roof_res"] = src.res
        cand = tree.query(p.buffer(RAY_MAX))
        occ = [B[j][1] for j in cand if j != n]
        sr = shadow_rays(o, p, sdir, occ)
        if sr:
            L, C, PL = sr
            if PL is not None:
                rec["sh_prof"] = round(PL, 2)
            rec["sh_n"] = len(L); rec["sh_cens"] = len(C)
            if len(L) >= 3:
                rec["sh_len"] = round(float(np.median(L)), 2)
                rec["sh_p75"] = round(float(np.percentile(L, 75)), 2)
            if len(C) >= 3:
                rec["sh_cens_med"] = round(float(np.median(C)), 2)
        if rec:
            res[key] = rec
        if n % 1000 == 0:
            log(f"{n}/{len(B)}")
    OUT.write_text(json.dumps({"meta": {"source": "Yandex ortho 0.5m / core 0.25m", "shadow_azimuth_deg": az,
                                        "ray_step": RAY_STEP, "ray_max": RAY_MAX},
                               "buildings": res, "shadow_corr": round(best[0], 3)}, separators=(",", ":")))
    log(f"записано {len(res)} -> {OUT}")


if __name__ == "__main__":
    main()
