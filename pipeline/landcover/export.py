"""Экспорт покрова: карта 2 м для игры (game/public/world-veg/landcover.png) и кандидаты деревьев/зарослей для мира.

landcover.png — 8-бит серый, значение = код класса (classes.CLASSES, 0 — нет данных), строка 0 = север (min three.z),
столбец 0 = min x (как veg.png). 2×2 пикселя 1 м → мода (при равенстве — главнее класс с меньшим кодом).

canopy_trees.npz — вершины крон: x, y (мир), r (радиус кроны, м), conif (0/1), lum (яркость кроны), tall (доля тени
на 8–14 м по направлению тени — «высокое»). thicket_pts.npz — точки клумп зарослей: x, y, thick (толщина массива, м).
"""
import json

import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import from_bounds
from scipy.ndimage import distance_transform_edt, gaussian_filter, maximum_filter, shift as nd_shift
from scipy.spatial import cKDTree

from config import ROOT
from . import features as FT
from .classes import C, NAMES, NCLS, ORTHO, OUT, Grid1m

VEG = ROOT / "game/public/world-veg"
CELL = 2


def mode2(L):
    R, Cc = L.shape[0] // 2 * 2, L.shape[1] // 2 * 2
    L = L[:R, :Cc]
    q = [L[0::2, 0::2], L[1::2, 0::2], L[0::2, 1::2], L[1::2, 1::2]]
    best = np.zeros(q[0].shape, np.uint8)
    bc = np.zeros(q[0].shape, np.uint8)
    for k in range(NCLS, -1, -1):     # с конца: при равенстве побеждает меньший код
        n = sum((a == k).astype(np.uint8) for a in q)
        upd = n >= bc
        best[upd] = k
        bc[upd] = n[upd]
    return best


def tree_peaks(L, g, log):
    can = (L == C["canopy"]) | (L == C["conifer"])
    SH = np.load(OUT / "shadow.npy", mmap_mode="r")
    xs, ys, rs, cf, lums, talls = [], [], [], [], [], []
    B = 1000
    for r0 in range(0, g.rows, B):
        for c0 in range(0, g.cols, B):
            r1, c1 = min(r0 + B, g.rows), min(c0 + B, g.cols)
            a0, a1, b0, b1 = max(r0 - 16, 0), min(r1 + 16, g.rows), max(c0 - 16, 0), min(c1 + 16, g.cols)
            m = can[a0:a1, b0:b1]
            if m.sum() < 20:
                continue
            x0, y1 = g.min_x + b0, g.max_y - a0
            x1, y0 = g.min_x + b1, g.max_y - a1
            with rasterio.open(ORTHO / "yandex_0.5m.tif") as src:
                rgb = src.read(window=from_bounds(x0, y0, x1, y1, src.transform), boundless=True,
                               out_shape=(3, a1 - a0, b1 - b0)).astype(np.float32) / 255
            lum = gaussian_filter(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2], 1.2)
            edt = distance_transform_edt(m)
            # вершина кроны: далеко от края массива и светлая (освещённая макушка)
            score = np.minimum(edt, 6) / 6 * 0.55 + np.clip(lum / 0.5, 0, 1) * 0.45
            score = gaussian_filter(score, 1.0)
            pk = (score == maximum_filter(score, size=5)) & m & (edt >= 1.0)
            rr, cc = np.nonzero(pk)
            inner = (rr >= r0 - a0) & (rr < r1 - a0) & (cc >= c0 - b0) & (cc < c1 - b0)
            rr, cc = rr[inner], cc[inner]
            sh = SH[a0:a1, b0:b1].astype(np.float32) / 255
            dx, dy = FT.SHADOW_DIR["yandex"]
            tall = np.zeros(len(rr))
            for d in (8, 11, 14):
                r2 = np.clip(rr + int(round(-dy * d)), 0, sh.shape[0] - 1)
                c2 = np.clip(cc + int(round(dx * d)), 0, sh.shape[1] - 1)
                tall += sh[r2, c2] / 3
            gx, gy = g.xy(rr + a0, cc + b0)
            xs.append(gx); ys.append(gy)
            rs.append(np.clip(edt[rr, cc] * 1.1 + 0.8, 1.5, 7.0))
            cf.append((L[rr + a0, cc + b0] == C["conifer"]).astype(np.uint8))
            lums.append(lum[rr, cc]); talls.append(tall)
    x, y, r = np.concatenate(xs), np.concatenate(ys), np.concatenate(rs)
    cf, lum, tall = np.concatenate(cf), np.concatenate(lums), np.concatenate(talls)
    # прореживание: не ближе 0.8 радиуса кроны большего соседа (жадно от больших крон)
    order = np.argsort(-r)
    kd = cKDTree(np.c_[x, y])
    keep = np.ones(len(x), bool)
    for i in order:
        if not keep[i]:
            continue
        nb = kd.query_ball_point((x[i], y[i]), max(2.6, 0.8 * r[i]))
        for j in nb:
            if j != i and r[j] <= r[i]:
                keep[j] = False
    k = keep
    np.savez(OUT / "canopy_trees.npz", x=x[k], y=y[k], r=r[k], conif=cf[k], lum=lum[k], tall=tall[k])
    log(f"  вершин крон {k.sum()} (до прореживания {len(x)})")


def thicket_points(L, g, log, step=4.0):
    th = L == C["thicket"]
    edt = distance_transform_edt(th)
    rng = np.random.default_rng(5)
    xs = np.arange(g.min_x + step / 2, g.max_x, step)
    ys = np.arange(g.min_y + step / 2, g.max_y, step)
    X, Y = np.meshgrid(xs, ys)
    X = X + rng.uniform(-0.4, 0.4, X.shape) * step
    Y = Y + rng.uniform(-0.4, 0.4, Y.shape) * step
    r, c = g.rc(X.ravel(), Y.ravel())
    ok = (r >= 0) & (r < g.rows) & (c >= 0) & (c < g.cols)
    r, c, X, Y = r[ok], c[ok], X.ravel()[ok], Y.ravel()[ok]
    m = th[r, c]
    np.savez(OUT / "thicket_pts.npz", x=X[m], y=Y[m], thick=edt[r[m], c[m]].astype(np.float32))
    log(f"  точек зарослей {m.sum()}")


def run(log):
    g = Grid1m()
    with rasterio.open(OUT / "lc_1m.tif") as r:
        L = r.read(1)
    L2 = mode2(L)
    VEG.mkdir(parents=True, exist_ok=True)
    Image.fromarray(L2, "L").save(VEG / "landcover.png", optimize=True)
    meta = {"version": 1, "cell": CELL, "cols": int(L2.shape[1]), "rows": int(L2.shape[0]), "minX": g.min_x, "minZ": -g.max_y,
            "classes": ["none"] + NAMES, "source": "build_landcover.py (yandex_0.5m + esri_0.5m, LightGBM)"}
    (VEG / "landcover.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    log(f"  landcover.png {L2.shape[1]}x{L2.shape[0]}, {(VEG / 'landcover.png').stat().st_size / 1e6:.1f} МБ")
    tree_peaks(L, g, log)
    thicket_points(L, g, log)
