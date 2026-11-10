"""Сборка одного персонажа-пешехода из MakeHuman/MPFB2 (Blender, headless) -> сырой .glb + метаданные.

Запуск (через build_people.sh, там же BLENDER_USER_RESOURCES с изолированно установленным MPFB2):
  BLENDER_USER_RESOURCES=assets/tools/blender-user blender -b --python assets/scripts/people/build_character.py -- \
      --spec assets/scripts/people/characters.json --id man_jacket --out assets/build/people

Что делает:
 1. MPFB2 HumanService.deserialize_from_dict: тело по макро-параметрам, низкополигональный прокси proxy741, одежда/обувь/шапка/
    волосы (mhclo), скелет cmu_mb (имена костей = BVH CMU/cgspeed), веса.
 2. Тело: удаляются вершины, закрытые одеждой (группы Delete.* из mhclo). Все части триангулируются и прореживаются
    (Decimate collapse) до бюджета из characters.json.
 3. Веса: пальцы/большой палец/носки сливаются в кисть/стопу, остаётся 23 кости (KEEP), ≤4 влияний, нормировано.
 4. Регион на вершину (атрибут _REGION): 0 кожа, 1 верх, 2 низ, 3 обувь, 4 волосы, 5 шапка, 6 внутренний верх, 7 шарф,
    8 перчатки. Костюм (верх+низ одной текстурой) делится по UV-островам: среднее по высоте ниже таза -> низ, иначе верх
    (или «внутренний верх» при topRegion: inner — рубашка под свитером). Между регионами рёбра разрезаются.
    scarf: true — генерируется шарф (make_scarf).
 5. Атлас 1024×512: кожа 512, верх/низ/волосы 256, остальное 128/64. Всё, кроме кожи, обесцвечивается (средняя яркость
    ~0.85; у обуви тёмное поднимается) — цвет даёт игра (палитры в gltf-people-view.ts). UV пересчитываются в ячейки.
 6. LOD1: копия, прореженная до ~800 треугольников. Оба меша в одном glb, общий скин и материал.
 7. Поворот на 180° вокруг вертикали: в glTF персонаж смотрит в −Z, +Y вверх, ноги в 0, реальный рост в метрах.
Выход: <out>/<id>.glb (PNG-атлас внутри; сжатие WebP/meshopt — в build_people.sh) и <out>/<id>.json (суставы, кончики
костей для ретаргета, рост, треугольники).
"""
import bpy
import bmesh
import sys
import os
import json
import math
import argparse
import numpy as np
from mathutils import Matrix, Vector

from bl_ext.user_default.mpfb.services.humanservice import HumanService  # noqa: E402

KEEP = ['Hips', 'LHipJoint', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RHipJoint', 'RightUpLeg', 'RightLeg', 'RightFoot',
        'LowerBack', 'Spine', 'Spine1', 'Neck', 'Neck1', 'Head',
        'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand']
MERGE = {'LeftToeBase': 'LeftFoot', 'RightToeBase': 'RightFoot', 'LThumb': 'LeftHand', 'LeftFingerBase': 'LeftHand',
         'LeftHandFinger1': 'LeftHand', 'RThumb': 'RightHand', 'RightFingerBase': 'RightHand', 'RightHandFinger1': 'RightHand'}
# «кончики» удалённых/концевых костей (для направления кости при ретаргете)
TIPS = {'LeftFoot': 'LeftToeBase', 'RightFoot': 'RightToeBase', 'LeftHand': 'LeftFingerBase', 'RightHand': 'RightFingerBase'}
REG = {'eyes': 0, 'skin': 0, 'top': 1, 'bottom': 2, 'shoes': 3, 'hair': 4, 'hat': 5, 'inner': 6, 'scarf': 7, 'gloves': 8}
TINTED = {1, 2, 3, 4, 5, 6, 7, 8}  # всё, кроме кожи (обесцвечивается; цвет даёт игра, если не keep)
ATLAS_W, ATLAS_H = 1024, 512
MARGIN = 3
# ячейки атласа (x, y от низа, размер): кожа 512; 256 — верх/низ/внутренний верх/волосы; 128 — обувь/шапка/шарф/перчатки
CELL_SKIN = (0, 0, 512)
CELLS_MID = [(512, 256, 256), (768, 256, 256), (512, 0, 256)]
CELLS_SMALL = [(768, 128, 128), (896, 128, 128), (768, 0, 128), (896, 64, 64), (960, 64, 64), (896, 0, 64), (960, 0, 64)]


def args():
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--spec', required=True)
    p.add_argument('--id', required=True)
    p.add_argument('--out', required=True)
    return p.parse_args(a)


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def find_asset(sub, name, ext):
    from bl_ext.user_default.mpfb.services.locationservice import LocationService
    root = LocationService.get_user_data(sub)
    d = os.path.join(root, name)
    for f in os.listdir(d):
        if f.endswith(ext):
            return os.path.join(name, f)
    raise IOError(f'no {ext} in {d}')


def create_human(spec, defaults):
    ph = {"gender": 0.5, "age": 0.5, "muscle": 0.5, "weight": 0.5, "proportions": 0.5, "height": 0.5, "cupsize": 0.5,
          "firmness": 0.5, "race": {"asian": 0.0, "caucasian": 1.0, "african": 0.0}}
    for k, v in spec['phenotype'].items():
        if k == 'race':
            ph['race'] = {"asian": 0.0, "caucasian": 0.0, "african": 0.0} | v
        else:
            ph[k] = v
    hi = {
        "phenotype": ph, "rig": "cmu_mb", "eyes": find_asset('eyes', spec['eyes']['asset'], '.mhclo') if spec.get('eyes') else "",
        "eyebrows": "", "eyelashes": "", "tongue": "", "teeth": "",
        "hair": find_asset('hair', spec['hair']['asset'], '.mhclo') if spec.get('hair') else "",
        "proxy": find_asset('proxymeshes', spec.get('proxy', defaults['proxy']), '.proxy'),
        "targets": [{"target": t, "value": v} for t, v in (spec.get('targets') or {}).items()], "clothes": [find_asset('clothes', c['asset'], '.mhclo') for c in spec['clothes']],
        "skin_mhmat": find_asset('skins', spec['skin'], '.mhmat'), "skin_material_type": "MAKESKIN",
        "eyes_material_type": "MAKESKIN", "skin_material_settings": {}, "eyes_material_settings": {}, "expressions": [],
        "name": spec['id'],
    }
    s = HumanService.get_default_deserialization_settings()
    s['subdiv_levels'] = 0
    basemesh = HumanService.deserialize_from_dict(hi, s)
    return basemesh


def diffuse_image(o):
    m = o.active_material
    if not m or not m.node_tree:
        return None
    for n in m.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.name == 'diffuseTexture' and n.image:
            return n.image
    for n in m.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image:
            return n.image
    return None


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def activate(o):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o


def delete_masked(o):
    """Удалить вершины в группах Delete.* (что закрыто одеждой)."""
    gids = [g.index for g in o.vertex_groups if g.name.startswith('Delete.')]
    if not gids:
        return
    bm = bmesh.new()
    bm.from_mesh(o.data)
    dl = bm.verts.layers.deform.active
    kill = [v for v in bm.verts if dl and any(v[dl].get(g, 0) > 0.5 for g in gids)]
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    bm.to_mesh(o.data)
    bm.free()


def merge_groups(o):
    vg = {g.name: g for g in o.vertex_groups}
    for src, dst in MERGE.items():
        if src not in vg:
            continue
        if dst not in vg:
            vg[dst] = o.vertex_groups.new(name=dst)
        si = vg[src].index
        for v in o.data.vertices:
            for g in v.groups:
                if g.group == si and g.weight > 0:
                    vg[dst].add([v.index], g.weight, 'ADD')
    for g in list(o.vertex_groups):
        if g.name not in KEEP:
            o.vertex_groups.remove(g)


def triangulate(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(o.data)
    bm.free()


def decimate(o, target):
    triangulate(o)
    n = tri_count(o)
    if target and n > target:
        activate(o)
        m = o.modifiers.new('dec', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.ratio = target / n
        m.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=m.name)
    triangulate(o)


def uv_islands(bm, uvl):
    """Острова по UV: грани, соединённые ребром с совпадающими UV."""
    parent = list(range(len(bm.faces)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    bm.faces.index_update()
    for e in bm.edges:
        lf = e.link_faces
        if len(lf) != 2:
            continue
        f0, f1 = lf

        def uvs(f):
            d = {}
            for l in f.loops:
                d[l.vert.index] = tuple(round(c, 5) for c in l[uvl].uv)
            return d
        a, b = uvs(f0), uvs(f1)
        if all(a[v.index] == b[v.index] for v in e.verts):
            parent[find(f0.index)] = find(f1.index)
    return [find(f.index) for f in bm.faces]


def assign_regions(o, region, split_z, top_region='top'):
    """Регион на грань (для костюма — по UV-островам), разрез рёбер между регионами, атрибут _REGION на вершины."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    uvl = bm.loops.layers.uv.active
    bm.faces.ensure_lookup_table()
    if region == 'suit':
        isl = uv_islands(bm, uvl)
        acc = {}
        for f in bm.faces:
            c = f.calc_center_median()
            s = acc.setdefault(isl[f.index], [0.0, 0])
            s[0] += c.z * f.calc_area()
            s[1] += f.calc_area()
        fr = [REG['bottom'] if acc[isl[f.index]][0] / max(acc[isl[f.index]][1], 1e-9) < split_z else REG[top_region] for f in bm.faces]
    else:
        fr = [REG[region]] * len(bm.faces)
    rl = bm.faces.layers.int.new('reg')
    for f, r in zip(bm.faces, fr):
        f[rl] = r
    cut = [e for e in bm.edges if len(e.link_faces) == 2 and e.link_faces[0][rl] != e.link_faces[1][rl]]
    if cut:
        bmesh.ops.split_edges(bm, edges=cut)
    bm.to_mesh(o.data)
    bm.free()
    me = o.data
    fr_arr = np.zeros(len(me.polygons), np.int32)
    me.attributes['reg'].data.foreach_get('value', fr_arr)
    vr = np.zeros(len(me.vertices), np.float32)
    for p in me.polygons:
        for vi in p.vertices:
            vr[vi] = fr_arr[p.index]
    if '_REGION' in me.attributes:
        me.attributes.remove(me.attributes['_REGION'])
    at = me.attributes.new('_REGION', 'FLOAT', 'POINT')
    at.data.foreach_set('value', vr)
    me.attributes.remove(me.attributes['reg'])
    return set(int(x) for x in np.unique(fr_arr))


def image_pixels(img, size):
    im = img.copy()
    im.scale(size, size)
    px = np.array(im.pixels[:], np.float32).reshape(size, size, 4)
    bpy.data.images.remove(im)
    return px


def face_uv_mask(o, reg, size):
    """Какие текселы использует регион (грубо: UV-центры граней + вершины) — для нормировки яркости."""
    me = o.data
    uv = np.zeros(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    vr = np.zeros(len(me.vertices), np.float32)
    me.attributes['_REGION'].data.foreach_get('value', vr)
    lv = np.zeros(len(me.loops), np.int32)
    me.loops.foreach_get('vertex_index', lv)
    sel = vr[lv] == reg
    pts = uv[sel]
    # плюс центры треугольников
    cents = []
    for p in me.polygons:
        if vr[p.vertices[0]] == reg:
            cents.append(uv[list(p.loop_indices)].mean(0))
    if cents:
        pts = np.concatenate([pts, np.array(cents)])
    pts = np.clip(pts, 0, 0.9999)
    return (pts[:, 1] * size).astype(int), (pts[:, 0] * size).astype(int)


def neutralize(px, rows, cols, lift=False):
    lum = px[..., 0] * 0.2126 + px[..., 1] * 0.7152 + px[..., 2] * 0.0722
    if lift:
        # обувь: в одной текстуре тёмная кожа ботинка и белые носки — поднимаем тёмное, чтобы тон был виден
        g = np.clip(0.42 + 0.58 * lum / max(float(np.percentile(lum, 98)), 0.05), 0, 1)
        out = px.copy()
        out[..., 0] = out[..., 1] = out[..., 2] = g
        return out
    used = lum[rows, cols] if len(rows) else lum.ravel()
    a = px[..., 3][rows, cols] if len(rows) else px[..., 3].ravel()
    used = used[a > 0.5] if (a > 0.5).any() else used
    mean = float(np.median(used)) if used.size else 0.5
    g = np.clip(lum * (0.85 / max(mean, 0.05)), 0, 1)
    out = px.copy()
    out[..., 0] = out[..., 1] = out[..., 2] = g
    return out


def knit_pattern(n):
    """Серая «вязка» для шарфа: продольные рубчики + поперечные полосы."""
    y, x = np.mgrid[0:n, 0:n] / n
    g = 0.78 + 0.12 * np.sin(x * np.pi * 2 * 24) ** 2 - 0.1 * (np.sin(y * np.pi * 2 * 5) > 0.7)
    px = np.ones((n, n, 4), np.float32)
    px[..., 0] = px[..., 1] = px[..., 2] = np.clip(g, 0, 1)
    return px


def make_scarf(arm, others):
    """Шарф: трубка вокруг шеи поверх воротника + свисающий конец спереди. Веса: Neck/Spine1."""
    neck = arm.matrix_world @ arm.data.bones['Neck'].head_local
    z0 = neck.z - 0.035
    # радиус по одежде/телу у основания шеи
    rx = rz = 0.06
    for o in others:
        mw = o.matrix_world
        for v in o.data.vertices:
            w = mw @ v.co
            if abs(w.z - z0) < 0.03 and abs(w.x - neck.x) < 0.14 and abs(w.y - neck.y) < 0.14:
                rx = max(rx, abs(w.x - neck.x)); rz = max(rz, abs(w.y - neck.y))
    rx = min(rx, 0.11) + 0.012
    rz = min(rz, 0.10) + 0.012
    th = 0.032
    n, m = 14, 6
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    ring = []
    for i in range(n):
        a = i / n * math.tau
        cx, cy = math.cos(a), math.sin(a)
        row = []
        for j in range(m):
            b = j / m * math.tau
            r = 1 + (th * math.cos(b)) / max(rx, rz)
            row.append(bm.verts.new((neck.x + cx * rx * r, neck.y + cy * rz * r, z0 + th * 0.9 * math.sin(b))))
        ring.append(row)
    for i in range(n):
        for j in range(m):
            a0, a1 = ring[i][j], ring[(i + 1) % n][j]
            b0, b1 = ring[i][(j + 1) % m], ring[(i + 1) % n][(j + 1) % m]
            f = bm.faces.new((a0, a1, b1, b0))
            for l, (u, v) in zip(f.loops, [(i / n, j / m), ((i + 1) / n, j / m), ((i + 1) / n, (j + 1) / m), (i / n, (j + 1) / m)]):
                l[uvl].uv = (u * 0.7, v * 0.5)
    # конец спереди (персонаж в Blender смотрит в −Y)
    w, L = 0.07, 0.32
    fx = neck.x + 0.05
    fy = neck.y - rz - th * 0.6
    tail = [bm.verts.new((fx - w / 2, fy, z0)), bm.verts.new((fx + w / 2, fy, z0)),
            bm.verts.new((fx + w / 2 + 0.01, fy - 0.03, z0 - L)), bm.verts.new((fx - w / 2 + 0.01, fy - 0.03, z0 - L))]
    f = bm.faces.new(tail)  # одна сторона: материал в игре двусторонний
    for l, uv in zip(f.loops, [(0.75, 0.0), (0.95, 0.0), (0.95, 1.0), (0.75, 1.0)]):
        l[uvl].uv = uv
    me = bpy.data.meshes.new('scarf')
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new('scarf', me)
    bpy.context.scene.collection.objects.link(o)
    o.parent = arm
    o.matrix_parent_inverse = arm.matrix_world.inverted()
    gn, gs = o.vertex_groups.new(name='Neck'), o.vertex_groups.new(name='Spine1')
    for v in me.vertices:
        if v.co.z < z0 - 0.04:
            gs.add([v.index], 1.0, 'REPLACE')
        else:
            gn.add([v.index], 0.6, 'REPLACE'); gs.add([v.index], 0.4, 'REPLACE')
    o['nfr_knit'] = True
    return o


def main():
    a = args()
    spec_all = json.load(open(a.spec))
    defaults = spec_all['defaults']
    spec = next(c for c in spec_all['characters'] if c['id'] == a.id)
    os.makedirs(a.out, exist_ok=True)
    clear_scene()
    basemesh = create_human(spec, defaults)
    arm = basemesh.parent
    assert arm and arm.type == 'ARMATURE'
    hips_z = (arm.matrix_world @ arm.data.bones['Hips'].head_local).z
    # части
    parts = []  # (obj, region, budget, keep)
    for o in list(arm.children):
        if o == basemesh or o.type != 'MESH':
            continue
        src = o.get('MPFB_GEN_asset_source') or ''
        nm = o.name.lower()
        if 'proxy' in nm or 'proxymeshes' in str(src):
            parts.append((o, 'skin', 0, True, None))
            continue
        hit = None
        for c in spec['clothes']:
            if c['asset'].lower() in nm:
                hit = (o, c['region'], c.get('tris', 1500), c.get('keep', False), c)
        if hit is None and spec.get('eyes') and (spec['eyes']['asset'].lower() in nm or 'eyes' in nm):
            hit = (o, 'eyes', 200, True, spec['eyes'])
        if hit is None and spec.get('hair') and spec['hair']['asset'].lower() in nm:
            hit = (o, 'hair', spec['hair'].get('tris', 800), spec['hair'].get('keep', False), spec['hair'])
        if hit is None:
            print('[char] пропускаю', o.name)
            bpy.data.objects.remove(o, do_unlink=True)
            continue
        parts.append(hit)
    bpy.data.objects.remove(basemesh, do_unlink=True)
    if spec.get('scarf'):
        sc = make_scarf(arm, [p[0] for p in parts])
        parts.append((sc, 'scarf', 0, False, {'asset': 'scarf'}))

    # кончики костей до удаления (в координатах Blender, позже повернём)
    tips_b = {k: arm.data.bones[v].head_local.copy() for k, v in TIPS.items()}
    tips_b['Head'] = arm.data.bones['Head'].tail_local.copy()

    cells = []  # (key, obj, reg, img)
    for o, region, budget, keep, c in parts:
        for m in list(o.modifiers):
            o.modifiers.remove(m)
        if region == 'skin':
            delete_masked(o)
        merge_groups(o)
        decimate(o, budget)
        regs = assign_regions(o, region, hips_z, (c or {}).get('topRegion', 'top'))
        img = diffuse_image(o)
        if region == 'eyes' and c and c.get('material'):
            from bl_ext.user_default.mpfb.services.locationservice import LocationService
            ep = os.path.join(LocationService.get_user_data('eyes'), 'materials', c['material'] + '_eye.png')
            img = bpy.data.images.load(ep)
        o['nfr_eyes'] = region == 'eyes'
        o['nfr_regions'] = list(regs)
        o['nfr_keep'] = bool(keep)
        o['nfr_img'] = img.name if img else ''
        print('[char]', o.name, region, tri_count(o), 'tris, regions', sorted(regs), 'img', img.name if img else None)

    part_info = [{'name': p[0].name, 'region': p[1], 'tris': tri_count(p[0])} for p in parts]
    # ---------------- атлас 1024×512
    want = []  # (obj, region)
    for o, region, budget, keep, c in parts:
        for r in o['nfr_regions']:
            want.append((o, r))
    layout = {}
    mid = list(CELLS_MID)
    order = {1: 0, 2: 1, 4: 2, 3: 3, 5: 4, 6: 5, 7: 6, 8: 7, 0: 8}
    for o, r in sorted(want, key=lambda t: order.get(t[1], -1)):
        if r == 0 and not o.get('nfr_eyes'):
            layout[(o.name, r)] = CELL_SKIN
        elif r in (1, 2, 4) and mid:
            layout[(o.name, r)] = mid.pop(0)
    rest = mid + list(CELLS_SMALL)  # оставшиеся по убыванию размера
    for o, r in sorted(want, key=lambda t: order.get(t[1], -1)):
        if (o.name, r) in layout:
            continue
        if not rest:
            raise RuntimeError('атлас переполнен')
        layout[(o.name, r)] = rest.pop(0)
    atlas = np.zeros((ATLAS_H, ATLAS_W, 4), np.float32)
    atlas[..., 3] = 1
    for o, region, budget, keep, c in parts:
        img = bpy.data.images.get(o['nfr_img']) if o['nfr_img'] else None
        me = o.data
        uv = np.zeros(len(me.loops) * 2, np.float32)
        me.uv_layers.active.data.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        lv = np.zeros(len(me.loops), np.int32)
        me.loops.foreach_get('vertex_index', lv)
        vr = np.zeros(len(me.vertices), np.float32)
        me.attributes['_REGION'].data.foreach_get('value', vr)
        new_uv = uv.copy()
        for r in o['nfr_regions']:
            x, y, cs = layout[(o.name, r)]
            inner = cs - 2 * MARGIN
            if img is not None:
                px = image_pixels(img, inner)
                if r in TINTED and not keep:
                    rows, cols = face_uv_mask(o, r, inner)
                    px = neutralize(px, rows, cols, lift=(r == REG['shoes']))
                if c and c.get('color') and r in TINTED:
                    px[..., :3] *= np.array(c['color'], np.float32)
            elif o.get('nfr_knit'):
                px = knit_pattern(inner)
            else:
                px = np.ones((inner, inner, 4), np.float32) * 0.85
            if r != REG['hair']:
                px[..., 3] = 1.0  # прозрачность (alphaTest) — только у карточек волос
            px = np.pad(px, ((MARGIN, MARGIN), (MARGIN, MARGIN), (0, 0)), mode='edge')
            atlas[y:y + cs, x:x + cs] = px
            sel = vr[lv] == r
            uu = np.clip(uv[sel], 0.0, 1.0)
            new_uv[sel, 0] = (x + MARGIN + uu[:, 0] * inner) / ATLAS_W
            new_uv[sel, 1] = (y + MARGIN + uu[:, 1] * inner) / ATLAS_H
        me.uv_layers.active.data.foreach_set('uv', new_uv.ravel())
    atlas_img = bpy.data.images.new(spec['id'] + '_atlas', ATLAS_W, ATLAS_H, alpha=True)
    atlas_img.pixels = atlas.ravel()
    atlas_path = os.path.join(a.out, spec['id'] + '_atlas.png')
    atlas_img.filepath_raw = atlas_path
    atlas_img.file_format = 'PNG'
    atlas_img.save()

    # ---------------- общий меш
    mat = bpy.data.materials.new(spec['id'])
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = atlas_img
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    nt.links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
    bsdf.inputs['Roughness'].default_value = 0.85
    mat.blend_method = 'CLIP' if hasattr(mat, 'blend_method') else None
    objs = [p[0] for p in parts]
    for o in objs:
        o.data.materials.clear()
        o.data.materials.append(mat)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    lod0 = bpy.context.view_layer.objects.active
    lod0.name = lod0.data.name = 'lod0'
    for m in list(lod0.modifiers):
        lod0.modifiers.remove(m)
    activate(lod0)
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    # LOD1
    lod1 = lod0.copy()
    lod1.data = lod0.data.copy()
    lod1.name = lod1.data.name = 'lod1'
    bpy.context.scene.collection.objects.link(lod1)
    m = lod1.modifiers.new('dec', 'DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = min(1.0, spec.get('lod1', defaults['lod1']) / tri_count(lod0))
    m.use_collapse_triangulate = True
    activate(lod1)
    bpy.ops.object.modifier_apply(modifier=m.name)
    triangulate(lod1)
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)

    # ---------------- кости: удалить лишние
    activate(arm)
    bpy.ops.object.mode_set(mode='EDIT')
    for eb in list(arm.data.edit_bones):
        if eb.name not in KEEP:
            arm.data.edit_bones.remove(eb)
    bpy.ops.object.mode_set(mode='OBJECT')

    # ---------------- поворот на 180° вокруг вертикали (вперёд = −Z в glTF)
    R = Matrix.Rotation(math.pi, 4, 'Z')
    assert arm.matrix_world == Matrix.Identity(4) or True
    # всё в мировые координаты на уровне данных
    for o in (lod0, lod1):
        o.data.transform(o.matrix_world)
        o.matrix_world = Matrix.Identity(4)
        o.data.transform(R)
    aw = arm.matrix_world.copy()
    arm.data.transform(R @ aw)
    arm.matrix_world = Matrix.Identity(4)
    for o in (lod0, lod1):
        o.parent = arm
        o.matrix_parent_inverse = Matrix.Identity(4)
        for mm in list(o.modifiers):
            o.modifiers.remove(mm)
        md = o.modifiers.new('Armature', 'ARMATURE')
        md.object = arm
    to_gl = lambda v: [round(v.x, 5), round(v.z, 5), round(-v.y, 5)]  # Blender Z-up -> glTF Y-up
    RW = R @ aw
    joints = {b.name: to_gl(b.head_local) for b in arm.data.bones}
    parents = {b.name: (b.parent.name if b.parent else None) for b in arm.data.bones}
    tips = {k: to_gl(RW @ v) for k, v in tips_b.items()}
    zmin = min((v.co.z for v in lod0.data.vertices))
    zmax = max((v.co.z for v in lod0.data.vertices))

    # ---------------- экспорт
    bpy.ops.object.select_all(action='DESELECT')
    for o in (arm, lod0, lod1):
        o.select_set(True)
    out_glb = os.path.join(a.out, spec['id'] + '.glb')
    bpy.ops.export_scene.gltf(filepath=out_glb, export_format='GLB', use_selection=True, export_skins=True,
                              export_animations=False, export_attributes=True, export_morph=False, export_yup=True,
                              export_apply=False, export_materials='EXPORT', export_image_format='AUTO',
                              export_def_bones=False, export_all_influences=False)
    meta = {
        'id': spec['id'], 'body': spec['body'], 'female': spec['female'],
        'height': tips['Head'][1], 'heightTotal': round(zmax - zmin, 4),
        'tris': tri_count(lod0), 'lod1Tris': tri_count(lod1),
        'bones': [b.name for b in arm.data.bones], 'parents': parents, 'joints': joints, 'tips': tips,
        'regions': sorted(set(int(k[1]) for k in layout.keys())),
        'parts': part_info,
    }
    json.dump(meta, open(os.path.join(a.out, spec['id'] + '.json'), 'w'), indent=1)
    print('[char] OK', spec['id'], 'tris', meta['tris'], meta['lod1Tris'])


main()
