"""Пешеходные улицы «от стены до стены» (Почтовая — «рязанский Арбат»).

Путь OSM highway=pedestrian (линия) с тегом nfr:pedestrian_street=yes (ставится правкой в data/overrides/roads.json)
превращается в:
- полигон улицы от стены до стены: лучи от оси до ближайших зданий (≤ MAX_HALF), проёмы между домами — по соседним
  стенам; здания вычитаются (zones, вызывается из yards.collect). Это площадка `area_paving_pedestrian` (приоритет выше
  всех площадок); тротуаров, бордюров и разметки внутри нет — их строят только автодороги, а highway=pedestrian не
  автодорога (osm.car_ways), поэтому в SUMO / traffic/net.json путь не попадает;
- витрины вдоль неё (mark_facades: фасады, смотрящие в зону, — «улица» ранга 6, плотные витрины);
- обстановку (furnish, из streetlife.run): скульптуры (OSM), кафе-террасы у кафе/ресторанов, ряды «дерево в решётке —
  фонарь lamp_classic — лавка с урной / вазон», киоски, боллards на въездах с автодорог (просвет 2.5 м — машина игрока
  проезжает);
- плотную пешеходную сеть (walk_export: решётка 5 м, зона pedestrian_street) и POI «уличный музыкант» / «компания».
Подробности: docs/stage2/pochtovaya.md; контракт — docs/world-format.md («Пешеходные улицы»).
"""
import math
from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

from .roads import base_class, cumlen, resample

TAG = "nfr:pedestrian_street"
MAX_HALF = 16.0        # дальше стену не ищем, м от оси
SAMPLE = 2.0           # шаг сечений, м
STEP = 9.0             # шаг «станций» рядов (дерево — фонарь/лавка — дерево), м
ROW_FROM_WALL = 3.4    # ряд обстановки: от стены (витрины, террасы — ближе к стене)
MIN_CORRIDOR = 5.0     # свободный проход посередине (пожарный проезд, машина игрока)
BOLLARD_GAP = 2.5      # просвет между боллardами на въездах, м (машина игрока 1.84 м)
BOLLARD_D = 0.2
FOOD = {"cafe", "restaurant", "fast_food", "bar", "pub", "ice_cream", "food_court", "bakery", "coffee"}


def is_ped_street(tg):
    return tg.get("highway") == "pedestrian" and tg.get(TAG) == "yes" and tg.get("area") != "yes"


def _num(s, default):
    try:
        return float(str(s).replace(",", ".").split()[0].rstrip("m"))
    except (TypeError, ValueError, IndexError):
        return default


def _frame(P):
    T = np.gradient(P, axis=0)
    T /= np.maximum(np.hypot(*T.T), 1e-9)[:, None]
    return T, np.c_[-T[:, 1], T[:, 0]]          # касательная, левая нормаль


def _ray_hits(P, N, polys, tree, maxd):
    """Расстояние от P вдоль N до первого полигона (nan — нет в пределах maxd)."""
    rays = shapely.linestrings(np.stack([P, P + N * maxd], axis=1))
    out = np.full(len(P), np.nan)
    ri, pi = tree.query(rays, predicate="intersects")
    if len(ri):
        d = shapely.distance(shapely.points(P[ri]), shapely.intersection(rays[ri], np.asarray(polys, dtype=object)[pi]))
        for r, v in zip(ri, d):
            if np.isfinite(v) and not (v >= out[r]):
                out[r] = v
    return out


def _fill(s, h, default):
    ok = np.isfinite(h)
    if ok.sum() >= 2:
        return np.interp(s, s[ok], h[ok])
    if ok.sum() == 1:
        return np.full(len(s), h[ok][0])
    return np.full(len(s), default)


# =====================================================================================
# 1. полигоны зон (yards.collect)
def zones(osm, buildings, world):
    """[{name, poly, lines, ways}] — полигоны пешеходных улиц от стены до стены (до вычитания проезжих частей)."""
    ways = [(wid, tg) for wid, (refs, tg) in osm.ways.items() if is_ped_street(tg)]
    if not ways:
        return []
    btree = shapely.STRtree(buildings)
    groups = defaultdict(list)
    for wid, tg in ways:
        groups[tg.get("name") or f"way/{wid}"].append((wid, tg))
    out = []
    for name, lst in sorted(groups.items()):
        parts, lines, wids = [], [], []
        for wid, tg in lst:
            xy = osm.way_xy(wid)
            if len(xy) < 2 or not LineString(xy).intersects(world):
                continue
            half0 = float(np.clip(_num(tg.get("width"), 12.0) / 2, 3.0, MAX_HALF))
            P = resample(xy, SAMPLE)
            s = cumlen(P)
            _, N = _frame(P)
            hl = _fill(s, _ray_hits(P, N, buildings, btree, MAX_HALF), half0)
            hr = _fill(s, _ray_hits(P, -N, buildings, btree, MAX_HALF), half0)
            # +0.5: заходим в стену (здание потом вычитается — край зоны точно по фасаду)
            hl = np.clip(hl + 0.5, 2.0, MAX_HALF); hr = np.clip(hr + 0.5, 2.0, MAX_HALF)
            L = P + N * hl[:, None]; R = P - N * hr[:, None]
            parts.append(Polygon(np.r_[L, R[::-1]]).buffer(0))
            ln = LineString(xy)
            parts.append(ln.buffer(float(min(hl.min(), hr.min())), quad_segs=4, cap_style="flat"))   # скругление стыков путей
            lines.append(ln)
            wids.append(wid)
        if not parts:
            continue
        poly = unary_union(parts)
        near = btree.query(poly, predicate="intersects")
        if len(near):
            poly = poly.difference(unary_union([buildings[i] for i in near]))
        poly = poly.intersection(world).buffer(0)
        axis = unary_union(lines)
        keep = [q for q in getattr(poly, "geoms", [poly]) if q.geom_type == "Polygon" and q.area > 30 and q.distance(axis) < 1.0]
        if not keep:
            continue
        out.append(dict(name=name if not name.startswith("way/") else "", poly=unary_union(keep), lines=lines, ways=wids))
    return out


# =====================================================================================
# 2. фасады, смотрящие в зону (streetlife.build_facades)
def mark_facades(sl):
    """Рёбра фасадов, у которых в 1 м перед стеной — пешеходная улица: «улица» ранга 6 (витрины гуще, вход с улицы)."""
    zs = sl.g.get("ped_streets") or []
    sl.ped_edges = {}
    if not zs or not len(sl.EA):
        return 0
    for z in zs:
        poly = z["poly"]
        shapely.prepare(poly)
        hits = np.zeros(len(sl.EA), bool)
        for t in (0.25, 0.5, 0.75):
            q = sl.EA + (sl.EB - sl.EA) * t + sl.EN * 1.0
            hits |= shapely.contains_xy(poly, q[:, 0], q[:, 1])
        for e in np.nonzero(hits)[0]:
            sl.ped_edges[int(e)] = z["name"]
            sl.Ed[e] = 1.0
            sl.Erank[e] = 6
    sl.stats["ped_street_facades"] = len(sl.ped_edges)
    return len(sl.ped_edges)


# =====================================================================================
# 3. обстановка (streetlife.run, до фонарей/клумб streetlife)
def furnish(sl, pois):
    from .yards import BLD, CORR, JUNC, PROP, ROAD, WATER, rot_of
    c, g = sl.c, sl.g
    zs = g.get("ped_streets") or []
    c.ped_pois = []
    if not zs:
        return {}
    st = sl.stats
    corr_tree = shapely.STRtree(c.corr) if c.corr else None
    F = BLD | WATER | ROAD | CORR | JUNC | PROP
    for zi, z in enumerate(zs):
        poly = z["poly"]
        if corr_tree is not None:
            ci = corr_tree.query(poly, predicate="intersects")
            if len(ci):
                poly = poly.difference(unary_union([c.corr[i] for i in ci]))
        eff = poly.buffer(-0.3, quad_segs=2).buffer(0)
        z["eff"] = eff
        shapely.prepare(eff)
        rng = sl.rng(400, zi)
        inside = lambda x, y, r=0.0: bool(shapely.contains_xy(eff, x, y)) and (
            r <= 0 or all(shapely.contains_xy(eff, x + r * math.cos(a), y + r * math.sin(a)) for a in np.arange(8) * math.pi / 4))
        free = lambda x, y, r: inside(x, y, r) and bool(sl.free(x, y, F, r)[0])
        # у стен: растр зданий (1 м, all_touched) «наползает» на улицу — стены проверяет сам полигон eff
        free_wall = lambda x, y, r: inside(x, y, r) and bool(sl.free(x, y, F & ~BLD, r)[0])

        # --- скульптуры: OSM tourism=artwork/attraction, historic=memorial/monument (кроме табличек)
        sc_pts = []
        for x, y, tg, cat, ref in sorted(pois, key=lambda p: (p[2].get("tourism") != "artwork", p[4])):
            if cat is not None:
                continue
            art = tg.get("tourism") in ("artwork", "attraction") and "building" not in tg
            mem = tg.get("historic") in ("memorial", "monument") and tg.get("memorial") not in ("plaque", "stolperstein", "blue_plaque")
            if not (art or mem) or not shapely.contains_xy(eff.buffer(1.5), x, y):
                continue
            nm = tg.get("name", "")
            if any(math.hypot(x - a, y - b) < (12.0 if nm and nm == n2 else 4.0) for a, b, n2 in sc_pts):
                continue
            low = nm.lower()
            variant = "mushroom" if "гриб" in low else "marker" if ("километр" in low or "границ" in low) else "figure"
            k = int(np.argmin([ln.distance(Point(x, y)) for ln in z["lines"]]))
            ln = z["lines"][k]
            p = np.array(ln.interpolate(ln.project(Point(x, y))).coords[0])
            d = p - [x, y]
            rot = float(rot_of(*d)) if np.hypot(*d) > 0.3 else float(rng.uniform(-math.pi, math.pi))
            extra = {"variant": variant}
            if nm:
                extra["name"] = nm
            sl.add("street_sculpture", x, y, rot, clear=1.6, stamp=1.3, **extra)
            sc_pts.append((x, y, nm))
            if variant != "marker":       # компания у скульптуры (фото, разговоры): 3 м от неё к оси
                f = d / np.hypot(*d) if np.hypot(*d) > 0.3 else np.array([1.0, 0.0])
                c.ped_pois.append(("park", float(x + f[0] * 3.0), float(y + f[1] * 3.0), rot))

        # --- кафе-террасы перед кафе/ресторанами, обращёнными к зоне (модули 4×3 м)
        n_ter = 0
        for e, nm in sorted(sl.ped_edges.items()):
            if nm != z["name"]:
                continue
            for rec in sl.edge_sf.get(e, []):
                if rec.get("kind") != "food" and rec.get("category") not in FOOD:
                    continue
                a = np.array([rec["x1"], -rec["z1"]]); b = np.array([rec["x2"], -rec["z2"]])
                t = (b - a) / max(np.hypot(*(b - a)), 1e-9)
                n = sl.EN[e]
                mods = int(np.clip(math.floor(min(rec["width"], 12.5) / 4.1), 1, 3))
                mid = (a + b) / 2
                for m in range(mods):
                    o = (m - (mods - 1) / 2) * 4.1
                    q = mid + t * o + n * 1.85
                    corners = [q + t * u + n * v for u in (-1.9, 1.9) for v in (-1.1, 1.35)]
                    if not free_wall(q[0], q[1], 1.2) or not all(free_wall(p_[0], p_[1], 0.0) for p_ in corners):
                        continue
                    sl.add("cafe_terrace", q[0], q[1], float(rot_of(*n)), clear=2.6, stamp=2.2,
                           width=4.0, depth=3.0, variant=int(rng.integers(6)))
                    n_ter += 1

        # --- ряды обстановки вдоль каждого пути зоны
        lines = sorted(z["lines"], key=lambda l: -l.length)
        kiosk_s = {0: [0.3, 0.75]} if lines and lines[0].length > 120 else {0: [0.5]}
        if len(lines) > 1 and lines[1].length > 100:
            kiosk_s[1] = [0.55]
        for li, ln in enumerate(lines):
            P = resample(np.asarray(ln.coords), 1.0)
            s = cumlen(P)
            if s[-1] < 12:
                continue
            T, N = _frame(P)
            # ширина зоны в каждом сечении (до края eff по обе стороны)
            ds = np.arange(0.25, MAX_HALF + 0.3, 0.25)
            wl = np.zeros(len(P)); wr = np.zeros(len(P))
            for side, sg in ((wl, 1), (wr, -1)):
                X = P[:, 0, None] + sg * N[:, 0, None] * ds
                Y = P[:, 1, None] + sg * N[:, 1, None] * ds
                ok = shapely.contains_xy(eff, X, Y)
                first_out = np.where(~ok.all(1), (~ok).argmax(1), len(ds))
                side[:] = np.where(ok[:, 0], ds[np.maximum(first_out - 1, 0)], 0.0)
            kiosks = [s[-1] * f for f in kiosk_s.get(li, [])]
            phase = float(rng.uniform(2.0, 6.0))
            for k, d in enumerate(np.arange(phase, s[-1] - 3.0, STEP / 2)):
                j = int(np.clip(np.searchsorted(s, d), 0, len(P) - 1))
                station = k % 2 == 0           # станция — деревья; между станциями — фонарь или лавка
                row = lambda w: w - ROW_FROM_WALL if w >= 9.0 else w - 2.0
                use = {1: wl[j] >= 4.0, -1: wr[j] >= 4.0}
                if use[1] and use[-1] and row(wl[j]) + row(wr[j]) - 1.5 < MIN_CORRIDOR:
                    use[-1 if wl[j] >= wr[j] else 1] = False          # узко: ряд только у более широкой стороны
                for sg, w, oth in ((1, wl[j], wr[j]), (-1, wr[j], wl[j])):
                    if not use[sg]:
                        continue
                    off = row(w)
                    if not use[-sg] and off + oth - 1.0 < MIN_CORRIDOR:
                        continue
                    q = P[j] + sg * N[j] * off
                    to_axis = -sg * N[j]
                    if station:
                        if rng.random() < 0.88 and free(q[0], q[1], 1.0):
                            sl.add("tree_grate", q[0], q[1], float(rot_of(*T[j])), stamp=0.8, size=1.4)
                            sl.add("tree_lime" if rng.random() < 0.7 else "tree_maple", q[0], q[1],
                                   float(rng.uniform(-math.pi, math.pi)), scale=float(rng.uniform(0.62, 0.78)))
                        continue
                    lamp = (k // 2 + (0 if sg == 1 else 1)) % 2 == 0
                    if kiosks and abs(d - kiosks[0]) < STEP / 2 and sg == (1 if li % 2 == 0 else -1):
                        if free(q[0], q[1], 1.6):
                            sl.add("kiosk", q[0], q[1], float(rot_of(*to_axis)), clear=2.0, stamp=1.8,
                                   variant=int(rng.integers(3)))
                            kiosks.pop(0)
                            continue
                    if lamp:
                        if free(q[0], q[1], 0.5):
                            sl.add("lamp_classic", q[0], q[1], float(rot_of(*T[j])), clear=1.0, stamp=0.5)
                            sl.lamps_xy.append((float(q[0]), float(q[1])))
                    elif rng.random() < 0.22:
                        L_ = float(rng.uniform(2.2, 3.0))
                        sl.flowerbed(q[0], q[1], float(rot_of(*T[j])) + math.pi / 2, "rect", rng, (L_, 1.1), "granite", 0.5,
                                     None, "ped_street", F)
                    elif free(q[0], q[1], 1.0):
                        sl.add("bench", q[0], q[1], float(rot_of(*to_axis)), clear=0.6, stamp=0.7)
                        b2 = q + T[j] * 1.6
                        if rng.random() < 0.6 and free(b2[0], b2[1], 0.25):
                            sl.add("trash_bin", b2[0], b2[1], 0.0, clear=0.4, stamp=0.4)
            # точки сценок для пешеходов: музыкант (2 на путь длиннее 120 м) и компании (каждые ~35 м) у оси
            nb = 2 if s[-1] > 120 else 1 if s[-1] > 60 else 0
            for f in (np.linspace(0.3, 0.75, nb) if nb else []):
                j = int(np.searchsorted(s, s[-1] * f + float(rng.uniform(-8, 8))))
                j = int(np.clip(j, 0, len(P) - 1))
                sg = 1 if wl[j] >= wr[j] else -1
                q = P[j] + sg * N[j] * min(2.0, max(wl[j], wr[j]) - 1.0)
                if inside(q[0], q[1]):
                    c.ped_pois.append(("busker", float(q[0]), float(q[1]), float(rot_of(*(-sg * N[j])))))
            for d in np.arange(float(rng.uniform(10, 25)), s[-1] - 5, 35.0):
                j = int(np.clip(np.searchsorted(s, d), 0, len(P) - 1))
                if inside(P[j, 0], P[j, 1]):
                    c.ped_pois.append(("park", float(P[j, 0]), float(P[j, 1]), 0.0))

        # --- боллards на въездах с автодорог (по краю зоны, дорога ≤ 5 м снаружи; service-проезды пропущены)
        n_bol = 0
        for part in getattr(eff, "geoms", [eff]):
            if part.geom_type != "Polygon":
                continue
            ring = np.asarray(orient(part, 1.0).exterior.coords)
            Q = resample(ring, 0.5)
            if len(Q) < 4:
                continue
            Tq = np.gradient(Q, axis=0); Tq /= np.maximum(np.hypot(*Tq.T), 1e-9)[:, None]
            No = np.c_[Tq[:, 1], -Tq[:, 0]]          # наружу (CCW)
            entry = np.zeros(len(Q), bool)
            for dd in (1.0, 2.0, 3.0, 4.0, 5.0):
                O = Q + No * dd
                m = c.m(O[:, 0], O[:, 1])
                rid = sl.rid_at(O[:, 0], O[:, 1])
                hit = (rid > 0) & ~entry
                for i in np.nonzero(hit)[0]:
                    r = sl.roads[rid[i] - 1]
                    blocked = any((c.m(np.array([Q[i, 0] + No[i, 0] * e_]), np.array([Q[i, 1] + No[i, 1] * e_]))[0] & BLD)
                                  for e_ in np.arange(0.5, dd, 0.5))
                    if base_class(r.hw) != "service" and not blocked:
                        entry[i] = True
                if (m & BLD).all():
                    break
            # непрерывные куски края-въезда
            i = 0
            while i < len(Q):
                if not entry[i]:
                    i += 1
                    continue
                j = i
                while j + 1 < len(Q) and entry[j + 1]:
                    j += 1
                L = (j - i) * 0.5
                if L >= 2.0:
                    seg = Q[i:j + 1] - No[i:j + 1] * 0.6
                    sseg = cumlen(seg)
                    nb_ = int(math.floor(sseg[-1] / (BOLLARD_GAP + BOLLARD_D))) + 1
                    span = (nb_ - 1) * (BOLLARD_GAP + BOLLARD_D)
                    for kk in range(nb_):
                        dd = (sseg[-1] - span) / 2 + kk * (BOLLARD_GAP + BOLLARD_D)
                        x = float(np.interp(dd, sseg, seg[:, 0])); y = float(np.interp(dd, sseg, seg[:, 1]))
                        if sl.free(x, y, BLD | WATER | ROAD | PROP)[0]:
                            sl.add("bollard", x, y, 0.0, clear=0.6, stamp=0.15)
                            n_bol += 1
                i = j + 1
        st["bollard_ped_street"] = st.get("bollard_ped_street", 0) + n_bol
        st["cafe_terrace_modules"] = st.get("cafe_terrace_modules", 0) + n_ter
        st["ped_street_area_m2"] = round(st.get("ped_street_area_m2", 0) + eff.area)
    st["ped_street_pois"] = len(c.ped_pois)
    keys = ("street_sculpture", "lamp_classic", "tree_grate", "bench", "trash_bin", "kiosk", "cafe_terrace", "bollard_ped_street")
    return {k: st.get(k, 0) for k in keys}
