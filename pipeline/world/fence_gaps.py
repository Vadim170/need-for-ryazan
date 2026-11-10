"""Проходы в оградах: финальный проход по всем сегментам-оградам props (после yards + streetlife, до записи props).

Ограды (типы fence, wall, lawn_fence, ped_fence, guardrail) разрезаются там, где их пересекает что-то, по чему ходят
или ездят. Ширина прохода задаётся поперёк пути. Если путь пересекает ограду под углом θ, длина выреза вдоль ограды
равна w / sin θ (не больше 2.5·w). Почти параллельные (< 20°) пересечения не режутся. jersey_barrier не трогаем.
Причины (reason) и ширины:
- osm_path   — OSM footway/path/steps/cycleway/bridleway (в т.ч. informal=yes): 1.3–1.8 м; pedestrian 3 м;
- driveway   — автодороги SUMO (service/living_street — проезды во дворы; прочие — улицы): ширина проезжей части + 1 м
               (не меньше 3.5 м); OSM track: 3.5 м;
- crossing   — пешеходные переходы (разметка): ширина зебры;
- walk       — рёбра пешеходного графа people/walk.json (тротуары, дорожки, дворовые линии): 1.5 м;
- entrance   — подходы к входам/подъездам (streetlife entrances): луч 12 м по нормали фасада, ширина двери + 0.4 (≥ 1.6 м);
- playground — вход на детскую площадку со стороны ближайшего узла пешеходной сети: 1.6 м;
- bus_stop   — подход к остановке: полоса 4 м от павильона к дороге;
- gate       — OSM barrier=gate/swing_gate/wicket_gate/kissing_gate/lift_gate на линии ограды (+ инстанс fence_gate);
- desire     — «тропы»: узкие полосы голой земли поперёк ограды на спутнике (эвристика по ortho, только уверенные).
guardrail режется только причинами crossing, driveway, bus_stop.
После разрезов рёбра пешеходного графа, которые всё ещё пересекают оставшиеся ограды, удаляются
(world/walk_export.drop_fence_edges).
"""
import math
import xml.etree.ElementTree as ET
from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

from config import DATA_PROCESSED, to_world
from .roads import base_class

FENCE_TYPES = {"fence", "wall", "lawn_fence", "ped_fence", "guardrail"}
GUARD_OK = {"crossing", "driveway", "bus_stop"}
MIN_ANGLE = math.radians(20)
MIN_PIECE = 0.25
GATE_W = {"gate": 3.5, "swing_gate": 3.5, "lift_gate": 4.0, "wicket_gate": 1.2, "kissing_gate": 1.2, "yes": 1.6}
FOOT_W = {"footway": 1.6, "path": 1.3, "steps": 1.6, "cycleway": 1.8, "bridleway": 1.5, "pedestrian": 3.0, "track": 3.5}
ORTHO = DATA_PROCESSED / "ortho" / "yandex_0.5m.tif"


def _cross(a, b):
    return float(a[0] * b[1] - a[1] * b[0])


GATE_STYLE = {"wood": "wood", "chain_link": "chain_link", "metal": "welded", "metal_bars": "welded"}


def _gate_nodes(osm_path):
    out = []
    lons, lats, tags = [], [], []
    for _, el in ET.iterparse(osm_path):
        if el.tag == "node":
            if len(el):
                tg = {c.get("k"): c.get("v") for c in el.iter("tag")}
                if tg.get("barrier") in GATE_W:
                    lons.append(float(el.get("lon"))); lats.append(float(el.get("lat"))); tags.append(tg)
            el.clear()
        elif el.tag in ("way", "relation"):
            el.clear()
    if lons:
        xs, ys = to_world.transform(np.array(lons), np.array(lats))
        out = list(zip(xs, ys, tags))
    return out


class Gaps:
    def __init__(self, yctx):
        self.c = yctx
        # все сегменты-ограды: (ключ тайла, индекс) -> запись
        self.refs, geoms = [], []
        for k, lst in yctx.tiles_segs.items():
            for i, s in enumerate(lst):
                if s["type"] in FENCE_TYPES:
                    self.refs.append((k, i))
                    geoms.append(LineString([(s["x1"], -s["z1"]), (s["x2"], -s["z2"])]))
        self.geoms = geoms
        self.tree = STRtree(geoms)
        self.cuts = defaultdict(list)     # индекс сегмента -> [polygon]
        self.stats = defaultdict(int)
        self.gates = []
        self.log = []       # (x, y, причина, длина выреза) — отладка, data/processed/fence_gaps_check/gaps.json

    def rec(self, j):
        k, i = self.refs[j]
        return self.c.tiles_segs[k][i]

    def allowed(self, j, reason):
        t = self.rec(j)["type"]
        if t == "guardrail":
            return reason in GUARD_OK
        return True

    def cut_at(self, j, p, w, reason, cross_dir=None, min_angle=MIN_ANGLE):
        """Вырез вокруг точки p на сегменте j (и соседях по той же линии): ширина w поперёк пути."""
        g = self.geoms[j]
        a, b = np.asarray(g.coords[0]), np.asarray(g.coords[1])
        u = b - a
        L = np.linalg.norm(u)
        if L < 1e-6:
            return False
        u /= L
        half = w / 2
        if cross_dir is not None:
            d = np.asarray(cross_dir, float)
            dl = np.linalg.norm(d)
            if dl < 1e-9:
                return False
            s = abs(_cross(u, d / dl))
            if s < math.sin(min_angle):
                return False
            half = min(w / 2 / s, 2.5 * w / 2)
        n = np.array([-u[1], u[0]])
        p = np.asarray(p, float)
        q = [p - u * half - n * 0.5, p + u * half - n * 0.5, p + u * half + n * 0.5, p - u * half + n * 0.5]
        box = shapely.Polygon(q)
        hit = False
        for k in self.tree.query(box, predicate="intersects"):
            if self.allowed(int(k), reason):
                gk = self.geoms[int(k)]
                ck = np.asarray(gk.coords[1]) - np.asarray(gk.coords[0])
                ckl = np.linalg.norm(ck)
                # соседние куски той же линии (почти коллинеарные) или сам сегмент
                if int(k) == j or (ckl > 1e-6 and abs(_cross(u, ck / ckl)) < 0.35):
                    self.cuts[int(k)].append(box)
                    hit = True
        if hit:
            self.stats[reason] += 1
            self.log.append((round(float(p[0]), 2), round(float(p[1]), 2), reason, round(float(half * 2), 2)))
        return hit

    def cut_lines(self, lines, widths, reason, min_angle=MIN_ANGLE):
        """lines: список LineString (пути), widths: ширины. Режет все пересечения с оградами."""
        if not lines:
            return
        arr = np.array(lines, dtype=object)
        li, si = self.tree.query(arr, predicate="intersects")
        done = set()
        for a, j in zip(li, si):
            a, j = int(a), int(j)
            if not self.allowed(j, reason):
                continue
            ip = lines[a].intersection(self.geoms[j])
            pts = shapely.get_coordinates(ip)
            if len(pts) == 0:
                continue
            for p in pts:
                key = (j, round(p[0], 1), round(p[1], 1))
                if key in done:
                    continue
                done.add(key)
                # направление пути в точке пересечения
                ln = lines[a]
                s = ln.project(Point(p))
                q0 = np.asarray(ln.interpolate(max(s - 0.5, 0)).coords[0]); q1 = np.asarray(ln.interpolate(min(s + 0.5, ln.length)).coords[0])
                self.cut_at(j, p, widths[a], reason, q1 - q0, min_angle)

    def apply(self):
        """Режет сегменты по накопленным вырезам; возвращает (вырезано сегментов, кусков после)."""
        by_tile = defaultdict(dict)
        for j, boxes in self.cuts.items():
            k, i = self.refs[j]
            by_tile[k][i] = shapely.union_all(boxes)
        n_cut = n_pieces = 0
        for k, d in by_tile.items():
            old = self.c.tiles_segs[k]
            new = []
            for i, s in enumerate(old):
                if i not in d:
                    new.append(s)
                    continue
                n_cut += 1
                a = np.array([s["x1"], -s["z1"]]); b = np.array([s["x2"], -s["z2"]])
                L = float(np.linalg.norm(b - a))
                rest = LineString([a, b]).difference(d[i])
                for part in getattr(rest, "geoms", [rest]):
                    if part.is_empty or part.geom_type != "LineString" or part.length < MIN_PIECE:
                        continue
                    p0, p1 = np.asarray(part.coords[0]), np.asarray(part.coords[-1])
                    t0 = float(np.dot(p0 - a, b - a) / (L * L)); t1 = float(np.dot(p1 - a, b - a) / (L * L))
                    r = dict(s)
                    r.update({"x1": round(float(p0[0]), 2), "z1": round(float(-p0[1]), 2),
                              "y1": round(s["y1"] + (s["y2"] - s["y1"]) * t0, 2),
                              "x2": round(float(p1[0]), 2), "z2": round(float(-p1[1]), 2),
                              "y2": round(s["y1"] + (s["y2"] - s["y1"]) * t1, 2)})
                    new.append(r)
                    n_pieces += 1
            self.c.tiles_segs[k] = new
        return n_cut, n_pieces


# =====================================================================================
def _ortho_desire(G, yctx, log):
    """Тропы на спутнике: узкая (0.5–3 м) полоса не-зелени, пересекающая ограду и уходящая ≥ 4 м в обе стороны,
    при зелени слева и справа вдоль ограды. Только fence / lawn_fence в зелёной зоне."""
    if not ORTHO.exists():
        return []
    import rasterio
    from rasterio.windows import from_bounds
    from .yards import GRASS, PARK, YARD, GROUNDS, BLD, ROAD, CORR, PARKING, HARD, PATH
    zone = GRASS | PARK | YARD | GROUNDS
    found = []
    cand = [j for j, (k, i) in enumerate(G.refs) if G.rec(j)["type"] in ("fence", "lawn_fence")]
    by_tile = defaultdict(list)
    for j in cand:
        by_tile[G.refs[j][0]].append(j)
    offs = np.array([-3.0, -1.5, 1.5, 3.0])
    with rasterio.open(ORTHO) as ds:
        for (ix, iz), js in by_tile.items():
            x0, x1 = ix * 250.0 - 10, (ix + 1) * 250.0 + 10
            y0, y1 = -(iz + 1) * 250.0 - 10, -iz * 250.0 + 10
            win = from_bounds(x0, y0, x1, y1, ds.transform)
            img = ds.read(window=win, boundless=True, fill_value=0).astype(np.int16)
            if img.size == 0:
                continue
            R, Gc, Bc = img
            h, w = R.shape
            res = (x1 - x0) / w
            bright = (R + Gc + Bc) / 3
            veg = ((Gc - R) > 6) & (Gc >= Bc - 4)
            bare = ~veg & (bright > 105) & (bright < 235) & ((R - Bc) > -6)

            def px(P):
                c = np.clip(((P[:, 0] - x0) / res).astype(int), 0, w - 1)
                r = np.clip(((y1 - P[:, 1]) / res).astype(int), 0, h - 1)
                return r, c
            for j in js:
                g = G.geoms[j]
                a, b = np.asarray(g.coords[0]), np.asarray(g.coords[1])
                L = np.linalg.norm(b - a)
                if L < 2.0:
                    continue
                u = (b - a) / L; n = np.array([-u[1], u[0]])
                ss = np.arange(0.5, L - 0.49, 0.5)
                if len(ss) == 0:
                    continue
                base = a + ss[:, None] * u
                m = yctx.m(base[:, 0], base[:, 1])
                if not np.any(m & zone):
                    continue
                # (позиции × смещения)
                P = base[:, None, :] + offs[None, :, None] * n[None, None, :]
                r, c = px(P.reshape(-1, 2))
                B_ = bare[r, c].reshape(len(ss), len(offs)); V_ = veg[r, c].reshape(len(ss), len(offs))
                mm = yctx.m(P[..., 0].ravel(), P[..., 1].ravel()).reshape(len(ss), len(offs))
                hard = (mm & (BLD | ROAD | CORR | PARKING | HARD | PATH)) != 0
                cross = (B_.sum(axis=1) >= 3) & B_[:, :2].any(axis=1) & B_[:, 2:].any(axis=1) & ~hard.any(axis=1)
                if not cross.any():
                    continue
                # отдельные полосы шириной 0.5–3 м с зеленью по бокам (±2.5 м вдоль ограды)
                k = 0
                while k < len(ss):
                    if not cross[k]:
                        k += 1; continue
                    e = k
                    while e + 1 < len(ss) and cross[e + 1]:
                        e += 1
                    width = (e - k + 1) * 0.5
                    sc = (ss[k] + ss[e]) / 2
                    if 0.5 <= width <= 2.5:
                        side = []
                        for ds_ in (-(width / 2 + 2.0), width / 2 + 2.0):
                            q = a + u * (sc + ds_) + offs[:, None] * n
                            if not (0 <= sc + ds_ <= L):
                                q = None
                            if q is None:
                                # за краем сегмента — берём точку по той же прямой (ограда обычно продолжается)
                                q = a + u * (sc + ds_) + offs[:, None] * n
                            rr, cc = px(q)
                            side.append(veg[rr, cc].sum())
                        if min(side) >= 3:
                            found.append((j, a + u * sc))
                    k = e + 1
    return found


def _add_gate(G, yctx, j, q, w, style):
    """Инстанс fence_gate: петля у начала проёма, −Z модели — вдоль ограды через проём (куда лёг бы закрытый створ)."""
    g = G.geoms[j]
    a, b = np.asarray(g.coords[0]), np.asarray(g.coords[1])
    u = (b - a) / max(np.linalg.norm(b - a), 1e-9)
    hx, hy = np.asarray(q, float) - u * w / 2
    yv = float(yctx.ground(np.array([hx]), np.array([hy]))[0])
    rs = G.rec(j)
    st_ = style or rs.get("style", "")
    yctx.add("fence_gate", hx, hy, float(np.arctan2(-u[0], u[1])), 1.0, yv=yv,
             width=round(float(w), 2), height=round(float(min(max(rs.get("height", 1.6), 1.0), 2.5)), 2),
             style=GATE_STYLE.get(st_, "welded"))
    return 1


def build(yctx, sl, walk_out, osm_path, log=print):
    """Главный проход. walk_out — результат walk_export.compute (рёбра пешеходного графа) или None."""
    G = Gaps(yctx)
    n_seg0 = len(G.refs)
    if not n_seg0:
        return {"segments": 0}
    osm = yctx.osm
    # 1) OSM пешеходные пути и треки
    lines, widths = [], []
    for wid, (refs, tg) in osm.ways.items():
        hw = tg.get("highway")
        if hw not in FOOT_W or tg.get("area") == "yes":
            continue
        if tg.get("tunnel", "no") != "no" or tg.get("bridge", "no") != "no":
            continue
        xy = osm.way_xy(wid)
        if len(xy) < 2:
            continue
        w = FOOT_W[hw]
        try:
            w = float(np.clip(float(str(tg.get("width")).replace(",", ".").split()[0]), 1.2, 4.0))
        except (TypeError, ValueError, IndexError):
            pass
        lines.append(LineString(xy)); widths.append(w)
    tr = [i for i, l in enumerate(lines) if widths[i] >= 3.5]
    G.cut_lines([lines[i] for i in range(len(lines)) if i not in set(tr)],
                [widths[i] for i in range(len(lines)) if i not in set(tr)], "osm_path")
    G.cut_lines([lines[i] for i in tr], [widths[i] for i in tr], "driveway")
    # 2) автодороги (проезды во дворы, улицы)
    rl, rw = [], []
    for r in yctx.roads:
        if len(r.axis) < 2 or r.tunnel:
            continue
        rl.append(LineString(r.axis)); rw.append(max(3.5, r.Wf + r.Wb + 1.0))
    G.cut_lines(rl, rw, "driveway")
    # 3) рёбра пешеходного графа (в т.ч. переходы бордюр — бордюр)
    # 4) рёбра пешеходного графа
    XY = None
    if walk_out is not None:
        from .walk_export import K_LINK, K_SQUARE, K_CROSSING
        nn = np.asarray(walk_out["nodes"], float).reshape(-1, 3)
        XY = np.c_[nn[:, 0], -nn[:, 2]]
        E = np.asarray(walk_out["edges"], int).reshape(-1, 4)
        wl, ww, cl, cw = [], [], [], []
        for a, b, kind, cid in E:
            if kind in (K_LINK, K_SQUARE):
                continue
            seg = LineString([XY[a], XY[b]])
            if kind == K_CROSSING:
                cl.append(seg); cw.append(3.0)
            else:
                wl.append(seg); ww.append(1.5)
        G.cut_lines(cl, cw, "crossing")
        G.cut_lines(wl, ww, "walk")
    # 5) подходы к входам
    el, ew = [], []
    for lst in getattr(sl, "tiles_ent", {}).values():
        for e in lst:
            p = np.array([e["x"], -e["z"]]); n = np.array([e["nx"], -e["nz"]])
            el.append(LineString([p + n * 0.3, p + n * 12.0])); ew.append(max(float(e.get("width", 1.2)) + 0.4, 1.6))
    G.cut_lines(el, ew, "entrance", min_angle=math.radians(30))
    # 6) остановки
    bl, bw = [], []
    for lst in yctx.tiles_props.values():
        for inst in lst:
            if inst["type"] == "bus_stop":
                p = np.array([inst["x"], -inst["z"]]); f = np.array([-math.sin(inst["rotY"]), math.cos(inst["rotY"])])
                bl.append(LineString([p + f * 0.5, p + f * 10.0])); bw.append(4.0)
    G.cut_lines(bl, bw, "bus_stop", min_angle=math.radians(10))
    # 7) детские площадки: вход со стороны ближайшего узла пешеходной сети
    if XY is not None and len(XY):
        from scipy.spatial import cKDTree
        kd = cKDTree(XY)
        polys = list(yctx.g["playground"]) + [p for p, _ in getattr(yctx, "extra_playgrounds", [])]
        pl, pw = [], []
        for poly in polys:
            c = np.array(poly.centroid.coords[0])
            ds_, ii = kd.query(c, k=8, distance_upper_bound=80)
            for d_, i in zip(np.atleast_1d(ds_), np.atleast_1d(ii)):
                if not np.isfinite(d_):
                    break
                q = XY[i]
                if poly.buffer(1.5).contains(Point(q)):
                    continue
                ray = LineString([c, q]).intersection(poly.buffer(3.0))
                if not ray.is_empty and ray.length > 0.5:
                    for part in getattr(ray, "geoms", [ray]):
                        if part.geom_type == "LineString":
                            pl.append(part); pw.append(1.6)
                break
        G.cut_lines(pl, pw, "playground", min_angle=math.radians(25))
    # 8) калитки/ворота OSM
    n_gate_inst = 0
    for x, y, tg in _gate_nodes(osm_path):
        if not yctx.inside(x, y, 2):
            continue
        p = Point(x, y)
        idx = G.tree.query(p.buffer(1.5), predicate="intersects")
        idx = [int(j) for j in idx if G.rec(int(j))["type"] in ("fence", "wall", "lawn_fence")]
        if not idx:
            continue
        j = min(idx, key=lambda j: G.geoms[j].distance(p))
        g = G.geoms[j]
        q = np.asarray(g.interpolate(g.project(p)).coords[0])
        kind = tg.get("barrier")
        w = GATE_W.get(kind, 1.6)
        if G.cut_at(j, q, w, "gate"):
            if kind != "lift_gate":     # шлагбаумы ставит streetlife (barrier_gate)
                n_gate_inst += _add_gate(G, yctx, j, q, w, tg.get("material") or tg.get("fence_type"))
    # 8б) огороженные территории (школы, сады, больницы, парки) без единого прохода: ворота со стороны пешеходной сети
    if XY is not None and len(XY):
        from scipy.spatial import cKDTree
        kd2 = cKDTree(XY)
        logged = np.array([(x, y) for x, y, _, _ in G.log]) if G.log else np.zeros((0, 2))
        for poly in list(yctx.g["grounds"]) + list(yctx.g["park"]):
            for pp in (poly.geoms if poly.geom_type == "MultiPolygon" else [poly]):
                ring = pp.exterior
                if ring.length < 40:
                    continue
                band = ring.buffer(4.0)
                near = [int(j) for j in G.tree.query(band, predicate="intersects")
                        if G.rec(int(j))["type"] in ("fence", "wall")]
                if not near or sum(G.geoms[j].intersection(band).length for j in near) < 0.5 * ring.length:
                    continue
                if len(logged) and np.any(shapely.distance(ring, shapely.points(logged)) < 6.0):
                    continue
                c = np.array(pp.centroid.coords[0])
                _, ii = kd2.query(c, k=30, distance_upper_bound=ring.length / 2 + 60)
                best = None
                for i in np.atleast_1d(ii):
                    if i >= len(XY):
                        break
                    if not pp.contains(Point(XY[i])) and ring.distance(Point(XY[i])) < 40:
                        best = XY[i]
                        break
                if best is None:
                    continue
                ray = LineString([c, best])
                hits = []
                for j in near:
                    ip = shapely.get_coordinates(ray.intersection(G.geoms[j]))
                    hits += [(np.hypot(*(p - best)), j, p) for p in ip]
                if not hits:
                    continue
                _, j, p = min(hits, key=lambda h: h[0])
                if G.cut_at(j, p, 3.0, "territory", best - c, math.radians(15)):
                    n_gate_inst += _add_gate(G, yctx, j, p, 3.0, None)
    # 9) тропы со спутника
    des = _ortho_desire(G, yctx, log)
    for j, p in des:
        G.cut_at(j, p, 1.4, "desire")
    n_cut, n_pieces = G.apply()
    try:
        import json
        d = DATA_PROCESSED / "fence_gaps_check"
        d.mkdir(parents=True, exist_ok=True)
        (d / "gaps.json").write_text(json.dumps(G.log))
    except OSError:
        pass
    st = {"segments_before": n_seg0, "segments_cut": n_cut, "pieces": n_pieces, "fence_gate": n_gate_inst}
    st.update({"gaps_" + k: v for k, v in G.stats.items()})
    return st


def fence_lines(yctx):
    """Оставшиеся ограды (для фильтра пешеходного графа): список LineString и типов."""
    out = []
    for lst in yctx.tiles_segs.values():
        for s in lst:
            if s["type"] in FENCE_TYPES:
                out.append(LineString([(s["x1"], -s["z1"]), (s["x2"], -s["z2"])]))
    return out
