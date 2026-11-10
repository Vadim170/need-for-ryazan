# Библиотека процедурного моделирования hero-объектов (docs/stage2/landmarks.md). Запускается внутри Blender 5.2.
#
# Конвенция модели (как у машин и пропсов): Blender Z вверх; в glTF (export_yup) это +Y вверх, перёд модели −Z glTF
# = +Y Blender. Начало координат — уровень земли у «якоря» (центр футпринта), метры, реальный масштаб.
#
# Геометрия копится в Mesh (списки вершин/граней с индексом материала) и превращается в объект Blender одним вызовом.
# Материалы — процедурные (ноды Cycles в мировых координатах), запекаются в общий атлас: albedo (с AO) + emissive (ночь).
import bpy, bmesh, math, os, json
import numpy as np
from mathutils import Vector, Matrix
from mathutils.geometry import tessellate_polygon

FONT_SERIF = '/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf'
FONT_SANS = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'


def log(*a):
    print('[landmark]', *a, flush=True)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.curves, bpy.data.metaballs):
        for x in list(c):
            c.remove(x)


# ------------------------------------------------------------------ материалы
MATS = {}   # имя -> (bpy material, role)

ROLE_PBR = {   # итоговые материалы glTF: (roughness, metallic). Цвет — из атласа.
    'opaque': (0.85, 0.0),
    'stone': (0.55, 0.0),
    'glass': (0.08, 0.6),
    'metal': (0.38, 0.75),
    'bronze': (0.42, 0.85),
}


def _nodes(m):
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    return nt, bsdf


def material(name, color, role='opaque', kind='plain', var=0.08, scale=1.0, emit=None, wash=None, extra=None):
    """Процедурный материал.
    color — sRGB (0..1); kind: plain | stucco | granite | seams (металл с фальцами вдоль X) | radial (купол: фальцы по углу)
    | glass | bronze | paving | panel (швы облицовочных панелей) | flowers;
    var — амплитуда шума яркости; emit — (r, g, b, strength) свечение ночью (окна, плафоны);
    wash — (strength, z0, L): ночная подсветка прожекторами = цвет × strength × (0.3 + 0.7·exp(−(z−z0)/L))."""
    if name in MATS:
        return name
    m = bpy.data.materials.new(name)
    nt, bsdf = _nodes(m)
    L = nt.links
    lin = [c ** 2.2 for c in color]
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    pos = geo.outputs['Position']
    rgb = nt.nodes.new('ShaderNodeRGB'); rgb.outputs[0].default_value = (*lin, 1)
    col_out = rgb.outputs[0]

    def noise(sc, detail=4.0, src=None, dist=0.0):
        n = nt.nodes.new('ShaderNodeTexNoise'); n.noise_dimensions = '3D'
        n.inputs['Scale'].default_value = sc; n.inputs['Detail'].default_value = detail
        n.inputs['Distortion'].default_value = dist
        L.new(src if src is not None else pos, n.inputs['Vector'])
        return n.outputs['Fac']

    def mul_col(c, f, amt):
        # c * (1 + amt * (f - 0.5) * 2)
        mr = nt.nodes.new('ShaderNodeMapRange')
        mr.inputs['From Min'].default_value = 0.0; mr.inputs['From Max'].default_value = 1.0
        mr.inputs['To Min'].default_value = 1 - amt; mr.inputs['To Max'].default_value = 1 + amt
        L.new(f, mr.inputs['Value'])
        mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'
        mx.inputs['Factor'].default_value = 1.0
        L.new(c, mx.inputs['A'])
        cm = nt.nodes.new('ShaderNodeCombineColor')
        for k in ('Red', 'Green', 'Blue'):
            L.new(mr.outputs['Result'], cm.inputs[k])
        L.new(cm.outputs['Color'], mx.inputs['B'])
        return mx.outputs['Result']

    def scaled_pos(sx, sy, sz):
        vm = nt.nodes.new('ShaderNodeVectorMath'); vm.operation = 'MULTIPLY'
        vm.inputs[1].default_value = (sx, sy, sz)
        L.new(pos, vm.inputs[0])
        return vm.outputs['Vector']

    if kind in ('stucco', 'plain', 'panel', 'paving'):
        col_out = mul_col(col_out, noise(0.35 * scale), var)
        col_out = mul_col(col_out, noise(4.0 * scale, 2.0), var * 0.5)
        if kind == 'stucco':   # потёки: шум, вытянутый по вертикали
            col_out = mul_col(col_out, noise(1.0, 3.0, scaled_pos(1.5, 1.5, 0.12)), var * 0.8)
        if kind == 'panel':    # швы облицовки 1.5 × 1.2 м
            for axis, step in ((0, 1.5), (1, 1.5), (2, 1.2)):
                sep = nt.nodes.new('ShaderNodeSeparateXYZ'); L.new(pos, sep.inputs[0])
                wv = nt.nodes.new('ShaderNodeMath'); wv.operation = 'PINGPONG'; wv.inputs[1].default_value = step / 2
                L.new(sep.outputs[axis], wv.inputs[0])
                st = nt.nodes.new('ShaderNodeMath'); st.operation = 'GREATER_THAN'; st.inputs[1].default_value = 0.025
                L.new(wv.outputs[0], st.inputs[0])
                mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs['To Min'].default_value = 0.72; mr.inputs['To Max'].default_value = 1.0
                L.new(st.outputs[0], mr.inputs['Value'])
                mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs['Factor'].default_value = 1.0
                L.new(col_out, mx.inputs['A'])
                cm = nt.nodes.new('ShaderNodeCombineColor')
                for k in ('Red', 'Green', 'Blue'):
                    L.new(mr.outputs['Result'], cm.inputs[k])
                L.new(cm.outputs['Color'], mx.inputs['B'])
                col_out = mx.outputs['Result']
        if kind == 'paving':   # плитка 0.5 м
            bt = nt.nodes.new('ShaderNodeTexBrick'); bt.inputs['Scale'].default_value = 1.0
            bt.inputs['Mortar Size'].default_value = 0.012; bt.inputs['Brick Width'].default_value = 0.5; bt.inputs['Row Height'].default_value = 0.5
            bt.inputs['Color1'].default_value = (*lin, 1); bt.inputs['Color2'].default_value = tuple(c * 0.88 for c in lin) + (1,)
            bt.inputs['Mortar'].default_value = tuple(c * 0.6 for c in lin) + (1,)
            L.new(pos, bt.inputs['Vector'])
            col_out = mul_col(bt.outputs['Color'], noise(0.6), var)
    elif kind == 'granite':
        col_out = mul_col(col_out, noise(9.0 * scale, 1.0), var * 1.6)
        col_out = mul_col(col_out, noise(0.5 * scale, 3.0), var)
    elif kind in ('seams', 'radial'):
        if kind == 'seams':
            sep = nt.nodes.new('ShaderNodeSeparateXYZ'); L.new(pos, sep.inputs[0])
            coord = sep.outputs[(extra or {}).get('axis', 0)]
            step = (extra or {}).get('step', 0.6)
        else:
            sep = nt.nodes.new('ShaderNodeSeparateXYZ'); L.new(pos, sep.inputs[0])
            at = nt.nodes.new('ShaderNodeMath'); at.operation = 'ARCTAN2'
            L.new(sep.outputs['Y'], at.inputs[0]); L.new(sep.outputs['X'], at.inputs[1])
            ml = nt.nodes.new('ShaderNodeMath'); ml.operation = 'MULTIPLY'; ml.inputs[1].default_value = (extra or {}).get('radius', 20.0)
            L.new(at.outputs[0], ml.inputs[0])
            coord = ml.outputs[0]
            step = (extra or {}).get('step', 0.9)
        wv = nt.nodes.new('ShaderNodeMath'); wv.operation = 'PINGPONG'; wv.inputs[1].default_value = step / 2
        L.new(coord, wv.inputs[0])
        st = nt.nodes.new('ShaderNodeMath'); st.operation = 'SMOOTH_MIN'; st.inputs[1].default_value = 0.05; st.inputs[2].default_value = 0.03
        L.new(wv.outputs[0], st.inputs[0])
        mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs['From Max'].default_value = 0.05
        mr.inputs['To Min'].default_value = 0.78; mr.inputs['To Max'].default_value = 1.0
        L.new(st.outputs[0], mr.inputs['Value'])
        mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs['Factor'].default_value = 1.0
        L.new(col_out, mx.inputs['A'])
        cm = nt.nodes.new('ShaderNodeCombineColor')
        for k in ('Red', 'Green', 'Blue'):
            L.new(mr.outputs['Result'], cm.inputs[k])
        L.new(cm.outputs['Color'], mx.inputs['B'])
        col_out = mul_col(mx.outputs['Result'], noise(0.25), var)
    elif kind == 'glass':
        sep = nt.nodes.new('ShaderNodeSeparateXYZ'); L.new(pos, sep.inputs[0])
        col_out = mul_col(col_out, noise(0.8, 2.0), var)
    elif kind == 'bronze':
        # патина: зеленоватые пятна + светлые грани (pointiness — только Cycles, при запекании работает)
        pat = (0.26 ** 2.2, 0.33 ** 2.2, 0.27 ** 2.2)
        f = noise(1.6, 6.0, None, 0.4)
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].position = 0.45; ramp.color_ramp.elements[0].color = (*lin, 1)
        ramp.color_ramp.elements[1].position = 0.72; ramp.color_ramp.elements[1].color = (*pat, 1)
        L.new(f, ramp.inputs['Fac'])
        pt = geo.outputs['Pointiness']
        mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs['From Min'].default_value = 0.45; mr.inputs['From Max'].default_value = 0.6
        mr.inputs['To Min'].default_value = 0.75; mr.inputs['To Max'].default_value = 1.35
        L.new(pt, mr.inputs['Value'])
        mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs['Factor'].default_value = 1.0
        L.new(ramp.outputs['Color'], mx.inputs['A'])
        cm = nt.nodes.new('ShaderNodeCombineColor')
        for k in ('Red', 'Green', 'Blue'):
            L.new(mr.outputs['Result'], cm.inputs[k])
        L.new(cm.outputs['Color'], mx.inputs['B'])
        col_out = mx.outputs['Result']
    elif kind == 'poster':   # афиша: градиент синий–фиолетовый–красный по X + пятна
        sep = nt.nodes.new('ShaderNodeSeparateXYZ'); L.new(pos, sep.inputs[0])
        mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs['From Min'].default_value = -12.0; mr.inputs['From Max'].default_value = 12.0
        L.new(sep.outputs['X'], mr.inputs['Value'])
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        cr = ramp.color_ramp
        stops = [(0.0, (0.05, 0.08, 0.45)), (0.25, (0.35, 0.05, 0.4)), (0.5, (0.75, 0.06, 0.12)), (0.75, (0.35, 0.05, 0.4)), (1.0, (0.05, 0.08, 0.45))]
        cr.elements[0].position = stops[0][0]; cr.elements[0].color = (*stops[0][1], 1)
        cr.elements[1].position = stops[-1][0]; cr.elements[1].color = (*stops[-1][1], 1)
        for t, c in stops[1:-1]:
            e = cr.elements.new(t); e.color = (*c, 1)
        L.new(mr.outputs['Result'], ramp.inputs['Fac'])
        col_out = mul_col(ramp.outputs['Color'], noise(1.5, 3.0), 0.35)
    elif kind == 'flowers':
        f = noise(6.0, 2.0)
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].position = 0.42; ramp.color_ramp.elements[0].color = (0.04, 0.12, 0.02, 1)
        ramp.color_ramp.elements[1].position = 0.5; ramp.color_ramp.elements[1].color = (*lin, 1)
        L.new(f, ramp.inputs['Fac'])
        col_out = ramp.outputs['Color']
    L.new(col_out, bsdf.inputs['Base Color'])
    rr, mm = ROLE_PBR.get(role, (0.8, 0.0))
    bsdf.inputs['Roughness'].default_value = rr
    bsdf.inputs['Metallic'].default_value = 0.0   # для запекания цвета металлик не нужен
    # свечение (запекается отдельно, тип EMIT)
    if emit is not None:
        bsdf.inputs['Emission Color'].default_value = (*[c ** 2.2 for c in emit[:3]], 1)
        bsdf.inputs['Emission Strength'].default_value = emit[3]
    elif wash is not None:
        s, z0, Lw = wash
        sep = nt.nodes.new('ShaderNodeSeparateXYZ'); L.new(pos, sep.inputs[0])
        a = nt.nodes.new('ShaderNodeMath'); a.operation = 'SUBTRACT'; a.inputs[1].default_value = z0
        L.new(sep.outputs['Z'], a.inputs[0])
        b = nt.nodes.new('ShaderNodeMath'); b.operation = 'DIVIDE'; b.inputs[1].default_value = -Lw
        L.new(a.outputs[0], b.inputs[0])
        e = nt.nodes.new('ShaderNodeMath'); e.operation = 'EXPONENT'
        L.new(b.outputs[0], e.inputs[0])
        c = nt.nodes.new('ShaderNodeMath'); c.operation = 'MULTIPLY_ADD'; c.inputs[1].default_value = 0.7 * s; c.inputs[2].default_value = 0.3 * s
        L.new(e.outputs[0], c.inputs[0])
        cl = nt.nodes.new('ShaderNodeClamp'); cl.inputs['Max'].default_value = 1.0
        L.new(c.outputs[0], cl.inputs['Value'])
        mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs['Factor'].default_value = 1.0
        L.new(col_out, mx.inputs['A'])
        warm = nt.nodes.new('ShaderNodeMix'); warm.data_type = 'RGBA'; warm.blend_type = 'MULTIPLY'; warm.inputs['Factor'].default_value = 1.0
        warm.inputs['A'].default_value = (1.0, 0.86, 0.62, 1)
        cm = nt.nodes.new('ShaderNodeCombineColor')
        for k in ('Red', 'Green', 'Blue'):
            L.new(cl.outputs['Result'], cm.inputs[k])
        L.new(cm.outputs['Color'], warm.inputs['B'])
        L.new(warm.outputs['Result'], mx.inputs['B'])
        L.new(mx.outputs['Result'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = 1.0
    MATS[name] = (m, role, {'color': color, 'emit': emit, 'wash': wash})
    return name


# ------------------------------------------------------------------ сборка геометрии
class Mesh:
    """Накопитель геометрии. Грани — списки индексов вершин; mat — имя материала; smooth — гладкая нормаль."""

    def __init__(self, name, uvk=1.0, palette=False):
        """uvk — вес плотности текстуры (крыши 0.3–0.5, скрытое 0.1); palette — мелкие повторяющиеся детали (наличники,
        капители, переплёты): без своих островов в атласе, все грани материала смотрят в одну клетку-палитру."""
        self.name, self.uvk, self.palette = name, uvk, palette
        self.v, self.f, self.fm, self.fs = [], [], [], []
        self.mats = []

    def _mi(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def add(self, verts, faces, mat, smooth=False, M=None):
        o = len(self.v)
        if M is not None:
            verts = [tuple(M @ Vector(p)) for p in verts]
        self.v += [tuple(p) for p in verts]
        mi = self._mi(mat)
        for fc in faces:
            self.f.append([o + i for i in fc]); self.fm.append(mi); self.fs.append(smooth)
        return o

    # --- примитивы
    def box(self, c, s, mat, M=None, skip=()):
        """Коробка с центром c и размерами s; skip — какие грани не строить: 'b' низ, 't' верх, 'x-','x+','y-','y+'."""
        cx, cy, cz = c; sx, sy, sz = (s[0] / 2, s[1] / 2, s[2] / 2)
        v = [(cx - sx, cy - sy, cz - sz), (cx + sx, cy - sy, cz - sz), (cx + sx, cy + sy, cz - sz), (cx - sx, cy + sy, cz - sz),
             (cx - sx, cy - sy, cz + sz), (cx + sx, cy - sy, cz + sz), (cx + sx, cy + sy, cz + sz), (cx - sx, cy + sy, cz + sz)]
        F = {'b': (0, 3, 2, 1), 't': (4, 5, 6, 7), 'y-': (0, 1, 5, 4), 'x+': (1, 2, 6, 5), 'y+': (2, 3, 7, 6), 'x-': (3, 0, 4, 7)}
        return self.add(v, [f for k, f in F.items() if k not in skip], mat, False, M)

    def box2(self, a, b, mat, M=None, skip=()):
        """Коробка по двум углам."""
        return self.box(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2),
                        (abs(b[0] - a[0]), abs(b[1] - a[1]), abs(b[2] - a[2])), mat, M, skip)

    def lathe(self, prof, n, mat, M=None, a0=0.0, a1=2 * math.pi, cap0=False, cap1=False, smooth=True):
        """Тело вращения вокруг Z: prof — [(r, z)] снизу вверх."""
        full = abs(a1 - a0 - 2 * math.pi) < 1e-6
        na = n if full else n + 1
        v = []
        for r, z in prof:
            for k in range(na):
                a = a0 + (a1 - a0) * k / n
                v.append((r * math.cos(a), r * math.sin(a), z))
        faces = []
        for i in range(len(prof) - 1):
            for k in range(n):
                k2 = (k + 1) % na if full else k + 1
                faces.append([i * na + k, i * na + k2, (i + 1) * na + k2, (i + 1) * na + k])
        o = self.add(v, faces, mat, smooth, M)
        if cap0 and prof[0][0] > 1e-6:
            self.add([v[k] for k in range(na)][::-1], [list(range(na))], mat, False, M)
        if cap1 and prof[-1][0] > 1e-6:
            last = (len(prof) - 1) * na
            self.add([v[last + k] for k in range(na)], [list(range(na))], mat, False, M)
        return o

    def cyl(self, c, r, h, n, mat, M=None, r2=None, cap0=False, cap1=True, smooth=True):
        T = Matrix.Translation(c)
        return self.lathe([(r, 0), (r2 if r2 is not None else r, h)], n, mat, (M @ T) if M is not None else T, cap0=cap0, cap1=cap1, smooth=smooth)

    def prism(self, poly, z0, z1, mat, M=None, cap0=False, cap1=True, side_mat=None, smooth=False):
        """Вертикальная призма по многоугольнику [(x, y)] (против часовой — наружу нормали стен)."""
        n = len(poly)
        v = [(x, y, z0) for x, y in poly] + [(x, y, z1) for x, y in poly]
        faces = [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
        self.add(v, faces, side_mat or mat, smooth, M)
        tris = [list(t) for t in tessellate_polygon([[Vector((x, y, 0)) for x, y in poly]])]
        for t in tris:   # верхняя крышка — нормалью вверх
            (ax, ay), (bx, by), (cx, cy) = poly[t[0]], poly[t[1]], poly[t[2]]
            if (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0:
                t.reverse()
        if cap1:
            self.add([(x, y, z1) for x, y in poly], [list(t) for t in tris], mat, False, M)
        if cap0:
            self.add([(x, y, z0) for x, y in poly], [list(t)[::-1] for t in tris], mat, False, M)

    def sweep(self, prof, path, mat, closed=True, M=None, smooth=False):
        """Протягивание профиля [(o, z)] (o — вынос наружу от линии пути) вдоль полилинии path [(x, y)] (против часовой —
        «наружу» = вправо от направления). Углы — с митрой."""
        P = [Vector((x, y)) for x, y in path]
        n = len(P)
        if closed and (P[0] - P[-1]).length < 1e-6:
            P = P[:-1]; n -= 1
        rows = []
        for i in range(n):
            if closed:
                a, b, c = P[i - 1], P[i], P[(i + 1) % n]
            else:
                a = P[i - 1] if i > 0 else P[i] - (P[i + 1] - P[i])
                b = P[i]
                c = P[i + 1] if i < n - 1 else P[i] + (P[i] - P[i - 1])
            d1 = (b - a).normalized(); d2 = (c - b).normalized()
            n1 = Vector((d1.y, -d1.x)); n2 = Vector((d2.y, -d2.x))
            nm = (n1 + n2)
            nm = nm.normalized() if nm.length > 1e-6 else n1
            k = 1.0 / max(nm.dot(n1), 0.3)
            rows.append([(b.x + nm.x * o * k, b.y + nm.y * o * k, z) for o, z in prof])
        m = len(prof)
        v = [p for r in rows for p in r]
        faces = []
        segs = n if closed else n - 1
        for i in range(segs):
            j = (i + 1) % n
            for k in range(m - 1):
                faces.append([i * m + k, j * m + k, j * m + k + 1, i * m + k + 1])
        self.add(v, faces, mat, smooth, M)
        if not closed:   # торцы
            for i, rev in ((0, True), (n - 1, False)):
                ring = [rows[i][k] for k in range(m)]
                if len(ring) >= 3:
                    tris = tessellate_polygon([[Vector((math.hypot(p[0] - rows[i][0][0], p[1] - rows[i][0][1]), p[2], 0)) for p in ring]])
                    self.add(ring, [list(t)[::-1] if rev else list(t) for t in tris], mat, False, M)

    def quad(self, a, b, c, d, mat, M=None):
        return self.add([a, b, c, d], [[0, 1, 2, 3]], mat, False, M)

    def tri_fan(self, pts, mat, M=None):
        return self.add(pts, [list(range(len(pts)))], mat, False, M)

    def from_object_mesh(self, me, mat, M=None, smooth=True):
        """Добавить меш Blender (например, текст или метаболлы)."""
        v = [tuple(x.co) for x in me.vertices]
        faces = [list(p.vertices) for p in me.polygons]
        return self.add(v, faces, mat, smooth, M)

    def to_object(self):
        me = bpy.data.meshes.new(self.name)
        me.from_pydata(self.v, [], self.f)
        for mn in self.mats:
            me.materials.append(MATS[mn][0])
        me.polygons.foreach_set('material_index', self.fm)
        me.polygons.foreach_set('use_smooth', self.fs)
        me.validate(clean_customdata=False)
        me.update()
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(ob)
        ob['uvk'] = self.uvk
        ob['palette'] = int(self.palette)
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
        bm.to_mesh(me); bm.free()
        return ob

    @property
    def tris(self):
        return sum(len(f) - 2 for f in self.f)


def text_mesh(s, font=FONT_SERIF, size=1.0, extrude=0.04, align='CENTER', spacing=1.0):
    """Меш текста в плоскости XY (буквы читаются вдоль +X, верх +Y, толщина вдоль +Z, низ строки y=0)."""
    cu = bpy.data.curves.new('txt', 'FONT')
    cu.body = s
    cu.font = bpy.data.fonts.load(font, check_existing=True)
    cu.size = size; cu.extrude = extrude; cu.align_x = align; cu.space_character = spacing
    cu.resolution_u = 3; cu.fill_mode = 'BOTH'
    ob = bpy.data.objects.new('txt', cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob); bpy.data.curves.remove(cu)
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1), verts=bm.verts, edges=bm.edges)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    return me


def metaball_mesh(elements, resolution=0.08, threshold=0.6, decimate=None, smooth_iter=0):
    """Метаболлы → меш. elements: [(type, co, radius, size_xyz | None, rot_quat | None)]."""
    mb = bpy.data.metaballs.new('mb')
    mb.resolution = resolution; mb.render_resolution = resolution; mb.threshold = threshold
    for t, co, r, sz, q in elements:
        e = mb.elements.new(type=t)
        e.co = co; e.radius = r
        if sz is not None:
            e.size_x, e.size_y, e.size_z = sz
        if q is not None:
            e.rotation = q
    ob = bpy.data.objects.new('mb', mb)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob); bpy.data.metaballs.remove(mb)
    tmp = bpy.data.objects.new('mbm', me)
    bpy.context.scene.collection.objects.link(tmp)
    bpy.context.view_layer.objects.active = tmp
    if smooth_iter:
        sm = tmp.modifiers.new('sm', 'SMOOTH'); sm.factor = 0.5; sm.iterations = smooth_iter
    if decimate:
        nt = sum(len(p.vertices) - 2 for p in me.polygons)
        if nt > decimate:
            d = tmp.modifiers.new('dec', 'DECIMATE'); d.ratio = decimate / nt
    dg = bpy.context.evaluated_depsgraph_get()
    me2 = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    bpy.data.objects.remove(tmp); bpy.data.meshes.remove(me)
    return me2


# ------------------------------------------------------------------ коллайдеры и метаданные
def colliders(boxes):
    """boxes: [(center (x, y, z), size (sx, sy, sz), rotZ рад | (rx, ry, rz))] в осях Blender. -> пустышка 'collider' с дочерними кубами."""
    root = bpy.data.objects.new('collider', None)
    bpy.context.scene.collection.objects.link(root)
    root['collider'] = 1
    root.hide_render = True
    me = bpy.data.meshes.new('collider_box')
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0); bm.to_mesh(me); bm.free()
    for i, (c, s, rz) in enumerate(boxes):
        ob = bpy.data.objects.new(f'collider_{i}', me)
        bpy.context.scene.collection.objects.link(ob)
        ob.location = c; ob.scale = s
        ob.rotation_euler = tuple(rz) if isinstance(rz, (tuple, list)) else (0, 0, rz)   # (rx, ry, rz) — наклонные плиты
        ob.parent = root
        ob['collider'] = 1
        ob.hide_render = True
    return root


# ------------------------------------------------------------------ UV, запекание, финальные материалы
def _uv_area_ratio(ob):
    me = ob.data
    uv = me.uv_layers.active.data
    a3 = a2 = 0.0
    for p in me.polygons:
        a3 += p.area
        pts = [uv[li].uv for li in p.loop_indices]
        s = 0.0
        for i in range(len(pts)):
            x1, y1 = pts[i]; x2, y2 = pts[(i + 1) % len(pts)]
            s += x1 * y2 - x2 * y1
        a2 += abs(s) / 2
    return a3, a2


PAL_ROWS = 2


def uv_atlas(objs, size, margin=0.002):
    """Smart UV по каждому объекту, выравнивание плотности (м² → UV) между объектами с весом uvk, общая упаковка.
    Нижняя полоса атласа (PAL_ROWS клеток по size/64 px) — палитра: грани объектов с palette=1 смотрят в центр клетки
    своего материала. -> {имя материала: (u0, v0, u1, v1) клетки}."""
    main = [o for o in objs if not o.get('palette')]
    pal = [o for o in objs if o.get('palette')]
    for ob in main:
        me = ob.data
        while me.uv_layers:
            me.uv_layers.remove(me.uv_layers[0])
        me.uv_layers.new(name='UVMap')
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True); bpy.context.view_layer.objects.active = ob
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=0.0, area_weight=0.0, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode='OBJECT')
    for ob in main:
        a3, a2 = _uv_area_ratio(ob)
        if a2 <= 0 or a3 <= 0:
            continue
        k = math.sqrt(a3 / a2) * 0.01 * float(ob.get('uvk', 1.0))
        uv = ob.data.uv_layers.active.data
        co = np.empty(len(uv) * 2, np.float32); uv.foreach_get('uv', co)
        uv.foreach_set('uv', co * k)
    if main:
        bpy.ops.object.select_all(action='DESELECT')
        for ob in main:
            ob.select_set(True)
        bpy.context.view_layer.objects.active = main[0]
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.select_all(action='SELECT')
        bpy.ops.uv.pack_islands(margin=margin, rotate=True, scale=True)
        bpy.ops.object.mode_set(mode='OBJECT')
    cell = 1.0 / 64
    strip = PAL_ROWS * cell
    for ob in main:   # освободить нижнюю полосу под палитру
        uv = ob.data.uv_layers.active.data
        co = np.empty(len(uv) * 2, np.float32); uv.foreach_get('uv', co)
        co = co.reshape(-1, 2)
        co[:, 1] = strip + co[:, 1] * (1 - strip)
        co[:, 0] = co[:, 0] * (1 - strip)
        uv.foreach_set('uv', co.ravel())
    cells = {}
    for ob in pal:
        me = ob.data
        while me.uv_layers:
            me.uv_layers.remove(me.uv_layers[0])
        me.uv_layers.new(name='UVMap')
        uv = me.uv_layers.active.data
        co = np.zeros((len(uv), 2), np.float32)
        for p in me.polygons:
            mn = me.materials[p.material_index].name
            if mn not in cells:
                i = len(cells)
                c0, r0 = i % 64, i // 64
                cells[mn] = (c0 * cell, r0 * cell, (c0 + 1) * cell, (r0 + 1) * cell)
            u0, v0, u1, v1 = cells[mn]
            cu, cv = (u0 + u1) / 2, (v0 + v1) / 2
            d = cell / 10
            for j, li in enumerate(p.loop_indices):
                a = 2 * math.pi * j / len(p.loop_indices)
                co[li] = (cu + d * math.cos(a), cv + d * math.sin(a))
        uv.foreach_set('uv', co.ravel())
    return cells


def _fill_cells(img, cells, kind):
    """Залить клетки палитры плоским цветом материала (albedo) или свечением (emit)."""
    if not cells:
        return
    W, H = img.size
    px = np.empty(W * H * 4, np.float32); img.pixels.foreach_get(px)
    px = px.reshape(H, W, 4)
    for mn, (u0, v0, u1, v1) in cells.items():
        info = MATS.get(mn, (None, None, {}))[2]
        col = info.get('color', (0.5, 0.5, 0.5))
        if kind == 'albedo':
            rgb = col
        else:
            e, w = info.get('emit'), info.get('wash')
            if e is not None:
                rgb = tuple(min(1.0, (c ** 2.2 * e[3]) ** (1 / 2.2)) for c in e[:3])
            elif w is not None:
                warm = (1.0, 0.86, 0.62)
                rgb = tuple(min(1.0, (c ** 2.2 * k * w[0] * 0.65) ** (1 / 2.2)) for c, k in zip(col, warm))
            else:
                rgb = (0.0, 0.0, 0.0)
        x0, x1 = int(round(u0 * W)), int(round(u1 * W))
        y0, y1 = int(round(v0 * H)), int(round(v1 * H))
        px[y0:y1, x0:x1, :3] = rgb
        px[y0:y1, x0:x1, 3] = 1.0
    img.pixels.foreach_set(px.ravel())


def bake(objs, size, out_dir, name, cells=None, ao_samples=24, ao_strength=0.65, ao_dist=2.5):
    """Запекание: albedo (цвет × AO) и emissive. -> (путь albedo, путь emissive | None)."""
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = 'GPU'
    except Exception as e:
        log('GPU недоступен, CPU:', e)
        sc.cycles.device = 'CPU'
    sc.render.bake.margin = 4
    imgs = {}

    def target(kind, srgb=True):
        img = bpy.data.images.new(f'{name}_{kind}', size, size, alpha=False, float_buffer=False)
        img.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
        for ob in objs:
            for m in ob.data.materials:
                nt = m.node_tree
                n = nt.nodes.get('BAKE_TARGET') or nt.nodes.new('ShaderNodeTexImage')
                n.name = 'BAKE_TARGET'; n.image = img
                for x in nt.nodes:
                    x.select = False
                n.select = True; nt.nodes.active = n
        imgs[kind] = img
        return img

    bpy.ops.object.select_all(action='DESELECT')
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    sc.cycles.samples = 1
    target('albedo')
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, margin=4, use_clear=True)
    target('emit')
    bpy.ops.object.bake(type='EMIT', margin=4, use_clear=True)
    sc.cycles.samples = ao_samples
    sc.world = sc.world or bpy.data.worlds.new('w')
    sc.world.light_settings.distance = ao_dist
    target('ao', srgb=False)
    bpy.ops.object.bake(type='AO', margin=4, use_clear=True)
    n = size * size * 4
    alb = np.empty(n, np.float32); imgs['albedo'].pixels.foreach_get(alb)
    ao = np.empty(n, np.float32); imgs['ao'].pixels.foreach_get(ao)
    f = (1 - ao_strength) + ao_strength * ao
    f = f ** (1 / 2.2)
    alb = alb.reshape(-1, 4); f = f.reshape(-1, 4)
    alb[:, :3] *= f[:, :1]
    imgs['albedo'].pixels.foreach_set(alb.ravel())
    _fill_cells(imgs['albedo'], cells, 'albedo')
    _fill_cells(imgs['emit'], cells, 'emit')
    paths = {}
    for kind in ('albedo', 'emit'):
        p = os.path.join(out_dir, f'{name}_{kind}.png')
        imgs[kind].filepath_raw = p; imgs[kind].file_format = 'PNG'; imgs[kind].save()
        paths[kind] = p
    em = np.empty(n, np.float32); imgs['emit'].pixels.foreach_get(em)
    has_emit = float(em.reshape(-1, 4)[:, :3].max()) > 0.01
    return imgs['albedo'], (imgs['emit'] if has_emit else None)


def finalize(objs, albedo, emit):
    """Заменить процедурные материалы на итоговые по ролям (общий атлас) и слить объекты в один."""
    final = {}

    def fmat(role):
        if role in final:
            return final[role]
        m = bpy.data.materials.new('lm_' + role)
        m.use_backface_culling = True
        nt, bsdf = _nodes(m)
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = albedo
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
        rr, mm = ROLE_PBR.get(role, (0.8, 0.0))
        bsdf.inputs['Roughness'].default_value = rr; bsdf.inputs['Metallic'].default_value = mm
        if emit is not None:
            te = nt.nodes.new('ShaderNodeTexImage'); te.image = emit
            nt.links.new(te.outputs['Color'], bsdf.inputs['Emission Color'])
            bsdf.inputs['Emission Strength'].default_value = 1.0
        final[role] = m
        return m

    for ob in objs:
        me = ob.data
        roles = [MATS[m.name][1] if m.name in MATS else 'opaque' for m in me.materials]
        uniq = sorted(set(roles))
        idx_map = [uniq.index(r) for r in roles]
        mi = np.empty(len(me.polygons), np.int32); me.polygons.foreach_get('material_index', mi)
        me.materials.clear()
        for r in uniq:
            me.materials.append(fmat(r))
        me.polygons.foreach_set('material_index', np.array(idx_map, np.int32)[mi] if len(mi) else mi)
        me.update()
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    # объединить одинаковые слоты
    me = ob.data
    names = []
    remap = []
    for m in me.materials:
        if m.name not in names:
            names.append(m.name)
        remap.append(names.index(m.name))
    mi = np.empty(len(me.polygons), np.int32); me.polygons.foreach_get('material_index', mi)
    mats = [bpy.data.materials[n] for n in names]
    me.materials.clear()
    for m in mats:
        me.materials.append(m)
    me.polygons.foreach_set('material_index', np.array(remap, np.int32)[mi])
    me.update()
    return ob


def export(path, objs, extras=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
        for c in o.children:
            c.select_set(True)
    if extras:
        for k, v in extras.items():
            objs[0][k] = v
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
                              export_texcoords=True, export_normals=True, export_materials='EXPORT', export_animations=False,
                              export_image_format='AUTO', export_extras=True, export_cameras=False, export_lights=False)


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def run(build, model_id, out_dir, lod, tex):
    """Общий цикл: build(lod) -> (meshes: [Mesh], boxes, info) ; UV, запекание, экспорт <id>[_lod1]_raw.glb."""
    reset_scene()
    MATS.clear()
    meshes, boxes, info = build(lod)
    objs = [m.to_object() for m in meshes if m.f]
    tris = sum(tri_count(o) for o in objs)
    log(f'{model_id} LOD{lod}: объектов {len(objs)}, треугольников {tris}')
    cells = uv_atlas(objs, tex)
    suffix = '' if lod == 0 else '_lod1'
    albedo, emit = bake(objs, tex, out_dir, model_id + suffix, cells)
    ob = finalize(objs, albedo, emit)
    ob.name = model_id + suffix
    root = colliders(boxes) if lod == 0 and boxes else None
    extras = {'nfr_landmark': json.dumps(dict(info, id=model_id, lod=lod, triangles=tris), ensure_ascii=False)}
    path = os.path.join(out_dir, f'{model_id}{suffix}_raw.glb')
    export(path, [ob] + ([root] if root else []), extras)
    log('записан', path)
    return dict(info, triangles=tris, tex=tex)


def sculpt_mesh(parts, voxel=0.02, smooth=4, target_tris=14000, scale=1.0, M=None):
    """«Лепка» из примитивов: части объединяются вокселями (Remesh), сглаживаются и прореживаются до target_tris.
    parts: ('ell', центр, (rx, ry, rz), Matrix3 | None) — эллипсоид; ('cap', p0, p1, r0, r1) — усечённая капсула;
    ('box', центр, (sx, sy, sz), Matrix3 | None). Координаты в масштабе «человека», scale — итоговый множитель."""
    bm = bmesh.new()
    for p in parts:
        if p[0] == 'ell':
            _, c, r, R = p
            T = Matrix.Translation(c) @ ((R.to_4x4()) if R is not None else Matrix.Identity(4)) @ Matrix.Diagonal((r[0], r[1], r[2], 1))
            bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=12, radius=1.0, matrix=T)
        elif p[0] == 'cap':
            _, a, b, r0, r1 = p
            a, b = Vector(a), Vector(b)
            d = b - a
            q = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
            T = Matrix.Translation((a + b) / 2) @ q
            bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=r0, radius2=r1, depth=d.length, matrix=T)
            bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=8, radius=r0, matrix=Matrix.Translation(a))
            bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=8, radius=r1, matrix=Matrix.Translation(b))
        elif p[0] == 'box':
            _, c, s, R = p
            T = Matrix.Translation(c) @ ((R.to_4x4()) if R is not None else Matrix.Identity(4)) @ Matrix.Diagonal((s[0], s[1], s[2], 1))
            bmesh.ops.create_cube(bm, size=1.0, matrix=T)
    me = bpy.data.meshes.new('sculpt')
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new('sculpt', me)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    rm = ob.modifiers.new('rm', 'REMESH'); rm.mode = 'VOXEL'; rm.voxel_size = voxel; rm.adaptivity = 0.0
    if smooth:
        sm = ob.modifiers.new('sm', 'SMOOTH'); sm.factor = 0.6; sm.iterations = smooth
    dg = bpy.context.evaluated_depsgraph_get()
    me2 = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    ob.modifiers.clear()
    ob.data = me2
    bpy.data.meshes.remove(me)
    nt = sum(len(p.vertices) - 2 for p in me2.polygons)
    if nt > target_tris:
        d = ob.modifiers.new('dec', 'DECIMATE'); d.ratio = target_tris / nt
        dg = bpy.context.evaluated_depsgraph_get()
        me3 = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        ob.modifiers.clear(); ob.data = me3
        bpy.data.meshes.remove(me2)
        me2 = me3
    me2.transform(Matrix.Diagonal((scale, scale, scale, 1)))
    if M is not None:
        me2.transform(M)
    bpy.data.objects.remove(ob)
    return me2
