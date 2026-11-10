# Сборка игровой Lada Largus (тюнинг) из Sketchfab-модели usolakolya (CC BY 4.0).
#
#   blender -b --python build_largus.py -- <scene.gltf> <outdir>
#
# Результат: <outdir>/largus_raw.glb (LOD0), <outdir>/largus_lod1_raw.glb. Дальше — meshopt: assets/scripts/pack_largus.sh
# Конвенция выхода (glTF): +Y вверх, перёд = -Z, право = +X, 1 ед = 1 м; начало координат — на земле, по центру колёсной базы.
# Узлы: body, wheel_FL/FR/RL/RR (пивот в центре колеса). Материалы: paint, glass, headlight, taillight, brakelight, ...
import bpy, bmesh, sys, math, os, json
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
os.makedirs(OUT, exist_ok=True)

# ---- целевые размеры (реальный Largus) и параметры тюнинга ----
WHEELBASE = 2.905
TIRE_R = 0.308          # 205/45 R17 -> наружный радиус
RIM_R = 0.2159          # 17"
TIRE_HALF_W = 0.1025    # 205 мм
LOWER = 0.040           # посадка кузова относительно колёс, м
FRONT_AXLE_Y = None     # заполняется ниже

def srgb(h):
    h = h.lstrip('#'); r, g, b = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (f(r), f(g), f(b))

# ---------------------------------------------------------------- импорт
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

keep = []
for o in list(bpy.data.objects):
    if o.type != 'MESH':
        continue
    mw = o.matrix_world.copy()
    cx = sum((mw @ Vector(c))[0] for c in o.bound_box) / 8
    if cx > 0.3:  # вторая копия машины (с открытыми дверями) — выбрасываем
        bpy.data.objects.remove(o, do_unlink=True)
        continue
    o.parent = None
    o.data = o.data.copy()   # glTF-меши могут быть общими для нескольких нод
    o.data.transform(mw)
    if mw.determinant() < 0:
        o.data.flip_normals()
    o.matrix_world = Matrix.Identity(4)
    keep.append(o)
for o in list(bpy.data.objects):
    if o.type != 'MESH':
        bpy.data.objects.remove(o, do_unlink=True)

def bbox(o):
    vs = [o.matrix_world @ v.co for v in o.data.vertices]
    return Vector([min(v[i] for v in vs) for i in range(3)]), Vector([max(v[i] for v in vs) for i in range(3)])

def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)

def matname(o):
    return o.data.materials[0].name if o.data.materials and o.data.materials[0] else ''

# ---- центры колёс по шинам (Material.009) ----
tires = [o for o in keep if matname(o) == 'Material.009']
assert len(tires) == 4, len(tires)
cen = []
for t in tires:
    a, b = bbox(t); cen.append((a + b) / 2)
cen.sort(key=lambda c: c[1])      # перёд = -Y исходной модели
front = cen[:2]; rear = cen[2:]
y_f = sum(c.y for c in front) / 2; y_r = sum(c.y for c in rear) / 2
print('CEN', [tuple(round(v,3) for v in c) for c in cen])
s = WHEELBASE / (y_r - y_f)
xs = sorted(c.x for c in cen)
x_mid = sum(xs) / 4
track_model = ((xs[2] + xs[3]) / 2 - (xs[0] + xs[1]) / 2)
a, b = bbox(tires[0]); r_model = (b.z - a.z) / 2 * s
z_ground = min(bbox(t)[0].z for t in tires)
z_center_model = sum(c.z for c in cen) / 4
print('SCALE', s, 'TRACK(final)', track_model * s, 'R_model(final)', r_model, 'wheel center z above tire bottom', (z_center_model - z_ground) * s)
y_mid = (y_f + y_r) / 2

# Матрица: центрирование -> масштаб -> поворот 180 вокруг Z (перёд -Y -> +Y; в glTF это -Z)
R180 = Matrix.Rotation(math.pi, 4, 'Z')
Mg = R180 @ Matrix.Scale(s, 4) @ Matrix.Translation((-x_mid, -y_mid, -z_center_model))
# z: теперь центр колеса в 0. Дальше сдвигаем: земля = z=-TIRE_R для колёс; кузов опускаем на LOWER.
BODY_DZ = TIRE_R - LOWER  # центр колеса был 0 -> поднимаем всё на R (земля в 0), кузов ниже на LOWER
for o in keep:
    o.data.transform(Mg)
    o.data.transform(Matrix.Translation((0, 0, BODY_DZ)))

# ---------------------------------------------------------------- материалы
MATS = {}
def mat(name, color, metal=0.0, rough=0.5, alpha=1.0, coat=0.0, coat_rough=0.05, emit=None, spec=0.5):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*srgb(color), 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    b.inputs['Alpha'].default_value = alpha
    if coat:
        b.inputs['Coat Weight'].default_value = coat
        b.inputs['Coat Roughness'].default_value = coat_rough
    if emit:
        b.inputs['Emission Color'].default_value = (*srgb(emit), 1)
        b.inputs['Emission Strength'].default_value = 0.0
    if alpha < 1:
        try: m.surface_render_method = 'BLENDED'
        except Exception: pass
        try: m.blend_method = 'BLEND'
        except Exception: pass
    if name in ('tire', 'rim', 'brake_disc', 'interior', 'chrome'):  # открытые поверхности — двусторонние
        m.use_backface_culling = False
    else:
        m.use_backface_culling = True
    MATS[name] = m
    return m

mat('paint', '#0d2250', metal=0.85, rough=0.30, coat=1.0, coat_rough=0.04)   # тёмно-синий металлик + клирикоут
mat('glass', '#0a0f14', metal=0.0, rough=0.05, alpha=0.38)
mat('headlight', '#c9d3dc', metal=0.3, rough=0.06, emit='#fff2cc')
mat('taillight', '#6a0508', metal=0.0, rough=0.15, emit='#ff1a10')
mat('brakelight', '#a00a0a', metal=0.0, rough=0.15, emit='#ff0800')
mat('trim', '#0c0c0e', metal=0.0, rough=0.55)                                   # чёрные акценты
mat('chrome', '#c8ccd2', metal=1.0, rough=0.12)
mat('tire', '#101010', metal=0.0, rough=0.88)
mat('rim', '#2a2c32', metal=0.9, rough=0.28)                                    # графитовый диск
mat('brake_disc', '#6a6a6e', metal=0.9, rough=0.5)
mat('interior', '#14161a', metal=0.0, rough=0.8)
mat('plate', '#e9e9e4', metal=0.0, rough=0.5)

ROLE = {
    '1403': 'paint', 'Material.040': 'paint',
    'Material.006': 'glass', 'Material.007': 'glass', 'Material.008': 'glass',
    'Material.002': 'headlight', 'Material.004': 'headlight',
    'Material.021': 'taillight', 'Material.022': 'taillight', 'Material.023': 'brakelight',
    'Material.019': 'chrome', 'Material.017': 'chrome',
    'Material.016': 'plate',
    'Material.020': 'trim', 'Material.001': 'trim', 'Material.003': 'trim', 'Material.005': 'trim',
    'Material.029': 'trim', 'Material.032': 'trim', 'Material.037': 'trim',
    'Material.028': 'interior', 'Material.035': 'interior', 'Material.036': 'interior', 'Material.030': 'interior',
    'Material.031': 'interior', 'Material.033': 'interior', 'Material.034': 'interior', 'Material.018': 'interior',
}
# Выбрасываем: колёса (шина/диски — заменим своими), двигатель/подвеска (024/026/027), багажник на крыше (038/039)
DROP = {'Material.009', 'Material.011', 'Material.012', 'Material.013', 'Material.014', 'Material.015', '1223',
        'Material.024', 'Material.026', 'Material.027', 'Material.038', 'Material.039'}

parts = {}   # role -> [objects]
for o in keep:
    n = matname(o)
    if n in DROP or n not in ROLE:
        bpy.data.objects.remove(o, do_unlink=True)
        continue
    r = ROLE[n]
    o.data.materials.clear(); o.data.materials.append(MATS[r])
    parts.setdefault(r, []).append(o)

# ---------------------------------------------------------------- вспомогательное
def make_obj(name, bm, material):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(MATS[material])
    for p in me.polygons: p.use_smooth = True
    return o

def box(bm, c, sz, rotz=0.0, rotx=0.0):
    r = bmesh.ops.create_cube(bm, size=1.0)
    verts = r['verts']
    m = Matrix.Translation(c) @ Matrix.Rotation(rotz, 4, 'Z') @ Matrix.Rotation(rotx, 4, 'X') @ Matrix.Diagonal((sz[0], sz[1], sz[2], 1))
    bmesh.ops.transform(bm, matrix=m, verts=verts)

def lathe(bm, profile, seg, axis='X'):
    """profile: список (x вдоль оси, r радиус). Вращение вокруг оси X."""
    rings = []
    for (x, r) in profile:
        ring = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            ring.append(bm.verts.new((x, r * math.cos(a), r * math.sin(a))))
        rings.append(ring)
    for k in range(len(rings) - 1):
        for i in range(seg):
            j = (i + 1) % seg
            try: bm.faces.new((rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]))
            except ValueError: pass
    return rings

def cap(bm, ring, flip=False):
    vs = ring[::-1] if flip else ring
    try: bm.faces.new(vs)
    except ValueError: pass

def build_wheel(side, seg_t=44, spokes=5, lod=0):
    """Колесо вокруг начала координат, ось = X, наружная сторона = +X (side=+1) или -X (side=-1)."""
    W = TIRE_HALF_W
    # ---- шина (профиль 205/45 R17): бортовая -> боковина -> плечо -> протектор
    prof = [(W * 0.82, RIM_R - 0.004), (W * 0.98, RIM_R + 0.020), (W * 1.0, RIM_R + 0.060), (W * 0.97, TIRE_R - 0.040),
            (W * 0.88, TIRE_R - 0.012), (W * 0.70, TIRE_R - 0.001), (W * 0.45, TIRE_R)]
    full = [(-x, r) for (x, r) in prof][::-1] + [(x, r) for (x, r) in prof]
    bt = bmesh.new(); lathe(bt, full, seg_t)
    bmesh.ops.recalc_face_normals(bt, faces=bt.faces)
    tire = make_obj('tire', bt, 'tire')
    # ---- диск: бочка + лицевая тарелка + 5 пар спиц + центр + гайки
    br = bmesh.new()
    barrel = [(-W * 0.78, RIM_R - 0.004), (-W * 0.78, RIM_R - 0.030), (-W * 0.25, RIM_R - 0.040), (W * 0.45, RIM_R - 0.030), (W * 0.62, RIM_R - 0.015)]
    lathe(br, barrel, seg_t)
    # лицевая тарелка (углублённая) — тёмное дно между спицами
    dish = [(W * 0.30, 0.05), (W * 0.30, RIM_R - 0.040)]
    lathe(br, dish, seg_t)
    # спицы: 5 пар, сужаются к ободу
    hub_r, out_r = 0.040, RIM_R - 0.012
    n = spokes
    for k in range(n):
        base = 2 * math.pi * k / n
        for d in (-0.115, 0.115):
            ang = base + d
            # трапеция: у ступицы шире, у обода уже, выпуклость наружу
            xin, xout = W * 0.30, W * 0.62
            def P(rad, w, x):
                ca, sa = math.cos(ang), math.sin(ang)
                # поперечное направление в плоскости YZ
                px, py = -sa, ca
                return [bm_v(br, x, rad * ca + w * px, rad * sa + w * py), bm_v(br, x, rad * ca - w * px, rad * sa - w * py)]
            a0 = P(hub_r, 0.020, xout + 0.006); a1 = P(out_r, 0.011, xout - 0.004)
            b0 = P(hub_r, 0.020, xin); b1 = P(out_r, 0.011, xin)
            for q in ((a0[0], a0[1], a1[1], a1[0]), (b0[1], b0[0], b1[0], b1[1]), (a0[0], b0[0], b1[0], a1[0]),
                      (a1[1], b1[1], b0[1], a0[1]), (a1[0], b1[0], b1[1], a1[1]), (a0[1], b0[1], b0[0], a0[0])):
                try: br.faces.new(q)
                except ValueError: pass
    # центральный колпак
    cp = [(W * 0.30, 0.0), (W * 0.30, 0.045), (W * 0.64, 0.043), (W * 0.68, 0.030), (W * 0.68, 0.0)]
    ring = lathe(br, cp, 24)
    # гайки
    for k in range(5):
        a = 2 * math.pi * (k + 0.5) / 5
        bn = bmesh.ops.create_cone(br, cap_ends=True, segments=6, radius1=0.0085, radius2=0.0085, depth=0.012)
        bmesh.ops.translate(br, verts=bn['verts'], vec=(W * 0.70, 0.028 * math.cos(a), 0.028 * math.sin(a)))
        bmesh.ops.rotate(br, verts=bn['verts'], cent=(W * 0.70, 0.028 * math.cos(a), 0.028 * math.sin(a)), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'))
    bmesh.ops.recalc_face_normals(br, faces=br.faces)
    rim = make_obj('rim', br, 'rim')
    # ---- хромированный ободок (лип)
    bl = bmesh.new()
    lip = [(W * 0.62, RIM_R - 0.015), (W * 0.74, RIM_R + 0.002), (W * 0.70, RIM_R + 0.010)]
    lathe(bl, lip, seg_t)
    bmesh.ops.recalc_face_normals(bl, faces=bl.faces)
    lipo = make_obj('lip', bl, 'chrome')
    # ---- тормозной диск и ступица за спицами (виден между спицами)
    bd = bmesh.new()
    disc = [(W * 0.02, 0.060), (W * 0.02, 0.165), (W * 0.20, 0.165), (W * 0.20, 0.060)]
    r_ = lathe(bd, disc, seg_t)
    cap(bd, r_[0], True); cap(bd, r_[-1], False)
    bmesh.ops.recalc_face_normals(bd, faces=bd.faces)
    discO = make_obj('disc', bd, 'brake_disc')
    # задняя «тёмная» плоскость ободка (чтобы не просвечивало)
    bb = bmesh.new()
    r_ = lathe(bb, [(-W * 0.05, 0.0), (-W * 0.05, RIM_R - 0.035)], seg_t)
    bmesh.ops.recalc_face_normals(bb, faces=bb.faces)
    backO = make_obj('back', bb, 'interior')
    objs = [tire, rim, lipo, discO, backO]
    if side < 0:
        for o in objs:
            o.data.transform(Matrix.Scale(-1, 4, Vector((1, 0, 0))))
            o.data.flip_normals()
    return objs

def bm_v(bm, x, y, z):
    return bm.verts.new((x, y, z))

def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active; o.name = name; o.data.name = name
    return o

def decimate(o, ratio):
    if ratio >= 0.999: return
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    m = o.modifiers.new('dec', 'DECIMATE'); m.ratio = ratio; m.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier='dec')

# ---------------------------------------------------------------- расчёт геометрии кузова
allv = []
for lst in parts.values():
    for o in lst:
        for v in o.data.vertices: allv.append(v.co.copy())
zmin = min(v.z for v in allv); zmax = max(v.z for v in allv)
ymin = min(v.y for v in allv); ymax = max(v.y for v in allv)
xmin = min(v.x for v in allv); xmax = max(v.x for v in allv)
print('BODY bbox x[%.3f %.3f] y[%.3f %.3f] z[%.3f %.3f]' % (xmin, xmax, ymin, ymax, zmin, zmax))
print('LENGTH', ymax - ymin, 'WIDTH(with mirrors)', xmax - xmin, 'HEIGHT', zmax - zmin)

# крыша у заднего края (для спойлера): перёд = +Y, зад = ymin; антенну игнорируем через 80-й перцентиль
roof_z = None; roof_y_rear = None
for k in range(40):
    yy = ymin + 0.05 * k
    zz = sorted(v.z for v in allv if abs(v.x) < 0.3 and yy <= v.y < yy + 0.05)
    if zz and zz[int(len(zz) * 0.8)] > 1.45:
        roof_z = zz[int(len(zz) * 0.8)]; roof_y_rear = yy + 0.02; break
low_band = [v for v in allv if abs(v.x) < 0.5 and 0.15 < v.z < 0.35]
bump_y = min(v.y for v in low_band)
for yy in [ymin + 0.05 * k for k in range(0, 14)]:
    zz = sorted(v.z for v in allv if abs(v.x) < 0.3 and yy <= v.y < yy + 0.05)
    print('PROFILE y=%.2f n=%d z80=%.3f zmax=%.3f' % (yy, len(zz), zz[int(len(zz) * 0.8)] if zz else -1, zz[-1] if zz else -1))
print('ROOF z', roof_z, 'roof rear y', roof_y_rear, 'bumper rear y', bump_y)

# ---------------------------------------------------------------- тюнинг-детали
extra = []
# спойлер на крыше (глянцевый чёрный): плоскость + две стойки
bs = bmesh.new()
sp_y = roof_y_rear - 0.03
box(bs, (0, sp_y, roof_z + 0.040), (1.08, 0.19, 0.016), rotx=math.radians(-8))
for sx in (-0.40, 0.40):
    box(bs, (sx, sp_y + 0.03, roof_z + 0.012), (0.035, 0.06, 0.04))
for sx in (-0.555, 0.555):
    box(bs, (sx, sp_y, roof_z + 0.050), (0.010, 0.21, 0.045), rotx=math.radians(-8))
extra.append(make_obj('spoiler', bs, 'trim'))
# двойной выхлоп: хромированные насадки + тёмная внутренность (ось вдоль Y, выступают назад из-под бампера)
be = bmesh.new(); bi = bmesh.new()
def add_to(bm_dst, bm_src):
    tm = bpy.data.meshes.new('t'); bm_src.to_mesh(tm); bm_src.free(); bm_dst.from_mesh(tm); bpy.data.meshes.remove(tm)
for sx in (-0.46, 0.46):
    m = Matrix.Translation((sx, bump_y + 0.03, 0.24)) @ Matrix.Rotation(-math.pi / 2, 4, 'Z')  # ось +X -> -Y (назад)
    t = bmesh.new()
    lathe(t, [(0.0, 0.0345), (0.0, 0.043), (0.10, 0.043), (0.10, 0.0345), (0.0, 0.0345)], 20)
    bmesh.ops.transform(t, matrix=m, verts=t.verts); add_to(be, t)
    t2 = bmesh.new(); lathe(t2, [(0.012, 0.0), (0.012, 0.0345)], 20)
    bmesh.ops.transform(t2, matrix=m, verts=t2.verts); add_to(bi, t2)
extra.append(make_obj('exhaust', be, 'chrome'))
extra.append(make_obj('exhaust_in', bi, 'interior'))
# пол салона (чтобы не просвечивала земля сквозь окна)
bf = bmesh.new()
box(bf, (0, 0.1, zmin + 0.12), (1.30, 2.6, 0.02))
extra.append(make_obj('floor', bf, 'interior'))
for o in extra:
    parts.setdefault(o.data.materials[0].name, []).append(o)
    o['extra'] = 1

# нормали/сглаживание уже взяты из импорта; приводим всё к одному набору объектов
def finalize(lod):
    """Собираем body + 4 колеса, декимируем под LOD, экспортируем."""
    # копируем объекты, чтобы можно было сделать второй LOD
    import copy
    def dup(o):
        n = o.copy(); n.data = o.data.copy(); bpy.context.scene.collection.objects.link(n); return n
    work = {r: [dup(o) for o in lst] for r, lst in parts.items()}
    ratios = {0: {'paint': 1.0, 'trim': 1.0, 'interior': 0.5, 'glass': 1.0, 'chrome': 1.0, 'headlight': 1.0, 'taillight': 1.0,
                  'brakelight': 1.0, 'plate': 1.0},
              1: {'paint': 0.28, 'trim': 0.2, 'interior': 0.0, 'glass': 0.6, 'chrome': 0.4, 'headlight': 0.5, 'taillight': 0.5,
                  'brakelight': 0.5, 'plate': 0.3}}[lod]
    body_objs = []
    for r, lst in work.items():
        if ratios.get(r, 1.0) <= 0.0:
            for o in lst:
                if o.get('extra') and o.name.startswith('floor'): body_objs.append(o)
                else: bpy.data.objects.remove(o, do_unlink=True)
            continue
        if r == 'interior' and lod == 1:
            continue
        for o in lst:
            if o.get('extra'): body_objs.append(o); continue
            decimate(o, ratios.get(r, 1.0))
            body_objs.append(o)
    # LOD1: пол салона нужен всегда
    body = join(body_objs, 'body')
    # колёса
    wheels = {}
    pos = {'FL': (-1, -1), 'FR': (1, -1), 'RL': (-1, 1), 'RR': (1, 1)}  # (side, fwd(+Y=-1..) )
    half_track = track_model * s / 2
    for k, (side, fb) in pos.items():
        objs = build_wheel(side, seg_t=44 if lod == 0 else 20, spokes=5, lod=lod)
        if lod == 1:
            # упрощённо: убираем гайки/ободок
            pass
        w = join(objs, 'wheel_' + k)
        y = (WHEELBASE / 2) * (1 if k[0] == 'F' else -1)
        x = half_track * side
        w.location = (x, y, TIRE_R)
        w.data.transform(Matrix.Identity(4))
        wheels[k] = w
    return body, wheels

def export(path, lod):
    # убрать всё лишнее со сцены кроме объектов lod
    body, wheels = finalize(lod)
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    for w in wheels.values(): w.select_set(True)
    tcount = sum(tris(o) for o in [body] + list(wheels.values()))
    print('EXPORT', path, 'tris', tcount, 'body', tris(body))
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=False, export_yup=True,
                              export_materials='EXPORT', export_cameras=False, export_lights=False, export_extras=False,
                              export_texcoords=False, export_normals=True)
    for o in [body] + list(wheels.values()): bpy.data.objects.remove(o, do_unlink=True)
    return tcount

t0 = export(os.path.join(OUT, 'largus_raw.glb'), 0)
t1 = export(os.path.join(OUT, 'largus_lod1_raw.glb'), 1)
json.dump({'scale': s, 'track': track_model * s, 'tire_r': TIRE_R, 'wheelbase': WHEELBASE, 'lower': LOWER, 'tris_lod0': t0, 'tris_lod1': t1,
           'length': ymax - ymin, 'width_mirrors': xmax - xmin, 'height': zmax - zmin, 'body_dz': BODY_DZ},
          open(os.path.join(OUT, 'largus_build.json'), 'w'), indent=1)
