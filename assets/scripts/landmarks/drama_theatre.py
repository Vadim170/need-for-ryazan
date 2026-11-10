# Рязанский областной театр драмы (Театральная пл., 7; OSM w96881608). Неоклассика 1961 г. (арх. И. Н. Чистосердова).
# Источники: футпринт OSM 69.1 × 39.1 м (совпадает с крышей на ортофото Яндекса 0.25 м), панорамы Яндекса 2024 г.
# (data/raw/panoramas/landmarks/drama_theatre/crops/ 16–23 — главный фасад, 00–02 — боковой).
# Размеры по панорамам: стилобат ~1 м (6 ступеней), коринфские колонны ~14.6 м (Ø ~1.35 м, дверь 3.2 м ≈ 1/4.5 ствола),
# антаблемент ~3 м, фронтон ~6 м; портик 10 колонн во всю ширину + по одной колонне в глубину с боков.
# Стены светло-жёлтые, колонны и декор белые, цоколь и лестница — красный гранит, кровля — серый металл.
# Блендер: перёд = +Y (главный фасад на СЗ, азимут 315.8°), начало координат — центр футпринта на уровне земли у фасада.
import math
from mathutils import Matrix, Vector
import lmlib as L
import arch as A

INFO = {
    'name': 'Рязанский театр драмы',
    'osm': ['w96881608'],
}

W = 19.0          # полуширина стен
YF = 33.9         # передняя грань антаблемента
YW = 25.4         # передняя стена (портик глубиной в два пролёта, панорама 23)
YR = -29.0        # задняя стена (длина ~64 м: крыша на ортофото короче контура OSM)
S = 1.0           # верх стилобата
ZC = 17.3         # верх колонн (колонна ~16.3 м: лучевая оценка по панорамам 19, 21)
ZE = 20.6         # верх карниза
ZR = 27.3         # конёк (вершина фронтона ~26.4 м над площадью, панорама 19)
COL_Y = 33.2
COL_X = [-17.6 + i * 35.2 / 9 for i in range(10)]


def build(lod):
    detail = lod == 0
    L.material('wall', (0.95, 0.83, 0.5), kind='stucco', var=0.07, wash=(0.32, 1.0, 9.0))
    L.material('frieze', (0.95, 0.83, 0.5), kind='stucco', var=0.05, wash=(0.4, 15.0, 6.0))
    L.material('wall_front', (0.95, 0.83, 0.5), kind='stucco', var=0.06, wash=(0.55, 1.0, 12.0))
    L.material('white', (0.93, 0.92, 0.88), kind='stucco', var=0.05, wash=(0.42, 1.0, 9.0))
    L.material('column', (0.95, 0.94, 0.9), kind='stucco', var=0.04, wash=(0.75, 1.0, 11.0))
    L.material('granite', (0.5, 0.27, 0.24), role='stone', kind='granite', var=0.1)
    L.material('steps', (0.56, 0.33, 0.3), role='stone', kind='granite', var=0.08)
    L.material('roof', (0.6, 0.62, 0.64), role='metal', kind='seams', var=0.08, extra={'axis': 1, 'step': 0.62})
    L.material('glass', (0.11, 0.13, 0.15), role='glass', kind='glass', var=0.15, emit=(1.0, 0.8, 0.52, 0.85))
    L.material('glass_dim', (0.11, 0.13, 0.15), role='glass', kind='glass', var=0.15, emit=(1.0, 0.85, 0.62, 0.35))
    L.material('glass_dark', (0.1, 0.11, 0.13), role='glass', kind='glass', var=0.15)
    L.material('mull', (0.42, 0.22, 0.14), kind='plain', var=0.05)
    L.material('door', (0.24, 0.13, 0.09), kind='plain', var=0.06)
    L.material('lamp', (0.95, 0.9, 0.75), role='glass', emit=(1.0, 0.85, 0.6, 1.0))
    L.material('iron', (0.08, 0.08, 0.08), role='metal', kind='plain', var=0.05)
    L.material('gold', (0.86, 0.68, 0.32), role='metal', kind='plain', var=0.06, emit=(1.0, 0.8, 0.45, 0.5))
    L.material('relief', (0.92, 0.91, 0.87), kind='stucco', var=0.06, wash=(0.5, 18.0, 6.0))
    L.material('soffit', (0.9, 0.86, 0.66), kind='stucco', var=0.05, wash=(0.6, 15.0, 4.0))
    win = {'frame': 'white', 'glass': 'glass', 'glass_dim': 'glass_dim', 'glass_dark': 'glass_dark', 'mull': 'mull', 'door': 'door'}

    body = L.Mesh('walls')
    cols = L.Mesh('columns')
    deco = L.Mesh('decor', palette=True)
    roof = L.Mesh('roof', uvk=0.35)
    hidden = L.Mesh('hidden', uvk=0.15)

    # ---------------- стилобат, лестница, цоколь
    body.box2((-W - 0.9, YW - 0.5, -2.5), (W + 0.9, YF + 0.7, S), 'steps', skip=('b',))
    nst = 6
    for i in range(nst):
        y0 = YF + 0.7 + i * 0.4
        body.box2((-16.6, y0, -1.5), (16.6, y0 + 0.4, S - (i + 1) * S / nst), 'steps', skip=('b',))
    for s in (-1, 1):   # щёки лестницы
        body.box2((s * 16.6, YF + 0.7, -1.5), (s * (W + 0.9), YF + 0.7 + nst * 0.4, S), 'granite', skip=('b',))
    # цоколь по периметру основного объёма
    plinth_path = [(-W, YW), (-W, YR), (W, YR), (W, YW)]
    body.sweep([(0.0, -0.6), (0.18, -0.6), (0.18, 1.05), (0.1, 1.15), (0.0, 1.15)], plinth_path, 'granite', closed=False)

    # ---------------- стены основного объёма
    body.sweep([(0.0, -2.5), (0.0, ZC)], [(-W, YW), (-W, YR), (W, YR), (W, YW)], 'wall', closed=False)
    # стена за портиком — отдельный материал (сильнее подсветка)
    body.quad((-W, YW, S), (-W, YW, ZC), (W, YW, ZC), (W, YW, S), 'wall_front')
    # пояс над 1-м этажом и под аттиковыми окнами
    for z0, z1, o in ((5.6, 5.95, 0.14), (14.0, 14.25, 0.1)):
        body.sweep([(0.0, z0), (o, z0), (o, z1), (0.0, z1)], [(-W, YW), (-W, YR), (W, YR), (W, YW)], 'white', closed=False)
        body.sweep([(0.0, z0), (o, z0), (o, z1), (0.0, z1)], [(W, YW), (-W, YW)], 'white', closed=False)

    # ---------------- антаблемент (архитрав, фриз, карниз) по периметру всего здания вместе с портиком
    ent = [(0.0, ZC), (0.25, ZC), (0.25, ZC + 0.95), (0.33, ZC + 1.0), (0.33, ZC + 1.08), (0.25, ZC + 1.1), (0.25, ZC + 2.15),
           (0.45, ZC + 2.2), (0.55, ZC + 2.38), (0.95, ZC + 2.45), (1.0, ZC + 2.7), (1.05, ZE - ZC + ZC), (0.0, ZE)]
    ent_path = [(-W, YR), (W, YR), (W, YF - 0.25), (-W, YF - 0.25)]
    # архитрав и карниз белые, фриз жёлтый (панорамы 19, 21)
    body.sweep(ent[:6], ent_path, 'white', closed=True)
    body.sweep([(0.25, ZC + 1.1), (0.25, ZC + 2.15)], ent_path, 'frieze', closed=True)
    body.sweep(ent[6:], ent_path, 'white', closed=True)
    if detail:   # сухарики под карнизом
        for x in [-W + 0.3 + i * 0.5 for i in range(int(2 * W / 0.5))]:
            deco.box((x, YF - 0.25 + 0.38, ZC + 2.22), (0.22, 0.26, 0.16), 'white')
    # потолок портика (кессоны)
    body.quad((-W, YF, ZC), (W, YF, ZC), (W, YW, ZC), (-W, YW, ZC), 'soffit')
    if detail:
        for i in range(10):   # балки потолка над колоннами
            body.box2((COL_X[i] - 0.35, YW, ZC - 0.45), (COL_X[i] + 0.35, YF - 0.25, ZC), 'white', skip=('t',))
        body.box2((-W, COL_Y - 0.4, ZC - 0.45), (W, COL_Y + 0.4, ZC), 'white', skip=('t',))

    # ---------------- колонны портика
    for x in COL_X:
        A.column(cols, x, COL_Y, S, ZC - S, 0.8, 'column', 'white', lod, mb_cap=deco)
    for s in (-1, 1):
        A.column(cols, s * COL_X[-1], 29.3, S, ZC - S, 0.8, 'column', 'white', lod, mb_cap=deco)
        # боковые лестницы портика (панорама 23)
        for i in range(nst):
            x0 = s * (W + 0.9 + i * 0.4)
            body.box2((min(x0, x0 + s * 0.4), YW + 0.6, -1.5), (max(x0, x0 + s * 0.4), YF - 2.4, S - (i + 1) * S / nst), 'steps', skip=('b',))

    # ---------------- пилястры
    Mfw = A.frame((0, YW, 0), (1, 0, 0), (0, 1, 0))
    for x in COL_X:
        A.pilaster(deco, Mfw, x, S, ZC, 1.15, 0.35, 'white', lod)
    nb = 11
    side_y = [YW - k * (YW - YR) / nb for k in range(nb + 1)]
    for s in (-1, 1):
        Ms = A.frame((s * W, 0, 0), (0, -s, 0), (s, 0, 0))   # x вдоль стены: при s=+1 идёт к −Y
        for y in side_y:
            A.pilaster(deco, Ms, -s * y, S, ZC, 1.15, 0.32, 'white', lod)
    Mr = A.frame((0, YR, 0), (-1, 0, 0), (0, -1, 0))
    for x in (-W + 0.6, -6.5, 6.5, W - 0.6):
        A.pilaster(deco, Mr, x, S, ZC, 1.15, 0.32, 'white', lod)

    # ---------------- окна и двери
    # главный фасад: двери в 5 центральных пролётах, арочные окна и аттиковые окна во всех 9
    mids = [(COL_X[i] + COL_X[i + 1]) / 2 for i in range(9)]
    for i, x in enumerate(mids):
        if abs(x) < 9:
            A.door(deco, Mfw, x, S, 2.0, 3.5, win, lod)
            if detail:   # фонари-бра между дверями
                for sx in (-1.2, 1.2):
                    deco.box((x + sx, 0.25, S + 3.6), (0.25, 0.25, 0.45), 'lamp', Mfw)
                    deco.box((x + sx, 0.25, S + 3.88), (0.32, 0.32, 0.1), 'iron', Mfw)
        else:
            A.window(deco, Mfw, x, S + 1.2, 1.3, 2.0, win, lod, lit='glass_dim')
        A.window(deco, Mfw, x, 7.0, 2.0, 5.8, win, lod, arch=True, mullions=(1, 3))
        A.window(deco, Mfw, x, 14.6, 1.1, 1.05, win, lod, mullions=(1, 0), sill=False, lit='glass_dim')
    # боковые фасады: в каждом простенке между пилястрами — окно 1-го этажа, арочное окно, аттиковое
    for s in (-1, 1):
        Ms = A.frame((s * W, 0, 0), (0, -s, 0), (s, 0, 0))
        for k in range(nb):
            y = (side_y[k] + side_y[k + 1]) / 2
            x = -s * y
            A.window(deco, Ms, x, 1.7, 1.3, 1.9, win, lod, lit='glass_dim' if k % 3 else 'glass_dark')
            A.window(deco, Ms, x, 7.0, 2.0, 5.8, win, lod, arch=True, mullions=(1, 3), lit='glass' if k % 4 != 3 else 'glass_dark')
            A.window(deco, Ms, x, 14.6, 1.1, 1.05, win, lod, mullions=(1, 0), sill=False, lit='glass_dim' if k % 2 else 'glass_dark')
    # задний фасад: служебный, сетка окон
    for x in (-15.0, -11.0, -2.0, 2.0, 11.0, 15.0):   # задний фасад
        for z, h in ((1.7, 1.8), (6.6, 2.1), (10.8, 2.1), (14.6, 1.05)):
            A.window(deco, Mr, x, z, 1.3, h, win, lod, mullions=(1, 1), lit='glass_dim' if (int(x) + int(z)) % 3 else 'glass_dark')

    # ---------------- фронтон
    yt = YF - 0.25
    tp = [(-W, ZE), (W, ZE), (0.0, ZR - 0.9)]
    # тимпан (утоплен) — треугольник
    body.add([(-W, yt - 0.05, ZE), (W, yt - 0.05, ZE), (0.0, yt - 0.05, ZR - 0.9)], [[0, 2, 1]], 'white')
    slope = math.atan2(ZR - ZE - 0.9, W)
    for s in (-1, 1):   # наклонные карнизы спереди и сзади
        for yy, ln in ((yt, 1.25), (YR, 1.0)):
            M = Matrix.Translation((s * W / 2, yy, (ZE + ZR - 0.9) / 2 + 0.1)) @ Matrix.Rotation(s * slope, 4, 'Y')
            Lr = math.hypot(W, ZR - ZE - 0.9) + 1.2
            yc = 0.3 if yy == yt else -0.3
            body.box((0, yc, 0.0), (Lr, 1.4, 0.75), 'white', M)
            body.box((0, yc * 1.1, 0.45), (Lr + 0.2, 1.6, 0.25), 'white', M)
    # задний щипец — сплошная стена
    body.add([(-W, YR, ZE), (0.0, YR, ZR - 0.9), (W, YR, ZE)], [[0, 2, 1]], 'wall')
    if detail:
        # барельеф в тимпане: венок, знамёна и фигуры — низкий рельеф из метаболлов
        els = []
        for k in range(-7, 8):
            t = k / 7.5
            zz = ZE + 1.1 + (1 - abs(t)) * 2.6
            els.append(('ELLIPSOID', (t * 13.5, yt - 0.05, zz), 1.0, (1.3, 0.22, 0.9 + 0.8 * (1 - abs(t))), None))
        els.append(('ELLIPSOID', (0.0, yt - 0.05, ZE + 2.6), 1.0, (1.9, 0.4, 1.9), None))
        for s in (-1, 1):
            els.append(('ELLIPSOID', (s * 4.5, yt - 0.05, ZE + 2.1), 1.0, (2.6, 0.32, 0.8), None))
        me = L.metaball_mesh(els, resolution=0.22, threshold=0.6, decimate=2600)
        deco.from_object_mesh(me, 'relief')
        L.bpy.data.meshes.remove(me)
        # надписи на фризе в реальности нет (панорамы 19, 21) — не ставим

    # ---------------- кровля: двускатная, от карниза до конька
    eo = 1.05
    for s in (-1, 1):
        a = (s * (W + eo), YR - eo, ZE); b = (s * (W + eo), YF + 0.8, ZE); c = (0.0, YF + 0.8, ZR); d = (0.0, YR - eo, ZR)
        if s > 0:
            roof.quad(a, b, c, d, 'roof')
        else:
            roof.quad(b, a, d, c, 'roof')
    roof.box((0, (YF + YR) / 2, ZR + 0.12), (0.5, YF - YR + 1.6, 0.3), 'roof', skip=('b',))
    if detail:   # снегозадержатели/вентвыходы на кровле
        for y in (-20, -6, 6, 18):
            for s in (-1, 1):
                roof.box((s * 9.5, y, ZE + (ZR - ZE) * (1 - 9.5 / (W + eo)) + 0.5), (0.9, 0.9, 1.0), 'roof', skip=('b',))

    meshes = [body, cols, deco, roof, hidden]
    boxes = [
        ((0, (YR + YF) / 2 - 0.3, (ZR - 3.0) / 2), (2 * (W + 1.0), YF - YR + 1.2, ZR + 3.0), 0.0),
        ((0, YF + 0.7 + nst * 0.2, -0.5), (2 * (W + 0.9), nst * 0.4 + 0.2, 3.0), 0.0),
    ]
    # ночные пятна света на земле (координаты glTF модели: x, y вверх, z = −y Blender), радиус и сила
    pools = [[x, 0.0, -(YF + 4.5), 8.5, 0.9] for x in (-14.0, -7.0, 0.0, 7.0, 14.0)]
    pools += [[s * (W + 3.5), 0.0, -y, 7.0, 0.5] for s in (-1, 1) for y in (18.0, 0.0, -18.0)]
    info = dict(INFO, size=[2 * (W + eo), ZR, YF - YR + 3.2], pools=pools,
                footprint=[[-W - 1.0, -(YF + 0.8 + nst * 0.4)], [W + 1.0, -(YF + 0.8 + nst * 0.4)], [W + 1.0, -(YR - 1.0)], [-W - 1.0, -(YR - 1.0)]],
                extraFootprints=[[[s * (W + 0.9), -(YW + 0.6)], [s * (W + 3.4), -(YW + 0.6)], [s * (W + 3.4), -(YF - 2.4)], [s * (W + 0.9), -(YF - 2.4)]] for s in (-1, 1)])
    return meshes, boxes, info
