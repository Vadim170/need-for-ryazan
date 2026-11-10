"""Сцена для анализа фасадов: здания (футпринты в мировой СК, высоты), точки опроса вдоль дорог, рельеф."""
import numpy as np
import rasterio
from shapely.geometry import LineString, MultiPolygon, Polygon, box
from shapely.geometry.polygon import orient
from shapely.strtree import STRtree

from config import BBOX, DATA_PROCESSED, DATA_RAW, to_wgs84, to_world
from world.osm import OsmData, parse_numbers

OSM_PATH = DATA_RAW / "osm" / "ryazan.osm"
DEM_PATH = DATA_PROCESSED / "terrain" / "fabdem_grid10m.tif"
LEVEL_H = 3.0
SKIP = {"roof", "carport", "no", "ruins", "collapsed", "demolished", "entrance", "construction"}
SAMPLE_HW = ["primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
             "unclassified", "residential", "living_street", "pedestrian"]

# Центральное ядро: Кремль – Соборная – Первомайский – Театральная – Есенина (S, W, N, E)
CORE_BBOX = (54.6160, 39.7270, 54.6400, 39.7640)


def bbox_poly(b):
    s, w, n, e = b
    pts = [to_world.transform(lo, la) for lo, la in [(w, s), (e, s), (e, n), (w, n)]]
    return Polygon(pts)


def height_of(tg):
    """(высота, источник) — как в pipeline/world/buildings.py, но с умолчанием 'unknown'."""
    h = parse_numbers(tg.get("height"))
    if h and 2.0 <= max(h) <= 300:
        return max(h), "height"
    lv = parse_numbers(tg.get("building:levels"))
    if lv and max(lv) >= 1:
        return max(lv) * LEVEL_H + 1.0, "levels"
    b = tg.get("building", "yes")
    if b in ("garages", "garage", "shed", "hut", "kiosk", "service"):
        return 3.0, "default"
    if b in ("apartments", "residential", "dormitory"):
        return 16.0, "default"
    if b in ("house", "detached", "semidetached_house"):
        return 7.0, "default"
    return 7.0, "default"


class Building:
    __slots__ = ("key", "poly", "tags", "height", "hsrc", "z0", "idx")


def load_scene(osm=None):
    osm = osm or OsmData(OSM_PATH)
    s, w, n, e = BBOX
    world_bb = bbox_poly(BBOX)
    out = []

    def add(key, p, tg):
        if p is None or tg.get("building", "no") in SKIP:
            return
        polys = [p] if isinstance(p, Polygon) else [g for g in getattr(p, "geoms", []) if isinstance(g, Polygon)]
        polys = [orient(g, 1.0) for g in polys if g.area > 4.0]
        if not polys or not world_bb.contains(polys[0].centroid):
            return
        b = Building()
        b.key = key
        b.poly = polys[0] if len(polys) == 1 else MultiPolygon(polys)
        b.tags = tg
        b.height, b.hsrc = height_of(tg)
        out.append(b)

    for wid, (refs, tg) in osm.ways.items():
        if tg.get("building", "no") != "no" and len(refs) > 3 and refs[0] == refs[-1]:
            add(f"w{wid}", osm.way_polygon(wid), tg)
    for rid, tg, mem in osm.rels:
        if tg.get("type") == "multipolygon" and tg.get("building", "no") != "no":
            add(f"r{rid}", osm.rel_polygon(mem), tg)
    for i, b in enumerate(out):
        b.idx = i
    dem = Dem()
    for b in out:
        c = b.poly.centroid
        b.z0 = dem.min_under(b.poly)
    return osm, out, dem


class Dem:
    def __init__(self, path=DEM_PATH):
        r = rasterio.open(path)
        self.a = r.read(1).astype(np.float64)
        self.tf = r.transform
        self.inv = ~r.transform

    def at(self, x, y):
        c, r = self.inv * (np.asarray(x, float), np.asarray(y, float))
        c = np.clip(np.asarray(c) - 0.5, 0, self.a.shape[1] - 1.001)
        r = np.clip(np.asarray(r) - 0.5, 0, self.a.shape[0] - 1.001)
        c0, r0 = np.floor(c).astype(int), np.floor(r).astype(int)
        fc, fr = c - c0, r - r0
        a = self.a
        return (a[r0, c0] * (1 - fc) * (1 - fr) + a[r0, c0 + 1] * fc * (1 - fr)
                + a[r0 + 1, c0] * (1 - fc) * fr + a[r0 + 1, c0 + 1] * fc * fr)

    def min_under(self, poly):
        pts = np.asarray(poly.exterior.coords if isinstance(poly, Polygon) else poly.geoms[0].exterior.coords)
        return float(np.min(self.at(pts[:, 0], pts[:, 1])))


def road_samples(osm, step=50.0, area=None, highways=SAMPLE_HW):
    """Точки вдоль осей дорог через каждые step м (мировые x, y и lat, lon), дедуп по сетке step/2."""
    area = area if area is not None else bbox_poly(BBOX)
    pts = []
    for wid, (refs, tg) in osm.ways.items():
        if tg.get("highway") not in highways or tg.get("area") == "yes":
            continue
        xy = osm.way_xy(wid)
        if len(xy) < 2:
            continue
        ln = LineString(xy).intersection(area)
        if ln.is_empty:
            continue
        for g in getattr(ln, "geoms", [ln]):
            if g.geom_type != "LineString" or g.length < 1:
                continue
            n = max(1, int(round(g.length / step)))
            for k in range(n):
                p = g.interpolate((k + 0.5) * g.length / n)
                pts.append((p.x, p.y))
    pts = np.array(pts)
    cell = np.floor(pts / (step * 0.5)).astype(np.int64)
    _, keep = np.unique(cell, axis=0, return_index=True)
    pts = pts[np.sort(keep)]
    lon, lat = to_wgs84.transform(pts[:, 0], pts[:, 1])
    return pts, np.c_[lat, lon]
