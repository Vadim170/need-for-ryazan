#!/usr/bin/env python3
"""Скачивание моделей Sketchfab по официальному Download API (нужен API-токен пользователя).

    python3 -I assets/scripts/vehicles/fetch_sketchfab.py [id ...]     # без аргументов — вся очередь catalog.queue

Токен читается из ~/.config/sketchfab/token (никуда не печатается и не копируется).
Каталог: assets/catalog/vehicles.json (entries[].candidates[] c uid; очередь — top-level "queue": [uid|{id,uid}]).
Результат: assets/sources/sketchfab/<id>/ — model.glb (или gltf.zip → extracted/), meta.json (лицензия, автор, url).
"""
import json, os, sys, time, urllib.request, zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
TOKEN_FILE = os.path.expanduser('~/.config/sketchfab/token')
API = 'https://api.sketchfab.com/v3/models/'


def token():
    if not os.path.exists(TOKEN_FILE):
        sys.exit('нет ~/.config/sketchfab/token — скачивание невозможно')
    return open(TOKEN_FILE).read().strip()


def get(url, tok=None):
    h = {'User-Agent': 'need-for-ryazan-asset-fetch'}
    if tok:
        h['Authorization'] = 'Token ' + tok
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60) as r:
        return json.loads(r.read())


def download(url, path):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'need-for-ryazan'}), timeout=600) as r, open(path, 'wb') as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)


def queue():
    cat = json.load(open(os.path.join(ROOT, 'assets/catalog/vehicles.json'), encoding='utf8'))
    entries = cat['entries'] if isinstance(cat, dict) and 'entries' in cat else (cat if isinstance(cat, list) else cat.get('vehicles', []))
    by_uid = {}
    for e in entries:
        for c in e.get('candidates', []):
            if c.get('uid'):
                by_uid[c['uid']] = (e['id'], c)
    q = []
    for item in (cat.get('queue', []) if isinstance(cat, dict) else []):
        uid = item['uid'] if isinstance(item, dict) else item
        if uid in by_uid:
            q.append((by_uid[uid][0], uid))
    if not q:  # без очереди — rank 1 каждого
        for e in entries:
            c = sorted([c for c in e.get('candidates', []) if c.get('source') == 'sketchfab'], key=lambda c: c.get('rank', 9))
            if c:
                q.append((e['id'], c[0]['uid']))
    return q


def draft_config(vid, uid, out):
    """Черновик configs/<id>.json из каталога (forward/роли материалов проверить по превью перед сборкой)."""
    cfg_path = os.path.join(ROOT, 'assets/scripts/vehicles/configs', vid + '.json')
    if os.path.exists(cfg_path):
        return
    cat = json.load(open(os.path.join(ROOT, 'assets/catalog/vehicles.json'), encoding='utf8'))
    e = next((e for e in cat.get('vehicles', []) if e['id'] == vid), {})
    c = next((c for c in e.get('candidates', []) if c.get('uid') == uid), {})
    meta = json.load(open(os.path.join(out, 'meta.json'), encoding='utf8'))
    src = os.path.join(out, 'model.glb')
    if not os.path.exists(src):
        ex = os.path.join(out, 'extracted')
        src = next((os.path.join(d, f) for d, _, fs in os.walk(ex) for f in fs if f.endswith(('.gltf', '.glb'))), src)
    big = e.get('kind') in ('paz', 'liaz', 'trolleybus', 'gazelle')
    cfg = {'id': vid, 'name': e.get('name', vid), 'kind': e.get('kind', 'sedan'), 'roles': e.get('roles', ['traffic', 'parked']),
           'src': os.path.relpath(src, ROOT), 'forward': '-Y', 'dims': e.get('realDims', {}), 'scaleBy': 'length',
           'budget': 15000 if big else 12000, 'lod1Budget': 2500 if big else 1600,
           'deleteMaterials': ['(?i)interior|seat|salon|engine|motor|underbody'],
           'license': meta.get('license') or c.get('license'), 'author': meta.get('author') or c.get('author'),
           'authorUrl': meta.get('authorUrl') or c.get('authorUrl'), 'url': meta.get('url') or c.get('url'),
           'draft': True}
    json.dump(cfg, open(cfg_path, 'w', encoding='utf8'), ensure_ascii=False, indent=1)


def main():
    tok = token()
    want = set(sys.argv[1:])
    for vid, uid in queue():
        if want and vid not in want and uid not in want:
            continue
        out = os.path.join(ROOT, 'assets/sources/sketchfab', vid)
        if os.path.exists(os.path.join(out, 'meta.json')):
            print('есть:', vid); continue
        os.makedirs(out, exist_ok=True)
        meta = get(API + uid)
        dl = get(API + uid + '/download', tok)
        if 'glb' in dl:
            download(dl['glb']['url'], os.path.join(out, 'model.glb'))
        elif 'gltf' in dl:
            z = os.path.join(out, 'gltf.zip')
            download(dl['gltf']['url'], z)
            with zipfile.ZipFile(z) as zf:
                zf.extractall(os.path.join(out, 'extracted'))
        else:
            print('нет glb/gltf:', vid, list(dl)); continue
        lic = meta.get('license') or {}
        json.dump({'id': vid, 'uid': uid, 'name': meta.get('name'), 'url': meta.get('viewerUrl'),
                   'author': (meta.get('user') or {}).get('displayName') or (meta.get('user') or {}).get('username'),
                   'authorUrl': (meta.get('user') or {}).get('profileUrl'), 'license': lic.get('label') or lic.get('slug'),
                   'licenseUrl': lic.get('url'), 'faceCount': meta.get('faceCount'), 'fetched': time.strftime('%Y-%m-%d')},
                  open(os.path.join(out, 'meta.json'), 'w'), ensure_ascii=False, indent=1)
        draft_config(vid, uid, out)
        print('скачано:', vid, uid)
        time.sleep(1)


if __name__ == '__main__':
    main()
