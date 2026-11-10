"""Hero-модели (docs/stage2/landmarks.md): манифест game/public/assets/landmarks/landmarks.json -> пайплайн мира.

Манифест — единственный источник правды о размещении: id, glb, позиция в координатах игры (x, z), rotY, какие объекты
OSM модель заменяет (`suppress`) и её футпринты (`footprints`, локальные координаты glTF модели [x, z]).

apply(osm, path, log) — до генерации чего-либо по зданиям (build_world.py, сразу после правок контуров):
  * здания OSM из suppress.buildings ("w123"/"r123") получают тег nfr:hero=<id>: процедурное здание не строится
    (world/archetypes.py пропускает их), но футпринт остаётся препятствием для дворов, пропсов, деревьев, тротуаров и
    пешеходного графа; building:part внутри такого футпринта гасятся (building:part=no);
  * каждый футпринт модели (крыльцо, навес, платформа памятника…) добавляется синтетическим путём building=yes +
    nfr:hero=<id> — тоже только препятствие.
clear_props(yctx, sl, log) — после улицы (streetlife) и до записи props: убирает инстансы, сегменты, витрины и подъезды,
  попавшие в футпринты hero-моделей (скульптуры из OSM-узла памятника, клумбы, фонари, деревья, припаркованные машины).
"""
import json
import math
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import Point, Polygon

from config import ROOT, to_wgs84

MANIFEST = ROOT / "game" / "public" / "assets" / "landmarks" / "landmarks.json"
SYN_WAY = 960_000_000_000
SYN_NODE = 960_000_000_000
CLEAR_BUFFER = 0.4          # м вокруг футпринтов, где пропсов тоже не должно быть

_HEROES = []                # [(id, Polygon мира)] — заполняет apply()


def load(path=MANIFEST):
    path = Path(path)
    if not path.exists():
        return []
    return [lm for lm in json.loads(path.read_text(encoding="utf-8")).get("landmarks", []) if lm.get("enabled", True)]


def local_to_world(lm, pts):
    """Локальные [x, z] модели (glTF: перёд −Z) -> мировые (x восток, y север) пайплайна по x, z, rotY манифеста."""
    r = float(lm["rotY"]); c, s = math.cos(r), math.sin(r)
    X, Z = float(lm["x"]), float(lm["z"])
    out = []
    for x, z in pts:
        xg = X + x * c + z * s
        zg = Z - x * s + z * c
        out.append((xg, -zg))
    return out


def footprints(lm):
    polys = []
    for ring in lm.get("footprints", []):
        p = Polygon(local_to_world(lm, ring))
        if not p.is_valid:
            p = p.buffer(0)
        if not p.is_empty:
            polys.append(p)
    return polys


def _wid(v):
    s = str(v)
    return (s[0], int(s[1:])) if s[0] in "wrn" else ("w", int(s))


def apply(osm, path=MANIFEST, log=print):
    _HEROES.clear()
    lms = load(path)
    if not lms:
        return {"landmarks": 0}
    st = {"landmarks": len(lms), "suppressed": 0, "parts": 0, "footprints": 0, "missing": []}
    rel_idx = {rid: i for i, (rid, _, _) in enumerate(osm.rels)}
    nxt_node = max(SYN_NODE, int(osm.node_ids.max()) + 1)
    nxt_way = SYN_WAY
    new_ids, new_xy = [], []
    for lm in lms:
        hid = lm["id"]
        hero_polys = []
        parts_area = None
        keep = lm.get("suppress", {}).get("keepFootprint", True)   # false: контур OSM неточен — препятствие только по футпринтам модели
        for ref in lm.get("suppress", {}).get("buildings", []):
            kind, oid = _wid(ref)
            if kind == "w" and oid in osm.ways:
                refs, tg = osm.ways[oid]
                tg = dict(tg); tg["nfr:hero"] = hid
                if not keep:
                    tg["nfr:building_dropped"] = tg.get("building", "yes"); tg["building"] = "no"
                osm.ways[oid] = (refs, tg)
                p = osm.way_polygon(oid)
            elif kind == "r" and oid in rel_idx:
                rid, tg, mem = osm.rels[rel_idx[oid]]
                tg = dict(tg); tg["nfr:hero"] = hid
                if not keep:
                    tg["nfr:building_dropped"] = tg.get("building", "yes"); tg["building"] = "no"
                osm.rels[rel_idx[oid]] = (rid, tg, mem)
                p = osm.rel_polygon(mem)
            else:
                st["missing"].append(ref)
                continue
            st["suppressed"] += 1
            if p is not None and keep:
                hero_polys.append(p)
            elif p is not None:
                parts_area = p
        # части зданий внутри заменённых футпринтов
        if hero_polys or parts_area is not None:
            hp = shapely.union_all(hero_polys + ([parts_area] if parts_area is not None else [])).buffer(0.5)
            for wid, (refs, tg) in list(osm.ways.items()):
                if tg.get("building:part", "no") in ("no", "roof") or len(refs) < 4 or refs[0] != refs[-1]:
                    continue
                p = osm.way_polygon(wid)
                if p is not None and hp.contains(p.representative_point()):
                    tg = dict(tg); tg["nfr:hero_part"] = tg["building:part"]; tg["building:part"] = "no"; tg["nfr:hero"] = hid
                    osm.ways[wid] = (refs, tg)
                    st["parts"] += 1
        # футпринты модели — синтетические «здания»-препятствия
        for p in footprints(lm):
            ring = list(p.exterior.coords)[:-1]
            ids = list(range(nxt_node, nxt_node + len(ring)))
            nxt_node += len(ids)
            new_ids += ids; new_xy += ring
            osm.ways[nxt_way] = (np.array(ids + [ids[0]], dtype=np.int64),
                                 {"building": "yes", "nfr:hero": hid, "nfr:hero_footprint": "yes", "name": lm.get("name", hid)})
            nxt_way += 1
            st["footprints"] += 1
            hero_polys.append(p)
        if hero_polys:
            _HEROES.append((hid, shapely.union_all(hero_polys)))
    if new_ids:
        xy = np.array(new_xy, float)
        lon, lat = to_wgs84.transform(xy[:, 0], xy[:, 1])
        osm.node_ids = np.r_[osm.node_ids, np.array(new_ids, np.int64)]
        osm.xy = np.r_[osm.xy, xy]
        osm.lonlat = np.r_[osm.lonlat, np.c_[lon, lat]]
        o = np.argsort(osm.node_ids)
        osm.node_ids, osm.xy, osm.lonlat = osm.node_ids[o], osm.xy[o], osm.lonlat[o]
    log(f"hero-модели: {st['landmarks']}, заменено зданий OSM {st['suppressed']} (частей {st['parts']}), "
        f"футпринтов-препятствий {st['footprints']}" + (f", НЕ НАЙДЕНО: {st['missing']}" if st["missing"] else ""))
    return st


def is_hero(tg):
    return "nfr:hero" in tg


def clear_props(yctx, sl=None, log=print):
    """Убрать пропсы/сегменты/витрины/подъезды внутри футпринтов hero-моделей (+ CLEAR_BUFFER)."""
    if not _HEROES:
        return {}
    area = shapely.union_all([p for _, p in _HEROES]).buffer(CLEAR_BUFFER)
    shapely.prepare(area)
    inside = lambda x, y: bool(shapely.contains_xy(area, x, y))
    st = {"instances": 0, "segments": 0, "storefronts": 0, "entrances": 0}
    for k, lst in yctx.tiles_props.items():
        keep = [r for r in lst if not inside(r["x"], -r["z"])]
        st["instances"] += len(lst) - len(keep)
        lst[:] = keep
    for k, lst in yctx.tiles_segs.items():
        keep = [r for r in lst if not (inside(r["x1"], -r["z1"]) or inside(r["x2"], -r["z2"])
                                       or inside((r["x1"] + r["x2"]) / 2, -(r["z1"] + r["z2"]) / 2))]
        st["segments"] += len(lst) - len(keep)
        lst[:] = keep
    for name in ("tiles_sf", "tiles_ent"):
        d = getattr(sl, name, None) if sl is not None else None
        if not d:
            continue
        for k, lst in d.items():
            keep = []
            for r in lst:
                x, z = (r["x"], r["z"]) if "x" in r else ((r["x1"] + r["x2"]) / 2, (r["z1"] + r["z2"]) / 2)
                if not inside(x, -z):
                    keep.append(r)
            st["storefronts" if name == "tiles_sf" else "entrances"] += len(lst) - len(keep)
            lst[:] = keep
    log(f"hero-модели: убрано из футпринтов {st}")
    return st
