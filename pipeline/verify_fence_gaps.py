"""Проверка проходов в оградах по готовому миру: картинки сверху поверх спутника.
Запуск: cd pipeline && uv run python verify_fence_gaps.py [--world ../game/public/world]
Берёт ограды из props/*.json, рёбра пешеходов из people/walk.json, вырезы — из data/processed/fence_gaps_check/gaps.json
(пишет world/fence_gaps.py при сборке). Картинки: data/processed/fence_gaps_check/*.png (3 двора, школа, парк).
"""
import argparse
import json
from collections import Counter
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import rasterio
from matplotlib.collections import LineCollection
from rasterio.windows import from_bounds

from config import DATA_PROCESSED, DATA_RAW, ROOT

OUT = DATA_PROCESSED / "fence_gaps_check"
SEG_COL = {"fence": "#ffeb3b", "wall": "#ff7043", "lawn_fence": "#e040fb", "ped_fence": "#40c4ff", "guardrail": "#ffffff",
           "jersey_barrier": "#ff1744"}
GAP_COL = {"osm_path": "#00e676", "driveway": "#2979ff", "crossing": "#ffffff", "walk": "#76ff03", "entrance": "#ff9100",
           "playground": "#f50057", "bus_stop": "#00b0ff", "gate": "#ffd600", "desire": "#d500f9"}


def load(world):
    man = json.loads((world / "manifest.json").read_text())
    segs, gates = [], []
    for t in man["tiles"]:
        if "props" not in t:
            continue
        js = json.loads((world / t["props"]).read_text())
        segs += js["segments"]
        gates += [i for i in js["instances"] if i["type"] == "fence_gate"]
    walk = None
    p = world / "people" / "walk.json"
    if p.exists():
        w = json.loads(p.read_text())
        nn = np.asarray(w["nodes"]).reshape(-1, 3)
        E = np.asarray(w["edges"]).reshape(-1, 4)
        walk = (np.c_[nn[:, 0], -nn[:, 2]], E)
    gaps = json.loads((OUT / "gaps.json").read_text()) if (OUT / "gaps.json").exists() else []
    return segs, gates, walk, gaps


def places(segs, gaps):
    """3 двора (больше всего вырезов «подъезд/площадка/тропа/дорожка»), школа и парк с оградами."""
    from world.osm import OsmData
    osm = OsmData(DATA_RAW / "osm" / "ryazan.osm")
    F = np.array([((s["x1"] + s["x2"]) / 2, -(s["z1"] + s["z2"]) / 2) for s in segs if s["type"] in ("fence", "lawn_fence", "wall")])
    G = np.array([(g[0], g[1]) for g in gaps if g[2] in ("entrance", "playground", "desire", "walk", "osm_path", "gate")])
    out = []
    cell = 200.0
    if len(G):
        c = Counter((int(x // cell), int(y // cell)) for x, y in G)
        for (i, j), _ in c.most_common(20):
            p = ((i + 0.5) * cell, (j + 0.5) * cell)
            if all(np.hypot(p[0] - q[0], p[1] - q[1]) > 600 for _, q in out):
                out.append((f"yard_{len(out) + 1}", p))
            if len(out) == 3:
                break

    def best(pred, name):
        bestv = None
        for wid, (refs, tg) in osm.ways.items():
            if pred(tg) and refs[0] == refs[-1]:
                p = osm.way_polygon(wid)
                if p is None:
                    continue
                c = np.array(p.centroid.coords[0])
                if not len(F):
                    continue
                n = int((np.hypot(*(F - c).T) < 120).sum())
                if bestv is None or n > bestv[0]:
                    bestv = (n, (float(c[0]), float(c[1])))
        if bestv:
            out.append((name, bestv[1]))
    best(lambda t: t.get("amenity") == "school", "school")
    best(lambda t: t.get("leisure") in ("park", "garden"), "park")
    return out


def render(name, c, size, segs, gates, walk, gaps, ortho):
    x0, x1, y0, y1 = c[0] - size / 2, c[0] + size / 2, c[1] - size / 2, c[1] + size / 2
    fig, ax = plt.subplots(figsize=(12, 12), dpi=110)
    with rasterio.open(ortho) as ds:
        img = ds.read(window=from_bounds(x0, y0, x1, y1, ds.transform), out_shape=(3, 1400, 1400), boundless=True,
                      fill_value=0).transpose(1, 2, 0)
    ax.imshow(img, extent=(x0, x1, y0, y1))
    if walk is not None:
        XY, E = walk
        m = ((XY[E[:, 0], 0] > x0) & (XY[E[:, 0], 0] < x1) & (XY[E[:, 0], 1] > y0) & (XY[E[:, 0], 1] < y1))
        ax.add_collection(LineCollection(np.stack([XY[E[m, 0]], XY[E[m, 1]]], axis=1), colors="#00e5ff", linewidths=0.5, alpha=0.6))
    by = {}
    for s in segs:
        if s["type"] not in SEG_COL:
            continue
        a = (s["x1"], -s["z1"]); b = (s["x2"], -s["z2"])
        if max(a[0], b[0]) < x0 or min(a[0], b[0]) > x1 or max(a[1], b[1]) < y0 or min(a[1], b[1]) > y1:
            continue
        by.setdefault(s["type"], []).append([a, b])
    for t, L in by.items():
        ax.add_collection(LineCollection(L, colors=SEG_COL[t], linewidths=2.0, label=t))
    G = [g for g in gaps if x0 < g[0] < x1 and y0 < g[1] < y1]
    for r, col in GAP_COL.items():
        P = np.array([(g[0], g[1]) for g in G if g[2] == r])
        if len(P):
            ax.scatter(P[:, 0], P[:, 1], s=60, facecolors="none", edgecolors=col, linewidths=1.8, label=f"проход: {r} ({len(P)})", zorder=6)
    Gt = np.array([(g["x"], -g["z"], g["rotY"], g["width"]) for g in gates if x0 < g["x"] < x1 and y0 < -g["z"] < y1])
    if len(Gt):
        for x, y, r, w in Gt:
            ax.plot([x, x - np.sin(r) * w], [y, y + np.cos(r) * w], color="#ffd600", lw=3.5, solid_capstyle="butt", zorder=7)
        ax.plot([], [], color="#ffd600", lw=3.5, label=f"fence_gate ({len(Gt)})")
    ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect("equal")
    ax.legend(loc="upper left", fontsize=8, framealpha=0.85)
    ax.set_title(f"{name}: ограды по типам, проходы по причинам, рёбра пешеходов (голубые); x восток, y север")
    fig.tight_layout()
    fig.savefig(OUT / f"{name}.png"); plt.close(fig)
    print("  ->", OUT / f"{name}.png")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", default=str(ROOT / "game" / "public" / "world"))
    a = ap.parse_args()
    world = Path(a.world)
    segs, gates, walk, gaps = load(world)
    OUT.mkdir(parents=True, exist_ok=True)
    print("сегменты:", dict(Counter(s["type"] for s in segs)))
    print("проходы:", dict(Counter(g[2] for g in gaps)), "калиток fence_gate:", len(gates))
    # проверка: рёбра пешеходов не пересекают ограды
    if walk is not None:
        import shapely
        XY, E = walk
        fl = [shapely.LineString([(s["x1"], -s["z1"]), (s["x2"], -s["z2"])]) for s in segs
              if s["type"] in ("fence", "wall", "lawn_fence", "ped_fence", "guardrail")]
        tree = shapely.STRtree(fl)
        ei, _ = tree.query(shapely.linestrings(np.stack([XY[E[:, 0]], XY[E[:, 1]]], axis=1)), predicate="intersects")
        print(f"рёбер пешеходов, пересекающих ограды: {len(set(ei.tolist()))} из {len(E)}")
    ortho = DATA_PROCESSED / "ortho" / "yandex_0.5m.tif"
    for name, c in places(segs, gaps):
        render(name, c, 220, segs, gates, walk, gaps, ortho)


if __name__ == "__main__":
    main()
