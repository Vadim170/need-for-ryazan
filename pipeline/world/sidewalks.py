"""Тротуары и бордюры.

Источники:
- отдельные пути OSM `footway=sidewalk` (highway=footway/path) — полоса по линии пути шириной `width` (по умолчанию 2 м);
- теги дороги `sidewalk=*` / `sidewalk:left|right|both=*`: `no` — нет, `separate` — берём отдельный путь,
  `yes/both/left/right` — процедурная полоса;
- без тегов — процедурно вдоль городских дорог (residential и выше, без съездов, service, living_street,
  тоннелей и мостов; на мост — только по явному тегу). Если рядом уже есть отдельный `footway=sidewalk`, процедурный
  кусок не строится.

Полоса прилегает к кромке проезжей части, ширина: primary/secondary 3 м, tertiary 2.5 м, остальные 2 м. Из неё
вычитаются все проезжие части (ленты и площадки перекрёстков), здания и вода; у перекрёстков добавляются угловые
скругления (кольцо вокруг площадки), если они касаются тротуаров. Верх: рельеф +0.15 м (на мосту — настил +0.10 м),
у пешеходных переходов бордюр опущен до +0.07 м с пандусами по 1.5 м. Все края — вертикальные грани материала `curb`.
Коллайдеров нет (аркада, v1).

Высоты (исправление «размазанных» тротуаров): верх режется по треугольникам ячеек heightmap 5 м (как `areas` в
world/yards.py), контур бордюра уплотняется в точках пересечения с линиями сетки и диагоналями, поэтому тротуар и бордюр
точно повторяют рельеф. Опорная высота = рельеф + поправка на отклонение соседней дороги от рельефа (наземные ленты
стоят на рельеф +0.05 только в вершинах, между ними — хорды): полная до 2 м от кромки, затухает к 4 м; большие отклонения
(насыпь въезда, настил моста) плавно гасятся, чтобы не было ступенек. Под низкими настилами мостов (< 3 м над рельефом)
наземных тротуаров нет; тротуары на мостах (по тегу) идут по поверхности настила с переходом к рельефу у опор.
"""
from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from shapely.strtree import STRtree

from world import buildings as B
from world.gltf import fix_winding, smooth_normals
from world.markings import crossing_rect, sub_line
from world.osm import parse_numbers
from world.roads import base_class, cumlen, junction_polygon, offset, resample

NODE = "sidewalks"
TOP = 0.15            # над рельефом
TOP_LOWERED = 0.07    # опущенный бордюр у перехода
RAMP = 1.5
BOTTOM = -0.03        # низ граней бордюра относительно рельефа
FOLLOW_FULL, FOLLOW_ZERO = 2.0, 4.0   # поправка на высоту дороги: полная до 2 м от кромки, ноль с 4 м
FOLLOW_MAX = 0.6      # вес поправки 1 - |dev|/FOLLOW_MAX: малые отклонения дороги (хорды лент) — полностью,
                      # большие (насыпь въезда на мост, настил) плавно до нуля — без ступеньки
LOW_DECK = 3.0        # под настилом ниже этого над рельефом наземный тротуар не строится
CHUNK = 20.0          # длина куска процедурной полосы
WIDTH = {"primary": 3.0, "secondary": 3.0, "tertiary": 2.5, "unclassified": 2.0, "residential": 2.0}
SEPARATE_NEAR = 10.0  # отдельный тротуар ближе этого к середине полосы -> процедурный кусок не нужен


def side_tags(tg):
    """{'left'|'right': 'yes'|'no'|'separate'|None} в направлении пути OSM."""
    v = {"left": None, "right": None}
    norm = lambda x: {"yes": "yes", "both": "yes", "left": "yes", "right": "yes", "no": "no", "none": "no",
                      "separate": "separate"}.get(x)
    sw = tg.get("sidewalk")
    if sw in ("both", "yes"):
        v = {"left": "yes", "right": "yes"}
    elif sw == "left":
        v = {"left": "yes", "right": "no"}
    elif sw == "right":
        v = {"left": "no", "right": "yes"}
    elif sw in ("no", "none"):
        v = {"left": "no", "right": "no"}
    elif sw == "separate":
        v = {"left": "separate", "right": "separate"}
    if tg.get("sidewalk:both"):
        v["left"] = v["right"] = norm(tg["sidewalk:both"]) or v["left"]
    for s in ("left", "right"):
        if tg.get("sidewalk:" + s):
            v[s] = norm(tg["sidewalk:" + s]) or v[s]
    return v


def _valid_polys(p):
    p = shapely.make_valid(p)
    return [g for g in B.polygons(p) if g.area > 0.05]


def carriageway(e):
    l0 = e["lanes"][0]
    W = sum(l["width"] for l in e["lanes"])
    lane = resample(l0["shape"], 4.0)
    if len(lane) < 2:
        return []
    Rb = offset(lane, -l0["width"] / 2); Lb = offset(lane, W - l0["width"] / 2)
    return _valid_polys(Polygon(np.r_[Rb, Lb[::-1]]))


def band_chunks(edge_line, sigma, sw):
    """Куски полосы от кромки edge_line наружу (sigma=-1 — вправо по ходу ломаной), длиной ~CHUNK.
    -> [(polygon, centre LineString, середина кромки, направление)]"""
    P = resample(edge_line, 2.0)
    if len(P) < 2:
        return []
    s = cumlen(P)
    out = []
    n = max(1, int(np.ceil(s[-1] / CHUNK)))
    cuts = np.linspace(0, s[-1], n + 1)
    for a, b in zip(cuts[:-1], cuts[1:]):
        Q = sub_line(P, s, a, b, 2.0)
        if Q is None or len(Q) < 2:
            continue
        outer = offset(Q, sigma * sw)
        poly = _valid_polys(Polygon(np.r_[Q, outer[::-1]]))
        if poly:
            m = Q[len(Q) // 2] if len(Q) > 2 else Q.mean(0)
            t = Q[-1] - Q[0]
            t = t / max(np.hypot(*t), 1e-9)
            out.append((unary_union(poly), LineString(offset(Q, sigma * sw / 2)), m, t))
    return out


def is_median(m, t, sigma, road, ow_tree, ow_lines, ow_roads, reach=30.0):
    """Сторона односторонней дороги смотрит на встречную проезжую часть (разделённая дорога) -> True."""
    nrm = sigma * np.array([-t[1], t[0]])
    probe = LineString([m + nrm * 0.5, m + nrm * reach])
    for k in ow_tree.query(probe, predicate="intersects"):
        o = ow_roads[k]
        if o is road:
            continue
        line = ow_lines[k]
        x = probe.intersection(line)
        pt = x if x.geom_type == "Point" else (x.geoms[0] if hasattr(x, "geoms") and len(x.geoms) else None)
        if pt is None or pt.geom_type != "Point":
            continue
        d = line.project(pt)
        p0, p1 = line.interpolate(max(d - 1, 0)), line.interpolate(min(d + 1, line.length))
        to = np.array(p1.coords[0]) - np.array(p0.coords[0])
        to = to / max(np.hypot(*to), 1e-9)
        if float(to @ t) < -0.5:
            return True
    return False


def low_deck_polys(r, terr, base, lift):
    """Куски проезжей части моста, где настил ниже LOW_DECK над рельефом (въезды): под ними тротуара нет."""
    out = []
    line = LineString(r.axis)
    for e in (r.fwd, r.bwd):
        if e is None:
            continue
        l0 = e["lanes"][0]
        W = sum(l["width"] for l in e["lanes"])
        lane = resample(l0["shape"], 4.0)
        if len(lane) < 2:
            continue
        Rb = offset(lane, -l0["width"] / 2 - 1.0); Lb = offset(lane, W - l0["width"] / 2 + 1.0)
        mid = (lane[:-1] + lane[1:]) / 2
        sq = shapely.line_locate_point(line, shapely.points(mid))
        deck = np.interp(sq, r.s_axis, r.z_axis) - base
        low = deck - terr(mid) < LOW_DECK
        for i in np.nonzero(low)[0]:
            out.extend(_valid_polys(Polygon([Rb[i], Rb[i + 1], Lb[i + 1], Lb[i]])))
    return out


def grid_cells(p, grid):
    """Индексы (r, c) ячеек heightmap, задетых полигоном."""
    x0, y0, x1, y1 = p.bounds
    c0 = int(np.floor((x0 - grid.min_x) / grid.cell)); c1 = int(np.floor((x1 - grid.min_x) / grid.cell))
    r0 = int(np.floor((grid.max_y - y1) / grid.cell)); r1 = int(np.floor((grid.max_y - y0) / grid.cell))
    rr, cc = np.mgrid[r0:r1 + 1, c0:c1 + 1]
    return rr.ravel(), cc.ravel()


def drape(p, grid):
    """Полигон -> (V2, T), разрезанный по треугольникам ячеек heightmap (диагональ (r,c)-(r+1,c+1), как у коллайдера):
    каждый треугольник лежит в одной грани рельефа, поэтому верх точно параллелен рельефу."""
    rr, cc = grid_cells(p, grid)
    if len(rr) == 0:
        return None, None
    cs = grid.cell
    X0 = grid.min_x + cc * cs; X1 = X0 + cs
    Y0 = grid.max_y - rr * cs; Y1 = Y0 - cs
    A = np.c_[X0, Y0]; Bp = np.c_[X0, Y1]; C = np.c_[X1, Y1]; D = np.c_[X1, Y0]
    tris = shapely.polygons(np.concatenate([np.stack([A, Bp, C, A], 1), np.stack([A, C, D, A], 1)]))
    shapely.prepare(p)
    hit = shapely.intersects(p, tris)
    tris = tris[hit]
    full = shapely.contains(p, tris)
    pos, idx, nv = [], [], 0
    for t in tris[full]:
        V = np.asarray(t.exterior.coords)[:3]
        pos.append(V); idx.append(np.array([[nv, nv + 1, nv + 2]])); nv += 3
    for gm in shapely.intersection(tris[~full], p):
        for q in B.polygons(gm):
            if q.area < 1e-3:
                continue
            V, T = B.triangulate(q)
            if V is None:
                continue
            pos.append(V); idx.append(T + nv); nv += len(V)
    if not pos:
        return None, None
    V = np.concatenate(pos); T = np.concatenate(idx)
    Vr, inv = np.unique(np.round(V, 3), axis=0, return_inverse=True)
    T = inv.ravel()[T]
    T = T[(T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2])]
    return Vr, T


def densify_ring(C, grid):
    """Вставляет в замкнутый контур точки пересечения с линиями сетки heightmap и диагоналями ячеек."""
    a, b = C[:-1], C[1:]
    ra = (grid.max_y - a[:, 1]) / grid.cell; ca = (a[:, 0] - grid.min_x) / grid.cell
    rb = (grid.max_y - b[:, 1]) / grid.cell; cb = (b[:, 0] - grid.min_x) / grid.cell
    segs, ts = [np.arange(len(a))], [np.zeros(len(a))]
    for va, vb in ((ra, rb), (ca, cb), (ra - ca, rb - cb)):
        lo = np.ceil(np.minimum(va, vb) + 1e-7); hi = np.floor(np.maximum(va, vb) - 1e-7)
        n = np.maximum(hi - lo + 1, 0).astype(np.int64)
        if n.sum() == 0:
            continue
        sid = np.repeat(np.arange(len(a)), n)
        k = np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)
        v = lo[sid] + k
        ts.append((v - va[sid]) / (vb[sid] - va[sid])); segs.append(sid)
    sid = np.concatenate(segs); t = np.concatenate(ts)
    o = np.lexsort((t, sid))
    sid, t = sid[o], t[o]
    P = a[sid] + (b - a)[sid] * t[:, None]
    P = np.r_[P, C[-1:]]
    keep = np.r_[True, np.hypot(*np.diff(P, axis=0).T) > 1e-4]
    return P[keep]


def build_sidewalks(ctx, crossings):
    net, roads, osm = ctx["net"], ctx["roads"], ctx["osm"]
    zj, floating, jix = ctx["zj"], ctx["floating"], ctx["jix"]
    grid, H, base, lift = ctx["grid"], ctx["H"], ctx["base"], ctx["lift"]
    tiles, TILE = ctx["tiles"], ctx["tile"]
    st = defaultdict(float)

    terr = lambda XY: grid.sample(H, XY[:, 0], XY[:, 1]) - base

    # ---------- препятствия
    obst_ground, obst_bridge = [], []
    for r in roads:
        for e in (r.fwd, r.bwd):
            if e is not None:
                (obst_bridge if r.bridge else obst_ground).extend(carriageway(e))
    for r in roads:
        if r.bridge:
            obst_ground.extend(low_deck_polys(r, terr, base, lift))
    rs = ctx.get("road_surface")
    if rs is None:
        from world.markings import RoadSurface
        rs = ctx["road_surface"] = RoadSurface(tiles)

    def ground(XY):
        """Опорная высота тротуара (до +TOP): рельеф + отклонение соседней дороги от рельефа."""
        t = terr(XY)
        y, dist, Q = rs.nearest(XY, FOLLOW_ZERO)
        dev = (y - lift) - terr(Q)
        ok = np.isfinite(y)
        dev = np.where(ok, dev, 0.0)
        w = np.clip((FOLLOW_ZERO - dist) / (FOLLOW_ZERO - FOLLOW_FULL), 0, 1) * np.clip(1 - np.abs(dev) / FOLLOW_MAX, 0, 1)
        return t + np.maximum(np.where(ok, dev * w, 0.0), TOP_LOWERED - TOP)   # верх не ниже рельефа +0.07

    def ground_bridge(XY):
        y, dist, Q = rs.nearest(XY, 8.0)
        return np.where(np.isfinite(y), y - lift, terr(XY))

    pads = {}
    for j in zj:
        p = junction_polygon(net.junctions[j])
        if p is not None:
            if floating[jix[j]]:
                obst_bridge.append(p)
                c = np.array(p.centroid.coords)
                if zj[j] - base - terr(c)[0] < LOW_DECK:      # низкая площадка на мосту: под ней тротуара нет
                    obst_ground.extend(B.polygons(p.buffer(1.0)))
            else:
                pads[j] = p
                obst_ground.append(p)
    for poly, tg, _ in osm.buildings():
        obst_ground.extend(B.polygons(poly.buffer(0.2)))
    for p, _, _ in ctx["water"]:
        obst_ground.extend(B.polygons(p))

    # ---------- отдельные тротуары OSM
    sep_polys, sep_lines = [], []
    for wid, (refs, tg) in osm.ways.items():
        if tg.get("highway") not in ("footway", "path") or tg.get("footway") != "sidewalk":
            continue
        if tg.get("bridge", "no") != "no" or tg.get("tunnel", "no") != "no" or tg.get("layer", "0") not in ("0",):
            continue
        xy = osm.way_xy(wid)
        if len(xy) < 2:
            continue
        w = parse_numbers(tg.get("width"))
        w = float(np.clip(w[0], 1.5, 4.0)) if w else 2.0
        ln = LineString(xy)
        sep_lines.append(ln)
        sep_polys.extend(B.polygons(ln.buffer(w / 2, cap_style="round", join_style="round", quad_segs=2)))
        st["separate_km"] += ln.length / 1000
    sep_near = unary_union(sep_lines).buffer(SEPARATE_NEAR) if sep_lines else None
    if sep_near is not None:
        shapely.prepare(sep_near)

    # ---------- процедурные полосы
    ow_roads = [r for r in roads if r.bwd is None and not r.bridge]
    ow_lines = [LineString(r.axis) for r in ow_roads]
    ow_tree = STRtree(ow_lines)
    bands, bridge_bands = [], []
    j_sw = defaultdict(float)  # перекрёсток -> ширина тротуара у примыкающих дорог
    for r in roads:
        cls = base_class(r.hw)
        if cls not in WIDTH or r.hw.endswith("_link") or r.tunnel:
            continue
        tg = osm.ways.get(r.osm_id, (None, {}))[1] if r.osm_id is not None else {}
        sides = side_tags(tg)
        if r.fwd["id"].startswith("-"):   # ребро против направления пути OSM (oneway=-1)
            sides = {"left": sides["right"], "right": sides["left"]}
        sw = WIDTH[cls]
        f0 = r.fwd["lanes"][0]
        specs = [("right", f0["shape"], -f0["width"] / 2, -1)]
        if r.bwd is not None:
            b0 = r.bwd["lanes"][0]
            specs.append(("left", b0["shape"], -b0["width"] / 2, -1))
        else:
            fl = r.fwd["lanes"][-1]
            specs.append(("left", fl["shape"], fl["width"] / 2, 1))
        for side, shape, d, sigma in specs:
            tag = sides[side]
            if tag in ("no", "separate"):
                continue
            if r.bridge and tag != "yes":
                continue
            edge = offset(resample(shape, 2.0), d)
            # направление «по ходу» ребра: для правой стороны sigma=-1 вдоль fwd; для левой двусторонней — вдоль bwd
            for poly, mid, m, t in band_chunks(edge, sigma, sw):
                if tag is None and sep_near is not None and mid.length > 0 and \
                        mid.intersection(sep_near).length > 0.5 * mid.length:
                    st["skipped_near_separate"] += 1
                    continue
                if tag is None and r.bwd is None and side == "left" and is_median(m, t, sigma, r, ow_tree, ow_lines, ow_roads):
                    st["skipped_median"] += 1
                    continue
                (bridge_bands if r.bridge else bands).append((poly, r))
                st["procedural_km"] += mid.length / 1000
            if not r.bridge:
                for j in (r.frm, r.to):
                    j_sw[j] = max(j_sw[j], sw)

    # угловые скругления вокруг площадок
    corners = []
    for j, w in j_sw.items():
        if j in pads:
            p = pads[j]
            corners.extend(B.polygons(p.buffer(w, quad_segs=3).difference(p)))

    # переходы: зоны опускания бордюра
    cores = [crossing_rect(c, 0.0, 4.0) for c in crossings]
    ramps = [crossing_rect(c, RAMP, 4.0) for c in crossings]

    band_geoms = [p for p, _ in bands] + sep_polys
    t_band = STRtree(band_geoms) if band_geoms else None
    t_corner = STRtree(corners) if corners else None
    t_obst = STRtree(obst_ground)
    t_obst_b = STRtree(obst_bridge) if obst_bridge else None
    t_core = STRtree(cores) if cores else None

    def query(tree, geoms, g):
        return [geoms[i] for i in tree.query(g)] if tree is not None else []

    xs = sorted({k[0] for k in tiles}); zs = sorted({k[1] for k in tiles})
    n_tris = 0
    for ix in xs:
        for iz in zs:
            tb = box(ix * TILE, -(iz + 1) * TILE, (ix + 1) * TILE, -iz * TILE)
            bl = query(t_band, band_geoms, tb)
            if not bl:
                continue
            obs = unary_union(query(t_obst, obst_ground, tb))
            Bt = unary_union(bl).intersection(tb).difference(obs)
            cl = query(t_corner, corners, tb)
            if cl:
                Ct = unary_union(cl).intersection(tb).difference(obs)
                touch = Bt.buffer(0.05)
                keep = [g for g in B.polygons(Ct) if g.intersects(touch)]
                if keep:
                    Bt = unary_union([Bt] + keep)
            # убрать узкие щели и обрезки
            Bt = Bt.buffer(-0.25, join_style="mitre").buffer(0.25, join_style="mitre").intersection(tb)
            polys = [p for p in B.polygons(Bt) if p.area > 2.0]
            if not polys:
                continue
            R = unary_union(polys)
            ctx.setdefault("sidewalk_footprints", {})[(ix, iz)] = R   # для world/yards.py (площадки и пропсы)
            ci = t_core.query(tb.buffer(10)) if t_core is not None else []
            core_u = unary_union([cores[i] for i in ci]) if len(ci) else None
            ramp_u = unary_union([ramps[i] for i in ci]) if len(ci) else None
            n_tris += emit(R, core_u, ramp_u, tb, tiles[(ix, iz)][NODE], st, ground, terr, grid)
            st["area_m2"] += R.area

    # тротуары на мостах (только по явному тегу)
    for poly, r in bridge_bands:
        obs = unary_union(query(t_obst_b, obst_bridge, poly)) if t_obst_b is not None else None
        g = poly.difference(obs) if obs is not None else poly
        for p in B.polygons(g):
            if p.area < 1.0:
                continue
            c = p.centroid
            n_tris += emit(p, None, None, None, tiles[ctx["tile_key"](c.x, c.y)][NODE], st, ground_bridge, ground_bridge, grid)
            st["area_m2"] += p.area
            st["bridge_pieces"] += 1
    st["triangles"] = n_tris
    return {k: (round(v, 1) if isinstance(v, float) else v) for k, v in st.items()}


def emit(R, core_u, ramp_u, tb, node, st, ground, terrain, grid):
    """Верх тротуара (материал sidewalk, по треугольникам heightmap) + вертикальные грани по контуру R (материал curb).
    ground(XY) — опорная высота (верх = ground + TOP), terrain(XY) — рельеф (низ граней не выше него)."""
    R = R.simplify(0.15)
    if core_u is not None and ramp_u is not None and R.intersects(ramp_u):
        pieces = [R.intersection(core_u), R.intersection(ramp_u).difference(core_u), R.difference(ramp_u)]
        st["lowered_zones"] += len([1 for g in B.polygons(pieces[0]) if g.area > 0.5])
    else:
        pieces = [R]
        core_u = None

    def top(XY):
        y = ground(XY) + TOP
        if core_u is not None:
            d = shapely.distance(core_u, shapely.points(XY))
            f = np.clip(1 - d / RAMP, 0, 1)
            y = y - (TOP - TOP_LOWERED) * f
        return y

    bnd = R.boundary
    shapely.prepare(bnd)
    n_tris = 0
    tbx = tb.bounds if tb is not None else None
    for piece in pieces:
        for p in B.polygons(piece):
            if p.area < 0.05:
                continue
            p = orient(p, 1.0)
            V2, T = drape(p, grid)
            if V2 is None:
                continue
            y = top(V2)
            P = np.c_[V2[:, 0], y, -V2[:, 1]]
            T = fix_winding(P, T, np.array([0, 1.0, 0]))
            node["sidewalk"].add(P, T, smooth_normals(P, T), np.c_[P[:, 0], P[:, 2]])
            n_tris += len(T)
            # грани по контуру
            for ring in [p.exterior] + list(p.interiors):
                C = densify_ring(np.asarray(ring.coords), grid)
                a, b = C[:-1], C[1:]
                d = b - a
                ln = np.hypot(*d.T)
                m = ln > 1e-4
                mid = (a + b) / 2
                m &= shapely.distance(bnd, shapely.points(mid)) < 1e-3    # не внутренние разрезы зон
                if tbx is not None:
                    x0, y0, x1, y1 = tbx
                    on_tile = ((np.abs(a[:, 0] - x0) < 1e-6) & (np.abs(b[:, 0] - x0) < 1e-6)) | \
                              ((np.abs(a[:, 0] - x1) < 1e-6) & (np.abs(b[:, 0] - x1) < 1e-6)) | \
                              ((np.abs(a[:, 1] - y0) < 1e-6) & (np.abs(b[:, 1] - y0) < 1e-6)) | \
                              ((np.abs(a[:, 1] - y1) < 1e-6) & (np.abs(b[:, 1] - y1) < 1e-6))
                    m &= ~on_tile
                if not m.any():
                    continue
                # прореживание: точки уплотнения, где верх и низ грани линейны (±1 см), не нужны
                tp = top(C); gg = np.minimum(tp - TOP, terrain(C)) + BOTTOM
                keep = np.ones(len(C), bool)
                orig = np.zeros(len(C), bool)
                orig[[0, -1]] = True
                Cr = np.asarray(ring.coords)
                orig |= (np.abs(C[:, None, :] - Cr[None, :, :]).sum(-1) < 1e-6).any(1) if len(C) * len(Cr) < 4e6 else False
                for par in (1, 0, 1, 0):
                    idx = np.nonzero(keep)[0]
                    if len(idx) < 3:
                        break
                    i0, i1, i2 = idx[:-2], idx[1:-1], idx[2:]
                    L01 = np.hypot(*(C[i1] - C[i0]).T); L02 = np.hypot(*(C[i2] - C[i0]).T)
                    t_ = L01 / np.maximum(L02, 1e-9)
                    lin = (np.abs(tp[i0] + (tp[i2] - tp[i0]) * t_ - tp[i1]) < 0.01) & \
                          (np.abs(gg[i0] + (gg[i2] - gg[i0]) * t_ - gg[i1]) < 0.01)
                    cand = lin & ~orig[i1] & m[i0] & m[i1] & m[i2 - 1] & (np.arange(len(i1)) % 2 == par)
                    keep[i1[cand]] = False
                ki = np.nonzero(keep)[0]
                m = np.array([m[a_:b_].all() for a_, b_ in zip(ki[:-1], ki[1:])])
                C = C[ki]
                d = np.diff(C, axis=0); ln = np.hypot(*d.T)
                if not m.any():
                    continue
                # общие вершины по кольцу: низ/верх в каждой точке контура (сглаженная наружная нормаль)
                k = len(C)
                tp = top(C)
                g = np.minimum(tp - TOP, terrain(C)) + BOTTOM
                en = np.c_[d[:, 1], -d[:, 0]] / np.maximum(ln, 1e-9)[:, None]   # наружу (справа от обхода)
                vn = np.zeros((k, 2)); vn[:-1] += en; vn[1:] += en
                vn[0] += en[-1]; vn[-1] += en[0]                                 # кольцо замкнуто
                vn /= np.maximum(np.hypot(*vn.T), 1e-9)[:, None]
                P = np.empty((2 * k, 3))
                P[0::2] = np.c_[C[:, 0], g, -C[:, 1]]
                P[1::2] = np.c_[C[:, 0], tp, -C[:, 1]]
                N3 = np.repeat(np.c_[vn[:, 0], np.zeros(k), -vn[:, 1]], 2, axis=0)
                u = np.r_[0, np.cumsum(ln)]
                UV = np.empty((2 * k, 2)); UV[0::2] = np.c_[u, np.zeros(k)]; UV[1::2] = np.c_[u, tp - g]
                q = 2 * np.nonzero(m)[0][:, None]
                T = np.c_[q, q + 2, q + 3, q, q + 3, q + 1].reshape(-1, 3)
                fn = np.repeat(np.c_[en[m, 0], np.zeros(int(m.sum())), -en[m, 1]], 2, axis=0)
                tri_n = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
                flip = (tri_n * fn).sum(1) < 0
                T[flip] = T[flip][:, [0, 2, 1]]
                node["curb"].add(P, T, N3, UV)
                n_tris += len(T)
                ln = ln[m]
                st["curb_km"] += float(ln.sum()) / 1000
    return n_tris
