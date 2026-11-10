# Конвертер машин трафика/парковки: исходник (glTF/GLB/FBX/OBJ/.blend) → игровой glb + LOD1 + фрагмент манифеста.
#
#   blender -b --python assets/scripts/vehicles/build_vehicle.py -- <configs/<id>.json> <raw_out_dir>
#
# Дальше: sh assets/scripts/vehicles/pack_vehicle.sh <raw_out_dir> <id>  (webp ≤1k + meshopt → game/public/assets/vehicles/<id>/)
#         node assets/scripts/vehicles/make_manifest.mjs                (→ game/public/assets/vehicles/vehicles.json)
#
# Конвенция выхода (glTF): +Y вверх, перёд −Z, право +X, метры; начало координат — на земле, по центру между осями.
# Узлы LOD0: body (кузов, материалы по ролям), wheel (одно колесо-шаблон: ПРАВОЕ заднее, центр в начале координат,
# ось вращения X, наружная сторона +X; левые колёса рантайм поворачивает на π вокруг Y). LOD1: body (кузов + колёса, без шаблона).
# Материалы — по ролям (paint/glass/headlight/taillight/brakelight/indicator/trim/chrome/tire/rim/interior/plate/beacon/sign),
# все ссылаются на ОДНУ запечённую текстуру (атлас albedo, UV «bake»). Кузов (paint) запекается белым — цвет даёт инстанс
# (кроме keepPaintTexture: ливреи такси/ДПС/скорой).
#
# Конфиг (JSON): см. assets/scripts/vehicles/README в docs/stage2/models.md. Основное:
#   id, kind, src (путь от корня репо), forward ('+X'|'-X'|'+Y'|'-Y' — куда смотрит перёд в осях Blender после импорта),
#   dims {length,width,height,wheelbase}, scaleBy ('length'|'wheelbase'), budget (тр. LOD0 вместе с 4 колёсами), lod1Budget,
#   wheelBudget, texSize, materialRoles {имя материала|regex: роль}, deleteObjects [regex], deleteMaterials [regex],
#   wheelObjects (regex имён объектов/материалов колёс), wheelsFromLooseParts (bool), keepPaintTexture, mergeDistance.
import bpy, bmesh, sys, os, json, re, math
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
CFG_PATH, OUT = os.path.abspath(argv[0]), os.path.abspath(argv[1])
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
cfg = json.load(open(CFG_PATH, encoding='utf8'))
ID = cfg['id']
os.makedirs(OUT, exist_ok=True)
SRC = cfg['src'] if os.path.isabs(cfg['src']) else os.path.join(ROOT, cfg['src'])
DIMS = cfg.get('dims', {})
BUDGET = int(cfg.get('budget', 12000))
LOD1_BUDGET = int(cfg.get('lod1Budget', 1500))
TEX = int(cfg.get('texSize', 1024))
IS_BUS = cfg.get('kind') in ('paz', 'liaz', 'trolleybus', 'gazelle')
WHEEL_BUDGET = int(cfg.get('wheelBudget', 600 if IS_BUS else 400))

def log(*a):
    print('[build_vehicle]', *a, flush=True)

# ---------------------------------------------------------------- роли материалов
DEFAULT_ROLES = [
    ('wheel', r'(?i)wheel|tire|tyre|\brims?\b|disk|disc|колес|шин|диск|reifen|felge|pneu|roda'),
    ('glass', r'(?i)glass|window|windshield|wind_?screen|стекл|vidro|verre|glas\b'),
    ('headlight', r'(?i)head_?l|headlamp|front_?l|фар|^lights?$|light_?white|lamp_?front'),
    ('brakelight', r'(?i)brake|стоп'),
    ('taillight', r'(?i)tail|rear_?l|back_?l|задн|light_?red|lamp_?rear'),
    ('indicator', r'(?i)indicator|turn|blinker|поворот|orange|amber|signal'),
    ('interior', r'(?i)interior|seat|salon|салон|dash|steer|cabin_in|inside'),
    ('plate', r'(?i)plate|номер|licen[cs]e'),
    ('chrome', r'(?i)chrome|хром|mirror_?glass'),
    ('beacon', r'(?i)beacon|siren|мигалк|strobe'),
    ('paint', r'(?i)body|paint|kuzov|кузов|exterior|carpaint|car_?paint|color|colour'),
]
ROLE_RE = [(r, re.compile(p)) for r, p in DEFAULT_ROLES]
CFG_ROLES = cfg.get('materialRoles', {})

def role_of(matname):
    if matname in CFG_ROLES:
        return CFG_ROLES[matname]
    for k, v in CFG_ROLES.items():
        try:
            if re.search(k, matname):
                return v
        except re.error:
            pass
    for r, rx in ROLE_RE:
        if rx.search(matname):
            return r
    return cfg.get('defaultRole', 'trim')

# ---------------------------------------------------------------- импорт
bpy.ops.wm.read_factory_settings(use_empty=True)
ext = os.path.splitext(SRC)[1].lower()
if ext in ('.gltf', '.glb'):
    bpy.ops.import_scene.gltf(filepath=SRC)
elif ext == '.fbx':
    bpy.ops.import_scene.fbx(filepath=SRC)
elif ext == '.obj':
    bpy.ops.wm.obj_import(filepath=SRC)
elif ext == '.blend':
    with bpy.data.libraries.load(SRC, link=False) as (src, dst):
        dst.objects = src.objects
    for o in dst.objects:
        if o is not None:
            bpy.context.scene.collection.objects.link(o)
else:
    raise SystemExit('unsupported source ' + SRC)

del_obj = [re.compile(p) for p in cfg.get('deleteObjects', [])]
keep_obj = [re.compile(p) for p in cfg.get('keepObjects', [])]
for o in list(bpy.data.objects):
    if o.type != 'MESH' or not o.data.polygons or any(r.search(o.name) for r in del_obj) or (keep_obj and not any(r.search(o.name) for r in keep_obj)):
        continue
    mw = o.matrix_world.copy()
    o.parent = None
    o.data = o.data.copy()
    o.data.transform(mw)
    if mw.determinant() < 0:
        o.data.flip_normals()
    o.matrix_world = Matrix.Identity(4)
    o['keep'] = 1
for o in list(bpy.data.objects):
    if o.type != 'MESH' or not o.get('keep'):
        bpy.data.objects.remove(o, do_unlink=True)
objs = [o for o in bpy.data.objects if o.type == 'MESH']
log('objects', len(objs), 'tris', sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs))

# ---------------------------------------------------------------- удаление граней по материалам
del_mat = [re.compile(p) for p in cfg.get('deleteMaterials', [])]
if del_mat:
    for o in objs:
        bad = {i for i, m in enumerate(o.data.materials) if m and any(r.search(m.name) for r in del_mat)}
        if not bad:
            continue
        bm = bmesh.new(); bm.from_mesh(o.data)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in bad], context='FACES')
        bm.to_mesh(o.data); bm.free()
    for o in list(objs):
        if not o.data.polygons:
            objs.remove(o); bpy.data.objects.remove(o, do_unlink=True)

# ---------------------------------------------------------------- ориентация: перёд → +Y Blender (= −Z glTF)
fwd = cfg.get('forward', '-Y')
rot = {'+Y': 0.0, '-Y': math.pi, '+X': math.pi / 2, '-X': -math.pi / 2}[fwd]
R = Matrix.Rotation(rot, 4, 'Z')
up = cfg.get('up', '+Z')
if up == '+Y':      # исходник «Y вверх», не пересчитанный импортёром
    R = R @ Matrix.Rotation(math.pi / 2, 4, 'X')
elif up == '-Y':
    R = R @ Matrix.Rotation(-math.pi / 2, 4, 'X')
for o in objs:
    o.data.transform(R)

def bbox_of(obs):
    lo = Vector((1e9, 1e9, 1e9)); hi = Vector((-1e9, -1e9, -1e9))
    for o in obs:
        for v in o.data.vertices:
            for i in range(3):
                lo[i] = min(lo[i], v.co[i]); hi[i] = max(hi[i], v.co[i])
    return lo, hi

lo, hi = bbox_of(objs)
size = hi - lo
log('bbox src', [round(x, 3) for x in size])

# ---------------------------------------------------------------- колёса: отделить геометрию
wheel_rx = re.compile(cfg.get('wheelObjects', DEFAULT_ROLES[0][1]))

def split_by_materials(o, pred):
    """Вынести грани o с материалами, для которых pred(имя) → новый объект. Возвращает новый объект или None."""
    idx = {i for i, m in enumerate(o.data.materials) if m and pred(m.name)}
    if not idx:
        return None
    if all(p.material_index in idx for p in o.data.polygons):
        return o
    n = o.copy(); n.data = o.data.copy(); bpy.context.scene.collection.objects.link(n)
    for ob, keep_in in ((o, False), (n, True)):
        bm = bmesh.new(); bm.from_mesh(ob.data)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if (f.material_index in idx) != keep_in], context='FACES')
        bm.to_mesh(ob.data); bm.free()
    return n

wheel_objs = []
if not cfg.get('wheelsFromLooseParts'):
    for o in list(objs):
        if wheel_rx.search(o.name):
            wheel_objs.append(o); objs.remove(o); continue
        n = split_by_materials(o, lambda nm: bool(wheel_rx.search(nm)) or role_of(nm) in ('tire', 'rim'))
        if n is o:
            wheel_objs.append(o); objs.remove(o)
        elif n is not None:
            wheel_objs.append(n)

def loose_parts(o):
    """Список множеств индексов граней по связным компонентам (по общим вершинам)."""
    me = o.data
    parent = list(range(len(me.vertices)))
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for e in me.edges:
        a, b = find(e.vertices[0]), find(e.vertices[1])
        if a != b:
            parent[a] = b
    groups = {}
    for p in me.polygons:
        groups.setdefault(find(p.vertices[0]), []).append(p.index)
    return list(groups.values())

def poly_bbox(me, polys):
    lo = Vector((1e9, 1e9, 1e9)); hi = Vector((-1e9, -1e9, -1e9))
    for pi in polys:
        for vi in me.polygons[pi].vertices:
            c = me.vertices[vi].co
            for i in range(3):
                lo[i] = min(lo[i], c[i]); hi[i] = max(hi[i], c[i])
    return lo, hi

if cfg.get('wheelsFromLooseParts') and not wheel_objs:
    # колёса = связные куски у земли с почти круглым боковым профилем
    H = size.z; groundZ = lo.z
    for o in list(objs):
        me = o.data
        sel = []
        for polys in loose_parts(o):
            a, b = poly_bbox(me, polys); d = b - a
            if a.z > groundZ + 0.06 * H or d.z < 0.18 * H or d.z > 0.6 * H:
                continue
            if abs(d.y - d.z) > 0.3 * max(d.y, d.z) or d.x > 0.5 * d.z + 0.15:
                continue
            sel.extend(polys)
        if sel:
            n = o.copy(); n.data = o.data.copy(); bpy.context.scene.collection.objects.link(n)
            s = set(sel)
            for ob, keep_in in ((o, False), (n, True)):
                bm = bmesh.new(); bm.from_mesh(ob.data); bm.faces.ensure_lookup_table()
                bmesh.ops.delete(bm, geom=[f for f in bm.faces if (f.index in s) != keep_in], context='FACES')
                bm.to_mesh(ob.data); bm.free()
            wheel_objs.append(n)

for o in list(objs):
    if not o.data.polygons:
        objs.remove(o); bpy.data.objects.remove(o, do_unlink=True)

# масштаб: по длине (или по базе, если колёса найдены и scaleBy=wheelbase)
wheels = []  # [(центр Vector, радиус, ширина, [(obj, polys)])]
def cluster_wheels(wobjs):
    parts = []
    for o in wobjs:
        me = o.data
        for polys in loose_parts(o):
            a, b = poly_bbox(me, polys)
            parts.append(((a + b) / 2, a, b, o, polys))
    if not parts:
        return []
    # кластер: сторона (знак X) × положение вдоль Y (разрыв > 0.35 м)
    out = []
    for side in (-1, 1):
        ps = sorted([p for p in parts if (p[0].x > 0) == (side > 0)], key=lambda p: p[0].y)
        cur = []
        for p in ps:
            if cur and p[0].y - cur[-1][0].y > 0.35:
                out.append(cur); cur = []
            cur.append(p)
        if cur:
            out.append(cur)
    res = []
    for cl in out:
        a = Vector((min(p[1][i] for p in cl) for i in range(3)))
        b = Vector((max(p[2][i] for p in cl) for i in range(3)))
        d = b - a
        if d.z < 0.15:   # мусор (болты, колпачки вне колеса)
            continue
        res.append(((a + b) / 2, max(d.y, d.z) / 2, d.x, cl))
    return res

wheels = cluster_wheels(wheel_objs)
log('wheel clusters', len(wheels), [tuple(round(x, 2) for x in w[0]) for w in wheels])
if wheel_objs and len(wheels) < 4:
    log('WARNING: колёс найдено', len(wheels), '— колёса остаются в кузове')
    objs.extend(wheel_objs); wheel_objs = []; wheels = []

scale = 1.0
if cfg.get('scaleBy') == 'wheelbase' and wheels and DIMS.get('wheelbase'):
    ys = sorted(w[0].y for w in wheels)
    scale = DIMS['wheelbase'] / (ys[-1] - ys[0])
elif DIMS.get('length'):
    allo = objs + wheel_objs
    l2, h2 = bbox_of(allo)
    scale = DIMS['length'] / (h2.y - l2.y)
scale *= float(cfg.get('scaleMul', 1.0))
log('scale', round(scale, 4))
S = Matrix.Scale(scale, 4)
for o in objs + wheel_objs:
    o.data.transform(S)
wheels = cluster_wheels(wheel_objs) if wheel_objs else []

# начало координат: X — центр, Y — середина между осями, Z — земля (низ колёс)
lo, hi = bbox_of(objs + wheel_objs)
if wheels:
    ys = [w[0].y for w in wheels]
    cy = (min(ys) + max(ys)) / 2
    gz = min(w[0].z - w[1] for w in wheels)
else:
    cy = (lo.y + hi.y) / 2
    gz = lo.z
cx = (lo.x + hi.x) / 2
T = Matrix.Translation((-cx, -cy, -gz - float(cfg.get('dropZ', 0.0))))
for o in objs + wheel_objs:
    o.data.transform(T)
wheels = cluster_wheels(wheel_objs) if wheel_objs else []
lo, hi = bbox_of(objs + wheel_objs)
log('dims', [round(x, 3) for x in (hi - lo)])

# ---------------------------------------------------------------- кузов: одно тело
def join(obs, name):
    obs = [o for o in obs if o.data.polygons]
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    if len(obs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name; o.data.name = name
    return o

def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)

body = join(objs, 'body')
MERGE = float(cfg.get('mergeDistance', 0.0005))
def clean(o):
    bm = bmesh.new(); bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=MERGE)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=MERGE * 0.5)
    bm.to_mesh(o.data); bm.free()
clean(body)

wheel_tpl = None
wheel_pos = []
if wheels:
    # шаблон: правое заднее колесо (не повёрнуто рулём)
    rr = max([w for w in wheels if w[0].x > 0], key=lambda w: -w[0].y)
    polys_by_obj = {}
    for (_, _, _, o, polys) in rr[3]:
        polys_by_obj.setdefault(o.name, set()).update(polys)
    pieces = []
    for oname, ps in polys_by_obj.items():
        o = bpy.data.objects[oname]
        n = o.copy(); n.data = o.data.copy(); bpy.context.scene.collection.objects.link(n)
        bm = bmesh.new(); bm.from_mesh(n.data); bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in ps], context='FACES')
        bm.to_mesh(n.data); bm.free()
        pieces.append(n)
    wheel_tpl = join(pieces, 'wheel')
    c = rr[0]
    wheel_tpl.data.transform(Matrix.Translation(-c))
    clean(wheel_tpl)
    for w in wheels:
        wheel_pos.append((w[0].x, w[0].y, w[0].z, w[1], w[2]))
    for o in wheel_objs:
        bpy.data.objects.remove(o, do_unlink=True)
    # радиус/ширина — по шаблону
    wl, wh = bbox_of([wheel_tpl])
    WR = max(wh.y - wl.y, wh.z - wl.z) / 2
    WW = wh.x - wl.x
    log('wheels', len(wheel_pos), 'R', round(WR, 3), 'W', round(WW, 3))

# ---------------------------------------------------------------- децимация
def decimate(o, target):
    for _ in range(4):  # collapse не всегда добирает до цели за проход (границы, швы UV)
        t = tris(o)
        if t <= target * 1.05:
            return
        m = o.modifiers.new('dec', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'; m.ratio = max(target / t, 0.01); m.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=m.name)
        if tris(o) > t * 0.97:
            return

def smooth(o, deg):
    me = o.data
    for p in me.polygons:
        p.use_smooth = True
    try:
        me.set_sharp_from_angle(angle=math.radians(deg))
    except Exception as e:
        log('smooth', e)

body_target = BUDGET - (4 * min(WHEEL_BUDGET, tris(wheel_tpl)) if wheel_tpl else 0)
if wheel_tpl:
    decimate(wheel_tpl, WHEEL_BUDGET)
decimate(body, body_target)
smooth(body, float(cfg.get('smoothAngle', 40)))
if wheel_tpl:
    smooth(wheel_tpl, 50)
log('tris body', tris(body), 'wheel', tris(wheel_tpl) if wheel_tpl else 0)

# ---------------------------------------------------------------- запекание атласа
roles_used = {}
def prep_materials(o):
    for i, m in enumerate(o.data.materials):
        if m is None:
            m = bpy.data.materials.new('trim'); o.data.materials[i] = m
        r = role_of(m.name)
        if r == 'wheel':
            r = 'tire' if re.search(r'(?i)tire|tyre|шин|rubber|reifen', m.name) else 'rim'
        m['role'] = r
        if not m.node_tree:
            m.use_nodes = True
        nt = m.node_tree
        bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is None:
            continue
        def setin(name, val):
            s = bsdf.inputs.get(name)
            if s is None:
                return
            for l in list(s.links):
                nt.links.remove(l)
            s.default_value = val
        setin('Metallic', 0.0)
        setin('Transmission Weight', 0.0)
        setin('Coat Weight', 0.0)
        if r == 'paint' and not cfg.get('keepPaintTexture'):
            setin('Base Color', (1, 1, 1, 1))
        if r == 'glass':
            col = bsdf.inputs['Base Color']
            if not col.links:
                c = col.default_value
                # стекло тёмное: прозрачность игра не рисует
                k = 0.12
                col.default_value = (min(c[0], 1) * k + 0.02, min(c[1], 1) * k + 0.025, min(c[2], 1) * k + 0.03, 1)
        for nm, v in cfg.get('roleColors', {}).items():
            if nm == r:
                setin('Base Color', tuple(v) + (1,) if len(v) == 3 else tuple(v))

def bake(objs_to_bake, name):
    img = bpy.data.images.new(name, TEX, TEX, alpha=False)
    img.colorspace_settings.name = 'sRGB'
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 1
    sc.render.bake.margin = 6
    for o in objs_to_bake:
        me = o.data
        old = [uv.name for uv in me.uv_layers]
        uv = me.uv_layers.new(name='bake')
        me.uv_layers.active = uv
        # render-UV остаётся исходным (по нему читаются текстуры исходника)
        for u in me.uv_layers:
            u.active_render = (u.name == (old[0] if old else 'bake'))
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True); bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, area_weight=0.0)
        bpy.ops.object.mode_set(mode='OBJECT')
    # упаковать острова всех объектов в один атлас
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs_to_bake:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs_to_bake[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(margin=0.004, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    for o in objs_to_bake:
        for m in o.data.materials:
            nt = m.node_tree
            n = nt.nodes.new('ShaderNodeTexImage'); n.image = img; n.name = 'BAKE_TARGET'
            for x in nt.nodes:
                x.select = False
            n.select = True; nt.nodes.active = n
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, margin=6, use_clear=True)
    path = os.path.join(OUT, name + '.png')
    img.filepath_raw = path; img.file_format = 'PNG'; img.save()
    return img

ROLE_PBR = {  # (roughness, metallic) — игра всё равно задаёт свои по aPart; это для превью/других потребителей
    'paint': (0.35, 0.3), 'glass': (0.05, 0.0), 'chrome': (0.2, 1.0), 'rim': (0.4, 0.6), 'tire': (0.9, 0.0),
}

def finalize_materials(o, img):
    me = o.data
    by_role = {}
    for i, m in enumerate(list(me.materials)):
        r = m.get('role', 'trim')
        roles_used[r] = roles_used.get(r, 0) + 1
        if r not in by_role:
            fm = bpy.data.materials.get('final_' + r)
            if fm is None:
                fm = bpy.data.materials.new('final_' + r)
                fm.use_nodes = True
                nt = fm.node_tree
                b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
                t = nt.nodes.new('ShaderNodeTexImage'); t.image = img
                nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
                rr, mm = ROLE_PBR.get(r, (0.7, 0.0))
                b.inputs['Roughness'].default_value = rr; b.inputs['Metallic'].default_value = mm
            by_role[r] = fm
        me.materials[i] = by_role[r]
    # объединить слоты с одинаковым материалом
    names = []
    remap = {}
    for i, m in enumerate(me.materials):
        if m.name not in names:
            names.append(m.name)
        remap[i] = names.index(m.name)
    idx = [remap[p.material_index] for p in me.polygons]
    mats = [bpy.data.materials[n] for n in names]
    me.materials.clear()   # сбрасывает material_index граней — переназначаем после
    for m in mats:
        me.materials.append(m)
    me.polygons.foreach_set('material_index', idx)
    me.update()
    # оставить только UV bake
    for u in list(me.uv_layers):
        if u.name != 'bake':
            me.uv_layers.remove(u)
    me.uv_layers[0].name = 'UVMap'

bake_objs = [body] + ([wheel_tpl] if wheel_tpl else [])
for o in bake_objs:
    prep_materials(o)
img = bake(bake_objs, ID + '_albedo')
for o in bake_objs:
    finalize_materials(o, img)
for m in bpy.data.materials:
    if m.name.startswith('final_'):
        m.name = m.name[6:]

# ---------------------------------------------------------------- экспорт LOD0
def export(obs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
                              export_texcoords=True, export_normals=True, export_materials='EXPORT', export_animations=False,
                              export_image_format='AUTO', export_extras=False, export_cameras=False, export_lights=False)

export(bake_objs, os.path.join(OUT, ID + '_raw.glb'))

# ---------------------------------------------------------------- LOD1: воксельная оболочка → децимация → запекание с LOD0
# (прямая децимация «рваных» исходников до 1–3k даёт мусор; воксельный ремеш даёт замкнутую сетку, которая хорошо упрощается)
from mathutils.bvhtree import BVHTree
parts = []
b1 = body.copy(); b1.data = body.data.copy(); bpy.context.scene.collection.objects.link(b1); parts.append(b1)
if wheel_tpl:
    for (x, y, z, r, w) in wheel_pos:
        n = wheel_tpl.copy(); n.data = wheel_tpl.data.copy(); bpy.context.scene.collection.objects.link(n)
        M = Matrix.Translation((x, y, z))
        if x < 0:
            M = M @ Matrix.Rotation(math.pi, 4, 'Z')
        n.data.transform(M)
        parts.append(n)
lsrc = join(parts, 'lod_src')
# выпуклая оболочка → равномерная сетка (воксели) → притянуть к поверхности (shrinkwrap) → децимация
hm = bpy.data.meshes.new('lod1')
bm = bmesh.new()
for v in lsrc.data.vertices:
    bm.verts.new(v.co)
bmesh.ops.convex_hull(bm, input=bm.verts[:])
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
bm.to_mesh(hm); bm.free()
lod1 = bpy.data.objects.new('lod1', hm); bpy.context.scene.collection.objects.link(lod1)
L = max(hi.y - lo.y, 1.0)
bpy.context.view_layer.objects.active = lod1
rm = lod1.modifiers.new('rm', 'REMESH'); rm.mode = 'VOXEL'; rm.voxel_size = float(cfg.get('lod1Voxel', L / 50)); rm.adaptivity = 0.0
bpy.ops.object.modifier_apply(modifier='rm')
for it in range(2):
    sw = lod1.modifiers.new('sw', 'SHRINKWRAP'); sw.target = lsrc; sw.wrap_method = 'NEAREST_SURFACEPOINT'
    bpy.ops.object.modifier_apply(modifier='sw')
    if it == 0:
        sm = lod1.modifiers.new('sm', 'SMOOTH'); sm.factor = 0.5; sm.iterations = 2
        bpy.ops.object.modifier_apply(modifier='sm')
lod1.data.materials.clear()
for m in lsrc.data.materials:
    lod1.data.materials.append(m)
decimate(lod1, LOD1_BUDGET)
for p in lod1.data.polygons:
    p.use_smooth = True
lod1.data.set_sharp_from_angle(angle=math.radians(45))
# роли граней — от ближайшей грани исходника
dg = bpy.context.evaluated_depsgraph_get()
bvh = BVHTree.FromObject(lsrc, dg)
src_mi = [p.material_index for p in lsrc.data.polygons]
for p in lod1.data.polygons:
    hit = bvh.find_nearest(p.center)
    p.material_index = src_mi[hit[2]] if hit and hit[2] is not None else 0
# UV + запекание selected-to-active
for u in list(lod1.data.uv_layers):
    lod1.data.uv_layers.remove(u)
lod1.data.uv_layers.new(name='UVMap')
bpy.ops.object.select_all(action='DESELECT'); lod1.select_set(True); bpy.context.view_layer.objects.active = lod1
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.01)
bpy.ops.object.mode_set(mode='OBJECT')
T1 = int(cfg.get('lod1TexSize', 256))
img1 = bpy.data.images.new(ID + '_lod1_albedo', T1, T1, alpha=False)
mats1 = []
for m in lsrc.data.materials:
    nt = m.node_tree
    n = nt.nodes.new('ShaderNodeTexImage'); n.image = img1; n.name = 'LOD1_TARGET'
    for x in nt.nodes:
        x.select = False
    n.select = True; nt.nodes.active = n
lsrc.select_set(True); lod1.select_set(True); bpy.context.view_layer.objects.active = lod1
bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, margin=4, use_clear=True, use_selected_to_active=True,
                    cage_extrusion=0.06, max_ray_distance=0.3)
img1.filepath_raw = os.path.join(OUT, ID + '_lod1_albedo.png'); img1.file_format = 'PNG'; img1.save()
# материалы LOD1: те же роли, своя текстура
for i, m in enumerate(list(lod1.data.materials)):
    m1 = m.copy()
    nt = m1.node_tree
    for n in list(nt.nodes):
        if n.name == 'LOD1_TARGET':
            nt.nodes.remove(n)
    tex = next(n for n in nt.nodes if n.type == 'TEX_IMAGE')
    tex.image = img1
    lod1.data.materials[i] = m1
bpy.data.objects.remove(lsrc, do_unlink=True)
# имена: LOD1 экспортируется отдельно — переименовать материалы LOD0 на время экспорта
for m in body.data.materials:
    m.name = 'lod0_' + m.name
for m in lod1.data.materials:
    m.name = m.name.split('.')[0]
body.name = 'body_lod0'; lod1.name = 'body'
export([lod1], os.path.join(OUT, ID + '_lod1_raw.glb'))
body.name = 'body'

# ---------------------------------------------------------------- фрагмент манифеста (координаты glTF: x, y=up, z=-Y)
lo, hi = bbox_of([body])
frag = {
    'id': ID,
    'dims': {'length': round(hi.y - lo.y, 3), 'width': round(hi.x - lo.x, 3), 'height': round(hi.z, 3)},
    'bodyCenterZ': round(-(lo.y + hi.y) / 2, 3),
    'tris': {'body': tris(body), 'wheel': tris(wheel_tpl) if wheel_tpl else 0, 'lod1': tris(lod1)},
    'roles': sorted(roles_used.keys()),
}
frag['tris']['lod0'] = frag['tris']['body'] + 4 * frag['tris']['wheel']
if wheel_pos:
    frag['wheels'] = [[round(x, 4), round(z, 4), round(-y, 4)] for (x, y, z, r, w) in wheel_pos]
    frag['wheelRadius'] = round(WR, 4)
    frag['wheelWidth'] = round(WW, 4)
    ys = sorted(set(round(w[1], 2) for w in wheel_pos))
    frag['wheelbase'] = round(ys[-1] - ys[0], 3)
    xs = [w[0] for w in wheel_pos]
    frag['track'] = round(max(xs) - min(xs), 3)
json.dump(frag, open(os.path.join(OUT, ID + '.json'), 'w'), indent=1, ensure_ascii=False)
log('done', json.dumps(frag, ensure_ascii=False))
