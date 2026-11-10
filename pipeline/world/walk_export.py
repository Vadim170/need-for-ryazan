"""Пешеходная сеть для игры (этап 2, «люди»): game/public/world/people/walk.json.

Граф строится из того, что уже посчитала сборка мира (build_world.py), ничего не рисуется:
- оси тротуаров: кромка проезжей части + половина ширины тротуара, только там, где реально лежит футпринт
  тротуара (world/sidewalks.py), плюс дуги вокруг площадок перекрёстков (угловые скругления);
- пешеходные пути OSM (footway/path/pedestrian/steps/cycleway, в т.ч. footway=sidewalk), обрезанные по проезжей
  части автодорог, зданиям и воде;
- «дворовые» линии вдоль service/living_street (во дворах ходят по проездам);
- решётка 8 м по пешеходным площадям (highway=pedestrian area, place=square, marketplace);
- переходы из разметки (world/markings.py: find_crossings) — отрезок от бордюра до бордюра поперёк дороги;
  для регулируемых — id узла roads/graph.json и id ребра дороги (подход), по которым игра спрашивает фазу светофора;
- короткие связки (≤ 8 м) между концами линий, не пересекающие проезжую часть автодорог, площадки перекрёстков,
  здания и воду.
Точки интереса (POI): входы в дома (OSM entrance, иначе точки на фасадах жилых/коммерческих домов, обращённые к сети),
магазины/кафе (OSM shop/amenity), остановки, лавки, детские комплексы (из пропсов), точки в парках.

Формат: docs/world-format.md, раздел «Дополнение: пешеходная сеть (people/walk.json)».
Отладка без полной сборки: WALK_DUMP=<file.pkl> uv run python build_world.py ... сохраняет входные данные,
затем `uv run python -m world.walk_export <file.pkl> <out_dir>` пересчитывает только граф.
"""
import json
import math
import os
import pickle
import sys
import time
import xml.etree.ElementTree as ET
from collections import defaultdict

import numpy as np
import shapely
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point, Polygon
from shapely.strtree import STRtree

VERSION = 1
MAX_SEG = 8.0          # макс. длина ребра графа, м (высоты по рельефу интерполируются линейно)
LINK_R = 8.0           # радиус связок между концами линий
POI_R = 25.0           # радиус привязки POI к графу
PAD_CROSS_MAX = 5.0    # связка может зайти на площадку перекрёстка не больше чем на столько (устья дворовых проездов)
MIN_COMPONENT = 150.0  # компоненты связности короче (суммарно, м) выбрасываются
SNAP = 0.3             # слияние узлов ближе этого
SIDEWALK_W = {"primary": 3.0, "secondary": 3.0, "tertiary": 2.5, "unclassified": 2.0, "residential": 2.0}
MAJOR = set(SIDEWALK_W)  # «автодороги» для пешехода: переходить только по переходам
YARD_CLASSES = {"service", "living_street"}
SIGNAL_REACH = 45.0    # переход ближе этого к регулируемому узлу по оси дороги — регулируемый
# виды рёбер
K_SIDEWALK, K_PATH, K_CROSSING, K_SQUARE, K_YARD, K_LINK = range(6)
KIND_NAMES = ["sidewalk", "path", "crossing", "square", "yard", "link"]
# зоны узлов (битовая маска) — для плотности в игре
Z_CENTER, Z_COMMERCIAL, Z_RESIDENTIAL, Z_PARK, Z_INDUSTRIAL, Z_YARD, Z_PEDESTRIAN = (1 << i for i in range(7))
# высоты поверхности над рельефом
H_SIDEWALK, H_LOWERED, H_ROAD, H_AREA = 0.15, 0.07, 0.05, 0.03
# центр города (Почтовая/Театральная/Соборная/Первомайский): ~1.6 км от кремля на юго-запад
CENTER = (-900.0, -650.0)
CENTER_R = 1500.0
POI_TYPES = ["entrance", "shop", "bus_stop", "bench", "playground", "park", "busker"]   # busker — пешеходные улицы
SQUARE_STEP, PED_STREET_STEP = 8.0, 5.0   # шаг решётки на площадях и на пешеходных улицах (там гуще)


def log_default(*a):
    print(*a, flush=True)


# =====================================================================================
# 1. сбор входных данных из контекста build_world (всё, что нужно, в pickle-совместимом виде)
def gather(ctx, crossings, yard, osm_path):
    from world.roads import base_class, offset, resample
    from world.sidewalks import carriageway
    from world import buildings as B
    from world.yards import BLD, WATER, PARK, WOOD, YARD, APT40, URBAN, INDUSTRIAL, AREA, CEMETERY, GRASS

    net, roads, osm = ctx["net"], ctx["roads"], ctx["osm"]
    zj, floating, jix = ctx["zj"], ctx["floating"], ctx["jix"]
    gid = {j: i for i, j in enumerate(zj)}           # id узла roads/graph.json (тот же порядок, что в build_world)
    tls = {j for j, J in net.junctions.items() if J["type"] == "traffic_light"}
    from world.roads import junction_polygon
    pads = {}
    for j in zj:
        p = junction_polygon(net.junctions[j])
        if p is not None:
            pads[j] = dict(poly=p, tls=j in tls, floating=bool(floating[jix[j]]), gid=gid[j])
    rds = []
    for r in roads:
        f0 = r.fwd["lanes"][0]
        sides = [(offset(resample(f0["shape"], 2.0), -f0["width"] / 2), -1)]
        if r.bwd is not None:
            b0 = r.bwd["lanes"][0]
            sides.append((offset(resample(b0["shape"], 2.0), -b0["width"] / 2), -1))
        else:
            fl = r.fwd["lanes"][-1]
            sides.append((offset(resample(fl["shape"], 2.0), fl["width"] / 2), 1))
        carr = carriageway(r.fwd) + (carriageway(r.bwd) if r.bwd is not None else [])
        rds.append(dict(id=r.id, hw=r.hw, cls=base_class(r.hw), link=r.hw.endswith("_link"), frm=r.frm, to=r.to,
                        bridge=bool(r.bridge), tunnel=bool(r.tunnel), axis=np.asarray(r.axis), Wf=r.Wf, Wb=r.Wb,
                        sides=sides, carr=carr, name=r.name, oneway=r.bwd is None, sumo=r.fwd["id"]))
    crs = []
    for c in crossings:
        r = c["road"]
        tg = osm.node_tags.get(c.get("osm"), {})
        crs.append(dict(c=np.asarray(c["c"]), t=np.asarray(c["t"]), n=np.asarray(c["n"]), wr=c["wr"], wl=c["wl"],
                        road=r.id, s=c["s"], marked=bool(c["marked"]), osm=c.get("osm"),
                        sig_tag=tg.get("crossing") == "traffic_signals" or tg.get("highway") == "traffic_signals"
                        or tg.get("crossing:signals") == "yes"))
    foot, squares = [], []
    for wid, (refs, tg) in osm.ways.items():
        hw = tg.get("highway")
        closed = len(refs) > 3 and refs[0] == refs[-1]
        if (hw in ("pedestrian", "footway") and tg.get("area") == "yes") or tg.get("place") == "square" \
                or tg.get("amenity") == "marketplace":
            if closed:
                p = osm.way_polygon(wid)
                if p is not None:
                    squares.append(p)
            continue
        if hw not in ("footway", "path", "pedestrian", "steps", "cycleway", "bridleway"):
            continue
        if tg.get("bridge", "no") != "no" or tg.get("tunnel", "no") != "no" or tg.get("layer", "0") not in ("0",) \
                or tg.get("indoor", "no") != "no" or tg.get("access") in ("private", "no"):
            continue
        xy = osm.way_xy(wid)
        if len(xy) >= 2:
            foot.append((xy, hw, tg.get("footway", "")))
    for rid, tg, mem in osm.rels:
        if tg.get("type") == "multipolygon" and (tg.get("place") == "square" or (
                tg.get("highway") == "pedestrian") or tg.get("amenity") == "marketplace"):
            p = osm.rel_polygon(mem)
            if p is not None:
                squares.append(p)
    blds = []
    for poly, tg, _ in osm.buildings():
        if tg.get("building") in B.SKIP:
            continue
        blds.append((poly, B.category(tg)))
    yc = yard.ctx
    props = defaultdict(list)
    for inst in (i for lst in yc.tiles_props.values() for i in lst):
        if inst["type"] in ("bus_stop", "bench", "playground_set"):
            props[inst["type"]].append((inst["x"], -inst["z"], inst["y"], inst["rotY"]))
    entrances = [(x, y, t.get("entrance")) for x, y, t in yc.points.of("entrance")]
    shops = parse_shops(osm_path)
    bits = dict(BLD=BLD, WATER=WATER, PARK=PARK, WOOD=WOOD, YARD=YARD, APT40=APT40, URBAN=URBAN, INDUSTRIAL=INDUSTRIAL,
                AREA=AREA, CEMETERY=CEMETERY, GRASS=GRASS)
    ped = (getattr(yc, "g", None) or {}).get("ped_streets", [])      # world/pedestrian_streets.py
    return dict(roads=rds, pads=pads, crossings=crs, footprints=list(ctx.get("sidewalk_footprints", {}).values()),
                foot=foot, squares=squares, ped_streets=[z["poly"] for z in ped], ped_pois=list(getattr(yc, "ped_pois", [])), buildings=blds, props=dict(props), entrances=entrances, shops=shops,
                grid=ctx["grid"], H=ctx["H"], base=ctx["base"], water=[p for p, _, _ in ctx["water"]],
                mask=dict(M=yc.M, min_x=yc.min_x, max_y=yc.max_y, res=1.0, bits=bits))


SHOP_AMENITY = {"cafe", "restaurant", "fast_food", "pharmacy", "bank", "atm", "post_office", "bar", "pub", "cinema",
                "theatre", "library", "clinic", "doctors", "dentist", "school", "kindergarten", "marketplace",
                "community_centre", "townhall", "courthouse", "police", "ice_cream", "bureau_de_change"}


def parse_shops(path):
    """Узлы OSM shop=*, office=*, amenity из SHOP_AMENITY -> [(x, y, kind)]."""
    from config import to_world
    lons, lats, kinds = [], [], []
    for _, el in ET.iterparse(path):
        if el.tag == "node":
            if len(el):
                k = None
                for c in el.iter("tag"):
                    key, v = c.get("k"), c.get("v")
                    if key == "shop" or key == "office" or (key == "amenity" and v in SHOP_AMENITY):
                        k = f"{key}={v}"
                        break
                if k:
                    lons.append(float(el.get("lon"))); lats.append(float(el.get("lat"))); kinds.append(k)
            el.clear()
        elif el.tag in ("way", "relation"):
            el.clear()
    if not lons:
        return []
    xs, ys = to_world.transform(np.array(lons), np.array(lats))
    return list(zip(xs.tolist(), ys.tolist(), kinds))


# =====================================================================================
# 2. геометрия
def _runs(P, ok, min_len=3.0):
    """Непрерывные куски полилинии P, где ok[i] True."""
    out, i, n = [], 0, len(P)
    while i < n:
        if not ok[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and ok[j + 1]:
            j += 1
        if j > i:
            Q = P[i:j + 1]
            if np.hypot(*np.diff(Q, axis=0).T).sum() >= min_len:
                out.append(Q)
        i = j + 1
    return out


def _dense(P, step):
    from world.roads import resample
    return resample(np.asarray(P, np.float64), step)


class Mask:
    def __init__(self, m):
        self.M, self.x0, self.y0, self.res, self.bits = m["M"], m["min_x"], m["max_y"], m["res"], m["bits"]

    def at(self, x, y):
        c = np.floor((np.asarray(x, np.float64) - self.x0) / self.res).astype(np.int64)
        r = np.floor((self.y0 - np.asarray(y, np.float64)) / self.res).astype(np.int64)
        ok = (r >= 0) & (r < self.M.shape[0]) & (c >= 0) & (c < self.M.shape[1])
        out = np.zeros(r.shape, np.uint32)
        out[ok] = self.M[r[ok], c[ok]]
        return out


def compute(inp, log=log_default):
    t0 = time.time()
    mask = Mask(inp["mask"])
    BITS = mask.bits
    roads, pads = inp["roads"], inp["pads"]
    st = defaultdict(int)

    # ---------- препятствия для связок
    major_carr = [p for r in roads if (r["cls"] in MAJOR or r["link"]) and not r["bridge"] and not r["tunnel"]
                  for p in r["carr"]]
    major_carr_e = [q for p in major_carr for q in _polys(p.buffer(-0.2))]
    t_carr = STRtree(major_carr_e)
    pad_polys = [d["poly"] for d in pads.values() if not d["floating"]]
    t_pad = STRtree(pad_polys)
    bpolys = [q for p, _ in inp["buildings"] for q in _polys(p)]
    t_bld = STRtree(bpolys)

    def seg_ok(a, b):
        """Связка a-b не пересекает автодороги, площадки перекрёстков (больше 2.5 м), здания и воду."""
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L < 1e-6:
            return True
        ln = LineString([a, b])
        if len(t_carr.query(ln, predicate="intersects")):
            return False
        for k in t_pad.query(ln, predicate="intersects"):
            if pad_polys[k].intersection(ln).length > PAD_CROSS_MAX:
                return False
        n = max(2, int(L / 0.5))
        t = np.linspace(0.08, 0.92, n) if L > 1 else np.array([0.5])
        xs = a[0] + (b[0] - a[0]) * t; ys = a[1] + (b[1] - a[1]) * t
        if np.any(mask.at(xs, ys) & (BITS["BLD"] | BITS["WATER"])):
            return False
        return True

    # ---------- тротуарные футпринты
    fp = [q for p in inp["footprints"] for q in _polys(p)]
    fp_in = [q for p in fp for q in _polys(p.buffer(-0.3))]
    t_fp = STRtree(fp)
    t_fpi = STRtree(fp_in)

    def inside(tree, P):
        P = np.asarray(P)
        pts = shapely.points(P)
        idx = tree.query(pts, predicate="intersects")
        ok = np.zeros(len(P), bool)
        ok[idx[0]] = True
        return ok

    lines = []   # (np.array Nx2, kind, crossing_id)

    # a. оси тротуаров
    from world.roads import offset
    for r in roads:
        if r["bridge"] or r["tunnel"] or r["link"] or r["cls"] not in SIDEWALK_W:
            continue
        sw = SIDEWALK_W[r["cls"]]
        for edge, sigma in r["sides"]:
            if len(edge) < 2:
                continue
            C = _dense(offset(edge, sigma * sw / 2), 1.0)
            for Q in _runs(C, inside(t_fpi, C)):
                lines.append((Q, K_SIDEWALK, -1)); st["sidewalk_lines"] += 1
    # b. дуги вокруг площадок
    j_sw = defaultdict(float)
    j_arms = defaultdict(int)
    for r in roads:
        if r["cls"] in SIDEWALK_W and not r["link"] and not r["bridge"]:
            for j in (r["frm"], r["to"]):
                j_sw[j] = max(j_sw[j], SIDEWALK_W[r["cls"]])
                j_arms[j] += 1
    for j, w in j_sw.items():
        d = pads.get(j)
        if d is None or d["floating"]:
            continue
        ring = np.asarray(d["poly"].buffer(w / 2, quad_segs=4).exterior.coords)
        C = _dense(ring, 1.0)
        ok = inside(t_fpi, C)
        if ok.all():
            lines.append((C, K_SIDEWALK, -1)); continue
        k = int(np.argmin(ok))   # начать с точки вне футпринта, чтобы куски не рвались на стыке кольца
        C = np.r_[C[k:-1], C[:k + 1]]; ok = np.r_[ok[k:-1], ok[:k + 1]]
        for Q in _runs(C, ok, 1.5):
            lines.append((Q, K_SIDEWALK, -1)); st["corner_arcs"] += 1

    # c. переходы
    rmap = {r["id"]: r for r in roads}
    crossings_out = []
    for c in inp["crossings"]:
        r = rmap[c["road"]]
        if r["bridge"] or r["tunnel"]:
            continue
        cc, n = c["c"], c["n"]
        a = cc - n * c["wr"]; b = cc + n * c["wl"]
        sw = SIDEWALK_W.get(r["cls"], 2.0)
        E = sw / 2 + 1.5
        # регулируемый? ближайший конец дороги — узел-светофор в пределах SIGNAL_REACH по оси
        L = float(np.hypot(*np.diff(r["axis"], axis=0).T).sum())
        junc, best, sj = -1, 1e9, ""
        for j, d in ((r["frm"], c["s"]), (r["to"], L - c["s"])):
            pd = pads.get(j)
            if pd is not None and pd["tls"] and d < SIGNAL_REACH and d < best:
                junc, best, sj = pd["gid"], d, str(j)
        cid = len(crossings_out)
        crossings_out.append(dict(id=cid, road=r["id"], junction=junc, signal=bool(junc >= 0 or c["sig_tag"]),
                                  marked=c["marked"], c=cc, a=a, b=b, width=c["wr"] + c["wl"], sj=sj, se=r.get("sumo", "")))
        lines.append((np.array([a, b]), K_CROSSING, cid))
        lines.append((np.array([a - n * E, a]), K_LINK, -1))
        lines.append((np.array([b, b + n * E]), K_LINK, -1))
        st["crossings"] += 1
        st["crossings_signal"] += junc >= 0

    # c2. переходы на перекрёстках без зебры в OSM: поперёк каждого «рукава» автодороги у площадки.
    #     Регулируемый узел -> переход со светофором (фаза по этому подходу); нерегулируемый -> «по линии тротуаров»
    #     (ПДД разрешают), только для узких дорог (≤ 11 м).
    by_road = defaultdict(list)
    for co in crossings_out:
        by_road[co["road"]].append(co["c"])
    for r in roads:
        if r["bridge"] or r["tunnel"] or r["link"] or r["cls"] not in MAJOR or len(r["axis"]) < 2:
            continue
        L = float(np.hypot(*np.diff(r["axis"], axis=0).T).sum())
        if L < 8:
            continue
        sw = SIDEWALK_W.get(r["cls"], 2.0)
        W = r["Wf"] + r["Wb"] if not r["oneway"] else r["Wf"]
        for j, end, nxt, rev in ((r["frm"], r["axis"][0], r["axis"][1], False), (r["to"], r["axis"][-1], r["axis"][-2], True)):
            pd = pads.get(j)
            if pd is None or pd["floating"]:
                continue
            if not pd["tls"] and (W > 11.0 or j_arms.get(j, 0) < 3):
                continue
            t = np.asarray(nxt) - np.asarray(end)
            t /= (np.linalg.norm(t) or 1)
            cc = np.asarray(end) + t * 1.3
            if any(np.hypot(*(q - cc)) < 20 for q in by_road[r["id"]]):
                continue
            n = np.array([-t[1], t[0]])
            if r["oneway"]:
                wr = wl = W / 2
            else:
                wr, wl = (r["Wb"], r["Wf"]) if rev else (r["Wf"], r["Wb"])
            a = cc - n * wr; b = cc + n * wl
            E_ = sw / 2 + 1.5
            cid = len(crossings_out)
            crossings_out.append(dict(id=cid, road=r["id"], junction=pd["gid"] if pd["tls"] else -1, signal=bool(pd["tls"]),
                                      marked=False, c=cc, a=a, b=b, width=wr + wl, sj=str(j) if pd["tls"] else "",
                                      se=r.get("sumo", "")))
            by_road[r["id"]].append(cc)
            lines.append((np.array([a, b]), K_CROSSING, cid))
            lines.append((np.array([a - n * E_, a]), K_LINK, -1))
            lines.append((np.array([b, b + n * E_]), K_LINK, -1))
            st["crossings_junction_signal" if pd["tls"] else "crossings_junction_unmarked"] += 1

    # d. пути OSM
    barrier = major_carr + pad_polys
    t_bar = STRtree(barrier)
    t_w = STRtree(inp["water"]) if inp["water"] else None
    for xy, hw, fw in inp["foot"]:
        ln = LineString(xy)
        cut = [barrier[k] for k in t_bar.query(ln, predicate="intersects")]
        cut += [bpolys[k] for k in t_bld.query(ln, predicate="intersects")]
        if t_w is not None:
            cut += [inp["water"][k] for k in t_w.query(ln, predicate="intersects")]
        g = ln
        if cut:
            g = ln.difference(shapely.union_all([p.buffer(0.3) for p in cut]))
        kind = K_SQUARE if hw == "pedestrian" else (K_SIDEWALK if fw == "sidewalk" else K_PATH)
        for part in _lines(g):
            if part.length >= 2.0:
                lines.append((np.asarray(part.coords)[:, :2], kind, -1)); st["osm_paths"] += 1
    # e. дворовые проезды
    for r in roads:
        if r["cls"] not in YARD_CLASSES or r["bridge"] or r["tunnel"]:
            continue
        W = r["Wf"] if r["oneway"] else r["Wf"] + r["Wb"]
        off = max(W / 2 - 0.5, 0.8)
        # одна линия на проезд (по правой стороне): во дворах ходят по краю проезда
        for s in (-1,):
            if len(r["axis"]) < 2:
                continue
            C = _dense(offset(r["axis"], s * off), 2.0)
            bad = (mask.at(C[:, 0], C[:, 1]) & (BITS["BLD"] | BITS["WATER"])) != 0
            bad |= inside(t_carr, C)
            for Q in _runs(C, ~bad, 4.0):
                lines.append((Q, K_YARD, -1)); st["yard_lines"] += 1
    # f. площади: решётка (вырезаны все проезжие части, включая service)
    all_carr = [p for r in roads if not r["bridge"] and not r["tunnel"] for p in r["carr"]] + pad_polys
    t_all = STRtree(all_carr)
    sq_extra = []
    for p, step in [(p, SQUARE_STEP) for p in inp["squares"]] + [(p, PED_STREET_STEP) for p in inp.get("ped_streets", [])]:
        for q in _polys(p):
            cut = [bpolys[k] for k in t_bld.query(q, predicate="intersects")] + \
                  [all_carr[k] for k in t_all.query(q, predicate="intersects")]
            if cut:
                q = q.difference(shapely.union_all([c.buffer(0.5) for c in cut]))
            for qq in _polys(q.buffer(-1.0)):
                if qq.area < 100:
                    continue
                x0, y0, x1, y1 = qq.bounds
                xs = np.arange(math.floor(x0 / step) * step, x1 + step, step)
                ys = np.arange(math.floor(y0 / step) * step, y1 + step, step)
                X, Y = np.meshgrid(xs, ys)
                inn = shapely.contains_xy(qq, X, Y)
                shapely.prepare(qq)
                for (dx, dy) in ((1, 0), (0, 1), (1, 1)):
                    for i in range(len(ys)):
                        for k in range(len(xs)):
                            i2, k2 = i + dy, k + dx
                            if not inn[i, k] or not (0 <= i2 < len(ys) and 0 <= k2 < len(xs)) or not inn[i2, k2]:
                                continue
                            seg = LineString([(xs[k], ys[i]), (xs[k2], ys[i2])])
                            if qq.contains(seg):
                                lines.append((np.asarray(seg.coords), K_SQUARE, -1))
                pts = np.c_[X[inn], Y[inn]]
                if len(pts):
                    # крайние узлы решётки — кандидаты на связки
                    edge_pts = [pt for pt in pts if qq.exterior.distance(Point(pt)) < step * 1.2]
                    sq_extra.extend(edge_pts)
                st["squares"] += 1
    log(f"  пешеходы: линий {len(lines)} ({dict(st)}), {time.time() - t0:.1f} с")

    # упрощение (точки шли с шагом 1–2 м; узлы графа нужны реже)
    lines = [(np.asarray(LineString(Q).simplify(0.2).coords) if len(Q) > 2 else Q, k, c) for Q, k, c in lines]
    # ---------- связки концов
    geoms = np.array([LineString(Q) for Q, _, _ in lines], dtype=object)
    tree = STRtree(geoms)
    cands, yard_ends = [], set()
    for i, (Q, kind, _) in enumerate(lines):
        if kind == K_CROSSING:
            continue
        cands.append((Q[0], i)); cands.append((Q[-1], i))
        if kind == K_YARD:   # концы дворовых проездов упираются в устье: продлеваем поиск
            yard_ends.update({len(cands) - 2, len(cands) - 1})
    for pt in sq_extra:
        cands.append((np.asarray(pt), -1))
    links = []
    pts_arr = shapely.points(np.array([c[0] for c in cands]))
    near = tree.query(pts_arr, predicate="dwithin", distance=LINK_R * 1.5)
    by_c = defaultdict(list)
    for ci, gi in zip(*near):
        by_c[int(ci)].append(int(gi))
    for ci, gis in by_c.items():
        p, own = cands[ci]
        P = pts_arr[ci]
        opts = []
        rmax = LINK_R * (1.5 if ci in yard_ends else 1.0)
        for gi in gis:
            if gi == own:
                continue
            d = geoms[gi].distance(P)
            if d <= rmax:
                opts.append((d, gi))
        opts.sort()
        if not opts or opts[0][0] < 0.05:
            continue
        for d, gi in opts[:4]:
            q = np.asarray(shapely.get_coordinates(shapely.shortest_line(P, geoms[gi]))[1])
            if seg_ok(p, q):
                v = q - p
                v /= (np.linalg.norm(v) or 1)
                links.append((np.array([p, q + v * 0.02]), K_LINK, -1))
                st["links"] += 1
                break
    lines += links

    # ---------- узлы: пересечения линий
    geoms = np.array([LineString(Q) for Q, _, _ in lines], dtype=object)
    tree = STRtree(geoms)
    ia, ib = tree.query(geoms, predicate="intersects")
    m = ia < ib
    ia, ib = ia[m], ib[m]
    cuts = defaultdict(list)
    if len(ia):
        inter = shapely.intersection(geoms[ia], geoms[ib])
        for a, b, g in zip(ia, ib, inter):
            if g.is_empty:
                continue
            if g.geom_type in ("Point", "MultiPoint"):
                xy = shapely.get_coordinates(g)
            else:
                xy = shapely.get_coordinates(shapely.boundary(g)) if g.geom_type != "GeometryCollection" else \
                    shapely.get_coordinates(g)
            for x, y in xy:
                cuts[int(a)].append((x, y)); cuts[int(b)].append((x, y))
    nodes, nkey = [], {}

    def node(x, y):
        k = (int(round(x * 20)), int(round(y * 20)))
        i = nkey.get(k)
        if i is None:
            i = nkey[k] = len(nodes)
            nodes.append((x, y))
        return i

    edges = {}

    def add_edge(a, b, kind, cid):
        if a == b:
            return
        k = (min(a, b), max(a, b))
        old = edges.get(k)
        if old is None or _prio(kind) > _prio(old[0]):
            edges[k] = (kind, cid)

    for li, (Q, kind, cid) in enumerate(lines):
        g = geoms[li]
        s_v = shapely.line_locate_point(g, shapely.points(Q))
        items = [(float(s), float(x), float(y)) for s, (x, y) in zip(s_v, Q)]
        cp = cuts.get(li)
        if cp:
            cpa = np.array(cp)
            s_c = shapely.line_locate_point(g, shapely.points(cpa))
            items += [(float(s), float(x), float(y)) for s, (x, y) in zip(s_c, cpa)]
        items.sort()
        prev = None
        for s, x, y in items:
            if prev is not None:
                if s - prev[0] < 1e-4 and math.hypot(x - prev[1], y - prev[2]) < 0.05:
                    continue
                a, b = node(prev[1], prev[2]), None
                L = math.hypot(x - prev[1], y - prev[2])
                nseg = max(1, int(math.ceil(L / MAX_SEG)))
                last = a
                for k in range(1, nseg + 1):
                    t = k / nseg
                    nb = node(prev[1] + (x - prev[1]) * t, prev[2] + (y - prev[2]) * t)
                    add_edge(last, nb, kind, cid)
                    last = nb
            prev = (s, x, y)
    XY = np.array(nodes)
    # слияние близких узлов
    parent = np.arange(len(XY))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for a, b in cKDTree(XY).query_pairs(SNAP):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    root = np.array([find(i) for i in range(len(XY))])
    E = {}
    for (a, b), (kind, cid) in edges.items():
        a, b = root[a], root[b]
        if a == b:
            continue
        k = (min(a, b), max(a, b))
        if k not in E or _prio(kind) > _prio(E[k][0]):
            E[k] = (kind, cid)

    # ---------- чистка: висячие короткие хвосты и мелкие компоненты
    adj = defaultdict(set)
    for a, b in E:
        adj[a].add(b); adj[b].add(a)

    def elen(a, b):
        return math.hypot(*(XY[a] - XY[b]))
    removed = 0
    for _ in range(2):
        for v in [v for v in list(adj) if len(adj[v]) == 1]:
            chain, cur, prev, L = [v], v, None, 0.0
            ok = True
            while True:
                nxt = [w for w in adj[cur] if w != prev]
                if len(adj[cur]) > 2 or not nxt:
                    break
                w = nxt[0]
                kind = E[(min(cur, w), max(cur, w))][0]
                if kind not in (K_LINK, K_SIDEWALK, K_YARD):
                    ok = False
                    break
                L += elen(cur, w)
                prev, cur = cur, w
                chain.append(cur)
                if L > 3.5:
                    ok = False
                    break
            if ok and len(adj[cur]) > 2 and L <= 3.5:
                for a, b in zip(chain[:-1], chain[1:]):
                    E.pop((min(a, b), max(a, b)), None)
                    adj[a].discard(b); adj[b].discard(a)
                    removed += 1
    st["stub_edges_removed"] = removed
    # компоненты
    comp = {}
    for v in list(adj):
        if v in comp or not adj[v]:
            continue
        stack, members, L = [v], [], 0.0
        comp[v] = v
        while stack:
            u = stack.pop()
            members.append(u)
            for w in adj[u]:
                if w not in comp:
                    comp[w] = v
                    stack.append(w)
        tot = sum(elen(u, w) for u in members for w in adj[u]) / 2
        if tot < MIN_COMPONENT:
            for u in members:
                for w in list(adj[u]):
                    E.pop((min(u, w), max(u, w)), None)
            st["small_components"] += 1
    used = sorted({v for e in E for v in e})
    remap = {v: i for i, v in enumerate(used)}
    XY = XY[used]
    E = {(remap[a], remap[b]): v for (a, b), v in E.items()}
    st["nodes"] = len(XY); st["edges"] = len(E)
    # доля крупнейшей компоненты связности
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    ea = np.array(list(E.keys()))
    ncomp, lab = connected_components(coo_matrix((np.ones(len(ea)), (ea[:, 0], ea[:, 1])), shape=(len(XY), len(XY))), directed=False)
    st["components"] = int(ncomp)
    st["largest_component_pct"] = round(float(np.bincount(lab).max() / len(XY) * 100), 1)

    # ---------- высоты
    grid, H, base = inp["grid"], inp["H"], inp["base"]
    terr = grid.sample(H, XY[:, 0], XY[:, 1]) - base
    pts = shapely.points(XY)
    on_fp = np.zeros(len(XY), bool)
    on_fp[t_fp.query(pts, predicate="intersects")[0]] = True
    on_road = np.zeros(len(XY), bool)
    on_road[t_all.query(pts, predicate="intersects")[0]] = True
    lift = np.where(on_fp, H_SIDEWALK, np.where(on_road, H_ROAD + 0.01, H_AREA))
    # опущенный бордюр у переходов (4 м вдоль дороги)
    cr_xy = np.array([c["c"] for c in crossings_out]) if crossings_out else np.zeros((0, 2))
    if len(cr_xy):
        kd = cKDTree(cr_xy)
        for i, js in enumerate(kd.query_ball_point(XY, 14.0)):
            if not on_fp[i] or not js:
                continue
            for j in js:
                c = crossings_out[j]
                t = np.array([-(c["b"] - c["a"])[1], (c["b"] - c["a"])[0]]); t /= (np.linalg.norm(t) or 1)
                along = abs(float(np.dot(XY[i] - c["c"], t)))
                if along < 2.0:
                    lift[i] = H_LOWERED
                elif along < 3.5:
                    lift[i] = min(lift[i], H_LOWERED + (H_SIDEWALK - H_LOWERED) * (along - 2.0) / 1.5)
    Y = terr + lift
    from . import lybed as LY   # Лыбедский бульвар: проходы под Астраханским мостом, площадки у порталов (docs/stage3/lybed.md)
    XY, Y, E = LY.walk_append(XY, Y, E, K_PATH, st)

    # ---------- зоны
    mk = mask.at(XY[:, 0], XY[:, 1])
    B = BITS
    zone = np.zeros(len(XY), np.int64)
    zone |= np.where(mk & (B["PARK"] | B["WOOD"]), Z_PARK, 0)
    zone |= np.where(mk & B["INDUSTRIAL"], Z_INDUSTRIAL, 0)
    zone |= np.where(mk & B["APT40"], Z_RESIDENTIAL, 0)
    zone |= np.where(mk & B["YARD"], Z_YARD, 0)
    zone |= np.where(np.hypot(XY[:, 0] - CENTER[0], XY[:, 1] - CENTER[1]) < CENTER_R, Z_CENTER, 0)
    if inp.get("ped_streets"):
        pz = shapely.union_all([p.buffer(0.5) for p in inp["ped_streets"]])
        zone |= np.where(shapely.contains_xy(pz, XY[:, 0], XY[:, 1]), Z_PEDESTRIAN, 0)
        st["nodes_pedestrian_street"] = int(((zone & Z_PEDESTRIAN) != 0).sum())
    shop_xy = np.array([(x, y) for x, y, _ in inp["shops"]]) if inp["shops"] else np.zeros((0, 2))
    com = [p for p, c in inp["buildings"] if c == "commercial"]
    com_pts = np.array([p.representative_point().coords[0] for p in com]) if com else np.zeros((0, 2))
    attract = np.r_[shop_xy, com_pts]
    if len(attract):
        cnt = np.array([len(x) for x in cKDTree(attract).query_ball_point(XY, 60.0)])
        zone |= np.where(cnt >= 2, Z_COMMERCIAL, 0)

    # ---------- POI
    kd_n = cKDTree(XY)
    pois = []
    blds_tree_polys = [(q, c) for p, c in inp["buildings"] for q in _polys(p)]
    t_b2 = STRtree([q for q, _ in blds_tree_polys])

    def attach(p, start_off=None, r=POI_R):
        """Ближайший узел графа, до которого из p можно дойти по прямой."""
        ds, ids = kd_n.query(p, k=8, distance_upper_bound=r)
        for d, i in zip(np.atleast_1d(ds), np.atleast_1d(ids)):
            if not np.isfinite(d):
                break
            a = p if start_off is None else start_off
            if seg_ok(a, XY[i]):
                return int(i)
        return -1

    def poi(t, x, y, n, rot=None, y_override=None, **extra):
        yv = y_override if y_override is not None else \
            float(grid.sample(H, np.array([x]), np.array([y]))[0] - base) + (H_AREA if not on_any(x, y) else H_SIDEWALK)
        o = {"t": t, "x": round(float(x), 2), "y": round(float(yv), 2), "z": round(float(-y), 2), "n": n}
        if rot is not None:
            o["r"] = round(float(rot), 3)
        o.update(extra)
        pois.append(o)

    def on_any(x, y):
        return len(t_fp.query(Point(x, y), predicate="intersects")) > 0

    def facade_point(bp, toward):
        ring = bp.exterior
        s = ring.project(Point(toward))
        e = np.array(ring.interpolate(s).coords[0])
        a = np.array(ring.interpolate(s - 0.5).coords[0]); c = np.array(ring.interpolate(s + 0.5).coords[0])
        t = c - a; t /= (np.linalg.norm(t) or 1)
        nrm = np.array([t[1], -t[0]])
        if bp.contains(Point(*(e + nrm * 0.3))):
            nrm = -nrm
        return e + nrm * 0.6, nrm

    # входы OSM
    ent_bld = set()
    for x, y, kind in inp["entrances"]:
        if kind in ("emergency", "exit", "service", "garage"):
            continue
        idx = t_b2.query_nearest(Point(x, y), max_distance=3.0)
        if len(idx) == 0:
            continue
        bp, cat = blds_tree_polys[int(idx[0])]
        ent_bld.add(int(idx[0]))
        q, nrm = facade_point(bp, (x, y))
        n = attach(q)
        if n >= 0:
            poi("entrance", q[0], q[1], n, rot=math.atan2(-nrm[0], nrm[1]), src=1)
            st["poi_entrance_osm"] += 1
    # процедурные входы: жилые и коммерческие дома
    for bi, (bp, cat) in enumerate(blds_tree_polys):
        if bi in ent_bld or cat not in ("apartments", "commercial", "other") or bp.area < (150 if cat != "other" else 400):
            continue
        ring = bp.exterior
        L = ring.length
        k = max(1, min(4, int(L / 60)))
        ss = np.arange(0, L, 6.0)
        best = []
        for s in ss:
            q, nrm = facade_point(bp, ring.interpolate(s).coords[0])
            d, i = kd_n.query(q, distance_upper_bound=POI_R)
            if np.isfinite(d):
                best.append((d, s, q, nrm, int(i)))
        best.sort(key=lambda z: z[0])
        chosen = []
        for d, s, q, nrm, i in best:
            if len(chosen) >= k:
                break
            if any(min(abs(s - s2), L - abs(s - s2)) < 20 for s2 in chosen):
                continue
            n = attach(q)
            if n < 0:
                continue
            chosen.append(s)
            poi("shop" if cat == "commercial" else "entrance", q[0], q[1], n, rot=math.atan2(-nrm[0], nrm[1]), src=0)
            st["poi_entrance_proc" if cat != "commercial" else "poi_shop_bld"] += 1
    # магазины OSM
    for x, y, kind in inp["shops"]:
        p = np.array([x, y])
        idx = t_b2.query(Point(x, y), predicate="intersects")
        if len(idx):
            bp = blds_tree_polys[int(idx[0])][0]
            d, i = kd_n.query(p)
            q, nrm = facade_point(bp, XY[i])
        else:
            q, nrm = p, None
        n = attach(q, r=40.0)
        if n >= 0:
            rot = math.atan2(-nrm[0], nrm[1]) if nrm is not None else None
            poi("shop", q[0], q[1], n, rot=rot, kind=kind)
            st["poi_shop_osm"] += 1
    # остановки, лавки, детские комплексы
    props = inp["props"]
    for x, y, yv, rot in props.get("bus_stop", []):
        f = np.array([-math.sin(rot), math.cos(rot)])
        q = np.array([x, y]) + f * 1.4
        n = attach(q, r=20.0)
        if n >= 0:
            poi("bus_stop", q[0], q[1], n, rot=rot, y_override=float(grid.sample(H, q[:1], q[1:])[0] - base) + H_SIDEWALK
                if on_any(*q) else None)
            st["poi_bus_stop"] += 1
    for x, y, yv, rot in props.get("bench", []):
        n = attach(np.array([x, y]), r=15.0)
        if n >= 0:
            poi("bench", x, y, n, rot=rot, y_override=yv)
            st["poi_bench"] += 1
    for x, y, yv, rot in props.get("playground_set", []):
        n = attach(np.array([x, y]), r=30.0)
        if n >= 0:
            poi("playground", x, y, n, rot=rot, y_override=yv)
            st["poi_playground"] += 1
    # пешеходные улицы: уличные музыканты и «компании» (world/pedestrian_streets.py)
    for t, x, y, rot in inp.get("ped_pois", []):
        n = attach(np.array([x, y]), r=12.0)
        if n >= 0:
            poi(t, x, y, n, rot=rot, y_override=float(grid.sample(H, np.array([x]), np.array([y]))[0] - base) + H_AREA)
            st["poi_" + t + "_ped_street"] += 1
    # парки: узел графа в парке, по одному на клетку 40 м
    seen = set()
    for i in np.nonzero(zone & Z_PARK)[0]:
        k = (int(XY[i, 0] // 40), int(XY[i, 1] // 40))
        if k in seen:
            continue
        seen.add(k)
        poi("park", XY[i, 0], XY[i, 1], int(i), y_override=float(Y[i]))
        st["poi_park"] += 1

    # ---------- вывод
    order = sorted(E)
    ekind = np.array([E[k][0] for k in order])
    cr_used = sorted({E[k][1] for k in order if E[k][0] == K_CROSSING})
    cr_new = {c: i for i, c in enumerate(cr_used)}
    crossings_final = []
    cross_nodes = defaultdict(list)
    for k in order:
        kind, cid = E[k]
        if kind == K_CROSSING:
            cross_nodes[cid].extend(k)
    for c in cr_used:
        co = crossings_out[c]
        ns = cross_nodes[c]
        # концы перехода: узлы, ближайшие к бордюрным точкам a/b
        na = min(ns, key=lambda v: np.hypot(*(XY[v] - co["a"])))
        nb = min(ns, key=lambda v: np.hypot(*(XY[v] - co["b"])))
        yc = float(grid.sample(H, co["c"][:1], co["c"][1:])[0] - base) + H_ROAD + 0.01
        crossings_final.append({"id": cr_new[c], "a": int(na), "b": int(nb), "x": round(float(co["c"][0]), 2),
                                "y": round(yc, 2), "z": round(float(-co["c"][1]), 2), "width": round(float(co["width"]), 2),
                                "road": co["road"], "junction": co["junction"], "signal": co["signal"],
                                "marked": co["marked"], "sumoJunction": co["sj"], "sumoEdge": co["se"]})
    flat_e = []
    for k in order:
        kind, cid = E[k]
        flat_e += [int(k[0]), int(k[1]), int(kind), cr_new.get(cid, -1) if kind == K_CROSSING else -1]
    flat_n = np.c_[XY[:, 0], Y, -XY[:, 1]].round(2).ravel().tolist()
    st["crossings_in_graph"] = len(crossings_final)
    st["crossings_in_graph_signal"] = sum(1 for c in crossings_final if c["junction"] >= 0)
    st["edge_km"] = round(float(sum(np.hypot(*(XY[a] - XY[b])) for a, b in order)) / 1000, 1)
    for i, nm in enumerate(KIND_NAMES):
        st["km_" + nm] = round(float(sum(np.hypot(*(XY[a] - XY[b])) for (a, b), kk in zip(order, ekind) if kk == i)) / 1000, 1)
    out = {"version": VERSION, "kinds": KIND_NAMES, "poiTypes": POI_TYPES,
           "zones": {"center": Z_CENTER, "commercial": Z_COMMERCIAL, "residential": Z_RESIDENTIAL, "park": Z_PARK,
                     "industrial": Z_INDUSTRIAL, "yard": Z_YARD, "pedestrian_street": Z_PEDESTRIAN},
           "nodes": flat_n, "zone": zone.tolist(), "edges": flat_e, "crossings": crossings_final, "pois": pois,
           "stats": {k: (round(v, 1) if isinstance(v, float) else int(v) if isinstance(v, (np.integer, bool)) else v)
                     for k, v in st.items()}}
    log(f"  пешеходы: граф {len(XY)} узлов, {len(order)} рёбер, {st['edge_km']} км, переходов {len(crossings_final)}, "
        f"POI {len(pois)}; {time.time() - t0:.1f} с")
    return out


def drop_fence_edges(out, fences):
    """Удаляет рёбра, пересекающие оставшиеся ограды (после world/fence_gaps.py). Узлы не трогаем."""
    if not fences:
        return 0
    nn = np.asarray(out["nodes"], float).reshape(-1, 3)
    XY = np.c_[nn[:, 0], -nn[:, 2]]
    E = np.asarray(out["edges"], np.int64).reshape(-1, 4)
    segs = shapely.linestrings(np.stack([XY[E[:, 0]], XY[E[:, 1]]], axis=1))
    ei, _ = STRtree(fences).query(segs, predicate="intersects")
    bad = np.zeros(len(E), bool)
    bad[ei] = True
    out["edges"] = E[~bad].ravel().tolist()
    out["stats"]["edges"] = int((~bad).sum())
    out["stats"]["edges_dropped_fence"] = int(bad.sum())
    return int(bad.sum())


def _prio(kind):
    return {K_CROSSING: 5, K_SIDEWALK: 4, K_SQUARE: 3, K_PATH: 2, K_YARD: 1, K_LINK: 0}[kind]


def _polys(g):
    if g is None or g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    return [q for q in getattr(g, "geoms", []) if q.geom_type == "Polygon" and not q.is_empty]


def _lines(g):
    if g.is_empty:
        return []
    if g.geom_type == "LineString":
        return [g]
    out = []
    for q in getattr(g, "geoms", []):
        out += _lines(q)
    return out


def write(out, out_dir):
    d = out_dir / "people"
    d.mkdir(parents=True, exist_ok=True)
    js = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    (d / "walk.json").write_text(js)
    return len(js)


# =====================================================================================
def build(ctx, crossings, yard, out_dir, osm_path, log=log_default):
    """Точка входа из build_world.py. Пишет <out>/people/walk.json, возвращает краткую статистику."""
    out = getattr(yard, "walk_out", None)       # уже посчитан до проходов в оградах (world/fence_gaps.py)
    if out is None:
        inp = gather(ctx, crossings, yard, osm_path)
        dump = os.environ.get("WALK_DUMP")
        if dump:
            with open(dump, "wb") as f:
                pickle.dump(inp, f, protocol=5)
        out = compute(inp, log)
    size = write(out, out_dir)
    s = out["stats"]
    return {"nodes": s["nodes"], "edges": s["edges"], "km": s["edge_km"], "crossings": s["crossings_in_graph"],
            "signal": s["crossings_in_graph_signal"], "pois": len(out["pois"]), "MB": round(size / 1e6, 1)}


if __name__ == "__main__":
    from pathlib import Path
    with open(sys.argv[1], "rb") as f:
        inp = pickle.load(f)
    res = compute(inp)
    print(f"walk.json: {write(res, Path(sys.argv[2])) / 1e6:.1f} МБ", res["stats"])
