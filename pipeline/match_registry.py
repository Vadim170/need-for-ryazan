"""Сопоставление реестровых данных (fetch_registry.py) со зданиями OSM -> data/processed/building_registry.json.

Ключ сопоставления: (улица, номер дома) после нормализации (registry_common.py). Если на один адрес приходится
несколько контуров OSM — выбираем по координатам реестра (ближайший, < 50 м до контура), без координат — самый
большой жилой контур. Если у OSM-здания несколько адресов ("12;14") — агрегируем (levels = max, levels_min = min).

Запуск:  cd pipeline && uv run python match_registry.py
"""
import json
from collections import Counter, defaultdict

from shapely.geometry import Point

from config import DATA_PROCESSED, DATA_RAW, to_world
from registry_common import load_osm_buildings, split_housenumbers, street_key

REG = DATA_RAW / "registry"
OUT = DATA_PROCESSED / "building_registry.json"  # {osm_id: {...}} — контракт для pipeline/world/buildings.py
OUT_STATS = DATA_PROCESSED / "building_registry_stats.json"
MAX_DIST = 50.0  # м от координаты реестра до контура
NON_RESIDENTIAL = {"garage", "garages", "service", "shed", "roof", "carport", "kiosk", "retail", "office",
                   "commercial", "industrial", "warehouse", "construction", "container", "hut", "cabin"}


GENERIC_SERIES = {"сведения отсутствуют", "нет данных", "данных нет", "нет", "многоквартирный жилой дом", "кирпичный",
                  "панельный", "блочный", "деревянный", "монолитный", "кирпич", "панель", "иной", "индивидуальный",
                  "типовой", "жилой дом", "жилой", "дом", "-"}


def load(name):
    f = REG / f"{name}.json"
    return json.loads(f.read_text()) if f.exists() else []


def merge_registry():
    """Склеиваем источники по (street_key, house_key). Приоритет: domreestr для этажей/года/подъездов/координат,
    mkdbase для материала стен и крыши; недостающее добираем из другого источника."""
    recs = {}
    for src, rows in (("domreestr", load("domreestr")), ("mkdbase", load("mkdbase"))):
        for r in rows:
            if not r.get("street_key") or not r.get("house_key"):
                continue
            if not any(r.get(f) for f in ("floors_max", "year_built", "year", "entrances", "wall_material")):
                continue  # пустая карточка
            k = (r["street_key"], r["house_key"])
            m = recs.setdefault(k, {"urls": {}})
            m["urls"][src] = r["url"]
            for f in ("floors_max", "floors_min", "entrances", "series", "wall_material", "roof_shape", "roof_type",
                      "lifts", "lat", "lon"):
                if m.get(f) is None and r.get(f) is not None:
                    m[f] = r[f]
            y = r.get("year_built") or r.get("year")
            if m.get("year") is None and y:
                m["year"] = y
    return recs


def pick(cands, reg):
    """Выбор среди нескольких OSM-контуров с одним адресом. Возвращает (building|None, причина)."""
    if "lat" in reg:
        x, y = to_world.transform(reg["lon"], reg["lat"])
        p = Point(x, y)
        ds = sorted((b["poly"].distance(p), b["id"], b) for b in cands)
        if ds[0][0] <= MAX_DIST:
            return ds[0][2], "geo" if len(cands) > 1 else "single_geo"
        return None, "far"
    res = [b for b in cands if b["tags"].get("building") not in NON_RESIDENTIAL] or cands
    if len(res) == 1 and len(cands) == 1:
        return res[0], "single"
    return max(res, key=lambda b: b["area"]), "largest"


def main():
    B = load_osm_buildings()
    by_addr = defaultdict(list)
    for b in B:
        st, hn = b["tags"].get("addr:street"), b["tags"].get("addr:housenumber")
        if st and hn:
            for k in split_housenumbers(hn):
                by_addr[(street_key(st), k)].append(b)
    reg = merge_registry()
    print(f"OSM зданий {len(B)}, адресных ключей {len(by_addr)}, записей реестра {len(reg)}")

    per = defaultdict(list)  # osm_id -> [reg]
    why = Counter()
    for k, r in reg.items():
        c = by_addr.get(k)
        if not c:
            why["no_osm_address"] += 1
            continue
        b, reason = pick(c, r)
        why[reason] += 1
        if b:
            per[b["id"]].append(r)
    bmap = {b["id"]: b for b in B}

    out = {}
    for oid, rs in per.items():
        lv_max = [r["floors_max"] for r in rs if r.get("floors_max")]
        lv_min = [r["floors_min"] for r in rs if r.get("floors_min")]
        e = {}
        if lv_max:
            e["levels"] = max(lv_max)
            lo = min(lv_min + lv_max)
            if lo < e["levels"]:
                e["levels_min"] = lo
        yrs = [r["year"] for r in rs if r.get("year")]
        if yrs:
            e["year"] = min(yrs)
        ser = next((r["series"] for r in rs if r.get("series")), None)
        if ser:
            e["series_raw"] = ser
            if ser.strip().lower() not in GENERIC_SERIES:
                e["series"] = ser.strip()
        for f_out, f_in in (("wall_material", "wall_material"), ("roof_type", "roof_shape"),
                            ("roof_material", "roof_type")):
            v = next((r[f_in] for r in rs if r.get(f_in)), None)
            if v:
                e[f_out] = v
        ent = [r["entrances"] for r in rs if r.get("entrances")]
        if ent:
            e["entrances"] = sum(ent)
        if any(r.get("lifts") is not None for r in rs):
            e["lifts"] = sum(r.get("lifts") or 0 for r in rs)
        e["n_addresses"] = len(rs)
        e["source_url"] = next((r["urls"].get("domreestr") or r["urls"].get("mkdbase") for r in rs), None)
        out[str(oid)] = e

    # ---- статистика ----
    n_all = len(B)
    apts = [b for b in B if b["tags"].get("building") == "apartments"]
    with_addr = [b for b in B if b["tags"].get("addr:street") and b["tags"].get("addr:housenumber")]
    matched = [bmap[int(i)] for i in out]
    with_lv = [i for i, e in out.items() if "levels" in e]
    osm_has = lambda b: "building:levels" in b["tags"]  # noqa: E731
    gained = [i for i in with_lv if not osm_has(bmap[int(i)])]
    both = []
    for i in with_lv:
        t = bmap[int(i)]["tags"].get("building:levels")
        try:
            both.append((int(float(t)), out[i]["levels"], i))
        except (TypeError, ValueError):
            pass
    exact = sum(a == b for a, b, _ in both)
    pm1 = sum(abs(a - b) <= 1 for a, b, _ in both)
    diffs = Counter(b - a for a, b, _ in both)
    apt_m = [b for b in matched if b["tags"].get("building") == "apartments"]
    stats = {
        "osm_buildings_bbox": n_all,
        "osm_with_address": len(with_addr),
        "osm_building_apartments": len(apts),
        "registry_records": len(reg),
        "registry_unmatched_no_osm_address": why["no_osm_address"],
        "match_reasons": dict(why),
        "osm_buildings_matched": len(out),
        "osm_buildings_matched_pct_of_all": round(100 * len(out) / n_all, 1),
        "apartments_matched": len(apt_m),
        "apartments_matched_pct": round(100 * len(apt_m) / max(1, len(apts)), 1),
        "buildings_with_levels_from_registry": len(with_lv),
        "buildings_gaining_levels_new": len(gained),
        "gain_levels_pct_of_all": round(100 * len(gained) / n_all, 1),
        "osm_levels_before_pct": round(100 * sum(osm_has(b) for b in B) / n_all, 1),
        "levels_pct_after_merge": round(100 * (sum(osm_has(b) for b in B) + len(gained)) / n_all, 1),
        "levels_both_available": len(both),
        "levels_exact_agreement_pct": round(100 * exact / max(1, len(both)), 1),
        "levels_within_1_agreement_pct": round(100 * pm1 / max(1, len(both)), 1),
        "levels_diff_registry_minus_osm": {str(k): v for k, v in sorted(diffs.items())},
        "fields_filled": {f: sum(f in e for e in out.values()) for f in
                          ("levels", "levels_min", "year", "series", "series_raw", "wall_material", "roof_type", "roof_material",
                           "entrances", "lifts")},
        "multi_address_buildings": sum(e["n_addresses"] > 1 for e in out.values()),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    OUT_STATS.write_text(json.dumps(stats, ensure_ascii=False, indent=1))
    print(json.dumps(stats, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
