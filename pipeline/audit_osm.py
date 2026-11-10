"""Аудит покрытия OSM-данных bbox. Вход: data/raw/osm/ryazan.osm, выход: data/processed/osm_audit.json."""
import json
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict

from shapely.geometry import LineString, Point, box
from shapely.ops import linemerge, polygonize, transform, unary_union

from config import BBOX, DATA_PROCESSED, DATA_RAW, to_world

SRC = DATA_RAW / "osm" / "ryazan.osm"
OUT = DATA_PROCESSED / "osm_audit.json"
S, W, N, E = BBOX
BB = box(W, S, E, N)  # lon/lat
CAR = ["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary",
       "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service"]
KEYS = ["lanes", "turn:lanes", "lanes:forward", "lanes:backward", "width", "maxspeed", "surface", "lit", "oneway",
        "name", "sidewalk", "cycleway", "destination", "ref"]
ARTERIALS = ["Первомайский проспект", "Соборная", "Ленина", "Свободы", "Есенина", "Циолковского",
             "Солотчинское шоссе", "Касимовское шоссе", "Московское шоссе", "Лыбедский бульвар", "Высоковольтная",
             "Грибоедова", "Новая", "Магистральная", "Михайловское шоссе", "Подбельского", "Куйбышевское шоссе",
             "Вокзальная", "Каширина", "Октябрьская", "Дзержинского", "Типанова", "Профсоюзная", "Table"]
ARTERIALS = [a for a in ARTERIALS if a != "Table"]
LANDMARK_AMENITY = {"place_of_worship", "theatre", "cinema", "museum", "arts_centre", "university", "library",
                    "townhall", "courthouse", "planetarium", "police", "fountain", "marketplace"}


def proj_len(g):
    return transform(lambda x, y, z=None: to_world.transform(x, y), g).length


def proj_area(g):
    return transform(lambda x, y, z=None: to_world.transform(x, y), g).area


def pct(a, b):
    return round(100 * a / b, 1) if b else 0.0


def main():
    nodes, ways, rels = {}, {}, []
    ntags = {}
    for _, el in ET.iterparse(SRC):
        t = el.tag
        if t == "node":
            nid = el.get("id")
            lon, lat = float(el.get("lon")), float(el.get("lat"))
            nodes[nid] = (lon, lat)
            tg = {c.get("k"): c.get("v") for c in el.findall("tag")}
            if tg and S <= lat <= N and W <= lon <= E:
                ntags[nid] = tg
            el.clear()
        elif t == "way":
            ways[el.get("id")] = ([n.get("ref") for n in el.findall("nd")],
                                  {c.get("k"): c.get("v") for c in el.findall("tag")})
            el.clear()
        elif t == "relation":
            rels.append(({c.get("k"): c.get("v") for c in el.findall("tag")},
                         [(m.get("type"), m.get("ref"), m.get("role")) for m in el.findall("member")]))
            el.clear()
    print(len(nodes), len(ways), len(rels))

    def way_geom(wid):
        refs, _ = ways[wid]
        pts = [nodes[r] for r in refs if r in nodes]
        return pts

    def centroid(pts):
        return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))

    res = {"bbox": BBOX, "counts": {"nodes": len(nodes), "ways": len(ways), "relations": len(rels)}}

    # ---- здания
    bl = Counter(); lv = Counter(); btype = Counter()
    tot = {k: 0 for k in ["levels", "height", "roof", "housenumber", "name", "material", "colour", "min_height", "roof_height", "roof_levels"]}
    parts = 0; part_levels = 0; part_height = 0; total_b = 0; area_b = 0.0
    def add_building(tg, geom=None):
        nonlocal total_b, area_b
        total_b += 1
        btype[tg["building"]] += 1
        if "building:levels" in tg:
            tot["levels"] += 1
            lv[tg["building:levels"]] += 1
        if "height" in tg: tot["height"] += 1
        if "roof:shape" in tg: tot["roof"] += 1
        if "addr:housenumber" in tg: tot["housenumber"] += 1
        if "name" in tg: tot["name"] += 1
        if "building:material" in tg: tot["material"] += 1
        if "building:colour" in tg or "roof:colour" in tg: tot["colour"] += 1
        if "min_height" in tg: tot["min_height"] += 1
        if "roof:height" in tg: tot["roof_height"] += 1
        if "roof:levels" in tg: tot["roof_levels"] += 1
    for wid, (refs, tg) in ways.items():
        if "building" in tg and tg["building"] != "no":
            pts = way_geom(wid)
            if pts and BB.intersects(Point(centroid(pts))):
                add_building(tg)
        if "building:part" in tg:
            pts = way_geom(wid)
            if pts and BB.intersects(Point(centroid(pts))):
                parts += 1
                part_levels += "building:levels" in tg
                part_height += "height" in tg
    for tg, mem in rels:
        if "building" in tg and tg.get("type") == "multipolygon":
            ow = [m for m in mem if m[0] == "way" and m[1] in ways and m[2] == "outer"]
            if ow and any(BB.intersects(Point(centroid(way_geom(m[1])))) for m in ow if way_geom(m[1])):
                add_building(tg)
    def lvkey(k):
        try: return (0, float(k))
        except ValueError: return (1, k)
    res["buildings"] = {
        "total": total_b, "building_part": parts, "building_part_with_levels": part_levels, "building_part_with_height": part_height,
        "with": tot, "with_pct": {k: pct(v, total_b) for k, v in tot.items()},
        "by_type": dict(btype.most_common()),
        "levels_hist": {k: lv[k] for k in sorted(lv, key=lvkey)},
    }

    # ---- дороги
    road = {c: {"count": 0, "km": 0.0, "km_with": defaultdict(float), "cnt_with": defaultdict(int)} for c in CAR}
    extra = {"bridge": 0, "tunnel": 0, "layer": 0, "roundabout": 0, "bridge_km": 0.0, "tunnel_km": 0.0}
    named = defaultdict(lambda: {"cls": Counter(), "n": 0, "km": 0.0, "lanes": 0, "turn": 0, "lanes_km": 0.0, "turn_km": 0.0,
                                 "fb_km": 0.0, "maxspeed_km": 0.0, "width_km": 0.0, "surface_km": 0.0, "oneway_km": 0.0})
    other_hw = Counter()
    for wid, (refs, tg) in ways.items():
        hw = tg.get("highway")
        if not hw: continue
        pts = way_geom(wid)
        if len(pts) < 2: continue
        g = LineString(pts).intersection(BB)
        if g.is_empty: continue
        km = proj_len(g) / 1000
        if hw not in road:
            other_hw[hw] += 1
            continue
        r = road[hw]
        r["count"] += 1; r["km"] += km
        for k in KEYS:
            if k in tg:
                r["km_with"][k] += km; r["cnt_with"][k] += 1
        if "lanes:forward" in tg or "lanes:backward" in tg:
            r["km_with"]["lanes:fb"] += km
        if tg.get("bridge") not in (None, "no"): extra["bridge"] += 1; extra["bridge_km"] += km
        if tg.get("tunnel") not in (None, "no"): extra["tunnel"] += 1; extra["tunnel_km"] += km
        if "layer" in tg: extra["layer"] += 1
        if tg.get("junction") == "roundabout": extra["roundabout"] += 1
        nm = tg.get("name")
        if nm:
            d = named[nm]
            d["cls"][hw] += 1; d["n"] += 1; d["km"] += km
            if "lanes" in tg: d["lanes"] += 1; d["lanes_km"] += km
            if "turn:lanes" in tg or "turn:lanes:forward" in tg: d["turn"] += 1; d["turn_km"] += km
            if "lanes:forward" in tg or "lanes:backward" in tg: d["fb_km"] += km
            if "maxspeed" in tg: d["maxspeed_km"] += km
            if "width" in tg: d["width_km"] += km
            if "surface" in tg: d["surface_km"] += km
            if "oneway" in tg: d["oneway_km"] += km
    roads = {}
    for c, r in road.items():
        km = r["km"]
        roads[c] = {"count": r["count"], "km": round(km, 2),
                    "pct_km": {k: pct(v, km) for k, v in r["km_with"].items()},
                    "count_with": dict(r["cnt_with"])}
    # roundabouts-узлы/лэйны
    res["roads"] = {"by_class": roads, "extra": {k: round(v, 2) for k, v in extra.items()}, "other_highway_ways": dict(other_hw.most_common())}
    # агрегат по основным классам
    main = [c for c in CAR if c != "service"]
    for label, cl in [("all_car_excl_service", main), ("all_car", CAR)]:
        km = sum(road[c]["km"] for c in cl)
        res["roads"]["agg_" + label] = {"km": round(km, 2), "pct_km": {k: pct(sum(road[c]["km_with"][k] for c in cl), km)
                                        for k in KEYS + ["lanes:fb"]}}
    def named_row(nm, d):
        return {"name": nm, "classes": dict(d["cls"]), "segments": d["n"], "km": round(d["km"], 2),
                "lanes_seg": d["lanes"], "turn_seg": d["turn"], "lanes_pct_km": pct(d["lanes_km"], d["km"]),
                "turn_pct_km": pct(d["turn_km"], d["km"]), "fb_pct_km": pct(d["fb_km"], d["km"]),
                "maxspeed_pct_km": pct(d["maxspeed_km"], d["km"]), "width_pct_km": pct(d["width_km"], d["km"]),
                "surface_pct_km": pct(d["surface_km"], d["km"]), "oneway_pct_km": pct(d["oneway_km"], d["km"])}
    arter = []
    for a in ARTERIALS:
        ms = [(nm, d) for nm, d in named.items() if a.lower() in nm.lower()]
        for nm, d in ms: arter.append(named_row(nm, d))
        if not ms: arter.append({"name": a, "missing": True})
    seen = {r["name"] for r in arter}
    top = sorted(((nm, d) for nm, d in named.items() if nm not in seen and (set(d["cls"]) & {"primary", "secondary", "tertiary", "trunk"})),
                 key=lambda x: -x[1]["km"])[:25]
    res["arterials_requested"] = arter
    res["arterials_top_other"] = [named_row(nm, d) for nm, d in top]

    # ---- точечные объекты
    nc = Counter(); cross = Counter(); signs = Counter(); sign_types = Counter(); stops = Counter(); signal_types = Counter()
    for nid, tg in ntags.items():
        h = tg.get("highway"); 
        if h == "traffic_signals": nc["traffic_signals"] += 1; signal_types[tg.get("traffic_signals", "-")] += 1
        if h == "crossing" or tg.get("railway") in ("crossing", "level_crossing"):
            nc["crossing_nodes"] += 1; cross[tg.get("crossing", tg.get("railway", "(no crossing=*)"))] += 1
            if "crossing:signals" in tg or tg.get("crossing") == "traffic_signals": nc["crossing_signals"] += 1
        if h == "street_lamp": nc["street_lamp"] += 1
        if h == "bus_stop": nc["highway_bus_stop"] += 1
        if tg.get("public_transport") == "stop_position":
            nc["stop_position"] += 1
            for m in ("bus", "trolleybus", "tram"):
                if tg.get(m) == "yes": stops["stop_position:" + m] += 1
        if tg.get("public_transport") == "platform": nc["platform"] += 1
        if tg.get("natural") == "tree": nc["trees"] += 1
        if h == "give_way" or tg.get("traffic_sign") == "give_way": nc["give_way"] += 1
        if h == "stop": nc["stop"] += 1
        if "traffic_sign" in tg: nc["traffic_sign_tag"] += 1; sign_types[tg["traffic_sign"]] += 1
        if h == "speed_camera" or tg.get("enforcement") == "maxspeed": nc["speed_camera"] += 1
        if tg.get("traffic_calming"): nc["traffic_calming"] += 1; signs["calming:" + tg["traffic_calming"]] += 1
        if h == "turning_circle" or h == "mini_roundabout": nc[h] += 1
        if tg.get("barrier"): signs["barrier:" + tg["barrier"]] += 1
        if "direction" in tg and h in ("give_way", "stop", "traffic_signals"): nc["signal_sign_with_direction"] += 1
    wc = Counter()
    for wid, (refs, tg) in ways.items():
        if tg.get("natural") == "tree_row": wc["tree_row"] += 1
        if tg.get("highway") == "street_lamp": wc["street_lamp_way"] += 1
        if tg.get("barrier") in ("fence", "wall", "guard_rail", "retaining_wall"): wc["barrier_" + tg["barrier"]] += 1
        if tg.get("railway") in ("rail", "tram", "light_rail"): wc["railway_" + tg["railway"]] += 1
        if tg.get("highway") in ("footway", "path", "pedestrian", "cycleway", "steps"): wc["hw_" + tg["highway"]] += 1
        if tg.get("amenity") == "parking": wc["parking_area"] += 1
    res["points"] = {"counts": dict(nc), "crossing_kinds": dict(cross.most_common()), "signal_types": dict(signal_types),
                     "traffic_sign_values": dict(sign_types.most_common(25)), "stops": dict(stops), "misc": dict(signs.most_common(20)),
                     "ways_misc": dict(wc.most_common())}

    # ---- площади
    def poly_of_way(wid):
        pts = way_geom(wid)
        if len(pts) >= 4 and pts[0] == pts[-1]:
            try:
                from shapely.geometry import Polygon
                p = Polygon(pts)
                return p if p.is_valid else p.buffer(0)
            except Exception:
                return None
        return None
    def poly_of_rel(mem):
        outs = [LineString(way_geom(m[1])) for m in mem if m[0] == "way" and m[1] in ways and m[2] in ("outer", "") and len(way_geom(m[1])) > 1]
        ins = [LineString(way_geom(m[1])) for m in mem if m[0] == "way" and m[1] in ways and m[2] == "inner" and len(way_geom(m[1])) > 1]
        if not outs: return None
        po = unary_union(list(polygonize(unary_union(outs))))
        if ins:
            po = po.difference(unary_union(list(polygonize(unary_union(ins)))))
        return po
    def classify(tg):
        c = []
        if tg.get("leisure") in ("park", "garden", "playground", "pitch", "stadium", "recreation_ground", "common"): c.append("leisure=" + tg["leisure"])
        if tg.get("landuse"): c.append("landuse=" + tg["landuse"])
        if tg.get("natural") in ("wood", "water", "scrub", "grassland", "wetland", "sand", "beach", "heath"): c.append("natural=" + tg["natural"])
        if tg.get("waterway") in ("riverbank", "dock"): c.append("waterway=" + tg["waterway"])
        return c
    area = defaultdict(lambda: [0, 0.0]); named_areas = []
    for kind, geoms in (("way", ((wid, tg, poly_of_way(wid)) for wid, (refs, tg) in ways.items() if "building" not in tg and "highway" not in tg)),
                        ("rel", ((None, tg, poly_of_rel(mem)) for tg, mem in rels if tg.get("type") == "multipolygon" and "building" not in tg))):
        for wid, tg, p in geoms:
            if p is None or p.is_empty: continue
            cl = classify(tg)
            if not cl: continue
            p = p.intersection(BB)
            if p.is_empty: continue
            a = proj_area(p)
            for c in cl:
                area[c][0] += 1; area[c][1] += a
            if any(c in ("leisure=park", "natural=wood", "landuse=forest", "natural=water", "waterway=riverbank") for c in cl) and tg.get("name"):
                named_areas.append({"name": tg["name"], "class": cl, "area_ha": round(a / 1e4, 1)})
    res["areas"] = {k: {"count": v[0], "area_ha": round(v[1] / 1e4, 1)} for k, v in sorted(area.items(), key=lambda x: -x[1][1])}
    res["areas_named"] = sorted(named_areas, key=lambda x: -x["area_ha"])[:40]
    water_lines = defaultdict(float)
    for wid, (refs, tg) in ways.items():
        if tg.get("waterway") in ("river", "stream", "canal", "drain", "ditch"):
            pts = way_geom(wid)
            if len(pts) > 1:
                g = LineString(pts).intersection(BB)
                if not g.is_empty: water_lines[tg["waterway"] + ":" + tg.get("name", "-")] += proj_len(g) / 1000
    res["waterways_km"] = {k: round(v, 2) for k, v in sorted(water_lines.items(), key=lambda x: -x[1])[:20]}

    # ---- маршруты ОТ
    routes = []
    for tg, mem in rels:
        if tg.get("type") == "route" and tg.get("route") in ("trolleybus", "bus", "tram", "share_taxi", "minibus"):
            inside = sum(1 for m in mem if m[0] == "way" and m[1] in ways)
            stops_m = sum(1 for m in mem if m[2] and m[2].startswith(("stop", "platform")))
            routes.append({"route": tg["route"], "ref": tg.get("ref", ""), "name": tg.get("name", ""), "members_ways_in_bbox": inside,
                           "stop_members": stops_m, "from": tg.get("from"), "to": tg.get("to"), "operator": tg.get("operator")})
    routes.sort(key=lambda r: (r["route"], r["ref"]))
    res["routes"] = {"count_by_type": dict(Counter(r["route"] for r in routes)), "list": routes,
                     "route_master": sum(1 for tg, _ in rels if tg.get("type") == "route_master")}

    # ---- ориентиры
    lm = []
    def lm_check(tg, lon, lat, kind):
        nm = tg.get("name")
        if not nm: return
        why = None
        if tg.get("tourism") in ("attraction", "museum", "gallery", "viewpoint", "artwork", "zoo", "theme_park", "hotel"):
            why = "tourism=" + tg["tourism"]
            if tg["tourism"] in ("hotel",): why = None
        elif "historic" in tg and tg["historic"] != "no": why = "historic=" + tg["historic"]
        elif tg.get("amenity") in LANDMARK_AMENITY: why = "amenity=" + tg["amenity"]
        elif tg.get("man_made") in ("tower", "water_tower", "obelisk", "lighthouse", "chimney"): why = "man_made=" + tg["man_made"]
        elif tg.get("shop") == "mall" or tg.get("railway") == "station" or tg.get("leisure") in ("stadium", "park"): why = tg.get("shop") or tg.get("railway") or "leisure=" + tg["leisure"]
        if why and S <= lat <= N and W <= lon <= E:
            lm.append({"name": nm, "why": why, "lat": round(lat, 5), "lon": round(lon, 5), "kind": kind})
    for nid, tg in ntags.items():
        lon, lat = nodes[nid]; lm_check(tg, lon, lat, "node")
    for wid, (refs, tg) in ways.items():
        if tg.get("name") and any(k in tg for k in ("tourism", "historic", "amenity", "man_made", "shop", "railway", "leisure")):
            pts = way_geom(wid)
            if pts: lm_check(tg, *centroid(pts), "way")
    for tg, mem in rels:
        if tg.get("name") and any(k in tg for k in ("tourism", "historic", "amenity", "man_made", "shop", "leisure")):
            ows = [way_geom(m[1]) for m in mem if m[0] == "way" and m[1] in ways and way_geom(m[1])]
            if ows: lm_check(tg, *centroid([p for o in ows for p in o]), "rel")
    uniq = {}
    for x in lm: uniq.setdefault((x["name"], x["why"]), x)
    res["landmarks"] = sorted(uniq.values(), key=lambda x: (x["why"], x["name"]))
    # DPS post
    res["police_with_dps"] = [x for x in res["landmarks"] if "дпс" in x["name"].lower() or "гибдд" in x["name"].lower()]

    DATA_PROCESSED.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print("written", OUT)


if __name__ == "__main__":
    main()
