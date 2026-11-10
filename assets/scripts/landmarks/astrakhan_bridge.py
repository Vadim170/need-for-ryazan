# Астраханский мост: ул. Ленина над Лыбедским бульваром, два сквозных пешеходных арочных прохода (реконструкция 2021 г.).
# Источники: панорамы Яндекса 2024-06 … 2026-03 (data/raw/panoramas/lybed/crops/astrakhan/: 04, 07 — фасад с арками с ЮЗ,
# 10, 12 — с СВ, 00–02, 05, 08 — парапет с проезжей части), OSM w993479901 / w993479903 (footway tunnel=yes).
# По фото: фасады — серые бетонные блоки ~0.6 × 0.3 м; арки пролётом ~6.4 м, стрела ~4 м (человек 1.8 м ≈ 0.45 высоты),
# обрамление — кольцо из светлого (кремового) кирпича; простенок между арками ~2 м; своды внутри — светлый гофрированный
# лист; парапет — кремовые кирпичные столбики ~0.55 м через ~3.6 м и чугунные панели с двумя розетками («цветки») между
# ними, внизу — кирпичный цоколь; карниз-поясок из того же кирпича под парапетом.
# Размещение и рельеф: pipeline/world/lybed.py (выемка heightmap под проходами), высоты дамбы до выемки —
# data/processed/lybed/astrakhan_heights.json (пишет сборка мира).
# Оси (Blender): X — вдоль ул. Ленина на ЮВ, Y — поперёк к цирку (СВ; перёд модели), Z вверх; начало — пол в центре
# между проходами (three.y = (FLOOR_SW + FLOOR_NE) / 2).
import json, math, os
from mathutils import Matrix, Vector
import bpy
import lmlib as L

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
HJ = json.load(open(os.path.join(ROOT, 'data', 'processed', 'lybed', 'astrakhan_heights.json'), encoding='utf8'))
INFO = {'name': 'Астраханский мост', 'osm': ['w993479901', 'w993479903']}

WALL_Y = HJ['wall_y']                 # плоскость фасадов
FSW, FNE = HJ['floor_sw'], HJ['floor_ne']
Y0 = (FSW + FNE) / 2                  # three.y начала модели
SPAN, SPRING, RISE = 6.4, 0.8, 4.0    # пролёт арки, высота пят над полом, стрела (до замка от пола)
R_ARCH = SPAN / 2
TUN_X = (-4.2, 4.2)                   # оси проходов (простенок 2.0 м)
X0, X1 = -56.0, 63.0                  # длина фасадов вдоль дамбы (весь участок дамбы lenina_dam_*)
APRON_Y = HJ['apron_y']
CORE_X = HJ['core_x']
PILLAR_STEP = 3.6
GX, GY, GZ = HJ['x'], HJ['y'], HJ['z']


def dam(X, Y):
    """three.y дамбы (до выемки), билинейно по сетке."""
    fx = (min(max(X, GX[0]), GX[-1]) - GX[0]) / (GX[1] - GX[0])
    fy = (min(max(Y, GY[0]), GY[-1]) - GY[0]) / (GY[1] - GY[0])
    i, j = min(int(fx), len(GX) - 2), min(int(fy), len(GY) - 2)
    tx, ty = fx - i, fy - j
    z = GZ
    return (z[j][i] * (1 - tx) * (1 - ty) + z[j][i + 1] * tx * (1 - ty) + z[j + 1][i] * (1 - tx) * ty + z[j + 1][i + 1] * tx * ty)


def floor(Y):
    t = min(max((Y + WALL_Y) / (2 * WALL_Y), 0.0), 1.0)
    return FSW + (FNE - FSW) * t - Y0


def top(X, side):
    """Верх тротуара у парапета (относительно начала модели)."""
    return dam(X, side * 10.3) + 0.15 - Y0


# ------------------------------------------------------------------ материалы (свои узлы: кладка по плоскости фасада)
def _brick_material(name, color, mortar, bw, bh, plane='XZ', var=0.1, role='stone', offset=0.5):
    if name in L.MATS:
        return name
    m = bpy.data.materials.new(name)
    nt, bsdf = L._nodes(m)
    lin = [c ** 2.2 for c in color]
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(geo.outputs['Position'], sep.inputs[0])
    cmb = nt.nodes.new('ShaderNodeCombineXYZ')
    a, b = plane[0], plane[1]
    nt.links.new(sep.outputs[a], cmb.inputs['X']); nt.links.new(sep.outputs[b], cmb.inputs['Y'])
    bt = nt.nodes.new('ShaderNodeTexBrick')
    bt.offset = offset
    bt.inputs['Scale'].default_value = 1.0
    bt.inputs['Mortar Size'].default_value = 0.012
    bt.inputs['Brick Width'].default_value = bw; bt.inputs['Row Height'].default_value = bh
    bt.inputs['Color1'].default_value = (*lin, 1)
    bt.inputs['Color2'].default_value = tuple(c * 0.86 for c in lin) + (1,)
    bt.inputs['Mortar'].default_value = (*[c ** 2.2 for c in mortar], 1)
    nt.links.new(cmb.outputs[0], bt.inputs['Vector'])
    nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 0.5; nz.inputs['Detail'].default_value = 4.0
    nt.links.new(geo.outputs['Position'], nz.inputs['Vector'])
    mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs['To Min'].default_value = 1 - var; mr.inputs['To Max'].default_value = 1 + var
    nt.links.new(nz.outputs['Fac'], mr.inputs['Value'])
    mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs['Factor'].default_value = 1.0
    nt.links.new(bt.outputs['Color'], mx.inputs['A'])
    cm = nt.nodes.new('ShaderNodeCombineColor')
    for k in ('Red', 'Green', 'Blue'):
        nt.links.new(mr.outputs['Result'], cm.inputs[k])
    nt.links.new(cm.outputs['Color'], mx.inputs['B'])
    nt.links.new(mx.outputs['Result'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.8
    L.MATS[name] = (m, role, {'color': color, 'emit': None, 'wash': None})
    return name


def materials():
    _brick_material('blocks', (0.62, 0.62, 0.6), (0.5, 0.5, 0.49), 0.6, 0.3, 'XZ', var=0.12)
    _brick_material('brick', (0.86, 0.8, 0.66), (0.75, 0.72, 0.64), 0.25, 0.075, 'XZ', var=0.08)
    _brick_material('brick_y', (0.86, 0.8, 0.66), (0.75, 0.72, 0.64), 0.25, 0.075, 'YZ', var=0.08)
    _brick_material('paving', (0.7, 0.62, 0.52), (0.5, 0.46, 0.4), 0.4, 0.2, 'XY', var=0.1)
    L.material('liner', (0.86, 0.82, 0.7), role='metal', kind='seams', var=0.05, extra={'axis': 1, 'step': 0.35}, wash=(0.55, -0.5, 6.0))
    L.material('sidewalk', (0.62, 0.62, 0.6), role='stone', kind='paving', var=0.06)
    L.material('cap', (0.82, 0.8, 0.74), role='stone', kind='plain', var=0.06)
    L.material('iron', (0.16, 0.18, 0.2), role='metal', kind='plain', var=0.05)
    L.material('lamp', (1.0, 0.92, 0.75), role='glass', emit=(1.0, 0.86, 0.6, 1.6))
    L.material('hidden', (0.4, 0.4, 0.4), kind='plain', var=0.0)


# ------------------------------------------------------------------ геометрия
def arch_z(x, cx, fy):
    """Высота свода над точкой x (внутри пролёта) при поле fy."""
    d = abs(x - cx)
    if d >= R_ARCH:
        return None
    return fy + SPRING + (RISE - SPRING) * math.sqrt(1 - (d / R_ARCH) ** 2)


def facade(M, ring, side, detail):
    """Фасад: кладка от низа до верха с вырезами арок (вертикальные полосы), кольца арок, карниз."""
    yw = side * WALL_Y
    fy = floor(yw)
    zb = min(floor(-WALL_Y), floor(WALL_Y)) - 1.6
    xs = []
    x = X0
    while x < X1 - 1e-6:
        near = any(abs(x - c) < R_ARCH + 0.6 for c in TUN_X)
        xs.append(x)
        x += 0.2 if near else 1.0
    xs.append(X1)
    for c in TUN_X:            # точные края проёмов
        for e in (c - R_ARCH, c + R_ARCH):
            if e not in xs:
                xs.append(e)
    xs = sorted(xs)
    T = lambda X: top(X, side) - 0.45     # низ карниза
    for a, b in zip(xs[:-1], xs[1:]):
        xm = (a + b) / 2
        lo = zb
        for c in TUN_X:
            if abs(xm - c) < R_ARCH:
                za, zb2 = arch_z(a, c, fy) or fy + SPRING, arch_z(b, c, fy) or fy + SPRING
                lo = None
                quad = [(a, yw, za), (b, yw, zb2), (b, yw, T(b)), (a, yw, T(a))]
                break
        if lo is not None:
            quad = [(a, yw, lo), (b, yw, lo), (b, yw, T(b)), (a, yw, T(a))]
        if side < 0:
            M.add(quad, [[0, 1, 2, 3]], 'blocks')
        else:
            M.add(quad, [[3, 2, 1, 0]], 'blocks')
    # кольца арок: выступ 0.06 м, ширина 0.45 м
    for c in TUN_X:
        n = 24 if detail else 10
        pts_in, pts_out = [], []
        for k in range(n + 1):
            t = math.pi * k / n
            r0, r1 = R_ARCH, R_ARCH + 0.45
            sx, sz = math.cos(t), math.sin(t)
            zc = fy + SPRING
            k_rise = (RISE - SPRING) / R_ARCH
            pts_in.append((c + r0 * sx, zc + r0 * sz * k_rise))
            pts_out.append((c + r1 * sx, zc + r0 * sz * k_rise + 0.45 * sz))
        yo = yw + side * 0.06
        for k in range(n):
            q = [(pts_in[k][0], yo, pts_in[k][1]), (pts_out[k][0], yo, pts_out[k][1]),
                 (pts_out[k + 1][0], yo, pts_out[k + 1][1]), (pts_in[k + 1][0], yo, pts_in[k + 1][1])]
            ring.add(q, [[0, 1, 2, 3] if side < 0 else [3, 2, 1, 0]], 'brick')
            # торцы кольца (интрадос — к своду, экстрадос — к стене)
            for p0, p1 in ((pts_in[k], pts_in[k + 1]), (pts_out[k + 1], pts_out[k])):
                q2 = [(p0[0], yw, p0[1]), (p1[0], yw, p1[1]), (p1[0], yo, p1[1]), (p0[0], yo, p0[1])]
                ring.add(q2, [[0, 1, 2, 3] if side > 0 else [3, 2, 1, 0]], 'brick')
        # пяты: короткие вертикальные полосы кирпича на высоту SPRING
        for sx in (-1, 1):
            xa, xb = c + sx * R_ARCH, c + sx * (R_ARCH + 0.45)
            q = [(xa, yo, fy), (xb, yo, fy), (xb, yo, fy + SPRING), (xa, yo, fy + SPRING)]
            ring.add(q, [[0, 1, 2, 3] if (side < 0) == (sx > 0) else [3, 2, 1, 0]], 'brick')
    # карниз-поясок под парапетом
    xs2 = [X0 + i * 2.0 for i in range(int((X1 - X0) / 2.0) + 1)]
    for a, b in zip(xs2[:-1], xs2[1:]):
        ta, tb = top(a, side), top(b, side)
        y1 = yw + side * 0.12
        q = [(a, y1, ta - 0.45), (b, y1, tb - 0.45), (b, y1, ta - 0.45 + (tb - ta) + 0.3), (a, y1, ta + 0.3 - 0.0)]
        q = [(a, y1, ta - 0.45), (b, y1, tb - 0.45), (b, y1, tb + 0.3), (a, y1, ta + 0.3)]
        ring.add(q, [[0, 1, 2, 3] if side < 0 else [3, 2, 1, 0]], 'brick')
        # верх цоколя парапета (от тротуара до лицевой стороны) и низ выступа
        y0 = side * 10.3
        q = [(a, y0, ta + 0.3), (b, y0, tb + 0.3), (b, y1, tb + 0.3), (a, y1, ta + 0.3)]
        ring.add(q, [[3, 2, 1, 0] if side < 0 else [0, 1, 2, 3]], 'cap')
        q = [(a, yw, ta - 0.45), (b, yw, tb - 0.45), (b, y1, tb - 0.45), (a, y1, ta - 0.45)]
        ring.add(q, [[0, 1, 2, 3] if side < 0 else [3, 2, 1, 0]], 'brick')
        # полоса мощения от кромки тротуара ул. Ленина (|Y| ≈ 9.0) до цоколя — на дамбе там иначе виден газон
        za, zb_ = dam(a, side * 9.0) + 0.16 - Y0, dam(b, side * 9.0) + 0.16 - Y0
        q = [(a, side * 9.0, za), (b, side * 9.0, zb_), (b, y0, tb + 0.01), (a, y0, ta + 0.01)]
        ring.add(q, [[3, 2, 1, 0] if side < 0 else [0, 1, 2, 3]], 'sidewalk')
        # внутренняя сторона цоколя (к тротуару)
        q = [(a, y0, ta - 0.02), (b, y0, tb - 0.02), (b, y0, tb + 0.3), (a, y0, ta + 0.3)]
        ring.add(q, [[3, 2, 1, 0] if side < 0 else [0, 1, 2, 3]], 'brick')


def tunnel(M, lights, cx, detail):
    """Свод прохода: пяты + полуэллипс, нормали внутрь; пол — плитка; светильники по своду."""
    n = 20 if detail else 8
    ys = [-WALL_Y + 2 * WALL_Y * i / 11 for i in range(12)]
    prof = []                               # (dx, dz над полом)
    prof.append((-R_ARCH, 0.0))
    for k in range(n + 1):
        t = math.pi - math.pi * k / n
        prof.append((R_ARCH * math.cos(t), SPRING + (RISE - SPRING) * math.sin(t)))
    prof.append((R_ARCH, 0.0))
    rows = [[(cx + dx, y, floor(y) + dz) for dx, dz in prof] for y in ys]
    m = len(prof)
    for i in range(len(ys) - 1):
        for k in range(m - 1):
            q = [rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]]
            M.add(q, [[3, 2, 1, 0]], 'liner')
        # пол
        q = [(cx - R_ARCH, ys[i], floor(ys[i]) + 0.02), (cx + R_ARCH, ys[i], floor(ys[i]) + 0.02),
             (cx + R_ARCH, ys[i + 1], floor(ys[i + 1]) + 0.02), (cx - R_ARCH, ys[i + 1], floor(ys[i + 1]) + 0.02)]
        M.add(q, [[0, 1, 2, 3]], 'paving')
    # светильники: две линии по своду через 2.7 м
    for y in [-WALL_Y + 1.5 + 2.7 * i for i in range(int((2 * WALL_Y - 3) / 2.7) + 1)]:
        for s in (-1, 1):
            a = math.radians(60)
            x = cx + s * R_ARCH * math.cos(a) * 0.98
            z = floor(y) + SPRING + (RISE - SPRING) * math.sin(a) * 0.98
            lights.box((x, y, z), (0.18, 0.9, 0.06), 'lamp', M=None)


def aprons(M):
    """Мощёные площадки перед порталами на уровне пола (|X| <= CORE_X, WALL_Y..APRON_Y)."""
    for side in (-1, 1):
        f = floor(side * WALL_Y) + 0.03
        ya, yb = side * WALL_Y, side * (APRON_Y - 1.0)
        for x0 in range(int(-CORE_X), int(CORE_X), 4):
            q = [(x0, ya, f), (x0 + 4, ya, f), (x0 + 4, yb, f), (x0, yb, f)]
            M.add(q, [[0, 1, 2, 3] if side > 0 else [3, 2, 1, 0]], 'paving')


def rosette(M, cx, cz, y, r, n, mat):
    """Кольцо квадратного сечения 3.5 см в плоскости XZ."""
    w = 0.022
    v, faces = [], []
    for k in range(n):
        t = 2 * math.pi * k / n
        for rr, yy in ((r - w / 2, y - w / 2), (r + w / 2, y - w / 2), (r + w / 2, y + w / 2), (r - w / 2, y + w / 2)):
            v.append((cx + rr * math.cos(t), yy, cz + rr * math.sin(t)))
    for k in range(n):
        a, b = 4 * k, 4 * ((k + 1) % n)
        for e in range(4):
            e2 = (e + 1) % 4
            faces.append([a + e, a + e2, b + e2, b + e])
    M.add(v, faces, mat)


def parapet(P, rails, side, detail):
    """Кирпичные столбики через PILLAR_STEP, чугунные панели с двумя розетками между ними."""
    yc = side * 10.55
    n = int((X1 - X0) / PILLAR_STEP)
    xs = [X0 + (X1 - X0) * i / n for i in range(n + 1)]
    for x in xs:
        t = top(x, side)
        P.box((x, yc, t + 0.625), (0.55, 0.55, 1.25), 'brick_y', skip=('b',))
        P.box((x, yc, t + 1.3), (0.66, 0.66, 0.1), 'cap', skip=('b',))
    for a, b in zip(xs[:-1], xs[1:]):
        xa, xb = a + 0.275, b - 0.275
        ta, tb = top(xa, side), top(xb, side)
        tm = (ta + tb) / 2
        L_ = xb - xa
        if not detail:
            for d in (-0.02, 0.02):
                q = [(xa, yc + d, ta + 0.3), (xb, yc + d, tb + 0.3), (xb, yc + d, tb + 1.15), (xa, yc + d, ta + 1.15)]
                rails.add(q, [[0, 1, 2, 3] if d < 0 else [3, 2, 1, 0]], 'iron')
            continue
        for zz in (0.33, 1.12):
            rails.box(((xa + xb) / 2, yc, tm + zz), (L_, 0.05, 0.05), 'iron', skip=('x-', 'x+'))
        for x in (xa + 0.04, (xa + xb) / 2, xb - 0.04):
            rails.box((x, yc, tm + 0.725), (0.04, 0.04, 0.8), 'iron', skip=('t', 'b'))
        for q in (0.25, 0.75):
            cx = xa + L_ * q
            rosette(rails, cx, tm + 0.725, yc, 0.34, 14, 'iron')
            rosette(rails, cx, tm + 0.725, yc, 0.14, 8, 'iron')


def deck_boxes():
    """Плиты-коллайдеры настила над выемкой: |X| <= CORE_X + 8, поверх тротуаров и проезжей части."""
    boxes = []
    xs = [x for x in range(-int(CORE_X + 8), int(CORE_X + 8), 4)]
    ys = [-WALL_Y + i * (2 * WALL_Y) / 6 for i in range(7)]
    for x0 in xs:
        for j in range(6):
            ya, yb = ys[j], ys[j + 1]
            xc, yc = x0 + 2.0, (ya + yb) / 2
            # поверхность: дорога (+0.05) в середине, тротуары (+0.15) у краёв (|Y| > 7)
            lift = 0.15 if abs(yc) > 7.0 else 0.05
            z = lambda X, Y: dam(X, Y) + lift - Y0
            zc = z(xc, yc)
            bx = (z(xc + 2, yc) - z(xc - 2, yc)) / 4
            by = (z(xc, yb) - z(xc, ya)) / (yb - ya)
            th = 0.45
            rx, ry = math.atan(by), -math.atan(bx)
            cz = zc - th / 2
            boxes.append(((xc, yc, cz), (4.05, yb - ya + 0.05, th), (rx, ry, 0.0)))
    return boxes


def fill_boxes():
    """Массив кладки вокруг проходов (под плитами настила), по полосам поперёк — верх следует уклону дамбы."""
    zlo = min(floor(-WALL_Y), floor(WALL_Y)) - 1.0
    segs = [(-(CORE_X + 8), TUN_X[0] - R_ARCH), (TUN_X[0] + R_ARCH, TUN_X[1] - R_ARCH), (TUN_X[1] + R_ARCH, CORE_X + 8)]
    ys = [-WALL_Y + i * (2 * WALL_Y) / 6 for i in range(7)]
    out = []
    for j in range(6):
        ya, yb = ys[j], ys[j + 1]
        ztop = min(dam(x, y) for x in range(-20, 21, 2) for y in (ya, (ya + yb) / 2, yb)) + 0.05 - 0.47 - Y0
        for a, b in segs:
            out.append((((a + b) / 2, (ya + yb) / 2, (zlo + ztop) / 2), (b - a, yb - ya, ztop - zlo), 0.0))
        zc = max(floor(ya), floor(yb)) + RISE + 0.03          # замок свода
        for c in TUN_X:
            if ztop > zc + 0.02:
                out.append(((c, (ya + yb) / 2, (zc + ztop) / 2), (SPAN, yb - ya, ztop - zc), 0.0))
    return out


def parapet_boxes():
    out = []
    for side in (-1, 1):
        for a in range(int(X0), int(X1), 6):
            b = min(a + 6, X1)
            ta, tb = top(a, side), top(b, side)
            out.append((((a + b) / 2, side * 10.55, (ta + tb) / 2 + 0.6), (b - a + 0.05, 0.5, 1.25), (0.0, -math.atan((tb - ta) / (b - a)), 0.0)))
    return out


def build(lod):
    detail = lod == 0
    materials()
    wall = L.Mesh('walls')
    ring = L.Mesh('brickwork', uvk=1.4)
    tun = L.Mesh('vaults', uvk=0.6)
    lights = L.Mesh('lights', palette=True)
    par = L.Mesh('parapet', palette=not detail)
    rails = L.Mesh('rails', palette=True)
    for side in (-1, 1):
        facade(wall, ring, side, detail)
        parapet(par, rails, side, detail)
    for c in TUN_X:
        tunnel(tun, lights, c, detail)
    aprons(tun)
    meshes = [wall, ring, tun, lights, par, rails]
    boxes = deck_boxes() + fill_boxes() + parapet_boxes()
    # ночные пятна света у порталов и в проходах (локальные glTF x, y, z = −Y)
    pools = []
    for c in TUN_X:
        for side in (-1, 1):
            pools.append([c, 0.0, -side * (WALL_Y + 2.5), 4.5, 0.55])
        pools.append([c, 0.0, 0.0, 4.0, 0.7])
    # футпринты (glTF x, z): площадки перед порталами — здесь не ставятся пропсы, дорожки OSM вырезаны (модель кладёт плитку)
    fp_ne = [[-CORE_X - 2, -(APRON_Y)], [CORE_X + 2, -(APRON_Y)], [CORE_X + 2, -(WALL_Y + 0.2)], [-CORE_X - 2, -(WALL_Y + 0.2)]]
    fp_sw = [[-CORE_X - 2, WALL_Y + 0.2], [CORE_X + 2, WALL_Y + 0.2], [CORE_X + 2, APRON_Y], [-CORE_X - 2, APRON_Y]]
    zmax = max(top(x, s) for x in range(int(X0), int(X1)) for s in (-1, 1)) + 1.4
    info = dict(INFO, size=[X1 - X0, zmax - (min(floor(-WALL_Y), floor(WALL_Y)) - 1.6), 2 * WALL_Y + 1.0], pools=pools,
                footprint=fp_ne, extraFootprints=[fp_sw], y0=Y0)
    L.log(f'Y0={Y0:.2f}, deck boxes {len(deck_boxes())}, fill {len(fill_boxes())}')
    return meshes, (boxes if detail else []), info
