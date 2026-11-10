"""Экспорт графа полос для трафика игры: game/public/world/traffic/{net.json, geom.bin}.

Источник — net.xml SUMO (полосы, соединения через перекрёстки, приоритеты, программы светофоров) и
отношения OSM route=bus/trolleybus/share_taxi. Формат: docs/world-format.md, «Дополнение: трафик».
Высоты точек — по фактическому мешу `roads` (как у разметки: markings.RoadSurface), на мостах — по настилу.
"""
import heapq
import json
import math
import re
import xml.etree.ElementTree as ET
from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString

from .markings import RoadSurface
from .roads import PRIORITY, base_class, cumlen, highway_class, resample

STEP = 4.0          # м, шаг выборки высоты вдоль полосы
SIMPLIFY = 0.04     # м, допуск упрощения ломаной в 3D
ROUTE_TYPES = {"bus": "bus", "trolleybus": "trolleybus", "share_taxi": "share_taxi", "minibus": "share_taxi"}
CLS_CAR, CLS_BUS, CLS_SERVICE = 1, 2, 4


# ---------------- разбор net.xml (полностью, с internal-полосами и запросами приоритета)
def _shape(s):
    return np.array([[float(v) for v in p.split(",")[:2]] for p in s.split()], dtype=np.float64)


def _allowed(vc, allow, disallow):
    if allow:
        return vc in allow.split()
    if disallow:
        return vc not in disallow.split()
    return True


def parse_net(path):
    edges, ilanes, junctions, conns, tls = {}, {}, {}, [], []
    for _, el in ET.iterparse(path):
        t = el.tag
        if t == "edge":
            fn = el.get("function")
            if fn == "internal":
                for ln in el.iter("lane"):
                    ilanes[ln.get("id")] = {"shape": _shape(ln.get("shape")), "speed": float(ln.get("speed")),
                                            "length": float(ln.get("length"))}
            elif fn not in ("walkingarea", "crossing"):
                lanes = []
                for ln in el.iter("lane"):
                    lanes.append({"id": ln.get("id"), "index": int(ln.get("index")), "speed": float(ln.get("speed")),
                                  "length": float(ln.get("length")), "width": float(ln.get("width", 3.2)),
                                  "shape": _shape(ln.get("shape")), "allow": ln.get("allow"), "disallow": ln.get("disallow")})
                lanes.sort(key=lambda l: l["index"])
                edges[el.get("id")] = {"id": el.get("id"), "from": el.get("from"), "to": el.get("to"),
                                       "type": el.get("type", ""), "name": el.get("name", ""), "lanes": lanes}
            el.clear()
        elif t == "junction":
            if el.get("type") != "internal":
                junctions[el.get("id")] = {"id": el.get("id"), "type": el.get("type"), "x": float(el.get("x")),
                                           "y": float(el.get("y")), "int": (el.get("intLanes") or "").split(),
                                           "req": {int(r.get("index")): (r.get("response"), r.get("foes")) for r in el.iter("request")}}
            el.clear()
        elif t == "connection":
            conns.append(dict(el.attrib))
            el.clear()
        elif t == "tlLogic":
            tls.append({"id": el.get("id"), "offset": float(el.get("offset", 0)),
                        "phases": [(float(p.get("duration")), p.get("state")) for p in el.iter("phase")]})
            el.clear()
    return edges, ilanes, junctions, conns, tls


def _piece(eid):
    """'-38003982300#1' -> (osm_id, кусок k, номер #n, обратное?)."""
    m = re.match(r"(-?)(\d+)(?:#(\d+))?$", eid)
    if not m:
        return None
    p = int(m.group(2))
    return p // 100, p % 100, int(m.group(3) or 0), m.group(1) == "-"


def _simplify3(P, tol):
    """Дуглас–Пекер в 3D (итеративно); концы сохраняются."""
    n = len(P)
    if n <= 2:
        return P
    keep = np.zeros(n, bool); keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        A, B = P[a], P[b]
        d = B - A
        L2 = float(d @ d)
        Q = P[a + 1:b] - A
        if L2 < 1e-12:
            dist = np.linalg.norm(Q, axis=1)
        else:
            t = np.clip(Q @ d / L2, 0, 1)
            dist = np.linalg.norm(Q - t[:, None] * d, axis=1)
        k = int(np.argmax(dist))
        if dist[k] > tol:
            m = a + 1 + k
            keep[m] = True
            stack += [(a, m), (m, b)]
    return P[keep]


# ---------------- основной экспорт
def export(ctx, osm, out_dir, log=print):
    net_path = ctx["net_path"]
    roads, zj, floating, jix = ctx["roads"], ctx["zj"], ctx["floating"], ctx["jix"]
    surf, base, lift = ctx["surf"], ctx["base"], ctx["lift"]
    edges, ilanes, junctions, conns, tls_list = parse_net(net_path)
    rs = ctx.get("road_surface") or RoadSurface(ctx["tiles"])

    edge_road = {}
    for r in roads:
        for e in (r.fwd, r.bwd):
            if e is not None:
                edge_road[e["id"]] = r

    geom = []           # куски Float32 xyz
    npts = [0]

    def put(XY, est):
        """Высоты по мешу дорог, упрощение, запись; -> (p0, pn)."""
        y = rs.height(XY, est)
        P = _simplify3(np.c_[XY[:, 0], y, -XY[:, 1]], SIMPLIFY)
        p0 = npts[0]
        geom.append(P.astype("<f4"))
        npts[0] += len(P)
        return p0, len(P)

    def lane_est(XY, eid):
        r = edge_road.get(eid)
        if r is not None and r.bridge:
            s = shapely.line_locate_point(LineString(r.axis), shapely.points(XY))
            return np.interp(s, r.s_axis, r.z_axis) - base + lift
        return surf(XY[:, 0], XY[:, 1])

    def junc_est(XY, jid):
        if jid in zj and floating[jix[jid]]:
            return np.full(len(XY), zj[jid] - base + lift)
        return surf(XY[:, 0], XY[:, 1])

    # --- рёбра и полосы
    E_ids = sorted(edges)
    e_ix = {e: i for i, e in enumerate(E_ids)}
    J_ids = sorted(junctions)
    j_ix = {j: i for i, j in enumerate(J_ids)}
    L = defaultdict(list)
    lane_ix = {}
    E_out = []
    for eid in E_ids:
        e = edges[eid]
        hw = highway_class(e["type"])
        lanes = []
        for ln in e["lanes"]:
            XY = resample(ln["shape"], STEP)
            if len(XY) < 2:
                XY = np.array([ln["shape"][0], ln["shape"][-1]])
            p0, pn = put(XY, lane_est(XY, eid))
            cls = 0
            if _allowed("passenger", ln["allow"], ln["disallow"]):
                cls |= CLS_CAR
            elif _allowed("delivery", ln["allow"], ln["disallow"]):
                cls |= CLS_SERVICE
            if _allowed("bus", ln["allow"], ln["disallow"]):
                cls |= CLS_BUS
            lane_ix[ln["id"]] = len(L["edge"])
            lanes.append(len(L["edge"]))
            L["edge"].append(e_ix[eid]); L["index"].append(ln["index"]); L["speed"].append(round(ln["speed"], 2))
            L["length"].append(round(float(cumlen(XY)[-1]), 2)); L["width"].append(round(ln["width"], 2))
            L["cls"].append(cls); L["p0"].append(p0); L["pn"].append(pn)
        pc = _piece(eid)
        r = edge_road.get(eid)
        E_out.append({"id": eid, "from": j_ix.get(e["from"], -1), "to": j_ix.get(e["to"], -1), "hw": hw,
                      "prio": PRIORITY.get(base_class(hw), 1), "name": e["name"], "lanes": lanes,
                      "osmId": pc[0] if pc else None, "bridge": bool(r is not None and r.bridge)})

    # --- соединения (from lane -> to lane через цепочку internal-полос)
    nxt_int = {}
    for c in conns:
        if c["from"].startswith(":") and c.get("via"):
            nxt_int[f'{c["from"]}_{c["fromLane"]}'] = c["via"]
    C = defaultdict(list)
    link_of = {}   # (junction, request index) -> conn idx
    foes_raw = []
    for c in conns:
        if c["from"].startswith(":"):
            continue
        fl, tl_ = f'{c["from"]}_{c["fromLane"]}', f'{c["to"]}_{c["toLane"]}'
        if fl not in lane_ix or tl_ not in lane_ix:
            continue
        via = c.get("via")
        if via:
            chain = [via]
            while chain[-1] in nxt_int and len(chain) < 6:
                chain.append(nxt_int[chain[-1]])
            jid = via[1:].rsplit("_", 2)[0]
            shp = [ilanes[v]["shape"] for v in chain if v in ilanes]
            XY = np.concatenate([s if k == 0 else s[1:] for k, s in enumerate(shp)]) if shp else None
            speed = min(ilanes[v]["speed"] for v in chain if v in ilanes) if shp else 13.89
        else:
            jid = edges[c["from"]]["to"]
            XY, speed = None, 13.89
        a = edges[c["from"]]["lanes"][int(c["fromLane"])]["shape"][-1]
        b = edges[c["to"]]["lanes"][int(c["toLane"])]["shape"][0]
        if XY is None or len(XY) < 2:
            XY = np.array([a, b])
        XY = resample(XY, STEP)
        if len(XY) < 2:
            XY = np.array([a, a + 0.01])
        ci = len(C["from"])
        p0, pn = put(XY, junc_est(XY, jid))
        C["from"].append(lane_ix[fl]); C["to"].append(lane_ix[tl_]); C["junction"].append(j_ix.get(jid, -1))
        C["length"].append(round(float(cumlen(XY)[-1]), 2)); C["speed"].append(round(speed, 2))
        C["dir"].append(c.get("dir", "s")); C["state"].append(c.get("state", "M"))
        C["p0"].append(p0); C["pn"].append(pn)
        tl = c.get("tl")
        C["tl"].append(tl); C["link"].append(int(c.get("linkIndex", -1)) if tl else -1)
        J = junctions.get(jid)
        ri = J["int"].index(via) if (J and via and via in J["int"]) else -1
        if ri >= 0:
            link_of[(jid, ri)] = ci
        foes_raw.append((jid, ri))
    # приоритеты: response (кому уступать) и foes (с кем пересекаемся) — индексы соединений
    resp, foes = [], []
    for jid, ri in foes_raw:
        rr, ff = [], []
        if ri >= 0 and ri in junctions[jid]["req"]:
            rsp, fo = junctions[jid]["req"][ri]
            n = len(rsp)
            for k in range(n):
                cj = link_of.get((jid, k))
                if cj is None:
                    continue
                if rsp[n - 1 - k] == "1":
                    rr.append(cj)
                if fo[n - 1 - k] == "1":
                    ff.append(cj)
        resp.append(rr); foes.append(ff)

    # --- светофоры
    tl_ix = {t["id"]: i for i, t in enumerate(tls_list)}
    tls_j = defaultdict(set)
    for ci, tl in enumerate(C["tl"]):
        if tl is not None and C["junction"][ci] >= 0:
            tls_j[tl].add(C["junction"][ci])
    C["tl"] = [tl_ix.get(t, -1) if t is not None else -1 for t in C["tl"]]
    TLS = [{"id": t["id"], "offset": t["offset"], "phases": [[d, s] for d, s in t["phases"]],
            "junctions": sorted(tls_j.get(t["id"], []))} for t in tls_list]
    J_tl = [-1] * len(J_ids)
    for i, t in enumerate(TLS):
        for j in t["junctions"]:
            J_tl[j] = i

    # --- главная компонента (сильная связность по полосам для легковых): туда ездит случайный трафик
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    car_lane = np.array([(c & CLS_CAR) > 0 for c in L["cls"]])
    lane_edge = np.array(L["edge"])
    ef, et = [], []
    for a, b in zip(C["from"], C["to"]):
        if car_lane[a] and car_lane[b]:
            ef.append(lane_edge[a]); et.append(lane_edge[b])
    nE = len(E_out)
    g = coo_matrix((np.ones(len(ef)), (ef, et)), shape=(nE, nE)).tocsr()
    _, lab = connected_components(g, directed=True, connection="strong")
    has_car = np.zeros(nE, bool)
    has_car[lane_edge[car_lane]] = True
    big = np.bincount(lab[has_car]).argmax() if has_car.any() else -1
    for i, e in enumerate(E_out):
        e["main"] = int(bool(has_car[i] and lab[i] == big))

    # --- маршруты ОТ
    routes, rstat = build_routes(osm, edges, E_ids, e_ix, E_out, L, C, log)

    # --- запись
    out_dir.mkdir(parents=True, exist_ok=True)
    G = np.concatenate(geom) if geom else np.zeros((0, 3), "<f4")
    G.astype("<f4").tofile(out_dir / "geom.bin")
    J_out = {"id": J_ids, "type": [junctions[j]["type"] for j in J_ids],
             "x": [round(junctions[j]["x"], 2) for j in J_ids], "z": [round(-junctions[j]["y"], 2) for j in J_ids],
             "y": [round(float(junc_est(np.array([[junctions[j]["x"], junctions[j]["y"]]]), j)[0]), 2) for j in J_ids],
             "tl": J_tl}
    doc = {"version": 1, "geom": "geom.bin", "points": int(len(G)),
           "edges": E_out, "lanes": dict(L), "conns": {**{k: v for k, v in C.items() if k not in ("dir", "state")},
                                                      "dir": "".join(C["dir"]), "state": "".join(C["state"]),
                                                      "resp": resp, "foes": foes},
           "junctions": J_out, "tls": TLS, "routes": routes}
    (out_dir / "net.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    sz = (out_dir / "net.json").stat().st_size + (out_dir / "geom.bin").stat().st_size
    return (f"рёбер {nE} (главная компонента {sum(e['main'] for e in E_out)}), полос {len(L['edge'])}, "
            f"соединений {len(C['from'])}, светофоров {len(TLS)}, точек {len(G)}, маршрутов {len(routes)} {rstat}, "
            f"{sz / 1e6:.1f} МБ; попаданий в меш {rs.hits}/{rs.total}")


# ---------------- маршруты общественного транспорта
def build_routes(osm, edges, E_ids, e_ix, E_out, L, C, log):
    """Отношения route=bus/trolleybus/share_taxi (PTv2) -> куски маршрута как последовательности рёбер SUMO + остановки."""
    nE = len(E_ids)
    lane_edge = L["edge"]
    elen = np.array([L["length"][E_out[i]["lanes"][0]] for i in range(nE)])
    bus_ok = np.array([any(L["cls"][l] & (CLS_BUS | CLS_CAR | CLS_SERVICE) for l in E_out[i]["lanes"]) for i in range(nE)])
    adj = defaultdict(set)
    for a, b in zip(C["from"], C["to"]):
        ea, eb = lane_edge[a], lane_edge[b]
        if bus_ok[eb]:
            adj[ea].add(eb)
    # рёбра по пути OSM: (osm_id, обратное?) -> рёбра в порядке движения
    by_way = defaultdict(list)
    for eid in E_ids:
        pc = _piece(eid)
        if pc:
            by_way[(pc[0], pc[3])].append((pc[1], pc[2], e_ix[eid]))
    children = defaultdict(list)   # правки overrides: куски разрезанного пути (nfr:parent)
    for wid, (_, tg) in osm.ways.items():
        if "nfr:parent" in tg:
            try:
                children[int(tg["nfr:parent"])].append(wid)
            except ValueError:
                pass

    def chain(wid, back):
        out = []
        parts = [wid] + sorted(children.get(wid, []))
        for w in (parts[::-1] if back else parts):
            es = sorted(by_way.get((w, back), []))
            if back:
                es = es[::-1]
            out += [e for _, _, e in es]
        return out

    end_xy = np.array([edges[E_ids[i]]["lanes"][0]["shape"][-1] for i in range(nE)])
    start_xy = np.array([edges[E_ids[i]]["lanes"][0]["shape"][0] for i in range(nE)])

    def dijkstra(src, targets, cutoff, pref):
        """Кратчайший путь от конца ребра src до начала одного из targets; стоимость = длины промежуточных рёбер
        (рёбра маршрута дешевле). -> {target: (cost, path без src и target)}."""
        dist, prev = {src: 0.0}, {}
        pq = [(0.0, src)]
        found = {}
        tg = set(targets)
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist.get(u, 1e18) or d > cutoff:
                continue
            if u in tg and u != src:
                path = []
                k = u
                while prev.get(k, src) != src:
                    k = prev[k]; path.append(k)
                found[u] = (d, path[::-1])
                if len(found) == len(tg):
                    break
                continue
            for v in adj.get(u, ()):
                w = 0.0 if v in tg else elen[v] * (1.0 if v in pref else 2.5)
                nd = d + w
                if nd < dist.get(v, 1e18):
                    dist[v] = nd; prev[v] = u
                    heapq.heappush(pq, (nd, v))
        return found

    routes, n_pieces, n_stops, n_rel = [], 0, 0, 0
    for rid, tg, mem in osm.rels:
        kind = ROUTE_TYPES.get(tg.get("route"))
        if kind is None or tg.get("public_transport:version") != "2":
            continue
        ways = [ref for typ, ref, role in mem if typ == "way" and role in ("", "forward", "backward")]
        if len(ways) < 3:
            continue
        n_rel += 1
        pref = set()
        anchors = []    # [(chains по направлениям)]
        for w in ways:
            refs = osm.ways.get(w, (None, None))[0]
            closed = refs is not None and len(refs) > 2 and refs[0] == refs[-1]
            st = [ch for ch in (chain(w, False), chain(w, True)) if ch]
            for ch in st:
                pref.update(ch)
            if st and not closed:
                anchors.append(st)
        if not anchors:
            continue
        # Витерби по направлениям путей; разрыв (нет пути / большой крюк) -> новый кусок
        pieces = []
        cur = [(0.0, list(ch)) for ch in anchors[0]]
        for st in anchors[1:]:
            new = []
            for ch in st:
                best = None
                for cost, path in cur:
                    if path[-1] == ch[0]:
                        cand = (cost, path + ch[1:])
                    else:
                        f = dijkstra(path[-1], [ch[0]], 2500.0, pref).get(ch[0])
                        if f is None:
                            continue
                        eu = math.dist(end_xy[path[-1]], start_xy[ch[0]])
                        if f[0] > 3 * eu + 400:
                            continue
                        cand = (cost + f[0], path + f[1] + ch)
                    if best is None or cand[0] < best[0]:
                        best = cand
                if best is not None:
                    new.append(best)
            if new:
                cur = new
            else:
                pieces.append(min(cur, key=lambda c: c[0])[1])
                cur = [(0.0, list(ch)) for ch in st]
        pieces.append(min(cur, key=lambda c: c[0])[1])
        # внутри цепочек тоже могут быть разрывы (обрезка bbox, слияние узлов): дозаполняем или режем
        fixed = []
        for p in pieces:
            seq = [p[0]]
            for e in p[1:]:
                if e == seq[-1]:
                    continue
                if e in adj.get(seq[-1], ()):
                    seq.append(e); continue
                f = dijkstra(seq[-1], [e], 600.0, pref).get(e)
                if f is None:
                    fixed.append(seq); seq = [e]
                else:
                    seq += f[1] + [e]
            fixed.append(seq)
        fixed = [p for p in fixed if sum(elen[e] for e in p) > 150]
        if not fixed:
            continue
        # остановки: узлы stop*, иначе платформы; проекция на крайнюю правую полосу рёбер куска, монотонно
        stops_xy = []
        for typ, ref, role in mem:
            if role.startswith("stop") and typ == "node":
                i, ok = osm.node_index(np.array([ref]))
                if ok[0]:
                    stops_xy.append(osm.xy[i[0]])
        if not stops_xy:
            for typ, ref, role in mem:
                if role.startswith("platform"):
                    if typ == "node":
                        i, ok = osm.node_index(np.array([ref]))
                        if ok[0]:
                            stops_xy.append(osm.xy[i[0]])
                    elif typ == "way" and ref in osm.ways:
                        P = osm.way_xy(ref)
                        if len(P):
                            stops_xy.append(P.mean(0))
        out_pieces = []
        for p in fixed:
            lines = [LineString(edge_shape(E_out, L, edges, E_ids, e)) for e in p]
            stops = []
            k0 = 0
            for sxy in stops_xy:
                pt = shapely.Point(sxy)
                best = None
                for k in range(k0, len(p)):
                    d = lines[k].distance(pt)
                    if d < 25 and (best is None or d < best[0] - 0.5):
                        best = (d, k)
                    if best is not None and k > best[1] + 3:
                        break
                if best is None:
                    continue
                k = best[1]
                s = float(lines[k].project(pt)) * elen[p[k]] / max(lines[k].length, 1e-6)
                s = float(np.clip(s + 4.0, 8.0, max(elen[p[k]] - 1.0, 8.0)))   # передом чуть за остановкой
                if elen[p[k]] < 10:
                    continue
                stops.append([k, round(s, 1)])
                k0 = k
            n_stops += len(stops)
            out_pieces.append({"edges": [int(e) for e in p], "stops": stops})
        n_pieces += len(out_pieces)
        routes.append({"osmId": rid, "type": kind, "ref": tg.get("ref") or _ref_from_name(tg.get("name", "")),
                       "name": tg.get("name", ""), "pieces": out_pieces})
    return routes, f"(отношений {n_rel}, кусков {n_pieces}, остановок {n_stops})"


def _ref_from_name(name):
    m = re.search(r"(\d+[А-Яа-яA-Za-z]?)", name)
    return m.group(1) if m else ""


def edge_shape(E_out, L, edges, E_ids, e):
    return edges[E_ids[e]]["lanes"][0]["shape"]
