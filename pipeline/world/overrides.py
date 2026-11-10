"""Ручные правки атрибутов и геометрии автодорог OSM по аэрофотоснимку (data/overrides/roads.json).

Применяются к OsmData до фильтрации автодорог и netconvert, поэтому их видят все дальнейшие шаги
(SUMO, разметка, тротуары, дворы) так же, как если бы теги стояли в самом OSM.
Формат и порядок работы: docs/stage1/junctions.md.

Поддерживается:
- ways[]:  {"id": wid, "set": {tag: value}, "del": [tag], "split": [node_id, ...], "parts": [{"set":…, "del":…}, …]}
           split режет путь в указанных узлах; part k получает свои правки поверх общих set/del.
           Первый кусок сохраняет id пути, остальные получают синтетические id (SYN + n, тег nfr:parent = исходный id).
           Тег width (полная ширина проезжей части, м) делится netconvert поровну между полосами пути.
- nodes[]: {"id": nid, "move": [dx, dy]} или {"id": nid, "xy": [x, y]} — сдвиг узла в мировых метрах.
- add[]:   {"id": "имя", "nodes": [nid | [x, y], …], "tags": {…}} — новый путь (например, пропущенный съезд);
           [x, y] создаёт новый узел (синтетический id), nid — существующий узел.
Поля "why", "conf", "name" и ключи, начинающиеся с "_", — комментарии, код их не читает.
"""
import json
from pathlib import Path

import numpy as np

from config import to_wgs84

SYN = 900_000_000_000   # начало синтетических id (узлы и пути); реальные OSM id сейчас < 2e10


def _num(x):
    return str(x) if not isinstance(x, float) or not x.is_integer() else str(int(x))


def _patch(tags, ov):
    tags = dict(tags)
    for k in ov.get("del", []):
        tags.pop(k, None)
    for k, v in ov.get("set", {}).items():
        tags[k] = _num(v)
    if "width" in ov.get("set", {}):
        tags["nfr:width"] = "1"     # osm.write_filtered_osm сохраняет width только с этой меткой
    return tags


def load(path):
    path = Path(path)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _add_nodes(osm, ids, xy):
    """Добавляет узлы (синтетические id больше любых реальных, поэтому сортировка сохраняется)."""
    if not len(ids):
        return
    lon, lat = to_wgs84.transform(xy[:, 0], xy[:, 1])
    osm.node_ids = np.r_[osm.node_ids, np.asarray(ids, dtype=np.int64)]
    osm.xy = np.r_[osm.xy, xy]
    osm.lonlat = np.r_[osm.lonlat, np.c_[lon, lat]]


def apply(osm, path, log=print):
    """Применяет правки к osm (на месте). Возвращает сводку."""
    cfg = load(path) if not isinstance(path, dict) else path
    st = {"ways": 0, "tags": 0, "splits": 0, "nodes": 0, "added": 0, "missing": []}
    if not cfg:
        return st
    next_way = SYN
    next_node = max(SYN, int(osm.node_ids.max()) + 1)

    # 1. узлы
    for ov in cfg.get("nodes", []):
        nid = int(ov["id"])
        i, ok = osm.node_index(np.array([nid]))
        if not ok[0]:
            st["missing"].append(f"node {nid}")
            continue
        i = i[0]
        if "xy" in ov:
            osm.xy[i] = ov["xy"]
        else:
            osm.xy[i] += np.asarray(ov["move"], float)
        lon, lat = to_wgs84.transform(osm.xy[i, 0], osm.xy[i, 1])
        osm.lonlat[i] = (lon, lat)
        st["nodes"] += 1

    # 2. теги и разрезы путей
    for ov in cfg.get("ways", []):
        wid = int(ov["id"])
        if wid not in osm.ways:
            st["missing"].append(f"way {wid}")
            continue
        refs, tags = osm.ways[wid]
        base = _patch(tags, ov)
        st["tags"] += len(ov.get("set", {})) + len(ov.get("del", []))
        cuts = [int(n) for n in ov.get("split", [])]
        if not cuts:
            osm.ways[wid] = (refs, base)
            st["ways"] += 1
            continue
        pos = []
        for n in cuts:
            hit = np.nonzero(refs[1:-1] == n)[0]
            if not len(hit):
                st["missing"].append(f"split node {n} not inside way {wid}")
                continue
            pos.append(int(hit[0]) + 1)
        pos = sorted(set(pos))
        bounds = [0] + pos + [len(refs) - 1]
        parts = ov.get("parts", [])
        for k in range(len(bounds) - 1):
            sub = refs[bounds[k]:bounds[k + 1] + 1]
            tg = _patch(base, parts[k]) if k < len(parts) else dict(base)
            if k == 0:
                osm.ways[wid] = (sub, tg)
            else:
                tg["nfr:parent"] = str(wid)
                osm.ways[next_way] = (sub, tg)
                next_way += 1
        st["ways"] += 1
        st["splits"] += len(pos)

    # 3. новые пути
    new_ids, new_xy = [], []
    for ov in cfg.get("add", []):
        refs = []
        for n in ov["nodes"]:
            if isinstance(n, (list, tuple)):
                new_ids.append(next_node); new_xy.append(n)
                refs.append(next_node); next_node += 1
            else:
                refs.append(int(n))
        tg = {k: _num(v) for k, v in ov.get("tags", {}).items()}
        tg["nfr:added"] = str(ov.get("id", next_way))
        osm.ways[next_way] = (np.array(refs, dtype=np.int64), tg)
        next_way += 1
        st["added"] += 1
    _add_nodes(osm, new_ids, np.array(new_xy, float).reshape(-1, 2))

    log(f"overrides: путей {st['ways']} (тегов {st['tags']}, разрезов {st['splits']}), узлов {st['nodes']}, "
        f"новых путей {st['added']}" + (f", НЕ НАЙДЕНО: {st['missing']}" if st["missing"] else ""))
    return st
