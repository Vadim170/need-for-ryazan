"""Здания: высота по тегам/типу, материал, экструзия футпринтов."""
import numpy as np
import mapbox_earcut as earcut
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.polygon import orient

from .osm import parse_numbers

LEVEL_H = 3.0
SKIP = {"roof", "carport", "no", "ruins", "collapsed", "demolished", "entrance"}

APARTMENTS = {"apartments", "residential", "dormitory", "flats", "hotel"}
HOUSE = {"house", "detached", "semidetached_house", "terrace", "bungalow", "cabin", "farm", "static_caravan"}
GARAGE = {"garages", "garage", "shed", "hut", "kiosk", "storage_tank", "transformer_tower"}
COMMERCIAL = {"commercial", "retail", "office", "supermarket", "mall", "shop", "kiosk_shop"}

DEFAULT_LEVELS = {"apartments": 5, "house": 2, "commercial": 2, "other": 2}


def category(tg):
    b = tg.get("building", "yes")
    if b in APARTMENTS: return "apartments"
    if b in HOUSE: return "house"
    if b in GARAGE: return "garage"
    if b in COMMERCIAL: return "commercial"
    return "other"


def height_of(tg, cat):
    """height -> building:levels*3+1 -> умолчание по типу. Возвращает (высота, источник)."""
    h = parse_numbers(tg.get("height"))
    if h and 2.0 <= max(h) <= 300:
        return max(h), "height"
    lv = parse_numbers(tg.get("building:levels"))
    if lv and max(lv) >= 1:
        return max(lv) * LEVEL_H + 1.0, "levels"
    if cat == "garage":
        return 3.0, "default"
    return DEFAULT_LEVELS.get(cat, 2) * LEVEL_H + 1.0, "default"


def polygons(geom):
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def triangulate(poly):
    """earcut для полигона с дырами -> (вершины Nx2, индексы Tx3)."""
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


def prism(poly, base, top, with_normals=True):
    """Стены + крыша в координатах игры (x, y=высота, z=-north). Высоты base/top уже со сдвигом baseHeight."""
    poly = orient(poly, 1.0)  # внешний контур CCW, дыры CW
    P, N, U, I = [], [], [], []
    n = 0
    for ring in [poly.exterior] + list(poly.interiors):
        c = np.asarray(ring.coords)
        a, b = c[:-1], c[1:]
        d = b - a
        L = np.hypot(*d.T)
        ok = L > 0.05
        a, b, d, L = a[ok], b[ok], d[ok], L[ok]
        if len(a) == 0:
            continue
        k = len(a)
        nrm = np.c_[d[:, 1] / L, np.zeros(k), d[:, 0] / L]   # наружу: (dy, -dx) в (x,y) -> (nx, 0, -ny) = (dy, 0, dx)
        u0 = np.r_[0, np.cumsum(L)][:-1]
        v = np.empty((k, 4, 3))
        v[:, 0] = np.c_[a[:, 0], np.full(k, base), -a[:, 1]]
        v[:, 1] = np.c_[b[:, 0], np.full(k, base), -b[:, 1]]
        v[:, 2] = np.c_[b[:, 0], np.full(k, top), -b[:, 1]]
        v[:, 3] = np.c_[a[:, 0], np.full(k, top), -a[:, 1]]
        P.append(v.reshape(-1, 3))
        N.append(np.repeat(nrm, 4, axis=0))
        uv = np.empty((k, 4, 2))
        uv[:, 0] = np.c_[u0, np.zeros(k)]; uv[:, 1] = np.c_[u0 + L, np.zeros(k)]
        uv[:, 2] = np.c_[u0 + L, np.full(k, top - base)]; uv[:, 3] = np.c_[u0, np.full(k, top - base)]
        U.append(uv.reshape(-1, 2))
        q = n + 4 * np.arange(k)[:, None]
        tri = np.c_[q, q + 1, q + 2, q, q + 2, q + 3].reshape(-1, 3)
        # ориентация: нормаль треугольника должна совпадать с наружной
        I.append(_orient(v.reshape(-1, 3), tri - 0, np.repeat(nrm, 2, axis=0), n))
        n += 4 * k
    V2, T = triangulate(poly)
    if V2 is not None:
        m = len(V2)
        P.append(np.c_[V2[:, 0], np.full(m, top), -V2[:, 1]])
        N.append(np.tile([0.0, 1.0, 0.0], (m, 1)))
        U.append(np.c_[V2[:, 0], -V2[:, 1]])
        I.append(_orient(P[-1], T, np.array([0.0, 1.0, 0.0]), 0) + n)
        n += m
    if not P:
        return None
    return np.concatenate(P), np.concatenate(N), np.concatenate(U), np.concatenate(I)


def _orient(local_pos, tri_global, want, n0):
    """tri_global — индексы с учётом смещения n0 в общем буфере; local_pos — вершины этого кольца."""
    t = tri_global - n0
    p = local_pos
    fn = np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])
    flip = (fn * want).sum(axis=1) < 0
    t = t.copy()
    t[flip] = t[flip][:, [0, 2, 1]]
    return t + n0
