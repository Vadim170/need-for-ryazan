# Памятник В. И. Ленину на площади Ленина (OSM n736442710, historic=monument, monument=statue; wikidata Q116669130).
# Источники: панорамы Яндекса 2024–2026 гг. (data/raw/panoramas/landmarks/lenin_monument/crops/ 13–16 и 18–19 — фас,
# 06–08 — со спины), ортофото 0.25 м (гранитная платформа 18 × 8.7 м, длинной стороной север–юг, центр x −820.8, y −787.0).
# Фигура смотрит на запад (к Соборной ул.), правая рука вытянута вперёд-вправо и вверх (на северо-запад).
# Размеры по панорамам (относительно платформы ~18 м в кадре): платформа ~0.75 м со ступенями спереди, постамент —
# усечённая пирамида из красного гранита ~5.6 м, бронзовая фигура в пальто ~5.2 м. Итого ~11.5 м (с рукой ~12 м).
# Блендер: перёд = +Y (запад, азимут 270°), +X = правая рука фигуры (север). Начало — центр платформы на уровне площади.
import math
from mathutils import Matrix, Vector
import lmlib as L

INFO = {'name': 'Памятник В. И. Ленину', 'osm': ['n736442710']}

PX, PY = 9.0, 4.35        # полуразмеры платформы
ZP = 0.75                 # верх платформы
PED_Y = -1.0              # центр постамента
Z_TOP = 5.85              # верх постамента (фигура ≈ постамент по высоте, панорамы 07, 13, 14)
FIG_H = 5.6               # высота фигуры


def figure_parts():
    """Фигура в пальто, рост 1.75 м (масштабируется до FIG_H). Перёд +Y, правая рука +X."""
    P = []
    ell = lambda c, r, R=None: P.append(('ell', c, r, R))
    cap = lambda a, b, r0, r1: P.append(('cap', a, b, r0, r1))
    # ботинки и брюки (левая нога выставлена вперёд)
    ell((0.11, -0.02, 0.05), (0.065, 0.14, 0.055)); ell((-0.1, 0.13, 0.05), (0.065, 0.14, 0.055))
    cap((0.11, -0.03, 0.08), (0.11, -0.02, 0.5), 0.065, 0.075)
    cap((-0.1, 0.11, 0.08), (-0.1, 0.06, 0.5), 0.065, 0.075)
    # пальто: расклёшенные полы (эллиптическое сечение — три усечённых конуса со сдвигом по X), корпус, плечи
    for x in (-0.075, 0.0, 0.075):
        cap((x, 0.03, 0.4), (x * 0.8, 0.0, 1.0), 0.19, 0.15)
        cap((x * 0.8, 0.0, 1.0), (x, 0.0, 1.38), 0.15, 0.135)
    cap((-0.05, 0.13, 0.42), (-0.04, 0.06, 0.95), 0.09, 0.07)        # левая пола вперёд за шагом
    ell((0.0, 0.03, 1.27), (0.2, 0.14, 0.17))                         # грудь
    cap((-0.19, 0.0, 1.4), (0.19, 0.0, 1.4), 0.075, 0.075)            # плечи
    ell((0.07, 0.11, 1.32), (0.06, 0.035, 0.11))                      # лацканы
    ell((-0.07, 0.11, 1.32), (0.06, 0.035, 0.11))
    ell((0.0, -0.035, 1.46), (0.1, 0.075, 0.05))                      # воротник
    cap((0.0, 0.0, 1.44), (0.0, 0.01, 1.55), 0.055, 0.05)              # шея
    # голова: череп, лицо, бородка
    ell((0.0, 0.0, 1.645), (0.082, 0.1, 0.105))
    ell((0.0, 0.045, 1.6), (0.07, 0.06, 0.07))
    ell((0.0, 0.075, 1.555), (0.04, 0.035, 0.04))
    ell((0.0, 0.098, 1.615), (0.014, 0.02, 0.022))      # нос
    for s in (-1, 1):
        ell((s * 0.082, 0.0, 1.63), (0.015, 0.025, 0.03))   # уши
    # правая рука: вперёд-вправо и вверх (указывающий жест)
    yaw, el_a = math.radians(50), math.radians(36)
    d = Vector((math.sin(yaw) * math.cos(el_a), math.cos(yaw) * math.cos(el_a), math.sin(el_a)))
    sh = Vector((0.2, 0.0, 1.41))
    el = sh + d * 0.3
    d2 = Vector((d.x, d.y, d.z + 0.08)).normalized()
    wr = el + d2 * 0.27
    cap(tuple(sh), tuple(el), 0.075, 0.064)
    cap(tuple(el), tuple(wr), 0.064, 0.05)
    hand = wr + d2 * 0.07
    R = Vector((0, 1, 0)).rotation_difference(d2).to_matrix()
    ell(tuple(hand), (0.035, 0.07, 0.045), R)
    # левая рука: опущена, кепка в руке у бедра
    shl = Vector((-0.2, 0.0, 1.41)); ell_ = Vector((-0.24, -0.01, 1.14)); wl = Vector((-0.21, 0.07, 0.94))
    cap(tuple(shl), tuple(ell_), 0.075, 0.064)
    cap(tuple(ell_), tuple(wl), 0.064, 0.05)
    ell(tuple(wl + Vector((0.0, 0.03, -0.05))), (0.04, 0.05, 0.06))
    ell((-0.19, 0.12, 0.88), (0.085, 0.03, 0.075))      # кепка
    return P


def build(lod):
    detail = lod == 0
    L.material('granite', (0.46, 0.25, 0.21), role='stone', kind='granite', var=0.12, wash=(0.45, ZP, 4.0))
    L.material('granite_dark', (0.36, 0.2, 0.17), role='stone', kind='granite', var=0.12, wash=(0.3, ZP, 3.0))
    L.material('platform', (0.5, 0.31, 0.27), role='stone', kind='granite', var=0.1)
    L.material('bronze', (0.26, 0.21, 0.15), role='bronze', kind='bronze', wash=(0.5, Z_TOP, 3.5))
    L.material('soil', (0.18, 0.12, 0.08), kind='plain', var=0.2)
    L.material('flowers', (0.78, 0.06, 0.08), kind='flowers')
    L.material('lamp', (0.9, 0.9, 0.85), role='glass', emit=(1.0, 0.9, 0.75, 1.0))
    L.material('iron', (0.08, 0.08, 0.08), role='metal', kind='plain', var=0.05)

    base = L.Mesh('base')
    ped = L.Mesh('pedestal')
    deco = L.Mesh('decor', palette=True)
    fig = L.Mesh('figure')

    # ---------------- платформа со ступенями и цветочницами
    ys = 2.0                    # край верхней площадки
    base.box2((-PX, -PY, -1.2), (PX, ys, ZP), 'platform', skip=('b',))
    nst = 5
    for i in range(nst):
        y0 = ys + i * (PY - ys) / nst
        base.box2((-5.0, y0, -1.2), (5.0, y0 + (PY - ys) / nst, ZP - (i + 1) * ZP / nst), 'platform', skip=('b',))
    for s in (-1, 1):
        base.box2((s * 5.0, ys, -1.2), (s * PX, PY, ZP), 'platform', skip=('b',))
    planters = [(-6.9, 3.15), (6.9, 3.15), (-7.8, -3.1), (7.8, -3.1)]
    for x, y in planters:
        base.box((x, y, ZP + 0.35), (1.5, 1.5, 0.7), 'granite_dark', skip=('b',))
        deco.box((x, y, ZP + 0.66), (1.3, 1.3, 0.04), 'soil')
    # ---------------- постамент: база, усечённая пирамида, карниз
    base.box((0, PED_Y, ZP + 0.25), (5.0, 4.4, 0.5), 'granite_dark', skip=('b',))
    z0, z1 = ZP + 0.5, Z_TOP - 0.35
    bx0, by0, bx1, by1 = 2.15, 1.85, 1.5, 1.3
    v = [(-bx0, PED_Y - by0, z0), (bx0, PED_Y - by0, z0), (bx0, PED_Y + by0, z0), (-bx0, PED_Y + by0, z0),
         (-bx1, PED_Y - by1, z1), (bx1, PED_Y - by1, z1), (bx1, PED_Y + by1, z1), (-bx1, PED_Y + by1, z1)]
    ped.add(v, [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], 'granite')
    ped.box((0, PED_Y, z1 + 0.175), (3.3, 2.9, 0.35), 'granite', skip=('b',))
    if detail:   # швы между гранитными блоками (выступающие пояски) и эмблема
        for zz in (2.6, 4.3):
            t = (zz - z0) / (z1 - z0)
            hx = bx0 + (bx1 - bx0) * t; hy = by0 + (by1 - by0) * t
            ped.box((0, PED_Y, zz), (2 * hx + 0.06, 2 * hy + 0.06, 0.06), 'granite_dark', skip=('b', 't'))
        em = L.sculpt_mesh([('ell', (0, 0, 0), (0.45, 0.06, 0.45), None), ('ell', (0, 0.03, 0.05), (0.25, 0.06, 0.3), None)],
                           voxel=0.03, smooth=2, target_tris=600)
        t = (4.9 - z0) / (z1 - z0)
        deco.from_object_mesh(em, 'bronze', Matrix.Translation((0, PED_Y + by0 + (by1 - by0) * t + 0.02, 4.9)))
        L.bpy.data.meshes.remove(em)
    # ---------------- фигура
    k = FIG_H / 1.75
    me = L.sculpt_mesh(figure_parts(), voxel=0.016 if detail else 0.03, smooth=5, target_tris=15000 if detail else 2500, scale=k,
                       M=Matrix.Translation((0, PED_Y, Z_TOP - 0.05)) @ Matrix.Diagonal((1.22, 1.22, 1.0, 1.0)))   # фигура в пальто массивнее (панорамы 07, 14)
    fig.from_object_mesh(me, 'bronze')
    L.bpy.data.meshes.remove(me)
    fig.box((0, PED_Y, Z_TOP + 0.1), (1.7, 1.4, 0.3), 'bronze', skip=('b',))   # бронзовая плинта
    # ---------------- цветы и прожекторы
    if detail:
        fl = []
        for x, y in planters:
            for i in range(14):
                a = i * 2.4; r = 0.15 + 0.4 * ((i * 7) % 5) / 5
                fl.append(('ell', (x + r * math.cos(a), y + r * math.sin(a), ZP + 0.78), (0.2, 0.2, 0.13), None))
        me = L.sculpt_mesh(fl, voxel=0.08, smooth=1, target_tris=2400)
        deco.from_object_mesh(me, 'flowers')
        L.bpy.data.meshes.remove(me)
        for x, y in ((-3.2, 1.6), (3.2, 1.6), (-3.2, -3.6), (3.2, -3.6)):
            deco.box((x, y, ZP + 0.12), (0.35, 0.25, 0.24), 'iron')
            deco.box((x, y + (0.13 if y > 0 else -0.13), ZP + 0.15), (0.28, 0.02, 0.16), 'lamp')

    meshes = [base, ped, deco, fig]
    boxes = [((0, 0, (ZP - 1.2) / 2), (2 * PX, 2 * PY, ZP + 1.2), 0.0),
             ((0, PED_Y, Z_TOP / 2), (4.4, 3.8, Z_TOP), 0.0)]
    pools = [[0.0, 0.0, -(PY + 2.5), 6.5, 0.8], [-5.0, 0.0, -(PY + 1.0), 4.5, 0.5], [5.0, 0.0, -(PY + 1.0), 4.5, 0.5]]
    info = dict(INFO, size=[2 * PX, Z_TOP + FIG_H + 0.8, 2 * PY], pools=pools,
                footprint=[[-PX - 0.3, -(PY + 0.3)], [PX + 0.3, -(PY + 0.3)], [PX + 0.3, PY + 0.3], [-PX - 0.3, PY + 0.3]])
    return meshes, boxes, info
