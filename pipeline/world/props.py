"""Расстановка пропсов-инстансов: деревья, фонари, светофоры, остановки, машины, дворовая мебель, ограды.

Порядок важен: сначала «жёсткие» объекты (светофоры, остановки, фонари, машины, площадки), каждый помечает
занятое место в растре (бит PROP); деревья и кусты ставятся последними в оставшееся свободное место.
Все случайности — через ctx.rng(ключ) с детерминированным ключом (тайл или id объекта), сборка воспроизводима.
"""
import math
from collections import defaultdict

import numpy as np
import shapely
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

from . import buildings as B
from .roads import base_class, cumlen, highway_class, offset, resample
from .yards import (APT40, AREA, BLD, CEMETERY, CORR, GRASS, GROUNDS, HARD, INDUSTRIAL, JUNC, NEAR_BLD, PARK, PARKING, PATH,
                    PROP, ROAD, ROAD_LIFT, SCRUB, TILE, URBAN, WALLRING, WATER, WOOD, YARD, rot_of)

# номинальные размеры моделей (для игры; scale множит их)
TREE_TYPES = ["tree_birch", "tree_poplar", "tree_maple", "tree_lime", "tree_pine"]

LAMP_SPACING = {"primary": 30.0, "secondary": 32.0, "tertiary": 33.0, "unclassified": 35.0, "residential": 35.0,
                "living_street": 30.0}
LAMP_BOTH = {"primary", "secondary"}
STREET_TREE_CLASSES = {"primary", "secondary", "tertiary"}

F_POLE = BLD | WATER | ROAD | PROP
F_FURN = BLD | WATER | ROAD | CORR | PROP
F_TREE = BLD | NEAR_BLD | WATER | ROAD | CORR | PARKING | HARD | PATH | PROP


def _sides(r):
    """[(знак, расстояние от оси до кромки)]: знак +1 = левая сторона (offset > 0), −1 = правая."""
    if r.bwd is not None:
        return [(-1, r.Wf), (+1, r.Wb)]
    return [(-1, r.Wf / 2), (+1, r.Wf / 2)]


def _along(P, step, start, end_margin):
    """Точки и единичные касательные вдоль ломаной через step, начиная с start."""
    s = cumlen(P)
    if s[-1] < start + end_margin:
        return np.zeros((0, 2)), np.zeros((0, 2)), np.zeros(0)
    d = np.arange(start, s[-1] - end_margin + 1e-6, step)
    i = np.clip(np.searchsorted(s, d, side="right") - 1, 0, len(P) - 2)
    seg = P[i + 1] - P[i]
    L = np.hypot(*seg.T); L[L == 0] = 1
    t = (d - s[i]) / L
    pts = P[i] + seg * t[:, None]
    return pts, seg / L[:, None], d


def _outer(ctx, pts, nrm, start, maxd=9.0, step=0.25):
    """Расстояние (от pts вдоль нрм. nrm) до первой точки вне коридора дороги+тротуара (бит CORR), начиная со start.
    Если в пределах maxd коридор не кончается — nan."""
    out = np.full(len(pts), np.nan)
    todo = np.ones(len(pts), bool)
    for d in np.arange(start, start + maxd + 1e-6, step):
        q = pts + nrm * d
        f = todo & ((ctx.m(q[:, 0], q[:, 1]) & CORR) == 0)
        out[f] = d
        todo &= ~f
        if not todo.any():
            break
    return out


def _pick(rng, n, table):
    names = [k for k, _ in table]
    p = np.array([v for _, v in table], np.float64); p /= p.sum()
    return np.array(names)[rng.choice(len(names), size=n, p=p)]


# =====================================================================================
def traffic_lights(ctx):
    inc = defaultdict(list)
    for e in ctx.net.edges.values():
        inc[e["to"]].append(e)
    n = 0
    for jid, J in ctx.net.junctions.items():
        if not (J.get("type") or "").startswith("traffic_light"):
            continue
        for e in inc[jid]:
            if base_class(highway_class(e["type"])) == "service":
                continue
            l0 = e["lanes"][0]
            S = l0["shape"]
            if len(S) < 2:
                continue
            d = S[-1] - S[-2]
            L = math.hypot(*d)
            if L < 1e-6:
                continue
            t = d / L
            right = np.array([t[1], -t[0]])
            for extra in (0.8, 1.6, 2.5):
                p = S[-1] + right * (l0["width"] / 2 + extra) - t * 1.0
                if ctx.free(p[0:1], p[1:2], BLD | WATER | ROAD | PROP)[0]:
                    break
            else:
                continue
            ctx.add("traffic_light", p[0], p[1], float(rot_of(-t[0], -t[1])), 1.0, lanes=len(e["lanes"]))
            ctx.stamp(p[0], p[1], 0.8)
            n += 1
    return n


def _road_tree(ctx, classes=None):
    rs = [r for r in ctx.roads if len(r.axis) >= 2 and not r.tunnel and (classes is None or base_class(r.hw) in classes)]
    return rs, shapely.STRtree([LineString(r.axis) for r in rs])


def bus_stops(ctx):
    rs, tree = _road_tree(ctx, {"primary", "secondary", "tertiary", "unclassified", "residential", "living_street"})
    pts = ctx.points.of("public_transport=platform") + ctx.points.of("highway=bus_stop")
    cands = []
    for x, y, tg in pts:
        if not ctx.inside(x, y, 10):
            continue
        idx = tree.query_nearest(Point(x, y), max_distance=30.0)
        if len(idx) == 0:
            continue
        r = rs[int(idx[0])]
        if r.bridge:
            continue
        ln = LineString(r.axis)
        s = ln.project(Point(x, y))
        a = np.array(ln.interpolate(max(s - 1, 0)).coords[0]); b = np.array(ln.interpolate(min(s + 1, ln.length)).coords[0])
        t = b - a; t /= (np.linalg.norm(t) or 1)
        p0 = np.array(ln.interpolate(s).coords[0])
        nl = np.array([-t[1], t[0]])
        side = 1 if np.dot(np.array([x, y]) - p0, nl) >= 0 else -1
        edge = dict(_sides(r))[side]
        cands.append((p0, t, nl * side, edge))
    acc = []
    for p0, t, n, edge in cands:
        dd = _outer(ctx, (p0 + n * edge)[None], n[None], 0.35)[0]
        base_off = (dd + 1.2) if not np.isnan(dd) else 2.5
        for off in (base_off, base_off + 0.8, base_off + 1.6):
            p = p0 + n * (edge + off)
            if any(np.hypot(*(p - q)) < 15 for q in acc):
                p = None
                break
            if ctx.free(p[0:1], p[1:2], BLD | WATER | ROAD | PROP, 1.0)[0]:
                break
        else:
            p = None
        if p is None:
            continue
        acc.append(p)
        ctx.add("bus_stop", p[0], p[1], float(rot_of(-n[0], -n[1])), 1.0)
        ctx.stamp(p[0], p[1], 2.0)
        q = p + t * 2.6
        if ctx.free(q[0:1], q[1:2], BLD | WATER | ROAD | PROP)[0]:
            ctx.add("trash_bin", q[0], q[1], float(rot_of(-n[0], -n[1])), 1.0)
            ctx.stamp(q[0], q[1], 0.5)
    return len(acc)


def street_lamps(ctx):
    n = 0
    for r in ctx.roads:
        cls = base_class(r.hw)
        if cls not in LAMP_SPACING or r.tunnel or len(r.axis) < 2:
            continue
        step = LAMP_SPACING[cls]
        sides = _sides(r)
        if cls not in LAMP_BOTH:
            sides = [sides[r.id % 2]]
        L = cumlen(r.axis)[-1]
        for sg, edge in sides:
            line = offset(resample(r.axis, 4.0), sg * (edge if not r.bridge else edge + 0.7))
            pts, tan, d = _along(line, step, step / 2 if sg < 0 else step / 4, 3.0)
            if len(pts) == 0:
                continue
            if not r.bridge:
                # от кромки наружу до конца тротуара (+0.4 м); без тротуара — кромка + 0.75 м
                nout = sg * np.c_[-tan[:, 1], tan[:, 0]]
                dd = _outer(ctx, pts, nout, 0.35)
                good = ~np.isnan(dd)
                pts, tan, d = pts[good] + nout[good] * (dd[good, None] + 0.4), tan[good], d[good]
                if len(pts) == 0:
                    continue
            m = ctx.m(pts[:, 0], pts[:, 1])
            ok = (m & (BLD | ROAD | PROP | JUNC)) == 0
            if not r.bridge:
                ok &= (m & WATER) == 0
                yv = ctx.ground(pts[:, 0], pts[:, 1])
            else:
                fr = d / max(cumlen(line)[-1], 1e-6)
                try:
                    from .bridges import surface
                    yv = surface(r, fr * r.s_axis[-1], pts[:, 0], pts[:, 1], ctx.H, ctx.grid, ctx.base, ROAD_LIFT)
                except (ImportError, AttributeError):
                    yv = np.interp(fr * r.s_axis[-1], r.s_axis, r.z_axis) - ctx.base + ROAD_LIFT
            ok &= ctx.inside(pts[:, 0], pts[:, 1], 3)
            toward = -sg * np.c_[-tan[:, 1], tan[:, 0]]   # от фонаря к дороге
            for k in np.nonzero(ok)[0]:
                x, y = pts[k]
                ctx.add("street_lamp", x, y, float(rot_of(*toward[k])), 1.0, yv=float(yv[k]))
                ctx.stamp(x, y, 0.6)
                n += 1
    return n


# =====================================================================================
def _local_union(tree, geoms, region):
    idx = tree.query(region, predicate="intersects")
    return unary_union([geoms[i] for i in idx]) if len(idx) else None


def _rects(cx, cy, ux, uy, hu, hv):
    """Прямоугольники с центрами (cx, cy), осью u = (ux, uy) и полуразмерами hu (вдоль u) и hv (поперёк)."""
    vx, vy = -uy, ux
    pts = [np.stack([cx + a * hu * ux + b * hv * vx, cy + a * hu * uy + b * hv * vy], axis=-1)
           for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1), (-1, -1))]
    return shapely.polygons(np.stack(pts, axis=1))


def _stalls_from_aisles(free, aisles):
    """Места перпендикулярно проездам parking_aisle, по обе стороны: центр в 5.5 м от оси проезда."""
    X, Y, HX, HY = [], [], [], []
    for ln in aisles:
        for part in getattr(ln, "geoms", [ln]):
            if part.geom_type != "LineString" or part.length < 3:
                continue
            P = resample(np.asarray(part.coords), 1.0)
            pts, tan, _ = _along(P, 2.5, 1.25, 1.0)
            if len(pts) == 0:
                continue
            nrm = np.c_[-tan[:, 1], tan[:, 0]]
            for sg in (1, -1):
                c = pts + sg * nrm * 5.5
                X.append(c[:, 0]); Y.append(c[:, 1]); HX.append(sg * nrm[:, 0]); HY.append(sg * nrm[:, 1])
    if not X:
        return np.zeros((0, 4))
    X, Y, HX, HY = map(np.concatenate, (X, Y, HX, HY))
    ok = shapely.contains(free, _rects(X, Y, HX, HY, 2.35, 1.15))
    S = np.c_[X, Y, HX, HY][ok]
    # убираем наложения (повороты проездов, соседние проезды)
    keep = []
    if len(S):
        kd = cKDTree(S[:, :2]); taken = np.zeros(len(S), bool)
        for i in range(len(S)):
            if taken[i]:
                continue
            keep.append(i)
            taken[kd.query_ball_point(S[i, :2], 2.3)] = True
    return S[keep]


def _stalls_from_pattern(poly, free, ang):
    """Регулярная разметка: ряды перпендикулярных мест через проезд 6.5 м или параллельные места (узкие карманы)."""
    c, s = math.cos(ang), math.sin(ang)
    cx, cy = poly.centroid.x, poly.centroid.y
    P = shapely.get_coordinates(poly) - [cx, cy]
    U = P @ [c, s]; V = P @ [-s, c]
    best = None
    patterns = [("perp", 2.5, 5.0, 16.5, (2.5, 14.0), (-1, 1)), ("par", 6.0, 2.4, 8.5, (1.2, 7.3), (0, 0))]
    for name, du, dv, mod, rows, face in patterns:
        for v0 in np.arange(0, mod, 1.0):
            for u0 in (0.0, du / 2):
                vs, fs = [], []
                k0 = math.floor((V.min() - v0) / mod) - 1
                for k in range(k0, k0 + int((V.max() - V.min()) / mod) + 3):
                    for rv, f in zip(rows, face):
                        vs.append(v0 + k * mod + rv); fs.append(f)
                us = np.arange(math.floor((U.min() - u0) / du) * du + u0 + du / 2, U.max(), du)
                if len(us) == 0:
                    continue
                UU, VV = np.meshgrid(us, vs); FF = np.meshgrid(us, fs)[1]
                UU, VV, FF = UU.ravel(), VV.ravel(), FF.ravel()
                X = cx + UU * c - VV * s; Y = cy + UU * s + VV * c
                okm = shapely.contains(free, _rects(X, Y, c, s, du / 2 - 0.1, dv / 2 - 0.1))
                cnt = int(okm.sum())
                if best is None or cnt > best[0]:
                    if name == "perp":
                        H = np.c_[-s * FF[okm], c * FF[okm]]      # «носом от проезда»
                    else:
                        H = np.tile([c, s], (cnt, 1))              # вдоль кармана
                    best = (cnt, name, np.c_[X[okm], Y[okm], H])
    return best


def parking_cars(ctx, g):
    blds = [p for p, _, _ in g["buildings"]]
    obst = blds + ctx.corr + [j.buffer(1.0) for j in ctx.junc] + ctx.water + g["playground"] + g["pitch"]
    otree = shapely.STRtree(obst)
    ab = [a.buffer(3.0, cap_style="flat") for a in g["aisles"]]
    atree = shapely.STRtree(g["aisles"]) if g["aisles"] else None
    n_cars = n_stalls = 0
    for pi, (poly, tg) in enumerate(g["parking"]):
        if poly.area < 25:
            continue
        free = poly.buffer(-0.3)
        o = _local_union(otree, obst, poly)
        if o is not None:
            free = free.difference(o)
        ai = atree.query(poly, predicate="intersects") if atree is not None else []
        if len(ai):
            free = free.difference(unary_union([ab[i] for i in ai]))
        if free.is_empty or free.area < 10:
            continue
        shapely.prepare(free)
        aisles = [g["aisles"][i].intersection(poly.buffer(3.0)) for i in ai]
        A = _stalls_from_aisles(free, aisles) if aisles else np.zeros((0, 4))
        # ось рядов для регулярной разметки: самый длинный проезд или длинная сторона MRR
        ang = None
        if aisles:
            segs = [np.asarray(gm.coords) for a in aisles for gm in getattr(a, "geoms", [a]) if gm.geom_type == "LineString"]
            if segs:
                cc = max(segs, key=lambda q: np.hypot(*(q[-1] - q[0])))
                ang = math.atan2(*(cc[-1] - cc[0])[::-1])
        if ang is None:
            mrr = np.asarray(poly.minimum_rotated_rectangle.exterior.coords)
            e1, e2 = mrr[1] - mrr[0], mrr[2] - mrr[1]
            e = e1 if np.hypot(*e1) >= np.hypot(*e2) else e2
            ang = math.atan2(e[1], e[0])
        best = _stalls_from_pattern(poly, free, ang)
        name = "perp"
        if best is not None and best[0] > len(A) * 1.3:
            _, name, S = best
        else:
            S = A
        if len(S) == 0:
            continue
        rng = ctx.rng(31, pi)
        occ = 0.8 if tg.get("parking") in ("street_side", "lane") else 0.72
        n_stalls += len(S)
        for x, y, hx, hy in S:
            if rng.random() > occ:
                continue
            x += rng.normal(0, 0.1); y += rng.normal(0, 0.1)
            if name == "par":
                if rng.random() < 0.5:
                    hx, hy = -hx, -hy
            elif rng.random() > 0.75:      # 25% заехали задом
                hx, hy = -hx, -hy
            a = math.atan2(hy, hx) + rng.normal(0, 0.03)
            hx, hy = math.cos(a), math.sin(a)
            ctx.add("parked_car", x, y, float(rot_of(hx, hy)), 1.0, seed=int(rng.integers(0, 65536)))
            for q in (-1.6, 0, 1.6):
                ctx.stamp(x + hx * q, y + hy * q, 1.0)
            n_cars += 1
    return n_cars, n_stalls


def yard_cars(ctx, occ=0.45, step=6.2):
    """Машины вдоль внутридворовых проездов (service/living_street рядом с многоэтажками), параллельно проезду."""
    n = 0
    for r in ctx.roads:
        if base_class(r.hw) not in ("service", "living_street") or r.bridge or r.tunnel or len(r.axis) < 2:
            continue
        rng = ctx.rng(41, r.id)
        for sg, edge in _sides(r):
            line = offset(resample(r.axis, 2.0), sg * (edge + 1.15))
            pts, tan, d = _along(line, step, 8.0 + rng.random() * 2, 8.0)
            if len(pts) == 0:
                continue
            bad = BLD | WATER | ROAD | HARD | PROP | PARKING | JUNC
            ok = ((ctx.m(pts[:, 0], pts[:, 1]) & APT40) != 0)
            for q in (-2.2, 0.0, 2.2):
                qx = pts[:, 0] + tan[:, 0] * q; qy = pts[:, 1] + tan[:, 1] * q
                ok &= (ctx.m(qx, qy) & bad) == 0
                # и не на чужом тротуаре (у service коридор узкий, CORR = чужие дороги)
                ok &= (ctx.m(qx, qy) & CORR) == 0
            ok &= rng.random(len(pts)) < occ
            for k in np.nonzero(ok)[0]:
                x, y = pts[k] + rng.normal(0, 0.1, 2)
                h = tan[k] * (1 if sg < 0 else -1)
                if rng.random() < 0.2:
                    h = -h
                ctx.add("parked_car", x, y, float(rot_of(*h)) + rng.normal(0, 0.04), 1.0,
                        seed=int(rng.integers(0, 65536)))
                for q in (-1.6, 0, 1.6):
                    ctx.stamp(x + h[0] * q, y + h[1] * q, 1.0)
                n += 1
    return n


# =====================================================================================
def playgrounds(ctx, g, extra):
    polys = [(p, None) for p in g["playground"]] + list(extra)
    n_sets = n_b = 0
    for i, (poly, ang) in enumerate(polys):
        rng = ctx.rng(51, i)
        parts = B.polygons(poly)
        if not parts:
            continue
        poly = max(parts, key=lambda q: q.area)
        inner = poly.buffer(-2.0)
        if inner.is_empty:
            inner = poly.buffer(-0.5)
            if inner.is_empty:
                continue
        k = int(np.clip(round(poly.area / 90.0), 1, 5))
        x0, y0, x1, y1 = inner.bounds
        cand = np.c_[rng.uniform(x0, x1, 60), rng.uniform(y0, y1, 60)]
        cand = cand[shapely.contains_xy(inner, cand[:, 0], cand[:, 1])]
        cand = cand[ctx.free(cand[:, 0], cand[:, 1], BLD | ROAD | WATER | PROP)] if len(cand) else cand
        chosen = []
        for p in cand:
            if all(np.hypot(*(p - q)) >= 5.5 for q in chosen):
                chosen.append(p)
            if len(chosen) >= k:
                break
        for p in chosen:
            rot = (ang if ang is not None else rng.uniform(-math.pi, math.pi)) + rng.integers(0, 4) * math.pi / 2
            ctx.add("playground_set", p[0], p[1], float(rot), 1.0, variant=int(rng.integers(0, 8)))
            ctx.stamp(p[0], p[1], 2.5)
            n_sets += 1
        # лавочки по краю, лицом внутрь
        ring = poly.exterior
        nb = int(np.clip(round(ring.length / 25), 2, 6))
        cxy = np.array(poly.centroid.coords[0])
        for j in range(nb):
            q = np.array(ring.interpolate((j + rng.random() * 0.5) / nb, normalized=True).coords[0])
            dirc = cxy - q; dl = np.linalg.norm(dirc)
            if dl < 1:
                continue
            q = q + dirc / dl * 1.0
            if not ctx.free(q[0:1], q[1:2], BLD | ROAD | WATER | PROP, 0.8)[0]:
                continue
            ctx.add("bench", q[0], q[1], float(rot_of(*dirc)), 1.0)
            ctx.stamp(q[0], q[1], 1.0)
            n_b += 1
    for j, (x, y, tg) in enumerate(ctx.points.of("leisure=playground")):
        if ctx.inside(x, y, 5) and ctx.free([x], [y], BLD | ROAD | WATER | PROP, 2.0)[0]:
            ctx.add("playground_set", x, y, float(ctx.rng(52, j).uniform(-math.pi, math.pi)), 1.0, variant=j % 8)
            ctx.stamp(x, y, 2.5)
            n_sets += 1
    return n_sets, n_b


def _nearest_road_dir(rs, tree, x, y, maxd=40.0):
    idx = tree.query_nearest(Point(x, y), max_distance=maxd)
    if len(idx) == 0:
        return None
    ln = LineString(rs[int(idx[0])].axis)
    p = np.array(ln.interpolate(ln.project(Point(x, y))).coords[0])
    d = p - [x, y]
    L = np.linalg.norm(d)
    return d / L if L > 1e-6 else None


def container_sites(ctx, g, spacing=85.0):
    rs, tree = _road_tree(ctx)
    acc = []
    # из OSM
    for j, (x, y, tg) in enumerate(ctx.points.of("amenity=waste_disposal", "amenity=recycling")):
        if not ctx.inside(x, y, 5) or not ctx.free([x], [y], BLD | ROAD | WATER | PROP, 1.0)[0]:
            continue
        d = _nearest_road_dir(rs, tree, x, y)
        rot = float(rot_of(*d)) if d is not None else 0.0
        ctx.add("container_site", x, y, rot, 1.0)
        ctx.stamp(x, y, 2.2)
        acc.append((x, y))
    n_osm = len(acc)
    # процедурные: вдоль дворовых проездов, 15–45 м от многоэтажки
    apts = [p for p, c, _ in g["buildings"] if c == "apartments"]
    atree = shapely.STRtree(apts)
    C, T, Rd = [], [], []
    for r in ctx.roads:
        if base_class(r.hw) not in ("service", "living_street") or r.bridge or r.tunnel or len(r.axis) < 2:
            continue
        for sg, edge in _sides(r):
            line = offset(resample(r.axis, 2.0), sg * (edge + 2.2))
            pts, tan, _ = _along(line, 8.0, 6.0, 6.0)
            if len(pts):
                C.append(pts); T.append(-sg * np.c_[-tan[:, 1], tan[:, 0]]); Rd.append(np.full(len(pts), r.id))
    if not C:
        return n_osm, 0
    C = np.concatenate(C); T = np.concatenate(T); Rd = np.concatenate(Rd)
    ok = ((ctx.m(C[:, 0], C[:, 1]) & APT40) != 0) & ctx.free(C[:, 0], C[:, 1], BLD | NEAR_BLD | ROAD | WATER | PROP | HARD | PARKING | CORR, 1.8)
    C, T, Rd = C[ok], T[ok], Rd[ok]
    idx, dist = atree.query_nearest(shapely.points(C[:, 0], C[:, 1]), return_distance=True, all_matches=False)
    dd = np.full(len(C), 1e9); dd[idx[0]] = dist
    ok = (dd >= 10) & (dd <= 50)
    C, T, Rd, dd = C[ok], T[ok], Rd[ok], dd[ok]
    rng = ctx.rng(61, 0)
    order = np.argsort(np.abs(dd - 22) + rng.random(len(C)) * 15, kind="stable")
    grid = defaultdict(list)
    for x, y in acc:
        grid[(int(x // spacing), int(y // spacing))].append((x, y))
    n = 0
    for i in order:
        x, y = C[i]
        gi, gj = int(x // spacing), int(y // spacing)
        if any((px - x) ** 2 + (py - y) ** 2 < spacing ** 2 for a in (-1, 0, 1) for b in (-1, 0, 1)
               for px, py in grid.get((gi + a, gj + b), ())):
            continue
        if not ctx.free([x], [y], PROP, 1.8)[0]:
            continue
        grid[(gi, gj)].append((x, y))
        ctx.add("container_site", x, y, float(rot_of(*T[i])), 1.0)
        ctx.stamp(x, y, 2.2)
        n += 1
    return n_osm, n


def osm_furniture(ctx, g):
    walk = [ln for ln, w, hw in g["walk_lines"]]
    wtree = shapely.STRtree(walk) if walk else None
    nb = nt = 0
    for j, (x, y, tg) in enumerate(ctx.points.of("amenity=bench")):
        if not ctx.inside(x, y, 3) or not ctx.free([x], [y], BLD | ROAD | WATER | PROP)[0]:
            continue
        rot = float(ctx.rng(71, j).uniform(-math.pi, math.pi))
        if wtree is not None:
            idx = wtree.query_nearest(Point(x, y), max_distance=6.0)
            if len(idx):
                ln = walk[int(idx[0])]
                p = np.array(ln.interpolate(ln.project(Point(x, y))).coords[0])
                d = p - [x, y]
                if np.linalg.norm(d) > 0.2:
                    rot = float(rot_of(*d))
        ctx.add("bench", x, y, rot, 1.0)
        ctx.stamp(x, y, 1.0)
        nb += 1
    for j, (x, y, tg) in enumerate(ctx.points.of("amenity=waste_basket")):
        if ctx.inside(x, y, 3) and ctx.free([x], [y], BLD | ROAD | WATER | PROP)[0]:
            ctx.add("trash_bin", x, y, float(ctx.rng(72, j).uniform(-math.pi, math.pi)), 1.0)
            ctx.stamp(x, y, 0.5)
            nt += 1
    return nb, nt


def entrance_benches(ctx, g):
    apts = [p for p, c, _ in g["buildings"] if c in ("apartments", "other")]
    tree = shapely.STRtree(apts)
    nb = nt = 0
    for j, (x, y, tg) in enumerate(ctx.points.of("entrance")):
        if tg.get("entrance") not in ("staircase", "yes", "main", "home"):
            continue
        idx = tree.query_nearest(Point(x, y), max_distance=3.0)
        if len(idx) == 0:
            continue
        b = min(B.polygons(apts[int(idx[0])]), key=lambda q: q.distance(Point(x, y)))
        if b.area < 150:
            continue
        rng = ctx.rng(81, j)
        ring = b.exterior
        s = ring.project(Point(x, y))
        a = np.array(ring.interpolate(s - 0.5).coords[0]); c = np.array(ring.interpolate(s + 0.5).coords[0])
        t = c - a; t /= (np.linalg.norm(t) or 1)
        n = np.array([t[1], -t[0]])
        e = np.array(ring.interpolate(s).coords[0])
        if b.contains(Point(*(e + n * 0.5))):
            n = -n
        if rng.random() < 0.75:
            side = 1 if rng.random() < 0.5 else -1
            q = e + n * 2.2 + t * side * 2.0
            if ctx.free(q[0:1], q[1:2], F_FURN, 0.8)[0]:
                ctx.add("bench", q[0], q[1], float(rot_of(*n)), 1.0)
                ctx.stamp(q[0], q[1], 1.0); nb += 1
            q = e + n * 1.6 - t * side * 1.4
            if rng.random() < 0.6 and ctx.free(q[0:1], q[1:2], F_FURN, 0.3)[0]:
                ctx.add("trash_bin", q[0], q[1], float(rot_of(*n)), 1.0)
                ctx.stamp(q[0], q[1], 0.5); nt += 1
    return nb, nt


def park_benches(ctx, g, step=32.0):
    nb = nt = 0
    for i, (ln, w, hw) in enumerate(g["walk_lines"]):
        if hw not in ("footway", "pedestrian", "path", "cycleway"):
            continue
        rng = ctx.rng(91, i)
        for part in getattr(ln, "geoms", [ln]):
            if part.geom_type != "LineString" or part.length < step:
                continue
            P = resample(np.asarray(part.coords), 2.0)
            pts, tan, _ = _along(P, step, step * (0.3 + 0.4 * rng.random()), 5.0)
            if len(pts) == 0:
                continue
            m = ctx.m(pts[:, 0], pts[:, 1])
            inpark = (m & (PARK | CEMETERY)) != 0
            for k in np.nonzero(inpark)[0]:
                sg = 1 if (k + i) % 2 == 0 else -1
                nrm = sg * np.array([-tan[k, 1], tan[k, 0]])
                q = pts[k] + nrm * (w / 2 + 0.8)
                if not ctx.free(q[0:1], q[1:2], F_FURN, 0.7)[0]:
                    continue
                ctx.add("bench", q[0], q[1], float(rot_of(*-nrm)), 1.0)
                ctx.stamp(q[0], q[1], 1.0); nb += 1
                if rng.random() < 0.5:
                    q2 = q + tan[k] * 1.6
                    if ctx.free(q2[0:1], q2[1:2], F_FURN)[0]:
                        ctx.add("trash_bin", q2[0], q2[1], float(rot_of(*-nrm)), 1.0)
                        ctx.stamp(q2[0], q2[1], 0.5); nt += 1
    return nb, nt


# =====================================================================================
# деревья
SPECIES = {
    "wood": [("tree_pine", 0.42), ("tree_birch", 0.38), ("tree_maple", 0.08), ("tree_lime", 0.07), ("tree_poplar", 0.05)],
    "park": [("tree_lime", 0.28), ("tree_maple", 0.25), ("tree_birch", 0.22), ("tree_poplar", 0.10), ("tree_pine", 0.15)],
    "yard": [("tree_birch", 0.30), ("tree_poplar", 0.24), ("tree_maple", 0.26), ("tree_lime", 0.20)],
    "street": [("tree_lime", 0.36), ("tree_poplar", 0.30), ("tree_maple", 0.24), ("tree_birch", 0.10)],
    "cemetery": [("tree_birch", 0.45), ("tree_lime", 0.25), ("tree_maple", 0.15), ("tree_pine", 0.15)],
    "broad": [("tree_birch", 0.3), ("tree_lime", 0.25), ("tree_maple", 0.25), ("tree_poplar", 0.2)],
}

# (имя, нужен бит, исключить биты, шаг сетки м, вероятность, вес шума, набор пород)
SCATTER = [
    ("wood", WOOD, 0, 6.5, 0.92, 0.5, "wood"),
    ("cemetery", CEMETERY, WOOD, 6.0, 0.8, 0.3, "cemetery"),
    ("park", PARK, WOOD | CEMETERY, 9.0, 0.75, 0.8, "park"),
    ("grounds", GROUNDS, WOOD | PARK | CEMETERY, 10.0, 0.5, 0.6, "broad"),
    ("yard", YARD, WOOD | PARK | CEMETERY | GROUNDS | INDUSTRIAL, 7.5, 0.72, 0.7, "yard"),
    ("lawn", GRASS, WOOD | PARK | CEMETERY | GROUNDS | YARD, 12.0, 0.35, 0.6, "broad"),
    ("scrub", SCRUB, WOOD, 12.0, 0.3, 0.5, "broad"),
    # прочая городская территория (пустыри у домов, кремль, общественные здания) — редко
    ("fill", URBAN, WOOD | PARK | CEMETERY | GROUNDS | YARD | GRASS | SCRUB | INDUSTRIAL, 12.0, 0.33, 0.8, "broad"),
    ("industrial", INDUSTRIAL, WOOD | PARK | CEMETERY | GROUNDS | YARD, 16.0, 0.12, 0.8, "broad"),
]


class Trees:
    def __init__(self, ctx):
        self.ctx = ctx
        self.xy = np.zeros((0, 2))
        self.kd = None

    def filter_far(self, xy, dmin):
        if len(xy) == 0 or len(self.xy) == 0:
            return np.ones(len(xy), bool)
        d, _ = cKDTree(self.xy).query(xy, distance_upper_bound=dmin)
        return d >= dmin

    def add(self, xy, types, scales, rots, src):
        if len(xy) == 0:
            return
        ctx = self.ctx
        yv = ctx.ground(xy[:, 0], xy[:, 1])
        for (x, y), t, s, r, h in zip(xy, types, scales, rots, yv):
            ctx.add(t, x, y, r, s, yv=h)
        self.xy = np.r_[self.xy, xy]
        ctx.stats["trees_" + src] += len(xy)


def jgrid(ctx, ix, iz, s, salt, jitter=0.36):
    rng = ctx.rng(salt, ix, iz)
    k = max(1, int(round(TILE / s)))
    st = TILE / k
    u = (np.arange(k) + 0.5) * st
    X, Y = np.meshgrid(ix * TILE + u, -(iz + 1) * TILE + u)
    X = X.ravel() + rng.uniform(-jitter, jitter, X.size) * st
    Y = Y.ravel() + rng.uniform(-jitter, jitter, Y.size) * st
    return np.c_[X, Y], rng


def place_trees(ctx, g):
    T = Trees(ctx)
    from . import landcover_veg as LV       # карта покрова со спутника (docs/stage3/landcover.md); нет — None
    LCV = LV.load(ctx)
    # 1) OSM: отдельные деревья и аллеи
    xy, ty = [], []
    for j, (x, y, tg) in enumerate(ctx.points.of("natural=tree")):
        if not ctx.inside(x, y, 2) or not ctx.free([x], [y], BLD | WATER | ROAD | PROP)[0]:
            continue
        gen = (tg.get("genus", "") + tg.get("species", "") + tg.get("taxon", "")).lower()
        if tg.get("leaf_type") == "needleleaved" or any(w in gen for w in ("picea", "pinus", "abies", "larix", "thuja")):
            t = "tree_pine"
        elif "betula" in gen: t = "tree_birch"
        elif "populus" in gen: t = "tree_poplar"
        elif "acer" in gen: t = "tree_maple"
        elif "tilia" in gen: t = "tree_lime"
        else: t = str(_pick(ctx.rng(101, j), 1, SPECIES["broad"])[0])
        xy.append((x, y)); ty.append(t)
    if xy:
        rng = ctx.rng(102, 0)
        T.add(np.array(xy), ty, rng.uniform(0.85, 1.15, len(xy)), rng.uniform(-math.pi, math.pi, len(xy)), "osm")
    for j, (ln, tg) in enumerate(g["tree_rows"]):
        rng = ctx.rng(103, j)
        sp = str(_pick(rng, 1, SPECIES["street"])[0])
        for part in getattr(ln, "geoms", [ln]):
            if part.geom_type != "LineString":
                continue
            pts, _, _ = _along(np.asarray(part.coords), 6.0, 2.0, 0.0)
            if len(pts) == 0:
                continue
            ok = ctx.free(pts[:, 0], pts[:, 1], BLD | WATER | ROAD | PROP) & T.filter_far(pts, 3.0)
            pts = pts[ok]
            T.add(pts, [sp] * len(pts), rng.uniform(0.85, 1.15, len(pts)), rng.uniform(-math.pi, math.pi, len(pts)), "row")
    # 2) вдоль магистралей за тротуаром
    for r in ctx.roads:
        if base_class(r.hw) not in STREET_TREE_CLASSES or r.hw.endswith("_link") or r.bridge or r.tunnel or len(r.axis) < 2:
            continue
        rng = ctx.rng(111, r.id)
        for sg, edge in _sides(r):
            line = offset(resample(r.axis, 3.0), sg * edge)
            pts, tan, d = _along(line, 9.0, 4.0, 4.0)
            if len(pts) == 0:
                continue
            nout = sg * np.c_[-tan[:, 1], tan[:, 0]]
            dd = _outer(ctx, pts, nout, 0.35)
            good = ~np.isnan(dd)
            # за внешней кромкой тротуара: +1.5 м, но не ближе 3.5 м к проезжей части
            pts = pts[good] + nout[good] * np.maximum(dd[good] + 1.5, 3.5)[:, None]
            d = d[good]
            if len(pts) == 0:
                continue
            pts = pts + rng.normal(0, 0.3, pts.shape)
            run = (d // 120).astype(int)
            nrun = run.max() + 1
            has = rng.random(nrun) < 0.7
            sp = _pick(rng, nrun, SPECIES["street"])
            m = ctx.m(pts[:, 0], pts[:, 1])
            ok = has[run] & ((m & URBAN) != 0) & ctx.free(pts[:, 0], pts[:, 1], F_TREE, 1.0) & (rng.random(len(pts)) < 0.85)
            if LCV is not None:
                ok &= LCV.allow(pts, 3.0)      # на спутнике у дороги нет кроны — нет и дерева
            ok &= ctx.inside(pts[:, 0], pts[:, 1], 3)
            ok[ok] &= T.filter_far(pts[ok], 4.0)
            k = np.nonzero(ok)[0]
            T.add(pts[k], sp[run[k]], rng.uniform(0.8, 1.2, len(k)), rng.uniform(-math.pi, math.pi, len(k)), "street")
    # 3) площадные: лес, кладбища, парки, территории школ/больниц, дворы, газоны, кустарник
    for name, need, excl, s, keep, nw, sp in SCATTER:
        allxy, alltypes, allsc, allrot = [], [], [], []
        for ix, iz in ctx.tiles():
            pts, rng = jgrid(ctx, ix, iz, s, sum(map(ord, name)))
            m = ctx.m(pts[:, 0], pts[:, 1])
            ok = ((m & need) != 0) & ((m & excl) == 0)
            if not ok.any():
                continue
            pts, m = pts[ok], m[ok]
            ok = ctx.free(pts[:, 0], pts[:, 1], F_TREE, 1.2 if name != "wood" else 0.8)
            nz = ctx.noise_at(pts[:, 0], pts[:, 1])
            p = keep * ((1 - nw) + nw * np.clip((nz - 0.1) / 0.6, 0, 1))
            ok &= rng.random(len(pts)) < p
            if LCV is not None:
                ok &= LCV.allow(pts, 2.0)      # открытая земля на спутнике (газон, луг, огород, грунт) — без деревьев
            pts = pts[ok]
            if len(pts) == 0:
                continue
            allxy.append(pts)
            alltypes.append(_pick(rng, len(pts), SPECIES[sp]))
            allsc.append(rng.uniform(0.75, 1.25, len(pts)))
            allrot.append(rng.uniform(-math.pi, math.pi, len(pts)))
        if not allxy:
            continue
        xy = np.concatenate(allxy); ty = np.concatenate(alltypes); sc = np.concatenate(allsc); ro = np.concatenate(allrot)
        ok = T.filter_far(xy, 3.5)
        T.add(xy[ok], ty[ok], sc[ok], ro[ok], name)
    if LCV is not None:
        # кроны со спутника, где деревьев ещё нет (дворы, овраги, обочины), и заросли клёна ясенелистного
        nc = LCV.add_canopy_trees(T, F_TREE)
        ncl, nng = LCV.thickets(T, BLD | WATER | ROAD | CORR | PARKING | HARD | PATH | PROP, BLD)
        ctx.stats["landcover_trees"] = nc
        ctx.stats["landcover_thickets"] = ncl
        ctx.stats["landcover_negundo"] = nng
    return T


def place_shrubs(ctx, g, T):
    S = np.zeros((0, 2))
    groups = [("wallring", WALLRING, WOOD | PARK, 5.0, 0.22), ("scrub", SCRUB, 0, 3.5, 0.55),
              ("park", PARK, 0, 11.0, 0.22), ("wood", WOOD, 0, 9.0, 0.18), ("yard", YARD, 0, 10.0, 0.15)]
    n = 0
    for name, need, excl, s, keep in groups:
        allxy = []
        for ix, iz in ctx.tiles():
            pts, rng = jgrid(ctx, ix, iz, s, 500 + sum(map(ord, name)))
            m = ctx.m(pts[:, 0], pts[:, 1])
            ok = ((m & need) != 0) & ((m & excl) == 0)
            if not ok.any():
                continue
            pts = pts[ok]
            fb = BLD | WATER | ROAD | CORR | PARKING | HARD | PATH | PROP
            ok = ctx.free(pts[:, 0], pts[:, 1], fb, 0.8) & (rng.random(len(pts)) < keep)
            if ok.any():
                allxy.append(pts[ok])
        if not allxy:
            continue
        xy = np.concatenate(allxy)
        ok = T.filter_far(xy, 2.0)
        if len(S):
            d, _ = cKDTree(S).query(xy, distance_upper_bound=2.0); ok &= d >= 2.0
        xy = xy[ok]
        rng = ctx.rng(120, sum(map(ord, name)))
        ctx.add_many("shrub", xy[:, 0], xy[:, 1], rng.uniform(-math.pi, math.pi, len(xy)), rng.uniform(0.7, 1.3, len(xy)))
        S = np.r_[S, xy]
        n += len(xy)
    return n


# =====================================================================================
FENCE_H = {"fence": 1.8, "wall": 2.2, "city_wall": 3.5, "retaining_wall": 1.2}


def fences(ctx, g, seg_len=4.0):
    ctree = shapely.STRtree(ctx.carr + ctx.junc)
    cgeo = ctx.carr + ctx.junc
    n = 0; hedge = 0
    for j, (ln, tg) in enumerate(g["barriers"]):
        bar = tg["barrier"]
        cut = _local_union(ctree, cgeo, ln.buffer(2.0))
        if cut is not None:
            ln = ln.difference(cut.buffer(0.8, quad_segs=2))
        if ln.is_empty:
            continue
        for part in getattr(ln, "geoms", [ln]):
            if part.geom_type != "LineString" or part.length < 0.5:
                continue
            P = resample(np.asarray(part.coords), seg_len)
            if bar == "hedge":
                pts, _, _ = _along(P, 1.2, 0.6, 0.0)
                rng = ctx.rng(131, j)
                if len(pts):
                    ctx.add_many("shrub", pts[:, 0], pts[:, 1], rng.uniform(-math.pi, math.pi, len(pts)), rng.uniform(0.75, 0.95, len(pts)))
                    hedge += len(pts)
                continue
            typ = "fence" if bar == "fence" else "wall"
            h = _num_h(tg.get("height"), FENCE_H[bar])
            extra = {}
            style = tg.get("fence_type") or tg.get("material") or tg.get("wall")
            if style:
                extra["style"] = style
            for a, b in zip(P[:-1], P[1:]):
                if not (ctx.inside(a[0], a[1], 1) and ctx.inside(b[0], b[1], 1)):
                    continue
                ctx.add_seg(typ, a, b, h, **extra)
                n += 1
    return n, hedge


def _num_h(s, default):
    try:
        v = float(str(s).replace(",", ".").split()[0].rstrip("m"))
        return v if 0.3 <= v <= 15 else default
    except (TypeError, ValueError, IndexError):
        return default


# =====================================================================================
def place_all(ctx, g, extra, log):
    n_tl = traffic_lights(ctx)
    n_bus = bus_stops(ctx)
    n_lamp = street_lamps(ctx)
    log(f"пропсы: светофоров {n_tl}, остановок {n_bus}, фонарей {n_lamp}")
    n_pc, n_stalls = parking_cars(ctx, g)
    n_yc = yard_cars(ctx)
    log(f"пропсы: машин на парковках {n_pc} (мест {n_stalls}), во дворах {n_yc}")
    n_set, n_pb = playgrounds(ctx, g, extra)
    ob, ot = osm_furniture(ctx, g)
    co, cp = container_sites(ctx, g)
    eb, et = entrance_benches(ctx, g)
    pb, pt = park_benches(ctx, g)
    log(f"пропсы: детских комплексов {n_set}, лавок {n_pb + ob + eb + pb}, урн {ot + et + pt}, "
        f"контейнерных площадок {co + cp} (OSM {co})")
    T = place_trees(ctx, g)
    ns = place_shrubs(ctx, g, T)
    nf, nh = fences(ctx, g)
    log(f"пропсы: деревьев {len(T.xy)}, кустов {ns + nh}, сегментов оград {nf}")
    if ctx.stats.get("landcover_trees") is not None:
        log(f"пропсы по покрову: деревьев по кронам {ctx.stats['landcover_trees']}, клумп зарослей {ctx.stats['landcover_thickets']}, "
            f"кленов ясенелистных {ctx.stats['landcover_negundo']}")
