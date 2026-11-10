"""Дороги: сборка двусторонних дорог из рёбер SUMO, высоты перекрёстков, продольные профили, мосты."""
import math
import re

import numpy as np
from scipy.ndimage import gaussian_filter1d
from shapely.geometry import Polygon
from shapely.validation import make_valid

# максимальный продольный уклон по классу
MAX_GRADE = {"primary": 0.08, "secondary": 0.08, "tertiary": 0.10, "unclassified": 0.12, "residential": 0.12,
             "living_street": 0.12, "service": 0.14}
BRIDGE_GRADE = 0.06
PRIORITY = {"primary": 10, "secondary": 9, "tertiary": 8, "unclassified": 6, "residential": 5,
            "living_street": 4, "service": 2}


def highway_class(sumo_type):
    m = re.match(r"highway\.([a-z_]+)", sumo_type or "")
    return m.group(1) if m else "unclassified"


def base_class(hw):
    return hw.replace("_link", "")


# ---------------- геометрия ломаных
def resample(P, step):
    """Вставляет точки так, чтобы сегменты были не длиннее step (исходные вершины сохраняются)."""
    P = np.asarray(P, np.float64)
    out = [P[:1]]
    for a, b in zip(P[:-1], P[1:]):
        L = math.hypot(*(b - a))
        n = max(1, int(math.ceil(L / step)))
        t = np.arange(1, n + 1)[:, None] / n
        out.append(a + (b - a) * t)
    Q = np.concatenate(out)
    keep = np.r_[True, np.hypot(*np.diff(Q, axis=0).T) > 1e-6]
    return Q[keep]


def cumlen(P):
    return np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]


def left_normals(P):
    """Нормали влево в вершинах (митра, ограниченная x2)."""
    d = np.diff(P, axis=0)
    L = np.hypot(*d.T); L[L == 0] = 1
    t = d / L[:, None]
    n = np.c_[-t[:, 1], t[:, 0]]
    nv = np.empty((len(P), 2))
    nv[0], nv[-1] = n[0], n[-1]
    if len(P) > 2:
        m = n[:-1] + n[1:]
        ml = np.hypot(*m.T)
        ml[ml < 1e-9] = 1
        m = m / ml[:, None]
        cos = (m * n[1:]).sum(1)
        scale = 1.0 / np.clip(cos, 0.5, 1.0)
        nv[1:-1] = m * scale[:, None]
    return nv


def offset(P, d):
    return P + left_normals(P) * d


# ---------------- сборка дорог
class Road:
    __slots__ = ("id", "fwd", "bwd", "osm_id", "name", "hw", "bridge", "tunnel", "frm", "to", "axis", "Wf", "Wb",
                 "z_axis", "s_axis", "prio", "cross", "clearance_ok", "embank", "end_w", "ground_end", "end_len")


def edge_width(e):
    return sum(l["width"] for l in e["lanes"])


def build_roads(net, osm_ways):
    edges = net.edges
    used, roads = set(), []
    for eid in sorted(edges):
        if eid in used:
            continue
        e = edges[eid]
        rev_id = eid[1:] if eid.startswith("-") else "-" + eid
        rev = edges.get(rev_id)
        if rev is not None and (rev["from"] != e["to"] or rev["to"] != e["from"]):
            rev = None
        fwd, bwd = e, rev
        if bwd is not None and eid.startswith("-"):
            fwd, bwd = rev, e
        used.add(fwd["id"]);
        if bwd is not None: used.add(bwd["id"])
        r = Road()
        r.fwd, r.bwd = fwd, bwd
        r.osm_id = fwd["osmId"]
        tags = osm_ways.get(r.osm_id, (None, {}))[1] if r.osm_id is not None else {}
        r.name = fwd["name"] or tags.get("name", "")
        r.hw = highway_class(fwd["type"])
        r.prio = PRIORITY.get(base_class(r.hw), 1)
        r.bridge = tags.get("bridge", "no") not in ("no",) and tags.get("bridge") is not None
        r.tunnel = tags.get("tunnel", "no") not in ("no",) and tags.get("tunnel") is not None
        r.frm, r.to = fwd["from"], fwd["to"]
        r.Wf = edge_width(fwd)
        r.Wb = edge_width(bwd) if bwd is not None else 0.0
        l0 = fwd["lanes"][0]
        lane0 = resample(l0["shape"], 4.0)
        if len(lane0) < 2:
            continue
        if bwd is not None:
            d = r.Wf - l0["width"] / 2  # левая граница прямого ребра = ось дороги
        else:
            d = r.Wf / 2 - l0["width"] / 2
        r.axis = offset(lane0, d)
        roads.append(r)
    for i, r in enumerate(roads):
        r.id = i
    return roads


def junction_heights(net, roads, grid, h0, ub=None, lb=None):
    """Высоты перекрёстков: среднее сглаженного рельефа по площадке; узлы, к которым примыкают только мосты,
    интерполируются по мостам; затем ограничение уклона между перекрёстками."""
    jids = sorted({r.frm for r in roads} | {r.to for r in roads})
    jix = {j: i for i, j in enumerate(jids)}
    z = np.zeros(len(jids))
    for j, i in jix.items():
        J = net.junctions[j]
        pts = [(J["x"], J["y"])]
        if J["shape"] is not None and len(J["shape"]) >= 3:
            pts += [tuple(p) for p in J["shape"]]
        pts = np.array(pts)
        z[i] = grid.sample_bilinear(h0, pts[:, 0], pts[:, 1]).mean()
    a = np.array([jix[r.frm] for r in roads]); b = np.array([jix[r.to] for r in roads])
    L = np.array([max(cumlen(r.axis)[-1], 1.0) + 0.0 for r in roads])
    is_br = np.array([r.bridge for r in roads])
    g = np.array([BRIDGE_GRADE if r.bridge else MAX_GRADE.get(base_class(r.hw), 0.12) for r in roads])
    # узлы только с мостами
    has_ground = np.zeros(len(jids), bool)
    has_ground[a[~is_br]] = True; has_ground[b[~is_br]] = True
    floating = ~has_ground
    if floating.any() and is_br.any():
        ab, bb, wb = a[is_br], b[is_br], 1.0 / L[is_br]
        for _ in range(500):
            num = np.zeros(len(jids)); den = np.zeros(len(jids))
            np.add.at(num, ab, wb * z[bb]); np.add.at(den, ab, wb)
            np.add.at(num, bb, wb * z[ab]); np.add.at(den, bb, wb)
            upd = floating & (den > 0)
            z[upd] = num[upd] / den[upd]
    ubv = np.full(len(jids), np.inf)
    for j, v in (ub or {}).items():
        ubv[jix[j]] = v
    lbv = np.full(len(jids), -np.inf)   # нижние границы: опоры мостов над ж/д и водой (world/structures.py)
    for j, v in (lb or {}).items():
        if j in jix:
            lbv[jix[j]] = v
    z = np.minimum(np.maximum(z, lbv), ubv)
    # ограничение уклона (проекция, Якоби)
    for _ in range(600):
        dz = z[b] - z[a]
        exc = np.abs(dz) - g * L
        m = exc > 1e-3
        if not m.any():
            break
        corr = np.zeros(len(jids)); cnt = np.zeros(len(jids))
        s = np.sign(dz[m]) * exc[m] * 0.5
        np.add.at(corr, a[m], s); np.add.at(cnt, a[m], 1)
        np.add.at(corr, b[m], -s); np.add.at(cnt, b[m], 1)
        cnt[cnt == 0] = 1
        z += corr / cnt
        z = np.minimum(np.maximum(z, lbv), ubv)
    return {j: z[i] for j, i in jix.items()}, floating, jix


OVERPASS_CLEARANCE = 5.5   # м от дороги внизу до верха настила


def bridge_crossings(roads):
    """Для мостов: точки пересечения с наземными дорогами под ними -> r.cross = [(s_on_bridge, z_needed)]."""
    from shapely.geometry import LineString
    from shapely.strtree import STRtree
    ground = [r for r in roads if not r.bridge]
    lines = [LineString(r.axis) for r in ground]
    tree = STRtree(lines)
    n = 0
    for b in roads:
        if not b.bridge:
            continue
        b.cross = []
        bl = LineString(b.axis)
        for i in tree.query(bl, predicate="intersects"):
            g = ground[i]
            if g.frm in (b.frm, b.to) or g.to in (b.frm, b.to):
                continue  # примыкает к мосту, а не проходит под ним
            x = bl.intersection(lines[i])
            for pt in getattr(x, "geoms", [x]):
                if pt.geom_type != "Point":
                    continue
                sg = lines[i].project(pt)
                zg = float(np.interp(sg, g.s_axis, g.z_axis))
                b.cross.append((bl.project(pt), zg + OVERPASS_CLEARANCE, g, sg))
                n += 1
    return n


def bridge_profile(r, zj, step=2.0):
    """Настил: линейно между опорами; над дорогами снизу поднимается «шатром» с уклоном BRIDGE_GRADE,
    не круче BRIDGE_GRADE от концов."""
    P = resample(r.axis, step)
    s = cumlen(P)
    L = max(s[-1], 1e-6)
    zA, zB = zj[r.frm], zj[r.to]
    z = zA + (zB - zA) * s / L
    cross = getattr(r, "cross", [])
    if cross:
        g = BRIDGE_GRADE
        tent = np.max([cz - g * np.abs(s - cs) for cs, cz, *_ in cross], axis=0)
        cap = np.minimum(zA + g * s, zB + g * (L - s))
        z = np.maximum(z, np.minimum(tent, cap))
        r.clearance_ok = all(np.interp(cs, s, z) >= cz - 0.3 for cs, cz, *_ in cross)
    r.axis, r.z_axis, r.s_axis = P, z, s
    return P, z


def dig_underpasses(roads, zj):
    """Если мост не набрал габарит, опускаем дорогу под ним (с уклоном её класса).
    Возвращает (число правок, верхние границы высот перекрёстков, задетых выемкой)."""
    n = 0
    ub = {}
    for b in roads:
        for cs, cz, g, sg in getattr(b, "cross", None) or []:
            target = float(np.interp(cs, b.s_axis, b.z_axis)) - OVERPASS_CLEARANCE
            zg = float(np.interp(sg, g.s_axis, g.z_axis))
            if zg > target + 0.05:
                gr = MAX_GRADE.get(base_class(g.hw), 0.12)
                g.z_axis = np.minimum(g.z_axis, target + gr * np.abs(g.s_axis - sg))
                n += 1
                for j, zz in ((g.frm, g.z_axis[0]), (g.to, g.z_axis[-1])):
                    if zz < zj[j] - 0.05:
                        ub[j] = min(ub.get(j, 1e9), float(zz))
    return n, ub


def road_profile(r, zj, grid, h0, step=2.0, sigma_m=12.0):
    """Профиль высоты вдоль оси: сглаженный рельеф, концы на высотах перекрёстков, ограничение уклона.
    Мосты: линейная интерполяция между опорами."""
    P = resample(r.axis, step)
    s = cumlen(P)
    zA, zB = zj[r.frm], zj[r.to]
    t = s / max(s[-1], 1e-6)
    if r.bridge:
        z = zA + (zB - zA) * t
    else:
        z0 = grid.sample_bilinear(h0, P[:, 0], P[:, 1])
        ds = s[-1] / max(len(s) - 1, 1)
        zs = gaussian_filter1d(z0, sigma_m / max(ds, 0.5), mode="nearest") if len(z0) > 3 else z0
        z = zs + (zA - zs[0]) * (1 - t) + (zB - zs[-1]) * t
        g = MAX_GRADE.get(base_class(r.hw), 0.12)
        z = clamp_grade(z, s, g)
    r.axis, r.z_axis, r.s_axis = P, z, s
    return P, z


def clamp_grade(z, s, g):
    z = z.copy()
    n = len(z)
    if n < 3:
        return z
    ds = np.diff(s)
    for _ in range(3):
        for i in range(1, n - 1):
            lim = g * ds[i - 1]
            z[i] = min(max(z[i], z[i - 1] - lim), z[i - 1] + lim)
        for i in range(n - 2, 0, -1):
            lim = g * ds[i]
            z[i] = min(max(z[i], z[i + 1] - lim), z[i + 1] + lim)
    return z


def junction_polygon(J):
    if J["shape"] is None or len(J["shape"]) < 3:
        return None
    p = Polygon(J["shape"])
    if not p.is_valid:
        p = make_valid(p)
        p = max(getattr(p, "geoms", [p]), key=lambda g: g.area if g.geom_type == "Polygon" else 0)
        if p.geom_type != "Polygon":
            return None
    return p if p.area > 0.5 else None
