"""Геометрия зданий по BuildingSpec (archetypes.py): стены, крыши (плоская с парапетом / скатные по «прямому скелету» /
двускатная / купола), карнизы, коробки на крыше, балконы-инстансы. Контракт: docs/world-format.md («Здания v2»).

Координаты на входе — мир пайплайна (x восток, y север) + высота h; на выходе — игра (x, h, -y).
Атрибуты вершин: POSITION, NORMAL, TEXCOORD_0 (стены: u — м от начала стены, v — м от пола 1-го этажа),
TEXCOORD_1 (стены: длина стены, высота этажа), COLOR_0 (sRGB->linear, ubyte), _ARCH (ubyte4: архетип, seed, часть, этажи).
"""
import math

import numpy as np
import mapbox_earcut as earcut
from shapely.geometry import LinearRing, MultiPolygon, Point, Polygon
from shapely.geometry.polygon import orient

from .archetypes import ARCH, STYLE

# коды частей (_ARCH.z) — контракт с шейдером
P_WALL, P_SHOP, P_BLANK, P_ROOF_FLAT, P_ROOF_PITCH, P_TRIM, P_BOX, P_GABLE, P_DOME, P_DRUM = range(10)
# типы балконов
BAL_OPEN, BAL_GLAZED, BAL_LOGGIA = 0, 1, 2


def srgb2lin(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


class MeshAcc:
    """Накопитель одного здания: треугольники с атрибутами, в мировых (x, y, h)."""

    def __init__(self):
        self.P, self.N, self.UV, self.UV1, self.C, self.PART, self.I = [], [], [], [], [], [], []
        self.n = 0
        self.tris = 0

    def add(self, P, T, N, UV, part, color, UV1=None):
        P = np.asarray(P, np.float64)
        T = np.asarray(T, np.int64).reshape(-1, 3)
        N = np.asarray(N, np.float64)
        if N.ndim == 1:
            N = np.tile(N, (len(P), 1))
        if len(P) == 0 or len(T) == 0:
            return
        # ориентация по желаемой нормали (средняя по вершинам треугольника)
        fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
        want = N[T[:, 0]] + N[T[:, 1]] + N[T[:, 2]]
        flip = (fn * want).sum(axis=1) < 0
        T = T.copy()
        T[flip] = T[flip][:, [0, 2, 1]]
        self.P.append(P); self.N.append(N)
        self.UV.append(np.asarray(UV, np.float64).reshape(len(P), 2))
        self.UV1.append(np.zeros((len(P), 2)) if UV1 is None else np.asarray(UV1, np.float64).reshape(len(P), 2))
        self.C.append(np.tile(np.asarray(color, np.float64), (len(P), 1)))
        self.PART.append(np.full(len(P), part, np.uint8))
        self.I.append(T + self.n)
        self.n += len(P)
        self.tris += len(T)

    def quad(self, a, b, c, d, n, part, color, uv=None, uv1=None):
        P = np.array([a, b, c, d], np.float64)
        if uv is None:
            uv = np.zeros((4, 2))
        self.add(P, [[0, 1, 2], [0, 2, 3]], n, uv, part, color, uv1)

    def poly_flat(self, poly, h, up, part, color):
        """Плоский многоугольник (с дырами) на высоте h; up=True — нормаль вверх."""
        for g in _polys(poly):
            V, T = triangulate(g)
            if V is None:
                continue
            P = np.c_[V, np.full(len(V), h)]
            self.add(P, T, np.array([0, 0, 1.0 if up else -1.0]), V.copy(), part, color)

    def to_game(self, arch, seed, levels):
        if not self.n:
            return None
        P = np.concatenate(self.P); N = np.concatenate(self.N)
        Pg = np.c_[P[:, 0], P[:, 2], -P[:, 1]].astype(np.float32)
        Ng = np.c_[N[:, 0], N[:, 2], -N[:, 1]]
        ln = np.linalg.norm(Ng, axis=1, keepdims=True); ln[ln == 0] = 1
        Ng = (Ng / ln).astype(np.float32)
        C = np.concatenate(self.C)
        col = np.c_[np.clip(np.round(srgb2lin(C) * 255), 0, 255), np.full(len(C), 255)].astype(np.uint8)
        part = np.concatenate(self.PART)
        arch_a = np.c_[np.full(len(P), arch), np.full(len(P), seed & 255), part, np.full(len(P), min(levels, 255))].astype(np.uint8)
        return (Pg, np.concatenate(self.I), Ng, np.concatenate(self.UV).astype(np.float32),
                {"TEXCOORD_1": np.concatenate(self.UV1).astype(np.float32), "COLOR_0": col, "_ARCH": arch_a})


# ---------------------------------------------------------------- геометрические утилиты
def _polys(g):
    if g is None or g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    return [x for x in getattr(g, "geoms", []) if isinstance(x, Polygon)]


def triangulate(poly):
    rings = [np.asarray(poly.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in poly.interiors]
    rings = [r for r in rings if len(r) >= 3]
    if not rings:
        return None, None
    V = np.concatenate(rings)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    I = earcut.triangulate_float64(V, ends)
    if len(I) == 0:
        return None, None
    return V, np.asarray(I, np.int64).reshape(-1, 3)


def clean_ring(R, eps=0.03):
    """Убрать повторы и почти коллинеарные вершины (кольцо без замыкающей точки)."""
    R = np.asarray(R, np.float64)
    changed = True
    while changed and len(R) >= 3:
        changed = False
        n = len(R)
        keep = np.ones(n, bool)
        for i in range(n):
            if not keep[(i - 1) % n]:
                continue
            a, b, c = R[(i - 1) % n], R[i], R[(i + 1) % n]
            ab, bc = b - a, c - b
            if np.hypot(*ab) < eps:
                keep[i] = False; changed = True; continue
            cr = ab[0] * bc[1] - ab[1] * bc[0]
            if abs(cr) < eps * 0.5 * (np.hypot(*ab) + np.hypot(*bc)) * 0.02 and (ab @ bc) > 0:
                keep[i] = False; changed = True
        R = R[keep]
    return R


def ring_area(R):
    x, y = R[:, 0], R[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _normals_in(R):
    """Внутренние единичные нормали рёбер CCW-кольца (ребро i: R[i] -> R[i+1])."""
    d = np.roll(R, -1, axis=0) - R
    L = np.hypot(d[:, 0], d[:, 1])
    L[L == 0] = 1e-9
    return np.c_[-d[:, 1], d[:, 0]] / L[:, None], d / L[:, None], L


def offset_ring(R, d):
    """Митровое смещение CCW-кольца внутрь на d (d<0 — наружу). Скорости вершин — для расчёта событий."""
    n_in, _, _ = _normals_in(R)
    n_prev = np.roll(n_in, 1, axis=0)
    den = 1.0 + (n_prev * n_in).sum(axis=1)
    den = np.maximum(den, 0.05)
    vel = (n_prev + n_in) / den[:, None]
    return R + vel * d, vel


def edge_event(R):
    """Время (расстояние смещения) до первого схлопывания ребра."""
    _, e, L = _normals_in(R)
    _, vel = offset_ring(R, 0.0)
    rate = ((np.roll(vel, -1, axis=0) - vel) * e).sum(axis=1)
    t = np.where(rate < -1e-9, L / np.maximum(-rate, 1e-9), np.inf)
    return float(t.min())


def _simple_ok(R):
    if len(R) < 3:
        return False
    try:
        lr = LinearRing(R)
        return lr.is_simple and ring_area(R) > 0
    except Exception:
        return False


def skeleton_roof(acc, poly, h0, slope, max_rise, color, part=P_ROOF_PITCH, max_stages=10, caps_out=None):
    """Скатная крыша «прямым скелетом» (поэтапное митровое смещение до событий рёбер; при расщеплении — разрезание).
    Возвращает фактический максимальный подъём. Плоский верх (если упёрлись в max_rise) — в caps_out или как крыша."""
    poly = orient(poly, 1.0)
    if poly.interiors:
        return _dutch_roof(acc, poly, h0, slope, max_rise, color, part, caps_out)
    stack = [(clean_ring(np.asarray(poly.exterior.coords)[:-1]), h0, 0)]
    top = h0
    while stack:
        R, h, st = stack.pop()
        R = clean_ring(R)
        if len(R) < 3 or ring_area(R) < 0.05:
            continue
        rise_left = h0 + max_rise - h
        if rise_left <= 1e-3 or st >= max_stages:
            _cap(acc, R, h, color, part, caps_out)
            continue
        t_edge = edge_event(R)
        t_max = rise_left / slope
        d = min(t_edge, t_max)
        Rd, _ = offset_ring(R, d)
        split = False
        if not _simple_ok(Rd) and not (d == t_edge and ring_area(Rd) < 0.5):
            lo, hi = 0.0, d
            for _ in range(22):
                mid = (lo + hi) / 2
                if _simple_ok(offset_ring(R, mid)[0]):
                    lo = mid
                else:
                    hi = mid
            d = lo * 0.995
            Rd, _ = offset_ring(R, d)
            split = True
        hn = h + d * slope
        top = max(top, hn)
        _slopes(acc, R, Rd, h, hn, color, part)
        if d >= t_max - 1e-6:
            _cap(acc, Rd, hn, color, part, caps_out)
            continue
        if split:
            P = Polygon(Rd)
            if not P.is_valid:
                P = P.buffer(0)
            parts = P.buffer(-0.04, join_style=2)
            rest = P.difference(parts) if not parts.is_empty else P
            for g in _polys(rest):
                acc.poly_flat(g, hn, True, part, color)
            for g in _polys(parts):
                g = orient(g, 1.0)
                if g.area > 0.05:
                    stack.append((np.asarray(g.exterior.coords)[:-1], hn, st + 1))
        else:
            stack.append((Rd, hn, st + 1))
    return top - h0


def _slopes(acc, R, Rd, h, hn, color, part):
    n = len(R)
    for i in range(n):
        j = (i + 1) % n
        a, b, c, d = R[i], R[j], Rd[j], Rd[i]
        e = b - a
        Le = math.hypot(*e)
        if Le < 1e-4:
            continue
        eu = e / Le
        P = np.array([[*a, h], [*b, h], [*c, hn], [*d, hn]])
        nrm = np.cross(P[1] - P[0], P[2] - P[0])
        if np.linalg.norm(nrm) < 1e-9:
            nrm = np.cross(P[1] - P[0], P[3] - P[0])
        # нормаль крыши смотрит вверх-наружу
        if nrm[2] < 0:
            nrm = -nrm
        nrm = nrm / (np.linalg.norm(nrm) or 1)
        # UV: u вдоль карниза, v — вверх по скату (м)
        rel = P[:, :2] - a
        u = rel @ eu
        v = np.hypot(rel @ np.array([-eu[1], eu[0]]), P[:, 2] - h)
        UV = np.c_[u, v]
        if math.hypot(*(c - d)) < 1e-3:
            acc.add(P[[0, 1, 2]], [[0, 1, 2]], nrm, UV[[0, 1, 2]], part, color)
        else:
            acc.add(P, [[0, 1, 2], [0, 2, 3]], nrm, UV, part, color)


def _cap(acc, R, h, color, part, caps_out):
    if len(R) < 3 or abs(ring_area(R)) < 0.05:
        return
    P = Polygon(R)
    if not P.is_valid:
        P = P.buffer(0)
    if caps_out is not None:
        caps_out.append((P, h))
    else:
        acc.poly_flat(P, h, True, P_ROOF_FLAT if part == P_ROOF_PITCH else part, color)


def _dutch_roof(acc, poly, h0, slope, max_rise, color, part, caps_out):
    """Полигон с дворами: один пояс скатов (одновременное смещение всех колец) + плоский верх."""
    d = min(max_rise / slope, 6.0)
    for _ in range(12):
        rings = [orient(Polygon(poly.exterior), 1.0).exterior] + [r for r in poly.interiors]
        new = []
        ok = True
        for k, r in enumerate(rings):
            # смещение влево от направления обхода: у CCW-контура это внутрь, у CW-дыры — тоже в тело здания
            R = clean_ring(np.asarray(r.coords)[:-1])
            if len(R) < 3 or d > edge_event(R) * 0.98:
                ok = False; break
            Rd, _ = offset_ring(R, d)
            new.append((R, Rd))
        if ok:
            try:
                P = Polygon(new[0][1], [x[1] for x in new[1:]])
                ok = P.is_valid and P.area > 1
            except Exception:
                ok = False
        if ok:
            break
        d *= 0.6
        if d < 0.3:
            acc.poly_flat(poly, h0, True, P_ROOF_FLAT, color)
            return 0.0
    hn = h0 + d * slope
    for R, Rd in new:
        _slopes(acc, R, Rd, h0, hn, color, part)
    if caps_out is not None:
        caps_out.append((P, hn))
    else:
        acc.poly_flat(P, hn, True, P_ROOF_FLAT, color)
    return hn - h0


# ---------------------------------------------------------------- стены
def walls(acc, poly, h0, h1, v0, fh, color, blank_fn=None, shop=False, part=P_WALL):
    """Стены всех колец; v0 — высота пола 1-го этажа (v = h - v0). blank_fn(a, b, nrm) -> True для глухой стены."""
    poly = orient(poly, 1.0)
    for ring in [poly.exterior] + list(poly.interiors):
        c = np.asarray(ring.coords)
        for a, b in zip(c[:-1], c[1:]):
            d = b - a
            L = math.hypot(*d)
            if L < 0.05:
                continue
            nrm = np.array([d[1] / L, -d[0] / L, 0.0])
            pt = part
            if blank_fn is not None and part == P_WALL and blank_fn(a, b, nrm[:2]):
                pt = P_BLANK
            # витрины: стена режется на участки (u — сквозное от начала стены, сетка окон не сбивается)
            segs = [(0.0, L, pt)]
            if shop and pt == P_WALL:
                iv = [(0.0, L)] if shop is True else shop(a, b, nrm[:2])
                if iv:
                    segs, u = [], 0.0
                    for u0, u1 in iv:
                        if u0 > u + 0.01:
                            segs.append((u, u0, P_WALL))
                        segs.append((max(u0, u), u1, P_SHOP))
                        u = max(u, u1)
                    if u < L - 0.01:
                        segs.append((u, L, P_WALL))
            t = d / L
            for u0, u1, sp in segs:
                pa, pb = a + t * u0, a + t * u1
                P = np.array([[*pa, h0], [*pb, h0], [*pb, h1], [*pa, h1]])
                UV = np.array([[u0, h0 - v0], [u1, h0 - v0], [u1, h1 - v0], [u0, h1 - v0]])
                acc.add(P, [[0, 1, 2], [0, 2, 3]], nrm, UV, sp, color, np.tile([L, fh], (4, 1)))


def ring_band(acc, poly, h0, h1, out, color, part=P_TRIM, top=True, bottom=True):
    """Выступающий пояс (карниз/парапетная плита): кольцо, вынесенное наружу на out, от h0 до h1."""
    poly = orient(poly, 1.0)
    big = poly.buffer(out, join_style=2, mitre_limit=3.0)
    for g in _polys(big):
        walls(acc, g, h0, h1, 0.0, 3.0, color, part=part)
    ringp = big.difference(poly.buffer(-0.02, join_style=2))
    for g in _polys(ringp):
        if top:
            acc.poly_flat(g, h1, True, part, color)
        if bottom:
            acc.poly_flat(g, h0, False, part, color)


def box(acc, cx, cy, w, l, ang, h0, h1, color, part=P_BOX):
    """Короб (без дна): центр, размеры, поворот (рад) — для машинных отделений, вентшахт, барабанов."""
    ca, sa = math.cos(ang), math.sin(ang)
    u, v = np.array([ca, sa]), np.array([-sa, ca])
    c = np.array([cx, cy])
    pts = [c - u * l / 2 - v * w / 2, c + u * l / 2 - v * w / 2, c + u * l / 2 + v * w / 2, c - u * l / 2 + v * w / 2]
    for i in range(4):
        a, b = pts[i], pts[(i + 1) % 4]
        d = b - a
        L = math.hypot(*d)
        nrm = np.array([d[1] / L, -d[0] / L, 0])
        # нормаль наружу: от центра
        if nrm[:2] @ ((a + b) / 2 - c) < 0:
            nrm = -nrm
        acc.quad([*a, h0], [*b, h0], [*b, h1], [*a, h1], nrm, part, color,
                 uv=np.array([[0, h0], [L, h0], [L, h1], [0, h1]]), uv1=np.tile([L, 3.0], (4, 1)))
    P = np.array([[*p, h1] for p in pts])
    acc.add(P, [[0, 1, 2], [0, 2, 3]], np.array([0, 0, 1.0]), P[:, :2], part, color)


def lathe(acc, cx, cy, h0, R, H, profile, color, part=P_DOME, seg=12):
    """Тело вращения: profile — [(t (0..1 по высоте), r_rel)]."""
    ts = np.array([p[0] for p in profile]); rs = np.array([p[1] for p in profile])
    ang = np.linspace(0, 2 * math.pi, seg + 1)[:-1]
    P, N, UV = [], [], []
    for k, (t, r) in enumerate(zip(ts, rs)):
        # нормаль профиля: производная
        k0, k1 = max(k - 1, 0), min(k + 1, len(ts) - 1)
        dz = (ts[k1] - ts[k0]) * H
        dr = (rs[k1] - rs[k0]) * R
        nr, nz = dz, -dr
        ln = math.hypot(nr, nz) or 1
        nr, nz = nr / ln, nz / ln
        for a in ang:
            P.append([cx + math.cos(a) * r * R, cy + math.sin(a) * r * R, h0 + t * H])
            N.append([math.cos(a) * nr, math.sin(a) * nr, nz])
            UV.append([a * R, t * H])
    T = []
    for k in range(len(ts) - 1):
        for i in range(seg):
            a, b = k * seg + i, k * seg + (i + 1) % seg
            c, d = a + seg, b + seg
            T += [[a, b, d], [a, d, c]]
    acc.add(np.array(P), np.array(T), np.array(N), np.array(UV), part, color)


ONION = [(0, 1.0), (0.12, 1.18), (0.28, 1.28), (0.42, 1.18), (0.56, 0.9), (0.7, 0.55), (0.82, 0.26), (0.92, 0.1), (1.0, 0.0)]
DOME = [(0, 1.0), (0.3, 0.95), (0.55, 0.83), (0.75, 0.65), (0.9, 0.42), (1.0, 0.0)]
DRUM = [(0, 1.0), (1.0, 1.0)]
SPIRE = [(0, 1.0), (1.0, 0.02)]


def cross(acc, cx, cy, h0, size, color):
    """Крест: две тонкие планки (вертикаль и перекладина) — коробки."""
    box(acc, cx, cy, 0.12, 0.12, 0, h0, h0 + size, color, P_DOME)
    box(acc, cx, cy, 0.1, size * 0.55, 0, h0 + size * 0.62, h0 + size * 0.72, color, P_DOME)


# ---------------------------------------------------------------- сборка одного объёма
def build_spec(acc, s, base, blank_fn, rng, street_fn=None, ground=None, with_balconies=True):
    """Добавляет объём s в acc. base — «расчётная земля»: пол 1-го этажа = base + s.plinth (на склоне base выше
    минимума рельефа); ground — фактический низ стен (минимум рельефа под объёмом), по умолчанию = base.
    Возвращает стопки балконов."""
    poly = orient(s.poly, 1.0)
    col = s.color
    rcol = s.roof_color
    g0 = base + s.min_h
    if ground is not None and s.min_h <= 0.5:
        g0 = min(g0, ground)          # на склоне стены уходят до земли: снизу виден высокий цоколь
    v0 = base + s.plinth
    top = base + s.wall_h
    if top - g0 < 0.3:
        top = g0 + 0.3
    flat = s.roof == "flat"
    wall_top = top + (s.parapet if flat else 0.0)
    fh = s.fh
    shop = street_fn if street_fn is not None else False   # витрины — только на стенах к улице
    if s.roof == "gabled" and _rect_ok(poly):
        _gabled(acc, s, poly, base, g0, top, v0, blank_fn, rng, shop)
    else:
        walls(acc, poly, g0, wall_top, v0, fh, col, blank_fn, shop)
        if s.min_h > 0.5:
            acc.poly_flat(poly, g0, False, P_TRIM, col)
        if flat:
            _flat_roof(acc, s, poly, top, rcol, col)
        elif s.roof in ("hipped", "pyramidal", "mansard", "skillion", "gabled"):
            slope = math.tan(math.radians(max(s.pitch, 5)))
            over = 0.35 if s.arch in ("house", "merchant", "church", "shed") else 0.2
            if s.cornice:
                ring_band(acc, poly, top - 0.45, top, 0.35, _shade(col, 0.95))
                over = 0.4
            src = poly.buffer(over, join_style=2, mitre_limit=2.5) if over > 0 else poly
            src = max(_polys(src), key=lambda g: g.area)
            h_e = top - over * slope
            if s.roof == "mansard":
                caps = []
                skeleton_roof(acc, src, h_e, math.tan(math.radians(68)), min(s.roof_h * 0.7, 3.0), rcol, caps_out=caps)
                for g, hh in caps:
                    skeleton_roof(acc, g, hh, math.tan(math.radians(18)), max(s.roof_h * 0.3, 0.8), rcol)
            else:
                skeleton_roof(acc, src, h_e, slope, s.roof_h + over * slope, rcol)
            _soffit(acc, src, poly, h_e, col)
        elif s.roof in ("dome", "onion"):
            _dome_roof(acc, s, poly, top, rcol, col)
    bal = []
    if with_balconies and s.arch in BALCONY_RULES and not s.part and s.levels >= 2:
        bal = balconies(s, poly, base, blank_fn, rng)
    if s.arch == "church" and not s.part:
        _church_extras(acc, s, poly, top, rng)
    return bal


def _shade(c, k):
    return tuple(min(max(x * k, 0), 1) for x in c)


def _rect_ok(poly):
    if poly.interiors:
        return False
    mrr = poly.minimum_rotated_rectangle
    return poly.area / max(mrr.area, 1e-9) > 0.88 and len(poly.exterior.coords) <= 9


def _flat_roof(acc, s, poly, top, rcol, col):
    par = s.parapet
    if par <= 0.05:
        acc.poly_flat(poly, top, True, P_ROOF_FLAT, rcol)
        return
    inner = poly.buffer(-0.28, join_style=2)
    if inner.is_empty or inner.area < 2:
        acc.poly_flat(poly, top + par, True, P_ROOF_FLAT, rcol)
        return
    for g in _polys(inner):
        acc.poly_flat(g, top, True, P_ROOF_FLAT, rcol)
        # внутренняя грань парапета: нормаль внутрь (к крыше) = против наружной нормали кольца
        g = orient(g, 1.0)
        for ring in [g.exterior] + list(g.interiors):
            c = np.asarray(ring.coords)
            for a, b in zip(c[:-1], c[1:]):
                d = b - a
                L = math.hypot(*d)
                if L < 0.05:
                    continue
                nrm = np.array([-d[1] / L, d[0] / L, 0.0])
                acc.quad([*a, top], [*b, top], [*b, top + par], [*a, top + par], nrm, P_TRIM, _shade(col, 0.85),
                         uv=np.array([[0, 0], [L, 0], [L, par], [0, par]]))
    cap = poly.difference(inner)
    for g in _polys(cap):
        acc.poly_flat(g, top + par, True, P_TRIM, _shade(col, 0.8))
    if s.cornice:
        ring_band(acc, poly, top - 0.5, top - 0.05, 0.35, _shade(col, 0.95))


def _soffit(acc, outer, poly, h, col):
    ring = outer.difference(poly)
    for g in _polys(ring):
        acc.poly_flat(g, h, False, P_TRIM, _shade(col, 0.7))


def _gabled(acc, s, poly, base, g0, top, v0, blank_fn, rng, shop=False):
    """Двускатная по повёрнутому прямоугольнику: стены по футпринту до карниза, фронтоны на торцах."""
    from .archetypes import rect_frame
    ctr, u, L, W, _ = rect_frame(poly)
    v = np.array([-u[1], u[0]])
    col, rcol = s.color, s.roof_color
    walls(acc, poly, g0, top, v0, s.fh, col, blank_fn, shop)
    slope = math.tan(math.radians(max(s.pitch, 5)))
    rise = min(W / 2 * slope, s.roof_h if s.roof_h > 0 else 99)
    slope = rise / (W / 2)
    ridge = top + rise
    o = 0.4 if s.arch in ("house", "merchant", "shed", "church") else 0.25
    if s.cornice:
        ring_band(acc, poly, top - 0.4, top, 0.3, _shade(col, 0.95), top=False)
    # фронтоны (треугольники стены) на торцах
    for sg in (-1, 1):
        e = ctr + u * sg * L / 2
        a, b = e - v * W / 2, e + v * W / 2
        m = e
        nrm = np.array([*(u * sg), 0])
        P = np.array([[*a, top], [*b, top], [*m, ridge]])
        UV = np.array([[0, top - v0], [W, top - v0], [W / 2, ridge - v0]])
        acc.add(P, [[0, 1, 2]], nrm, UV, P_GABLE, col, np.tile([W, s.fh], (3, 1)))
    # скаты с выносом o
    for sg in (-1, 1):
        e0 = ctr - u * (L / 2 + o) + v * sg * (W / 2 + o)
        e1 = ctr + u * (L / 2 + o) + v * sg * (W / 2 + o)
        r0 = ctr - u * (L / 2 + o)
        r1 = ctr + u * (L / 2 + o)
        he = top - o * slope
        P = np.array([[*e0, he], [*e1, he], [*r1, ridge], [*r0, ridge]])
        nrm = np.cross(P[1] - P[0], P[3] - P[0])
        if nrm[2] < 0:
            nrm = -nrm
        nrm /= np.linalg.norm(nrm)
        sl = math.hypot(W / 2 + o, ridge - he)
        acc.add(P, [[0, 1, 2], [0, 2, 3]], nrm, np.array([[0, 0], [L + 2 * o, 0], [L + 2 * o, sl], [0, sl]]), P_ROOF_PITCH, rcol)
        # подшивка свеса (низ) вдоль длинной стороны
        w0 = ctr - u * (L / 2 + o) + v * sg * (W / 2)
        w1 = ctr + u * (L / 2 + o) + v * sg * (W / 2)
        acc.quad([*e0, he], [*e1, he], [*w1, he], [*w0, he], np.array([0, 0, -1.0]), P_TRIM, _shade(col, 0.7))
        # торцевой «ветровой» скат снизу (видно с земли): нижняя сторона свеса на торцах
        for eg in (-1, 1):
            q0 = ctr + u * eg * (L / 2 + o) + v * sg * (W / 2 + o)
            q1 = ctr + u * eg * (L / 2 + o)
            q2 = ctr + u * eg * (L / 2)
            q3 = ctr + u * eg * (L / 2) + v * sg * (W / 2 + o)
            Pq = np.array([[*q0, he - 0.02], [*q1, ridge - 0.02], [*q2, ridge - 0.02], [*q3, he - 0.02]])
            acc.add(Pq, [[0, 1, 2], [0, 2, 3]], np.array([0, 0, -1.0]), np.zeros((4, 2)), P_TRIM, _shade(col, 0.7))


def _dome_roof(acc, s, poly, top, rcol, col):
    c = poly.centroid
    R = math.sqrt(poly.area / math.pi) * 0.98
    H = s.roof_h if s.roof_h > 0 else R * (2.0 if s.roof == "onion" else 1.0)
    acc.poly_flat(poly, top, True, P_ROOF_FLAT, _shade(col, 0.8))
    if s.roof == "onion":
        neck = 0.2 * H
        lathe(acc, c.x, c.y, top, R * 0.62, neck, DRUM, rcol, P_DOME)
        lathe(acc, c.x, c.y, top + neck, R * 0.62, H - neck, ONION, rcol, P_DOME)
        cross(acc, c.x, c.y, top + H, max(1.0, R * 0.7), (0.85, 0.7, 0.3))
    else:
        lathe(acc, c.x, c.y, top, R, H, DOME, rcol, P_DOME)


def _church_extras(acc, s, poly, top, rng):
    """Процедурная церковь без частей OSM: барабан с луковицей (+4 малых у крупных), колокольня у вытянутых."""
    from .archetypes import rect_frame
    ctr, u, L, W, _ = rect_frame(poly)
    gold = (0.83, 0.65, 0.23)
    dome_col = [gold, (0.25, 0.42, 0.66), (0.24, 0.48, 0.32), gold][s.seed % 4]
    roof_top = top + (s.roof_h if s.roof != "flat" else s.parapet)
    # колокольня на западном торце (по оси u — к западу)
    west = -u if u[0] > 0 else u
    main_c = ctr
    if L / max(W, 1) > 1.7 and L > 15:
        bt = ctr + west * (L / 2 - W * 0.32)
        bw = W * 0.6
        bh = top + max(10.0, s.wall_h * 1.4)
        if poly.buffer(0.5).contains(Point(*bt)):
            box(acc, bt[0], bt[1], bw, bw, math.atan2(u[1], u[0]), top - 0.5, bh, s.color, P_DRUM)
            box(acc, bt[0], bt[1], bw * 0.7, bw * 0.7, math.atan2(u[1], u[0]), bh, bh + 3.5, s.color, P_DRUM)
            lathe(acc, bt[0], bt[1], bh + 3.5, bw * 0.35, bw * 1.3, ONION, dome_col, P_DOME, seg=10)
            cross(acc, bt[0], bt[1], bh + 3.5 + bw * 1.3, 1.5, gold)
        main_c = ctr - west * (L * 0.12)
    dr = float(np.clip(W * 0.2, 1.4, 4.5))
    dh = dr * 1.6
    lathe(acc, main_c[0], main_c[1], roof_top - 1.0, dr, dh + 1.0, DRUM, s.color, P_DRUM, seg=12)
    lathe(acc, main_c[0], main_c[1], roof_top + dh, dr * 1.02, dr * 2.3, ONION, dome_col, P_DOME, seg=12)
    cross(acc, main_c[0], main_c[1], roof_top + dh + dr * 2.3, max(1.2, dr * 0.6), gold)
    if poly.area > 350:
        v = np.array([-u[1], u[0]])
        for a in (-1, 1):
            for b in (-1, 1):
                p = main_c + u * a * W * 0.27 + v * b * W * 0.27
                if poly.contains(Point(*p)):
                    r2 = dr * 0.5
                    lathe(acc, p[0], p[1], roof_top - 1.0, r2, r2 * 1.8 + 1.0, DRUM, s.color, P_DRUM, seg=10)
                    lathe(acc, p[0], p[1], roof_top + r2 * 1.8, r2 * 1.02, r2 * 2.3, ONION, dome_col, P_DOME, seg=10)


# ---------------------------------------------------------------- детали крыши
def roof_details(acc, s, poly, base, rng):
    if s.roof != "flat" or s.part:
        return
    from .archetypes import rect_frame
    top = base + s.wall_h
    ctr, u, L, W, _ = rect_frame(poly)
    ang = math.atan2(u[1], u[0])
    inner = poly.buffer(-1.5)
    if inner.is_empty:
        return
    gray = (0.62, 0.6, 0.57)
    col = _shade(s.color, 0.92)

    def try_box(c, w, l, h, color, a=ang):
        if inner.contains(Point(*c)):
            box(acc, c[0], c[1], w, l, a, top, top + h, color)
            return True
        return False

    n = max(1, s.sections)
    if s.arch in ("panel9", "tower", "modern") and s.levels >= 9:
        for k in range(n):
            c = ctr + u * (k - (n - 1) / 2) * (L / n)
            try_box(c, min(4.0, W * 0.35), 6.0, 3.0, col)
    elif s.arch in ("panel5", "brick5", "stalinka", "panel9", "modern", "school", "public"):
        for k in range(n):
            c = ctr + u * (k - (n - 1) / 2) * (L / n)
            try_box(c + np.array([-u[1], u[0]]) * W * 0.15, 2.0, 2.6, 1.7, col)
            if rng.random() < 0.7:
                try_box(c + u * 4.0, 0.7, 0.7, 1.1, gray)
    elif s.arch in ("commercial", "industrial") and poly.area > 300:
        for _ in range(int(min(4, 1 + poly.area / 1500))):
            c = ctr + u * rng.uniform(-L / 3, L / 3) + np.array([-u[1], u[0]]) * rng.uniform(-W / 4, W / 4)
            try_box(c, 1.6, 2.4, 1.3, gray)


# ---------------------------------------------------------------- балконы (инстансы)
# правило: (шаг окон берётся из STYLE), выбор столбцов, тип, доля застеклённых, стороны
BALCONY_RULES = {
    #             cols(k, n) -> bool,                     type          glazed  sides   width depth  floors_from top_skip
    "panel5":   (lambda k, n: k % 3 == 1,                  BAL_OPEN,     0.55,   "one",  2.7,  1.0,   2, 0),
    "brick5":   (lambda k, n: k % 4 == 2,                  BAL_OPEN,     0.5,    "one",  2.4,  0.9,   2, 0),
    "panel9":   (lambda k, n: k % 4 in (1, 2),             BAL_LOGGIA,   0.75,   "both", 2.8,  0.35,  2, 0),
    "tower":    (lambda k, n: k in (1, n - 2) and n >= 4,  BAL_LOGGIA,   0.8,    "all",  2.8,  0.35,  2, 0),
    "stalinka": (lambda k, n: n >= 5 and k in (n // 2,) or (n >= 9 and k in (1, n - 2)), BAL_OPEN, 0.1, "street", 2.0, 0.8, 2, 1),
    "modern":   (lambda k, n: k % 2 == 1,                  BAL_GLAZED,   0.95,   "all",  3.0,  1.1,   2, 0),
}


def balconies(s, poly, base, blank_fn, rng):
    """Стопки балконов: [(x, y, h0, rotY, n, fh, type, width, depth, glazed, seed)] в мире пайплайна."""
    from .archetypes import rect_frame
    rule = BALCONY_RULES[s.arch]
    sel, typ, glazed, sides, bw, bd, f0, top_skip = rule
    _, u, L, W, _ = rect_frame(poly)
    step = STYLE[s.arch][2]
    n_floors = s.levels - (f0 - 1) - top_skip
    if n_floors < 1:
        return []
    side_pick = rng.integers(0, 2)
    out = []
    c = np.asarray(orient(poly, 1.0).exterior.coords)
    for a, b in zip(c[:-1], c[1:]):
        d = b - a
        Lw = math.hypot(*d)
        if Lw < 6.0:
            continue
        t = d / Lw
        nrm = np.array([t[1], -t[0]])
        long_side = abs(t @ u) > 0.8 and Lw > 0.45 * L
        if sides in ("one", "both", "street") and not long_side:
            continue
        if sides == "one":
            want = 1 if side_pick else -1
            if np.sign(nrm @ np.array([-u[1], u[0]])) != want:
                continue
        if blank_fn is not None and blank_fn(a, b, nrm):
            continue
        styp = typ
        if sides == "both" and s.arch == "panel9":
            # вторая сторона — открытые кухонные балконы реже
            if np.sign(nrm @ np.array([-u[1], u[0]])) < 0:
                styp = BAL_OPEN
        m = 0.6
        n = int((Lw - 2 * m) // step)
        if n < 2:
            continue
        start = (Lw - n * step) / 2
        for k in range(n):
            if s.arch == "panel9" and styp == BAL_OPEN and k % 4 != 0:
                continue
            if not (s.arch == "panel9" and styp == BAL_OPEN) and not sel(k, n):
                continue
            uu = start + (k + 0.5) * step
            p = a + t * uu
            h0 = base + s.plinth + (f0 - 1) * s.fh
            rot = math.atan2(-nrm[0], nrm[1])
            out.append((float(p[0]), float(p[1]), float(h0), rot, int(n_floors), float(s.fh), int(styp),
                        float(min(bw, step * 0.92)), float(bd), float(glazed), int(rng.integers(0, 65535))))
    return out
