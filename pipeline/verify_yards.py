"""Проверка дворов/площадок/пропсов по готовому миру (только выходные файлы).
Запуск: cd pipeline && uv run python verify_yards.py [--world ../game/public/world]
Печатает счётчики и проверки, рисует data/processed/yards_check/*.png (вид сверху: площадки, дороги, здания, пропсы).
"""
import argparse
import json
import math
import re
from collections import Counter
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import trimesh
from matplotlib.collections import LineCollection, PolyCollection

from config import DATA_PROCESSED, ROOT, to_world

TYPES = {"tree_birch", "tree_poplar", "tree_maple", "tree_lime", "tree_pine", "shrub", "street_lamp", "traffic_light",
         "bus_stop", "bench", "trash_bin", "playground_set", "container_site", "parked_car",
         # уличная жизнь (streetlife.py) и проходы в заборах (fence_gaps.py)
         "bollard", "barrier_gate", "flowerbed", "park_lamp", "street_lamp_double", "fence_gate"}
SEG_TYPES = {"fence", "wall", "lawn_fence", "ped_fence", "guardrail", "jersey_barrier"}
AREA_COL = {"area_parking": "#5a5a5e", "area_paving": "#b9b2a6", "area_path": "#d8cdb6", "area_playground": "#e0874a",
            "area_grass": "#7fb069", "area_dirt": "#a68a5b"}
PROP_STYLE = {  # цвет, размер, маркер
    "tree_birch": ("#f4f1c6", 9, "o"), "tree_poplar": ("#2e7d32", 9, "o"), "tree_maple": ("#e65100", 9, "o"),
    "tree_lime": ("#9ccc65", 9, "o"), "tree_pine": ("#004d40", 9, "^"), "shrub": ("#558b2f", 3, "o"),
    "street_lamp": ("#ffeb3b", 14, "*"), "traffic_light": ("#d50000", 30, "s"), "bus_stop": ("#2962ff", 40, "D"),
    "bench": ("#6d4c41", 10, "s"), "trash_bin": ("#000000", 5, "s"), "playground_set": ("#ff4081", 25, "P"),
    "container_site": ("#00bcd4", 30, "X"), "parked_car": ("#ab47bc", 6, "s"),
}
BLD_COL = "#c9b9a6"
# (имя, центр (lat, lon) или мировые (x, y), размер окна м)
PLACES = [
    ("kremlin", (-150.0, -150.0), 600),
    ("tspkio_park", (-1206.0, -2891.0), 700),
    ("lesopark_edge", (1000.0, 500.0), 700),
    ("yard_pervomaysky", None, 450),
]


class World:
    def __init__(self, d):
        self.d = Path(d)
        self.man = json.loads((self.d / "manifest.json").read_text())
        t = self.man["terrain"]
        self.hm = np.fromfile(self.d / t["file"], "<f4").reshape(t["rows"], t["cols"]).astype(np.float64)
        self.t = t
        self.tiles = {(e["ix"], e["iz"]): e for e in self.man["tiles"]}

    def h(self, x, z):
        t = self.t
        c = (np.asarray(x) - t["minX"]) / t["cellSize"]; r = (np.asarray(z) - t["minZ"]) / t["cellSize"]
        r = np.clip(r, 0, t["rows"] - 1 - 1e-9); c = np.clip(c, 0, t["cols"] - 1 - 1e-9)
        r0 = np.floor(r).astype(int); c0 = np.floor(c).astype(int); fr = r - r0; fc = c - c0
        h = self.hm
        h00, h11, h10, h01 = h[r0, c0], h[r0 + 1, c0 + 1], h[r0 + 1, c0], h[r0, c0 + 1]
        za = h00 + fr * (h10 - h00) + fc * (h11 - h10)
        zb = h00 + fc * (h01 - h00) + fr * (h11 - h01)
        return np.where(fr >= fc, za, zb)

    def props(self, key):
        e = self.tiles.get(key)
        if not e or "props" not in e:
            return None
        return json.loads((self.d / e["props"]).read_text())

    def meshes(self, key):
        """[(node, material, V, F)] из tile .glb."""
        e = self.tiles.get(key)
        if not e:
            return []
        sc = trimesh.load(self.d / e["file"], force="scene")
        out = []
        for node in sc.graph.nodes_geometry:
            T, gname = sc.graph[node]
            g = sc.geometry[gname]
            if not hasattr(g, "faces"):  # узлы без граней (PointCloud) пропускаем
                continue
            mat = getattr(getattr(g.visual, "material", None), "name", None)
            out.append((re.sub(r"_[0-9a-f]{6}$", "", node), mat, np.asarray(g.vertices), np.asarray(g.faces)))
        return out


def stats(w):
    cnt, segc = Counter(), Counter()
    bad_type, bad_tile, dy, dy_seg, nfiles, nbytes = 0, 0, [], [], 0, 0
    for key, e in w.tiles.items():
        if "props" not in e:
            continue
        nfiles += 1; nbytes += (w.d / e["props"]).stat().st_size
        js = w.props(key)
        for p in js["instances"]:
            cnt[p["type"]] += 1
            bad_type += p["type"] not in TYPES
            if not (e["minX"] - 0.01 <= p["x"] <= e["maxX"] + 0.01 and e["minZ"] - 0.01 <= p["z"] <= e["maxZ"] + 0.01):
                bad_tile += 1
            if p["type"] not in ("street_lamp",):
                dy.append(p["y"] - float(w.h(p["x"], p["z"])))
        for s in js["segments"]:
            segc[s["type"]] += 1
            bad_type += s["type"] not in SEG_TYPES
            if s["type"] != "guardrail":  # отбойники стоят на мостах — выше рельефа законно
                dy_seg.append(s["y1"] - float(w.h(s["x1"], s["z1"])))
    dy = np.array(dy)
    print(f"props: файлов {nfiles}, {nbytes / 1e6:.1f} МБ")
    print("  инстансы:", dict(sorted(cnt.items())), "всего", sum(cnt.values()))
    print("  деревья всего:", sum(v for k, v in cnt.items() if k.startswith("tree_")))
    print("  сегменты:", dict(segc))
    print(f"  неизвестных типов {bad_type}, вне своего тайла {bad_tile}")
    print(f"  y − heightmap: min {dy.min():+.3f}, max {dy.max():+.3f}, доля |Δ| ∈ {{0, 0.03}}±0.011: "
          f"{np.mean((np.abs(dy) < 0.011) | (np.abs(dy - 0.03) < 0.011)) * 100:.2f}%; сегменты max |Δ| {np.abs(dy_seg).max():.3f}")
    return cnt


def area_check(w, n_tiles=40):
    rng = np.random.default_rng(0)
    keys = sorted(w.tiles)
    tri = Counter(); err = []
    sel = [keys[i] for i in rng.choice(len(keys), size=min(n_tiles, len(keys)), replace=False)]
    for k in keys:
        pass
    for k in sel:
        for node, mat, V, F in w.meshes(k):
            if node != "areas":
                continue
            tri[mat] += len(F)
            # проверка: вершины и центры треугольников на +0.03 над рельефом
            err.append(V[:, 1] - w.h(V[:, 0], V[:, 2]) - 0.03)
            C = V[F].mean(axis=1)
            err.append(C[:, 1] - w.h(C[:, 0], C[:, 2]) - 0.03)
    if err:
        e = np.concatenate(err)
        print(f"areas ({len(sel)} случайных тайлов): треугольников {dict(tri)}; |y − (рельеф+0.03)| макс {np.abs(e).max():.4f} м")


def render(w, name, cx, cy, size, ortho=None):
    x0, x1 = cx - size / 2, cx + size / 2
    z0, z1 = -cy - size / 2, -cy + size / 2
    keys = {(ix, iz) for ix in range(int(math.floor(x0 / 250)), int(math.floor(x1 / 250)) + 1)
            for iz in range(int(math.floor(z0 / 250)), int(math.floor(z1 / 250)) + 1)}
    ncol = 2 if ortho is not None else 1
    fig, axes = plt.subplots(1, ncol, figsize=(11 * ncol, 11), dpi=110, squeeze=False)
    axes = axes[0]
    ax = axes[0]
    ax.set_facecolor("#c8d5b9")
    polys = {"areas": [], "roads": [], "sidewalks": [], "buildings": [], "water": []}
    for k in keys:
        for node, mat, V, F in w.meshes(k):
            if node in ("areas", "roads", "sidewalks", "buildings", "water"):
                if node == "buildings":
                    up = np.abs(np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])[:, 1]) > 1e-3
                    F = F[up]
                tris = V[F][:, :, [0, 2]]
                col = AREA_COL.get(mat, "#888") if node == "areas" else {"roads": "#3a3a3a", "sidewalks": "#9e9e9e",
                                                                         "buildings": BLD_COL, "water": "#5b8db8"}[node]
                polys[node].append((tris, col))
    for node in ("water", "areas", "sidewalks", "roads", "buildings"):
        for tris, col in polys[node]:
            ax.add_collection(PolyCollection(tris, facecolors=col, edgecolors=col, linewidths=0.1))
    _props(ax, w, keys)
    ax.set_xlim(x0, x1); ax.set_ylim(z1, z0); ax.set_aspect("equal")
    ax.set_title(f"{name}: площадки, дороги, здания, пропсы (x, z игры; север вверху)")
    handles = [plt.Line2D([], [], color=c, marker=m, ls="", ms=7, label=t) for t, (c, s, m) in PROP_STYLE.items()]
    handles += [plt.Line2D([], [], color=c, lw=6, label=t) for t, c in AREA_COL.items()]
    handles += [plt.Line2D([], [], color="#000", lw=1.5, label="fence"), plt.Line2D([], [], color="#7b1f1f", lw=2.5, label="wall")]
    ax.legend(handles=handles, loc="upper left", fontsize=7, ncol=2, framealpha=0.85)
    if ortho is not None:
        import rasterio
        from rasterio.windows import from_bounds
        with rasterio.open(ortho) as ds:
            img = ds.read(window=from_bounds(x0, cy - size / 2, x1, cy + size / 2, ds.transform),
                          out_shape=(3, 1200, 1200), boundless=True, fill_value=0).transpose(1, 2, 0)
        ax2 = axes[1]
        ax2.imshow(img, extent=(x0, x1, z1, z0))
        _props(ax2, w, keys, only=("tree_", "parked_car", "playground_set", "container_site"))
        ax2.set_xlim(x0, x1); ax2.set_ylim(z1, z0); ax2.set_aspect("equal")
        ax2.set_title("спутник + деревья/машины/площадки")
    out = DATA_PROCESSED / "yards_check" / f"{name}.png"
    fig.tight_layout()
    fig.savefig(out); plt.close(fig)
    print("  ->", out)


def _props(ax, w, keys, only=None):
    pts = {}
    segs = {"fence": [], "wall": []}
    for k in keys:
        js = w.props(k)
        if not js:
            continue
        for p in js["instances"]:
            if only and not p["type"].startswith(only):
                continue
            pts.setdefault(p["type"], []).append((p["x"], p["z"], p["rotY"]))
        if not only:
            for s in js["segments"]:
                segs.setdefault(s["type"], []).append([(s["x1"], s["z1"]), (s["x2"], s["z2"])])
    if segs["fence"]:
        ax.add_collection(LineCollection(segs["fence"], colors="#000", linewidths=0.8))
    if segs["wall"]:
        ax.add_collection(LineCollection(segs["wall"], colors="#7b1f1f", linewidths=1.6))
    for t, arr in pts.items():
        a = np.array(arr)
        c, s, m = PROP_STYLE.get(t, ("#f0f", 6, "o"))
        if t == "parked_car":
            # прямоугольник 1.8×4.5 по rotY: вперёд = (−sin, −cos) в (x, z)
            fx, fz = -np.sin(a[:, 2]), -np.cos(a[:, 2])
            rx, rz = -fz, fx
            q = []
            for (x, z), f0, f1, r0, r1 in zip(a[:, :2], fx, fz, rx, rz):
                q.append([(x + f0 * 2.25 * sx + r0 * 0.9 * sy, z + f1 * 2.25 * sx + r1 * 0.9 * sy)
                          for sx, sy in ((1, 1), (1, -1), (-1, -1), (-1, 1))])
            ax.add_collection(PolyCollection(q, facecolors=c, edgecolors="#222", linewidths=0.2))
            ax.add_collection(LineCollection([[(x, z), (x + f0 * 2.6, z + f1 * 2.6)] for (x, z), f0, f1 in zip(a[:, :2], fx, fz)],
                                             colors="#fff", linewidths=0.3))
        elif t in ("street_lamp", "traffic_light", "bus_stop", "bench", "container_site"):
            ax.scatter(a[:, 0], a[:, 1], s=s, c=c, marker=m, edgecolors="#222", linewidths=0.3, zorder=5)
            fx, fz = -np.sin(a[:, 2]), -np.cos(a[:, 2])
            L = 3.0 if t != "bench" else 1.5
            ax.add_collection(LineCollection([[(x, z), (x + u * L, z + v * L)] for (x, z), u, v in zip(a[:, :2], fx, fz)],
                                             colors=c, linewidths=0.8, zorder=5))
        else:
            ax.scatter(a[:, 0], a[:, 1], s=s, c=c, marker=m, edgecolors="#222", linewidths=0.2, zorder=4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", default=str(ROOT / "game" / "public" / "world"))
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    w = World(a.world)
    stats(w)
    area_check(w)
    (DATA_PROCESSED / "yards_check").mkdir(parents=True, exist_ok=True)
    ortho = DATA_PROCESSED / "ortho" / "yandex_0.5m.tif"
    ortho = ortho if ortho.exists() else None
    graph = json.loads((w.d / w.man["roads"]["file"]).read_text())
    for name, c, size in PLACES:
        if a.only and name not in a.only:
            continue
        if c is None:   # двор у Первомайского: середина проспекта, 220 м к северу
            pts = np.concatenate([np.array(e["points"]) for e in graph["edges"] if e["name"] == "Первомайский проспект"])
            mid = pts[np.argsort(pts[:, 0])[len(pts) // 2]]
            c = (mid[0], -mid[2] + 200.0)
        render(w, name, c[0], c[1], size, ortho)


if __name__ == "__main__":
    main()
