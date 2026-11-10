"""Проверка разметки и тротуаров: крупные виды сверху ключевых перекрёстков + числовые проверки высот.
Запуск: cd pipeline && uv run python verify_markings.py [--world <каталог мира>]
Выход: data/processed/markings_check/*.png (если есть data/processed/ortho/yandex_0.5m.tif — ещё *_ortho.png)
"""
import argparse
import json
import struct
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.collections import PolyCollection

from config import DATA_PROCESSED, ROOT, to_world
from world.grid import Grid

OUT = DATA_PROCESSED / "markings_check"
ORTHO = DATA_PROCESSED / "ortho" / "yandex_0.5m.tif"

# (имя файла, подпись, центр x, y (север) в мировых метрах, полуразмер окна)
VIEWS = [
    ("pl_pobedy", "Площадь Победы", *to_world.transform(39.7116, 54.6293), 110),
    ("pervomaysky_sobornaya", "Первомайский × Соборная / Ленина", -890.0, -790.0, 90),
    ("teatralnaya", "Театральная площадь", 470.0, -1615.0, 110),
    ("zebra", "Зебра 1.14.1 у Первомайского (опущенный бордюр)", -833.0, -868.0, 22),
    ("arrows", "Стрелки 1.18, стоп-линия 1.12, зебра (Театральная пл.)", 418.0, -1578.0, 25),
]
COLORS = {"road_asphalt": "#3a3a3c", "road_junction": "#4a4a4e", "sidewalk": "#b9b6ae", "curb": "#6f6c66",
          "road_marking": "#ffffff", "terrain": None}


def read_glb(path):
    """{node: {material: (P, I)}} — без зависимостей (свой писатель, простая структура)."""
    b = Path(path).read_bytes()
    jl = struct.unpack("<I", b[12:16])[0]
    js = json.loads(b[20:20 + jl])
    bin0 = 20 + jl + 8
    def acc(i):
        a = js["accessors"][i]; v = js["bufferViews"][a["bufferView"]]
        dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32}[a["componentType"]]
        nc = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[a["type"]]
        arr = np.frombuffer(b, dt, a["count"] * nc, bin0 + v["byteOffset"])
        return arr.reshape(-1, nc) if nc > 1 else arr
    out = {}
    for nd in js.get("nodes", []):
        m = js["meshes"][nd["mesh"]]
        for p in m["primitives"]:
            if p.get("mode", 4) != 4 or "indices" not in p:
                continue                      # линии/точки других модулей
            mat = js["materials"][p["material"]]["name"] if "material" in p else None
            out.setdefault(nd["name"], {})[mat] = (acc(p["attributes"]["POSITION"]).astype(np.float64),
                                                   acc(p["indices"]).astype(np.int64).reshape(-1, 3))
    return out


def load_area(W, man, x0, x1, y0, y1):
    res = []
    for t in man["tiles"]:
        if t["maxX"] < x0 or t["minX"] > x1 or t["maxZ"] < -y1 or t["minZ"] > -y0:
            continue
        res.append(read_glb(W / t["file"]))
    return res


def render(W, man, name, title, cx, cy, half, ortho=None):
    x0, x1, y0, y1 = cx - half, cx + half, cy - half, cy + half
    data = load_area(W, man, x0, x1, y0, y1)
    fig, ax = plt.subplots(figsize=(12, 12))
    if ortho is not None:
        img, ext = ortho
        ax.imshow(img, extent=ext, interpolation="bilinear")
    layers = [("roads", "road_asphalt"), ("roads", "road_junction"), ("sidewalks", "sidewalk"),
              ("buildings", None), ("markings", "road_marking")]
    for node, mat in layers:
        polys, cols = [], []
        for d in data:
            for nm, prims in d.items():
                if nm != node:
                    continue
                for mn, (P, I) in prims.items():
                    if mat is not None and mn != mat:
                        continue
                    if node == "buildings":
                        up = I[np.abs(np.cross(P[I[:, 1]] - P[I[:, 0]], P[I[:, 2]] - P[I[:, 0]])[:, 1]) > 1e-3]
                        tri = P[up][:, :, [0, 2]]
                        c = "#d6c3a5"
                    else:
                        tri = P[I][:, :, [0, 2]]
                        c = COLORS[mn]
                    tri = tri.copy(); tri[:, :, 1] *= -1     # z -> север
                    m = (tri[:, :, 0].max(1) > x0) & (tri[:, :, 0].min(1) < x1) & (tri[:, :, 1].max(1) > y0) & (tri[:, :, 1].min(1) < y1)
                    polys.extend(tri[m]); cols.extend([c] * int(m.sum()))
        if not polys:
            continue
        alpha = 0.55 if (ortho is not None and node != "markings") else 1.0
        if ortho is not None and node == "markings":
            cols = ["#ff2bd6"] * len(cols)
        ax.add_collection(PolyCollection(polys, facecolors=cols, edgecolors="none", alpha=alpha,
                                         zorder={"roads": 1, "sidewalks": 2, "buildings": 3, "markings": 4}[node]))
    # бордюры: линии верхних кромок граней
    segs = []
    for d in data:
        if "sidewalks" in d and "curb" in d["sidewalks"]:
            P, I = d["sidewalks"]["curb"]
            Q6 = I.reshape(-1, 6)                       # квад = 2 треугольника; верхние вершины — нечётные
            a = np.where(Q6 % 2 == 1, Q6, 1 << 40).min(1); b = np.where(Q6 % 2 == 1, Q6, -1).max(1)
            segs.extend(np.stack([P[a][:, [0, 2]], P[b][:, [0, 2]]], 1) * [1, -1])
    if segs:
        from matplotlib.collections import LineCollection
        ax.add_collection(LineCollection(segs, colors="#55524c" if ortho is None else "#00e5ff", linewidths=0.6, zorder=2.5))
    ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect("equal")
    ax.set_facecolor("#7d8f62")
    ax.set_title(f"{title}: разметка (белая), тротуары (светлые), бордюры (линии); север сверху, 1 клетка = 10 м")
    ax.set_xticks(np.arange(np.floor(x0 / 10) * 10, x1, 10), minor=True); ax.set_yticks(np.arange(np.floor(y0 / 10) * 10, y1, 10), minor=True)
    ax.grid(which="minor", alpha=0.12); ax.tick_params(labelsize=7)
    fig.tight_layout()
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f"{name}{'_ortho' if ortho is not None else ''}.png"
    fig.savefig(out, dpi=100); plt.close(fig)
    return out


def ortho_crop(cx, cy, half):
    import rasterio
    from rasterio.warp import transform_bounds
    from rasterio.windows import from_bounds
    from config import WORLD_CRS
    with rasterio.open(ORTHO) as src:
        b = transform_bounds(WORLD_CRS, src.crs, cx - half, cy - half, cx + half, cy + half)
        win = from_bounds(*b, src.transform)
        img = src.read(window=win, boundless=True)
        # переводим в мировую СК по углам (для локального окна достаточно аффинного приближения)
        if str(src.crs) != str(WORLD_CRS):
            from rasterio.warp import reproject, Resampling
            from rasterio.transform import from_origin
            res = 0.5
            n = int(2 * half / res)
            dst = np.zeros((img.shape[0], n, n), img.dtype)
            reproject(img, dst, src_transform=src.window_transform(win), src_crs=src.crs,
                      dst_transform=from_origin(cx - half, cy + half, res, res), dst_crs=WORLD_CRS, resampling=Resampling.bilinear)
            img = dst
    img = np.moveaxis(img[:3], 0, -1)
    if img.dtype != np.uint8:
        img = np.clip(img / max(img.max(), 1) * 255, 0, 255).astype(np.uint8)
    return img, (cx - half, cx + half, cy - half, cy + half)


def check_heights(W, man):
    """Вершины разметки и тротуаров против heightmap/дорог в выборке тайлов."""
    t = man["terrain"]
    hm = np.fromfile(W / t["file"], dtype="<f4").reshape(t["rows"], t["cols"]).astype(np.float64)
    max_y = -t["minZ"]
    grid = Grid(t["minX"], t["minX"] + (t["cols"] - 1) * t["cellSize"], max_y - (t["rows"] - 1) * t["cellSize"], max_y, t["cellSize"])
    stats = {"mark_vs_road": [], "sw_top_vs_terrain": []}
    rng = np.random.default_rng(0)
    tiles = [x for x in man["tiles"]]
    rng.shuffle(tiles)
    n = 0
    for tl in tiles:
        d = read_glb(W / tl["file"])
        if "markings" not in d or "roads" not in d:
            continue
        P, I = d["markings"]["road_marking"]
        rm = [d["roads"][k] for k in d["roads"]]
        RP = np.concatenate([p for p, _ in rm]); off = np.cumsum([0] + [len(p) for p, _ in rm])[:-1]
        RI = np.concatenate([i + o for (_, i), o in zip(rm, off)])
        sel = rng.choice(len(P), min(2000, len(P)), replace=False)
        best = surface_below(RP, RI, P[sel])
        best = {i: v for i, v in enumerate(best) if np.isfinite(v)}
        stats["mark_vs_road"].extend(best.values())
        # точки внутри треугольников разметки
        ti = rng.choice(len(I), min(2000, len(I)), replace=False)
        w = rng.dirichlet([1, 1, 1], len(ti))
        Q = (P[I[ti]] * w[:, :, None]).sum(1)
        dq = surface_below(RP, RI, Q)
        stats.setdefault("mark_interior_vs_road", []).extend(dq[np.isfinite(dq)].tolist())
        if "sidewalks" in d:
            S, _ = d["sidewalks"]["sidewalk"]
            dv = S[:, 1] - grid.sample(hm, S[:, 0], -S[:, 2])
            stats["sw_top_vs_terrain"].extend(dv.tolist())
        n += 1
        if n >= 25:
            break
    out = {}
    for k, v in stats.items():
        v = np.array(v)
        if len(v):
            out[k] = {"n": int(len(v)), "min": round(float(v.min()), 3), "p1": round(float(np.percentile(v, 1)), 3),
                      "p50": round(float(np.median(v)), 3), "max": round(float(v.max()), 3),
                      "share_below_0.005": round(float((v < 0.005).mean() * 100), 3)}
    return out


def surface_below(RP, RI, Q):
    """Для точек Q: min(Q.y - высота поверхности) по поверхностям в пределах ±1 м (треугольники RP/RI), inf если нет."""
    A, Bv, C = RP[RI[:, 0]], RP[RI[:, 1]], RP[RI[:, 2]]
    out = np.full(len(Q), np.inf)
    for i0 in range(0, len(Q), 200):
        q = Q[i0:i0 + 200]
        px, pz = q[:, 0][:, None], q[:, 2][:, None]
        d = (Bv[:, 2] - C[:, 2]) * (A[:, 0] - C[:, 0]) + (C[:, 0] - Bv[:, 0]) * (A[:, 2] - C[:, 2])
        d[np.abs(d) < 1e-12] = np.nan
        l1 = ((Bv[:, 2] - C[:, 2]) * (px - C[:, 0]) + (C[:, 0] - Bv[:, 0]) * (pz - C[:, 2])) / d
        l2 = ((C[:, 2] - A[:, 2]) * (px - C[:, 0]) + (A[:, 0] - C[:, 0]) * (pz - C[:, 2])) / d
        l3 = 1 - l1 - l2
        inside = (l1 >= -1e-9) & (l2 >= -1e-9) & (l3 >= -1e-9)
        y = l1 * A[:, 1] + l2 * Bv[:, 1] + l3 * C[:, 1]
        dy = np.where(inside, q[:, 1][:, None] - y, np.inf)
        dy[np.abs(dy) > 1.0] = np.inf          # другие ярусы (мост над дорогой)
        out[i0:i0 + 200] = dy.min(axis=1)      # худший случай среди перекрывающихся поверхностей
    return out


def _grid(W, man):
    t = man["terrain"]
    hm = np.fromfile(W / t["file"], dtype="<f4").reshape(t["rows"], t["cols"]).astype(np.float64)
    max_y = -t["minZ"]
    return hm, Grid(t["minX"], t["minX"] + (t["cols"] - 1) * t["cellSize"], max_y - (t["rows"] - 1) * t["cellSize"], max_y, t["cellSize"])


def check_sidewalk_smear(W, man, top=8):
    """Детектор «размазанных» тротуаров по всем тайлам (heightmap и дороги — из того же мира):
    - dev: отклонение середины ребра / центра треугольника верха от рельефа относительно среднего отступа его вершин
      (треугольник «перекидывается» через рельеф);
    - long: треугольники с ребром > 6 м и |dev| > 0.1 м;
    - overlap: вершина тротуара прямо над/под треугольником дороги в плане (не должно быть: проезжие части вычитаются);
    - road: верх тротуара минус поверхность ближайшей дороги в 0.4 м вокруг вершины: < -0.02 — ниже соседней дороги
      (обычно другая дорога выше на насыпи — ступенька по рельефу), > 0.4 — выше неё;
    - off: отступ вершины верха от рельефа вне [0.0, 0.3] м там, где рядом нет дороги."""
    hm, grid = _grid(W, man)
    H = lambda x, z: grid.sample(hm, x, -z)
    worst_dev, worst_road, worst_off, worst_overlap = [], [], [], []
    n_tri = n_long = n_dev = n_road_lo = n_road_hi = n_off = n_overlap = 0
    for tl in man["tiles"]:
        d = read_glb(W / tl["file"])
        if "sidewalks" not in d or "sidewalk" not in d["sidewalks"]:
            continue
        P, I = d["sidewalks"]["sidewalk"]
        if not np.isfinite(P).all():
            worst_off.append((np.inf, tl["file"], 0, 0)); n_off += 1
            P = np.nan_to_num(P)
        off = P[:, 1] - H(P[:, 0], P[:, 2])
        n_tri += len(I)
        # рёбра и центры
        E = np.r_[I[:, [0, 1]], I[:, [1, 2]], I[:, [2, 0]]]
        M = (P[E[:, 0]] + P[E[:, 1]]) / 2
        dev_e = (M[:, 1] - H(M[:, 0], M[:, 2])) - (off[E[:, 0]] + off[E[:, 1]]) / 2
        Cn = P[I].mean(1)
        dev_c = (Cn[:, 1] - H(Cn[:, 0], Cn[:, 2])) - off[I].mean(1)
        elen = np.hypot(P[E[:, 0], 0] - P[E[:, 1], 0], P[E[:, 0], 2] - P[E[:, 1], 2])
        tri_len = elen.reshape(3, -1).max(0)
        tri_dev = np.maximum(np.abs(dev_e).reshape(3, -1).max(0), np.abs(dev_c))
        n_dev += int((tri_dev > 0.1).sum())
        n_long += int(((tri_len > 6) & (tri_dev > 0.1)).sum())
        k = int(np.argmax(tri_dev))
        worst_dev.append((float(tri_dev[k]), tl["file"], round(float(Cn[k, 0]), 1), round(float(Cn[k, 2]), 1), round(float(tri_len[k]), 1)))
        # против дороги
        if "roads" in d:
            rm = list(d["roads"].values())
            RP = np.concatenate([p for p, _ in rm]); offs = np.cumsum([0] + [len(p) for p, _ in rm])[:-1]
            RI = np.concatenate([i + o for (_, i), o in zip(rm, offs)])
            best = np.full(len(P), np.inf)
            for dx, dz in ((0.4, 0), (-0.4, 0), (0, 0.4), (0, -0.4)):
                Q = P + [dx, 0, dz]
                Q[:, 1] = P[:, 1]
                dy = surface_below_any(RP, RI, Q)
                best = np.where(np.abs(dy) < np.abs(best), dy, best)
            d0 = surface_below_any(RP, RI, P, eps=0.02)   # строго внутри треугольника дороги (кромка не в счёт)
            ov = np.isfinite(d0) & ((d0 < 0.0) | (d0 > 0.3))
            n_overlap += int(ov.sum())
            if ov.any():
                k = int(np.argmax(np.where(ov, np.abs(d0), -1)))
                worst_overlap.append((round(float(d0[k]), 3), tl["file"], round(float(P[k, 0]), 1), round(float(P[k, 2]), 1)))
            near = np.isfinite(best)
            lo = near & (best < -0.02); hi = near & (best > 0.4)
            n_road_lo += int(lo.sum()); n_road_hi += int(hi.sum())
            if near.any():
                k = int(np.argmax(np.where(near, np.abs(best), -1)))
                worst_road.append((round(float(best[k]), 3), tl["file"], round(float(P[k, 0]), 1), round(float(P[k, 2]), 1)))
            far = ~near
        else:
            far = np.ones(len(P), bool)
        bad = far & ((off < 0.0) | (off > 0.3))
        n_off += int(bad.sum())
        if bad.any():
            k = int(np.argmax(np.where(bad, np.abs(off - 0.15), -1)))
            worst_off.append((round(float(off[k]), 3), tl["file"], round(float(P[k, 0]), 1), round(float(P[k, 2]), 1)))
    worst_overlap.sort(key=lambda r: -abs(r[0]))
    worst_dev.sort(key=lambda r: -r[0]); worst_road.sort(key=lambda r: -abs(r[0])); worst_off.sort(key=lambda r: -abs(r[0] - 0.15))
    return {"triangles": n_tri, "tri_dev_gt_0.1": n_dev, "long_gt_6m_and_dev_gt_0.1": n_long,
            "verts_overlapping_road_in_plan": n_overlap, "worst_overlap (top-road, tile, x, z)": worst_overlap[:top],
            "verts_below_adjacent_road_0.4m": n_road_lo, "verts_float_over_road_gt_0.4": n_road_hi, "verts_off_terrain_far_from_road": n_off,
            "worst_dev (dev, tile, x, z, max_edge)": [(round(a, 3), *b) for a, *b in worst_dev[:top]],
            "worst_vs_road (top-road, tile, x, z)": worst_road[:top], "worst_off_terrain": worst_off[:top]}


def surface_below_any(RP, RI, Q, eps=-1e-9):
    """Q.y - высота ближайшей по |dy| поверхности (в пределах 1.5 м), inf если точка не над треугольником."""
    A, Bv, C = RP[RI[:, 0]], RP[RI[:, 1]], RP[RI[:, 2]]
    xmin = np.minimum(np.minimum(A[:, 0], Bv[:, 0]), C[:, 0]); xmax = np.maximum(np.maximum(A[:, 0], Bv[:, 0]), C[:, 0])
    zmin = np.minimum(np.minimum(A[:, 2], Bv[:, 2]), C[:, 2]); zmax = np.maximum(np.maximum(A[:, 2], Bv[:, 2]), C[:, 2])
    out = np.full(len(Q), np.inf)
    order = np.argsort(Q[:, 0])
    for i0 in range(0, len(Q), 256):
        ids = order[i0:i0 + 256]
        q = Q[ids]
        sel = (xmax >= q[:, 0].min()) & (xmin <= q[:, 0].max()) & (zmax >= q[:, 2].min()) & (zmin <= q[:, 2].max())
        if not sel.any():
            continue
        a, b, c = A[sel], Bv[sel], C[sel]
        px, pz = q[:, 0][:, None], q[:, 2][:, None]
        dd = (b[:, 2] - c[:, 2]) * (a[:, 0] - c[:, 0]) + (c[:, 0] - b[:, 0]) * (a[:, 2] - c[:, 2])
        dd[np.abs(dd) < 1e-12] = np.nan
        l1 = ((b[:, 2] - c[:, 2]) * (px - c[:, 0]) + (c[:, 0] - b[:, 0]) * (pz - c[:, 2])) / dd
        l2 = ((c[:, 2] - a[:, 2]) * (px - c[:, 0]) + (a[:, 0] - c[:, 0]) * (pz - c[:, 2])) / dd
        l3 = 1 - l1 - l2
        inside = (l1 >= eps) & (l2 >= eps) & (l3 >= eps)
        y = l1 * a[:, 1] + l2 * b[:, 1] + l3 * c[:, 1]
        dy = np.where(inside, q[:, 1][:, None] - y, np.inf)
        dy[np.abs(dy) > 1.5] = np.inf
        k = np.argmin(np.abs(dy), axis=1)
        out[ids] = dy[np.arange(len(q)), k]
    return out


def render_spot(W, man, name, x, z, half=14.0, zscale=4.0):
    """Перспектива (3D) места: рельеф, дороги, тротуары, бордюры; высоты x zscale."""
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    hm, grid = _grid(W, man)
    data = load_area(W, man, x - half, x + half, -z - half, -z + half)
    fig = plt.figure(figsize=(12, 7))
    ax = fig.add_subplot(111, projection="3d")
    xs = np.arange(x - half, x + half + 0.01, 1.0); zs = np.arange(z - half, z + half + 0.01, 1.0)
    X, Z = np.meshgrid(xs, zs)
    Y = grid.sample(hm, X.ravel(), -Z.ravel()).reshape(X.shape)
    y0 = float(Y.min())
    ax.plot_wireframe(X, Z, (Y - y0) * zscale, color="#6b8a4a", linewidth=0.3, alpha=0.6)
    for node, mat, col in (("roads", None, "#333333"), ("sidewalks", "sidewalk", "#c9c6bd"), ("sidewalks", "curb", "#8a2be2"),
                           ("markings", None, "#ffffff")):
        tris = []
        for d in data:
            for mn, (P, I) in d.get(node, {}).items():
                if mat is not None and mn != mat:
                    continue
                T = P[I]
                c = T.mean(1)
                m = (np.abs(c[:, 0] - x) < half) & (np.abs(c[:, 2] - z) < half)
                T = T[m].copy()
                T[:, :, 1] = (T[:, :, 1] - y0) * zscale
                tris.extend(T[:, :, [0, 2, 1]])
        if tris:
            ax.add_collection3d(Poly3DCollection(tris, facecolors=col, edgecolors="k" if node == "sidewalks" and mat == "sidewalk" else "none",
                                                 linewidths=0.15, alpha=0.95))
    ax.set_xlim(x - half, x + half); ax.set_ylim(z - half, z + half); ax.set_zlim(0, max(float((Y.max() - y0) * zscale) + 2, 3))
    ax.view_init(elev=28, azim=-60)
    ax.set_title(f"{name}: x={x:.1f}, z={z:.1f} (высоты x{zscale:g}; серый — дорога, светлый — тротуар, фиолетовый — бордюр)")
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f"{name}.png"
    fig.tight_layout(); fig.savefig(out, dpi=100); plt.close(fig)
    return out


def counts(W, man):
    tot = {"markings_tris": 0, "sidewalk_tris": 0, "curb_tris": 0, "tiles_with_markings": 0, "tiles_with_sidewalks": 0}
    for tl in man["tiles"]:
        d = read_glb(W / tl["file"])
        if "markings" in d:
            tot["tiles_with_markings"] += 1; tot["markings_tris"] += len(d["markings"]["road_marking"][1])
        if "sidewalks" in d:
            tot["tiles_with_sidewalks"] += 1
            tot["sidewalk_tris"] += len(d["sidewalks"].get("sidewalk", (0, []))[1])
            tot["curb_tris"] += len(d["sidewalks"].get("curb", (0, []))[1])
    return tot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", default=str(ROOT / "game" / "public" / "world"))
    ap.add_argument("--zebra", nargs=2, type=float, help="x y (север) центра вида с зеброй")
    ap.add_argument("--smear", action="store_true", help="только детектор «размазанных» тротуаров + 3D-виды худших мест")
    ap.add_argument("--tag", default="", help="суффикс имён 3D-видов (before/after)")
    ap.add_argument("--spots", nargs="*", type=float, default=[], help="x z [x z ...] — дополнительные места для 3D-видов")
    a = ap.parse_args()
    W = Path(a.world)
    man = json.loads((W / "manifest.json").read_text())
    if a.smear:
        rep = check_sidewalk_smear(W, man)
        for k, v in rep.items():
            print(f"{k}: {v}")
        spots = [(r[2], r[3]) for r in rep["worst_dev (dev, tile, x, z, max_edge)"][:2]] + \
                [(r[2], r[3]) for r in rep["worst_vs_road (top-road, tile, x, z)"][:1]] + list(zip(a.spots[0::2], a.spots[1::2]))
        for i, (x, z) in enumerate(spots):
            print("png:", render_spot(W, man, f"smear_{i}{'_' + a.tag if a.tag else ''}", x, z))
        return
    views = list(VIEWS)
    if a.zebra:
        views.append(("zebra", "Пешеходный переход", a.zebra[0], a.zebra[1], 40))
    for v in views:
        print("png:", render(W, man, *v))
        if ORTHO.exists():
            print("png:", render(W, man, *v, ortho=ortho_crop(*v[2:])))
    print("счётчики:", counts(W, man))
    print("высоты:", check_heights(W, man))


if __name__ == "__main__":
    main()
