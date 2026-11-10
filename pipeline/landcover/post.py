"""Чистка карты: сглаживание вероятностей (CRF-подобно), тени, слияние с OSM, минимальные площади → lc_1m.tif."""
import numpy as np
import rasterio
from scipy.ndimage import distance_transform_edt, gaussian_filter, label as cc_label, uniform_filter

from . import context
from .classes import C, NCLS, OUT, PALETTE, Grid1m

# минимальная площадь пятна класса, м² (меньше — растворяется в соседях)
MIN_AREA = {"canopy": 6, "conifer": 12, "thicket": 20, "meadow": 40, "lawn": 40, "garden": 40, "bare": 12, "sand": 30,
            "gravel": 25, "water": 80, "paved": 12, "building": 10}
BLOCK = 1000
PAD = 24


def fill_holes(lab, hole, src=None):
    """Пиксели hole получают метку ближайшего пикселя-источника (по умолчанию — любого без hole)."""
    if not hole.any():
        return lab
    src = ~hole if src is None else src
    if not src.any():
        return lab
    _, (ri, ci) = distance_transform_edt(~src, return_indices=True)
    out = lab.copy()
    out[hole] = lab[ri[hole], ci[hole]]
    return out


def smooth_argmax(P, SH, OK, r0, r1, c0, c1):
    R, Cc = P.shape[1:]
    a0, a1, b0, b1 = max(r0 - PAD, 0), min(r1 + PAD, R), max(c0 - PAD, 0), min(c1 + PAD, Cc)
    p = P[:, a0:a1, b0:b1].astype(np.float32) / 255
    valid = p.sum(0) > 0.5
    # «крыша» и «вода» — только у зданий/воды OSM (иначе тени, тёмные огороды и шиферные сараи становятся «зданиями»)
    ok = OK[:, a0:a1, b0:b1]
    p[C["building"] - 1] *= ok[0]
    p[C["water"] - 1] *= ok[1]
    # «асфальт» вне асфальта OSM в частном секторе — почти всегда дворы, сараи, грунтовки: штраф по доле частных домов
    p[C["paved"] - 1] *= ok[2]
    # анизотропии нет: гаусс 1.2 м по вероятностям ~ парные потенциалы CRF (соседи тянут к своему классу)
    ps = np.stack([gaussian_filter(p[k], 1.2) for k in range(NCLS)])
    lab = (np.argmax(ps, 0) + 1).astype(np.uint8)
    conf = ps.max(0)
    lab[~valid] = 0
    sh = SH[a0:a1, b0:b1] > 128
    # тень: неуверенные пиксели в тени Яндекса — по соседям (тень дерева на газоне ≠ дерево)
    # тёмное «асфальт/щебень/вода/крыша» в тени вдали от твёрдого OSM — это тень кроны или тень на земле: по соседям
    darkcls = np.isin(lab, [C["paved"], C["gravel"], C["water"], C["building"]]) & (ok[3] < 0.5)
    hole = sh & ((conf < 0.6) | darkcls) & valid
    lab = fill_holes(lab, hole, ~hole & valid & (lab != C["building"]) & (lab != C["water"]))
    s = (slice(r0 - a0, r0 - a0 + (r1 - r0)), slice(c0 - b0, c0 - b0 + (c1 - c0)))
    return lab[s], conf[s]


def run(log):
    g = Grid1m()
    P = np.load(OUT / "proba.npy", mmap_mode="r")
    SH = np.load(OUT / "shadow.npy", mmap_mode="r")
    ctx = context.load()
    M = ctx["M"]
    B = context.B
    has = lambda b: (M & np.uint32(B[b])) != 0
    hard = has("road") | has("parking") | has("hard")
    # частный сектор: доля мелких зданий (< 250 м², в OSM чаще building=yes) в окне 61 м
    lb, n = cc_label(has("bld"))
    sz = np.bincount(lb.ravel()); small = (sz < 250); small[0] = False
    sfrac = uniform_filter(small[lb].astype(np.float32), 61)
    del lb
    pav = np.where(distance_transform_edt(~hard) <= 6.0, 1.0, np.clip(1.0 - sfrac * 5.0, 0.25, 1.0)).astype(np.float32)
    OK = np.stack([distance_transform_edt(~has("bld")) <= 1.0, distance_transform_edt(~has("water")) <= 3.0, pav,
                   distance_transform_edt(~(hard | has("bld"))) <= 4.0]).astype(np.float32)
    L = np.zeros((g.rows, g.cols), np.uint8)
    CF = np.zeros((g.rows, g.cols), np.uint8)
    for r0 in range(0, g.rows, BLOCK):
        for c0 in range(0, g.cols, BLOCK):
            r1, c1 = min(r0 + BLOCK, g.rows), min(c0 + BLOCK, g.cols)
            lab, conf = smooth_argmax(P, SH, OK, r0, r1, c0, c1)
            L[r0:r1, c0:c1] = lab
            CF[r0:r1, c0:c1] = np.round(conf * 255).astype(np.uint8)
    log("  сглаживание и тени")
    # OSM главнее там, где он точен: контуры зданий, вода (кроме нависающих крон/зарослей), проезжая часть
    bld_in = distance_transform_edt(has("bld")) > 1.0
    L[bld_in] = C["building"]
    veg = np.isin(L, [C["canopy"], C["conifer"], C["thicket"]])
    L[has("water") & ~veg] = C["water"]
    road_in = distance_transform_edt(has("road")) > 1.0
    L[road_in & ~veg] = C["paved"]
    # кольцо 3 м вокруг зданий: завал крыш и тень дома дают «огород/щебень/асфальт» — берём класс из-за кольца
    ring = (distance_transform_edt(~has("bld")) <= 3.0) & ~has("bld") & ~has("road")
    badr = ring & np.isin(L, [C["garden"], C["gravel"], C["paved"], C["bare"]])
    L = fill_holes(L, badr, ~ring & ~has("bld") & (L != 0))
    log("  слияние с OSM")
    # минимальные площади
    for name, a in MIN_AREA.items():
        k = C[name]
        lb, n = cc_label(L == k)
        if n == 0:
            continue
        sz = np.bincount(lb.ravel())
        small = sz < a
        small[0] = False
        L[small[lb]] = 0
    # «здание»/«вода» вне OSM (после заливок) и дыры — по ближайшим классам земли
    bad = ((L == C["building"]) & (OK[0] < 0.5)) | ((L == C["water"]) & (OK[1] < 0.5)) | (L == 0)
    L = fill_holes(L, bad, ~bad & (L != C["building"]) & (L != C["water"]))
    L[bld_in] = C["building"]
    log("  минимальные площади")
    prof = dict(driver="GTiff", width=g.cols, height=g.rows, count=1, dtype="uint8", transform=g.transform, compress="deflate",
                tiled=True, blockxsize=512, blockysize=512)
    with rasterio.open(OUT / "lc_1m.tif", "w", **prof) as dst:
        dst.write(L, 1)
        dst.write_colormap(1, {i: c + (255,) for i, c in enumerate(PALETTE)})
    with rasterio.open(OUT / "conf_1m.tif", "w", **prof) as dst:
        dst.write(CF, 1)
    cnt = np.bincount(L.ravel(), minlength=NCLS + 1)
    from .classes import NAMES
    log("  площади, км²: " + ", ".join(f"{NAMES[i - 1]} {cnt[i] / 1e6:.2f}" for i in range(1, NCLS + 1)))
