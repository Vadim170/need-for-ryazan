"""Контуры зданий: ручные правки (data/overrides/buildings.json) и проверка подозрительных футпринтов OSM.

apply(osm, path) — до генерации зданий (build_world.py), правит OsmData на месте:
  {"id": "w123" | "r123" | 123, "action": "drop" | "replace" | "tags", "outline": [[x, y], ...], "set": {}, "del": []}
  drop — тег building=no (здание не строится нигде); replace — путь получает новые узлы (синтетические id),
  id и теги сохраняются, поэтому реестр/ортофото по ключу w123 продолжают работать.
check(osm, out_path) — список подозрительных контуров в отчёт (сами не исправляются):
  крупные (> 3000 м²) торговые/«yes» футпринты, которые пересекают оси автодорог (кроме service) больше чем на 15 м,
  наземные пешеходные дорожки больше чем на 40 м (площадь внутри контура),
  или перекрывают площади/пешеходные зоны (place=square, highway=pedestrian area) больше чем на 300 м²;
  крупные здания, внутри контура которых на ортофото (yandex_0.5m) ≥ 30 % зелени (деревья/газон — не крыша);
  а также любые здания > 20000 м² не промышленного типа (информационно).
"""
import json
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import LineString

from config import to_wgs84

SYN_NODE = 950_000_000_000


def _wid(v):
    s = str(v)
    if s[0] in "wr":
        return s[0], int(s[1:])
    return "w", int(s)


def apply(osm, path, log=print):
    path = Path(path)
    st = {"drop": 0, "replace": 0, "tags": 0, "missing": []}
    if not path.exists():
        return st
    cfg = json.loads(path.read_text(encoding="utf-8"))
    nxt = max(SYN_NODE, int(osm.node_ids.max()) + 1)
    new_ids, new_xy = [], []
    rel_tags = {rid: tg for rid, tg, _ in osm.rels}
    for ov in cfg.get("buildings", []):
        kind, oid = _wid(ov["id"])
        act = ov.get("action", "tags")
        if kind == "w":
            if oid not in osm.ways:
                st["missing"].append(ov["id"]); continue
            refs, tg = osm.ways[oid]
        else:
            if oid not in rel_tags:
                st["missing"].append(ov["id"]); continue
            tg = rel_tags[oid]
        tg = dict(tg)
        for k in ov.get("del", []):
            tg.pop(k, None)
        tg.update({k: str(v) for k, v in ov.get("set", {}).items()})
        if act == "drop":
            tg["nfr:building_dropped"] = tg.get("building", "yes")
            tg["building"] = "no"
        elif act == "replace" and kind == "w":
            ring = [list(map(float, p)) for p in ov["outline"]]
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            ids = list(range(nxt, nxt + len(ring) - 1))
            nxt += len(ids)
            new_ids += ids; new_xy += ring[:-1]
            refs = np.array(ids + [ids[0]], dtype=np.int64)
            tg["nfr:outline"] = "override"
        st[act if act in st else "tags"] += 1
        if kind == "w":
            osm.ways[oid] = (refs, tg)
        else:
            osm.rels = [(r, tg if r == oid else t, m) for r, t, m in osm.rels]
    if new_ids:
        xy = np.array(new_xy, float)
        lon, lat = to_wgs84.transform(xy[:, 0], xy[:, 1])
        osm.node_ids = np.r_[osm.node_ids, np.array(new_ids, np.int64)]
        osm.xy = np.r_[osm.xy, xy]
        osm.lonlat = np.r_[osm.lonlat, np.c_[lon, lat]]
        o = np.argsort(osm.node_ids)
        osm.node_ids, osm.xy, osm.lonlat = osm.node_ids[o], osm.xy[o], osm.lonlat[o]
    log(f"здания (правки контуров): заменено {st['replace']}, удалено {st['drop']}, тегов {st['tags']}"
        + (f", НЕ НАЙДЕНО: {st['missing']}" if st["missing"] else ""))
    return st


def _veg_fraction(ds, p):
    from rasterio.features import geometry_mask
    from rasterio.windows import from_bounds
    q = p.buffer(-2.0)
    if q.is_empty:
        return 0.0
    w = from_bounds(*p.bounds, ds.transform)
    img = ds.read(window=w, boundless=True, fill_value=0).astype(np.float32)
    m = ~geometry_mask([q], out_shape=img.shape[1:], transform=ds.window_transform(w))
    if m.sum() < 50:
        return 0.0
    R, G, B = img[:, m]
    return float((((2 * G - R - B) > 25) & (G > 60)).mean())


def check(osm, out_path=None, log=print, ortho=None):
    roads, plazas, walks = [], [], []
    for wid, (refs, tg) in osm.ways.items():
        hw = tg.get("highway")
        if hw and hw != "service" and tg.get("area") != "yes" and hw in (
                "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
                "primary_link", "secondary_link", "tertiary_link"):
            xy = osm.way_xy(wid)
            if len(xy) >= 2 and tg.get("tunnel", "no") == "no" and tg.get("covered", "no") == "no" \
                    and tg.get("layer", "0") in ("0", "") :
                roads.append(LineString(xy))
        elif hw in ("footway", "path", "pedestrian", "cycleway") and tg.get("area") != "yes" \
                and tg.get("indoor", "no") == "no" and tg.get("tunnel", "no") == "no" and tg.get("covered", "no") == "no" \
                and tg.get("layer", "0") in ("0", ""):
            xy = osm.way_xy(wid)
            if len(xy) >= 2:
                walks.append(LineString(xy))
        elif (tg.get("place") == "square" or hw == "pedestrian" and tg.get("area") == "yes") and len(refs) > 3 \
                and refs[0] == refs[-1]:
            p = osm.way_polygon(wid)
            if p is not None:
                plazas.append(p)
    rt = shapely.STRtree(roads) if roads else None
    pt = shapely.STRtree(plazas) if plazas else None
    wt = shapely.STRtree(walks) if walks else None
    ds = None
    if ortho is not None and Path(ortho).exists():
        import rasterio
        ds = rasterio.open(ortho)
    out = []
    for p, tg, oid in osm.buildings():
        b = tg.get("building")
        if b in ("no", "roof") or p.area < 3000:
            continue
        industrial = b in ("industrial", "warehouse", "factory", "manufacture", "hangar")
        reasons = []
        if b in ("retail", "commercial", "yes", "mall", "supermarket", "office", "public"):
            if rt is not None:
                L = sum(roads[i].intersection(p).length for i in rt.query(p, predicate="intersects"))
                if L > 15:
                    reasons.append(f"дороги внутри {L:.0f} м")
            if pt is not None:
                A = sum(plazas[i].intersection(p).area for i in pt.query(p, predicate="intersects"))
                if A > 300:
                    reasons.append(f"перекрывает площадь {A:.0f} м²")
            if wt is not None:
                L = sum(walks[i].intersection(p).length for i in wt.query(p, predicate="intersects"))
                if L > 40:
                    reasons.append(f"пешеходные дорожки внутри {L:.0f} м")
        if ds is not None and not industrial:
            v = _veg_fraction(ds, p)
            if v >= 0.3:
                reasons.append(f"на снимке внутри {v * 100:.0f}% зелени")
        if p.area > 20000 and not industrial:
            reasons.append("очень большой футпринт")
        if reasons:
            out.append({"id": f"w{oid}" if oid in osm.ways else f"r{oid}", "building": b, "area": round(p.area),
                        "name": tg.get("name"), "addr": f"{tg.get('addr:street', '')} {tg.get('addr:housenumber', '')}".strip(),
                        "override": tg.get("nfr:outline"), "reasons": reasons})
    if out_path:
        Path(out_path).write_text(json.dumps(out, ensure_ascii=False, indent=1))
    log(f"здания (проверка контуров): подозрительных {len(out)}"
        + (": " + "; ".join(f"{o['id']} {o['addr'] or o['name'] or ''} ({', '.join(o['reasons'])})" for o in out[:6]) if out else ""))
    return out
