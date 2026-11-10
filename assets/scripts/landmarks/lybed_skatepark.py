# Скейтпарк и памп-трек на Лыбедском бульваре (OSM w1424802275: leisure=pitch, sport=skateboard;bmx,
# «Бетонный скейтпарк и асфальтовый памптрек на Лыбедском бульваре»; спортзона 3-й очереди, 2023 г.).
# Источники: ортофото 0.25 м (data/processed/lybed/skate_local.png — бетонная площадка ~31 × 32 м, повёрнута на ~58°,
# асфальтовая петля памп-трека к северо-востоку), панорамы Яндекса 2025-12 / 2026-03 (data/raw/panoramas/lybed/crops/
# skatepark/: 02 — два длинных рельса и серая разгонка; 04, 05 — разгонка с «пиксельной» росписью синий/розовый/белый;
# 00, 01 — тёмные асфальтовые бугры памп-трека с жёлтой полосой по кромке; 12 — рельсы, лавки).
# Оси (Blender): X — восток, Y — север, начало — якорь (−625, −1170) мира на уровне рельефа.
import math
from mathutils import Vector
import lmlib as L

INFO = {'name': 'Скейтпарк и памп-трек (Лыбедский бульвар)', 'osm': ['w1424802275']}

# площадка: центр, оси U (на СВ) и V (на ЮВ), полуразмеры
PC = (1.5, -13.0)
_u = Vector((16.5, 26.5)).normalized()
UX, UY = _u.x, _u.y
VX, VY = _u.y, -_u.x
HU, HV = 15.5, 16.0
# памп-трек: «стадион» (две прямые + два полукруга) с центром PT, полуоси, поворот
PT = (14.0, 21.0)
PT_R = 7.0            # радиус поворотов по оси трека
PT_HALF = 9.0         # полудлина прямых
PT_ROT = math.radians(-10)
PT_W = 2.6
POLY = [(6.7, 36.5), (15.5, 45.0), (27.1, 41.1), (23.8, 33.8), (19.4, 14.1), (22.0, -9.5), (23.8, -16.5), (-12.6, -42.3), (-32.1, -17.1)]


def uv(U, V):
    return (PC[0] + U * UX + V * VX, PC[1] + U * UY + V * VY)


def mats():
    L.material('concrete', (0.7, 0.69, 0.66), role='stone', kind='plain', var=0.07)
    L.material('concrete_dark', (0.55, 0.55, 0.53), role='stone', kind='plain', var=0.08)
    L.material('asphalt', (0.2, 0.2, 0.21), role='stone', kind='plain', var=0.1)
    L.material('stripe', (0.92, 0.75, 0.1), kind='plain', var=0.03)
    L.material('steel', (0.55, 0.57, 0.6), role='metal', kind='plain', var=0.03)
    for name, c in (('px_blue', (0.12, 0.33, 0.78)), ('px_lblue', (0.35, 0.6, 0.92)), ('px_pink', (0.92, 0.45, 0.55)),
                    ('px_white', (0.93, 0.93, 0.92)), ('px_navy', (0.1, 0.16, 0.45))):
        L.material(name, c, kind='plain', var=0.03)


def quad(M, a, b, c, d, mat):
    M.add([a, b, c, d], [[0, 1, 2, 3]], mat)


def wedge(M, boxes, U0, U1, V0, depth, h, facing, mural=False):
    """Разгонка-клин вдоль U: высокая кромка на V0, скат к V0 + facing·depth."""
    V1 = V0 + facing * depth
    p = lambda U, V, z: (*uv(U, V), z)
    a0, a1 = p(U0, V0, h), p(U1, V0, h)
    b0, b1 = p(U0, V1, 0.0), p(U1, V1, 0.0)
    g0, g1 = p(U0, V0, 0.0), p(U1, V0, 0.0)
    order = (lambda q: q) if facing > 0 else (lambda q: q[::-1])
    if mural:   # пиксельная роспись: клетки 0.6 × 0.4 м
        nu, nv = int((U1 - U0) / 0.6), 4
        pal = ['px_blue', 'px_lblue', 'px_pink', 'px_white', 'px_navy']
        for i in range(nu):
            for j in range(nv):
                t0, t1 = j / nv, (j + 1) / nv
                ua, ub = U0 + (U1 - U0) * i / nu, U0 + (U1 - U0) * (i + 1) / nu
                q = [p(ua, V0 + facing * depth * t0, h * (1 - t0)), p(ub, V0 + facing * depth * t0, h * (1 - t0)),
                     p(ub, V0 + facing * depth * t1, h * (1 - t1)), p(ua, V0 + facing * depth * t1, h * (1 - t1))]
                k = (i * 7 + j * 3 + (i // 3) * 5) % 9
                col = pal[0] if k < 3 else pal[1] if k < 5 else pal[2] if k < 7 else pal[3] if k < 8 else pal[4]
                if (i + 2 * j) % 11 == 0:
                    col = 'px_white'
                M.add(order(q), [[0, 1, 2, 3]], col)
    else:
        M.add(order([a0, a1, b1, b0]), [[0, 1, 2, 3]], 'concrete')
    M.add(order([g1, g0, a0, a1]), [[0, 1, 2, 3]], 'concrete_dark')       # задняя стенка
    M.add([g0, b0, a0], [[0, 1, 2]] if facing > 0 else [[2, 1, 0]], 'concrete_dark')
    M.add([g1, a1, b1], [[0, 1, 2]] if facing > 0 else [[2, 1, 0]], 'concrete_dark')
    M.add(order([a0, a1, p(U1, V0 - facing * 0.06, h), p(U0, V0 - facing * 0.06, h)]), [[0, 1, 2, 3]], 'steel')  # копинг
    ang = math.atan2(h, depth)
    rz = math.atan2(UY, UX)
    cu, cv = (U0 + U1) / 2, V0 + facing * depth / 2
    c = uv(cu, cv)
    # коллайдер: наклонная плита по скату (поворот вокруг оси U)
    th = 0.3
    boxes.append(((c[0], c[1], h / 2 - th / (2 * math.cos(ang))), (U1 - U0, math.hypot(depth, h), th), (facing * ang, 0.0, rz)))
    boxes.append(((*uv(cu, V0 - facing * 0.15), h / 2), (U1 - U0, 0.3, h), rz))


def box_uv(M, boxes, U, V, su, sv, h, mat, z0=0.0, collide=True):
    c = uv(U, V)
    rz = math.atan2(UY, UX)
    from mathutils import Matrix
    T = Matrix.Translation((c[0], c[1], z0 + h / 2)) @ Matrix.Rotation(rz, 4, 'Z')
    M.box((0, 0, 0), (su, sv, h), mat, M=T, skip=('b',))
    if collide:
        boxes.append(((c[0], c[1], z0 + h / 2), (su, sv, h), rz))


def rail(M, boxes, U0, U1, V, h):
    from mathutils import Matrix
    rz = math.atan2(UY, UX)
    c = uv((U0 + U1) / 2, V)
    T = Matrix.Translation((c[0], c[1], 0)) @ Matrix.Rotation(rz, 4, 'Z')
    M.box((0, 0, h - 0.025), (U1 - U0, 0.06, 0.05), 'steel', M=T)
    for u in (U0 + 0.3, (U0 + U1) / 2, U1 - 0.3):
        M.box((u - (U0 + U1) / 2, 0, (h - 0.05) / 2), (0.05, 0.05, h - 0.05), 'steel', M=T, skip=('b', 't'))
    boxes.append(((c[0], c[1], h / 2), (U1 - U0, 0.12, h), rz))


def quarter(M, boxes, Uc, V0, V1, h, r, facing):
    """Квотер вдоль V на U = Uc, обращён к −facing·U (дуга радиуса r, площадка сверху 1 м)."""
    from mathutils import Matrix
    n = 10
    rz = math.atan2(UY, UX)
    pts = []
    for k in range(n + 1):
        a = (math.pi / 2) * k / n
        x = r * math.sin(a)
        z = r * (1 - math.cos(a))
        if z > h:
            break
        pts.append((x, z))
    pts.append((pts[-1][0] + 1.0, pts[-1][1]))
    off = lambda du: Uc + facing * (du - r)
    rows = [[(*uv(off(du), v), z) for du, z in pts] for v in (V0, V1)]
    for k in range(len(pts) - 1):
        q = [rows[0][k], rows[0][k + 1], rows[1][k + 1], rows[1][k]]
        M.add(q if facing < 0 else q[::-1], [[0, 1, 2, 3]], 'concrete')
    top_u = off(pts[-1][0]); zt = pts[-1][1]
    for v0, v1 in ((V0, V1),):
        back = [(*uv(top_u, v0), 0.0), (*uv(top_u, v1), 0.0), (*uv(top_u, v1), zt), (*uv(top_u, v0), zt)]
        M.add(back if facing > 0 else back[::-1], [[0, 1, 2, 3]], 'concrete_dark')
    for v, sgn in ((V0, -1), (V1, 1)):
        side = [(*uv(off(du), v), z) for du, z in pts] + [(*uv(top_u, v), 0.0), (*uv(off(0), v), 0.0)]
        M.add(side, [list(range(len(side)))] if sgn * facing > 0 else [list(range(len(side)))[::-1]], 'concrete_dark')
    # коллайдеры: ступенчатые наклонные плиты по дуге
    for k in range(len(pts) - 2):
        (x0, z0), (x1, z1) = pts[k], pts[k + 1]
        ang = math.atan2(z1 - z0, x1 - x0)
        cu = off((x0 + x1) / 2)
        c = uv(cu, (V0 + V1) / 2)
        L_ = math.hypot(x1 - x0, z1 - z0)
        th = 0.3
        boxes.append(((c[0], c[1], (z0 + z1) / 2 - th / (2 * math.cos(ang))), (L_, V1 - V0, th), (0.0, -facing * ang, rz)))
    c = uv((off(pts[-2][0]) + top_u) / 2, (V0 + V1) / 2)
    boxes.append(((c[0], c[1], zt / 2), (1.0, V1 - V0, zt), rz))


def pumptrack(M, boxes, detail):
    """Петля памп-трека: тёмный асфальт, бугры на прямых (0.55 м, шаг 4.5 м), виражи 0.9 м в поворотах, жёлтые кромки."""
    cr, sr = math.cos(PT_ROT), math.sin(PT_ROT)
    loc = lambda a, b: (PT[0] + a * cr - b * sr, PT[1] + a * sr + b * cr)
    per = 4 * PT_HALF + 2 * math.pi * PT_R
    ns = int(per / (0.6 if detail else 1.5))
    samples = []
    for i in range(ns + 1):
        s = per * i / ns
        if s < 2 * PT_HALF:                       # правая прямая (вверх по +b)
            a, b, ta, tb, kind, t = PT_R, -PT_HALF + s, 0, 1, 'str', s
        elif s < 2 * PT_HALF + math.pi * PT_R:    # верхний поворот
            q = (s - 2 * PT_HALF) / PT_R
            a, b, ta, tb, kind, t = PT_R * math.cos(q), PT_HALF + PT_R * math.sin(q), -math.sin(q), math.cos(q), 'turn', q
        elif s < 4 * PT_HALF + math.pi * PT_R:
            s2 = s - 2 * PT_HALF - math.pi * PT_R
            a, b, ta, tb, kind, t = -PT_R, PT_HALF - s2, 0, -1, 'str', s2
        else:
            q = (s - 4 * PT_HALF - math.pi * PT_R) / PT_R + math.pi
            a, b, ta, tb, kind, t = PT_R * math.cos(q), -PT_HALF + PT_R * math.sin(q), -math.sin(q), math.cos(q), 'turn', q - math.pi
        if kind == 'str':
            z = 0.12 + 0.55 * max(0.0, math.sin(math.pi * (t - 1.0) / 2.25)) ** 1.5 if 1.0 < t < 2 * PT_HALF - 1.0 else 0.12
            bank = 0.0
        else:
            z = 0.25; bank = 0.9 * math.sin(t) ** 0.5
        na, nb = tb, -ta          # нормаль наружу (вправо от движения при обходе против часовой)
        samples.append((a, b, na, nb, z, bank))
    rows = []
    hw = PT_W / 2
    for a, b, na, nb, z, bank in samples:
        r = []
        for off, dz in ((-hw - 1.0, -0.1), (-hw, z), (-hw + 0.12, z + 0.0), (hw - 0.12, z + bank), (hw, z + bank), (hw + 1.2, -0.1)):
            if off == hw - 0.12 or off == hw:
                zz = z + bank * (off + hw) / PT_W
            elif off == -hw + 0.12:
                zz = z + bank * (off + hw) / PT_W
            else:
                zz = dz if off in (-hw - 1.0, hw + 1.2) else z
            r.append((*loc(a + na * off, b + nb * off), zz + 0.02))
        rows.append(r)
    mats_row = ['concrete_dark', 'stripe', 'asphalt', 'stripe', 'asphalt']
    for i in range(len(rows) - 1):
        for k in range(5):
            q = [rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]]
            M.add(q[::-1], [[0, 1, 2, 3]], 'asphalt' if k in (0, 4) else mats_row[k])
    # коллайдеры: наклонные плиты по сегментам ~2 м
    step = max(1, int(2.0 / (per / ns)))
    for i in range(0, len(samples) - step, step):
        a0, b0, na, nb, z0, bk0 = samples[i]
        a1, b1, _, _, z1, bk1 = samples[i + step]
        p0, p1 = loc(a0, b0), loc(a1, b1)
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        Lseg = math.hypot(dx, dy)
        yaw = math.atan2(dy, dx)
        pitch = math.atan2(z1 - z0, Lseg)
        roll = math.atan2((bk0 + bk1) / 2, PT_W)
        th = 0.4
        cz = (z0 + z1) / 2 + (bk0 + bk1) / 4 - th / 2
        c = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
        boxes.append(((c[0], c[1], cz), (Lseg + 0.2, PT_W, th), (-roll, -pitch, yaw)))


def build(lod):
    detail = lod == 0
    mats()
    pad = L.Mesh('pad', uvk=0.5)
    obs = L.Mesh('obstacles')
    pt = L.Mesh('pumptrack', uvk=0.6)
    met = L.Mesh('metal', palette=True)
    boxes = []
    # бетонная площадка (+4 см над рельефом)
    corners = [uv(-HU, -HV), uv(HU, -HV), uv(HU, HV), uv(-HU, HV)]
    c4 = [(x, y, 0.14) for x, y in corners]
    for i in range(4):   # кромка плиты (рельеф под площадкой неровный ±0.1 м)
        (x0, y0), (x1, y1) = corners[i], corners[(i + 1) % 4]
        pad.add([(x0, y0, -0.3), (x1, y1, -0.3), (x1, y1, 0.14), (x0, y0, 0.14)], [[3, 2, 1, 0]], 'concrete_dark')
    boxes.append(((PC[0], PC[1], -0.1), (2 * HU, 2 * HV, 0.48), math.atan2(UY, UX)))
    pad.add(c4, [[0, 3, 2, 1]] if (UX * VY - UY * VX) < 0 else [[0, 1, 2, 3]], 'concrete')
    # разгонки, фанбокс, рельсы, квотер, маниал-пад (раскладка по фото 2025-12 / 2026-03)
    # разгонка с «пиксельной» росписью — на юго-восточной кромке, скатом наружу к аллее (панорама 2026-03
    # 1310802648…: роспись видна с дорожки в нескольких метрах, длина ~12 м, высота ~1.2 м)
    wedge(obs, boxes, 1.0, 13.0, HV - 2.6, 2.6, 1.2, +1, mural=True)
    wedge(obs, boxes, -12.0, -2.0, -13.0, 2.2, 0.9, +1)                   # серая разгонка у северо-западной кромки
    box_uv(obs, boxes, 1.0, 0.0, 6.0, 3.4, 0.6, 'concrete')               # фанбокс: верх
    for sgn in (-1, 1):                                                     # пандусы фанбокса по торцам (вдоль U)
        u0 = 1.0 + sgn * 3.0
        from mathutils import Matrix
        rz = math.atan2(UY, UX)
        a = [(*uv(u0, -1.7), 0.6), (*uv(u0, 1.7), 0.6), (*uv(u0 + sgn * 1.8, 1.7), 0.0), (*uv(u0 + sgn * 1.8, -1.7), 0.0)]
        obs.add(a if sgn > 0 else a[::-1], [[0, 1, 2, 3]], 'concrete')
        for v in (-1.7, 1.7):
            tri = [(*uv(u0, v), 0.0), (*uv(u0, v), 0.6), (*uv(u0 + sgn * 1.8, v), 0.0)]
            obs.add(tri, [[0, 1, 2]] if v * sgn > 0 else [[2, 1, 0]], 'concrete_dark')
        ang = math.atan2(0.6, 1.8)
        cc = uv(u0 + sgn * 0.9, 0)
        boxes.append(((cc[0], cc[1], 0.3 - 0.15), (math.hypot(1.8, 0.6), 3.4, 0.3), (0.0, sgn * ang, rz)))
    rail(met, boxes, -10.0, -3.0, -3.5, 0.35)
    rail(met, boxes, -10.0, -3.0, 3.5, 0.35)
    box_uv(obs, boxes, 8.5, -7.0, 5.0, 1.3, 0.4, 'concrete_dark')          # маниал-пад
    quarter(obs, boxes, 14.5, -6.0, 6.0, 1.5, 2.6, +1)                    # квотер у СВ края площадки
    pumptrack(pt, boxes, detail)
    meshes = [pad, obs, pt, met]
    fp = [[x, -y] for x, y in POLY]            # футпринт в glTF (x, z = −Y)
    info = dict(INFO, size=[60.0, 1.6, 88.0], pools=[], footprint=fp)
    return meshes, (boxes if detail else []), info
