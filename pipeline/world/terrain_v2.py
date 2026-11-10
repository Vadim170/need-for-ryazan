"""Рельеф v2: FABDEM + горизонтали старой топокарты + гидрология + жёсткие линии (OSM).

Вход: FABDEM (data/raw/dem/fabdem/fabdem_crop.tif), мозаика топокарты GGC 1:25 000 (pipeline/fetch_topo.py ->
data/raw/topo/ggc250_z15.tif, EPSG:3857), OSM. Выход: сетка высот в узлах Grid (та же, что у v1), подменяет
«сглаженный FABDEM» h0 в build_world.py. Документация: docs/stage2/terrain-v2.md.

Слои (все — поправки к одной базе):
1. база = FABDEM -> 5 м (бикубика), гаусс 17.5 м (как v1, убирает ступени 30 м);
2. горизонтали: линии с привязанной высотой (уровень кратен 5 м, выбран по FABDEM вдоль линии) -> поправка
   «уровень − база», интерполированная нормированной свёрткой на двух масштабах и затухающая вдали от линий;
   линии со штрихами (обрывы, овраги, откосы) на карте отдельный класс: высоту не задают, только маркер склона;
3. долины: оси водотоков OSM (включая участки в трубе tunnel=culvert/yes, как Лыбедь под бульваром) ->
   тальвег = нижняя огибающая базы вдоль оси, монотонно вниз по течению, + врезка поперечного профиля,
   глубина которого «восстанавливается» из сглаженной FABDEM-ложбины (обратная задача к сглаживанию 30 м);
4. жёсткие линии: лестницы (step_count × 0.16 м или incline), подпорные стены, обрывы, откосы/насыпи OSM
   (перепад по разности рельефа по сторонам, иначе по умолчанию).
"""
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from scipy import ndimage as ndi
from scipy.ndimage import gaussian_filter, map_coordinates
from scipy.spatial import cKDTree
from shapely.geometry import LineString

from config import WORLD_CRS

TOPO_CONTOUR_RGB = (164, 76, 1)          # горизонтали на GGC: коричнево-оранжевый, 1 px с антиалиасингом
# фоны карты: пиксель линии = смесь фона и цвета горизонтали; «конкурирующие» цвета (дома, грунтовки, текст, вода)
TOPO_BG = [(250, 250, 250), (255, 255, 255), (252, 205, 158), (251, 223, 195), (167, 223, 167), (167, 253, 167),
           (188, 253, 188), (167, 223, 251), (167, 167, 167), (167, 149, 130), (167, 137, 105), (0, 0, 0),
           (254, 169, 80)]
INTERVAL = 5.0          # м: сечение рельефа карты 1:25 000 (равнина)
LEVEL_TOL = 1.6         # м: |медиана FABDEM − уровень| больше -> уровень неоднозначен, линию не используем
LEVEL_SD = 2.5          # м: разброс FABDEM вдоль линии больше -> линия не согласуется с DEM
CORR_MAX = 4.0          # м: максимум поправки от горизонталей
STEP_RISE = 0.16        # м на ступень
BASE_SMOOTH = 17.5


# ---------------------------------------------------------------- горизонтали
def _zhang_suen(img, max_iter=20):
    """Утончение до скелета (Zhang-Suen), векторно по всей картинке."""
    I = img.astype(np.uint8).copy()
    for _ in range(max_iter):
        changed = False
        for step in (0, 1):
            P = np.pad(I, 1)
            p2, p3, p4 = P[:-2, 1:-1], P[:-2, 2:], P[1:-1, 2:]
            p5, p6, p7 = P[2:, 2:], P[2:, 1:-1], P[2:, :-2]
            p8, p9 = P[1:-1, :-2], P[:-2, :-2]
            nb = [p2, p3, p4, p5, p6, p7, p8, p9]
            B = sum(n.astype(np.int32) for n in nb)
            seq = nb + [p2]
            A = sum(((seq[k] == 0) & (seq[k + 1] == 1)).astype(np.int32) for k in range(8))
            if step == 0:
                c = (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                c = (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            rm = (I == 1) & (B >= 2) & (B <= 6) & (A == 1) & c
            if rm.any():
                I[rm] = 0
                changed = True
        if not changed:
            break
    return I.astype(bool)


def extract_contours(topo_tif, cache=None):
    """Коричневые линии топокарты -> точки в мировой СК, сгруппированные по связным компонентам.
    Возвращает dict: xy (N,2), comp (N,) id компоненты, kinds {id: 'contour'|'hachure'}, npix {id: n}."""
    if cache is not None and Path(cache).exists():
        d = np.load(cache, allow_pickle=True)
        return {"xy": d["xy"], "comp": d["comp"], "kind": d["kind"].item(), "npix": d["npix"].item()}
    with rasterio.open(topo_tif) as s:
        a = s.read().transpose(1, 2, 0).astype(np.float32)
        tr = s.transform
        src_crs = s.crs
    C = np.array(TOPO_CONTOUR_RGB, np.float32)
    best_a = np.zeros(a.shape[:2], np.float32)
    best_r = np.full(a.shape[:2], 1e9, np.float32)
    for B in np.array(TOPO_BG, np.float32):
        d = C - B
        al = np.clip(((a - B) * d).sum(-1) / (d * d).sum(), 0, 1)
        res = np.linalg.norm(a - (B + al[..., None] * d), axis=-1)
        m = res < best_r
        best_r[m] = res[m]; best_a[m] = al[m]
    mask = (best_a > 0.4) & (best_r < 20)
    lab, n = ndi.label(mask, structure=np.ones((3, 3)))
    cnt = np.bincount(lab.ravel(), minlength=n + 1)
    keep = np.zeros(n + 1, bool)
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None or cnt[i] < 25:
            continue
        h = sl[0].stop - sl[0].start; w = sl[1].stop - sl[1].start
        if max(h, w) < 15:
            continue
        keep[i] = cnt[i] / (h * w) < 0.5 or max(h, w) > 60   # линии, а не залитые значки/текст
    mask = keep[lab]
    skel = _zhang_suen(mask)
    nb = lambda s_: sum(np.roll(np.roll(np.pad(s_, 1).astype(np.int32), dy, 0), dx, 1)
                        for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx)[1:-1, 1:-1]
    pr = skel.copy()
    for _ in range(3):                      # обрезаем шпоры скелета (≤ 3 px), штрихи откосов длиннее
        pr &= ~(pr & (nb(pr) <= 1))
    P = np.pad(pr, 1).astype(np.int32)
    ring = [P[:-2, 1:-1], P[:-2, 2:], P[1:-1, 2:], P[2:, 2:], P[2:, 1:-1], P[2:, :-2], P[1:-1, :-2], P[:-2, :-2]]
    cross = sum(((ring[k] == 0) & (ring[(k + 1) % 8] == 1)).astype(np.int32) for k in range(8))
    branch = pr & (cross >= 3)              # настоящие ветвления (число переходов 0->1 по кольцу)
    lab2, n2 = ndi.label(skel, structure=np.ones((3, 3)))
    L = np.bincount(lab2.ravel(), minlength=n2 + 1)
    Bn = np.bincount(lab2[branch], minlength=n2 + 1)
    kind, npix = {}, {}
    for i in range(1, n2 + 1):
        if L[i] < 15:
            continue
        kind[i] = "hachure" if Bn[i] / L[i] > 0.06 else "contour"
        npix[i] = int(L[i])
    r, c = np.nonzero(skel & np.isin(lab2, list(kind.keys())))
    comp = lab2[r, c]
    x, y = rasterio.transform.xy(tr, r, c)
    t = Transformer.from_crs(src_crs, WORLD_CRS, always_xy=True)
    wx, wy = t.transform(np.asarray(x), np.asarray(y))
    out = {"xy": np.c_[wx, wy], "comp": comp, "kind": kind, "npix": npix}
    if cache is not None:
        Path(cache).parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(cache, xy=out["xy"], comp=comp, kind=np.array(kind, dtype=object),
                            npix=np.array(npix, dtype=object))
    return out


def assign_levels(ct, grid, B, log=print):
    """Высоты горизонталей: медиана B вдоль линии, сдвиг датума FABDEM<->карта (bias) подбирается глобально,
    уровень = ближайший кратный INTERVAL. Неоднозначные и не согласующиеся с DEM линии отбрасываются.
    Возвращает (xy, z_target, comp) принятых точек и сводку."""
    xy, comp = ct["xy"], ct["comp"]
    inside = (xy[:, 0] > grid.min_x) & (xy[:, 0] < grid.max_x) & (xy[:, 1] > grid.min_y) & (xy[:, 1] < grid.max_y)
    z = grid.sample_bilinear(B, xy[:, 0], xy[:, 1])
    ids = [i for i, k in ct["kind"].items() if k == "contour"]
    stats = {}
    order = np.argsort(comp, kind="stable")
    cs = comp[order]
    starts = np.searchsorted(cs, ids); ends = np.searchsorted(cs, ids, side="right")
    for i, a, b in zip(ids, starts, ends):
        sel = order[a:b]
        sel = sel[inside[sel]]
        if len(sel) < 20:
            continue
        stats[i] = (float(np.median(z[sel])), float(np.std(z[sel])), sel)
    med = np.array([v[0] for v in stats.values()]); sd = np.array([v[1] for v in stats.values()])
    ok = sd < LEVEL_SD
    offs = np.arange(-INTERVAL / 2, INTERVAL / 2, 0.25)
    score = []
    for b in offs:
        d = (med[ok] - b) % INTERVAL
        score.append(np.minimum(d, INTERVAL - d).mean())
    bias = float(offs[int(np.argmin(score))])
    P, Z, C = [], [], []
    n_amb = n_sd = 0
    for i, (m, s, sel) in stats.items():
        if s >= LEVEL_SD:
            n_sd += 1; continue
        lev = round((m - bias) / INTERVAL) * INTERVAL
        if abs(m - (lev + bias)) > LEVEL_TOL:
            n_amb += 1; continue
        P.append(xy[sel]); Z.append(np.full(len(sel), lev + bias)); C.append(np.full(len(sel), i))
    info = {"lines": len(stats), "used": len(P), "ambiguous": n_amb, "disagree_dem": n_sd, "bias": bias,
            "hachure_lines": sum(1 for k in ct["kind"].values() if k == "hachure")}
    if not P:
        return np.zeros((0, 2)), np.zeros(0), np.zeros(0, int), info
    return np.concatenate(P), np.concatenate(Z), np.concatenate(C), info


def contour_correction(grid, B, pts, zt, sigmas=(10.0, 30.0), w0=0.5):
    """Поправка «уровень горизонтали − база», интерполированная нормированной свёрткой (мелкий масштаб
    внутри крупного), с доверием, затухающим вдали от линий."""
    if len(pts) == 0:
        return np.zeros_like(B), np.zeros_like(B)
    r, c = grid.to_rc(pts[:, 0], pts[:, 1])
    ri = np.clip(np.round(r).astype(int), 0, grid.rows - 1); ci = np.clip(np.round(c).astype(int), 0, grid.cols - 1)
    e = zt - grid.sample_bilinear(B, pts[:, 0], pts[:, 1])
    E = np.zeros_like(B); Wt = np.zeros_like(B)
    np.add.at(E, (ri, ci), e); np.add.at(Wt, (ri, ci), 1.0)
    corr = np.zeros_like(B); conf = np.zeros_like(B)
    for sg in sigmas[::-1]:            # крупный масштаб, затем мелкий поверх
        s = sg / grid.cell
        N = gaussian_filter(E, s); D = gaussian_filter(Wt, s)
        cs = np.where(D > 1e-6, N / np.maximum(D, 1e-6), 0.0)
        cf = np.clip(D * math.sqrt(2 * np.pi) * s * w0, 0, 1)   # 1 = на линии (≥ 2 точки на ячейку), спад ~ σ
        corr = corr * (1 - cf) + cs * cf
        conf = np.maximum(conf, cf)
    return np.clip(corr, -CORR_MAX, CORR_MAX), conf


# ---------------------------------------------------------------- геометрия
def _resample(P, step):
    P = np.asarray(P, float)
    s = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
    if s[-1] < 1e-6:
        return P[:1], s[:1]
    n = max(2, int(math.ceil(s[-1] / step)) + 1)
    t = np.linspace(0, s[-1], n)
    return np.c_[np.interp(t, s, P[:, 0]), np.interp(t, s, P[:, 1])], t


def _normals(P):
    d = np.gradient(P, axis=0)
    L = np.hypot(*d.T); L[L == 0] = 1
    t = d / L[:, None]
    return np.c_[-t[:, 1], t[:, 0]], t


def _smoothstep(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def _isotonic_dec(y, w=None):
    """Невозрастающая регрессия (PAVA)."""
    y = np.asarray(y, float)
    w = np.ones_like(y) if w is None else np.asarray(w, float)
    v, ww, n = [], [], []
    for yi, wi in zip(-y, w):
        v.append(yi); ww.append(wi); n.append(1)
        while len(v) > 1 and v[-2] > v[-1]:
            tw = ww[-2] + ww[-1]
            vm = (v[-2] * ww[-2] + v[-1] * ww[-1]) / tw
            cnt = n[-2] + n[-1]
            v[-2:] = [vm]; ww[-2:] = [tw]; n[-2:] = [cnt]
    return -np.repeat(v, n)


# ---------------------------------------------------------------- долины
VALLEY_TYPES = {"river", "stream", "canal", "drain"}
SIDE_GRADE = 0.12        # уклон борта долины по умолчанию (без данных); с лестницами рядом — по ним
STEP_CAL_DIST = 150.0    # м: лестницы ближе к оси водотока калибруют крутизну бортов (Лыбедь: 17–44 %, медиана ~26 %)
VALLEY_MAX = 140.0       # м: дальше от оси профиль не трогаем
VALLEY_MIN_DEPTH = 2.0   # м: мельче — не долина


def waterway_lines(osm, grid, water_polys):
    """Оси водотоков в мире (включая участки в трубе), без участков внутри полигонов воды и без Оки."""
    from shapely.geometry import box
    from shapely.ops import linemerge, unary_union
    wb = box(grid.min_x, grid.min_y, grid.max_x, grid.max_y)
    wu = unary_union([p for p in water_polys]) if water_polys else None
    out = []
    for wid, (refs, tg) in osm.ways.items():
        if tg.get("waterway") not in VALLEY_TYPES or tg.get("name", "").startswith("Ока"):
            continue
        P = osm.way_xy(wid)
        if len(P) < 2:
            continue
        ls = LineString(P).intersection(wb)
        if wu is not None and not ls.is_empty:
            ls = ls.difference(wu.buffer(5))
        for g in getattr(ls, "geoms", [ls]):
            if g.is_empty or g.geom_type != "LineString" or g.length < 30:
                continue
            out.append((wid, np.asarray(g.coords), tg))
    return out


def carve_valleys(H, grid, lines, log=print, step=5.0, xs_step=2.5, stairs=()):
    """Перепрофилирование долин вдоль водотоков: плоское дно + крутые борта на месте 50%-перехода
    сглаженного профиля (размытие сохраняет положение середины ступени), тальвег монотонно вниз по течению.
    Возвращает новую сетку, вес применения и сводку по линиям."""
    d = np.arange(-VALLEY_MAX, VALLEY_MAX + 1e-6, xs_step)
    samples = []   # (P, n, profile_new(d), floor)
    summary = []
    # 1. поперечники и наблюдаемое дно
    per_line = []
    for wid, P0, tg in lines:
        P, s = _resample(P0, step)
        if len(P) < 3:
            continue
        n, _ = _normals(P)
        X = P[:, None, 0] + n[:, None, 0] * d[None]
        Y = P[:, None, 1] + n[:, None, 1] * d[None]
        O = grid.sample_bilinear(H, X.ravel(), Y.ravel()).reshape(X.shape)
        core = np.abs(d) <= 12.0
        floor = O[:, core].min(1)
        per_line.append([wid, tg, P, n, O, floor, s])
    # 2. монотонный тальвег (по направлению OSM = вниз по течению); стыки линий: начало не выше конца притока
    ends = {}
    for L in per_line:
        P = L[2]
        L[5] = _isotonic_dec(L[5])
    for _ in range(3):
        tree_end = cKDTree(np.array([L[2][-1] for L in per_line]))
        for L in per_line:
            dd, k = tree_end.query(L[2][0], k=4, distance_upper_bound=8.0)
            for di, ki in zip(np.atleast_1d(dd), np.atleast_1d(k)):
                if np.isfinite(di) and per_line[ki] is not L:
                    L[5] = np.minimum(L[5], per_line[ki][5][-1])
            L[5] = np.minimum.accumulate(L[5])
    # 3. новые поперечники: параметры бортов (бровка, 50%-переход) по каждой стороне, сглаженные вдоль оси
    from scipy.ndimage import gaussian_filter1d
    allP, allN, allT, allR = [], [], [], []
    for wid, tg, P, n, O, floor, s in per_line:
        m_ = len(P)
        ax = LineString(P)
        cal = [dz / max(L_, 1.0) for st, dz, L_ in stairs if st.distance(ax) < STEP_CAL_DIST]
        grade = float(np.clip(np.median(cal), 0.12, 0.4)) if cal else SIDE_GRADE
        par = {}
        for side in (1, -1):
            idx = np.where(d * side >= 0)[0]
            idx = idx[np.argsort(np.abs(d[idx]))]
            dist = np.abs(d[idx])
            zb_a = np.full(m_, np.nan); d50_a = np.full(m_, np.nan); dkb_a = np.full(m_, np.nan)
            for i in range(m_):
                pr = O[i, idx]
                zf = floor[i]
                # бровка: максимум до первого заметного спуска (дальше — соседний склон)
                run = np.maximum.accumulate(pr)
                drop = run - pr > 1.0
                lim = np.argmax(drop) if drop.any() else len(pr)
                kb = int(np.argmax(pr[:max(lim, 2)]))
                if pr[kb] - zf < VALLEY_MIN_DEPTH or dist[kb] < 10:
                    continue
                k50 = int(np.argmax(pr >= zf + 0.5 * (pr[kb] - zf)))
                zb_a[i], d50_a[i], dkb_a[i] = pr[kb], dist[k50], dist[kb]
            ok = np.isfinite(zb_a).astype(float)
            sg = 3.0   # отсчётов (15 м)
            den = gaussian_filter1d(ok, sg, mode="nearest")
            sm = lambda v: gaussian_filter1d(np.nan_to_num(v), sg, mode="nearest") / np.maximum(den, 1e-6)
            par[side] = (idx, dist, sm(zb_a), sm(d50_a), sm(dkb_a), den > 0.5)
        T = O.copy()
        reach = np.zeros(m_)
        depths = []
        for i in range(m_):
            zf = floor[i]
            newp = O[i].copy()
            rmax = 0.0
            for side in (1, -1):
                idx, dist, zb_s, d50_s, dkb_s, valid = par[side]
                if not valid[i]:
                    continue
                zb, d50, dkb = zb_s[i], d50_s[i], dkb_s[i]
                depth = zb - zf
                if depth < VALLEY_MIN_DEPTH * 0.75:
                    continue
                w = float(np.clip(depth / grade, 8.0, max(2 * d50, 8.0)))
                a = max(d50 - w / 2, 0.0)
                top = a + w
                dkb = max(dkb, top + 5.0)
                pr = O[i, idx]
                v = zf + depth * _smoothstep((dist - a) / w)
                up = dist > top
                bl = np.clip((dist[up] - top) / (dkb - top), 0, 1)
                v[up] = zb + (pr[up] - zb) * bl
                v[dist > dkb] = pr[dist > dkb]
                newp[idx] = v
                rmax = max(rmax, dkb); depths.append(depth)
            core = np.abs(d) <= 6.0
            newp[core] = np.minimum(newp[core], zf)     # дно не выше монотонного тальвега
            T[i] = newp
            reach[i] = rmax
        allP.append(P); allN.append(n); allT.append(T); allR.append(reach)
        summary.append({"osm": int(wid), "name": tg.get("name", ""), "tunnel": tg.get("tunnel", ""),
                        "len": float(s[-1]), "depth_med": float(np.median(depths)) if depths else 0.0,
                        "floor_drop": float(floor[0] - floor[-1]), "side_grade": round(grade, 3), "n_stairs": len(cal)})
    if not allP:
        return H, np.zeros_like(H), summary
    P = np.concatenate(allP); N = np.concatenate(allN); T = np.concatenate(allT); Rch = np.concatenate(allR)
    # 4. перенос на сетку: ближайший поперечник
    xs, ys = grid.node_xy()
    gx, gy = np.meshgrid(xs, ys)
    pts = np.c_[gx.ravel(), gy.ravel()]
    dist, k = cKDTree(P).query(pts, distance_upper_bound=VALLEY_MAX, workers=-1)
    ok = np.isfinite(dist)
    kk = k[ok]
    sd = ((pts[ok] - P[kk]) * N[kk]).sum(1)
    fi = (sd + VALLEY_MAX) / xs_step
    i0 = np.clip(np.floor(fi).astype(int), 0, len(d) - 2); f = fi - i0
    val = T[kk, i0] * (1 - f) + T[kk, i0 + 1] * f
    reach = Rch[kk]
    w = 1 - _smoothstep((np.abs(sd) - reach) / 15.0)
    w[reach <= 0] = 0
    out = H.ravel().copy(); W = np.zeros(H.size)
    W[np.where(ok)[0]] = w
    out[ok] = H.ravel()[ok] * (1 - w) + val * w
    # гладкость вдоль оси (соседние поперечники различаются): лёгкий гаусс только приращения
    out = out.reshape(H.shape)
    dlt = gaussian_filter(out - H, 1.0)
    return H + dlt, W.reshape(H.shape), summary


# ---------------------------------------------------------------- жёсткие линии
def _line_frame(grid, P, reach):
    """Узлы сетки в пределах reach от ломаной P: индексы, signed distance u (слева +), позиция вдоль t, длина."""
    ls = LineString(P)
    x0, y0, x1, y1 = ls.bounds
    xs, ys = grid.node_xy()
    ci = np.where((xs >= x0 - reach) & (xs <= x1 + reach))[0]
    ri = np.where((ys >= y0 - reach) & (ys <= y1 + reach))[0]
    if not len(ci) or not len(ri):
        return None
    gx, gy = np.meshgrid(xs[ci], ys[ri])
    Q = np.c_[gx.ravel(), gy.ravel()]
    # ближайший сегмент
    A = P[:-1]; Bv = P[1:] - P[:-1]
    L2 = (Bv ** 2).sum(1); L2[L2 == 0] = 1e-9
    t = np.clip((((Q[:, None, :] - A[None]) * Bv[None]).sum(-1)) / L2[None], 0, 1)
    proj = A[None] + t[..., None] * Bv[None]
    dd = np.hypot(*(Q[:, None, :] - proj).transpose(2, 0, 1))
    k = dd.argmin(1)
    rr = np.arange(len(Q))
    seglen = np.sqrt(L2)
    cum = np.r_[0, np.cumsum(seglen)]
    along = cum[k] + t[rr, k] * seglen[k]
    v = Q - proj[rr, k]
    cr = Bv[k, 0] * v[:, 1] - Bv[k, 1] * v[:, 0]
    u = np.sign(cr) * dd[rr, k]
    # за концами — расстояние вдоль продолжения
    beyond = np.zeros(len(Q))
    tk = t[rr, k]
    m0 = (k == 0) & (tk <= 0)
    beyond[m0] = -((Q[m0] - P[0]) * (P[1] - P[0])).sum(1) / max(seglen[0], 1e-9)
    m1 = (k == len(A) - 1) & (tk >= 1)
    beyond[m1] = ((Q[m1] - P[-1]) * (P[-1] - P[-2])).sum(1) / max(seglen[-1], 1e-9)
    return ri, ci, u.reshape(len(ri), len(ci)), along.reshape(len(ri), len(ci)), \
        np.maximum(beyond, 0).reshape(len(ri), len(ci)), cum[-1]


def apply_scarp(H, grid, P, dz, half_w, fade=25.0, end_fade=40.0):
    """Ступень вдоль ломаной P: левая сторона (u > 0) выше правой на dz сверх текущего перепада.
    half_w — полуширина перехода (м). Перепад набирается внутри |u| < half_w, гаснет за fade и за концами."""
    fr = _line_frame(grid, P, half_w + fade + 5)
    if fr is None:
        return H, 0.0
    ri, ci, u, along, beyond, L = fr
    xa = P[len(P) // 2]
    n, _ = _normals(P)
    nn = n[len(P) // 2]
    za, zb = grid.sample_bilinear(H, [xa[0] + nn[0] * half_w, xa[0] - nn[0] * half_w],
                                  [xa[1] + nn[1] * half_w, xa[1] - nn[1] * half_w])
    extra = dz - (za - zb)
    if abs(extra) < 0.1:
        return H, 0.0
    S = _smoothstep((u + half_w) / (2 * half_w)) - 0.5
    F = 1 - _smoothstep((np.abs(u) - half_w) / fade)
    G = 1 - _smoothstep(beyond / end_fade)
    H = H.copy()
    H[np.ix_(ri, ci)] += extra * S * F * G
    return H, extra


def apply_ridge(H, grid, P, height, top_half, side_grade=0.5, base=None, area=False):
    """Вал/насыпь вдоль P: гребень на height над окружением (если DEM уже выше — не трогаем)."""
    w_side = height / side_grade
    fr = _line_frame(grid, P, top_half + w_side + 2)
    if fr is None:
        return H, 0.0
    ri, ci, u, along, beyond, L = fr
    sub = H[np.ix_(ri, ci)]
    ref = base[np.ix_(ri, ci)] if base is not None else sub
    if area and len(P) > 3 and np.allclose(P[0], P[-1]):
        # замкнутый контур = площадь насыпи (например, Кремлёвский вал): внутри полная высота, снаружи откос
        import shapely
        from shapely.geometry import Polygon
        xs, ys = grid.node_xy()
        gx, gy = np.meshgrid(xs[ci], ys[ri])
        inside = shapely.contains_xy(Polygon(P), gx, gy)
        prof = np.where(inside, 1.0, 1 - _smoothstep(np.abs(u) / w_side))
    else:
        prof = (1 - _smoothstep((np.abs(u) - top_half) / w_side)) * (1 - _smoothstep(beyond / 10.0))
    tgt = ref + height * prof
    H = H.copy()
    H[np.ix_(ri, ci)] = np.maximum(sub, tgt)
    return H, height


def breaklines(H, grid, osm, log=print, segments=()):
    """Лестницы, подпорные стены, обрывы, откосы, валы и насыпи/выемки дорог из OSM. Возвращает (H, список)."""
    xs_ok = lambda P: (P[:, 0].min() > grid.min_x) & (P[:, 0].max() < grid.max_x) & \
                      (P[:, 1].min() > grid.min_y) & (P[:, 1].max() < grid.max_y)
    done = []
    smooth_ref = gaussian_filter(H, 30.0 / grid.cell)

    def phase(tg):
        if tg.get("highway") == "steps":
            return 2
        if tg.get("barrier") == "retaining_wall" or tg.get("natural") in ("cliff", "earth_bank"):
            return 1
        return 0
    # лестницы с числом ступеней — калибровка высоты валов, к которым они примыкают
    stair_dz = []
    for wid, (refs, tg) in osm.ways.items():
        n = tg.get("step_count", "")
        if tg.get("highway") == "steps" and n.isdigit() and int(n) >= 8:
            stair_dz.append((LineString(osm.way_xy(wid)), STEP_RISE * int(n)))
    todo = sorted(((phase(tg), wid) for wid, (refs, tg) in osm.ways.items()
                   if tg.get("highway") == "steps" or tg.get("barrier") == "retaining_wall"
                   or tg.get("natural") in ("cliff", "earth_bank") or tg.get("man_made") in ("embankment", "dyke")
                   or tg.get("embankment") == "yes" or tg.get("cutting") == "yes"))
    for _, wid in todo:
        refs, tg = osm.ways[wid]
        P = osm.way_xy(wid)
        if len(P) < 2 or not xs_ok(P):
            continue
        Ls = float(np.hypot(*np.diff(P, axis=0).T).sum())
        hw = tg.get("highway")
        if hw == "steps":
            n = tg.get("step_count")
            inc = tg.get("incline")
            za, zb = grid.sample_bilinear(H, P[[0, -1], 0], P[[0, -1], 1])
            if n and n.isdigit() and int(n) >= 8:
                dz = STEP_RISE * int(n)
                src = "step_count"
            elif Ls >= 15 and abs(zb - za) >= 0.5:
                dz = max(abs(zb - za), min(0.15 * Ls, 6.0))   # оценка: марши с площадками ~15 % по длине
                src = "length"
            else:
                continue
            sign = 1 if inc == "up" else -1 if inc == "down" else (1 if zb >= za else -1)
            # линия обрыва — перпендикуляр к маршу через его середину, длина по 30 м в стороны
            a, b = P[0], P[-1]
            t = (b - a) / max(np.hypot(*(b - a)), 1e-6)
            nrm = np.array([-t[1], t[0]])
            mid = (a + b) / 2
            Q = np.array([mid - nrm * 30, mid + nrm * 30])   # слева от Q (по ходу Q) — сторона b
            # левая сторона Q = направление -t... проверим знак: левая нормаль Q-направления = -t
            dz_left = -sign * dz                               # слева (сторона a) выше, если идём вниз
            H, ex = apply_scarp(H, grid, Q, dz_left, half_w=max(Ls / 2, 4.0), fade=20.0, end_fade=40.0)
            done.append({"osm": int(wid), "type": "steps", "dz": round(sign * dz, 2), "src": src,
                         "added": round(abs(ex), 2), "xy": [round(float(mid[0])), round(float(mid[1]))]})
        elif tg.get("barrier") == "retaining_wall" or tg.get("natural") in ("cliff", "earth_bank"):
            # OSM: нижняя сторона справа по ходу линии
            n_, _ = _normals(P)
            m = len(P) // 2
            probe = 30.0 if tg.get("natural") == "earth_bank" else 15.0
            zl, zr = grid.sample_bilinear(H, [P[m, 0] + n_[m, 0] * probe, P[m, 0] - n_[m, 0] * probe],
                                          [P[m, 1] + n_[m, 1] * probe, P[m, 1] - n_[m, 1] * probe])
            ht = tg.get("height", "")
            try:
                dz = float(ht.split()[0])
                src = "height"
            except (ValueError, IndexError):
                dz = max(zl - zr, {"retaining_wall": 1.5, "cliff": 3.0, "earth_bank": 2.0}[
                    "retaining_wall" if tg.get("barrier") else tg["natural"]])
                src = "dem/default"
            half = 1.5 if tg.get("barrier") else max(4.0, dz / (2 * 0.6))   # откос/обрыв не круче ~31°
            H, ex = apply_scarp(H, grid, P, dz, half_w=half, fade=probe, end_fade=15.0)
            done.append({"osm": int(wid), "type": tg.get("barrier") or tg.get("natural"), "dz": round(dz, 2),
                         "src": src, "added": round(abs(ex), 2), "len": round(Ls)})
        elif tg.get("man_made") in ("embankment", "dyke") and not hw:
            ls = LineString(P)
            near = [dz for st, dz in stair_dz if st.distance(ls) < 15.0]
            ov = [float(sg["height"]) for sg in segments if sg.get("class") == "ridge" and sg.get("way") == wid]
            ht, src = (ov[0], "override") if ov else (max(near), "steps") if near else (3.0, "default")
            H, _ = apply_ridge(H, grid, P, ht, top_half=3.0, side_grade=0.5, base=smooth_ref, area=True)
            done.append({"osm": int(wid), "type": tg["man_made"], "dz": round(ht, 2), "src": src, "len": round(Ls),
                         "closed": bool(np.allclose(P[0], P[-1]))})
        elif hw and (tg.get("embankment") == "yes" or tg.get("cutting") == "yes"):
            width = 8.0 if hw in ("primary", "secondary", "trunk") else 5.0
            kind = "embankment" if tg.get("embankment") == "yes" else "cutting"
            H, info_ = apply_road_fill(H, grid, P, kind, width / 2 + 2.0)
            done.append({"osm": int(wid), "type": "road_" + kind, "src": "osm", "len": round(Ls), **info_})
    # участки дорог из data/overrides/elevation.json (дамбы через овраги и т.п.)
    for seg in segments:
        if seg.get("class") == "ridge":
            continue   # высота вала — в ветке man_made=embankment выше
        P = segment_xy(osm, seg)
        if P is None:
            done.append({"segment": seg.get("id"), "error": "way/nodes not found"})
            continue
        if seg.get("class") in ("embankment", "cutting"):
            H, info_ = apply_road_fill(H, grid, P, seg["class"], float(seg.get("half_width", 9.0)),
                                       side=float(seg.get("side_m", 3.0)), z_top=seg.get("z_top"),
                                       extend=float(seg.get("extend_m", 30.0)))
            done.append({"segment": seg.get("id"), "type": "segment_" + seg["class"], "len": round(LineString(P).length), **info_})
    return H, done


def segment_xy(osm, seg, extend=0.0):
    """Ломаная участка пути seg = {"way": id, "from": node, "to": node} (узлы включительно)."""
    if seg.get("way") not in osm.ways or "from" not in seg or "to" not in seg:
        return None
    refs, _ = osm.ways[seg["way"]]
    refs = list(refs)
    try:
        a, b = refs.index(int(seg["from"])), refs.index(int(seg["to"]))
    except ValueError:
        return None
    if a > b:
        a, b = b, a
    i, ok = osm.node_index(np.array(refs[a:b + 1]))
    return osm.xy[i[ok]] if ok.all() and b > a else None


def apply_road_fill(H, grid, P, kind, half_w, side=None, z_top=None, extend=0.0):
    """Насыпь (дамба) / выемка дороги: верх по прямой между высотами рельефа на концах участка
    (насыпь через овраг — как дамба ул. Ленина над Лыбедским бульваром), не ниже (не выше для выемки)
    текущего рельефа. Откос side м (по умолчанию 1:1.5 от высоты)."""
    if extend > 0:   # концы участка продлеваем до бровок: дамба опирается на борта оврага
        t0 = (P[0] - P[1]) / max(np.hypot(*(P[0] - P[1])), 1e-6)
        t1 = (P[-1] - P[-2]) / max(np.hypot(*(P[-1] - P[-2])), 1e-6)
        P = np.r_[[P[0] + t0 * extend], P, [P[-1] + t1 * extend]]
    fr = _line_frame(grid, P, half_w + 25.0)
    if fr is None:
        return H, {}
    ri, ci, u, along, beyond, L = fr
    za, zb = grid.sample_bilinear(H, P[[0, -1], 0], P[[0, -1], 1])
    if z_top is not None:
        za = zb = float(z_top)
    line = za + (zb - za) * np.clip(along / max(L, 1e-6), 0, 1)
    sub = H[np.ix_(ri, ci)]
    dh = np.abs(line - sub)
    sw = np.full_like(sub, side) if side is not None else 1.5 * np.maximum(dh, 0.5)
    w = (1 - _smoothstep((np.abs(u) - half_w) / np.maximum(sw, 1.0))) * (1 - _smoothstep(beyond / 8.0))
    if kind == "embankment":
        new = np.maximum(sub, sub + (line - sub).clip(0) * w)
    else:
        new = np.minimum(sub, sub + (line - sub).clip(None, 0) * w)
    H = H.copy()
    H[np.ix_(ri, ci)] = new
    on = (np.abs(u) <= half_w) & (beyond == 0)
    return H, {"dz_max": round(float(np.abs(new - sub)[on].max()) if on.any() else 0.0, 2)}
    return H, done


# ---------------------------------------------------------------- лес/парки: остатки крон в FABDEM
def canopy_fix(R, grid, transform, osm, protect, rad=60.0, keep=1.0):
    """В парках и лесах положительные аномалии уже rad (R − открытие диском rad) срезаются до keep м:
    FABDEM не всегда убирает кроны (сквер на Соборной, ~+6 м). Зоны рядом с горизонталями не трогаем."""
    from rasterio.features import rasterize
    polys = []
    for wid, (refs, tg) in osm.ways.items():
        if (tg.get("leisure") in ("park", "garden") or tg.get("landuse") in ("forest", "cemetery")
                or tg.get("natural") == "wood") and refs[0] == refs[-1]:
            p = osm.way_polygon(wid)
            if p is not None:
                polys.append(p)
    for rid, tg, mem in osm.rels:
        if tg.get("type") == "multipolygon" and (tg.get("leisure") == "park" or tg.get("landuse") == "forest"
                                                  or tg.get("natural") == "wood"):
            p = osm.rel_polygon(mem)
            if p is not None:
                polys.append(p)
    if not polys:
        return R, 0
    M = rasterize([(p, 1) for p in polys], out_shape=R.shape, transform=transform, fill=0).astype(float)
    M *= (1 - protect)
    M = gaussian_filter(M, 2.0)
    r = int(rad / grid.cell)
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    O = ndi.grey_opening(R, footprint=(xx ** 2 + yy ** 2) <= r * r)
    A = R - O
    cut = np.maximum(A - keep, 0) * M
    return R - cut, int((cut > 0.5).sum())


# ---------------------------------------------------------------- сборка
def stairs_list(osm):
    """[(LineString, перепад м, длина м)] лестниц с числом ступеней (≥ 8)."""
    out = []
    for wid, (refs, tg) in osm.ways.items():
        n = tg.get("step_count", "")
        if tg.get("highway") == "steps" and n.isdigit() and int(n) >= 8:
            ls = LineString(osm.way_xy(wid))
            out.append((ls, STEP_RISE * int(n), ls.length))
    return out


def build(grid, transform, osm, water_polys, fabdem, topo_tif, work, log=print, base_smooth=7.5, overrides=None):
    """Рельеф v2 в узлах grid (замена сглаженного FABDEM v1). Возвращает (H, layers, info)."""
    from .terrain import load_dem
    work = Path(work); work.mkdir(parents=True, exist_ok=True)
    R, _ = load_dem(fabdem, grid, smooth_m=0)
    info = {}
    # горизонтали
    ct = extract_contours(topo_tif, cache=work / "contours.npz") if Path(topo_tif).exists() else None
    protect = np.zeros_like(R)
    if ct is not None:
        r, c = grid.to_rc(ct["xy"][:, 0], ct["xy"][:, 1])
        ok = (r >= 0) & (r < grid.rows - 1) & (c >= 0) & (c < grid.cols - 1)
        Pm = np.zeros_like(R)
        Pm[np.round(r[ok]).astype(int), np.round(c[ok]).astype(int)] = 1
        protect = np.clip(gaussian_filter(Pm, 25.0 / grid.cell) * 20, 0, 1)
    R1, n_cut = canopy_fix(R, grid, transform, osm, protect)
    info["canopy_cells"] = n_cut
    B = gaussian_filter(R1, base_smooth / grid.cell, mode="nearest")
    corr = conf = np.zeros_like(B)
    if ct is not None:
        pts, zt, comp, ci = assign_levels(ct, grid, B, log)
        corr, conf = contour_correction(grid, B, pts, zt)
        info["contours"] = ci
        np.savez_compressed(work / "contours_used.npz", xy=pts, z=zt, comp=comp)
    H1 = B + corr
    lines = waterway_lines(osm, grid, water_polys)
    H2, wv, vsum = carve_valleys(H1, grid, lines, log, stairs=stairs_list(osm))
    info["valleys"] = vsum
    from config import ROOT
    ov = Path(overrides) if overrides else ROOT / "data" / "overrides" / "elevation.json"
    segs = json.loads(ov.read_text(encoding="utf-8")).get("segments", []) if ov.exists() else []
    H3, bl = breaklines(H2, grid, osm, log, segments=segs)
    info["breaklines"] = bl
    layers = {"raw": R, "canopy": R1, "base": B, "contour_corr": corr, "contour_conf": conf,
              "valley": H2 - H1, "valley_w": wv, "breaklines": H3 - H2}
    (work / "terrain_v2_info.json").write_text(json.dumps(info, ensure_ascii=False, indent=1, default=float))
    log(f"рельеф v2: горизонталей {info.get('contours', {}).get('used', 0)}/{info.get('contours', {}).get('lines', 0)} "
        f"(сдвиг датума {info.get('contours', {}).get('bias', 0):+.2f} м), долин {len(vsum)}, "
        f"жёстких линий {len(bl)}, срезано крон {n_cut} узлов; |Δ| от v1-базы до {np.abs(H3 - B).max():.1f} м")
    return H3, layers, info
