"""Точки GTA-режима (docs/stage3/gta-mode.md): больницы, отделения полиции, автосервисы (перекраска) из OSM.

Запуск: pipeline/.venv/bin/python pipeline/build_places.py
Выход: game/public/assets/gta/places.json (не в world/ — его перезаписывает build_world) — [{type, name, x, y, z}] в координатах игры (three.js: x = восток, z = −север),
y — 0 (высоту берёт игра по рельефу). Объекты-полигоны — центроид контура; точки — как есть.
"""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import DATA_RAW, ROOT, to_world  # noqa: E402

WANT = {('amenity', 'hospital'): 'hospital', ('amenity', 'clinic'): 'hospital', ('amenity', 'police'): 'police',
        ('shop', 'car_repair'): 'garage', ('craft', 'car_repair'): 'garage'}


def main():
    src = DATA_RAW / 'osm' / 'ryazan.osm'
    nodes = {}
    out = []
    way_nodes, way_tags = None, None
    for ev, el in ET.iterparse(src, events=('end',)):
        tag = el.tag
        if tag == 'node':
            lat, lon = float(el.get('lat')), float(el.get('lon'))
            nodes[el.get('id')] = (lon, lat)
            tags = {t.get('k'): t.get('v') for t in el.findall('tag')}
            kind = next((v for (k, val), v in WANT.items() if tags.get(k) == val), None)
            if kind:
                out.append((kind, tags.get('name', ''), lon, lat))
            el.clear()
        elif tag == 'way':
            tags = {t.get('k'): t.get('v') for t in el.findall('tag')}
            kind = next((v for (k, val), v in WANT.items() if tags.get(k) == val), None)
            if kind:
                pts = [nodes[n.get('ref')] for n in el.findall('nd') if n.get('ref') in nodes]
                if pts:
                    lon = sum(p[0] for p in pts) / len(pts)
                    lat = sum(p[1] for p in pts) / len(pts)
                    out.append((kind, tags.get('name', ''), lon, lat))
            el.clear()
        elif tag == 'relation':
            el.clear()
    res = []
    for kind, name, lon, lat in out:
        x, y = to_world.transform(lon, lat)
        if not (-3250 <= x <= 4000 and -3250 <= -y <= 4250):
            continue  # вне мира (manifest.bounds)
        if kind == 'police' and 'охран' in name.lower():
            continue  # «Пост охраны» — не полиция
        res.append({'type': kind, 'name': name, 'x': round(x, 1), 'y': 0, 'z': round(-y, 1)})
    dst = ROOT / 'game' / 'public' / 'assets' / 'gta' / 'places.json'
    dst.parent.mkdir(parents=True, exist_ok=True)
    json.dump({'version': 1, 'places': res}, open(dst, 'w'), ensure_ascii=False, separators=(',', ':'))
    from collections import Counter
    print(dst, Counter(r['type'] for r in res))


if __name__ == '__main__':
    main()
