"""Железная дорога (docs/stage2/rail.md, контракт — docs/world-format.md, «Дополнение: железная дорога»).

Два шага, оба вызываются из build_world.py:
1. prepare(): граф путей из OSM (railway=rail/light_rail, включая service=siding/yard/spur/crossover), обрезка по
   границе мира (порталы), продольный профиль головки рельса на всей сети сразу (МНК: следование рельефу +
   штраф за излом профиля, жёсткие точки на переездах, ограничения под путепроводами и над дорогами), затем
   вжатие коридоров в ОКОНЧАТЕЛЬНЫЙ рельеф H — после вжатия дорог (ячейки дорог не трогаем, переезд — это
   совпадение головки рельса с поверхностью дороги), насыпи/выемки с откосами 1:1.5.
2. build(): геометрия в тайлы (нода `railway`: балластная призма, шпалы, рельсы 1520 мм, платформы, навесы;
   нода `railway_colliders`), переезды (связь с рёбрами roads/graph.json и SUMO), опоры контактной сети,
   сигналы, упоры, станции и места остановок -> rail/net.json. Ж/д мосты (плита, опоры, ограждения) строит
   world/structures.py; здесь на настил кладётся балласт и путь по той же формуле высоты.
"""
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import shapely
from scipy import sparse
from scipy.ndimage import gaussian_filter
from scipy.sparse.linalg import spsolve
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union
from shapely.strtree import STRtree

from .gltf import fix_winding, smooth_normals
from .roads import cumlen, left_normals, resample

# ---------------------------------------------------------------- размеры (м)
GAUGE = 1.520            # между внутренними гранями головок
HEAD_W = 0.075           # ширина головки рельса
RAIL_OFF = GAUGE / 2 + HEAD_W / 2
RAIL_H = 0.18            # высота рельса над шпалой
SLEEPER_TOP = 0.18       # верх шпалы ниже головки рельса
SLEEPER_L, SLEEPER_W, SLEEPER_STEP = 2.75, 0.30, 0.55
BALLAST_TOP = 0.21       # верх балласта ниже головки
FORMATION = 0.65         # основная площадка (рельеф) ниже головки
BALLAST_HALF = 1.75      # полуширина верха призмы
BALLAST_SLOPE = 1.5      # откос призмы 1:1.5
PLATFORM_H = 1.10        # высокая платформа над головкой рельса
PLATFORM_EDGE = 1.80     # край платформы от оси пути
CANOPY_H = 3.6           # навес над платформой
MAST_STEP = 60.0         # шаг опор контактной сети
MAST_OFF = 3.1           # опора от оси пути
WIRE_H = 6.0             # контактный провод над головкой
# профиль
SAMPLE = 5.0             # шаг узлов профиля
SMOOTH_L = 320.0         # м: «длина волны» сглаживания профиля
PIN_W = 300.0            # вес жёстких точек (переезды, ограничения)
GRADE_MAIN = 0.012       # предельный уклон главных путей (12 ‰)
GRADE_SIDING = 0.025     # станционные и подъездные пути
RAIL_CLEAR_UNDER = 7.1   # м: от поверхности путепровода до головки рельса (плита 0.8 + провод 6.0 + запас)
ROAD_UNDER_RAIL = 6.3    # как в structures.py: низ ж/д пролёта над дорогой + плита
CROSS_LIFT = 0.06        # головка рельса на переезде над рельефом дороги (дорога лежит на +0.05)

TRACK_SERVICE = {None, "siding", "yard", "spur", "crossover"}


def _is_track(tg):
    return (tg.get("railway") in ("rail", "light_rail") and tg.get("service") in TRACK_SERVICE
            and tg.get("tunnel") in (None, "no") and tg.get("area") != "yes")


def _yes(v):
    return v not in (None, "no", "0", "false")


def _speed(v):
    m = re.match(r"\s*(\d+)", v or "")
    return int(m.group(1)) if m else None


def _smoothstep(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def _r(v, k=2):
    return round(float(v), k)


# ---------------------------------------------------------------- точечные объекты OSM (быстрый проход по тексту)
_NODE_RE = re.compile(r'<node id="(\d+)" lat="([-\d.]+)" lon="([-\d.]+)"[^>]*>(.*?)</node>', re.S)
_TAG_RE = re.compile(r'<tag k="([^"]*)" v="([^"]*)"\s*/>')


def railway_nodes(osm_path):
    """{node id: (lon, lat, tags)} — узлы с тегом railway=* или public_transport (поезда). OsmData их тегов не хранит."""
    text = Path(osm_path).read_text(encoding="utf-8")
    out = {}
    pos = 0
    end = text.find("<way ")          # в OSM-файле узлы идут первыми
    end = len(text) if end < 0 else end
    while True:
        k = text.find('k="railway"', pos, end)
        if k < 0:
            break
        pos = k + 10
        st = text.rfind("<node ", 0, k)
        if st < 0 or text.rfind("<way ", st, k) >= 0 or text.rfind("</node>", st, k) >= 0:
            continue
        m = _NODE_RE.match(text, st)
        if not m or m.end() < k:
            continue
        tg = {a: b.replace("&quot;", '"').replace("&amp;", "&") for a, b in _TAG_RE.findall(m.group(4))}
        out[int(m.group(1))] = (float(m.group(3)), float(m.group(2)), tg)
    return out


# ---------------------------------------------------------------- граф
class Seg:
    __slots__ = ("id", "way", "tg", "P", "a", "b", "bridge", "Q", "s", "var", "z", "L", "usage", "service", "elec",
                 "maxspeed", "dirpref", "ref", "name", "bridge_way")


class RailCtx:
    pass


def build_graph(osm, bounds, log=print):
    """Сегменты путей между узлами-развилками/концами, обрезанные по границе мира (концы на границе — порталы)."""
    min_x, max_x, min_y, max_y = bounds
    m = 1.0
    world = box(min_x + m, min_y + m, max_x - m, max_y - m)
    ways = {wid: (refs, tg) for wid, (refs, tg) in osm.ways.items() if _is_track(tg) and len(refs) >= 2}
    cnt = Counter()
    for refs, _ in ways.values():
        cnt.update(set(int(r) for r in refs))
        cnt[int(refs[0])] += 1; cnt[int(refs[-1])] += 1
    nodes = {}          # key -> {"xy", "ends": [(seg, end)], "kind", "osm"}
    segs = []
    portal_id = [-1]

    def node_at(key, xy, kind="node"):
        n = nodes.get(key)
        if n is None:
            n = nodes[key] = {"xy": np.asarray(xy, float), "ends": [], "kind": kind, "key": key}
        return n

    for wid, (refs, tg) in ways.items():
        idx, ok = osm.node_index(refs)
        if not ok.all():
            keep = ok
            refs, idx = refs[keep], idx[keep]
        if len(refs) < 2:
            continue
        xy = osm.xy[idx]
        if xy[:, 0].max() < min_x or xy[:, 0].min() > max_x or xy[:, 1].max() < min_y or xy[:, 1].min() > max_y:
            continue
        # куски между общими узлами
        cut = [0] + [i for i in range(1, len(refs) - 1) if cnt[int(refs[i])] > 1] + [len(refs) - 1]
        for i0, i1 in zip(cut[:-1], cut[1:]):
            P = xy[i0:i1 + 1]
            ka, kb = int(refs[i0]), int(refs[i1])
            ln = LineString(P)
            if ln.length < 0.5:
                continue
            if world.contains(ln):
                pieces = [(P, ka, kb)]
            else:
                g = ln.intersection(world)
                if g.is_empty:
                    continue
                pieces = []
                for part in getattr(g, "geoms", [g]):
                    if part.geom_type != "LineString" or part.length < 5:
                        continue
                    Q = np.asarray(part.coords)
                    ea = ka if np.hypot(*(Q[0] - P[0])) < 0.01 else None
                    eb = kb if np.hypot(*(Q[-1] - P[-1])) < 0.01 else None
                    pieces.append((Q, ea, eb))
            for Q, ea, eb in pieces:
                sg = Seg()
                sg.id = len(segs); sg.way = int(wid); sg.tg = tg; sg.P = np.asarray(Q, float)
                for end, key in ((0, ea), (1, eb)):
                    if key is None:
                        portal_id[0] -= 1
                        n = node_at(portal_id[0], sg.P[0 if end == 0 else -1], "portal")
                    else:
                        n = node_at(key, sg.P[0 if end == 0 else -1])
                    n["ends"].append((sg.id, end))
                    if end == 0: sg.a = n["key"]
                    else: sg.b = n["key"]
                sg.bridge = _yes(tg.get("bridge"))
                sg.usage = tg.get("usage") or ""
                sg.service = tg.get("service") or ""
                sg.elec = tg.get("electrified") == "contact_line"
                sg.maxspeed = _speed(tg.get("maxspeed"))
                d = tg.get("railway:preferred_direction") or tg.get("designated_direction") or ""
                sg.dirpref = 1 if d == "forward" else -1 if d == "backward" else 0
                sg.ref = tg.get("railway:track_ref") or ""
                sg.name = tg.get("name") or ""
                sg.bridge_way = int(wid) if sg.bridge else None
                segs.append(sg)
    # тип узла: развилка / тупик / проходной
    for n in nodes.values():
        if n["kind"] == "portal":
            continue
        k = len(n["ends"])
        n["kind"] = "end" if k == 1 else "pass" if k == 2 else "switch"
    log(f"ж/д: путей OSM {len(ways)}, сегментов {len(segs)}, узлов {len(nodes)} "
        f"(стрелок {sum(n['kind'] == 'switch' for n in nodes.values())}, порталов {sum(n['kind'] == 'portal' for n in nodes.values())}, "
        f"тупиков {sum(n['kind'] == 'end' for n in nodes.values())}), длина {sum(LineString(s.P).length for s in segs) / 1000:.1f} км")
    return segs, nodes


def _end_dir(sg, end, reach=12.0):
    """Единичное направление от узла внутрь сегмента."""
    P = sg.P if end == 0 else sg.P[::-1]
    s = cumlen(P)
    j = int(np.clip(np.searchsorted(s, min(reach, s[-1])), 1, len(P) - 1))
    d = P[j] - P[0]
    return d / max(np.hypot(*d), 1e-9)


def transitions(segs, nodes, max_turn_deg=32.0):
    """Разрешённые проезды через узел: пары концов (seg, end) с плавным переходом (угол излома < max_turn_deg)."""
    out = []
    c = math.cos(math.radians(max_turn_deg))
    for n in nodes.values():
        E = n["ends"]
        for i in range(len(E)):
            for j in range(i + 1, len(E)):
                d1 = _end_dir(segs[E[i][0]], E[i][1]); d2 = _end_dir(segs[E[j][0]], E[j][1])
                if float(-d1 @ d2) > c:
                    out.append((n["key"], E[i], E[j]))
    return out


# ---------------------------------------------------------------- профиль
def _bridge_lines(segs):
    return [(sg, LineString(sg.Q)) for sg in segs if sg.bridge]


def solve_profile(segs, nodes, trans, grid, H, roads, log=print):
    """Головка рельса z(s) во всех точках сети: МНК (данные — рельеф + FORMATION вне мостов; штраф за вторую разность;
    жёсткие точки на переездах; верх. граница под путепроводами, нижняя — на ж/д мостах над дорогами)."""
    # переменные: узлы, затем внутренние точки сегментов
    var_of_node = {k: i for i, k in enumerate(nodes)}
    nv = len(var_of_node)
    for sg in segs:
        sg.Q = resample(sg.P, SAMPLE)
        sg.s = cumlen(sg.Q)
        sg.L = float(sg.s[-1])
        v = np.empty(len(sg.Q), np.int64)
        v[0] = var_of_node[sg.a]; v[-1] = var_of_node[sg.b]
        v[1:-1] = nv + np.arange(len(sg.Q) - 2)
        nv += len(sg.Q) - 2
        sg.var = v
    xy = np.zeros((nv, 2)); data_w = np.zeros(nv)
    for sg in segs:
        xy[sg.var] = sg.Q
        if not sg.bridge:
            data_w[sg.var] = 1.0
    target = grid.sample(H, xy[:, 0], xy[:, 1]) + FORMATION
    # строки МНК
    rows, cols, vals, rhs, wts = [], [], [], [], []
    r = 0

    def add(idx, coef, b, w):
        nonlocal r
        rows.extend([r] * len(idx)); cols.extend(idx); vals.extend(coef); rhs.append(b); wts.append(w)
        r += 1

    alpha = math.sqrt((SMOOTH_L / (2 * math.pi * SAMPLE)) ** 4)

    def curv(i0, i1, i2, h0, h1):
        hb = (h0 + h1) / 2
        add([i0, i1, i2], [hb / h0, -hb / h0 - hb / h1, hb / h1], 0.0, alpha)

    for sg in segs:
        h = np.diff(sg.s)
        for k in range(1, len(sg.Q) - 1):
            curv(sg.var[k - 1], sg.var[k], sg.var[k + 1], max(h[k - 1], 0.5), max(h[k], 0.5))
    for key, (s1, e1), (s2, e2) in trans:
        A, B = segs[s1], segs[s2]
        if len(A.Q) < 2 or len(B.Q) < 2:
            continue
        ia = A.var[1] if e1 == 0 else A.var[-2]
        ib = B.var[1] if e2 == 0 else B.var[-2]
        ha = A.s[1] if e1 == 0 else A.L - A.s[-2]
        hb = B.s[1] if e2 == 0 else B.L - B.s[-2]
        curv(ia, var_of_node[key], ib, max(ha, 0.5), max(hb, 0.5))
    # переезды: точки пути на проезжей части наземных дорог — головка = поверхность дороги
    ground_roads = [g for g in roads if not g.bridge and not g.tunnel]
    from .structures import _hw
    road_polys = [LineString(g.axis).buffer(max(_hw(g)) + 0.3, cap_style="flat") for g in ground_roads]
    rtree = STRtree(road_polys)
    pts = shapely.points(xy)
    on_road = np.zeros(nv, bool)
    ground_var = np.zeros(nv, bool)
    for sg in segs:
        if not sg.bridge:
            ground_var[sg.var] = True
    for a, b in zip(*rtree.query(pts, predicate="intersects")):
        if ground_var[a]:
            on_road[a] = True
    pins = {int(i): float(grid.sample(H, [xy[i, 0]], [xy[i, 1]])[0]) + CROSS_LIFT for i in np.where(on_road)[0]}
    # ограничения: под путепроводами (верх), на ж/д мостах над дорогами (низ)
    ub, lb, under_deck = {}, {}, {}
    vtree = cKDTree(xy)
    for g in roads:
        if not g.bridge:
            continue
        bl = LineString(g.axis)
        hw = max(_hw(g))
        for i in vtree.query_ball_point(np.asarray(bl.interpolate(0.5, normalized=True).coords[0]), bl.length / 2 + hw + 10):
            if not ground_var[i]:
                continue
            p = Point(xy[i])
            if bl.distance(p) > hw + 2.0:
                continue
            sc = bl.project(p)
            zd = float(np.interp(sc, g.s_axis, g.z_axis))
            ub[i] = min(ub.get(i, 1e9), zd - RAIL_CLEAR_UNDER)
            if float(np.interp(sc, g.s_axis, getattr(g, "end_w", np.zeros(len(g.s_axis))))) < 0.05:
                under_deck[i] = max(under_deck.get(i, -1e9), zd)
    rl = [LineString(g.axis) for g in ground_roads]
    gtree = STRtree(rl)
    for sg in segs:
        if not sg.bridge:
            continue
        ln = LineString(sg.Q)
        for gi in gtree.query(ln, predicate="intersects"):
            g = ground_roads[gi]
            x = ln.intersection(rl[gi])
            for pt in getattr(x, "geoms", [x]):
                if pt.geom_type != "Point":
                    continue
                zg = float(np.interp(rl[gi].project(pt), g.s_axis, g.z_axis))
                k = int(np.argmin(np.abs(sg.s - ln.project(pt))))
                i = sg.var[k]
                lb[i] = max(lb.get(i, -1e9), zg + ROAD_UNDER_RAIL + 0.6 + FORMATION)
    # данные у путепроводов не годятся (в рельефе насыпь подходов дороги): ±25 м от точек под настилом — без данных
    if ub:
        for lst in vtree.query_ball_point(xy[list(ub)], 25.0):
            data_w[lst] = 0.0
    for i in np.where(data_w > 0)[0]:
        add([i], [1.0], target[i], data_w[i])
    nr = r

    # пары соседних точек (для ограничения уклона): (i, j, h, предел)
    pairs = []
    for sg in segs:
        gmax = GRADE_MAIN if sg.usage in ("main", "branch") and not sg.service else GRADE_SIDING
        h = np.diff(sg.s)
        for k in range(len(sg.Q) - 1):
            pairs.append((sg.var[k], sg.var[k + 1], max(h[k], 0.5), gmax))
    pairs = np.array(pairs)
    pi, pj = pairs[:, 0].astype(np.int64), pairs[:, 1].astype(np.int64)

    def solve(extra, grade=None):
        R = list(rows); C = list(cols); V = list(vals); bb = list(rhs); W = list(wts)
        rr = nr
        for i, z in extra.items():
            R.append(rr); C.append(i); V.append(1.0); bb.append(z); W.append(PIN_W); rr += 1
        for k, (g, w) in (grade or {}).items():   # z_j − z_i = g·h (уклон на пределе)
            R += [rr, rr]; C += [int(pi[k]), int(pj[k])]; V += [-1.0, 1.0]; bb.append(g * pairs[k, 2]); W.append(w); rr += 1
        A = sparse.csr_matrix((V, (R, C)), shape=(rr, nv))
        Wd = sparse.diags(np.asarray(W) ** 2)
        M = (A.T @ Wd @ A).tocsc() + sparse.identity(nv) * 1e-9
        return spsolve(M, A.T @ (Wd @ np.asarray(bb)))

    act = dict(pins)
    grade = {}
    z = solve(act)
    for it in range(20):
        viol = 0
        for i, u in ub.items():
            if z[i] > u + 0.02:
                act[i] = u; viol += 1
        for i, l in lb.items():
            if z[i] < l - 0.02:
                act[i] = l; viol += 1
        g = (z[pj] - z[pi]) / pairs[:, 2]
        over = np.where(np.abs(g) > pairs[:, 3] + 0.0005)[0]
        for k in over:   # уклон сверх предела: строка «уклон = предел», вес растёт с каждой итерацией
            w0 = grade.get(k, (0, 0.0))[1]
            grade[k] = (float(np.sign(g[k]) * pairs[k, 3]), max(w0 * 2.0, 3.0 * SAMPLE))
        viol += len(over)
        if not viol:
            break
        z = solve(act, grade)
    for sg in segs:
        sg.z = z[sg.var]
    # отчёт: уклоны
    gr_main, gr_all = [], []
    for sg in segs:
        if sg.L < 20:
            continue
        g = np.abs(np.diff(sg.z) / np.maximum(np.diff(sg.s), 0.5))
        gr_all.append(g.max())
        if sg.usage in ("main", "branch"):
            gr_main.append(np.percentile(g, 99))
    dev = (z - target)[data_w > 0]
    info = {"vars": nv, "crossing_pins": len(pins), "under_bridges": len(ub), "over_roads": len(lb),
            "grade_main_p99_max": _r(max(gr_main, default=0) * 100, 2), "grade_max": _r(max(gr_all, default=0) * 100, 2),
            "fill_max": _r(dev.max(), 2), "cut_max": _r(-dev.min(), 2), "dev_mean": _r(np.abs(dev).mean(), 2)}
    # проём под путепроводом: точки пути под пролётом (не у наземной опоры) с настилом выше габарита —
    # там рельеф опускается до площадки даже на насыпи моста (поверхность моста = настил, коллайдер — плита)
    trench = np.array([[xy[i, 0], xy[i, 1]] for i, zd in under_deck.items() if zd - (z[i] - FORMATION) > 5.5]).reshape(-1, 2)
    info["under_deck_trench"] = len(trench)
    log(f"ж/д: профиль — {info}")
    return info, on_road, trench


def condition_terrain(segs, grid, H, wroad, trench, log=print):
    """Вжатие коридоров путей: основная площадка FORMATION ниже головки, полуширина 3 м, откосы 1:1.5.
    Ячейки дорог (wroad ≥ 0.5) не меняются, ближе к дороге влияние гаснет. Пролёты мостов не трогаются."""
    S = []
    for sg in segs:
        if sg.bridge:
            continue
        Q = resample(sg.P, 2.5)
        s = cumlen(Q)
        z = np.interp(s, sg.s, sg.z)
        S.append(np.c_[Q, z - FORMATION])
    S = np.concatenate(S)
    xs, ys = grid.node_xy()
    gx, gy = np.meshgrid(xs, ys)
    pts = np.c_[gx.ravel(), gy.ravel()]
    hw = 3.0
    R = hw + 32.0
    tree = cKDTree(S[:, :2])
    d, idx = tree.query(pts, k=6, distance_upper_bound=R, workers=-1)
    valid = np.isfinite(d)
    if not valid.any():
        return H, {}
    sel = np.where(valid.any(1))[0]
    d, idx, valid = d[sel], idx[sel], valid[sel]
    idx_c = np.where(valid, idx, 0)
    h_here = H.ravel()[sel][:, None]
    f = S[idx_c, 2]
    shoulder = np.clip(np.abs(h_here - f) * 2.25, 3.0, 32.0)
    w = 1.0 - _smoothstep((d - hw) / shoulder)
    w[d <= hw] = 1.0
    w[~valid] = 0.0
    score = w - 1e-4 * np.where(valid, d, 1e9)
    best = np.argmax(score, axis=1)
    rr = np.arange(len(sel))
    wb = w[rr, best]; fb = f[rr, best]
    wr = wroad.ravel()[sel].copy()
    force = np.zeros(H.size, bool)
    if len(trench):   # под пролётами путепроводов дорога — это настил, рельеф под ним можно опускать
        dt, _ = cKDTree(trench).query(pts[sel], distance_upper_bound=hw + 0.5)
        f = np.isfinite(dt)
        wr[f] = 0.0
        force[sel[f]] = True
    wb = wb * np.clip(1.0 - 2.0 * wr, 0.0, 1.0)
    out = H.ravel().copy()
    dz = np.zeros(len(out))
    dz[sel] = (fb - out[sel]) * wb
    dz = gaussian_filter(dz.reshape(H.shape), 0.6).ravel()
    dz[(wroad.ravel() >= 0.5) & ~force] = 0.0
    dz[force] = np.minimum(dz[force], 0.0)
    out += dz
    Hn = out.reshape(H.shape)
    ch = np.abs(Hn - H)
    info = {"cells": int((ch > 0.05).sum()), "fill_max": _r((Hn - H).max(), 2), "cut_max": _r((H - Hn).max(), 2)}
    log(f"ж/д: вжатие коридоров — {info}")
    return Hn, info


def prepare(osm, roads, grid, H, wroad, bounds, osm_path, log=print):
    """Граф, профиль и вжатие. Возвращает (H, RailCtx)."""
    rc = RailCtx()
    rc.segs, rc.nodes = build_graph(osm, bounds, log)
    rc.trans = transitions(rc.segs, rc.nodes)
    rc.bounds = bounds
    rc.osm_nodes = railway_nodes(osm_path)
    import os
    if os.environ.get("RAIL_DEBUG_DUMP"):   # отладка профиля без полной сборки: входы prepare() в pickle
        import pickle
        with open(os.environ["RAIL_DEBUG_DUMP"], "wb") as f:
            pickle.dump({"roads": roads, "grid": grid, "H": H, "wroad": wroad, "bounds": bounds}, f)
    if not rc.segs:
        rc.info = {}
        return H, rc
    rc.info, rc.on_road, trench = solve_profile(rc.segs, rc.nodes, rc.trans, grid, H, roads, log)
    H, rc.cond = condition_terrain(rc.segs, grid, H, wroad, trench, log)
    return H, rc


# ---------------------------------------------------------------- геометрия
class _Mesh:
    """Накопитель треугольников по тайлам (резка по середине элемента)."""

    def __init__(self, tiles, tile_key, base):
        self.tiles, self.tile_key, self.base = tiles, tile_key, base
        self.tris = Counter()

    def g(self, x, y, z):
        return np.c_[x, np.asarray(z) - self.base, -np.asarray(y)]

    def strip(self, node, mat, A, B, hint, uv=None, normals=True):
        """Лента между линиями A и B ((n,3) абсолютные x, y, z), режется по тайлам по середине звена.
        hint: (3,) или (n-1,3) — желаемая сторона нормали в координатах игры."""
        A = np.asarray(A, float); B = np.asarray(B, float)
        n = len(A)
        if n < 2:
            return
        mid = (A[:-1, :2] + A[1:, :2] + B[:-1, :2] + B[1:, :2]) / 4
        ks = [self.tile_key(x, y) for x, y in mid]
        hint = np.asarray(hint, float)
        if hint.ndim == 1:
            hint = np.tile(hint, (n - 1, 1))
        i = 0
        while i < n - 1:
            j = i
            while j + 1 < n - 1 and ks[j + 1] == ks[i]:
                j += 1
            sl = slice(i, j + 2)
            k = j + 2 - i
            P = np.empty((2 * k, 3))
            P[0::2] = self.g(A[sl, 0], A[sl, 1], A[sl, 2])
            P[1::2] = self.g(B[sl, 0], B[sl, 1], B[sl, 2])
            q = 2 * np.arange(k - 1)[:, None]
            T = np.c_[q, q + 2, q + 3, q, q + 3, q + 1].reshape(-1, 3)
            T = fix_winding(P, T, np.repeat(hint[i:j + 1], 2, axis=0))
            U = None
            if uv is not None:
                U = np.empty((2 * k, 2)); U[0::2] = uv[0][sl]; U[1::2] = uv[1][sl]
            if mat is None:
                self.tiles[ks[i]][node][None].add(P, T)
            else:
                self.tiles[ks[i]][node][mat].add(P, T, smooth_normals(P, T) if normals else None, U)
            self.tris[node + ":" + str(mat)] += len(T)
            i = j + 1

    def quads(self, node, mat, key, Q4, hint, uv=None):
        """Набор независимых четырёхугольников Q4 (m,4,3) абсолютных; плоские нормали."""
        Q4 = np.asarray(Q4, float)
        m = len(Q4)
        if not m:
            return
        P = self.g(Q4[..., 0].ravel(), Q4[..., 1].ravel(), Q4[..., 2].ravel())
        q = 4 * np.arange(m)[:, None]
        T = np.c_[q, q + 1, q + 2, q, q + 2, q + 3].reshape(-1, 3)
        hint = np.asarray(hint, float)
        hint = np.tile(hint, (m, 1)) if hint.ndim == 1 else hint
        T = fix_winding(P, T, np.repeat(hint, 2, axis=0))
        if mat is None:
            self.tiles[key][node][None].add(P, T)
        else:
            nn = np.cross(P[T[0::2, 1]] - P[T[0::2, 0]], P[T[0::2, 2]] - P[T[0::2, 0]])
            nn /= np.maximum(np.linalg.norm(nn, axis=1, keepdims=True), 1e-9)
            N = np.repeat(nn, 4, axis=0)
            self.tiles[key][node][mat].add(P, T, N, uv)
        self.tris[node + ":" + str(mat)] += len(T)


def _dp3(P, tol):
    """Дуглас–Пекер в 3D (индексы оставленных точек)."""
    n = len(P)
    if n < 3:
        return np.arange(n)
    keep = np.zeros(n, bool); keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        d = P[b] - P[a]
        L = np.linalg.norm(d)
        v = P[a + 1:b] - P[a]
        if L < 1e-9:
            dist = np.linalg.norm(v, axis=1)
        else:
            dist = np.linalg.norm(np.cross(v, d / L), axis=1)
        k = int(np.argmax(dist))
        if dist[k] > tol:
            m = a + 1 + k
            keep[m] = True
            stack.append((a, m)); stack.append((m, b))
    return np.where(keep)[0]


def _seg_dense(sg, step):
    Q = resample(sg.P, step)
    s = cumlen(Q)
    return Q, s, np.interp(s, sg.s, sg.z)


def build(rc, ctx, out_dir, log=print):
    """Геометрия в тайлы + rail/net.json. ctx — mctx из build_world.py (H — окончательный рельеф)."""
    out_dir = Path(out_dir)
    (out_dir / "rail").mkdir(parents=True, exist_ok=True)
    if not getattr(rc, "segs", None):
        (out_dir / "rail" / "net.json").write_text(json.dumps({"version": 1, "segments": []}))
        return {"segments": 0}
    grid, H, base, roads, osm = ctx["grid"], ctx["H"], ctx["base"], ctx["roads"], ctx["osm"]
    M = _Mesh(ctx["tiles"], ctx["tile_key"], base)
    st = Counter()
    segs, nodes = rc.segs, rc.nodes
    hz = lambda x, y: grid.sample(H, np.atleast_1d(x), np.atleast_1d(y))
    from .structures import _hw

    # --- зоны переездов (по проезжей части)
    ground_roads = [g for g in roads if not g.bridge and not g.tunnel]
    road_polys = [LineString(g.axis).buffer(max(_hw(g)) + 0.3, cap_style="flat") for g in ground_roads]
    rtree = STRtree(road_polys)

    def on_road(Q):
        res = np.zeros(len(Q), bool)
        if not len(Q):
            return res
        a, _ = rtree.query(shapely.points(Q), predicate="intersects")
        res[a] = True
        return res

    # ---------- путь: балласт, шпалы, рельсы
    col_items = 0
    for sg in segs:
        Q, s, z = _seg_dense(sg, 3.0)
        if len(Q) < 2:
            continue
        nrm = left_normals(Q)
        road = on_road(Q)
        # балласт (вне проезжей части)
        mask = ~road
        i = 0
        while i < len(Q):
            if not mask[i]:
                i += 1; continue
            j = i
            while j + 1 < len(Q) and mask[j + 1]:
                j += 1
            if j > i:
                sl = slice(i, j + 1)
                q, nn, zz, ss = Q[sl], nrm[sl], z[sl], s[sl]
                top = zz - BALLAST_TOP
                foot_off = BALLAST_HALF + (FORMATION - BALLAST_TOP) * BALLAST_SLOPE
                Lt = q + nn * BALLAST_HALF; Rt = q - nn * BALLAST_HALF
                Lf = q + nn * foot_off; Rf = q - nn * foot_off
                if sg.bridge:
                    fz = zz - FORMATION
                    zl = fz; zrr = fz
                else:
                    zl = np.minimum(hz(Lf[:, 0], Lf[:, 1]), top - 0.05) - 0.08
                    zrr = np.minimum(hz(Rf[:, 0], Rf[:, 1]), top - 0.05) - 0.08
                A3 = lambda P2, Z: np.c_[P2, Z]
                up = np.array([0, 1.0, 0])
                uvx = lambda a: np.full(len(ss), a)
                M.strip("railway", "rail_ballast", A3(Lt, top), A3(Rt, top), up, uv=(np.c_[uvx(-BALLAST_HALF), ss], np.c_[uvx(BALLAST_HALF), ss]))
                hl = np.c_[nn[:-1, 0], np.full(len(nn) - 1, 1.0), -nn[:-1, 1]]
                hr = np.c_[-nn[:-1, 0], np.full(len(nn) - 1, 1.0), nn[:-1, 1]]
                M.strip("railway", "rail_ballast", A3(Lf, zl), A3(Lt, top), hl, uv=(np.c_[uvx(-foot_off), ss], np.c_[uvx(-BALLAST_HALF), ss]))
                M.strip("railway", "rail_ballast", A3(Rt, top), A3(Rf, zrr), hr, uv=(np.c_[uvx(BALLAST_HALF), ss], np.c_[uvx(foot_off), ss]))
                # коллайдер: верх и откосы (по упрощённой оси, шаг до 12 м)
                keep = _dp3(np.c_[q, zz], 0.03)
                keep = np.unique(np.r_[keep, np.arange(0, len(q), 4), len(q) - 1])
                for A_, B_, h_ in ((A3(Lt, top), A3(Rt, top), up), (A3(Lf, zl), A3(Lt, top), hl), (A3(Rt, top), A3(Rf, zrr), hr)):
                    hh = h_ if h_.ndim == 1 else h_[np.minimum(keep[:-1], len(h_) - 1)]
                    M.strip("railway_colliders", None, A_[keep], B_[keep], hh, normals=False)
                st["ballast_m"] += float(ss[-1] - ss[0])
            i = j + 1
        # шпалы (шаг 0.55 м), не на проезжей части
        ns = int(max(sg.L - 0.4, 0) // SLEEPER_STEP)
        if ns > 0:
            sq = 0.2 + SLEEPER_STEP / 2 + np.arange(ns) * SLEEPER_STEP
            cx = np.interp(sq, s, Q[:, 0]); cy = np.interp(sq, s, Q[:, 1]); cz = np.interp(sq, s, z) - SLEEPER_TOP
            k = np.clip(np.searchsorted(s, sq) - 1, 0, len(Q) - 2)
            t = Q[k + 1] - Q[k]; t /= np.maximum(np.hypot(*t.T), 1e-9)[:, None]
            nn = np.c_[-t[:, 1], t[:, 0]]
            ok = ~on_road(np.c_[cx, cy])
            c = np.c_[cx, cy][ok]; t = t[ok]; nn = nn[ok]; cz = cz[ok]
            hl, hw_ = SLEEPER_L / 2, SLEEPER_W / 2
            corners = [(-hw_, -hl), (hw_, -hl), (hw_, hl), (-hw_, hl)]
            top = np.stack([np.c_[c + t * a + nn * b, cz] for a, b in corners], axis=1)       # (m,4,3)
            keys = [ctx["tile_key"](x, y) for x, y in c]
            byk = defaultdict(list)
            for ii, kk in enumerate(keys):
                byk[kk].append(ii)
            for kk, ii in byk.items():
                ii = np.asarray(ii)
                T4 = top[ii]
                uv = np.tile(np.array([[0, 0], [1, 0], [1, 1], [0, 1]], float), (len(ii), 1))
                M.quads("railway", "rail_sleeper", kk, T4, np.array([0, 1.0, 0]), uv)
            st["sleepers"] += int(ok.sum())
        # рельсы: упрощённая ось (ДП 1 см), каждая нить — верх + две грани
        keep = _dp3(np.c_[Q, z], 0.01)
        q, nn, zz, ss = Q[keep], nrm[keep], z[keep], s[keep]
        for side in (1, -1):
            c = q + nn * side * RAIL_OFF
            a = c + nn * HEAD_W / 2; b = c - nn * HEAD_W / 2
            ztop = zz + 0.005 * road[keep]
            zbot = zz - RAIL_H
            up = np.array([0, 1.0, 0])
            hl = np.c_[nn[:-1, 0], np.zeros(len(nn) - 1), -nn[:-1, 1]]
            uvs = (np.c_[np.zeros(len(ss)), ss], np.c_[np.ones(len(ss)), ss])
            M.strip("railway", "rail_steel", np.c_[a, ztop], np.c_[b, ztop], up, uv=uvs, normals=False)
            M.strip("railway", "rail_steel", np.c_[a, zbot], np.c_[a, ztop], hl, uv=uvs, normals=False)
            M.strip("railway", "rail_steel", np.c_[b, ztop], np.c_[b, zbot], -hl, uv=uvs, normals=False)
            M.strip("railway_colliders", None, np.c_[a, ztop], np.c_[b, ztop], up, normals=False)
            M.strip("railway_colliders", None, np.c_[a, zbot], np.c_[a, ztop], hl, normals=False)
            M.strip("railway_colliders", None, np.c_[b, ztop], np.c_[b, zbot], -hl, normals=False)
        st["track_m"] += sg.L
        if sg.bridge:
            _rail_bridge(sg, Q, s, z, nrm, grid, H, M, ctx, road_polys, rtree, st)
    # плоские нормали рельсов (strip без нормалей): Prim без NORMAL -> игра посчитает computeVertexNormals

    # ---------- станции, платформы, навесы
    stations, platforms, stops = _stations(rc, segs, osm, grid, H, M, st, ctx)

    # ---------- переезды
    crossings = _crossings(rc, segs, roads, ground_roads, grid, H, base, st)

    # ---------- контактная сеть, сигналы, упоры
    masts, portals, supports = _catenary(segs, grid, H, base, st)
    signals = _signals(rc, segs, stops, grid, H, base, st)
    buffers = _buffers(rc, segs, nodes, grid, H, base)

    # ---------- граф для игры
    bg = lambda x, y, z: [_r(x), _r(z - base), _r(-y)]
    nodes_out, nid = [], {}
    for k, n in nodes.items():
        sg_i, e = n["ends"][0]
        zz = segs[sg_i].z[0 if e == 0 else -1]
        nid[k] = len(nodes_out)
        d = None
        if n["kind"] == "portal":
            d = -_end_dir(segs[sg_i], e)
        nodes_out.append({"id": nid[k], "kind": n["kind"], **dict(zip("xyz", bg(n["xy"][0], n["xy"][1], zz))),
                          **({"osm": int(k)} if k > 0 else {}), **({"out": [_r(d[0], 3), _r(-d[1], 3)]} if d is not None else {})})
    seg_out = []
    for sg in segs:
        Q, s, z = sg.Q, sg.s, sg.z
        seg_out.append({"id": sg.id, "from": nid[sg.a], "to": nid[sg.b], "osm": sg.way, "len": _r(sg.L, 1),
                        "usage": sg.usage, "service": sg.service, "electrified": sg.elec,
                        **({"maxspeed": sg.maxspeed} if sg.maxspeed else {}), **({"dir": sg.dirpref} if sg.dirpref else {}),
                        **({"ref": sg.ref} if sg.ref else {}), **({"name": sg.name} if sg.name else {}),
                        "bridge": bool(sg.bridge), "supports": supports.get(sg.id, []),
                        "points": [bg(x, y, zz) for (x, y), zz in zip(Q, z)]})
    links = [[nid[k], a[0], a[1], b[0], b[1]] for k, a, b in rc.trans]
    net = {"version": 1, "railHead": "points[].y — головка рельса", "gauge": GAUGE,
           "dims": {"railOffset": RAIL_OFF, "ballastTop": BALLAST_TOP, "formation": FORMATION, "platformH": PLATFORM_H,
                    "wireH": WIRE_H, "mastOffset": MAST_OFF},
           "nodes": nodes_out, "segments": seg_out, "links": links, "stations": stations, "platforms": platforms,
           "stops": stops, "crossings": crossings, "signals": signals, "masts": masts, "portals": portals,
           "buffers": buffers, "stats": {**{k: (_r(v, 1) if isinstance(v, float) else v) for k, v in st.items()},
                                         "profile": rc.info, "terrain": rc.cond}}
    (out_dir / "rail" / "net.json").write_text(json.dumps(net, ensure_ascii=False, separators=(",", ":")))
    st["tris_" + "railway"] = sum(v for k, v in M.tris.items() if k.startswith("railway:"))
    st["tris_colliders"] = sum(v for k, v in M.tris.items() if k.startswith("railway_colliders"))
    return {k: (_r(v, 1) if isinstance(v, float) else v) for k, v in st.items()}


# ---------------------------------------------------------------- ж/д мосты
def _rail_bridge(sg, Q, s, z, nrm, grid, H, M, ctx, road_polys, rtree, st):
    """Пролётное строение под балластным корытом (верх плиты = основная площадка), бортики, устои, опоры."""
    top = z - FORMATION
    bot = top - 1.1
    half = 2.7
    up = np.array([0, 1.0, 0])
    L, R = Q + nrm * half, Q - nrm * half
    hl = np.c_[nrm[:-1, 0], np.zeros(len(Q) - 1), -nrm[:-1, 1]]
    sv = (np.c_[s, np.zeros(len(s))], np.c_[s, np.ones(len(s))])
    M.strip("railway", "bridge_concrete", np.c_[L, bot], np.c_[L, top + 0.9], hl, uv=sv)
    M.strip("railway", "bridge_concrete", np.c_[R, top + 0.9], np.c_[R, bot], -hl, uv=sv)
    M.strip("railway", "bridge_concrete", np.c_[L, bot], np.c_[R, bot], -up, uv=sv)
    Li, Ri = Q + nrm * (half - 0.25), Q - nrm * (half - 0.25)
    M.strip("railway", "bridge_concrete", np.c_[Li, top + 0.9], np.c_[Li, top], -hl, uv=sv)   # внутренние грани бортиков
    M.strip("railway", "bridge_concrete", np.c_[Ri, top], np.c_[Ri, top + 0.9], hl, uv=sv)
    M.strip("railway", "bridge_concrete", np.c_[L, top + 0.9], np.c_[Li, top + 0.9], up, uv=sv)
    M.strip("railway", "bridge_concrete", np.c_[Ri, top + 0.9], np.c_[R, top + 0.9], up, uv=sv)
    for A_, B_, h_ in ((np.c_[L, bot], np.c_[L, top + 0.9], hl), (np.c_[R, top + 0.9], np.c_[R, bot], -hl)):
        M.strip("railway_colliders", None, A_, B_, h_, normals=False)
    ground = grid.sample(H, Q[:, 0], Q[:, 1])
    t = np.gradient(Q, axis=0); t /= np.maximum(np.hypot(*t.T), 1e-9)[:, None]

    def box_q(c, tt, nn, ht, hn, z0, z1, collider=True):
        ring = np.array([c - tt * ht - nn * hn, c + tt * ht - nn * hn, c + tt * ht + nn * hn, c - tt * ht + nn * hn])
        quads, hints = [], []
        for i in range(4):
            a, b = ring[i], ring[(i + 1) % 4]
            quads.append([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]])
            o = (a + b) / 2 - c
            hints.append([o[0], 0, -o[1]])
        key = ctx["tile_key"](*c)
        M.quads("railway", "bridge_concrete", key, np.array(quads), np.array(hints))
        if collider:
            M.quads("railway_colliders", None, key, np.array(quads), np.array(hints))

    for k, inward in ((0, 1), (len(Q) - 1, -1)):   # устои
        if bot[k] - ground[k] > 0.4:
            box_q(Q[k] + t[k] * inward * 0.8, t[k], nrm[k], 0.8, half + 0.4, ground[k] - 0.5, bot[k])
            st["rail_abutments"] += 1
    Ls = s[-1]
    for q in range(1, int(Ls // 24.0) + 1):         # опоры через ~24 м, не на проезжей части
        for shift in (0, 3, -3, 6, -6):
            k = int(np.clip(np.searchsorted(s, Ls * q / (int(Ls // 24.0) + 1) + shift), 1, len(s) - 2))
            if bot[k] - ground[k] < 2.5:
                continue
            foot = Polygon([Q[k] - t[k] * 0.8 - nrm[k] * half, Q[k] + t[k] * 0.8 - nrm[k] * half,
                            Q[k] + t[k] * 0.8 + nrm[k] * half, Q[k] - t[k] * 0.8 + nrm[k] * half]).buffer(0.5)
            if len(rtree.query(foot, predicate="intersects")):
                continue
            box_q(Q[k], t[k], nrm[k], 0.6, half - 0.4, ground[k] - 0.5, bot[k])
            st["rail_piers"] += 1
            break
    st["rail_bridges"] += 1
    st["rail_bridge_m"] += float(Ls)


# ---------------------------------------------------------------- станции и платформы
def _platform_polys(osm):
    out = []
    for wid, (refs, tg) in osm.ways.items():
        if tg.get("railway") == "platform" or (tg.get("public_transport") == "platform" and tg.get("train") == "yes"):
            p = osm.way_polygon(wid)
            if p is None:
                P = osm.way_xy(wid)
                if len(P) >= 2:
                    p = LineString(P).buffer(2.5, cap_style="flat")
            if p is not None and p.area > 30:
                out.append((wid, tg, p))
    return out


def _stations(rc, segs, osm, grid, H, M, st, ctx):
    from config import to_world
    from .buildings import triangulate
    base = ctx["base"]
    min_x, max_x, min_y, max_y = rc.bounds
    # станции/остановочные пункты (включая лежащие чуть за границей — Рязань-II)
    stn = []
    for nid_, (lon, lat, tg) in rc.osm_nodes.items():
        if tg.get("railway") in ("station", "halt") and (tg.get("train") == "yes" or tg.get("railway") == "halt" or "station" in tg.get("public_transport", "")):
            x, y = to_world.transform(lon, lat)
            if min_x - 800 < x < max_x + 800 and min_y - 800 < y < max_y + 800:
                stn.append({"name": tg.get("name", ""), "osm": nid_, "x": x, "y": y, "kind": tg["railway"]})
    track_lines = [LineString(sg.P) for sg in segs]
    all_tracks = unary_union(track_lines)
    near_tracks = all_tracks.buffer(3.2)
    cut = all_tracks.buffer(PLATFORM_EDGE, cap_style="flat")
    # точки профиля для высоты
    allQ = np.concatenate([sg.Q for sg in segs]); allZ = np.concatenate([sg.z for sg in segs])
    ztree = cKDTree(allQ)
    zhead = lambda P: allZ[ztree.query(np.atleast_2d(P))[1]]
    world = box(min_x + 2, min_y + 2, max_x - 2, max_y - 2)
    platforms, stops = [], []
    rc.platform_union = None
    used_polys = []
    for wid, tg, p0 in _platform_polys(osm):
        p = p0.intersection(world)
        if p.is_empty or p.area < 30:
            continue
        # платформа подтягивается к соседнему пути (неточность OSM) и не заходит в габарит
        p = unary_union([p, p.buffer(1.5).intersection(near_tracks)]).difference(cut)
        parts = [g for g in getattr(p, "geoms", [p]) if g.geom_type == "Polygon" and g.area > 30]
        if not parts:
            continue
        p = max(parts, key=lambda g: g.area)
        used_polys.append(p)
        c = p.centroid
        best = min(stn, key=lambda s_: math.hypot(s_["x"] - c.x, s_["y"] - c.y)) if stn else None
        sname = best["name"] if best and math.hypot(best["x"] - c.x, best["y"] - c.y) < 900 else ""
        pid = len(platforms)
        # поверхность: полигон, рёбра нарезаны по 6 м, высота = ближайшая головка + PLATFORM_H
        pp = shapely.segmentize(p, 6.0)
        V2, T = triangulate(pp)
        if V2 is None:
            continue
        ztop = zhead(V2) + PLATFORM_H
        P3 = np.c_[V2[:, 0], ztop - base, -V2[:, 1]]
        T = fix_winding(P3, T, np.array([0, 1.0, 0]))
        key = ctx["tile_key"](c.x, c.y)
        M.tiles[key]["railway"]["rail_platform"].add(P3, T, np.tile([0, 1.0, 0], (len(P3), 1)), np.c_[V2[:, 0], -V2[:, 1]])
        M.tiles[key]["railway_colliders"][None].add(P3, T)
        for ext, ring in [(True, pp.exterior)] + [(False, r_) for r_ in pp.interiors]:
            R = np.asarray(ring.coords)
            zt = zhead(R) + PLATFORM_H
            zb = grid.sample(H, R[:, 0], R[:, 1]) - 0.3
            out = left_normals(R) * (-1 if ring.is_ccw == ext else 1)
            hint = np.c_[out[:-1, 0], np.zeros(len(R) - 1), -out[:-1, 1]]
            sR = cumlen(R)
            M.strip("railway", "rail_platform_wall", np.c_[R, zb], np.c_[R, zt], hint, uv=(np.c_[sR, zb - zt], np.c_[sR, np.zeros(len(R))]))
            M.strip("railway_colliders", None, np.c_[R, zb], np.c_[R, zt], hint, normals=False)
        # места остановки: пути вдоль края платформы
        side_stops = []
        for sg in segs:
            if sg.L < 20:
                continue
            Qd = resample(sg.P, 2.0); sd = cumlen(Qd)
            if not LineString(Qd).distance(p) < 2.6:
                continue
            dd = shapely.distance(p, shapely.points(Qd))
            adj = dd < 2.6
            if adj.sum() < 10:
                continue
            ii = np.where(adj)[0]
            s0, s1 = float(sd[ii[0]]), float(sd[ii[-1]])
            # сторона: платформа слева (+1) / справа (-1) по направлению сегмента
            k = ii[len(ii) // 2]
            nrm = left_normals(Qd)[k]
            side = 1 if p.distance(Point(Qd[k] + nrm * 3.0)) < p.distance(Point(Qd[k] - nrm * 3.0)) else -1
            stops.append({"station": sname, "platform": pid, "segment": sg.id, "s0": _r(s0, 1), "s1": _r(s1, 1), "side": side})
            side_stops.append(sg.id)
        L = float(p.minimum_rotated_rectangle.length) / 2
        platforms.append({"id": pid, "osm": int(wid), "station": sname, "ref": tg.get("ref", ""),
                          "x": _r(c.x), "y": _r(float(zhead([[c.x, c.y]])[0]) + PLATFORM_H - base), "z": _r(-c.y),
                          "area": _r(p.area, 0), "length": _r(L, 0), "tracks": side_stops})
        st["platforms"] += 1
        if sname and best and best["kind"] == "station":
            _canopy(p, best, zhead, ctx, M, st)
    rc.platform_union = unary_union(used_polys) if used_polys else None
    stations = []
    for s_ in stn:
        pl = [q["id"] for q in platforms if q["station"] == s_["name"]]
        if not pl:
            continue
        stations.append({"name": s_["name"], "osm": s_["osm"], "kind": s_["kind"], "x": _r(s_["x"]), "z": _r(-s_["y"]),
                         "inWorld": bool(min_x < s_["x"] < max_x and min_y < s_["y"] < max_y), "platforms": pl})
    st["stops"] = len(stops)
    return stations, platforms, stops


def _canopy(p, stn, zhead, ctx, M, st):
    """Навес над центральной частью платформы: колонны в ряд по оси, плоская кровля над платформой."""
    base = ctx["base"]
    rect = np.asarray(p.minimum_rotated_rectangle.exterior.coords)[:4]
    e1, e2 = rect[1] - rect[0], rect[2] - rect[1]
    t = e1 if np.hypot(*e1) >= np.hypot(*e2) else e2
    Lr = float(np.hypot(*t)); t = t / Lr
    n = np.array([-t[1], t[0]])
    c0 = rect.mean(0)
    # центральная часть: до 150 м, сдвинута к станции
    proj = float((np.array([stn["x"], stn["y"]]) - c0) @ t)
    half = min(Lr * 0.33, 75.0)
    mid = float(np.clip(proj, -Lr / 2 + half + 5, Lr / 2 - half - 5)) if Lr / 2 - half - 5 > -Lr / 2 + half + 5 else 0.0
    ss = np.arange(mid - half, mid + half + 0.1, 8.0)
    axis, widths = [], []
    for sv in ss:
        a = c0 + t * sv
        ln = LineString([a - n * 30, a + n * 30]).intersection(p)
        if ln.is_empty:
            axis.append(None); continue
        parts = [g for g in getattr(ln, "geoms", [ln]) if g.geom_type == "LineString"]
        if not parts:
            axis.append(None); continue
        g = max(parts, key=lambda q: q.length)
        A = np.asarray(g.coords)
        axis.append((A[0] + A[-1]) / 2); widths.append(g.length)
    run = [a for a in axis if a is not None]
    if len(run) < 3:
        return
    C = np.asarray(run)
    W = np.array([w for w in widths][:len(C)])
    if W.min() < 3.5:
        return
    roof_hw = np.clip(W / 2 - 0.6, 1.5, 3.2)
    zt = zhead(C) + PLATFORM_H
    nn = left_normals(C)
    zr = zt + CANOPY_H
    up = np.array([0, 1.0, 0])
    L = C + nn * roof_hw[:, None]; R = C - nn * roof_hw[:, None]
    sC = cumlen(C)
    # кровля: «чайка» — края на 0.25 м выше середины, толщина 0.2
    M.strip("railway", "rail_canopy", np.c_[L, zr + 0.25], np.c_[C, zr], up, uv=(np.c_[np.zeros(len(C)), sC], np.c_[roof_hw, sC]))
    M.strip("railway", "rail_canopy", np.c_[C, zr], np.c_[R, zr + 0.25], up, uv=(np.c_[np.zeros(len(C)), sC], np.c_[roof_hw, sC]))
    M.strip("railway", "rail_canopy", np.c_[R, zr - 0.2], np.c_[C, zr - 0.25], -up)
    M.strip("railway", "rail_canopy", np.c_[C, zr - 0.25], np.c_[L, zr - 0.2], -up)
    for side, E in ((1, L), (-1, R)):
        h = np.c_[nn[:-1, 0] * side, np.zeros(len(C) - 1), -nn[:-1, 1] * side]
        M.strip("railway", "rail_canopy", np.c_[E, zr - 0.2], np.c_[E, zr + 0.25], h)
    # колонны через 8 м (каждая вторая точка оси)
    for k in range(0, len(C), 2):
        cxy, z0 = C[k], zt[k]
        tt = (C[min(k + 1, len(C) - 1)] - C[max(k - 1, 0)]); tt /= max(np.hypot(*tt), 1e-9)
        n2 = np.array([-tt[1], tt[0]])
        ring = np.array([cxy - tt * 0.15 - n2 * 0.15, cxy + tt * 0.15 - n2 * 0.15, cxy + tt * 0.15 + n2 * 0.15, cxy - tt * 0.15 + n2 * 0.15])
        key = ctx["tile_key"](*cxy)
        quads = []
        hints = []
        for i in range(4):
            a, b = ring[i], ring[(i + 1) % 4]
            quads.append([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], zr[k] - 0.2], [a[0], a[1], zr[k] - 0.2]])
            o = (a + b) / 2 - cxy
            hints.append([o[0], 0, -o[1]])
        M.quads("railway", "rail_canopy_column", key, np.array(quads), np.array(hints))
        M.quads("railway_colliders", None, key, np.array(quads), np.array(hints))
        st["canopy_columns"] += 1
    st["canopies"] += 1


# ---------------------------------------------------------------- переезды
def _crossings(rc, segs, roads, ground_roads, grid, H, base, st):
    from .structures import _hw
    rl = [LineString(g.axis) for g in ground_roads]
    tree = STRtree(rl)
    hits = []   # (road index, point, seg, s)
    for sg in segs:
        if sg.bridge:
            continue
        ln = LineString(sg.Q)
        for gi in tree.query(ln, predicate="intersects"):
            x = ln.intersection(rl[gi])
            for pt in getattr(x, "geoms", [x]):
                if pt.geom_type == "Point":
                    hits.append((gi, np.array(pt.coords[0]), sg, float(ln.project(pt))))
    # группировка: одна дорога, точки ближе 40 м — один переезд (несколько путей)
    groups = []
    for h in hits:
        for g in groups:
            if g[0][0] == h[0] and min(np.hypot(*(q[1] - h[1])) for q in g) < 40:
                g.append(h); break
        else:
            groups.append([h])
    # теги переездов OSM
    from config import to_world
    lc = []
    for nid_, (lon, lat, tg) in rc.osm_nodes.items():
        if tg.get("railway") == "level_crossing":
            x, y = to_world.transform(lon, lat)
            lc.append((np.array([x, y]), tg, nid_))
    out = []
    for g in groups:
        gi = g[0][0]
        road = ground_roads[gi]
        rline = rl[gi]
        sc = np.array([rline.project(Point(q[1])) for q in g])
        smid = float((sc.min() + sc.max()) / 2)
        c = np.asarray(rline.interpolate(smid).coords[0])
        k = int(np.clip(np.searchsorted(cumlen(road.axis), smid), 1, len(road.axis) - 1))
        u = road.axis[k] - road.axis[k - 1]; u /= max(np.hypot(*u), 1e-9)
        spread = float(sc.max() - sc.min())
        hr, hl = _hw(road)
        width = hr + hl
        main = any(q[2].usage in ("main", "branch") for q in g)
        car_road = road.hw.replace("_link", "") in ("primary", "secondary", "tertiary", "unclassified", "residential", "living_street")
        # OSM-узел рядом
        tag = None
        for p, tg, nid_ in lc:
            if np.hypot(*(p - c)) < 15:
                tag = (tg, nid_); break
        barrier = main or car_road
        lights = barrier or tag is not None
        if tag:
            tg = tag[0]
            if tg.get("crossing:barrier") in ("no",):
                barrier = False
            elif tg.get("crossing:barrier"):
                barrier = True
            if tg.get("crossing:light") == "no":
                lights = False
            elif tg.get("crossing:light") == "yes":
                lights = True
        zc = float(grid.sample(H, [c[0]], [c[1]])[0]) + 0.05
        equip = []
        if barrier or lights:
            for sgn in (1, -1):
                travel = -sgn * u                     # машина подъезжает со стороны sgn
                right = np.array([travel[1], -travel[0]])
                face = sgn * u                        # «вперёд» модели — навстречу машине
                rot = math.atan2(-face[0], face[1])   # rotY: вперёд −Z игры; z = −y
                half = max(width / 2, 3.0)
                if barrier:
                    p = c + sgn * u * (spread / 2 + 9.0) + right * (half + 0.9)
                    arm = -right
                    equip.append({"type": "barrier", "x": _r(p[0]), "y": _r(float(grid.sample(H, [p[0]], [p[1]])[0]) - base), "z": _r(-p[1]),
                                  "rotY": _r(rot, 4), "armDir": [_r(arm[0], 3), _r(-arm[1], 3)], "armLength": _r(half + 0.5, 2)})
                if lights:
                    p = c + sgn * u * (spread / 2 + 6.5) + right * (half + 1.3)
                    equip.append({"type": "light", "x": _r(p[0]), "y": _r(float(grid.sample(H, [p[0]], [p[1]])[0]) - base), "z": _r(-p[1]),
                                  "rotY": _r(rot, 4)})
        tracks = [{"segment": q[2].id, "s": _r(q[3], 1)} for q in g]
        rec = {"id": len(out), "x": _r(c[0]), "y": _r(zc - base), "z": _r(-c[1]), "road": int(road.id),
               "osmRoad": int(road.osm_id or 0), "roadName": road.name, "highway": road.hw,
               "sumoEdges": [e["id"] for e in (road.fwd, road.bwd) if e is not None],
               "roadDir": [_r(u[0], 3), _r(-u[1], 3)], "roadWidth": _r(width, 1), "spread": _r(spread, 1),
               "barrier": bool(barrier), "lights": bool(lights), "main": bool(main), "carRoad": bool(car_road), "tracks": tracks, "equipment": equip}
        if tag:
            rec["osm"] = int(tag[1])
        out.append(rec)
        st["crossings"] += 1
        st["crossings_guarded"] += int(barrier)
        st["crossings_lights"] += int(lights)
    return out


# ---------------------------------------------------------------- контактная сеть
def _catenary(segs, grid, H, base, st):
    """Опоры через ~60 м (на кривых чаще) со стороны, где нет соседнего пути; в междупутьях станций — порталы
    (жёсткие поперечины) через все электрифицированные пути. supports — s точек подвеса провода по сегментам."""
    el = [sg for sg in segs if sg.elec]
    if not el:
        return [], [], {}
    lines = [LineString(sg.P) for sg in segs]
    eline = [LineString(sg.P) for sg in el]
    tree = STRtree(lines)
    etree = STRtree(eline)
    masts, portals = [], []
    supports = defaultdict(list)
    portal_lines = []

    def free(pt, own):
        for i in tree.query(pt.buffer(2.6)):
            if segs[i] is not own and lines[i].distance(pt) < 2.6:
                return False
        return True

    for sg in el:
        Q, s, z = _seg_dense(sg, 2.0)
        if sg.L < 15:
            continue
        nrm = left_normals(Q)
        # кривизна: шаг 45 м на кривых R < 800 м
        pos, cur = [], 8.0 if sg.L > 30 else sg.L / 2
        while cur < sg.L - 4:
            pos.append(cur)
            k = int(np.searchsorted(s, cur))
            k0, k1 = max(k - 10, 0), min(k + 10, len(Q) - 1)
            a = Q[k0 + 1] - Q[k0]; b = Q[k1] - Q[k1 - 1]
            ang = abs(math.atan2(a[0] * b[1] - a[1] * b[0], a @ b))
            R = (s[k1] - s[k0]) / max(ang, 1e-6)
            cur += 45.0 if R < 800 else MAST_STEP
        for sv in pos:
            k = int(np.clip(np.searchsorted(s, sv), 0, len(Q) - 1))
            c = Q[k]; nn = nrm[k]; zr = float(z[k])
            done = False
            # уже есть портал рядом?
            for pl in portal_lines:
                if pl.distance(Point(c)) < 1.0:
                    supports[sg.id].append(_r(sv, 1)); done = True; break
            if done:
                continue
            for side in (-1, 1):
                p = c + nn * side * MAST_OFF
                if free(Point(p), sg) and free(Point(c + nn * side * (MAST_OFF + 1.5)), sg):
                    zg = float(grid.sample(H, [p[0]], [p[1]])[0])
                    face = -nn * side   # «вперёд» опоры — к пути
                    masts.append({"x": _r(p[0]), "y": _r(zg - base), "z": _r(-p[1]), "rotY": _r(math.atan2(-face[0], face[1]), 4),
                                  "arm": _r(MAST_OFF, 2), "top": _r(zr + WIRE_H + 2.0 - zg, 2), "wire": _r(zr + WIRE_H - base, 2),
                                  "segment": sg.id})
                    supports[sg.id].append(_r(sv, 1))
                    done = True
                    break
            if done:
                continue
            # портал: перпендикуляр через все пути в ±45 м
            pl = LineString([c - nn * 45, c + nn * 45])
            offs = []
            for i in etree.query(pl, predicate="intersects"):
                x = pl.intersection(eline[i])
                for pt in getattr(x, "geoms", [x]):
                    if pt.geom_type == "Point":
                        offs.append(float((np.array(pt.coords[0]) - c) @ nn))
            offs = sorted(offs)
            if not offs:
                continue
            o0, o1 = offs[0] - MAST_OFF, offs[-1] + MAST_OFF
            pa, pb = c + nn * o0, c + nn * o1
            if not (free(Point(pa), None) and free(Point(pb), None)):
                # крайние стойки в габарите соседнего (неэлектрифицированного) пути — сдвигаем наружу
                pa, pb = c + nn * (o0 - 2.0), c + nn * (o1 + 2.0)
            za = float(grid.sample(H, [pa[0]], [pa[1]])[0]); zb = float(grid.sample(H, [pb[0]], [pb[1]])[0])
            portals.append({"x1": _r(pa[0]), "y1": _r(za - base), "z1": _r(-pa[1]), "x2": _r(pb[0]), "y2": _r(zb - base), "z2": _r(-pb[1]),
                            "beam": _r(zr + WIRE_H + 1.6 - base, 2)})
            portal_lines.append(LineString([pa, pb]))
            supports[sg.id].append(_r(sv, 1))
            st["portals"] += 1
    st["masts"] = len(masts)
    return masts, portals, dict(supports)


# ---------------------------------------------------------------- сигналы и упоры
def _signals(rc, segs, stops, grid, H, base, st):
    """Выходные сигналы у концов платформ (по обоим направлениям, справа по ходу), сигналы OSM, проходные на
    главных путях через ~1.5 км (по направлению designated_direction, иначе в обе стороны)."""
    out = []

    def put(sg, s, d, kind):
        Q, sq, z = sg.Q, sg.s, sg.z
        s = float(np.clip(s, 0.5, sg.L - 0.5))
        k = int(np.clip(np.searchsorted(sq, s) - 1, 0, len(Q) - 2))
        t = (Q[k + 1] - Q[k]) * d; t /= max(np.hypot(*t), 1e-9)
        p0 = Q[k] + (Q[k + 1] - Q[k]) * ((s - sq[k]) / max(sq[k + 1] - sq[k], 1e-9))
        right = np.array([t[1], -t[0]])
        p = p0 + right * 2.9
        pu = getattr(rc, "platform_union", None)
        if pu is not None:   # не на платформе; выходной — только за её концом (не в середине длинной платформы)
            if pu.distance(Point(p)) < 0.8 or (kind == "exit" and pu.distance(Point(p0)) < 6.0):
                return
        zg = float(grid.sample(H, [p[0]], [p[1]])[0])
        face = -t
        out.append({"segment": sg.id, "s": _r(s, 1), "dir": d, "kind": kind, "x": _r(p[0]), "y": _r(zg - base), "z": _r(-p[1]),
                    "rotY": _r(math.atan2(-face[0], face[1]), 4), "head": _r(float(np.interp(s, sq, z)) - base, 2)})

    for sp in stops:
        sg = segs[sp["segment"]]
        put(sg, sp["s1"] + 12, 1, "exit")
        put(sg, sp["s0"] - 12, -1, "exit")
    from config import to_world
    tree = cKDTree(np.concatenate([sg.Q for sg in segs]))
    owner = np.concatenate([np.full(len(sg.Q), sg.id) for sg in segs])
    for nid_, (lon, lat, tg) in rc.osm_nodes.items():
        if tg.get("railway") != "signal":
            continue
        x, y = to_world.transform(lon, lat)
        d, i = tree.query([x, y])
        if d > 3:
            continue
        sg = segs[owner[i]]
        sv = LineString(sg.Q).project(Point(x, y))
        dd = -1 if (tg.get("railway:signal:direction") == "backward") else 1
        put(sg, sv, dd, "osm")
    for sg in segs:
        if sg.usage != "main" or sg.L < 1200 or sg.bridge:
            continue
        for sv in np.arange(700, sg.L - 300, 1500):
            for d in ((sg.dirpref,) if sg.dirpref else (1, -1)):
                put(sg, sv + (0 if d > 0 else 20), d, "block")
    st["signals"] = len(out)
    return out


def _buffers(rc, segs, nodes, grid, H, base):
    out = []
    for k, n in nodes.items():
        if n["kind"] != "end":
            continue
        i, e = n["ends"][0]
        sg = segs[i]
        d = -_end_dir(sg, e)       # наружу из пути
        z = sg.z[0 if e == 0 else -1]
        p = n["xy"]
        face = -d
        out.append({"x": _r(p[0]), "y": _r(z - base), "z": _r(-p[1]), "rotY": _r(math.atan2(-face[0], face[1]), 4),
                    "segment": i, "end": e, **({"osm": int(k)} if k > 0 and rc.osm_nodes.get(k, (0, 0, {}))[2].get("railway") == "buffer_stop" else {})})
    return out
