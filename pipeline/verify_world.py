"""Проверка результата build_world.py: чтение glb через trimesh, сверка высот с heightmap,
превью сверху (data/processed/world_preview.png) и профиль Первомайского (data/processed/profile_pervomaysky.png).
Запуск: cd pipeline && uv run python verify_world.py
"""
import json
import sys
import math
import random

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import trimesh
from matplotlib.collections import LineCollection, PolyCollection

from config import DATA_PROCESSED, ROOT, to_world
from world.grid import Grid

W = ROOT / "game" / "public" / "world"
WORK = DATA_PROCESSED / "sumo"
PREVIEW_DIR = DATA_PROCESSED


def load():
    man = json.loads((W / "manifest.json").read_text())
    t = man["terrain"]
    hm = np.fromfile(W / t["file"], dtype="<f4").reshape(t["rows"], t["cols"]).astype(np.float64)
    # Grid в мировых (x, y=north): строка 0 = min three.z = max y
    max_y = -t["minZ"]
    grid = Grid(t["minX"], t["minX"] + (t["cols"] - 1) * t["cellSize"], max_y - (t["rows"] - 1) * t["cellSize"], max_y,
                t["cellSize"])
    return man, hm, grid


def h_at(grid, hm, x, z):
    return grid.sample(hm, np.asarray(x), -np.asarray(z))


def scene_nodes(path):
    sc = trimesh.load(path, force="scene", process=False)
    out = {}
    for node in sc.graph.nodes_geometry:
        tf, gname = sc.graph[node]
        g = sc.geometry[gname].copy()
        g.apply_transform(tf)
        # trimesh дробит меш с несколькими примитивами на ноды name_xxxxxx
        base = node.rsplit("_", 1)[0] if node.rsplit("_", 1)[-1].isalnum() and len(node.rsplit("_", 1)[-1]) == 6 else node
        out.setdefault(base, []).append(g)
    return sc, out


def check_tiles(man, hm, grid, n=12):
    random.seed(1)
    tiles = man["tiles"]
    # тайлы с мостами и центр — обязательно
    pick = [t for t in tiles if (t["ix"], t["iz"]) in {(0, 0), (-1, 0), (-5, 1), (8, -1)}]
    pick += random.sample(tiles, n)
    report = []
    worst_pen = 0.0
    for t in pick:
        sc, nodes = scene_nodes(W / t["file"])
        names = sorted(nodes)
        r = {"tile": t["file"], "nodes": names}
        if "terrain" in nodes:  # с v1.1 ноды нет: рельеф игра строит из heightmap
            terr = trimesh.util.concatenate(nodes["terrain"])
            v = terr.vertices
            r["terrain_max_abs_err"] = float(np.abs(v[:, 1] - h_at(grid, hm, v[:, 0], v[:, 2])).max())
        if "roads" in nodes:
            rd = trimesh.util.concatenate(nodes["roads"])
            dv = rd.vertices[:, 1] - h_at(grid, hm, rd.vertices[:, 0], rd.vertices[:, 2])
            ground = np.abs(dv - 0.05) < 0.02
            r["road_vertices_on_ground_pct"] = round(float(ground.mean() * 100), 1)
            # точки внутри треугольников дорог (кроме мостов): насколько рельеф вылезает над дорогой
            pts, fi = trimesh.sample.sample_surface(rd, 20000, seed=0)
            fv = rd.vertices[rd.faces[fi]]
            fground = (np.abs(fv[:, :, 1] - h_at(grid, hm, fv[:, :, 0].ravel(), fv[:, :, 2].ravel()).reshape(-1, 3) - 0.05) < 0.02).all(1)
            d = pts[:, 1] - h_at(grid, hm, pts[:, 0], pts[:, 2])
            d = d[fground]
            if len(d):
                r["road_over_terrain_min"] = round(float(d.min()), 3)
                r["road_over_terrain_p1"] = round(float(np.percentile(d, 1)), 3)
                r["road_below_terrain_pct"] = round(float((d < 0).mean() * 100), 3)
                worst_pen = min(worst_pen, float(d.min()))
        if "buildings" in nodes:
            r["buildings_tris"] = int(sum(len(g.faces) for g in nodes["buildings"]))
        report.append(r)
    return report, worst_pen


def check_extras():
    """trimesh не всегда поднимает extras нод — читаем JSON-чанк GLB напрямую."""
    import struct
    man = json.loads((W / "manifest.json").read_text())
    found = {}
    for t in man["tiles"]:
        b = (W / t["file"]).read_bytes()
        ln = struct.unpack("<I", b[12:16])[0]
        js = json.loads(b[20:20 + ln])
        for nd in js["nodes"]:
            if "extras" in nd:
                found[nd["name"]] = nd["extras"]
        if len(found) >= 2:
            break
    return found


def preview(man, hm, grid, view=None, name="world_preview.png"):
    fig, ax = plt.subplots(figsize=(16, 16.5))
    t = man["terrain"]
    ext = (t["minX"], t["minX"] + (t["cols"] - 1) * t["cellSize"], t["minZ"] + (t["rows"] - 1) * t["cellSize"], t["minZ"])
    dzdz, dzdx = np.gradient(hm * 3, t["cellSize"])
    hs = np.clip(0.6 + (-dzdx - dzdz) * 0.25, 0, 1)
    ax.imshow(hm, cmap="terrain", extent=ext, vmin=-15, vmax=70, alpha=1.0)
    ax.imshow(hs, cmap="gray", extent=ext, alpha=0.35, vmin=0, vmax=1)
    polys, cols, wpolys, rpolys = [], [], [], []
    colmap = {"building_apartments": "#c9a27e", "building_house": "#d9824b", "building_commercial": "#5a7fa8",
              "building_garage": "#888888", "building_other": "#b5b0a5"}
    for tl in man["tiles"]:
        if view and (tl["maxX"] < view[0] or tl["minX"] > view[1] or tl["maxZ"] < view[3] or tl["minZ"] > view[2]):
            continue
        sc = trimesh.load(W / tl["file"], force="scene", process=False)
        for node in sc.graph.nodes_geometry:
            tf, gname = sc.graph[node]
            g = sc.geometry[gname]
            mat = getattr(getattr(g.visual, "material", None), "name", None)
            if node.startswith("buildings") and mat in colmap:
                up = g.face_normals[:, 1] > 0.9
                tri = g.vertices[g.faces[up]][:, :, [0, 2]]
                polys.extend(tri); cols.extend([colmap[mat]] * len(tri))
            elif node.startswith("water"):
                wpolys.extend(g.vertices[g.faces][:, :, [0, 2]])
            elif node.startswith("roads"):
                rpolys.extend(g.vertices[g.faces][:, :, [0, 2]])
    ax.add_collection(PolyCollection(wpolys, facecolors="#3f6f9a", edgecolors="none"))
    ax.add_collection(PolyCollection(rpolys, facecolors="#2b2b2b", edgecolors="none"))
    ax.add_collection(PolyCollection(polys, facecolors=cols, edgecolors="none"))
    sp = man["spawnPoints"]
    ax.scatter([s["x"] for s in sp], [s["z"] for s in sp], c="red", s=25, zorder=5)
    for s in sp:
        ax.plot([s["x"], s["x"] + 60 * math.sin(s["heading"])], [s["z"], s["z"] - 60 * math.cos(s["heading"])], "r-", lw=1)
    v = view or ext
    ax.set_xlim(v[0], v[1]); ax.set_ylim(v[2], v[3])  # z вниз = юг вниз: север сверху
    ax.set_aspect("equal"); ax.set_title("Need for Ryazan — world preview (север сверху; x→восток)")
    fig.tight_layout()
    out = PREVIEW_DIR / name
    fig.savefig(out, dpi=110); plt.close(fig)
    return out, len(polys), len(rpolys)


def pervomaysky_profile(man, hm, grid):
    g = json.loads((W / "roads" / "graph.json").read_text())
    nodes = {n["id"]: n for n in g["nodes"]}
    E = [e for e in g["edges"] if e["name"] == "Первомайский проспект" and e["highway"] in ("primary", "secondary", "tertiary")]
    # направленный граф: идём от узла, ближайшего к пл. Победы, на восток
    out = {}
    for e in E:
        out.setdefault(e["from"], []).append((e, False))
        if not e["oneway"]:
            out.setdefault(e["to"], []).append((e, True))
    start = min(out, key=lambda n: nodes[n]["x"])  # западный конец
    pts, cur, used = [], start, set()
    while True:
        opts = [(e, rv) for e, rv in out.get(cur, []) if e["id"] not in used]
        if not opts:
            break
        def east(o):
            e, rv = o
            p = e["points"][::-1] if rv else e["points"]
            return p[-1][0] - p[0][0]
        e, rv = max(opts, key=east)
        used.add(e["id"])
        p = e["points"][::-1] if rv else e["points"]
        pts.extend(p if not pts else p[1:])
        cur = e["from"] if rv else e["to"]
    P = np.array(pts)
    s = np.r_[0, np.cumsum(np.hypot(np.diff(P[:, 0]), np.diff(P[:, 2])))]
    stages = np.load(WORK / "h_stages.npy")
    base = man["baseHeight"]
    raw = grid.sample_bilinear(stages[0], P[:, 0], -P[:, 2]) - base
    # уклон на базе ~10 м
    ss = np.arange(0, s[-1], 2.0)
    yi = np.interp(ss, s, P[:, 1])
    k = 5
    gr = (yi[k:] - yi[:-k]) / (ss[k:] - ss[:-k]) * 100
    fig, ax = plt.subplots(2, 1, figsize=(12, 7), sharex=True)
    ax[0].plot(s, raw + base, label="рельеф FABDEM (сглаженный 17.5 м) по оси", lw=1, color="gray")
    ax[0].plot(s, P[:, 1] + base, label="поверхность дороги (graph.json)", lw=2)
    ax[0].set_ylabel("высота, м"); ax[0].legend(); ax[0].grid(alpha=.3)
    ax[0].set_title(f"Первомайский проспект: западный конец → восток (пл. Победы ≈ 450 м), {s[-1]:.0f} м, рёбер {len(used)}")
    ax[1].plot(ss[k:], gr); ax[1].set_ylabel("уклон на 10 м, %"); ax[1].set_xlabel("м"); ax[1].grid(alpha=.3)
    fig.tight_layout()
    out = PREVIEW_DIR / "profile_pervomaysky.png"
    fig.savefig(out, dpi=90); plt.close(fig)
    d2 = np.diff(yi, 2) / 4.0
    return out, {"length_m": round(float(s[-1]), 1), "edges": len(used), "y_min": round(float(P[:, 1].min() + base), 2),
                 "y_max": round(float(P[:, 1].max() + base), 2), "max_grade_pct_10m": round(float(np.abs(gr).max()), 2),
                 "p95_grade_pct_10m": round(float(np.percentile(np.abs(gr), 95)), 2),
                 "max_curvature_dz2_per_m2": round(float(np.abs(d2).max()), 4)}


def graph_grades(man, hm, grid):
    g = json.loads((W / "roads" / "graph.json").read_text())
    res = {}
    for e in g["edges"]:
        P = np.array(e["points"])
        if len(P) < 2:
            continue
        L = np.hypot(np.diff(P[:, 0]), np.diff(P[:, 2]))
        ok = L > 5
        if not ok.any():
            continue
        gr = np.abs(np.diff(P[:, 1]))[ok] / L[ok]
        res.setdefault(e["highway"].replace("_link", ""), []).append(gr)
    return {k: {"p50": round(float(np.percentile(np.concatenate(v), 50) * 100), 2),
                "p99": round(float(np.percentile(np.concatenate(v), 99) * 100), 2),
                "max": round(float(np.concatenate(v).max() * 100), 2)} for k, v in res.items()}


def underpass_report(W):
    """Дороги под мостами: габарит (поверхность настила - поверхность дороги снизу) и уклон дороги снизу у пересечения."""
    from shapely.geometry import LineString
    from shapely.strtree import STRtree
    g = json.loads((W / "roads" / "graph.json").read_text())
    ground = [e for e in g["edges"] if not e["bridge"] and len(e["points"]) > 1]
    lines = [LineString(np.array(e["points"])[:, [0, 2]]) for e in ground]
    tree = STRtree(lines)
    out = []
    def y_at(line, P, pt):
        s = np.r_[0, np.cumsum(np.hypot(*np.diff(P[:, [0, 2]], axis=0).T))]
        d = line.project(pt)
        return float(np.interp(d, s, P[:, 1])), s, d
    for b in g["edges"]:
        if not b["bridge"]:
            continue
        PB = np.array(b["points"]); bl = LineString(PB[:, [0, 2]])
        for i in tree.query(bl, predicate="intersects"):
            e = ground[i]
            if {e["from"], e["to"]} & {b["from"], b["to"]}:
                continue
            x = bl.intersection(lines[i])
            for pt in getattr(x, "geoms", [x]):
                if pt.geom_type != "Point":
                    continue
                yb, _, _ = y_at(bl, PB, pt)
                PG = np.array(e["points"])
                yg, sg, dg = y_at(lines[i], PG, pt)
                m = np.abs(sg - dg) < 40
                gr = np.abs(np.diff(PG[:, 1])) / np.maximum(np.diff(sg), 1e-6)
                mm = m[:-1] | m[1:]
                out.append({"bridge": b["osmId"], "under": e["osmId"], "under_name": e["name"], "under_hw": e["highway"],
                            "clearance": round(yb - yg, 2),
                            "under_max_grade_pct_40m": round(float(gr[mm].max() * 100) if mm.any() else 0, 1)})
    return out


def bridge_report(man, hm, grid, W):
    """Мосты по графу: ступенька на концах (настил - поверхность примыкания), рельеф, вылезающий на настил."""
    g = json.loads((W / "roads" / "graph.json").read_text())
    nodes = {n["id"]: n for n in g["nodes"]}
    adj = {}
    for e in g["edges"]:
        for n in (e["from"], e["to"]):
            adj.setdefault(n, []).append(e)
    rows = []
    for e in g["edges"]:
        if not e["bridge"]:
            continue
        P = np.array(e["points"])
        L = float(np.hypot(*np.diff(P[:, [0, 2]], axis=0).T).sum())
        steps = []
        for k, nid in ((0, e["from"]), (-1, e["to"])):
            nd = nodes[nid]
            # площадка «висячего» узла (середина моста) стоит на высоте узла, остальные — на рельефе
            floating = abs(nd["y"] - (float(h_at(grid, hm, nd["x"], nd["z"])) + 0.05)) > 0.02
            ref = nd["y"] if floating else float(h_at(grid, hm, P[k, 0], P[k, 2])) + 0.05
            steps.append(round(float(P[k, 1] - ref), 3))
        # рельеф по бокам настила (полуширина + 1 м) выше настила
        d = np.diff(P[:, [0, 2]], axis=0); d = np.vstack([d, d[-1:]])
        n = np.c_[-d[:, 1], d[:, 0]] / np.maximum(np.hypot(*d.T), 1e-9)[:, None]
        hw = e["width"] / 2 + 1.0
        intr = -1e9
        for sgn in (-1, 1):
            q = P[:, [0, 2]] + sgn * hw * n
            intr = max(intr, float((h_at(grid, hm, q[:, 0], q[:, 1]) - (P[:, 1] - 0.05)).max()))
        clr = float((P[:, 1] - h_at(grid, hm, P[:, 0], P[:, 2])).max())
        rows.append({"id": e["id"], "osmId": e["osmId"], "name": e["name"], "len": round(L), "step_from": steps[0],
                     "step_to": steps[1], "side_terrain_above_deck": round(intr, 2), "max_deck_over_terrain": round(clr, 2)})
    return rows


def bridge_profiles(man, hm, grid, W, osm_ids=(236434025, 181352682, 176061622, 37915704, 882943213, 113801340)):
    """Боковые профили мостов с подходами (по одному соседнему ребру с каждой стороны) -> PNG."""
    g = json.loads((W / "roads" / "graph.json").read_text())
    adj = {}
    for e in g["edges"]:
        for n in (e["from"], e["to"]):
            adj.setdefault(n, []).append(e)

    def pts_from(e, node):
        P = np.array(e["points"])
        return P if e["from"] == node else P[::-1]

    def extend(e, node, P_bridge_dir):
        best, bd = None, -2
        for f in adj[node]:
            if f is e:
                continue
            Q = pts_from(f, node)
            if len(Q) < 2:
                continue
            v = Q[min(3, len(Q) - 1), [0, 2]] - Q[0, [0, 2]]
            c = float(np.dot(v, P_bridge_dir) / (np.linalg.norm(v) * np.linalg.norm(P_bridge_dir) + 1e-9))
            if c > bd:
                best, bd = Q, c
        return best

    outs = []
    done = set()
    sel = [e for e in g["edges"] if e["bridge"] and e["osmId"] in osm_ids]
    sel = [e for e in sel if not (e["osmId"] in done or done.add(e["osmId"]))]
    fig, axs = plt.subplots(len(sel), 1, figsize=(12, 3.2 * len(sel)))
    for ax, e in zip(np.atleast_1d(axs), sel):
        B = np.array(e["points"])
        A = extend(e, e["from"], B[0, [0, 2]] - B[min(3, len(B) - 1), [0, 2]])
        C = extend(e, e["to"], B[-1, [0, 2]] - B[max(-4, -len(B)), [0, 2]])
        segs = []
        if A is not None: segs.append(("подход", A[::-1]))
        segs.append(("мост", B))
        if C is not None: segs.append(("подход", C))
        s0 = 0.0
        allP = []
        for kind, P in segs:
            s = s0 + np.r_[0, np.cumsum(np.hypot(*np.diff(P[:, [0, 2]], axis=0).T))]
            allP.append((kind, s, P))
            s0 = s[-1]
        # рельеф по всей линии
        for kind, s, P in allP:
            ss = np.linspace(s[0], s[-1], max(int((s[-1] - s[0]) / 1.0), 2))
            xx = np.interp(ss, s, P[:, 0]); zz = np.interp(ss, s, P[:, 2])
            ax.plot(ss, h_at(grid, hm, xx, zz), color="#8a6d3b", lw=1, label="рельеф (heightmap)" if kind == "мост" else None)
            ax.plot(s, P[:, 1], color="C0" if kind == "мост" else "C2", lw=2.2 if kind == "мост" else 1.5,
                    label=("настил моста" if kind == "мост" else "дорога-подход") if kind == "мост" or s[0] == 0 else None)
        bs = allP[1 if A is not None else 0][1]
        for x in (bs[0], bs[-1]):
            ax.axvline(x, color="gray", ls=":", lw=0.8)
        ax.set_title(f"{e['name'] or 'без имени'} (osm {e['osmId']}, мост {bs[-1] - bs[0]:.0f} м)")
        ax.set_ylabel("y, м"); ax.grid(alpha=.3); ax.legend(fontsize=8, loc="upper right")
    np.atleast_1d(axs)[-1].set_xlabel("м вдоль оси")
    fig.tight_layout()
    out = PREVIEW_DIR / "bridge_profiles.png"
    fig.savefig(out, dpi=85); plt.close(fig)
    return out


def main():
    man, hm, grid = load()
    br = bridge_report(man, hm, grid, W)
    for r in br:
        print("мост", r)
    print("мосты: макс |ступенька на конце| =", max(max(abs(r["step_from"]), abs(r["step_to"])) for r in br),
          "м; макс рельеф над настилом сбоку =", max(r["side_terrain_above_deck"] for r in br), "м")
    up = underpass_report(W)
    for u in up:
        print("под мостом", u)
    print("профили мостов:", bridge_profiles(man, hm, grid, W))
    if "--bridges-only" in sys.argv:
        return
    rep, worst = check_tiles(man, hm, grid)
    for r in rep:
        print(r)
    print("худшее проникновение рельефа сквозь дорогу (м):", round(worst, 3))
    print("extras:", check_extras())
    sp = man["spawnPoints"]
    d = [s["y"] - h_at(grid, hm, s["x"], s["z"]) for s in sp]
    print("спавны: y - heightmap:", round(float(np.min(d)), 3), round(float(np.max(d)), 3), [s.get("name") for s in sp if s.get("name")])
    print("уклоны по графу (% на сегмент >5 м):", graph_grades(man, hm, grid))
    out, nb, nr = preview(man, hm, grid)
    print("превью:", out, "треугольников крыш", nb, "дорог", nr)
    out, _, _ = preview(man, hm, grid, view=(-1100, 300, 1400, 0), name="world_preview_center.png")
    print("превью центра:", out)
    out, st = pervomaysky_profile(man, hm, grid)
    print("профиль:", out, st)


if __name__ == "__main__":
    import argparse
    from pathlib import Path
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", help="каталог мира (по умолчанию game/public/world)")
    ap.add_argument("--bridges-only", action="store_true")
    a = ap.parse_args()
    if a.world:
        W = Path(a.world).resolve()
        WORK = W.parent / (W.name + "_work")
        PREVIEW_DIR = W.parent
    main()
