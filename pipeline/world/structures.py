"""Высотная структура дорог и инженерные сооружения (docs/stage2/terrain-v2.md).

1. bridge_lower_bounds(): нижние границы высот перекрёстков у мостов над ж/д и водотоками — путепровод
   над рельсами получает габарит (иначе настил лежит на земле), подходы поднимаются насыпями с уклоном класса.
2. build(): классификация каждой дороги по участкам (ground / embankment / cutting / bridge / tunnel,
   + точки пересечения с водотоками в трубе — culvert) -> roads/structures.json, и визуал в ноду `bridges`:
   опоры (колонны + ригель), устои, консоли тротуаров, ограждения (`bridge_railing`), подпорные стены
   (`retaining_wall`). Ограждения, опоры и устои — коллайдеры (нода `bridge_colliders`). Ж/д мосты строит
   world/railways.py (отдельный агент); здесь они только размечают дороги под ними как underpass.
3. open_under_rail() — проём под путепроводами над ж/д (правка итогового H до построения мешей).
"""
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import shapely
from shapely import affinity
from shapely.geometry import LineString, Point, box
from shapely.strtree import STRtree

from config import ROOT
from . import bridges as BR
from .gltf import fix_winding
from .roads import base_class, cumlen, left_normals, resample

RAIL_CLEAR = 7.3        # м: поверхность дороги на путепроводе над головкой рельса (6.5 контактная сеть + 0.8 плита)
WATER_CLEAR = 2.5       # м: над урезом водотока (малые мосты)
PIER_SPAN = 28.0        # м: шаг опор балочных пролётов
PIER_MIN_CLEAR = 2.5    # м: ниже — опор нет (плита на насыпи/низко)
RAIL_H = 1.1            # м: высота ограждения
RAIL_T = 0.15           # м: толщина ограждения
SW_WIDTH = {"primary": 3.0, "secondary": 3.0, "tertiary": 2.5, "unclassified": 2.0, "residential": 2.0}
CUT_MIN = 2.2           # м: подпорная стена, если рельеф в 8 м за кромкой выше дороги на столько
EMB_MIN = 2.0           # м: насыпь / выемка по разнице дорога − рельеф по сторонам
SIDE_PROBE = 14.0       # м за кромкой: «рельеф по сторонам» (за обочиной вжатия 1 + 8 м)


def load_segments():
    p = ROOT / "data" / "overrides" / "elevation.json"
    return json.loads(p.read_text(encoding="utf-8")).get("segments", []) if p.exists() else []


def _hw(r):
    """(правая, левая) полуширина проезжей части от оси дороги."""
    if r.bwd is not None:
        return r.Wf, r.Wb
    return r.Wf / 2, r.Wf / 2


# ---------------------------------------------------------------- 1. нижние границы опор
def bridge_lower_bounds(roads, osm, grid, h1, log=print):
    """{junction: z_min} для концов мостов над ж/д (RAIL_CLEAR) и водотоками (WATER_CLEAR)."""
    rails, waters = [], []
    for wid, (refs, tg) in osm.ways.items():
        if tg.get("railway") in ("rail", "light_rail", "narrow_gauge") and tg.get("tunnel") in (None, "no") \
                and tg.get("bridge") in (None, "no"):
            P = osm.way_xy(wid)
            if len(P) > 1:
                rails.append((wid, LineString(P)))
        elif tg.get("waterway") in ("river", "stream", "canal") and tg.get("tunnel") in (None, "no"):
            P = osm.way_xy(wid)
            if len(P) > 1:
                waters.append((wid, LineString(P)))
    lb, recs = {}, []
    BR.RAIL_S.clear(); RAIL_X.clear(); OVER.clear()
    for kind, lines, clear in (("rail", rails, RAIL_CLEAR), ("water", waters, WATER_CLEAR)):
        if not lines:
            continue
        tree = STRtree([l for _, l in lines])
        for r in roads:
            if not r.bridge:
                continue
            bl = LineString(r.axis)
            L = bl.length
            for i in tree.query(bl, predicate="intersects"):
                wid, ln = lines[i]
                x = bl.intersection(ln)
                for pt in getattr(x, "geoms", [x]):
                    if pt.geom_type != "Point":
                        continue
                    sc = bl.project(pt)
                    so = ln.project(pt)
                    ss = np.clip(np.arange(so - 25, so + 26, 5.0), 0, ln.length)
                    q = np.array([ln.interpolate(v).coords[0] for v in ss])
                    z0 = float(grid.sample_bilinear(h1, q[:, 0], q[:, 1]).min())
                    need = z0 + clear
                    for j, d in ((r.frm, sc), (r.to, L - sc)):
                        v = need - BR.BRIDGE_GRADE * d
                        lb[j] = max(lb.get(j, -1e9), v)
                    rec = {"kind": kind, "osm_bridge": int(r.osm_id or 0), "osm_crossed": int(wid),
                           "xy": [round(pt.x, 1), round(pt.y, 1)], "z_under": round(z0, 2), "z_need": round(need, 2)}
                    if kind == "rail" and min(sc, L - sc) >= BR.RAIL_KEEP + 2.0:
                        BR.RAIL_S.setdefault(r.id, []).append(sc)   # пролёт над путями: без насыпи у пересечения
                        RAIL_X.append((r, sc, ln, so, z0))
                    recs.append(rec)
                    OVER[r.id].append({"type": kind, "osm": int(wid), "s": round(sc, 1)})
    log(f"сооружения: нижние границы опор мостов — пересечений с ж/д {sum(r['kind'] == 'rail' for r in recs)}, "
        f"с водотоками {sum(r['kind'] == 'water' for r in recs)}, узлов {len(lb)}")
    return lb, recs


OVER = defaultdict(list)   # r.id моста -> что под ним (ж/д, водоток); дороги снизу — из r.cross
RAIL_X = []   # (мост, s на мосту, линия ж/д, s на ж/д, уровень пути) — для open_under_rail


def open_under_rail(H, grid, roads, half_rail=3.5):
    """Проём под путепроводом над ж/д: в коридоре пути (± half_rail) под настилом рельеф не выше уровня пути
    (FABDEM размывает насыпи подходов, и путь оказывается «засыпан»). Наземные дороги не трогаются;
    поверхность моста над проёмом = настил (коллайдер — плита моста)."""
    if not RAIL_X:
        return H
    ground = [LineString(r.axis).buffer((max(_hw(r)) + 1.0), cap_style="flat") for r in roads if not r.bridge]
    gt = STRtree(ground)
    xs, ys = grid.node_xy()
    H = H.copy()
    n = 0
    for r, sc, ln, so, z0 in RAIL_X:
        hr, hl = _hw(r)
        reach = max(hr, hl) + 4.0
        ss = np.arange(so - reach * 2, so + reach * 2 + 0.1, 1.0)
        q = np.array([ln.interpolate(v).coords[0] for v in np.clip(ss, 0, ln.length)])
        bl = LineString(r.axis)
        dq = shapely.distance(bl, shapely.points(q))
        q = q[dq <= reach]
        if not len(q):
            continue
        x0, y0 = q.min(0) - half_rail - 5; x1, y1 = q.max(0) + half_rail + 5
        ci = np.where((xs >= x0) & (xs <= x1))[0]; ri = np.where((ys >= y0) & (ys <= y1))[0]
        gx, gy = np.meshgrid(xs[ci], ys[ri])
        pts = np.c_[gx.ravel(), gy.ravel()]
        from scipy.spatial import cKDTree
        d, _ = cKDTree(q).query(pts)
        m = d <= half_rail
        if m.any():
            P = shapely.points(pts[m])
            hit = np.zeros(m.sum(), bool)
            for i in gt.query(shapely.MultiPoint(pts[m]).envelope):
                hit |= shapely.intersects(ground[i], P)
            idx = np.where(m)[0][~hit]
            sub = H[np.ix_(ri, ci)].ravel()
            sub[idx] = np.minimum(sub[idx], z0)
            H[np.ix_(ri, ci)] = sub.reshape(len(ri), len(ci))
            n += len(idx)
    return H


# ---------------------------------------------------------------- геометрия
class Mesh:
    def __init__(self, tiles, tile_key, base):
        self.tiles, self.tile_key, self.base = tiles, tile_key, base
        self.n = Counter()

    def _g(self, x, y, z):
        return np.c_[x, np.asarray(z) - self.base, -np.asarray(y)]

    def quad(self, node, mat, key, P4, want, uv=None):
        P = np.asarray(P4, float)
        T = fix_winding(P, np.array([[0, 1, 2], [0, 2, 3]]), want)
        if mat is None:
            self.tiles[key][node][None].add(P, T)
        else:
            nn = want / (np.linalg.norm(want) or 1)
            self.tiles[key][node][mat].add(P, T, np.tile(nn, (4, 1)), uv)

    def prism(self, node, mat, key, ring_xy, z0, z1, collider=False):
        """Вертикальная призма по контуру ring_xy (против часовой), низ z0, верх z1 (абсолютные)."""
        ring = np.asarray(ring_xy, float)
        c = ring.mean(0)
        k = len(ring)
        per = 0.0
        for i in range(k):
            a, b = ring[i], ring[(i + 1) % k]
            L = float(np.hypot(*(b - a)))
            P = np.r_[self._g([a[0], b[0], b[0], a[0]], [a[1], b[1], b[1], a[1]], [z0, z0, z1, z1])]
            out = np.r_[(a + b) / 2 - c, 0.0]
            want = np.array([out[0], 0.0, -out[1]])
            uv = np.array([[per, 0], [per + L, 0], [per + L, z1 - z0], [per, z1 - z0]])
            self.quad(node, mat, key, P, want, uv)
            if collider:
                self.quad("bridge_colliders", None, key, P, want)
            per += L
        for zz, up in ((z1, 1.0), (z0, -1.0)):
            P = self._g(ring[:, 0], ring[:, 1], np.full(k, zz))
            T = np.array([[0, i, i + 1] for i in range(1, k - 1)])
            T = fix_winding(P, T, np.array([0, up, 0]))
            if mat is not None:
                self.tiles[key][node][mat].add(P, T, np.tile([0, up, 0], (k, 1)), np.c_[ring[:, 0], -ring[:, 1]])
            if collider:
                self.tiles[key]["bridge_colliders"][None].add(P, T)

    def wall(self, node, mat, L, R, zb, zt, thick, collider=False, uv_scale=1.0):
        """Стенка вдоль ломаной (L — линия, zb/zt — низ/верх в узлах), толщина thick (в обе стороны поровну).
        Режется по тайлам по середине сегмента."""
        n = left_normals(L) * (thick / 2)
        A = L + n; B = L - n
        s = cumlen(L)
        for i in range(len(L) - 1):
            mid = (L[i] + L[i + 1]) / 2
            key = self.tile_key(*mid)
            ia, ib = i, i + 1
            faces = []
            for side, Q in ((1, A), (-1, B)):
                P = self._g([Q[ia, 0], Q[ib, 0], Q[ib, 0], Q[ia, 0]], [Q[ia, 1], Q[ib, 1], Q[ib, 1], Q[ia, 1]],
                            [zb[ia], zb[ib], zt[ib], zt[ia]])
                nn = n[ia] * side
                want = np.array([nn[0], 0.0, -nn[1]])
                uv = np.array([[s[ia], zb[ia]], [s[ib], zb[ib]], [s[ib], zt[ib]], [s[ia], zt[ia]]]) * uv_scale
                faces.append((P, want, uv))
            Pt = self._g([A[ia, 0], A[ib, 0], B[ib, 0], B[ia, 0]], [A[ia, 1], A[ib, 1], B[ib, 1], B[ia, 1]],
                         [zt[ia], zt[ib], zt[ib], zt[ia]])
            faces.append((Pt, np.array([0, 1.0, 0]), np.array([[s[ia], 0], [s[ib], 0], [s[ib], thick], [s[ia], thick]])))
            Pb = self._g([A[ia, 0], A[ib, 0], B[ib, 0], B[ia, 0]], [A[ia, 1], A[ib, 1], B[ib, 1], B[ia, 1]],
                         [zb[ia], zb[ib], zb[ib], zb[ia]])
            faces.append((Pb, np.array([0, -1.0, 0]), np.array([[s[ia], 0], [s[ib], 0], [s[ib], thick], [s[ia], thick]])))
            for P, want, uv in faces:
                self.quad(node, mat, key, P, want, uv)
                if collider:
                    self.quad("bridge_colliders", None, key, P, want)
            if i == 0 or i == len(L) - 2:   # торцы
                j = ia if i == 0 else ib
                P = self._g([A[j, 0], B[j, 0], B[j, 0], A[j, 0]], [A[j, 1], B[j, 1], B[j, 1], A[j, 1]], [zb[j], zb[j], zt[j], zt[j]])
                d = (L[j] - L[ib if i == 0 else ia])
                self.quad(node, mat, key, P, np.array([d[0], 0.0, -d[1]]), np.array([[0, 0], [thick, 0], [thick, 1], [0, 1]]))
            self.n[mat] += 1


def octagon(c, r):
    a = np.arange(8) * np.pi / 4 + np.pi / 8
    return np.c_[c[0] + r * np.cos(a), c[1] + r * np.sin(a)]


def rect(c, t, n, half_t, half_n):
    """Прямоугольник с центром c, осью t (вдоль) и n (поперёк)."""
    return np.array([c - t * half_t - n * half_n, c + t * half_t - n * half_n, c + t * half_t + n * half_n,
                     c - t * half_t + n * half_n])


# ---------------------------------------------------------------- 2. классификация и визуал
def _runs(mask):
    out, i = [], 0
    while i < len(mask):
        if mask[i]:
            j = i
            while j + 1 < len(mask) and mask[j + 1]:
                j += 1
            out.append((i, j))
            i = j + 1
        else:
            i += 1
    return out


def build(ctx, out_dir, log=print):
    roads, osm, grid, H = ctx["roads"], ctx["osm"], ctx["grid"], ctx["H"]
    base, lift = ctx["base"], ctx["lift"]
    M = Mesh(ctx["tiles"], ctx["tile_key"], base)
    st = Counter()
    segs = load_segments()
    seg_lines = []
    for sg in segs:
        from .terrain_v2 import segment_xy
        P = segment_xy(osm, sg)
        if P is not None:
            seg_lines.append((sg, LineString(P)))

    # водотоки в трубе (точки пересечения = culvert)
    culv = []
    for wid, (refs, tg) in osm.ways.items():
        if tg.get("waterway") and tg.get("tunnel") in ("culvert", "yes"):
            P = osm.way_xy(wid)
            if len(P) > 1:
                culv.append(LineString(P))
    culv_tree = STRtree(culv) if culv else None

    # коридоры наземных дорог (опоры в них не ставим)
    ground_polys = []
    for r in roads:
        if not r.bridge:
            hr, hl = _hw(r)
            ground_polys.append(LineString(r.axis).buffer(max(hr, hl) + 1.5, cap_style="flat"))
    for wid, (refs, tg) in osm.ways.items():   # и пути ж/д (габарит 3 м от оси)
        if tg.get("railway") in ("rail", "light_rail", "narrow_gauge") and tg.get("bridge") in (None, "no"):
            Pr = osm.way_xy(wid)
            if len(Pr) > 1:
                ground_polys.append(LineString(Pr).buffer(3.0, cap_style="flat"))
    gtree = STRtree(ground_polys)

    def free(poly):
        return not any(ground_polys[i].intersects(poly) for i in gtree.query(poly))

    # что проходит над дорогой: пролёты мостов-дорог и ж/д мосты (railway + bridge) -> класс underpass
    over = []
    for b in roads:
        if b.bridge:
            hr_, hl_ = _hw(b)
            span = ~b.embank
            for i0, i1 in _runs(span):
                if i1 > i0:
                    over.append(("road", b.osm_id, LineString(b.axis[i0:i1 + 1]), max(hr_, hl_)))
    for wid, (refs, tg) in osm.ways.items():
        if tg.get("railway") in ("rail", "light_rail", "narrow_gauge", "tram") and tg.get("bridge") not in (None, "no"):
            Pr = osm.way_xy(wid)
            if len(Pr) > 1:
                over.append(("rail", wid, LineString(Pr), 3.0))
    otree = STRtree([o[2] for o in over]) if over else None

    edges_out = []
    for r in roads:
        P, z, s = r.axis, r.z_axis, r.s_axis
        n = len(P)
        cls = np.array(["ground"] * n, dtype=object)
        hr, hl = _hw(r)
        tg = osm.ways.get(r.osm_id, (None, {}))[1] if r.osm_id is not None else {}
        nrm = left_normals(P)
        if r.bridge:
            cls[:] = "bridge"
            cls[r.embank] = "embankment"
        elif r.tunnel:
            cls[:] = "tunnel"
        else:
            zl = grid.sample_bilinear(H, *(P + nrm * (hl + SIDE_PROBE)).T)
            zr = grid.sample_bilinear(H, *(P - nrm * (hr + SIDE_PROBE)).T)
            hi = np.minimum(zl, zr) - z; lo = z - np.maximum(zl, zr)
            from scipy.ndimage import uniform_filter1d
            hi = uniform_filter1d(hi, 5); lo = uniform_filter1d(lo, 5)
            cls[lo > EMB_MIN] = "embankment"
            cls[hi > EMB_MIN] = "cutting"
            if tg.get("embankment") == "yes":
                cls[:] = "embankment"
            if tg.get("cutting") == "yes":
                cls[:] = "cutting"
        # участки из оверрайдов
        rl = LineString(P)
        for sg, ln in seg_lines:
            if sg.get("way") != r.osm_id or not rl.intersects(ln.buffer(3.0)):
                continue
            d = shapely.distance(shapely.points(P), ln)
            cls[d < 3.0] = sg.get("class", "embankment")
        # под пролётами (дорога под мостом / ж/д мостом)
        under = []
        if otree is not None and not r.bridge:
            for i in otree.query(rl, predicate="intersects"):
                kind, oid, ln, ohw = over[i]
                if kind == "road" and oid == r.osm_id:
                    continue
                x = rl.intersection(ln)
                for pt in getattr(x, "geoms", [x]):
                    if pt.geom_type != "Point":
                        continue
                    sc = rl.project(pt)
                    cls[np.abs(s - sc) < ohw + 3.0] = "underpass"
                    under.append({"type": kind, "osm": int(oid or 0), "s": round(sc, 1)})
        # трубы под дорогой
        cv = []
        if culv_tree is not None and not r.bridge:
            for i in culv_tree.query(rl, predicate="intersects"):
                x = rl.intersection(culv[i])
                for pt in getattr(x, "geoms", [x]):
                    if pt.geom_type == "Point":
                        sc = rl.project(pt)
                        cv.append([round(pt.x, 1), round(float(np.interp(sc, s, z)) - base + lift, 2), round(-pt.y, 1)])
        spans = []
        i = 0
        while i < n:
            j = i
            while j + 1 < n and cls[j + 1] == cls[i]:
                j += 1
            spans.append([round(float(s[i]), 1), round(float(s[j]), 1), cls[i]])
            i = j + 1
        lens = Counter()
        for a, b, c in spans:
            lens[c] += b - a
        for c, v in lens.items():
            st["km_" + c] += v / 1000
        dom = max(lens, key=lens.get) if lens else "ground"
        if r.bridge:
            dom = "bridge"
        rec = {"id": r.id, "osmId": r.osm_id, "name": r.name, "highway": r.hw, "class": dom,
               "spans": spans if len(spans) > 1 or spans[0][2] != "ground" else []}
        if r.bridge:
            rec["bridgeType"] = tg.get("bridge", "yes")
            ov = [{"type": "road", "osm": int(g.osm_id or 0), "s": round(float(cs), 1)} for cs, cz, g, sg in (getattr(r, "cross", None) or [])]
            ov += OVER.get(r.id, [])
            rec["over"] = ov
            rec["kind"] = ("overpass" if any(o["type"] in ("road", "rail") for o in ov) else
                           "viaduct" if tg.get("bridge") == "viaduct" or rec["spans"] and sum(b - a for a, b, c in spans if c == "bridge") > 150
                           else "bridge")
            st["bridge_" + rec["kind"]] += 1
        if under:
            rec["under"] = under
            st["underpass_crossings"] += len(under)
        if cv:
            rec["culverts"] = cv
            st["culverts"] += len(cv)
        edges_out.append(rec)

        # ---------- визуал моста
        if r.bridge:
            _bridge_visual(r, tg, ctx, M, st, free)
        else:
            _walls_visual(r, tg, cls, ctx, M, st, seg_lines)

    out = {"version": 1, "classes": ["ground", "embankment", "cutting", "bridge", "underpass", "tunnel"],
           "edges": edges_out,
           "stats": {k: (round(v, 2) if isinstance(v, float) else v) for k, v in st.items()}}
    p = Path(out_dir) / "roads" / "structures.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in st.items()}


def _deck_edges(r, tg, pad_default=0.4):
    """Внешние кромки настила (правая, левая) с учётом тротуаров по тегам: смещения от оси."""
    from .sidewalks import side_tags
    hr, hl = _hw(r)
    sides = side_tags(tg)
    if r.fwd["id"].startswith("-"):
        sides = {"left": sides["right"], "right": sides["left"]}
    sw = SW_WIDTH.get(base_class(r.hw), 1.5)
    er = hr + (sw if sides["right"] == "yes" else pad_default)
    el = hl + (sw if sides["left"] == "yes" else pad_default)
    return er, el, hr, hl


def _bridge_visual(r, tg, ctx, M, st, free):
    grid, H, base, lift = ctx["grid"], ctx["H"], ctx["base"], ctx["lift"]
    P, s = r.axis, r.s_axis
    nrm = left_normals(P)
    er, el, hr, hl = _deck_edges(r, tg)
    # поверхность настила по оси (абсолютная) и низ плиты
    ztop = BR.surface(r, s, P[:, 0], P[:, 1], H, grid, base, lift) + base - lift
    th = BR.slab_thickness(r, s, 0.8)
    zbot = ztop - th
    ground = grid.sample(H, P[:, 0], P[:, 1])
    span = ~r.embank
    st["bridges"] += 1
    # консоли тротуаров / бордюрные полосы: от кромки проезжей части до кромки настила (плита 0.5 м)
    for side, e0, e1 in ((-1, hr, er), (1, hl, el)):
        A = P + nrm * side * e0; B_ = P + nrm * side * e1
        mid = (A + B_) / 2
        M.wall("bridges", "bridge_concrete", mid, None, zbot + th - 0.5, ztop - 0.02, abs(e1 - e0))
        # ограждение по внешней кромке (на всём мосту, включая насыпь у опор — там оно сходит на нет по высоте)
        Lr = P + nrm * side * (e1 - RAIL_T / 2)
        rail_h = np.where(span, RAIL_H, np.clip((ztop - ground) / 1.0, 0, 1) * RAIL_H)
        keep = rail_h > 0.15
        for i0, i1 in _runs(keep):
            if i1 - i0 < 1:
                continue
            sl = slice(i0, i1 + 1)
            M.wall("bridges", "bridge_railing", Lr[sl], None, ztop[sl] - 0.05, ztop[sl] + rail_h[sl], RAIL_T, collider=True)
            st["railing_m"] += float(s[i1] - s[i0])
    # опоры
    t_all = np.gradient(P, axis=0)
    t_all /= np.maximum(np.hypot(*t_all.T), 1e-9)[:, None]
    for i0, i1 in _runs(span):
        Ls = s[i1] - s[i0]
        # устои на границах пролёта с насыпью
        for k, inward in ((i0, 1), (i1, -1)):
            if (k == i0 and i0 == 0) or (k == i1 and i1 == len(P) - 1):
                continue   # конец моста на висячем узле: устоя нет
            h = zbot[k] - ground[k]
            if h < 1.0:
                continue
            c = P[k] + t_all[k] * inward * 0.5
            ring = rect(c, t_all[k], nrm[k], 0.5, (er + el) / 2 + 0.5)
            ring = ring + nrm[k] * (el - er) / 2
            M.prism("bridges", "bridge_concrete", ctx["tile_key"](*c), ring, ground[k] - 0.5, zbot[k], collider=True)
            st["abutments"] += 1
        if Ls < 12:
            continue
        npier = int(Ls // PIER_SPAN)
        for q in range(1, npier + 1):
            sp = s[i0] + Ls * q / (npier + 1)
            placed = False
            for shift in (0, 4, -4, 8, -8, 12, -12):
                sq = sp + shift
                if not (s[i0] + 3 < sq < s[i1] - 3):
                    continue
                k = int(np.clip(np.searchsorted(s, sq), 0, len(s) - 1))
                if zbot[k] - ground[k] < PIER_MIN_CLEAR:
                    continue
                c = P[k]
                foot = shapely.Polygon(rect(c, t_all[k], nrm[k], 1.0, (hr + hl) / 2).tolist()).buffer(0.3)
                foot = affinity.translate(foot, *(nrm[k] * (hl - hr) / 2))
                if not free(foot):
                    continue
                _pier(M, ctx, c, t_all[k], nrm[k], -hr, hl, ground[k], zbot[k])
                placed = True
                break
            st["piers" if placed else "piers_skipped"] += 1


def _pier(M, ctx, c, t, n, off_r, off_l, zg, zb):
    """Опора: колонны (восьмигранник Ø 1.2 м) через ≤ 6 м поперёк + ригель 1.6×1.0 м под плитой."""
    W = off_l - off_r
    ncol = 1 if W < 7 else int(math.ceil((W - 2.0) / 6.0)) + 1
    offs = [0.5 * (off_l + off_r)] if ncol == 1 else list(np.linspace(off_r + 1.2, off_l - 1.2, ncol))
    cap_h = 1.0
    key = ctx["tile_key"](*c)
    for o in offs:
        cc = c + n * o
        M.prism("bridges", "bridge_concrete", key, octagon(cc, 0.6), zg - 0.5, zb - cap_h, collider=True)
    ring = rect(c + n * 0.5 * (off_l + off_r), t, n, 0.8, W / 2 - 0.2)
    M.prism("bridges", "bridge_concrete", key, ring, zb - cap_h, zb - 0.01)


def _walls_visual(r, tg, cls, ctx, M, st, seg_lines):
    """Подпорные стены вдоль выемок и откосов круче CUT_MIN; дамбы из оверрайдов — стены и ограждение."""
    grid, H, base, lift = ctx["grid"], ctx["H"], ctx["base"], ctx["lift"]
    P, z, s = r.axis, r.z_axis, r.s_axis
    nrm = left_normals(P)
    er, el, hr, hl = _deck_edges(r, tg, pad_default=0.8)
    zroad = grid.sample(H, P[:, 0], P[:, 1])
    # дамбы (оверрайды с railing/walls)
    for sg, ln in seg_lines:
        if sg.get("way") != r.osm_id:
            continue
        d = shapely.distance(shapely.points(P), ln)
        on = d < 3.0
        for i0, i1 in _runs(on):
            if i1 - i0 < 2:
                continue
            sl = slice(i0, i1 + 1)
            from .sidewalks import side_tags
            sides = side_tags(tg)
            if r.fwd["id"].startswith("-"):
                sides = {"left": sides["right"], "right": sides["left"]}
            for side, e, nm in ((-1, er, "right"), (1, el, "left")):
                if sides[nm] != "yes":
                    continue   # внутренняя сторона раздельной проезжей части — без ограждения
                Lr = P[sl] + nrm[sl] * side * (e + 0.3)
                ztop = grid.sample(H, Lr[:, 0], Lr[:, 1]) + 0.15
                if sg.get("railing"):
                    M.wall("bridges", "bridge_railing", Lr, None, ztop - 0.05, ztop + RAIL_H, RAIL_T, collider=True)
                    st["railing_m"] += float(s[i1] - s[i0])
                if sg.get("walls"):
                    out = P[sl] + nrm[sl] * side * (e + 6.0)
                    zlow = grid.sample(H, out[:, 0], out[:, 1])
                    Lw = P[sl] + nrm[sl] * side * (e + 0.9)
                    M.wall("bridges", "retaining_wall", Lw, None, np.minimum(zlow, ztop) - 0.5, ztop + 0.05, 0.6)
                    st["retaining_wall_m"] += float(s[i1] - s[i0])
    # выемки: стены по сторонам, где рельеф за кромкой выше дороги
    if base_class(r.hw) not in ("primary", "secondary", "tertiary", "unclassified", "residential") and \
            not any(c == "cutting" for c in cls):
        return
    for side, e in ((-1, er), (1, el)):
        Lw = P + nrm * side * (e + 0.6)
        far = P + nrm * side * (e + 8.0)
        zfar = grid.sample(H, far[:, 0], far[:, 1])
        rise = zfar - zroad
        from scipy.ndimage import uniform_filter1d
        rise = uniform_filter1d(rise, 5)
        mask = rise > CUT_MIN
        for i0, i1 in _runs(mask):
            if s[i1] - s[i0] < 16:
                continue
            sl = slice(i0, i1 + 1)
            top = np.minimum(zfar[sl], zroad[sl] + 6.0)
            M.wall("bridges", "retaining_wall", Lw[sl], None, zroad[sl] - 0.3, top, 0.5)
            st["retaining_wall_m"] += float(s[i1] - s[i0])
            st["retaining_walls"] += 1
