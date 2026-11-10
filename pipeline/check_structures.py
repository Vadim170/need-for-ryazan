"""Боковые профили мостов/путепроводов с опорами, устоями и ограждениями (по готовым тайлам мира).
Запуск: cd pipeline && uv run python check_structures.py [--world ../data/processed/world_test] [--osm 176061622 ...]
Выход: data/processed/terrain_v2_check/bridges_side.png (+ сводка roads/structures.json в консоль).
"""
import argparse
import json
from collections import defaultdict
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import trimesh
from matplotlib.collections import PolyCollection

from config import DATA_PROCESSED, ROOT

OUT = DATA_PROCESSED / "terrain_v2_check"
DEFAULT = [176061622, 37616056, 240691029, 236434024, 37915704, 111972812]
COLORS = {"bridge_concrete": "#8c8c8c", "bridge_railing": "#2b6cb0", "retaining_wall": "#a0522d",
          "road_asphalt": "#303030", "road_junction": "#303030"}


def load_tile(W, f):
    sc = trimesh.load(W / f, force="scene")
    out = defaultdict(list)
    for node in sc.graph.nodes_geometry:
        T, gname = sc.graph[node]
        g = sc.geometry[gname]
        mat = getattr(getattr(g.visual, "material", None), "name", None)
        out[(node.split("_")[0] if node.startswith("bridges") else node, mat)].append(g.copy().apply_transform(T))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", default=str(ROOT / "game" / "public" / "world"))
    ap.add_argument("--osm", type=int, nargs="*", default=DEFAULT)
    a = ap.parse_args()
    W = Path(a.world)
    man = json.loads((W / "manifest.json").read_text())
    t = man["terrain"]
    hm = np.fromfile(W / "terrain" / "heightmap.f32", "<f4").reshape(t["rows"], t["cols"])
    G = json.loads((W / "roads" / "graph.json").read_text())
    stj = json.loads((W / "roads" / "structures.json").read_text()) if (W / "roads" / "structures.json").exists() else None

    def h_at(x, z):
        c = np.clip((np.asarray(x) - t["minX"]) / t["cellSize"], 0, t["cols"] - 1.001)
        r = np.clip((np.asarray(z) - t["minZ"]) / t["cellSize"], 0, t["rows"] - 1.001)
        c0 = np.floor(c).astype(int); r0 = np.floor(r).astype(int); fc = c - c0; fr = r - r0
        return (hm[r0, c0] * (1 - fc) * (1 - fr) + hm[r0, c0 + 1] * fc * (1 - fr) + hm[r0 + 1, c0] * (1 - fc) * fr
                + hm[r0 + 1, c0 + 1] * fc * fr)

    fig, axs = plt.subplots(len(a.osm), 1, figsize=(15, 3.6 * len(a.osm)))
    for ax, oid in zip(np.atleast_1d(axs), a.osm):
        E = [e for e in G["edges"] if e["osmId"] == oid and e["bridge"]] or [e for e in G["edges"] if e["osmId"] == oid]
        if not E:
            ax.set_title(f"{oid}: нет в графе"); continue
        e = max(E, key=lambda e: len(e["points"]))
        P = np.array(e["points"])
        d = P[-1, [0, 2]] - P[0, [0, 2]]
        L0 = float(np.hypot(*d)); u = d / L0; nrm = np.array([-u[1], u[0]])
        o = P[0, [0, 2]] - u * 60
        # тайлы вокруг
        xs, zs = P[:, 0], P[:, 2]
        ixs = range(int(np.floor((xs.min() - 80) / 250)), int(np.floor((xs.max() + 80) / 250)) + 1)
        izs = range(int(np.floor((zs.min() - 80) / 250)), int(np.floor((zs.max() + 80) / 250)) + 1)
        polys = defaultdict(list)
        for ix in ixs:
            for iz in izs:
                f = W / f"tiles/{ix}_{iz}.glb"
                if not f.exists():
                    continue
                for (node, mat), gs in load_tile(W, f"tiles/{ix}_{iz}.glb").items():
                    if node not in ("bridges", "roads") or mat is None:
                        continue
                    for g in gs:
                        V = g.vertices
                        sl = (V[:, [0, 2]] - o) @ u
                        lat = (V[:, [0, 2]] - o) @ nrm
                        F = g.faces
                        keep = (np.abs(lat[F]).max(1) < 25) & (sl[F].min(1) > -5) & (sl[F].max(1) < L0 + 125)
                        if node == "roads":
                            keep &= np.abs(lat[F]).max(1) < 6
                        for f3 in F[keep]:
                            polys[mat].append(np.c_[sl[f3], V[f3, 1]])
        for mat in ("road_asphalt", "road_junction", "retaining_wall", "bridge_concrete", "bridge_railing"):
            if polys.get(mat):
                ax.add_collection(PolyCollection(polys[mat], facecolors=COLORS.get(mat, "#999"), edgecolors="none",
                                                 alpha=0.9 if mat != "bridge_railing" else 0.6, label=mat))
        ss = np.linspace(0, L0 + 120, 400)
        q = o[None] + ss[:, None] * u[None]
        ax.plot(ss, h_at(q[:, 0], q[:, 1]), color="#3a7d2c", lw=1.2, label="рельеф по оси")
        sP = (P[:, [0, 2]] - o) @ u
        ax.plot(sP, P[:, 1], "r--", lw=0.8, label="поверхность (граф)")
        ax.set_xlim(0, L0 + 120)
        ylo = min(P[:, 1].min(), h_at(q[:, 0], q[:, 1]).min()) - 2; yhi = P[:, 1].max() + 4
        ax.set_ylim(ylo, yhi)
        cls = ""
        if stj:
            rec = next((r for r in stj["edges"] if r["id"] == e["id"]), None)
            if rec:
                cls = " | " + ", ".join(f"{c} {b - a:.0f} м" for a, b, c in rec["spans"])
        ax.set_title(f"osm {oid} {e['name'] or e['highway']} — {L0:.0f} м{cls}", fontsize=9)
        ax.set_aspect(2.0); ax.grid(alpha=0.25)
        ax.set_ylabel("y игры, м (верт. ×2)")
    np.atleast_1d(axs)[0].legend(fontsize=7, loc="upper right", ncol=3)
    fig.tight_layout()
    OUT.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT / "bridges_side.png", dpi=80)
    if stj:
        print(json.dumps(stj["stats"], ensure_ascii=False))


if __name__ == "__main__":
    main()
