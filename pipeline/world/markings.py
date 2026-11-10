"""Дорожная разметка (ГОСТ Р 51256 / 52289) по геометрии полос SUMO: тонкие декали над дорогой.

Что строится (нода тайла `markings`, материал `road_marking`, UV: u поперёк линии 0..1, v вдоль в метрах):
- 1.1 сплошная / 1.3 двойная сплошная между направлениями на дорогах с >= 4 полосами;
- 1.5 прерывистая (штрих 3 м, разрыв 9 м) по оси двухполосных дорог и между полосами одного направления;
  перед светофором последние 20 м — сплошная 1.1;
- 1.2 краевая сплошная на primary/secondary;
- 1.12 стоп-линия на подходах к регулируемым перекрёсткам (SUMO traffic_light);
- 1.14.1 «зебра» в узлах OSM highway=crossing на автодорогах, поперёк дороги;
- 1.18 стрелки по полосам, где у пути OSM есть turn:lanes (направления — из соединений SUMO).
Внутри площадок перекрёстков линий нет: полосы SUMO заканчиваются на границе площадки.
"""
import math
import re
import xml.etree.ElementTree as ET
from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union
from shapely.strtree import STRtree

from world import buildings as B
from world.gltf import fix_winding, smooth_normals
from world.roads import base_class, cumlen, junction_polygon, left_normals, offset, resample

NODE, MAT = "markings", "road_marking"
LIFT = 0.02            # над поверхностью дороги
LINE_W = 0.12          # ширина линий 1.1/1.2/1.5
STOP_W = 0.40          # 1.12
DASH, GAP = 3.0, 9.0   # 1.5 в населённом пункте
SOLID_BEFORE_TLS = 20.0
STEP = 2.0             # шаг вершин вдоль линий
ZEBRA_LEN, ZEBRA_STRIPE, ZEBRA_GAP = 4.0, 0.40, 0.60
ARROW_LEN = 5.0
MAJOR = {"primary", "secondary", "tertiary"}
EDGE_LINE = {"primary", "secondary"}
MINOR_MARKED = {"unclassified", "residential"}   # размечаются, только если в OSM явно задан lanes


# ---------------- интервалы и ломаные
def _interp(P, s, d):
    return np.c_[np.interp(d, s, P[:, 0]), np.interp(d, s, P[:, 1])]


def sub_line(P, s, a, b, step=STEP):
    a, b = max(a, 0.0), min(b, s[-1])
    if b - a < 0.05:
        return None
    mid = P[(s > a + 1e-6) & (s < b - 1e-6)]
    Q = np.r_[_interp(P, s, [a]), mid, _interp(P, s, [b])]
    return resample(Q, step)


def clip_intervals(iv, lo, hi):
    return [(max(a, lo), min(b, hi)) for a, b in iv if min(b, hi) - max(a, lo) > 0.05]


def subtract(iv, cuts):
    out = list(iv)
    for c0, c1 in cuts:
        nxt = []
        for a, b in out:
            if c1 <= a or c0 >= b:
                nxt.append((a, b)); continue
            if c0 > a: nxt.append((a, c0))
            if c1 < b: nxt.append((c1, b))
        out = nxt
    return [(a, b) for a, b in out if b - a > 0.05]


def dashes(L, phase=1.0, dash=DASH, gap=GAP):
    out, a = [], phase
    while a < L:
        out.append((a, min(a + dash, L)))
        a += dash + gap
    return out


def union_iv(iv):
    iv = sorted(iv)
    out = []
    for a, b in iv:
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


# ---------------- поверхность дорог (уже построенные ленты и площадки)
class RoadSurface:
    """Высота фактического меша `roads` (ленты + площадки) в точке: декаль кладётся ровно над ним."""
    def __init__(self, tiles):
        tris = []
        for nodes in tiles.values():
            for pr in nodes.get("roads", {}).values():
                if pr is not None and not pr.empty():
                    P, _, _, I = pr.arrays()
                    tris.append(P[I.reshape(-1, 3)].astype(np.float64))
        T = np.concatenate(tris)
        a = np.stack([T[:, :, 0], -T[:, :, 2]], -1)
        d = (a[:, 1, 1] - a[:, 2, 1]) * (a[:, 0, 0] - a[:, 2, 0]) + (a[:, 2, 0] - a[:, 1, 0]) * (a[:, 0, 1] - a[:, 2, 1])
        keep = np.abs(d) > 1e-9
        self.T, self.a, self.d = T[keep], a[keep], d[keep]
        self.tree = STRtree(shapely.polygons(np.concatenate([self.a, self.a[:, :1]], 1)))

    def height(self, XY, est, tol=0.6):
        """Максимум поверхностей в пределах ±tol от оценки est (ярусы мостов отсекаются); нет попадания -> est."""
        pi, ti = self.tree.query(shapely.points(XY), predicate="intersects")
        res = np.full(len(XY), -np.inf)
        if len(pi):
            a, T, d = self.a[ti], self.T[ti], self.d[ti]
            px, py = XY[pi, 0], XY[pi, 1]
            l1 = ((a[:, 1, 1] - a[:, 2, 1]) * (px - a[:, 2, 0]) + (a[:, 2, 0] - a[:, 1, 0]) * (py - a[:, 2, 1])) / d
            l2 = ((a[:, 2, 1] - a[:, 0, 1]) * (px - a[:, 2, 0]) + (a[:, 0, 0] - a[:, 2, 0]) * (py - a[:, 2, 1])) / d
            y = l1 * T[:, 0, 1] + l2 * T[:, 1, 1] + (1 - l1 - l2) * T[:, 2, 1]
            ok = np.abs(y - est[pi]) < tol
            np.maximum.at(res, pi[ok], y[ok])
        hit = np.isfinite(res)
        self.hits += int(hit.sum()); self.total += len(XY)
        return np.where(hit, res, est)

    hits = total = 0

    def nearest(self, XY, max_dist):
        """Ближайшая (в плане) точка меша дорог для каждой XY в пределах max_dist:
        -> (высота y там, расстояние, x, y этой точки); нет дороги -> nan, inf."""
        pts = shapely.points(XY)
        (pi, ti), dist = self.tree.query_nearest(pts, max_distance=max_dist, return_distance=True, all_matches=False)
        y = np.full(len(XY), np.nan); dd = np.full(len(XY), np.inf); Q = np.array(XY, np.float64).copy()
        if len(pi):
            tris = self.tree.geometries[ti]
            near = shapely.get_coordinates(shapely.get_point(shapely.shortest_line(tris, pts[pi]), 0))
            a, T, d = self.a[ti], self.T[ti], self.d[ti]
            px, py = near[:, 0], near[:, 1]
            l1 = ((a[:, 1, 1] - a[:, 2, 1]) * (px - a[:, 2, 0]) + (a[:, 2, 0] - a[:, 1, 0]) * (py - a[:, 2, 1])) / d
            l2 = ((a[:, 2, 1] - a[:, 0, 1]) * (px - a[:, 2, 0]) + (a[:, 0, 0] - a[:, 2, 0]) * (py - a[:, 2, 1])) / d
            yy = l1 * T[:, 0, 1] + l2 * T[:, 1, 1] + (1 - l1 - l2) * T[:, 2, 1]
            y[pi] = yy; dd[pi] = dist; Q[pi] = near
        return y, dd, Q


# ---------------- вывод геометрии
class Out:
    def __init__(self, ctx):
        self.tiles, self.tile_key = ctx["tiles"], ctx["tile_key"]
        self.surf, self.base, self.lift_road = ctx["surf"], ctx["base"], ctx["lift"]
        self.rs = RoadSurface(self.tiles)
        self.n_tris = 0

    def height(self, XY, road):
        """Поверхность дороги (координаты игры, y) + подъём декали."""
        if road is not None and road.bridge:
            line = LineString(road.axis)
            s = shapely.line_locate_point(line, shapely.points(XY))
            est = np.interp(s, road.s_axis, road.z_axis) - self.base + self.lift_road
        else:
            est = self.surf(XY[:, 0], XY[:, 1])
        return self.rs.height(XY, est) + LIFT

    def strip(self, C, w, v0, road):
        """Полоса ширины w вдоль ломаной C, режется по тайлам по середине сегмента."""
        if C is None or len(C) < 2:
            return
        v = v0 + cumlen(C)
        Lb, Rb = offset(C, w / 2), offset(C, -w / 2)
        yl, yr = self.height(Lb, road), self.height(Rb, road)
        mid = (C[:-1] + C[1:]) / 2
        ks = [self.tile_key(x, y) for x, y in mid]
        i = 0
        while i < len(ks):
            j = i
            while j + 1 < len(ks) and ks[j + 1] == ks[i]:
                j += 1
            sl = slice(i, j + 2); k = j + 2 - i
            P = np.empty((2 * k, 3))
            P[0::2] = np.c_[Rb[sl, 0], yr[sl], -Rb[sl, 1]]
            P[1::2] = np.c_[Lb[sl, 0], yl[sl], -Lb[sl, 1]]
            q = 2 * np.arange(k - 1)[:, None]
            T = fix_winding(P, np.c_[q, q + 2, q + 3, q, q + 3, q + 1].reshape(-1, 3), np.array([0, 1.0, 0]))
            UV = np.empty((2 * k, 2)); UV[0::2, 0] = 0; UV[1::2, 0] = 1; UV[0::2, 1] = v[sl]; UV[1::2, 1] = v[sl]
            self.tiles[ks[i]][NODE][MAT].add(P, T, smooth_normals(P, T), UV)
            self.n_tris += len(T)
            i = j + 1

    def polygon(self, poly2d, frame, road):
        """Плоская фигура (стрелка) в локальных координатах (a вдоль, b влево) -> мир."""
        c, t, n = frame
        V2, T = B.triangulate(poly2d)
        if V2 is None:
            return
        XY = c + V2[:, :1] * t + V2[:, 1:2] * n
        y = self.height(XY, road)
        P = np.c_[XY[:, 0], y, -XY[:, 1]]
        T = fix_winding(P, T, np.array([0, 1.0, 0]))
        b = V2[:, 1]
        UV = np.c_[(b - b.min()) / max(b.max() - b.min(), 1e-6), V2[:, 0]]
        self.tiles[self.tile_key(*c)][NODE][MAT].add(P, T, np.tile([0, 1.0, 0], (len(P), 1)), UV)
        self.n_tris += len(T)


# ---------------- стрелки 1.18 (локально: a — вдоль полосы от основания, b — влево)
def _rect(a0, a1, b0, b1):
    return box(min(a0, a1), min(b0, b1), max(a0, a1), max(b0, b1))


def arrow_shape(dirs):
    sw, hw, hl = 0.18, 0.75, 1.5          # ширина стержня, ширина и длина наконечника
    parts = []
    has_s = "s" in dirs
    top = ARROW_LEN - hl if has_s else 3.0
    parts.append(_rect(0, top + 0.01, -sw / 2, sw / 2))
    if has_s:
        parts.append(Polygon([(ARROW_LEN - hl, -hw / 2), (ARROW_LEN, 0), (ARROW_LEN - hl, hw / 2)]))
    for d, sg in (("l", 1), ("r", -1)):
        if d not in dirs:
            continue
        a = 1.9 if has_s else top - sw / 2       # уровень бокового отвода
        arm = 0.75
        parts.append(_rect(a - sw / 2, a + sw / 2, 0, sg * arm))
        parts.append(Polygon([(a - hw / 2, sg * arm), (a, sg * (arm + 1.1)), (a + hw / 2, sg * arm)]))
    g = unary_union(parts)
    return g if g.geom_type == "Polygon" else max(g.geoms, key=lambda p: p.area)


def parse_connections(net_path):
    """{(edge, lane): set(dir)} для неслужебных рёбер."""
    con = defaultdict(set)
    for _, el in ET.iterparse(net_path):
        if el.tag == "connection":
            f = el.get("from")
            if not f.startswith(":"):
                d = el.get("dir")
                d = {"L": "l", "R": "r"}.get(d, d)
                if d in ("s", "l", "r"):
                    con[(f, int(el.get("fromLane")))].add(d)
        el.clear()
    return con


def has_turn_lanes(edge_id, tags):
    """Есть ли turn:lanes для направления движения этого ребра SUMO."""
    back = edge_id.startswith("-")
    ow = tags.get("oneway") in ("yes", "true", "1") or tags.get("junction") == "roundabout"
    if back:
        return "turn:lanes:backward" in tags or (tags.get("oneway") == "-1" and "turn:lanes" in tags)
    return "turn:lanes:forward" in tags or (ow and "turn:lanes" in tags)


# ---------------- пешеходные переходы
def find_crossings(osm, roads, pads_list):
    """Узлы OSM highway=crossing на автодорогах -> переходы поперёк ближайшей дороги того же пути OSM.
    Возвращает [{c, t, n, wr, wl, road, marked, s}]."""
    car = osm.car_ways()
    on_car = defaultdict(set)
    want = np.array(sorted(n for n, tg in osm.node_tags.items() if tg.get("highway") == "crossing"
                           or (tg.get("highway") == "traffic_signals" and tg.get("crossing") not in (None, "no"))),
                    dtype=np.int64)
    wset = set(want.tolist())
    for wid, (refs, _) in car.items():
        for nd in refs:
            if int(nd) in wset:
                on_car[int(nd)].add(wid)
    by_osm = defaultdict(list)
    for r in roads:
        by_osm[r.osm_id].append(r)
    lines = [LineString(r.axis) for r in roads]
    tree = STRtree(lines)
    pad_geoms = [p for p, _ in pads_list]
    pad_tree = STRtree(pad_geoms)
    out = []
    for nid in sorted(on_car):
        tg = osm.node_tags[nid]
        if tg.get("crossing") in ("no", "unmarked", "informal") or tg.get("crossing_ref") == "none":
            marked = False
        else:
            marked = True
        i, ok = osm.node_index(np.array([nid]))
        if not ok[0]:
            continue
        p = osm.xy[i[0]]
        pt = Point(p)
        cands = [r for w in on_car[nid] for r in by_osm.get(w, [])]
        if not cands:
            cands = [roads[k] for k in tree.query(pt.buffer(15))]
        if not cands:
            continue
        r = min(cands, key=lambda rr: LineString(rr.axis).distance(pt))
        line = LineString(r.axis)
        if line.distance(pt) > 15:
            continue
        L = line.length
        s = line.project(pt)
        half = ZEBRA_LEN / 2 + 0.5
        # узкая площадка (светофор на перегоне): переход по центру узла, поверх площадки
        near_pad = [pad_geoms[k] for k in pad_tree.query(pt.buffer(1.0))]
        thin = any(min(_mrr_dims(pg)) < 6.0 for pg in near_pad)
        if not thin:
            s = float(np.clip(s, half, L - half)) if L > 2 * half else L / 2
        c = np.array(line.interpolate(s).coords[0])
        a, b = line.interpolate(max(s - 1.0, 0)), line.interpolate(min(s + 1.0, L))
        t = np.array(b.coords[0]) - np.array(a.coords[0])
        t /= max(np.hypot(*t), 1e-9)
        n = np.array([-t[1], t[0]])
        if r.bwd is not None:
            wr, wl = r.Wf, r.Wb
        else:
            wr = wl = r.Wf / 2
        # дубликаты (один переход отмечен двумя узлами)
        if any(o["road"] is r and np.hypot(*(o["c"] - c)) < 4.0 for o in out):
            continue
        out.append({"c": c, "t": t, "n": n, "wr": wr, "wl": wl, "road": r, "marked": marked, "s": s, "osm": nid})
    return out


def _mrr_dims(pg):
    mrr = pg.minimum_rotated_rectangle
    xy = np.asarray(mrr.exterior.coords)
    if len(xy) < 4:
        return (0.0, 0.0)
    return (float(np.hypot(*(xy[1] - xy[0]))), float(np.hypot(*(xy[2] - xy[1]))))


def crossing_rect(cr, extra_a=0.0, extra_b=0.0):
    c, t, n = cr["c"], cr["t"], cr["n"]
    a = ZEBRA_LEN / 2 + extra_a
    pts = [c + t * sa * a + n * sb for sa, sb in ((-1, -cr["wr"] - extra_b), (1, -cr["wr"] - extra_b),
                                                     (1, cr["wl"] + extra_b), (-1, cr["wl"] + extra_b))]
    return Polygon(pts)


# ---------------- основная функция
def build_markings(ctx):
    net, roads, osm = ctx["net"], ctx["roads"], ctx["osm"]
    zj, floating, jix = ctx["zj"], ctx["floating"], ctx["jix"]
    pads_list = []
    for j in zj:
        p = junction_polygon(net.junctions[j])
        if p is not None:
            pads_list.append((p, bool(floating[jix[j]])))
    out = Out(ctx)
    ctx["road_surface"] = out.rs   # переиспользуют тротуары
    con = parse_connections(ctx["net_path"])
    tls = {j for j, J in net.junctions.items() if J["type"] == "traffic_light"}
    st = defaultdict(int)

    crossings = find_crossings(osm, roads, pads_list)
    zebras = [c for c in crossings if c["marked"]]
    keep = [crossing_rect(z, 0.5, 0.6) for z in zebras]
    keep_tree = STRtree(keep) if keep else None

    def cut_by_zebras(Q, s):
        """s-интервалы ломаной Q, попадающие на переходы."""
        if keep_tree is None:
            return []
        line = LineString(Q)
        cuts = []
        for k in keep_tree.query(line, predicate="intersects"):
            g = line.intersection(keep[k])
            for part in getattr(g, "geoms", [g]):
                if part.is_empty or part.geom_type != "LineString":
                    continue
                cs = np.asarray(part.coords)
                ss = [line.project(Point(cs[0])), line.project(Point(cs[-1]))]
                cuts.append((min(ss), max(ss)))
        return cuts

    def emit_line(Q, intervals, road, w=LINE_W, offsets=(0.0,)):
        s = cumlen(Q)
        iv = subtract(clip_intervals(intervals, 0, s[-1]), cut_by_zebras(Q, s))
        for d in offsets:
            Qd = offset(Q, d) if d else Q
            sd = cumlen(Qd)
            k = sd[-1] / max(s[-1], 1e-9)
            for a, b in iv:
                out.strip(sub_line(Qd, sd, a * k, b * k), w, a, road)
                st["segments"] += 1
        return sum(b - a for a, b in iv)

    tags_of = lambda r: osm.ways.get(r.osm_id, (None, {}))[1] if r.osm_id is not None else {}
    zebra_s = defaultdict(list)   # road id -> [центр зебры]
    for z in zebras:
        zebra_s[z["road"].id].append(z["c"])

    def stop_pos(e, lane_line, L):
        """Расстояние от начала полосы до стоп-линии: 1 м до площадки или до перехода."""
        sp = L - 1.0
        for c in zebra_s.get(e["_road"].id, []):
            sz = lane_line.project(Point(c))
            if L - 25 < sz <= L + 1:
                sp = min(sp, sz - ZEBRA_LEN / 2 - 1.0 - STOP_W / 2)
        return sp

    for r in roads:
        cls = base_class(r.hw)
        tg = tags_of(r)
        if cls in ("service", "living_street"):
            marked = False
        elif cls in MINOR_MARKED:
            marked = "lanes" in tg
        else:
            marked = cls in MAJOR
        edges = [e for e in (r.fwd, r.bwd) if e is not None]
        for e in edges:
            e["_road"] = r
        info = {}
        for e in edges:
            lanes = e["lanes"]
            l0 = lanes[0]
            line0 = LineString(l0["shape"])
            L0 = line0.length
            to_tls = e["to"] in tls
            sp = stop_pos(e, line0, L0) if to_tls and L0 > 6 else None
            info[e["id"]] = (to_tls, sp, L0)
            # 1.12 стоп-линия
            if sp is not None and sp > 2 and cls != "service":
                W = sum(l["width"] for l in lanes)
                P0 = _interp(l0["shape"], cumlen(l0["shape"]), [sp])[0]
                tt = _interp(l0["shape"], cumlen(l0["shape"]), [min(sp + 0.5, L0)])[0] - _interp(l0["shape"], cumlen(l0["shape"]), [max(sp - 0.5, 0)])[0]
                tt /= max(np.hypot(*tt), 1e-9)
                nn = np.array([-tt[1], tt[0]])
                C = np.array([P0 - nn * (l0["width"] / 2 - 0.1), P0 + nn * (W - l0["width"] / 2 - 0.1)])
                out.strip(resample(C, 2.0), STOP_W, 0.0, r)
                st["stop_lines"] += 1
            # 1.5 между полосами одного направления
            if len(lanes) >= 2 and cls not in ("service", "living_street"):
                for k in range(len(lanes) - 1):
                    Q = offset(resample(lanes[k]["shape"], STEP), lanes[k]["width"] / 2)
                    Lq = cumlen(Q)[-1]
                    iv = dashes(Lq)
                    if to_tls and sp is not None:
                        k_ = Lq / max(L0, 1e-9)
                        iv = union_iv(clip_intervals(iv, 0, (sp - STOP_W) * k_) + [(max(0, (sp - SOLID_BEFORE_TLS) * k_), (sp - STOP_W) * k_)])
                    st["lane_m"] += emit_line(Q, iv, r)
            # 1.2 краевые
            if cls in EDGE_LINE:
                Q = offset(resample(l0["shape"], STEP), -(l0["width"] / 2 - 0.25))
                st["edge_m"] += emit_line(Q, [(0, cumlen(Q)[-1])], r)
                if r.bwd is None:
                    ll = lanes[-1]
                    Q = offset(resample(ll["shape"], STEP), ll["width"] / 2 - 0.25)
                    st["edge_m"] += emit_line(Q, [(0, cumlen(Q)[-1])], r)
            # 1.18 стрелки
            if has_turn_lanes(e["id"], tg) and L0 > 14:
                sets = [frozenset(con.get((e["id"], l["index"]), ())) for l in lanes]
                if any(sets) and not all(sv == {"s"} for sv in sets):
                    for l, dv in zip(lanes, sets):
                        if not dv:
                            continue
                        P = resample(l["shape"], 1.0)
                        s = cumlen(P)
                        end = (sp if sp is not None else s[-1] - 1.0) - 2.0
                        a0 = end - ARROW_LEN
                        if a0 < 2:
                            continue
                        c = _interp(P, s, [a0])[0]
                        tt = _interp(P, s, [a0 + ARROW_LEN])[0] - c
                        tt /= max(np.hypot(*tt), 1e-9)
                        out.polygon(arrow_shape(dv), (c, tt, np.array([-tt[1], tt[0]])), r)
                        st["arrows"] += 1
        # ось двусторонней дороги
        if r.bwd is not None and marked:
            ll = r.fwd["lanes"][-1]
            Q = offset(resample(ll["shape"], STEP), ll["width"] / 2)
            Lq = cumlen(Q)[-1]
            N = len(r.fwd["lanes"]) + len(r.bwd["lanes"])
            if N >= 4:
                offs = (-0.12, 0.12) if cls in ("primary", "secondary") else (0.0,)
                st["centre_solid_m" if len(offs) == 1 else "centre_double_m"] += emit_line(Q, [(0, Lq)], r, offsets=offs)
            else:
                iv = dashes(Lq)
                f_tls, f_sp, f_L = info[r.fwd["id"]]
                b_tls, b_sp, b_L = info[r.bwd["id"]]
                if f_tls and f_sp is not None:
                    e_ = f_sp * Lq / max(f_L, 1e-9)
                    iv = clip_intervals(iv, 0, e_) + [(max(0, e_ - SOLID_BEFORE_TLS), e_)]
                if b_tls and b_sp is not None:
                    s_ = Lq - b_sp * Lq / max(b_L, 1e-9)
                    iv = clip_intervals(iv, s_, Lq) + [(s_, min(Lq, s_ + SOLID_BEFORE_TLS))]
                st["centre_dash_m"] += emit_line(Q, union_iv(iv), r)
        for e in edges:
            e.pop("_road", None)

    # 1.14.1 зебры
    for z in zebras:
        r = z["road"]
        span0, span1 = -z["wr"] + 0.3, z["wl"] - 0.3
        period = ZEBRA_STRIPE + ZEBRA_GAP
        n = int((span1 - span0 - ZEBRA_STRIPE) // period) + 1
        if n < 1:
            continue
        off0 = (span0 + span1) / 2 - (n - 1) * period / 2
        a = np.linspace(-ZEBRA_LEN / 2, ZEBRA_LEN / 2, 5)
        for k in range(n):
            b = off0 + k * period
            C = z["c"] + a[:, None] * z["t"] + b * z["n"]
            out.strip(C, ZEBRA_STRIPE, 0.0, r)
        st["zebras"] += 1; st["zebra_stripes"] += n
    st["crossings_all"] = len(crossings)
    st["triangles"] = out.n_tris
    st["vertices_on_road_mesh_pct"] = round(100 * out.rs.hits / max(out.rs.total, 1), 1)
    st = {k: (round(v / 1000, 1) if k.endswith("_m") else v) for k, v in st.items()}
    return crossings, st
