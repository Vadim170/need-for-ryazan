# Рязанский государственный цирк (Лево-Лыбедская ул., 34; OSM w101850040). Здание 1980 г., реконструкция 2014 г.
# Источники: ортофото Яндекса 0.25 м (восьмигранник по кровле: вершины на 7° + k·45°, R ≈ 31 м; купол Ø 45 м,
# фонарь Ø ~14 м), футпринт OSM (вход-навес 23 × 10 м, П-образный служебный корпус сзади), панорамы Яндекса 2024 г.
# (data/raw/panoramas/landmarks/circus/crops/ 12–18 — главный фасад и вход, 07–11 — восточная сторона, 03–06 — служебный корпус).
# Высоты по панорамам: 1-й этаж ~4.6 м (двери 2.5 м), витражный пояс ~7 м с цветными квадратами, фриз ~1.6 м, верх
# парапета ~13.8 м; купол поднимается на ~5 м, барабан-фонарь ~4 м с красной надписью «ЦИРК».
# Блендер: перёд = +Y (вход на ЮЗ, азимут 240.5°), начало — центр восьмигранника на уровне площади у входа.
import math
from mathutils import Matrix, Vector
import lmlib as L
import arch as A

INFO = {'name': 'Рязанский цирк', 'osm': ['w101850040']}

AP = 29.0                 # апофема витражного пояса
Z1, Z2, Z3, Z4 = 5.0, 5.7, 12.1, 13.3          # сверено с панорамами 13, 18 (1-й этаж ≈ витражу)
RD, ZD0, HD = 22.5, 13.4, 7.6      # подъём купола: барабан хорошо виден над парапетом (панорама 13)      # купол: радиус основания, высота основания, подъём
RL = 7.0                   # фонарь
COLORS = ['c_red', 'c_yellow', 'c_green', 'c_blue']


def octagon(ap, a0=math.pi / 8):
    R = ap / math.cos(math.pi / 8)
    return [(R * math.cos(a0 + k * math.pi / 4), R * math.sin(a0 + k * math.pi / 4)) for k in range(8)]


def dome_z(r):
    Rs = (RD ** 2 + HD ** 2) / (2 * HD)
    zc = ZD0 + HD - Rs
    return zc + math.sqrt(max(Rs * Rs - r * r, 0.0))


def build(lod):
    detail = lod == 0
    L.material('panel', (0.93, 0.84, 0.6), kind='panel', var=0.05, wash=(0.35, 0.0, 6.0))
    L.material('panel_dark', (0.62, 0.58, 0.5), kind='panel', var=0.05)
    L.material('plinth', (0.32, 0.3, 0.29), role='stone', kind='granite', var=0.08)
    L.material('glass', (0.3, 0.37, 0.44), role='glass', kind='glass', var=0.12, emit=(1.0, 0.86, 0.66, 0.75))
    L.material('glass_low', (0.12, 0.15, 0.19), role='glass', kind='glass', var=0.12, emit=(1.0, 0.9, 0.75, 0.6))
    L.material('mull', (0.86, 0.87, 0.86), role='metal', kind='plain', var=0.03)
    L.material('c_red', (0.82, 0.1, 0.1), kind='plain', var=0.04, emit=(1.0, 0.25, 0.2, 0.25))
    L.material('c_yellow', (0.96, 0.8, 0.12), kind='plain', var=0.04, emit=(1.0, 0.85, 0.3, 0.25))
    L.material('c_green', (0.12, 0.6, 0.25), kind='plain', var=0.04, emit=(0.3, 1.0, 0.45, 0.2))
    L.material('c_blue', (0.12, 0.36, 0.82), kind='plain', var=0.04, emit=(0.3, 0.55, 1.0, 0.25))
    L.material('roof', (0.33, 0.33, 0.34), kind='plain', var=0.1)
    L.material('dome', (0.86, 0.88, 0.9), role='metal', kind='radial', var=0.05, extra={'radius': 15.0, 'step': 1.1})
    L.material('lantern', (0.93, 0.91, 0.84), kind='panel', var=0.04, wash=(0.5, 18.0, 30.0))
    L.material('letters', (0.86, 0.1, 0.08), kind='plain', var=0.03, emit=(1.0, 0.12, 0.08, 1.0))
    L.material('granite_black', (0.09, 0.09, 0.1), role='stone', kind='granite', var=0.15)
    L.material('soffit', (0.88, 0.84, 0.72), kind='plain', var=0.04, emit=(1.0, 0.92, 0.78, 0.55))
    L.material('poster', (0.2, 0.15, 0.5), kind='poster', var=0.1, wash=(0.55, 0.0, 1e5))
    L.material('poster_text', (0.98, 0.82, 0.15), kind='plain', var=0.03, emit=(1.0, 0.85, 0.3, 0.9))
    L.material('wing', (0.93, 0.8, 0.45), kind='panel', var=0.05)
    L.material('wing_blank', (0.85, 0.82, 0.66), kind='panel', var=0.05)
    L.material('redframe', (0.75, 0.12, 0.1), kind='plain', var=0.04)
    L.material('wing_glass', (0.12, 0.14, 0.16), role='glass', kind='glass', var=0.1, emit=(1.0, 0.92, 0.8, 0.35))
    L.material('door_glass', (0.15, 0.18, 0.2), role='glass', kind='glass', var=0.1, emit=(1.0, 0.9, 0.75, 0.8))
    L.material('steps', (0.62, 0.6, 0.57), role='stone', kind='granite', var=0.06)

    body = L.Mesh('body')
    dome = L.Mesh('dome', uvk=0.5)
    deco = L.Mesh('decor', palette=True)
    roof = L.Mesh('roof', uvk=0.3)

    oct_up = octagon(AP)
    oct_g = octagon(AP - 1.3)
    oct_band = octagon(AP + 0.25)
    oct_top = octagon(AP + 0.35)

    # ---------------- цоколь и 1-й этаж (утоплен под витражным поясом)
    body.prism(octagon(AP - 1.0), -4.5, 0.0, 'plinth', cap1=False)
    body.prism(oct_g, 0.0, Z1, 'panel', cap1=False)
    body.prism(oct_band, Z1, Z2, 'panel', cap0=True, cap1=False)
    # витражный пояс: стекло + импосты + цветные квадраты
    body.prism(oct_up, Z2, Z3, 'glass', cap1=False)
    body.prism(oct_top, Z3, Z4, 'panel', cap0=True, cap1=False)
    body.sweep([(0.0, Z4), (0.15, Z4), (0.15, Z4 + 0.25), (-0.6, Z4 + 0.25)], oct_top + [oct_top[0]], 'panel_dark', closed=True)
    # ground floor: окна-щели, витрины, двери на гранях
    rng = 7
    for k in range(8):
        a, b = Vector(oct_up[k]), Vector(oct_up[(k + 1) % 8])
        ag, bg = Vector(oct_g[k]), Vector(oct_g[(k + 1) % 8])
        u = (b - a).normalized(); n = Vector((u.y, -u.x))
        side = (b - a).length
        # правая тройка (x вдоль грани, y наружу, z вверх): у обхода против часовой «наружу» справа, поэтому x идёт от b к a
        Mw = A.frame((b.x, b.y, 0), (-u.x, -u.y, 0), (n.x, n.y, 0))
        Mg = A.frame((bg.x, bg.y, 0), (-u.x, -u.y, 0), (n.x, n.y, 0))
        sg = (bg - ag).length
        # импосты витража (через ~1.55 м), цветные — через 2
        nm = max(int(side / 1.55), 2)
        for i in range(nm + 1):
            x = side * i / nm
            if detail or i % 2 == 0:
                cm = COLORS[(i * 3 + k) % 4] if i % 2 == 1 else 'mull'      # цветные импосты через один (панорамы 10, 13)
                deco.box((x, 0.12, (Z2 + Z3) / 2), (0.16 if cm == 'mull' else 0.32, 0.24, Z3 - Z2), cm, Mw, skip=('y-',))
            if i < nm:
                for zz in (Z2 + 0.5, Z3 - 0.5):   # ряды цветных квадратов внизу и вверху пояса
                    rng = (rng * 1103515245 + 12345) & 0x7fffffff
                    cm = COLORS[(rng >> 8) % 4]                                 # цветной квадрат в каждом модуле
                    deco.box((x + side / nm / 2, 0.07, zz), (side / nm - 0.2, 0.1, 0.95), cm, Mw, skip=('y-',))
        if detail:   # горизонтальные ригели
            for zz in (Z2 + 0.8, (Z2 + Z3) / 2 + 0.6, Z3 - 0.8):
                deco.box((side / 2, 0.08, zz), (side, 0.1, 0.1), 'mull', Mw, skip=('y-',))
        # 1-й этаж
        if k == 1:      # главный вход (грань +Y): стеклянные двери под навесом
            deco.box((sg / 2, 0.05, 1.6), (12.0, 0.1, 3.2), 'door_glass', Mg, skip=('y-',))
            for i in range(9):
                deco.box((sg / 2 - 6 + 1.5 * i, 0.1, 1.6), (0.1, 0.12, 3.2), 'mull', Mg, skip=('y-',))
            for s in (-1, 1):   # афишные витрины
                deco.box((sg / 2 + s * 9.0, 0.08, 2.0), (3.6, 0.12, 2.6), 'poster', Mg, skip=('y-',))
        elif k in (0, 2, 3, 7):   # витрины фойе
            deco.box((sg / 2, 0.05, 2.0), (sg * 0.5, 0.1, 3.4), 'glass_low', Mg, skip=('y-',))
            for i in range(7):
                deco.box((sg / 2 - sg * 0.25 + sg * 0.5 * i / 6, 0.1, 2.0), (0.1, 0.12, 3.4), 'mull', Mg, skip=('y-',))
            if detail:
                for j in range(6):   # окна-щели
                    deco.box((sg * 0.12 + j * 0.45, 0.05, 2.6), (0.22, 0.1, 1.6), 'glass_low', Mg, skip=('y-',))
        else:
            for j in range(8 if detail else 4):
                deco.box((sg / 2 - 2.5 + j * (0.7 if detail else 1.4), 0.05, 2.6), (0.24, 0.1, 1.8), 'glass_low', Mg, skip=('y-',))
            deco.box((sg / 2 + 6.0, 0.05, 1.3), (2.0, 0.1, 2.6), 'door_glass', Mg, skip=('y-',))

    # ---------------- кровля: плоское кольцо, купол, фонарь, надпись
    ring_o = octagon(AP + 0.35)
    n_d = 48 if detail else 24
    ring_in = [(RD * math.cos(2 * math.pi * k / n_d), RD * math.sin(2 * math.pi * k / n_d)) for k in range(n_d)]
    # плоская кровля между восьмигранником и куполом — веер треугольников от окружности к ближайшей вершине
    zr = Z4 + 0.05
    for k in range(n_d):
        p, q = ring_in[k], ring_in[(k + 1) % n_d]
        a = math.atan2((p[1] + q[1]) / 2, (p[0] + q[0]) / 2)
        j = int(((a - math.pi / 8) % (2 * math.pi)) / (math.pi / 4) + 0.5) % 8
        v = ring_o[j]
        roof.add([(p[0], p[1], zr), (v[0], v[1], zr), (q[0], q[1], zr)], [[0, 1, 2]], 'roof')
    for j in range(8):
        a_mid = math.pi / 8 + (j + 0.5) * math.pi / 4
        kq = int(round(a_mid / (2 * math.pi) * n_d)) % n_d
        q = ring_in[kq]
        roof.add([(ring_o[j][0], ring_o[j][1], zr), (ring_o[(j + 1) % 8][0], ring_o[(j + 1) % 8][1], zr), (q[0], q[1], zr)], [[0, 1, 2]], 'roof')
    # купол
    prof = [(RD + 0.3, ZD0 - 0.2), (RD, ZD0)]
    nr = 10 if detail else 5
    for i in range(1, nr + 1):
        r = RD - (RD - RL) * i / nr
        prof.append((r, dome_z(r)))
    dome.lathe(prof, n_d, 'dome')
    if detail:   # рёбра купола
        for k in range(24):
            a = 2 * math.pi * k / 24
            pts = []
            for i in range(nr + 1):
                r = RD - (RD - RL) * i / nr
                pts.append((r, dome_z(r) + 0.08))
            for i in range(nr):
                (r0, z0), (r1, z1) = pts[i], pts[i + 1]
                c, s = math.cos(a), math.sin(a)
                t = Vector((-s, c, 0)) * 0.08
                p0 = Vector((r0 * c, r0 * s, z0)); p1 = Vector((r1 * c, r1 * s, z1))
                deco.quad(p0 - t, p0 + t, p1 + t, p1 - t, 'mull')
    zl0 = dome_z(RL) - 0.4
    zl1 = zl0 + 6.2              # барабан заметно выше парапета (панорамы 13, 14)
    dome.lathe([(RL, zl0), (RL, zl1), (RL + 0.25, zl1), (RL + 0.25, zl1 + 0.35), (RL - 0.4, zl1 + 0.45), (RL * 0.5, zl1 + 0.95), (0.0, zl1 + 1.1)],
               n_d, 'lantern')
    deco.cyl((0, 0, zl1 + 1.1), 0.12, 3.0, 6, 'mull')
    # галерея по куполу от фонаря к задней грани
    gal = []
    steps = 6
    for i in range(steps + 1):
        r = RL + (RD + 1.0 - RL) * i / steps
        gal.append((r, dome_z(min(r, RD)) if r <= RD else ZD0))
    for i in range(steps):
        (r0, z0), (r1, z1) = gal[i], gal[i + 1]
        body.box2((-1.6, -r1, min(z0, z1) - 0.6), (1.6, -r0, max(z0, z1) + 1.4), 'panel', skip=('b',))
    # надпись «ЦИРК» по барабану (спереди и сзади)
    if True:
        for base_a in (math.pi / 2, -math.pi / 2):
            word = 'ЦИРК'
            lw = 1.75
            for i, ch in enumerate(word):
                a = base_a - (1.5 - i) * lw / RL
                tm = L.text_mesh(ch, L.FONT_SANS, size=2.3, extrude=0.18, align='CENTER')
                M = Matrix.Translation((RL * math.cos(a), RL * math.sin(a), zl0 + 1.1)) @ Matrix.Rotation(a + math.pi / 2, 4, 'Z') \
                    @ Matrix.Rotation(math.pi / 2, 4, 'X')
                deco.from_object_mesh(tm, 'letters', M, smooth=False)
                L.bpy.data.meshes.remove(tm)

    # ---------------- входной навес на чёрных гранитных опорах с афишей
    yc0 = AP - 1.0
    yc1 = 37.5                    # передняя кромка навеса (OSM 39.5; по панораме 16 ближе)
    CW = 14.5                     # полуширина навеса: опоры разнесены на ~27 м (панорама 16)
    body.box2((-CW, yc0, Z1 + 0.25), (CW, yc1, Z1 + 1.0), 'panel', skip=('b',))
    body.quad((-CW, yc1, Z1 + 0.25), (CW, yc1, Z1 + 0.25), (CW, yc0, Z1 + 0.25), (-CW, yc0, Z1 + 0.25), 'soffit')
    for x in (-13.5, -4.5, 4.5, 13.5):
        body.box((x, yc1 - 1.0, (Z1 + 0.25) / 2), (0.8, 0.8, Z1 + 0.25), 'granite_black', skip=('b', 't'))
        if detail:
            for zz in range(1, 5):
                deco.box((x, yc1 - 1.0, zz * 0.95), (0.84, 0.84, 0.05), 'mull')
    # ступени к входу
    for i in range(3):
        body.box2((-9.0, yc0, -0.6), (9.0, yc0 + 0.9 * (i + 1), 0.15 * (3 - i)), 'steps', skip=('b',))
    # афиша-баннер на кромке навеса
    # (сменная афиша текущего шоу, панорама 16: 2.8 м по высоте; надпись «ЦИРК» — только на барабане)
    body.box2((-CW - 0.1, yc1 - 0.25, Z1 + 0.95), (CW + 0.1, yc1, Z1 + 3.1), 'poster', skip=('b',))
    if detail:   # прожекторы подсветки афиши на кронштейнах
        for x in range(-13, 14, 3):
            deco.box((x, yc1 + 0.6, Z1 + 3.35), (0.25, 0.9, 0.12), 'mull')

    # ---------------- служебный П-образный корпус (по футпринту OSM, локальные координаты)
    blocks = [
        ([(-12.1, -41.4), (9.7, -41.4), (9.7, -27.0), (-12.1, -27.0)], 10.5, 'wing', True),
        ([(-28.3, -51.8), (27.3, -51.8), (27.3, -40.1), (-28.3, -40.1)], 10.5, 'wing_blank', False),
        ([(17.1, -83.3), (27.3, -83.3), (27.3, -51.8), (17.1, -51.8)], 8.0, 'wing', True),
        ([(-28.5, -83.1), (-17.4, -83.1), (-17.4, -51.8), (-28.5, -51.8)], 8.0, 'wing', True),
    ]
    for poly, h, m, windows in blocks:
        body.prism(poly, -4.0, h, m, cap1=False)
        roof.prism(poly, h, h + 0.01, 'roof', cap1=True)
        body.sweep([(0.0, h - 0.4), (0.2, h - 0.4), (0.2, h + 0.4), (-0.1, h + 0.4)], poly + [poly[0]], 'panel_dark', closed=True)
        if windows:
            for e in range(4):
                a, b = Vector(poly[e]), Vector(poly[(e + 1) % 4])
                u = (b - a).normalized(); n = Vector((u.y, -u.x)); ln = (b - a).length
                if ln < 15:
                    continue
                Mw = A.frame((b.x, b.y, 0), (-u.x, -u.y, 0), (n.x, n.y, 0))
                nw = int(ln / 3.2)
                for i in range(nw):
                    x = ln * (i + 0.5) / nw
                    for zz in (1.2, 4.6):
                        A.window(deco, Mw, x, zz, 1.3, 1.6, {'frame': 'redframe', 'glass': 'wing_glass', 'mull': 'mull'}, lod,
                                 mullions=(1, 0), frame_w=0.18, depth=0.1)

    meshes = [body, dome, deco, roof]
    ap = AP + 0.4
    sw = 2 * ap * math.tan(math.pi / 8)
    boxes = [((0, 0, (Z4 - 4.5) / 2), (2 * ap, sw, Z4 + 4.5), 0.0), ((0, 0, (Z4 - 4.5) / 2), (2 * ap, sw, Z4 + 4.5), math.pi / 2),
             ((0, 0, (Z4 - 4.5) / 2), (2 * ap, sw, Z4 + 4.5), math.pi / 4), ((0, 0, (Z4 - 4.5) / 2), (2 * ap, sw, Z4 + 4.5), -math.pi / 4)]
    for x in (-13.5, -4.5, 4.5, 13.5):
        boxes.append(((x, yc1 - 1.0, 2.0), (1.0, 1.0, 8.0), 0.0))
    for poly, h, _, _ in blocks:
        xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
        boxes.append((((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (h - 4.0) / 2), (max(xs) - min(xs), max(ys) - min(ys), h + 4.0), 0.0))
    pools = [[x, 0.0, -(yc1 + 3.0), 9.0, 1.0] for x in (-8.0, 0.0, 8.0)]
    pools += [[(AP + 4) * math.cos(a), 0.0, -(AP + 4) * math.sin(a), 8.0, 0.55] for a in (math.pi / 4, 3 * math.pi / 4, 0.0, math.pi)]
    fp = octagon(AP + 0.6)
    info = dict(INFO, size=[2 * AP + 1, zl1 + 4, 2 * AP + 50], pools=pools,
                footprint=[[x, -y] for x, y in fp],
                extraFootprints=[[[-CW - 0.5, -(yc0)], [CW + 0.5, -(yc0)], [CW + 0.5, -(yc1 + 0.5)], [-CW - 0.5, -(yc1 + 0.5)]]])
    return meshes, boxes, info
