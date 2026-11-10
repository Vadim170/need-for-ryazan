"""Проверка «улицы» (витрины, подъезды, клумбы, ограждения, фонари) по готовому миру.
Запуск: cd pipeline && uv run python verify_streetlife.py [--world ../game/public/world] [--props <каталог props>]
Печатает счётчики, проверяет поля и высоты, рисует data/processed/streetlife_check/*.png
(слева — схема: здания, дороги, тротуары + объекты улицы; справа — спутник с теми же объектами).
"""
import argparse
import json
import math
from collections import Counter
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.collections import LineCollection, PolyCollection
from matplotlib.patches import Circle, Polygon as MPoly

from config import DATA_PROCESSED, ROOT, to_world
from verify_yards import AREA_COL, BLD_COL, World

OUT = DATA_PROCESSED / "streetlife_check"
SEG_COL = {"ped_fence": "#e53935", "guardrail": "#1e88e5", "jersey_barrier": "#ff9800", "lawn_fence": "#00c853",
           "fence": "#000000", "wall": "#7b1f1f"}
ENT_COL = {"podezd": "#2962ff", "shop": "#ff6d00", "office": "#757575"}
NEW_TYPES = ("flowerbed", "bollard", "barrier_gate", "park_lamp", "street_lamp_double")


def place_xy(name, graph):
    fixed = {"teatralnaya": (54.6218, 39.7571), "pobedy": (54.6293, 39.7116)}
    if name in fixed:
        lat, lon = fixed[name]
        return to_world.transform(lon, lat)
    if name == "sobornaya":
        pts = np.concatenate([np.array(e["points"]) for e in graph["edges"] if e["name"] == "Соборная площадь"])
        return float(pts[:, 0].mean()), float(-pts[:, 2].mean())
    pts = np.concatenate([np.array(e["points"]) for e in graph["edges"] if e["name"] == "Первомайский проспект"])
    mid = pts[np.argsort(pts[:, 0])[len(pts) // 2]]
    if name == "pervomaysky":
        return float(mid[0]), float(-mid[2])
    return -2375.0, -3375.0     # yard: квартал многоэтажек (больше всего выведенных подъездов на тайл)


PLACES = [("pervomaysky", 300), ("sobornaya", 350), ("teatralnaya", 300), ("pobedy", 300), ("yard", 260)]


def meshes(w, key):
    """Как World.meshes, но пропускает геометрию без граней (точки/линии других нод)."""
    import re
    import trimesh
    e = w.tiles.get(key)
    if not e:
        return []
    sc = trimesh.load(w.d / e["file"], force="scene")
    out = []
    for node in sc.graph.nodes_geometry:
        T, gname = sc.graph[node]
        g = sc.geometry[gname]
        if not hasattr(g, "faces"):
            continue
        mat = getattr(getattr(g.visual, "material", None), "name", None)
        out.append((re.sub(r"_[0-9a-f]{6}$", "", node), mat, np.asarray(g.vertices), np.asarray(g.faces)))
    return out


def load_props(props_dir, keys):
    out = []
    for k in keys:
        p = props_dir / f"{k[0]}_{k[1]}.json"
        if p.exists():
            out.append(json.loads(p.read_text()))
    return out


def stats(props_dir, w):
    inst, segs, sf, ent = Counter(), Counter(), [], []
    seg_m = Counter()
    bad_y = 0; n_y = 0
    for p in sorted(props_dir.glob("*.json")):
        js = json.loads(p.read_text())
        for r in js["instances"]:
            inst[r["type"]] += 1
            if r["type"] in NEW_TYPES:
                h = float(w.h(r["x"], r["z"]))
                n_y += 1
                if not (-0.02 <= r["y"] - h <= 0.06) and r["type"] != "street_lamp_double":
                    bad_y += 1
        for s in js["segments"]:
            segs[s["type"]] += 1
            seg_m[s["type"]] += math.hypot(s["x2"] - s["x1"], s["z2"] - s["z1"])
        sf += js.get("storefronts", [])
        ent += js.get("entrances", [])
    print("инстансы:", dict(inst))
    print("сегменты:", {k: f"{segs[k]} шт / {seg_m[k] / 1000:.1f} км" for k in segs})
    print(f"новые инстансы: y вне рельеф..+0.06 м: {bad_y} из {n_y}")
    print(f"витрины: {len(sf)} (OSM {sum(not s['generated'] for s in sf)}, процедурных {sum(s['generated'] for s in sf)}); "
          f"по kind: {dict(Counter(s['kind'] for s in sf))}")
    print("  сети:", Counter(s.get("brand") for s in sf if s.get("brand") and not s["generated"]).most_common(20))
    print("  процедурные:", Counter(s["label"] for s in sf if s["generated"]).most_common(30))
    print(f"входы: {len(ent)}: {dict(Counter((e['type'], e['generated']) for e in ent))}, "
          f"ступеней сред {np.mean([e['steps'] for e in ent]):.1f}, макс {max(e['steps'] for e in ent)}")
    req = {"x1", "y1", "z1", "x2", "y2", "z2", "nx", "nz", "width", "height", "kind", "category", "label", "name",
           "signText", "signColor", "generated"}
    miss = sum(1 for s in sf if not req <= set(s))
    print(f"витрины без обязательных полей: {miss}")
    return sf, ent


def draw_new(ax, js_list, sat=False, labels=False):
    segs = {}
    for js in js_list:
        for s in js["segments"]:
            if s["type"] in SEG_COL and (not sat or s["type"] not in ("fence", "wall")):
                segs.setdefault(s["type"], []).append([(s["x1"], s["z1"]), (s["x2"], s["z2"])])
    for t, L in segs.items():
        ax.add_collection(LineCollection(L, colors=SEG_COL[t], linewidths={"lawn_fence": 1.0, "ped_fence": 1.6,
                                                                           "guardrail": 1.8, "jersey_barrier": 2.2}.get(t, 0.6), zorder=6))
    for js in js_list:
        for s in js.get("storefronts", []):
            n = np.array([s["nx"], s["nz"]])
            a = np.array([s["x1"], s["z1"]]) + n * 0.6; b = np.array([s["x2"], s["z2"]]) + n * 0.6
            ax.plot([a[0], b[0]], [a[1], b[1]], color=s["signColor"], lw=3.2, solid_capstyle="butt", zorder=7,
                    alpha=0.6 if s["generated"] else 1.0)
            m = (a + b) / 2 + n * 2.0
            if labels and not s["generated"] and labels[0] < m[0] < labels[1] and labels[2] < m[1] < labels[3]:
                ax.text(m[0], m[1], s["signText"][:18], fontsize=4.2, color="#000" if not sat else "#fff", zorder=9,
                        ha="center", va="center", clip_on=True)
        for e in js.get("entrances", []):
            f = np.array([e["nx"], e["nz"]])
            p = np.array([e["x"], e["z"]])
            ax.add_patch(MPoly([p + f * 2.0, p + np.array([-f[1], f[0]]) * 0.9, p - np.array([-f[1], f[0]]) * 0.9],
                               closed=True, fc=ENT_COL[e["type"]], ec="#fff" if sat else "#000", lw=0.3, zorder=8))
        for r in js["instances"]:
            t = r["type"]
            x, z = r["x"], r["z"]
            if t == "flowerbed":
                if r["shape"] == "round":
                    ax.add_patch(Circle((x, z), r["radius"], fc="#ff4fa3", ec="#7a0040", lw=0.4, zorder=6))
                else:
                    a = r["rotY"]
                    fx, fz = -math.sin(a), -math.cos(a)       # «вперёд» (−Z модели) -> ширина вдоль вперёд
                    rx, rz = -fz, fx                           # локальная X -> длина
                    hl, hw = r["length"] / 2, r["width"] / 2
                    q = [(x + rx * hl * sx + fx * hw * sy, z + rz * hl * sx + fz * hw * sy) for sx, sy in ((1, 1), (1, -1), (-1, -1), (-1, 1))]
                    ax.add_patch(MPoly(q, closed=True, fc="#ff4fa3", ec="#7a0040", lw=0.4, zorder=6))
            elif t == "bollard":
                ax.scatter([x], [z], s=3, c="#212121" if not sat else "#ffffff", zorder=7)
            elif t == "barrier_gate":
                d = r["armDir"]
                ax.plot([x, x + d[0] * r["armLength"]], [z, z + d[1] * r["armLength"]], color="#d50000", lw=1.8, zorder=7)
                ax.scatter([x], [z], s=10, c="#fff", edgecolors="#d50000", zorder=8)
            elif t == "park_lamp":
                ax.scatter([x], [z], s=12, c="#ffd600", marker="o", edgecolors="#5d4037", linewidths=0.4, zorder=7)
            elif t == "street_lamp_double":
                ax.scatter([x], [z], s=40, c="#ffd600", marker="P", edgecolors="#000", linewidths=0.4, zorder=7)
            elif t == "street_lamp":
                ax.scatter([x], [z], s=14 * r.get("scale", 1), c="#fff59d", marker="*", edgecolors="#555", linewidths=0.3, zorder=6)
            elif t in ("bench", "trash_bin") and not sat:
                ax.scatter([x], [z], s=5 if t == "bench" else 2, c="#6d4c41" if t == "bench" else "#000", marker="s", zorder=6)
            elif t.startswith("tree_") and not sat:
                ax.scatter([x], [z], s=4, c="#2e7d32", alpha=0.35, zorder=3, linewidths=0)


def render(w, props_dir, name, cx, cy, size, ortho):
    x0, x1 = cx - size / 2, cx + size / 2
    z0, z1 = -cy - size / 2, -cy + size / 2
    keys = {(ix, iz) for ix in range(int(math.floor(x0 / 250)), int(math.floor(x1 / 250)) + 1)
            for iz in range(int(math.floor(z0 / 250)), int(math.floor(z1 / 250)) + 1)}
    js = load_props(props_dir, keys)
    fig, axes = plt.subplots(1, 2, figsize=(22, 11), dpi=120)
    ax = axes[0]
    ax.set_facecolor("#e6eadf")
    for k in keys:
        for node, mat, V, F in meshes(w, k):
            if node not in ("areas", "roads", "sidewalks", "buildings"):
                continue
            if node == "buildings":
                up = np.abs(np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])[:, 1]) > 1e-3
                F = F[up]
            col = AREA_COL.get(mat, "#888") if node == "areas" else {"roads": "#3a3a3a", "sidewalks": "#a8a8a8",
                                                                     "buildings": BLD_COL}[node]
            if node == "areas" and mat == "area_grass":
                col = "#b9d8a6"
            ax.add_collection(PolyCollection(V[F][:, :, [0, 2]], facecolors=col, edgecolors=col, linewidths=0.1,
                                             zorder={"areas": 1, "sidewalks": 2, "roads": 2, "buildings": 4}[node]))
    draw_new(ax, js, sat=False, labels=(x0 + 5, x1 - 5, z0 + 5, z1 - 5))
    ax.set_xlim(x0, x1); ax.set_ylim(z1, z0); ax.set_aspect("equal")
    ax.set_title(f"{name}: витрины (цвет вывески), входы (▲ синий — подъезд, оранжевый — магазин, серый — офис), "
                 f"клумбы (розовые), ограждения", fontsize=9)
    hd = [plt.Line2D([], [], color=c, lw=2, label=t) for t, c in SEG_COL.items()]
    hd += [plt.Line2D([], [], color="#ffd600", marker="o", ls="", label="park_lamp"),
           plt.Line2D([], [], color="#ffd600", marker="P", ls="", ms=9, label="street_lamp_double"),
           plt.Line2D([], [], color="#fff59d", marker="*", ls="", ms=8, label="street_lamp"),
           plt.Line2D([], [], color="#ff4fa3", marker="s", ls="", label="flowerbed"),
           plt.Line2D([], [], color="#212121", marker=".", ls="", label="bollard"),
           plt.Line2D([], [], color="#d50000", lw=2, label="barrier_gate")]
    ax.legend(handles=hd, loc="upper left", fontsize=7, framealpha=0.85)
    import rasterio
    from rasterio.windows import from_bounds
    with rasterio.open(ortho) as ds:
        img = ds.read(window=from_bounds(x0, cy - size / 2, x1, cy + size / 2, ds.transform),
                      out_shape=(3, 1400, 1400), boundless=True, fill_value=0).transpose(1, 2, 0)
    ax2 = axes[1]
    ax2.imshow(img, extent=(x0, x1, z1, z0))
    draw_new(ax2, js, sat=True)
    ax2.set_xlim(x0, x1); ax2.set_ylim(z1, z0); ax2.set_aspect("equal")
    ax2.set_title("спутник + объекты улицы", fontsize=9)
    fig.tight_layout()
    OUT.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT / f"{name}.png"); plt.close(fig)
    print("  ->", OUT / f"{name}.png")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", default=str(ROOT / "game" / "public" / "world"))
    ap.add_argument("--props", help="каталог props (по умолчанию <world>/props)")
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    w = World(a.world)
    props_dir = Path(a.props) if a.props else Path(a.world) / "props"
    stats(props_dir, w)
    graph = json.loads((w.d / w.man["roads"]["file"]).read_text())
    core = DATA_PROCESSED / "ortho" / "yandex_core_0.25m.tif"
    for name, size in PLACES:
        if a.only and name not in a.only:
            continue
        cx, cy = place_xy(name, graph)
        ortho = core if (-1467 < cx < 1518 and -2571 < cy < 835) else DATA_PROCESSED / "ortho" / "yandex_0.5m.tif"
        render(w, props_dir, name, cx, cy, size, ortho)


if __name__ == "__main__":
    main()
