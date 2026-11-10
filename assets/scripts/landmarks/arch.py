# Архитектурные элементы для hero-моделей: колонны (коринфские, упрощённые), пилястры, окна, карнизы.
# Все функции пишут в lmlib.Mesh; координаты Blender (Z вверх).
import math
from mathutils import Matrix, Vector


def frame(origin, u, n):
    """Матрица «стены»: локальные x — вдоль стены (u), y — наружу (n), z — вверх; origin — точка на стене (z = 0)."""
    u = Vector(u).normalized(); n = Vector(n).normalized()
    z = Vector((0, 0, 1))
    if u.cross(n).dot(z) < 0.99:
        raise ValueError('frame: тройка (u, n, z) должна быть правой (n = поворот u на 90° против часовой)')
    M = Matrix.Identity(4)
    for i in range(3):
        M[i][0], M[i][1], M[i][2], M[i][3] = u[i], n[i], z[i], origin[i]
    return M


def column(mb, x, y, z0, h, r0, mat, mat_cap=None, lod=0, base=True, capital='corinthian', mb_cap=None):
    """Колонна с энтазисом: база (плинт + торы), ствол, капитель. h — от низа плинта до верха абаки."""
    mat_cap = mat_cap or mat
    mc = mb_cap or mb
    n = 24 if lod == 0 else 10
    T = Matrix.Translation((x, y, z0))
    cap_h = 1.9 if capital == 'corinthian' else 0.6
    zb = 0.0
    if base:
        pl = r0 * 1.28
        mc.box((x, y, z0 + 0.15), (2 * pl, 2 * pl, 0.3), mat_cap, skip=('b',))
        if lod == 0:
            mb.lathe([(r0 * 1.22, 0.3), (r0 * 1.24, 0.36), (r0 * 1.2, 0.44), (r0 * 1.08, 0.48), (r0 * 1.1, 0.53),
                      (r0 * 1.12, 0.6), (r0 * 1.04, 0.66), (r0 * 1.0, 0.7)], n, mat, T)
        else:
            mb.lathe([(r0 * 1.15, 0.3), (r0 * 1.15, 0.5), (r0, 0.7)], n, mat, T)
        zb = 0.7
    zs1 = h - cap_h
    prof = []
    k = 8 if lod == 0 else 3
    for i in range(k + 1):
        t = i / k
        r = r0 * (1 - 0.15 * max(0.0, (t - 0.33) / 0.67) ** 1.4)   # утонение с трети высоты
        prof.append((r, zb + (zs1 - zb) * t))
    mb.lathe(prof, n, mat, T)
    rt = prof[-1][0]
    if capital == 'corinthian':
        corinthian_capital(mc, x, y, z0 + zs1, cap_h, rt, mat_cap, lod)
    else:
        mc.lathe([(rt, 0), (rt * 1.12, 0.12), (rt * 1.12, 0.2), (rt, 0.25)], n, mat_cap, Matrix.Translation((x, y, z0 + zs1)))
        mc.box((x, y, z0 + h - 0.17), (rt * 2.6, rt * 2.6, 0.34), mat_cap)
    return n


def corinthian_capital(mb, x, y, z0, h, r, mat, lod=0):
    T = Matrix.Translation((x, y, z0))
    n = 24 if lod == 0 else 10
    # астрагал и колокол (калаф)
    mb.lathe([(r, 0), (r * 1.1, 0.05), (r * 1.1, 0.13), (r, 0.18), (r * 0.98, 0.2), (r * 1.08, h * 0.55), (r * 1.32, h - 0.3)],
             n, mat, T, cap1=True)
    ab = r * 1.62   # полуширина абаки
    z_ab = h - 0.3
    # абака с вогнутыми сторонами (восьмиугольник со срезанными углами) + профиль
    c = ab * 0.86
    poly = [(c, -ab * 0.55), (ab, -ab * 0.2), (ab, ab * 0.2), (c, ab * 0.55), (ab * 0.55, c), (ab * 0.2, ab), (-ab * 0.2, ab), (-ab * 0.55, c),
            (-c, ab * 0.55), (-ab, ab * 0.2), (-ab, -ab * 0.2), (-c, -ab * 0.55), (-ab * 0.55, -c), (-ab * 0.2, -ab), (ab * 0.2, -ab), (ab * 0.55, -c)]
    poly = [(px * 0.96, py * 0.96) for px, py in poly]
    mb.prism(poly, z_ab, z_ab + 0.13, mat, T)
    mb.prism([(px * 1.03, py * 1.03) for px, py in poly], z_ab + 0.13, z_ab + 0.3, mat, T)
    if lod > 0:
        return
    # аканты: два яруса по 8 листьев
    for tier, (zt, hh, rr, off) in enumerate(((0.2, h * 0.42, r * 1.04, 0.0), (0.2 + h * 0.25, h * 0.42, r * 1.12, math.pi / 8))):
        for i in range(8):
            a = off + i * math.pi / 4
            leaf(mb, mat, T @ Matrix.Rotation(a - math.pi / 2, 4, 'Z'), rr, zt, hh, 0.44 * r / 0.6)
    # волюты (по диагоналям) и розетки
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        R = Matrix.Rotation(a, 4, 'Z')
        cx = ab * 1.02
        M = T @ R @ Matrix.Translation((cx * 0.92, 0, z_ab - 0.2)) @ Matrix.Rotation(math.pi / 2, 4, 'X')
        mb.lathe([(0.0, -0.17), (0.16, -0.17), (0.2, -0.1), (0.2, 0.1), (0.16, 0.17), (0.0, 0.17)], 10, mat, M)
        # стебли к волютам
        Ms = T @ R @ Matrix.Translation((r * 1.1, 0, h * 0.55)) @ Matrix.Rotation(-0.75, 4, 'Y')
        mb.lathe([(0.07, 0), (0.06, 0.62)], 6, mat, Ms)
    for i in range(4):   # розетка в середине каждой стороны абаки
        a = i * math.pi / 2
        M = T @ Matrix.Rotation(a, 4, 'Z') @ Matrix.Translation((ab * 1.0, 0, z_ab + 0.15)) @ Matrix.Rotation(math.pi / 2, 4, 'Y')
        mb.lathe([(0.0, 0.0), (0.14, 0.02), (0.1, 0.1), (0.0, 0.12)], 8, mat, M)


def leaf(mb, mat, M, r, z0, h, w):
    """Лист аканта: изогнутая наружу пластина (видна снаружи), кончик загнут. Локально: y — наружу от оси."""
    rows = 5
    verts, faces = [], []
    for j in range(rows):
        t = j / (rows - 1)
        hw = w / 2 * (1 - 0.55 * t ** 1.5) * (0.85 + 0.15 * math.sin(math.pi * t))
        bend = r + 0.02 + 0.38 * h * t ** 2.2
        zz = z0 + h * (t - 0.12 * t ** 3)
        for s in (-1, 0, 1):
            ridge = 0.05 if s == 0 else 0.0
            verts.append((s * hw, bend + ridge - (0.03 if s else 0) * t, zz - (0.05 * t if s else 0)))
    for j in range(rows - 1):
        for s in range(2):
            a = j * 3 + s
            faces.append([a, a + 3, a + 4, a + 1])
    mb.add(verts, faces, mat, True, M)


def pilaster(mb, M, x, z0, z1, w, d, mat, lod=0, capital=True):
    """Пилястра на стене (матрица M = frame стены): ширина w, вынос d, от z0 до z1 (с капителью и базой)."""
    cap = 1.5 if capital else 0.0
    mb.box((x, d / 2, z0 + 0.25), (w + 0.2, d + 0.08, 0.5), mat, M, skip=('b', 'y-'))
    mb.box((x, d / 2, (z0 + 0.5 + z1 - cap) / 2), (w, d, z1 - cap - z0 - 0.5), mat, M, skip=('b', 't', 'y-'))
    if capital:
        zc = z1 - cap
        # расширяющийся блок капители
        v = [(x - w / 2, 0, zc), (x + w / 2, 0, zc), (x + w / 2, d, zc), (x - w / 2, d, zc),
             (x - w * 0.68, 0, z1 - 0.25), (x + w * 0.68, 0, z1 - 0.25), (x + w * 0.68, d + 0.15, z1 - 0.25), (x - w * 0.68, d + 0.15, z1 - 0.25)]
        mb.add(v, [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], mat, False, M)
        mb.box((x, (d + 0.2) / 2, z1 - 0.125), (w * 1.5, d + 0.2, 0.25), mat, M, skip=('y-',))
        if lod == 0:
            for k, s in enumerate((-0.3, 0.0, 0.3)):
                Mf = M @ Matrix.Translation((x + s * w, d, 0)) @ Matrix.Rotation(-math.pi / 2, 4, 'Z') @ Matrix.Rotation(math.pi / 2, 4, 'Z')
                leaf(mb, mat, Mf, 0.0, zc + (0.15 if k == 1 else 0.05), cap * 0.62, w * 0.36)


def window(mb, M, x, z0, w, h, mats, lod=0, arch=False, depth=0.14, frame_w=0.16, mullions=(1, 2), sill=True, lit='glass'):
    """Окно на стене: наличник (выступает на depth), стекло у плоскости стены, переплёт. arch — полуциркульный верх
    (высота h включает арку). mats: {'frame', 'glass', 'mull'}; lit — ключ материала стекла."""
    fm, gm, mm = mats['frame'], mats[lit], mats.get('mull', mats['frame'])
    hw = w / 2
    zr = z0 + h - (hw if arch else 0)   # верх прямоугольной части
    fw = frame_w
    # стекло
    mb.quad((x - hw, 0.02, z0), (x - hw, 0.02, zr), (x + hw, 0.02, zr), (x + hw, 0.02, z0), gm, M)
    seg = 10 if lod == 0 else 5
    if arch:
        pts = [(x + hw * math.cos(math.pi * k / seg), 0.02, zr + hw * math.sin(math.pi * k / seg)) for k in range(seg + 1)]
        mb.add([(x, 0.02, zr)] + pts, [[0, k + 2, k + 1] for k in range(seg)], gm, False, M)
    # наличник
    mb.box((x - hw - fw / 2, depth / 2, (z0 + zr) / 2), (fw, depth, zr - z0), fm, M, skip=('y-',))
    mb.box((x + hw + fw / 2, depth / 2, (z0 + zr) / 2), (fw, depth, zr - z0), fm, M, skip=('y-',))
    if sill:
        mb.box((x, depth / 2 + 0.04, z0 - fw / 2), (w + 2 * fw + 0.16, depth + 0.08, fw), fm, M, skip=('y-',))
    else:
        mb.box((x, depth / 2, z0 - fw / 2), (w + 2 * fw, depth, fw), fm, M, skip=('y-',))
    if arch:
        ring_arc(mb, M, x, zr, hw, hw + fw, depth, seg, fm)
    else:
        mb.box((x, depth / 2, zr + fw / 2), (w + 2 * fw, depth, fw), fm, M, skip=('y-',))
        if lod == 0:   # сандрик
            mb.box((x, depth / 2 + 0.06, zr + fw + 0.07), (w + 2 * fw + 0.3, depth + 0.12, 0.14), fm, M, skip=('y-',))
    if lod == 0 and mullions:
        nv, nh = mullions
        for i in range(1, nv + 1):
            xx = x - hw + w * i / (nv + 1)
            mb.box((xx, 0.05, (z0 + zr) / 2), (0.07, 0.06, zr - z0), mm, M, skip=('y-',))
        for j in range(1, nh + 1):
            zz = z0 + (zr - z0) * j / (nh + 1)
            mb.box((x, 0.05, zz), (w, 0.06, 0.07), mm, M, skip=('y-',))
        if arch:
            mb.box((x, 0.05, zr), (w, 0.06, 0.07), mm, M, skip=('y-',))


def ring_arc(mb, M, x, zc, r0, r1, depth, seg, mat):
    """Полукольцо в плоскости стены (лицевая и торцевые грани)."""
    v, f = [], []
    for k in range(seg + 1):
        a = math.pi * k / seg
        c, s = math.cos(a), math.sin(a)
        v += [(x + r0 * c, depth, zc + r0 * s), (x + r1 * c, depth, zc + r1 * s), (x + r0 * c, 0.0, zc + r0 * s), (x + r1 * c, 0.0, zc + r1 * s)]
    for k in range(seg):
        a, b = 4 * k, 4 * (k + 1)
        f.append([a, b, b + 1, a + 1])           # лицо (y = depth) — смотрит наружу
        f.append([a + 2, b + 2, b, a])           # внутренняя грань (к стеклу)
        f.append([a + 1, b + 1, b + 3, a + 3])   # внешняя грань
    mb.add(v, f, mat, False, M)


def door(mb, M, x, z0, w, h, mats, lod=0):
    """Двустворчатая дверь с порталом."""
    fm, dm = mats['frame'], mats['door']
    mb.box((x, 0.03, z0 + h / 2), (w, 0.06, h), dm, M, skip=('y-',))
    if lod == 0:
        mb.box((x, 0.08, z0 + h / 2), (0.05, 0.06, h), mats.get('mull', fm), M, skip=('y-',))
        for s in (-1, 1):
            for zz in (0.25, 0.62):
                mb.box((x + s * w / 4, 0.07, z0 + h * zz), (w / 2 - 0.25, 0.04, h * 0.28), dm, M, skip=('y-',))
    mb.box((x - w / 2 - 0.15, 0.1, z0 + h / 2), (0.3, 0.2, h), fm, M, skip=('y-',))
    mb.box((x + w / 2 + 0.15, 0.1, z0 + h / 2), (0.3, 0.2, h), fm, M, skip=('y-',))
    mb.box((x, 0.12, z0 + h + 0.2), (w + 0.9, 0.24, 0.4), fm, M, skip=('y-',))
