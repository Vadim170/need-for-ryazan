"""Собирает game/public/assets/people/people.json из метаданных персонажей (build_character.py) и клипов (build_clips.py).

Запуск: python3 -I assets/scripts/people/make_manifest.py <build_dir> <out_dir> <characters.json>
"""
import sys
import os
import json
import shutil

build, out, spec_path = sys.argv[1], sys.argv[2], sys.argv[3]
spec = json.load(open(spec_path))
clips = json.load(open(os.path.join(build, 'clips.json')))
shutil.copyfile(os.path.join(build, 'clips.bin'), os.path.join(out, 'clips.bin'))
REF_L = 0.85  # длина ноги (таз–лодыжка) эталонного человека 1.75 м, для strideM
chars = []
for c in spec['characters']:
    p = os.path.join(build, c['id'] + '.json')
    if not os.path.exists(p) or not os.path.exists(os.path.join(out, c['id'] + '.glb')):
        print('нет', c['id'])
        continue
    m = json.load(open(p))
    head = m['tips']['Head'][1]
    chars.append({
        'id': m['id'], 'file': m['id'] + '.glb', 'lod1': 'lod1', 'body': m['body'], 'female': m['female'],
        'height': round(head, 4), 'heightTotal': m['heightTotal'], 'tris': m['tris'], 'lod1Tris': m['lod1Tris'],
        'joints': m['joints'], 'tips': m['tips'],
        'hairColor': (c.get('hair') or {}).get('color'), 'stoop': c.get('stoop', 0), 'winter': bool(c.get('winter')), 'regions': m.get('regions', []),
        'outfit': [x['asset'] for x in c['clothes']] + ([c['hair']['asset']] if c.get('hair') else []),
    })
for cl in clips['clips']:
    if 'strideNorm' in cl:
        cl['strideM'] = round(cl['strideNorm'] * REF_L, 4)
manifest = {
    'version': 1,
    'note': 'Пешеходы: персонажи MakeHuman/MPFB2 (CC0), анимации CMU mocap. Сборка: assets/scripts/people/build_people.sh',
    'skeleton': {'bones': clips['bones'], 'parents': clips['parents'], 'tposeDirs': clips['tposeDirs']},
    'clipsFile': 'clips.bin', 'fps': clips['fps'], 'frameFloats': clips['frameFloats'],
    'clips': clips['clips'],
    'characters': chars,
    'license': {
        'characters': 'MakeHuman system assets + asset packs (CC0 1.0), generated with MPFB2 (output CC0). See game/CREDITS.md',
        'animations': 'CMU Graphics Lab Motion Capture Database, mocap.cs.cmu.edu (free for any use); BVH conversion by B. Hahne (cgspeed), no extra restrictions. "The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217."',
    },
}
json.dump(manifest, open(os.path.join(out, 'people.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
print('people.json:', len(chars), 'персонажей,', len(clips['clips']), 'клипов')
