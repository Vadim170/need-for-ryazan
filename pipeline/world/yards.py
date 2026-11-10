"""Дворы, парки, благоустройство.

Даёт две вещи (контракт: docs/world-format.md, раздел «Дворы, площадки и пропсы»):
- плоские площадки на рельефе (+0.03 м) — нода `areas` в tile .glb, материалы area_*;
- пропсы-инстансы (деревья, фонари, машины во дворах…) — props/{ix}_{iz}.json, расстановка в world/props.py.

Вся «свободность» места проверяется по растру мира 1 м с битовыми слоями (здания, дороги, вода, парковки…):
это быстро и одинаково для всех типов пропсов.
"""
import json
import math
import xml.etree.ElementTree as ET
from collections import defaultdict

import numpy as np
import shapely
from rasterio import features
from rasterio.transform import from_origin
from scipy.ndimage import gaussian_filter, map_coordinates
from shapely.geometry import LineString, Point, box
from shapely.ops import unary_union

from config import to_world
from . import buildings as B
from . import pedestrian_streets as PS
from .gltf import MATERIALS, Prim, fix_winding
from .roads import base_class, junction_polygon

TILE = 250.0
CELL = 5.0
RES = 1.0            # шаг растра масок, м
AREA_LIFT = 0.03     # площадки над рельефом
ROAD_LIFT = 0.05
SIDEWALK = 3.0       # коридор тротуара от кромки проезжей части (тротуары делает другой модуль)
SIDEWALK_SERVICE = 0.3  # у service-проездов тротуаров нет: только небольшой зазор

# цвета для превью/серого бокса (игра подставит свои материалы по имени)
for _k, _c in {"area_parking": [0.30, 0.30, 0.31, 1.0], "area_paving": [0.62, 0.60, 0.56, 1.0],
               "area_paving_pedestrian": [0.60, 0.55, 0.52, 1.0],
               "area_path": [0.55, 0.53, 0.50, 1.0], "area_playground": [0.70, 0.45, 0.30, 1.0],
               "area_grass": [0.33, 0.52, 0.24, 1.0], "area_dirt": [0.50, 0.42, 0.30, 1.0]}.items():
    MATERIALS.setdefault(_k, (_c, 0.9, 0.0))

# порядок = приоритет (кто раньше, тот и занял место)
# area_paving_pedestrian — пешеходные улицы от стены до стены (world/pedestrian_streets.py): главнее всего
AREA_MATERIALS = ["area_paving_pedestrian", "area_playground", "area_parking", "area_paving", "area_path", "area_dirt", "area_grass"]

# ---- битовые слои растра
BLD, ROAD, CORR, WATER, PARKING, HARD, PATH, PROP = (1 << i for i in range(8))
NEAR_BLD, YARD, WOOD, PARK, SCRUB, GRASS, GROUNDS, CEMETERY = (1 << i for i in range(8, 16))
AREA, APT40, URBAN, WALLRING, JUNC, PLAY_NEAR, INDUSTRIAL, FENCE = (1 << i for i in range(16, 24))
PEDZONE = 1 << 24    # пешеходная улица (world/pedestrian_streets.py)

PAVED = {"asphalt", "paving_stones", "concrete", "paved", "sett", "concrete:plates", "concrete:lanes", "bricks",
         "cobblestone", "metal", "wood", "tartan", "rubber", "unhewn_cobblestone", "stone"}
FORESTLIKE_NAMES = ("лесопарк", "роща", "лес", "бор", "дубрава")


def _num(s, default):
    try:
        return float(str(s).replace(",", ".").split()[0].rstrip("m"))
    except (TypeError, ValueError, IndexError):
        return default


class OsmPoints:
    """Точечные объекты OSM, которые OsmData не хранит (деревья, остановки, лавки, входы...)."""
    KEEP = {
        ("natural", "tree"), ("highway", "bus_stop"), ("public_transport", "platform"), ("amenity", "bench"),
        ("amenity", "waste_basket"), ("amenity", "waste_disposal"), ("amenity", "recycling"),
        ("leisure", "playground"), ("highway", "street_lamp"), ("highway", "traffic_signals"),
    }

    def __init__(self, path):
        self.items = []   # (kind, x, y, tags)
        lons, lats, kinds, tags = [], [], [], []
        for _, el in ET.iterparse(path):
            if el.tag == "node":
                if len(el):
                    tg = {c.get("k"): c.get("v") for c in el.iter("tag")}
                    kind = None
                    for k, v in tg.items():
                        if (k, v) in self.KEEP:
                            kind = f"{k}={v}"
                            break
                    if kind is None and "entrance" in tg:
                        kind = "entrance"
                    if kind:
                        lons.append(float(el.get("lon"))); lats.append(float(el.get("lat")))
                        kinds.append(kind); tags.append(tg)
                el.clear()
            elif el.tag in ("way", "relation"):
                el.clear()
        if lons:
            xs, ys = to_world.transform(np.array(lons), np.array(lats))
            self.items = list(zip(kinds, xs, ys, tags))

    def of(self, *kinds):
        return [(x, y, t) for k, x, y, t in self.items if k in kinds]


class Ctx:
    """Общий контекст: рельеф, растр масок, геометрия OSM, дороги, RNG по тайлам."""

    def __init__(self, osm, osm_path, grid, H, roads, net, water, base, bounds, seed=20261013):
        self.osm, self.grid, self.H, self.roads, self.net, self.base = osm, grid, H, roads, net, base
        self.min_x, self.max_x, self.min_y, self.max_y = bounds
        self.seed = seed
        self.world = box(*[self.min_x, self.min_y, self.max_x, self.max_y])
        self.water = [p for p, _, _ in water]
        self.points = OsmPoints(osm_path)
        self.cols = int(round((self.max_x - self.min_x) / RES))
        self.rows = int(round((self.max_y - self.min_y) / RES))
        self.tr = from_origin(self.min_x, self.max_y, RES, RES)
        self.M = np.zeros((self.rows, self.cols), np.uint32)
        # нормали рельефа (как у ноды terrain)
        hm = (H - base).astype(np.float64)
        gz, gx = np.gradient(hm, CELL)
        nrm = np.dstack([-gx, np.ones_like(gx), -gz])
        self.nrm = nrm / np.linalg.norm(nrm, axis=2, keepdims=True)
        # низкочастотный шум (поляны, куртины), 10 м/пиксель, нормирован в [0, 1] по рангу
        rng = np.random.default_rng(seed)
        nz = gaussian_filter(rng.random((self.rows // 10 + 2, self.cols // 10 + 2)), 3.0)
        r = nz.ravel().argsort().argsort().reshape(nz.shape)
        self.noise = r / r.size
        self.tiles_props = defaultdict(list)     # (ix, iz) -> [instance]
        self.tiles_segs = defaultdict(list)      # (ix, iz) -> [segment]
        self.stats = defaultdict(int)

    # ---------- RNG и тайлы
    def rng(self, *key):
        h = self.seed
        for k in key:
            h = (h * 1000003 + (int(k) + 100000)) % (2 ** 63)
        return np.random.default_rng(h)

    @staticmethod
    def tile_key(x, y):
        return int(math.floor(x / TILE)), int(math.floor(-y / TILE))

    def tiles(self):
        return [(ix, iz) for ix in range(int(self.min_x // TILE), int(self.max_x // TILE))
                for iz in range(int(-self.max_y // TILE), int(-self.min_y // TILE))]

    def inside(self, x, y, m=2.0):
        x, y = np.asarray(x), np.asarray(y)
        return (x > self.min_x + m) & (x < self.max_x - m) & (y > self.min_y + m) & (y < self.max_y - m)

    # ---------- растр
    def rast(self, geoms, bit, all_touched=False):
        geoms = [g for g in geoms if g is not None and not g.is_empty]
        if not geoms:
            return
        a = features.rasterize(((g, 1) for g in geoms), out_shape=(self.rows, self.cols), transform=self.tr,
                               dtype="uint8", all_touched=all_touched)
        np.bitwise_or(self.M, np.uint32(bit), out=self.M, where=a.astype(bool))

    def rc(self, x, y):
        c = np.floor((np.asarray(x, np.float64) - self.min_x) / RES).astype(np.int64)
        r = np.floor((self.max_y - np.asarray(y, np.float64)) / RES).astype(np.int64)
        return r, c

    def m(self, x, y):
        r, c = self.rc(x, y)
        ok = (r >= 0) & (r < self.rows) & (c >= 0) & (c < self.cols)
        out = np.full(r.shape, BLD | WATER, np.uint32)  # вне мира — «занято»
        out[ok] = self.M[r[ok], c[ok]]
        return out

    def free(self, x, y, forbid, radius=0.0):
        """True, если в точке (и на окружности radius, 8 направлений) нет битов forbid."""
        x, y = np.asarray(x, np.float64), np.asarray(y, np.float64)
        ok = (self.m(x, y) & forbid) == 0
        if radius > 0:
            for a in np.arange(8) * (math.pi / 4):
                ok &= (self.m(x + radius * math.cos(a), y + radius * math.sin(a)) & forbid) == 0
        return ok

    def stamp(self, x, y, radius):
        """Помечает круг как занятый пропсом."""
        k = int(math.ceil(radius / RES))
        r0, c0 = self.rc(x, y)
        r0, c0 = int(r0), int(c0)
        rs = slice(max(r0 - k, 0), min(r0 + k + 1, self.rows))
        cs = slice(max(c0 - k, 0), min(c0 + k + 1, self.cols))
        if rs.start >= rs.stop or cs.start >= cs.stop:
            return
        rr, cc = np.mgrid[rs, cs]
        d = np.hypot((cc + 0.5) * RES + self.min_x - x, self.max_y - (rr + 0.5) * RES - y)
        sub = self.M[rs, cs]
        sub[d <= radius + 0.5 * RES] |= PROP

    def noise_at(self, x, y):
        r = (self.max_y - np.asarray(y)) / 10.0
        c = (np.asarray(x) - self.min_x) / 10.0
        return map_coordinates(self.noise, [np.atleast_1d(r), np.atleast_1d(c)], order=1, mode="nearest")

    # ---------- высоты и вывод
    def ground(self, x, y):
        """three.y поверхности: рельеф (+0.03 на площадках)."""
        x, y = np.asarray(x, np.float64), np.asarray(y, np.float64)
        h = self.grid.sample(self.H, x, y) - self.base
        return h + np.where((self.m(x, y) & AREA) != 0, AREA_LIFT, 0.0)

    def add(self, typ, x, y, rot, scale=1.0, yv=None, **extra):
        """Добавляет инстанс (мировые x, y; rot — направление «вперёд» модели, рад, three.rotation.y)."""
        if yv is None:
            yv = float(self.ground(np.array([x]), np.array([y]))[0])
        rec = {"type": typ, "x": round(float(x), 2), "y": round(float(yv), 2), "z": round(float(-y), 2),
               "rotY": round(float(rot), 3), "scale": round(float(scale), 2)}
        rec.update(extra)
        self.tiles_props[self.tile_key(x, y)].append(rec)
        self.stats[typ] += 1

    def add_many(self, typ, xs, ys, rots, scales):
        if len(xs) == 0:
            return
        yv = self.ground(xs, ys)
        for x, y, h, r, s in zip(xs, ys, yv, rots, scales):
            self.add(typ, x, y, r, s, yv=h)

    def add_seg(self, typ, a, b, height, **extra):
        ya = float(self.grid.sample(self.H, np.array([a[0]]), np.array([a[1]]))[0] - self.base)
        yb = float(self.grid.sample(self.H, np.array([b[0]]), np.array([b[1]]))[0] - self.base)
        rec = {"type": typ, "x1": round(float(a[0]), 2), "y1": round(ya, 2), "z1": round(float(-a[1]), 2),
               "x2": round(float(b[0]), 2), "y2": round(yb, 2), "z2": round(float(-b[1]), 2),
               "height": round(float(height), 2)}
        rec.update(extra)
        mid = (np.asarray(a) + np.asarray(b)) / 2
        self.tiles_segs[self.tile_key(*mid)].append(rec)
        self.stats[typ] += 1


def rot_of(dx, dy):
    """rotation.y в three, при которой локальная ось −Z модели смотрит в мировом направлении (dx, dy)."""
    return np.arctan2(-np.asarray(dx, np.float64), np.asarray(dy, np.float64))


# =====================================================================================
# геометрия OSM
def collect(ctx):
    osm = ctx.osm
    W = ctx.world
    g = defaultdict(list)

    def clip(p):
        if p is None:
            return None
        p = p.intersection(W)
        return None if p.is_empty else p

    def add_poly(tg, p):
        a, le, lu, na, hw = tg.get("amenity"), tg.get("leisure"), tg.get("landuse"), tg.get("natural"), tg.get("highway")
        surf = tg.get("surface", "")
        if a == "parking" and tg.get("parking") not in ("underground", "multi-storey", "rooftop") \
                and tg.get("building") is None:
            g["parking"].append((p, tg))
        if hw in ("pedestrian", "footway") and tg.get("area") == "yes" or tg.get("place") == "square" \
                or a == "marketplace":
            g["paving"].append(p)
        if le == "playground":
            g["playground"].append(p)
        if le == "pitch" or le == "track":
            if surf in ("rubber", "tartan"):
                g["playground"].append(p)
            elif surf in ("asphalt", "concrete", "paving_stones", "paved"):
                g["paving"].append(p)
            elif surf in ("dirt", "ground", "sand", "compacted", "fine_gravel", "gravel", "clay", "unpaved"):
                g["dirt"].append(p)
            else:
                g["grass"].append(p)
            g["pitch"].append(p)
        if le in ("park", "garden"):
            nm = (tg.get("name") or "").lower()
            if any(w in nm for w in FORESTLIKE_NAMES):
                g["wood"].append(p)
            g["park"].append(p)
            g["grass"].append(p)
        if lu in ("grass", "village_green", "recreation_ground") or le == "common":
            g["grass"].append(p)
            g["lawn"].append(p)
        if na == "wood" or lu == "forest":
            g["wood"].append(p)
        if na == "scrub":
            g["scrub"].append(p)
        if lu == "cemetery" or a == "grave_yard":
            g["cemetery"].append(p)
        if a in ("school", "kindergarten", "university", "college", "hospital", "clinic"):
            g["grounds"].append(p)
        if lu == "residential":
            g["residential"].append(p)
        if lu in ("industrial", "garages", "railway", "construction", "brownfield", "landfill", "quarry") \
                or tg.get("man_made") == "works" or a == "fuel":
            g["industrial"].append(p)

    for wid, (refs, tg) in osm.ways.items():
        if not tg:
            continue
        closed = len(refs) > 3 and refs[0] == refs[-1]
        hw = tg.get("highway")
        bar = tg.get("barrier")
        if closed and (tg.get("area") == "yes" or hw is None) and bar is None:
            p = clip(osm.way_polygon(wid))
            if p is not None:
                add_poly(tg, p)
                continue
        if hw is None and bar is None and tg.get("natural") != "tree_row":
            continue
        pts = osm.way_xy(wid)
        if len(pts) < 2:
            continue
        ln = LineString(pts)
        if not ln.intersects(W):
            continue
        ln = ln.intersection(W)
        if ln.is_empty:
            continue
        surf = tg.get("surface", "")
        wd = _num(tg.get("width"), None)
        if hw in ("footway", "pedestrian", "path", "cycleway", "steps", "track", "bridleway") and tg.get("area") != "yes":
            if tg.get("footway") in ("sidewalk", "crossing") or tg.get("path") == "sidewalk":
                continue
            if tg.get("tunnel") not in (None, "no") or tg.get("bridge") not in (None, "no"):
                continue
            if hw == "pedestrian" and PS.is_ped_street(tg):
                g["walk_lines"].append((ln, 5.0, hw))     # покрытие — полигон зоны (g["ped_streets"]), не буфер линии
                continue
            if hw == "pedestrian":
                w = wd or 5.0; kind = "paving"
            elif hw == "footway":
                w = wd or 2.5; kind = "dirt" if surf in ("ground", "dirt", "unpaved", "grass", "sand", "mud") else "path"
            elif hw == "cycleway":
                w = wd or 2.5; kind = "path"
            elif hw == "steps":
                w = wd or 2.0; kind = "path"
            elif hw == "track":
                w = wd or 3.0; kind = "path" if surf in PAVED else "dirt"
            else:  # path, bridleway
                w = wd or 1.5; kind = "path" if surf in PAVED else "dirt"
            w = float(np.clip(w, 1.0, 8.0))
            g[kind + "_lines"].append((ln, w))
            g["walk_lines"].append((ln, w, hw))
        elif hw == "service" and tg.get("service") == "parking_aisle":
            g["aisles"].append(ln)
        elif bar in ("fence", "wall", "city_wall", "retaining_wall", "hedge"):
            g["barriers"].append((ln, tg))
        elif tg.get("natural") == "tree_row":
            g["tree_rows"].append((ln, tg))
    for rid, tg, mem in osm.rels:
        if tg.get("type") != "multipolygon":
            continue
        p = clip(osm.rel_polygon(mem))
        if p is not None:
            add_poly(tg, p)

    # здания (как в build_world: пропускаем навесы/руины, представитель внутри мира)
    blds = []
    for poly, tg, _ in osm.buildings():
        if tg.get("building") in B.SKIP:
            continue
        rp = poly.representative_point()
        if not ctx.inside(rp.x, rp.y, 1):
            continue
        blds.append((poly, B.category(tg), tg))
    g["buildings"] = blds
    g["ped_streets"] = PS.zones(osm, [p for p, _, _ in blds], W)   # пешеходные улицы от стены до стены
    return g


def road_geometry(ctx, sidewalks=None):
    """Полосы проезжей части, площадки перекрёстков и «коридор» = проезжая часть + 0.3 м + тротуары.
    Тротуары — готовые футпринты из world/sidewalks.py (они важнее площадок); если их не передали —
    приближение: кромка + 3 м (service: + 0.3 м)."""
    carr, corr, junc = [], [], []
    for r in ctx.roads:
        if len(r.axis) < 2:
            continue
        hw = (max(r.Wf, r.Wb) if r.bwd is not None else r.Wf / 2)
        ln = LineString(r.axis)
        side = SIDEWALK_SERVICE if sidewalks is not None or base_class(r.hw) == "service" else SIDEWALK
        carr.append(ln.buffer(hw, cap_style="flat", quad_segs=2))
        corr.append(ln.buffer(hw + side, quad_segs=2))
    for J in ctx.net.junctions.values():
        p = junction_polygon(J)
        if p is not None:
            junc.append(p)
    jpad = SIDEWALK_SERVICE if sidewalks is not None else SIDEWALK
    corr += [j.buffer(jpad, quad_segs=2) for j in junc]
    if sidewalks is not None:
        corr += [q for p in sidewalks for q in B.polygons(p)]
    return carr, corr, junc


def buffer_lines(lines):
    return [ln.buffer(w / 2, cap_style="flat", quad_segs=3) for ln, w in lines]


# =====================================================================================
# растр слоёв
def build_masks(ctx, g, carr, corr, junc):
    blds = [p for p, _, _ in g["buildings"]]
    apts = [p for p, c, tg in g["buildings"] if c == "apartments"]
    ctx.rast(blds, BLD, all_touched=True)
    ctx.rast(carr + junc, ROAD, all_touched=True)
    ctx.rast(corr, CORR, all_touched=True)
    ctx.rast([j.buffer(2.0) for j in junc], JUNC)
    ctx.rast(ctx.water, WATER)
    ctx.rast([p for p, _ in g["parking"]], PARKING)
    ctx.rast(g["paving"] + g["playground"] + g["pitch"] + buffer_lines(g["paving_lines"]) + [z["poly"] for z in g["ped_streets"]], HARD)
    ctx.rast([z["poly"] for z in g["ped_streets"]], PEDZONE)
    ctx.rast(buffer_lines([(ln, w + 1.0) for ln, w in g["path_lines"] + g["dirt_lines"]]), PATH)
    ctx.rast(shapely.buffer(np.array(blds, dtype=object), 3.0, quad_segs=2), NEAR_BLD)
    ctx.rast(g["wood"], WOOD)
    ctx.rast(g["park"], PARK)
    ctx.rast(g["scrub"], SCRUB)
    ctx.rast(g["lawn"], GRASS)
    ctx.rast(g["grounds"], GROUNDS)
    ctx.rast(g["cemetery"], CEMETERY)
    ctx.rast(g["industrial"], INDUSTRIAL)
    ctx.rast([ln.buffer(1.5) for ln, _ in g["barriers"]], FENCE)
    # двор: 4..12 м от стен многоквартирных домов (и прочих жилых в landuse=residential)
    res_union = unary_union(g["residential"]) if g["residential"] else None
    yard_src = list(apts)
    if res_union is not None:
        shapely.prepare(res_union)
        others = [p for p, c, tg in g["buildings"] if c in ("other", "house") and p.area > 120]
        inside = shapely.intersects(res_union, np.array(others, dtype=object)) if others else []
        yard_src += [p for p, f in zip(others, inside) if f]
    ab = np.array(yard_src, dtype=object)
    ctx.rast(shapely.buffer(ab, 20.0, quad_segs=3), YARD)
    a = features.rasterize(((p, 1) for p in shapely.buffer(np.array(blds, dtype=object), 4.0, quad_segs=2)),
                           out_shape=ctx.M.shape, transform=ctx.tr, dtype="uint8")
    ctx.M[a.astype(bool)] &= ~np.uint32(YARD)
    del a
    ctx.rast(shapely.buffer(np.array(apts, dtype=object), 40.0, quad_segs=2), APT40)
    ctx.rast(shapely.buffer(np.array(blds, dtype=object), 60.0, quad_segs=1), URBAN)
    ring = shapely.difference(shapely.buffer(ab, 3.5, quad_segs=2), shapely.buffer(ab, 1.2, quad_segs=2))
    ctx.rast(ring, WALLRING)


# =====================================================================================
# процедурные детские площадки во дворах без площадки в OSM
def procedural_playgrounds(ctx, g, spacing=110.0, size=12.0):
    from scipy.ndimage import minimum_filter
    from scipy.spatial import cKDTree
    bad = BLD | NEAR_BLD | ROAD | CORR | WATER | PARKING | HARD | PATH | WOOD | CEMETERY | FENCE
    # ищем только в зоне многоквартирных домов
    zone = (ctx.M & APT40) != 0
    rows = np.nonzero(zone.any(axis=1))[0]; cols = np.nonzero(zone.any(axis=0))[0]
    if len(rows) == 0:
        return []
    r0, r1, c0, c1 = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
    sub = ctx.M[r0:r1, c0:c1]
    ok = ((sub & bad) == 0) & ((sub & APT40) != 0)
    k = int(math.ceil(size * 1.42 / RES)) + 2      # повёрнутый квадрат + зазор
    fit = minimum_filter(ok.astype(np.uint8), size=k) > 0
    # и не вплотную к домам: центр не ближе 10 м к стене (NEAR_BLD = 3 м, добавляем 7 м сверху)
    fr, fc = np.nonzero(fit[::4, ::4])
    fr = fr * 4 + r0; fc = fc * 4 + c0
    xs = ctx.min_x + (fc + 0.5) * RES; ys = ctx.max_y - (fr + 0.5) * RES
    if len(xs) == 0:
        return []
    apts = [p for p, c, _ in g["buildings"] if c == "apartments"]
    tree = shapely.STRtree(apts)
    pts = shapely.points(xs, ys)
    idx, dist = tree.query_nearest(pts, return_distance=True, all_matches=False)
    d = np.full(len(xs), 1e9); d[idx[0]] = dist
    near = np.full(len(xs), -1); near[idx[0]] = idx[1]
    sel = (d >= 10.0) & (d <= 35.0)
    xs, ys, d, near = xs[sel], ys[sel], d[sel], near[sel]
    # предпочтение: 15–25 м от дома, детерминированный порядок
    rng = ctx.rng(7, 7)
    score = np.abs(d - 18.0) + rng.random(len(xs)) * 6.0
    order = np.argsort(score, kind="stable")
    existing = [p.centroid.coords[0] for p in g["playground"]]
    existing += [(x, y) for x, y, _ in ctx.points.of("leisure=playground")]
    acc = list(existing)
    kd = cKDTree(np.array(acc)) if acc else None
    new_pts = []
    cell = {}
    def far(x, y):
        if kd is not None and kd.query([x, y])[0] < spacing:
            return False
        ci, cj = int(x // spacing), int(y // spacing)
        for a in (-1, 0, 1):
            for b in (-1, 0, 1):
                for (px, py) in cell.get((ci + a, cj + b), ()):
                    if (px - x) ** 2 + (py - y) ** 2 < spacing ** 2:
                        return False
        return True
    out = []
    for i in order:
        x, y = xs[i], ys[i]
        if not far(x, y):
            continue
        cell.setdefault((int(x // spacing), int(y // spacing)), []).append((x, y))
        # ориентация по ближайшему дому
        mrr = np.asarray(apts[near[i]].minimum_rotated_rectangle.exterior.coords)
        e = mrr[1] - mrr[0]
        ang = math.atan2(e[1], e[0])
        c, s = math.cos(ang), math.sin(ang)
        hs = size / 2
        corners = [(x + c * u - s * v, y + s * u + c * v) for u, v in ((-hs, -hs), (hs, -hs), (hs, hs), (-hs, hs))]
        out.append((shapely.Polygon(corners), ang))
    return out


# =====================================================================================
# площадки: материалы по приоритету, укладка на треугольники рельефа
def drape(ctx, geom, ix, iz, prim):
    """Режет geom (внутри тайла) по треугольникам ячеек рельефа 5 м и кладёт +AREA_LIFT.
    Каждый кусок лежит в одном треугольнике heightmap, поэтому площадка точно параллельна рельефу."""
    n = int(TILE / CELL)
    x0, z0 = ix * TILE, iz * TILE
    tr = from_origin(x0, -z0, CELL, CELL)
    cand = features.rasterize([(geom, 1)], out_shape=(n, n), transform=tr, all_touched=True, dtype="uint8")
    rr, cc = np.nonzero(cand)
    if len(rr) == 0:
        return 0
    X0 = x0 + cc * CELL; X1 = X0 + CELL
    Y0 = -(z0 + rr * CELL); Y1 = Y0 - CELL           # y севера сверху; строка +1 = южнее
    # треугольники: (r,c)-(r+1,c)-(r+1,c+1) и (r,c)-(r+1,c+1)-(r,c+1)
    A = np.c_[X0, Y0]; Bp = np.c_[X0, Y1]; C = np.c_[X1, Y1]; D = np.c_[X1, Y0]
    ring1 = np.stack([A, Bp, C, A], axis=1)
    ring2 = np.stack([A, C, D, A], axis=1)
    tris = shapely.polygons(np.concatenate([ring1, ring2]))
    shapely.prepare(geom)
    full = shapely.contains(geom, tris)
    pos, idx = [], []
    nv = 0
    # целые треугольники: общие вершины по узлам сетки
    nf = int(full.sum())
    if nf:
        k = len(rr)
        node = lambda r, c: r * (n + 1) + c
        tri_nodes = np.concatenate([
            np.c_[node(rr, cc), node(rr + 1, cc), node(rr + 1, cc + 1)],
            np.c_[node(rr, cc), node(rr + 1, cc + 1), node(rr, cc + 1)]])[full]
        used, inv = np.unique(tri_nodes, return_inverse=True)
        ur, uc = used // (n + 1), used % (n + 1)
        pos.append(np.c_[x0 + uc * CELL, -(z0 + ur * CELL)])
        idx.append(inv.reshape(-1, 3))
        nv = len(used)
    part = ~full
    if part.any():
        inter = shapely.intersection(tris[part], geom)
        for gm in inter:
            if gm.is_empty or gm.area < 0.01:
                continue
            for p in B.polygons(gm):
                if p.area < 0.01:
                    continue
                V, T = B.triangulate(p)
                if V is None:
                    continue
                pos.append(V); idx.append(T + nv); nv += len(V)
    if not pos:
        return 0
    V = np.concatenate(pos); T = np.concatenate(idx)
    # сварка вершин: куски соседних треугольников делят рёбра
    Vr, inv = np.unique(np.round(V, 3), axis=0, return_inverse=True)
    V, T = Vr, inv.ravel()[T]
    T = T[(T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2])]
    y = ctx.grid.sample(ctx.H, V[:, 0], V[:, 1]) - ctx.base + AREA_LIFT
    P = np.c_[V[:, 0], y, -V[:, 1]]
    T = fix_winding(P, T, np.array([0, 1.0, 0]))
    r, c = ctx.grid.to_rc(V[:, 0], V[:, 1])
    N = np.stack([map_coordinates(ctx.nrm[:, :, k], [r, c], order=1, mode="nearest") for k in range(3)], axis=1)
    N /= np.linalg.norm(N, axis=1, keepdims=True)
    prim.add(P, T, N, np.c_[P[:, 0], P[:, 2]])
    return len(T)


def build_areas(ctx, g, carr, corr, junc, extra_playgrounds):
    srcs = {
        "area_paving_pedestrian": [z["poly"] for z in g.get("ped_streets", [])],
        "area_playground": g["playground"] + extra_playgrounds,
        "area_parking": [p for p, _ in g["parking"]],
        "area_paving": g["paving"] + buffer_lines(g["paving_lines"]),
        "area_path": buffer_lines(g["path_lines"]),
        "area_dirt": g["dirt"] + buffer_lines(g["dirt_lines"]),
        "area_grass": g["grass"],
    }
    srcs = {k: [p if p.is_valid else p.buffer(0) for p in v if p is not None and not p.is_empty] for k, v in srcs.items()}
    trees = {k: shapely.STRtree(v) for k, v in srcs.items() if v}
    forb_src = [p for p, _, _ in g["buildings"]] + corr + ctx.water
    forb_tree = shapely.STRtree(forb_src)
    # под лесом площадку-газон не кладём: там рельеф (лесная подстилка), деревья всё закрывают
    minus = {"area_grass": (shapely.STRtree(g["wood"]), g["wood"])} if g["wood"] else {}
    out = defaultdict(dict)
    ntri = defaultdict(int); area_m2 = defaultdict(float)
    final_geoms = []
    for ix, iz in ctx.tiles():
        tb = box(ix * TILE, -(iz + 1) * TILE, (ix + 1) * TILE, -iz * TILE)
        hits = {k: t.query(tb, predicate="intersects") for k, t in trees.items()}
        if not any(len(h) for h in hits.values()):
            continue
        fi = forb_tree.query(tb, predicate="intersects")
        claimed = unary_union([forb_src[i] for i in fi]) if len(fi) else None
        for mat in AREA_MATERIALS:
            h = hits.get(mat)
            if h is None or len(h) == 0:
                continue
            geom = unary_union([srcs[mat][i] for i in h]).intersection(tb)
            if claimed is not None:
                geom = geom.difference(claimed)
            if mat in minus:
                mi = minus[mat][0].query(tb, predicate="intersects")
                if len(mi):
                    geom = geom.difference(unary_union([minus[mat][1][i] for i in mi]))
            geom = geom.buffer(0)
            if geom.is_empty or geom.area < 1.0:
                continue
            # убираем узкие хвосты (< 0.5 м)
            geom = geom.buffer(-0.25, quad_segs=2).buffer(0.25, quad_segs=2).intersection(tb)
            if geom.is_empty or geom.area < 1.0:
                continue
            prim = Prim()
            nt = drape(ctx, geom, ix, iz, prim)
            if nt:
                out[(ix, iz)][mat] = prim
                ntri[mat] += nt; area_m2[mat] += geom.area
                final_geoms.append(geom)
            claimed = geom if claimed is None else unary_union([claimed, geom])
    ctx.rast(final_geoms, AREA)
    return out, ntri, area_m2


# =====================================================================================
class YardResult:
    def __init__(self, areas, ctx, info):
        self.areas = areas          # (ix, iz) -> {material: Prim}
        self.ctx = ctx
        self.info = info

    def write_props(self, out_dir):
        """Пишет props/{ix}_{iz}.json; возвращает {(ix, iz): 'props/ix_iz.json'}."""
        d = out_dir / "props"
        d.mkdir(parents=True, exist_ok=True)
        files, total = {}, 0
        keys = set(self.ctx.tiles_props) | set(self.ctx.tiles_segs)
        for k in sorted(keys):
            inst = self.ctx.tiles_props.get(k, [])
            segs = self.ctx.tiles_segs.get(k, [])
            if not inst and not segs:
                continue
            f = f"props/{k[0]}_{k[1]}.json"
            js = json.dumps({"version": 1, "ix": k[0], "iz": k[1], "instances": inst, "segments": segs},
                            ensure_ascii=False, separators=(",", ":"))
            (out_dir / f).write_text(js)
            total += len(js)
            files[k] = f
        self.info["props_files"] = len(files)
        self.info["props_bytes"] = total
        return files


def build(osm, osm_path, grid, H, roads, net, water, base, bounds, log=print, sidewalks=None):
    """Точка входа из build_world.py. Возвращает YardResult (площадки по тайлам + пропсы)."""
    from . import props as P
    ctx = Ctx(osm, osm_path, grid, H, roads, net, water, base, bounds)
    g = collect(ctx)
    carr, corr, junc = road_geometry(ctx, sidewalks)
    ctx.carr, ctx.corr, ctx.junc = carr, corr, junc
    build_masks(ctx, g, carr, corr, junc)
    log(f"дворы: OSM парковок {len(g['parking'])}, площадок {len(g['playground'])}, парков {len(g['park'])}, "
        f"лесов {len(g['wood'])}, дорожек {len(g['path_lines']) + len(g['dirt_lines'])}, оград {len(g['barriers'])}")
    extra = procedural_playgrounds(ctx, g)
    ctx.rast([p for p, _ in extra], HARD)
    ctx.rast([p.buffer(60) for p in g["playground"]] + [p.buffer(60) for p, _ in extra], PLAY_NEAR)
    areas, ntri, area_m2 = build_areas(ctx, g, carr, corr, junc, [p for p, _ in extra])
    log("дворы: площадки " + ", ".join(f"{k} {area_m2[k] / 1e6:.3f} км² ({ntri[k]} тр.)" for k in AREA_MATERIALS)
        + f"; процедурных детплощадок {len(extra)}")
    P.place_all(ctx, g, extra, log)
    ctx.g, ctx.extra_playgrounds = g, extra      # для world/streetlife.py
    info = {"area_m2": dict(area_m2), "area_tris": dict(ntri), "extra_playgrounds": len(extra),
            "counts": dict(ctx.stats)}
    return YardResult(areas, ctx, info)
