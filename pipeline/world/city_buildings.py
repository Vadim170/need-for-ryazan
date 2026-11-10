"""Здания v2: архетипы (archetypes.py) + геометрия (building_geom.py) -> ноды тайла `buildings`, `building_colliders`,
`balconies`. Вызывается из build_world.py. Контракт: docs/world-format.md («Здания v2»), отчёт: docs/stage2/buildings.md.
"""
import json
import math
from collections import Counter, defaultdict

import numpy as np
from shapely.geometry import Point
from shapely.strtree import STRtree

from config import DATA_PROCESSED
from . import archetypes as A
from . import building_geom as G
from .buildings import prism, polygons
from .gltf import Prim


_SPECS = {}   # id(osm) -> (specs, report): классификация считается один раз (её же читает world/streetlife.py)


def classify_cached(osm, osm_path, inside, log=print):
    """Архетипы/этажность/цоколь/секции до сборки геометрии (streetlife ставит по ним входы и витрины)."""
    k = id(osm)
    if k not in _SPECS:
        _SPECS[k] = A.classify(osm, osm_path, inside, log)
    return _SPECS[k]


def ground_level(ss, grid, H, base_height):
    """Уровень земли здания (высота игры): минимум рельефа под всеми его объёмами. Пол 1-го этажа = это + s.plinth."""
    ext = np.concatenate([np.asarray(s.poly.exterior.coords) for s in ss])
    return float(grid.sample(H, ext[:, 0], ext[:, 1]).min()) - base_height


MAX_LIFT = 6.0        # м: насколько пол 1-го этажа может подняться над минимумом рельефа (крутые склоны)
_PLANS = {}


class GroundPlan:
    """Уровни пола здания на склоне. sections: [(полигон, низ стен = мин. рельеф, base)], пол 1-го этажа секции =
    base + plinth. Длинные дома с плоской крышей режутся на секции (по подъездам) со ступенькой между ними;
    короткие — один объём, пол по самой высокой точке рельефа у стен, с низовой стороны открывается высокий цоколь."""

    def __init__(self, ground, sections, plinth, stepped):
        self.ground = ground            # минимум рельефа под зданием (как ground_level)
        self.sections = sections
        self.plinth = plinth
        self.stepped = stepped

    @property
    def floor(self):
        """Пол 1-го этажа (самой низкой секции) — высота игры."""
        return min(b for _, _, b in self.sections) + self.plinth

    def floor_at(self, x, y):
        """Пол 1-го этажа секции, ближайшей к точке (x, y — мир пайплайна: x восток, y север)."""
        p = Point(x, y)
        best = min(self.sections, key=lambda t: t[0].distance(p))
        return best[2] + self.plinth

    def base_at(self, x, y):
        p = Point(x, y)
        return min(self.sections, key=lambda t: t[0].distance(p))[2]


def _ring_samples(poly, step=2.0):
    pts = []
    for g in ([poly] if poly.geom_type == "Polygon" else list(poly.geoms)):
        ln = g.exterior
        n = max(int(ln.length / step), 4)
        pts += [ln.interpolate(t, normalized=True).coords[0] for t in np.linspace(0, 1, n, endpoint=False)]
    return np.array(pts)


def ground_plan(ss, grid, H, base_height):
    """План уровней пола здания (группа объёмов одного здания, как в groups по tile_pt). Кэшируется по зданию.
    Для streetlife: ground_plan(ss, ...).floor_at(x, y) — пол 1-го этажа у двери."""
    k = (ss[0].tile_pt, len(ss))
    if k in _PLANS:
        return _PLANS[k]
    terr = lambda P: grid.sample(H, P[:, 0], P[:, 1]) - base_height
    g_all = ground_level(ss, grid, H, base_height)
    s = ss[0]
    if len(ss) > 1 or s.part or s.arch == "church":
        plan = GroundPlan(g_all, [(sp.poly, g_all, g_all) for sp in ss], s.plinth, False)   # части/сложные — как раньше
    else:
        poly = s.poly
        tb = terr(_ring_samples(poly))
        rng_h = float(tb.max() - tb.min())
        ctr, u, L, W, _ = A.rect_frame(poly)
        n = int(np.clip(s.sections, 1, 8))
        if s.roof == "flat" and n >= 2 and L >= 30 and rng_h >= 0.6:
            from shapely.geometry import Polygon as _P
            v = np.array([-u[1], u[0]])
            secs = []
            for i in range(n):
                a0, a1 = -L / 2 + L * i / n, -L / 2 + L * (i + 1) / n
                strip = _P([ctr + u * a0 - v * (W + 5), ctr + u * a1 - v * (W + 5), ctr + u * a1 + v * (W + 5), ctr + u * a0 + v * (W + 5)])
                piece = poly.intersection(strip)
                piece = [g for g in getattr(piece, "geoms", [piece]) if g.geom_type == "Polygon" and g.area > 1.0]
                for g in piece:
                    t = terr(_ring_samples(g))
                    lo, hi = float(t.min()), float(t.max())
                    secs.append((g, lo, min(hi, lo + MAX_LIFT)))
            plan = GroundPlan(g_all, secs, s.plinth, True) if secs else GroundPlan(g_all, [(poly, g_all, g_all)], s.plinth, False)
        else:
            plan = GroundPlan(g_all, [(poly, g_all, min(float(tb.max()), g_all + MAX_LIFT))], s.plinth, False)
    _PLANS[k] = plan
    return plan


def build(osm, osm_path, grid, H, base_height, inside, tiles, tile_key, log=print, report_path=None, storefronts=None):
    specs, rep = classify_cached(osm, osm_path, inside, log)
    log(f"здания v2: {rep['buildings']} зданий, {rep['volumes']} объёмов; этажность: {rep['levels_sources']}")
    log(f"  архетипы: {rep['archetypes']}")
    # соседи для глухих стен (брандмауэров): все объёмы-не-части
    foot = [s.poly for s in specs if not s.part]
    owner = [s.key for s in specs if not s.part]
    tree = STRtree(foot)

    def blank_fn_for(key):
        def f(a, b, nrm):
            hits = 0
            ts = (0.2, 0.5, 0.8)
            for t in ts:
                p = Point(*(a + (b - a) * t + nrm * 0.8))
                for j in tree.query(p):
                    if owner[j] != key and foot[j].contains(p):
                        hits += 1
                        break
            return hits >= 2
        return f

    # витрины 1-го этажа — только там, где слой улицы (streetlife) поставил запись storefront: интервалы вдоль стены
    from shapely.geometry import LineString
    sf_lines, sf_n = [], []
    for r in storefronts or []:
        a = np.array([r["x1"], -r["z1"]]); b = np.array([r["x2"], -r["z2"]])
        if np.hypot(*(b - a)) > 0.3:
            sf_lines.append(LineString([a, b])); sf_n.append(np.array([r.get("nx", 0.0), -r.get("nz", 0.0)]))
    sf_tree = STRtree(sf_lines) if sf_lines else None

    def shop_intervals(a, b, nrm):
        """[(u0, u1)] — участки стены a->b (м от a), занятые витринами."""
        if sf_tree is None:
            return []
        d = b - a
        L = float(np.hypot(*d))
        t = d / L
        out = []
        for j in sf_tree.query(LineString([a, b]).buffer(0.8)):
            ln = sf_lines[j]
            if sf_n[j] @ nrm < 0.7:
                continue
            p = np.asarray(ln.coords)
            off = np.abs((p - a) @ np.array([-t[1], t[0]]))
            if off.max() > 0.8:
                continue
            u = np.sort((p - a) @ t)
            u0, u1 = max(u[0], 0.0), min(u[1], L)
            if u1 - u0 > 0.5:
                out.append((float(u0), float(u1)))
        return sorted(out)

    # уровень земли: минимум рельефа под всеми объёмами здания (части — по своему зданию)
    groups = defaultdict(list)
    for s in specs:
        groups[s.tile_pt].append(s)
    tris = 0
    n_bal = 0
    bal_by_type = Counter()
    n_stepped = n_lifted = 0
    import copy
    for tp, ss in groups.items():
        plan = ground_plan(ss, grid, H, base_height)
        base = plan.ground
        key = tile_key(*tp)
        acc = G.MeshAcc()
        rng = np.random.default_rng(ss[0].seed)
        bals = []
        n_stepped += plan.stepped
        n_lifted += any(b - g > 0.3 for _, g, b in plan.sections)
        if plan.stepped:
            # секции: свой пол и плоская крыша; стены на стыке секций — глухие (ступенька видна выше/ниже соседа)
            s0 = ss[0]
            sec_polys = [g for g, _, _ in plan.sections]
            bf0 = blank_fn_for(s0.key)
            for i, (g, gnd, b) in enumerate(plan.sections):
                sp = copy.copy(s0)
                sp.poly = g
                sp.sections = 1
                others = [q for j, q in enumerate(sec_polys) if j != i]

                def bf(a, b_, nrm, others=others):
                    m = Point(*((a + b_) / 2 + nrm * 0.3))
                    return any(q.buffer(0.05).contains(m) for q in others) or bf0(a, b_, nrm)
                try:
                    G.build_spec(acc, sp, b, bf, rng, shop_intervals, ground=gnd, with_balconies=False)
                    G.roof_details(acc, sp, g, b, rng)
                except Exception as e:
                    log(f"  ! {s0.key} секция {i}: {type(e).__name__}: {e}")
            # балконы — по целому дому (стороны/колонки), высота — по секции
            try:
                for bl in G.balconies(s0, s0.poly, 0.0, bf0, rng) if (s0.arch in G.BALCONY_RULES and s0.levels >= 2) else []:
                    bals.append((bl[0], bl[1], bl[2] + plan.base_at(bl[0], bl[1])) + tuple(bl[3:]))
            except Exception as e:
                log(f"  ! {s0.key} балконы: {type(e).__name__}: {e}")
            ss_iter = []
        else:
            ss_iter = ss
        for s in ss_iter:
            sb = plan.sections[0][2] if (len(ss) == 1 and not s.part) else base
            try:
                bals += G.build_spec(acc, s, sb, blank_fn_for(s.key), rng, shop_intervals, ground=base)
                G.roof_details(acc, s, s.poly, sb, rng)
            except Exception as e:  # геометрия одного здания не должна ронять сборку
                log(f"  ! {s.key}: {type(e).__name__}: {e}")
                acc2 = G.MeshAcc()
                G.walls(acc2, s.poly, base, base + s.wall_h, base + s.plinth, s.fh, s.color)
                acc2.poly_flat(s.poly, base + s.wall_h, True, G.P_ROOF_FLAT, s.roof_color)
                acc = _merge_acc(acc, acc2)
        main = ss[0]
        out = acc.to_game(A.ARCH[main.arch], main.seed, main.levels)
        if out is not None:
            P, I, N, U, attrs = out
            tiles[key]["buildings"]["building"].add(P, I, N, U, attrs)
            tris += len(I) // 3 if I.ndim == 1 else len(I)
        # коллайдеры: упрощённые призмы до верха стен
        col_items = [(g, gnd, b, ss[0]) for g, gnd, b in plan.sections] if (plan.stepped or (len(ss) == 1 and not ss[0].part)) \
            else [(sp.poly, base, base, sp) for sp in ss]
        for g, gnd, b, s in col_items:
            if s.min_h > 0.5:
                continue
            for cp in polygons(g.simplify(1.0, preserve_topology=True)):
                if cp.area < 4:
                    continue
                rc = prism(cp, gnd, b + s.wall_h)
                if rc is not None:
                    tiles[key]["building_colliders"][None].add(rc[0], rc[3])
        for b in bals:
            x, y, h0, rot, n, fh, typ, w, d, gl, sd = b
            pr = tiles[tile_key(x, y)]["balconies"]["balcony"]
            pr.mode = 0
            pr.add(np.array([[x, h0, -y]], np.float32), np.array([0]), None, None,
                   {"_BAL": np.array([[typ, rot, n, fh]], np.float32), "_BAL2": np.array([[w, d, gl, sd / 65535.0]], np.float32)})
            n_bal += n
            bal_by_type[typ] += n
    rep["triangles"] = int(tris)
    rep["balconies"] = {"total": n_bal, "open": bal_by_type[G.BAL_OPEN], "glazed": bal_by_type[G.BAL_GLAZED],
                        "loggia": bal_by_type[G.BAL_LOGGIA]}
    rep["slopes"] = {"stepped_buildings": int(n_stepped), "lifted_buildings": int(n_lifted)}
    log(f"  треугольников зданий {tris}, балконов {n_bal} ({dict(bal_by_type)}); на склонах: секциями {n_stepped}, "
        f"пол поднят {n_lifted}")
    if report_path:
        report_path.write_text(json.dumps(rep, ensure_ascii=False, indent=1))
    return rep


def _merge_acc(a, b):
    for k in ("P", "N", "UV", "UV1", "C", "PART"):
        getattr(a, k).extend(getattr(b, k))
    a.I.extend([i + a.n for i in b.I])
    a.n += b.n
    a.tris += b.tris
    return a
