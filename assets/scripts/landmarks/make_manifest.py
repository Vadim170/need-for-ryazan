"""Обновить game/public/assets/landmarks/landmarks.json данными сборки моделей (<id>/build.json):
футпринты (footprints), пятна ночного света (pools), треугольники LOD0/LOD1, габариты.
Размещение (x, z, rotY, ground, suppress, ...) правится в манифесте руками — скрипт его не трогает.
  python3 assets/scripts/landmarks/make_manifest.py
"""
import json, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
D = os.path.join(ROOT, 'game', 'public', 'assets', 'landmarks')
path = os.path.join(D, 'landmarks.json')
man = json.load(open(path, encoding='utf8'))
r = lambda v: round(v, 2)
for lm in man['landmarks']:
    bj = os.path.join(D, lm['id'], 'build.json')
    if not os.path.exists(bj):
        print('нет сборки:', lm['id']); continue
    b = json.load(open(bj, encoding='utf8'))
    fps = [b['footprint']] + b.get('extraFootprints', [])
    lm['footprints'] = [[[r(x), r(z)] for x, z in ring] for ring in fps]
    lm['pools'] = [[r(v) for v in p] for p in b.get('pools', [])]
    lm['size'] = [r(v) for v in b['size']]
    lm['triangles'] = {k: b[k]['triangles'] for k in ('lod0', 'lod1') if k in b}
    print(lm['id'], lm['triangles'])
json.dump(man, open(path, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
