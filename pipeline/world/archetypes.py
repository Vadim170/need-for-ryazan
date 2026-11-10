"""Архетипы зданий Рязани: классификация, этажность, крыша, цвет фасада (docs/stage2/buildings.md).

Источники (по приоритету для этажности): OSM height / building:levels -> реестр ЖКХ (data/processed/building_registry.json)
-> панорамы (building_facades.json, levels_est) -> тень на ортофото (building_ortho.json, sh_prof) -> догадка по
архетипу и соседям (kNN по форме футпринта и положению среди зданий с известной этажностью).

Выход: список BuildingSpec (по одному на объём: здание или building:part), из которого building_geom.py строит меши.
"""
import hashlib
import json
import math
import re
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import dataclass, field

import numpy as np
from shapely.geometry import MultiPolygon, Point, Polygon
from shapely.prepared import prep
from shapely.strtree import STRtree

from config import DATA_PROCESSED, to_world
from .osm import parse_numbers

# ---------------------------------------------------------------- архетипы (id — контракт с шейдером, docs/world-format.md)
ARCH = {
    "other": 0, "panel5": 1, "brick5": 2, "panel9": 3, "tower": 4, "stalinka": 5, "merchant": 6, "house": 7,
    "modern": 8, "commercial": 9, "garage": 10, "industrial": 11, "church": 12, "school": 13, "public": 14, "shed": 15,
}
ARCH_NAME = {v: k for k, v in ARCH.items()}

# высота этажа, цоколь (м); шаг окон по горизонтали (м) — тот же, что в шейдере (game/src/world/building-material.ts)
STYLE = {
    #            fh    plinth  win_step  parapet
    "other":      (3.2, 0.6, 3.2, 0.5),
    "panel5":     (2.75, 0.9, 3.2, 0.5),
    "brick5":     (2.85, 0.9, 3.0, 0.4),
    "panel9":     (2.8, 1.2, 3.0, 0.7),
    "tower":      (2.8, 1.2, 3.0, 0.8),
    "stalinka":   (3.4, 1.1, 3.4, 0.6),
    "merchant":   (3.9, 0.8, 3.0, 0.5),
    "house":      (3.0, 0.5, 3.4, 0.0),
    "modern":     (3.0, 0.9, 3.3, 0.9),
    "commercial": (4.2, 0.3, 4.0, 0.8),
    "garage":     (3.0, 0.0, 3.5, 0.0),
    "industrial": (5.5, 0.2, 6.0, 0.6),
    "church":     (5.0, 0.8, 4.0, 0.0),
    "school":     (3.6, 0.8, 3.0, 0.7),
    "public":     (3.5, 0.8, 3.2, 0.7),
    "shed":       (2.6, 0.1, 4.0, 0.0),
}

# палитры фасадов (sRGB hex) по архетипам; цвет из панорам важнее
PALETTE = {
    "other": ["#bfb8ab", "#c9c2b4", "#b3aca0", "#d0c8b8"],
    "panel5": ["#c9c4b9", "#bdb9b0", "#d3ccbe", "#d8d5ce", "#cbbf9f", "#b8c2c4", "#c4b8a8"],
    "brick5": ["#9c5b47", "#a8654f", "#8f533f", "#d6d1c4", "#cfc8b9", "#c9c1ae"],
    "panel9": ["#d0cdc5", "#c1bcb2", "#d8d4c8", "#c9c9c4", "#bcc2c4", "#d3c9b5"],
    "tower": ["#d4cfc3", "#c8c2b4", "#b9775e", "#d9d6cf", "#c4c8cb"],
    "stalinka": ["#d9be8a", "#dcae8e", "#d4a79b", "#e0d6c0", "#c4c9a8", "#e3cfa3", "#cfb79a"],
    "merchant": ["#c9785a", "#e2bf80", "#c98f7a", "#c2cbb8", "#e8e2d4", "#aebccb", "#d9a7a0", "#b56a4f"],
    "house": ["#7a5a3e", "#8a6a48", "#5d7d6b", "#6b85a3", "#a3604a", "#d8d2c0", "#c7b48a", "#9b8f7c", "#b08a5c"],
    "modern": ["#e0d8c8", "#d6cbb8", "#e6e2da", "#cdbfa8", "#d8c3a5", "#c9d0d4"],
    "commercial": ["#a9b3bd", "#cfcfcf", "#8e9aa6", "#bcb5a8", "#d8d2c4", "#9fa8a0"],
    "garage": ["#8f8a82", "#a19a8e", "#7d7a74", "#9c9284"],
    "industrial": ["#a7a49c", "#b0a690", "#9aa3a8", "#b8b2a4", "#8f8b84"],
    "church": ["#ece8de", "#f0ebe0", "#e9dcc0", "#e6d3c9"],
    "school": ["#d7c8a6", "#c9c0b0", "#d9b99a", "#cfd0c4"],
    "public": ["#cfc8bb", "#d6cfbf", "#c2bfb7", "#d2c3a5"],
    "shed": ["#6e5a45", "#8a8378", "#7b6a55", "#9a9488"],
}
PALETTE_WOOD = ["#7a5a3e", "#8a6a48", "#5d7d6b", "#6b85a3", "#6e5a45"]          # реестр: стены деревянные
PALETTE_BRICK = ["#9c5b47", "#a8654f", "#8f533f", "#d6d1c4", "#cfc8b9", "#b9775e"]  # реестр: кирпич (красный/силикатный)
ROOF_PALETTE = {  # скатные крыши (металл/шифер), если нет цвета с ортофото
    "pitched": ["#5f6b5e", "#7a4a3c", "#6a6f75", "#8a8f93", "#4f6a52", "#7c5b46", "#94918a"],
    "flat": ["#5a5856", "#66625e", "#4e4d4c", "#6e6c68"],
}

# исторический центр (Кремль — Почтовая — Соборная — Свободы — пл. Победы), lat/lon
CENTER_LL = [(54.6405, 39.7535), (54.6402, 39.7330), (54.6357, 39.7200), (54.6312, 39.7105), (54.6255, 39.7135),
             (54.6222, 39.7260), (54.6238, 39.7420), (54.6268, 39.7545), (54.6330, 39.7580)]
CORE_LL = [(54.6392, 39.7520), (54.6372, 39.7340), (54.6318, 39.7250), (54.6268, 39.7290), (54.6262, 39.7470),
           (54.6300, 39.7540)]

SKIP = {"roof", "carport", "no", "ruins", "collapsed", "demolished", "entrance", "construction"}
APART = {"apartments", "residential", "dormitory", "flats", "hotel"}
HOUSE = {"house", "detached", "semidetached_house", "terrace", "bungalow", "cabin", "farm", "static_caravan"}
GARAGE = {"garages", "garage", "carport"}
SHED = {"shed", "hut", "kiosk", "storage_tank", "transformer_tower", "greenhouse", "toilets", "barn", "sty", "cowshed"}
COMMERCIAL = {"commercial", "retail", "supermarket", "mall", "shop", "kiosk_shop", "warehouse_retail"}
INDUSTRIAL = {"industrial", "warehouse", "service", "hangar", "factory", "manufacture", "depot", "storage", "boathouse"}
PUBLIC = {"office", "public", "civic", "government", "hospital", "university", "college", "train_station",
          "transportation", "sports_hall", "sports_centre", "stadium", "fire_station", "military", "theatre", "museum"}
CHURCH = {"church", "cathedral", "chapel", "temple", "religious", "monastery", "bell_tower", "mosque", "synagogue"}
SCHOOL = {"school", "kindergarten"}

LEVEL_SOURCES = ["osm_height", "osm_levels", "registry", "panorama", "shadow", "archetype"]


@dataclass
class BuildingSpec:
    key: str                    # w123 / r123 (часть: w123 тоже, но part=True)
    poly: Polygon
    tags: dict
    arch: str = "other"
    levels: int = 2
    levels_src: str = "archetype"
    fh: float = 3.0
    plinth: float = 0.6
    min_h: float = 0.0          # низ объёма над землёй (building:min_level / min_height)
    wall_h: float = 6.6         # высота верха стен над землёй (без парапета)
    roof: str = "flat"          # flat / gabled / hipped / pyramidal / dome / onion / mansard / skillion
    roof_h: float = 0.0         # подъём крыши (скатной/купола)
    pitch: float = 0.0          # градусы
    parapet: float = 0.0
    cornice: bool = False
    color: tuple = (0.7, 0.7, 0.7)       # sRGB 0..1
    roof_color: tuple = (0.4, 0.4, 0.4)  # sRGB 0..1
    color_src: str = "palette"
    seed: int = 0
    shopfront: bool = False
    part: bool = False
    sections: int = 1
    series: str = ""
    year: int = 0
    tile_pt: tuple = (0.0, 0.0)  # точка привязки к тайлу (у частей — точка здания)
    extra: dict = field(default_factory=dict)


# ---------------------------------------------------------------- утилиты
def seed_of(key):
    return int(hashlib.md5(key.encode()).hexdigest()[:8], 16)


def hex2rgb(h):
    h = h.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


NAMED_COLORS = {"white": "#ece8de", "yellow": "#e3c886", "orange": "#d9955a", "red": "#a8473a", "brown": "#7a5236",
                "green": "#4f7a52", "blue": "#4f6f9a", "grey": "#8f8f8c", "gray": "#8f8f8c", "black": "#2e2e2e",
                "beige": "#d8c8a6", "pink": "#d8a7a0", "gold": "#d4a63a", "silver": "#b8bcc0", "darkgreen": "#2f5a3a",
                "lightblue": "#8fb2cf", "maroon": "#6a2a2a", "cream": "#ece2c4"}


def parse_colour(s):
    if not s:
        return None
    s = s.strip().lower()
    if s.startswith("#") and len(s) in (4, 7):
        try:
            return hex2rgb(s)
        except ValueError:
            return None
    return hex2rgb(NAMED_COLORS[s]) if s in NAMED_COLORS else None


def ll_poly(ll):
    xs, ys = to_world.transform([lo for la, lo in ll], [la for la, lo in ll])
    return Polygon(list(zip(xs, ys)))


def rect_frame(poly):
    mrr = poly.minimum_rotated_rectangle
    if mrr.geom_type != "Polygon":
        b = poly.bounds
        return np.array([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]), np.array([1.0, 0.0]), max(b[2] - b[0], 1), max(b[3] - b[1], 1), 1.0
    c = np.asarray(mrr.exterior.coords)[:4]
    e1, e2 = c[1] - c[0], c[2] - c[1]
    l1, l2 = float(np.hypot(*e1)), float(np.hypot(*e2))
    if l1 >= l2:
        u, L, W = e1 / max(l1, 1e-9), l1, l2
    else:
        u, L, W = e2 / max(l2, 1e-9), l2, l1
    return c.mean(axis=0), u, L, W, poly.area / max(mrr.area, 1e-9)


def _year(tg):
    m = re.search(r"(1[6-9]\d\d|20\d\d)", tg.get("start_date", "") or tg.get("building:year", ""))
    return int(m.group(1)) if m else 0


def _load_json(path):
    if not path.exists():
        return {}
    try:
        d = json.loads(path.read_text())
    except Exception:
        return {}
    if isinstance(d, dict) and isinstance(d.get("buildings"), dict):
        d = d["buildings"]
    out = {}
    for k, v in (d.items() if isinstance(d, dict) else []):
        if not isinstance(v, dict):
            continue
        ks = str(k)
        m = re.match(r"^(?:(w|r|way|relation)[/_:]?)?(\d+)$", ks)
        if not m:
            continue
        if m.group(1):
            out[("r" if m.group(1).startswith("r") else "w") + m.group(2)] = v
        else:   # голый id: путь или отношение — кладём под оба ключа (пути важнее)
            out.setdefault("w" + m.group(2), v)
            out.setdefault("r" + m.group(2), v)
    return out


def _num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    n = parse_numbers(str(v))
    return max(n) if n else None


# ---------------------------------------------------------------- контекст: landuse, POI, плотность частного сектора
class Context:
    def __init__(self, osm, osm_path, buildings):
        self.center = prep(ll_poly(CENTER_LL))
        self.core = prep(ll_poly(CORE_LL))
        lu = defaultdict(list)
        for wid, (refs, tg) in osm.ways.items():
            if len(refs) < 4 or refs[0] != refs[-1]:
                continue
            k = self._lu_kind(tg)
            if k:
                p = osm.way_polygon(wid)
                if p is not None:
                    lu[k].append(p)
        for rid, tg, mem in osm.rels:
            if tg.get("type") == "multipolygon":
                k = self._lu_kind(tg)
                if k:
                    p = osm.rel_polygon(mem)
                    if p is not None:
                        lu[k].append(p)
        self.lu = {k: (STRtree(v), v) for k, v in lu.items()}
        # POI (магазины/кафе/офисы на первых этажах): узлы с shop/amenity/office
        pts = []
        for _, el in ET.iterparse(osm_path):
            if el.tag == "node":
                if len(el):
                    tg = {c.get("k"): c.get("v") for c in el.iter("tag")}
                    if "shop" in tg or tg.get("amenity") in ("cafe", "restaurant", "bank", "pharmacy", "fast_food", "bar",
                                                             "post_office", "clinic", "dentist") or "office" in tg:
                        pts.append((float(el.get("lon")), float(el.get("lat"))))
                el.clear()
            elif el.tag in ("way", "relation"):
                el.clear()
        if pts:
            xs, ys = to_world.transform([p[0] for p in pts], [p[1] for p in pts])
            self.poi = np.c_[xs, ys]
        else:
            self.poi = np.zeros((0, 2))
        # плотность частных домов
        self.bxy = np.array([b[1].representative_point().coords[0] for b in buildings])
        self.is_house = np.array([b[2].get("building") in HOUSE for b in buildings])
        self.btree = STRtree([b[1] for b in buildings])
        self.bpolys = [b[1] for b in buildings]

    @staticmethod
    def _lu_kind(tg):
        lu, am = tg.get("landuse"), tg.get("amenity")
        if am in ("school", "kindergarten", "college", "university"):
            return "school" if am in ("school", "kindergarten") else "edu"
        if am in ("hospital", "clinic"):
            return "hospital"
        if lu in ("industrial", "railway", "construction", "depot", "port"):
            return "industrial"
        if lu == "garages":
            return "garages"
        if lu in ("retail", "commercial"):
            return "commercial"
        if lu == "residential":
            return "residential"
        if lu in ("allotments", "farmyard"):
            return "allotments"
        if lu == "religious" or am == "place_of_worship":
            return "religious"
        return None

    def in_lu(self, kind, pt):
        if kind not in self.lu:
            return False
        tree, polys = self.lu[kind]
        P = Point(pt)
        return any(polys[i].contains(P) for i in tree.query(P))

    def house_share(self, i, r=110.0):
        d = np.hypot(*(self.bxy - self.bxy[i]).T)
        m = d < r
        n = m.sum()
        return float(self.is_house[m].sum() / max(n, 1)), int(n)

    def poi_in(self, poly):
        if not len(self.poi):
            return 0
        x0, y0, x1, y1 = poly.bounds
        sel = self.poi[(self.poi[:, 0] > x0 - 3) & (self.poi[:, 0] < x1 + 3) & (self.poi[:, 1] > y0 - 3) & (self.poi[:, 1] < y1 + 3)]
        if not len(sel):
            return 0
        pb = poly.buffer(3.0)
        return sum(pb.contains(Point(p)) for p in sel)


# ---------------------------------------------------------------- классификация
def coarse_class(tg, poly, ctx, i, fr, ortho):
    """Грубый класс: apart / house / commercial / industrial / garage / shed / church / school / public / other."""
    b = tg.get("building", "yes")
    am = tg.get("amenity")
    area = poly.area
    _, _, L, W, rect = fr
    if b in CHURCH or am == "place_of_worship":
        return "church"
    if b in SCHOOL or am in ("school", "kindergarten"):
        return "school"
    if b in GARAGE:
        return "garage"
    if b in SHED:
        return "shed"
    if b in HOUSE:
        return "house"
    if b in APART:
        return "apart"
    if b in COMMERCIAL or "shop" in tg:
        return "commercial"
    if b in INDUSTRIAL:
        return "industrial"
    if b in PUBLIC or am in ("hospital", "clinic", "townhall", "police", "courthouse", "library", "theatre", "cinema",
                             "university", "college", "bank", "post_office", "community_centre", "arts_centre"):
        return "public"
    # building=yes и прочее: по контексту
    pt = poly.representative_point().coords[0]
    if area < 25:
        return "shed"
    if ctx.in_lu("garages", pt) and area < 1200:
        return "garage"
    if ctx.in_lu("school", pt):
        return "school" if area > 400 else "shed"
    if ctx.in_lu("industrial", pt):
        return "industrial" if area > 60 else "shed"
    if ctx.in_lu("hospital", pt) or ctx.in_lu("edu", pt):
        return "public" if area > 150 else "shed"
    if ctx.in_lu("religious", pt) and area > 60:
        return "church" if area < 1500 else "public"
    hs, n = ctx.house_share(i)
    if area < 70 and W < 6 and L > 2.5 * W and n > 3:
        return "garage"     # узкая ячейка ряда гаражей
    if area < 60:
        return "shed"
    if hs > 0.35 and area < 260:
        return "house"
    if hs > 0.15 and area < 220 and not ctx.center.contains(Point(pt)):
        return "house"
    if ctx.in_lu("allotments", pt) and area < 200:
        return "house"
    if ctx.in_lu("commercial", pt):
        return "commercial"
    if ctx.center.contains(Point(pt)):
        return "apart" if area > 120 else "house"
    if area < 160:
        return "house" if hs > 0.12 else "shed"
    if ctx.in_lu("residential", pt) and 9 <= W <= 18 and L >= 25:
        return "apart"
    if area > 2500 and rect > 0.8:
        return "industrial"
    if 9 <= W <= 16 and L >= 30 and rect > 0.6:
        return "apart"      # вытянутый корпус шириной секции жилого дома
    if ctx.in_lu("residential", pt):
        return "apart"
    return "public" if area < 2500 else "industrial"


def fine_arch(cc, levels, tg, poly, fr, ctx, reg, fac, sd, center, core):
    """Архетип по грубому классу, этажности, эпохе, месту и форме."""
    _, _, L, W, rect = fr
    year = _year(tg) or int(_num((reg or {}).get("year")) or 0)
    series = str((reg or {}).get("series") or "").lower()
    # в реестре «серия» часто — материал стен («кирпичный», «панельный»): учитываем как материал
    wall = (str((reg or {}).get("wall_material") or "") + " " + series).lower()
    if (reg or {}).get("wall_material"):
        fmat = ""          # материал с панорам — лишь догадка по цвету; материал стен из реестра важнее
    fmat = (fac or {}).get("material", "") if _facade_ok(fac) else ""
    area = poly.area
    r = (sd % 1000) / 1000.0
    if cc == "church":
        return "church"
    if cc == "school":
        return "school"
    if cc == "garage":
        return "garage"
    if cc == "shed":
        return "shed"
    if cc == "industrial":
        return "industrial"
    if cc == "commercial":
        if center and levels >= 3 and year and year < 1958:
            return "stalinka" if year >= 1930 else "merchant"
        if center and levels <= 3 and area < 500 and core:
            return "merchant"
        return "commercial" if levels <= 4 or area > 1500 else "modern"
    if cc == "public":
        if center and levels <= 3 and area < 700 and (core or (year and year < 1917)):
            return "merchant"
        if center and 3 <= levels <= 6 and (not year or year < 1960):
            return "stalinka"
        return "public"
    if cc == "house":
        if center and core and levels >= 2 and area > 90:
            return "merchant"
        return "house"
    # жилые многоквартирные
    if series:
        if "464" in series or "468" in series or "467" in series:
            return "panel5"
        if "447" in series or "511" in series or "1-439" in series:
            return "brick5"
        if "п-44т" in series or "п44т" in series or "п-3" in series:
            return "tower"
        if re.search(r"ii-49|ii-18|п-44|(?<!\d)(121|124|90|97|111м?|114|83)(?!\d)", series):
            return "tower" if (L / max(W, 1) < 1.6 and area < 900) else "panel9"
        if ("индивид" in series or "монолит" in series) and year and year >= 1995:
            return "modern"
        if "индивид" in series and year and year < 1958:
            return "stalinka" if year >= 1930 else "merchant"
    if "дерев" in wall and levels <= 3:
        return "house"          # деревянные двухэтажки/бараки: брёвна/доска, наличники
    if year and year >= 1995 and levels >= 3:
        return "modern"
    if year and year < 1917:
        return "merchant" if levels <= 3 else "stalinka"
    if year and 1930 <= year < 1958 and levels >= 2:
        return "stalinka"
    if levels <= 1:
        return "merchant" if (center and core) else "house"
    if levels <= 2:
        if center:
            return "merchant" if (core or area < 400) else "stalinka"
        return "stalinka" if area > 250 else "house"
    if levels <= 4:
        if center:
            return "merchant" if (levels == 3 and area < 600 and core) else "stalinka"
        if year and year >= 1958:
            return "brick5"
        return "stalinka" if (rect < 0.85 or W > 13) else "brick5"
    if levels == 5:
        if center and (rect < 0.8 or W > 14 or (year and year < 1958)):
            return "stalinka"
        if "панел" in wall or "блоч" in wall or fmat == "panel_grey":
            return "panel5"
        if "кирп" in wall or fmat == "brick_red":
            return "brick5"
        if fmat == "white_silicate_or_plaster":
            return "brick5" if r < 0.5 else "panel5"
        if fmat in ("plaster_yellow", "plaster_pink", "plaster_beige") and center:
            return "stalinka"
        return "panel5" if r < 0.55 else "brick5"
    if levels <= 8:
        if center and levels <= 7 and (not year or year < 1960) and fmat not in ("panel_grey",):
            return "stalinka"
        return "modern" if (rect < 0.75 or "монол" in wall or (year and year >= 1990)) else "panel9"
    squareish = L / max(W, 1) < 1.7 and area < 1000
    if levels >= 18:
        return "modern"
    if "монол" in wall or fmat in ("plaster_colored",):
        return "modern"
    if levels >= 12:
        return "tower" if squareish else ("modern" if rect < 0.7 else "panel9")
    return "tower" if squareish else "panel9"


# ---------------------------------------------------------------- оценка этажности (kNN по зданиям с известной этажностью)
CLASS_IDX = {c: i for i, c in enumerate(["apart", "house", "commercial", "industrial", "garage", "shed", "church", "school",
                                         "public", "other"])}


def _features(poly, fr, cc, sh):
    ctr, u, L, W, rect = fr
    x, y = poly.representative_point().coords[0]
    f = [math.log(max(poly.area, 1)) * 1.2, W / 3.0, math.log(max(L / max(W, 1), 1)) * 1.5, rect * 1.5, x / 350, y / 350]
    oh = [0.0] * len(CLASS_IDX)
    oh[CLASS_IDX.get(cc, 9)] = 6.0
    return f + oh, (sh / 3.0 if sh is not None else None)


class LevelModel:
    """Взвешенная медиана k ближайших (форма + положение + класс [+ длина тени]); LOO-ошибка для отчёта."""

    def __init__(self, feats, shs, levels, k=7):
        self.F = np.array(feats)
        self.S = np.array([s if s is not None else np.nan for s in shs])
        self.y = np.array(levels, float)
        self.k = k
        self.hasS = ~np.isnan(self.S)

    def _pred(self, f, s, exclude=None, use_shadow=True):
        d2 = ((self.F - f) ** 2).sum(axis=1)
        if use_shadow and s is not None:
            mask = self.hasS.copy()
            d2 = d2 + np.where(mask, (self.S - s) ** 2 * 2.0, np.inf)
        if exclude is not None:
            d2[exclude] = np.inf
        idx = np.argpartition(d2, self.k)[:self.k]
        idx = idx[np.isfinite(d2[idx])]
        if not len(idx):
            return None
        w = 1.0 / (np.sqrt(d2[idx]) + 0.15)
        o = np.argsort(self.y[idx])
        cw = np.cumsum(w[o])
        return float(self.y[idx][o][np.searchsorted(cw, cw[-1] / 2)])

    def predict(self, f, s):
        if s is not None and self.hasS.sum() > 50:
            v = self._pred(np.array(f), s)
            if v is not None:
                return v, "shadow"
        return self._pred(np.array(f), None, use_shadow=False), "archetype"

    def loo(self, n=1200, seed=3):
        rng = np.random.default_rng(seed)
        idx = rng.choice(len(self.y), min(n, len(self.y)), replace=False)
        # сравнение на одних и тех же зданиях (с измеренной тенью): без тени / с тенью; отдельно многоквартирные
        e_a, e_s, apt = [], [], []
        for i in idx:
            if not self.hasS[i]:
                continue
            a = self._pred(self.F[i], None, exclude=i, use_shadow=False)
            b = self._pred(self.F[i], self.S[i], exclude=i)
            if a is None or b is None:
                continue
            e_a.append(abs(a - self.y[i])); e_s.append(abs(b - self.y[i]))
            apt.append(self.F[i][6 + CLASS_IDX["apart"]] > 3)
        e_a, e_s, apt = np.array(e_a), np.array(e_s), np.array(apt, bool)
        r = lambda v: round(float(np.mean(v)), 2) if len(v) else None
        return {"mae_no_shadow": r(e_a), "mae_with_shadow": r(e_s),
                "mae_apart_no_shadow": r(e_a[apt]), "mae_apart_with_shadow": r(e_s[apt]),
                "within1_apart_with_shadow": round(float(np.mean(e_s[apt] <= 1)), 2) if apt.any() else None,
                "n_train": int(len(self.y)), "n_eval": int(len(e_a))}


# ---------------------------------------------------------------- главный проход
def _polys(g):
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    return [x for x in getattr(g, "geoms", []) if isinstance(x, Polygon)]


def _parts(osm):
    """building:part: (key, polygon, tags)."""
    out = []
    for wid, (refs, tg) in osm.ways.items():
        if tg.get("building:part", "no") not in ("no", "roof") and len(refs) > 3 and refs[0] == refs[-1]:
            p = osm.way_polygon(wid)
            if p is not None:
                out.append((f"w{wid}", p.simplify(0.1, preserve_topology=True), tg))
    for rid, tg, mem in osm.rels:
        if tg.get("type") == "multipolygon" and tg.get("building:part", "no") not in ("no", "roof"):
            p = osm.rel_polygon(mem)
            if p is not None:
                out.append((f"r{rid}", p, tg))
    return out


def classify(osm, osm_path, inside, log=print):
    """-> (specs, report). inside(x, y) — точка в мире."""
    from .ortho_buildings import iter_buildings
    reg = _load_json(DATA_PROCESSED / "building_registry.json")
    fac = _load_json(DATA_PROCESSED / "building_facades.json")
    orto_path = DATA_PROCESSED / "building_ortho.json"
    ortho = _load_json(orto_path)
    log(f"здания: реестр {len({k[1:] for k in reg})}, фасады {len(fac)}, ортофото {len(ortho)}")

    B = []
    for key, p, tg in iter_buildings(osm):
        if tg.get("building") in SKIP or "nfr:hero" in tg:   # hero-модели (world/landmarks.py) строит игра
            continue
        rp = p.representative_point()
        if not inside(rp.x, rp.y):
            continue
        p = p.simplify(0.2, preserve_topology=True)
        if p.is_empty or p.area < 4:
            continue
        B.append((key, p, tg))
    ctx = Context(osm, osm_path, B)

    # части зданий: к какому зданию относятся
    parts = _parts(osm)
    ptree = STRtree([p for _, p, _ in parts]) if parts else None

    rows = []
    for i, (key, p, tg) in enumerate(B):
        main = max(_polys(p), key=lambda g: g.area)
        fr = rect_frame(main)
        o = ortho.get(key, {})
        cc = coarse_class(tg, p, ctx, i, fr, o)
        sh = o.get("sh_prof")
        rows.append(dict(i=i, key=key, poly=p, main=main, tg=tg, fr=fr, cc=cc, sh=sh, o=o, reg=reg.get(key), fac=fac.get(key)))

    # явные этажи
    def explicit(r):
        tg, rg, fc = r["tg"], r["reg"], r["fac"]
        h = _num(tg.get("height")) or _num(tg.get("building:height"))
        lv = _num(tg.get("building:levels"))
        # приоритет: явная высота OSM -> реестр ЖКХ -> building:levels OSM -> панорамы
        if h and 2 <= h <= 300 and lv is None:
            return max(1, int(round((h - 1.5) / 3.0))), "osm_height"
        if rg and _num(rg.get("levels")) and 1 <= _num(rg.get("levels")) <= 40:
            return int(round(_num(rg.get("levels")))), "registry"
        if lv is not None and lv >= 1:
            return int(round(lv)), "osm_levels"
        if fc and fc.get("levels_est") and (fc.get("confidence") or 0) >= 0.4:
            return int(round(float(fc["levels_est"]))), "panorama"
        return None, None

    feats, shs, ys = [], [], []
    for r in rows:
        lv, src = explicit(r)
        r["lv"], r["src"] = lv, src
        f, s = _features(r["main"], r["fr"], r["cc"], r["sh"])
        r["f"], r["s"] = f, s
        if lv is not None and src in ("osm_levels", "osm_height", "registry") and r["cc"] not in ("garage", "shed", "church"):
            feats.append(f); shs.append(s); ys.append(min(lv, 30))
    model = LevelModel(feats, shs, ys)
    loo = model.loo()
    log(f"модель этажности: {loo}")

    specs = []
    src_count = Counter()
    arch_count = Counter()
    for r in rows:
        key, p, tg, fr, cc = r["key"], r["poly"], r["tg"], r["fr"], r["cc"]
        sd = seed_of(key)
        rp = p.representative_point()
        center = ctx.center.contains(rp)
        core = ctx.core.contains(rp)
        lv, src = r["lv"], r["src"]
        if lv is None:
            if cc in ("garage", "shed"):
                lv, src = 1, "archetype"
            elif cc == "church":
                lv, src = 2, "archetype"
            else:
                v, src = model.predict(r["f"], r["s"])
                lv = int(round(v)) if v is not None else 2
                lv = _clamp_levels(cc, lv, r["main"], center)
        arch = fine_arch(cc, lv, tg, r["main"], fr, ctx, r["reg"], r["fac"], sd, center, core)
        if src == "archetype" and arch in ("panel5", "brick5") and lv in (4, 6):
            lv = 5   # типовые хрущёвки — 5 этажей
        if src in ("archetype", "shadow") and arch == "panel9" and lv in (8, 11):
            lv = 9
        src_count[src] += 1
        arch_count[arch] += 1
        shop = (cc in ("apart", "public") and lv >= 3 and ctx.poi_in(r["main"]) > 0) or (center and arch in ("stalinka", "merchant") and ctx.poi_in(r["main"]) > 0)
        # части
        my_parts = []
        if ptree is not None:
            for j in ptree.query(p):
                pk, pp, ptg = parts[j]
                inter = pp.intersection(p).area if pp.intersects(p) else 0
                if inter > 0.6 * pp.area:
                    my_parts.append(parts[j])
        cover = sum(pp.area for _, pp, _ in my_parts) / max(p.area, 1)
        if my_parts and cover > 0.5:
            for pk, pp, ptg in my_parts:
                for g in _polys(pp):
                    if g.area < 2:
                        continue
                    s = _spec_from(pk, g, {**{k: v for k, v in tg.items() if k not in ("building:levels", "height", "roof:shape")}, **ptg},
                                   arch, lv, src, r, sd ^ seed_of(pk), center, core, shop=False, part=True)
                    s.tile_pt = (rp.x, rp.y)
                    specs.append(s)
            # остаток контура, не покрытый частями — как основное здание
            rest = p.difference(MultiPolygon([g for _, pp, _ in my_parts for g in _polys(pp)]).buffer(0.05))
            for g in _polys(rest):
                if g.area > 15 and g.buffer(-1.0).area > 3:
                    s = _spec_from(key, g, tg, arch, lv, src, r, sd, center, core, shop)
                    s.tile_pt = (rp.x, rp.y)
                    specs.append(s)
            continue
        for g in _polys(p):
            if g.area < 4:
                continue
            s = _spec_from(key, g, tg, arch, lv, src, r, sd, center, core, shop)
            s.tile_pt = (rp.x, rp.y)
            specs.append(s)

    n = len(rows)
    report = {
        "buildings": n, "volumes": len(specs),
        "levels_sources": {k: src_count.get(k, 0) for k in LEVEL_SOURCES},
        "levels_sources_pct": {k: round(100 * src_count.get(k, 0) / max(n, 1), 1) for k in LEVEL_SOURCES},
        "archetypes": dict(arch_count.most_common()),
        "level_model": loo,
        "inputs": {"registry": len({k[1:] for k in reg}), "facades": len(fac), "ortho": len(ortho),
                   "registry_matched_buildings": sum(1 for r in rows if r["reg"]),
                   "facades_matched_buildings": sum(1 for r in rows if r["fac"])},
        "colors": dict(Counter(s.color_src for s in specs if not s.part)),
        "roofs": dict(Counter(s.roof for s in specs)),
    }
    return specs, report


def _clamp_levels(cc, lv, poly, center):
    a = poly.area
    if cc == "house":
        return int(np.clip(lv, 1, 3 if a > 150 else 2))
    if cc == "apart":
        lv = int(np.clip(lv, 2, 25))
        if a < 150:
            lv = min(lv, 3)
        return lv
    if cc in ("commercial", "industrial"):
        return int(np.clip(lv, 1, 5))
    if cc in ("public", "school"):
        return int(np.clip(lv, 1, 9))
    return int(np.clip(lv, 1, 20))


def _spec_from(key, poly, tg, arch, levels, src, r, sd, center, core, shop, part=False):
    fh, plinth, step, parapet = STYLE[arch]
    s = BuildingSpec(key=key, poly=poly, tags=tg, arch=arch, levels=levels, levels_src=src, fh=fh, plinth=plinth,
                     seed=sd, shopfront=shop, part=part)
    rg, fc, o = r["reg"] or {}, r["fac"] or {}, r["o"] or {}
    s.year = _year(tg) or int(_num(rg.get("year")) or 0)
    s.series = str(rg.get("series") or "")
    rng = np.random.default_rng(sd)
    # части: этажи/высоты из тегов части
    if part:
        lv = _num(tg.get("building:levels"))
        h = _num(tg.get("height"))
        mlv = _num(tg.get("building:min_level"))
        mh = _num(tg.get("min_height"))
        rl = _num(tg.get("roof:levels"))
        if lv is not None:
            s.levels = max(int(round(lv)), 0)
        elif h is None:
            s.levels = levels
        if mh is not None:
            s.min_h = mh
        elif mlv is not None:
            s.min_h = s.plinth + mlv * fh
    # высоты
    h_tag = _num(tg.get("height")) or _num(tg.get("building:height"))
    roof_h_tag = _num(tg.get("roof:height"))
    roof_lv = _num(tg.get("roof:levels"))
    s.wall_h = s.plinth + s.levels * fh
    # крыша
    shape = (tg.get("roof:shape") or "").lower()
    if not shape and rg.get("roof_type"):
        rt = str(rg["roof_type"]).lower()
        shape = ("flat" if ("плоск" in rt or "flat" in rt) else "gabled" if "двускат" in rt else "hipped" if "вальм" in rt
                 else ("pitched" if ("скат" in rt or "pitched" in rt) else ""))
    rm = str(rg.get("roof_material") or "").lower()
    if not shape and rm:
        if any(k in rm for k in ("рулон", "мягк", "мастич", "наливн")):
            shape = "flat"
        elif any(k in rm for k in ("шифер", "металл", "желез", "волнист", "фальц", "профлист", "стальн", "черепиц")):
            shape = "pitched"
    _, u, L, W, rect = r["fr"] if not part else rect_frame(poly)
    if shape == "pitched":   # реестр знает только «скатная»: форму выбирает архетип (с подсказкой «скатная» для ортофото)
        g = _roof_guess(arch, s, {**o, "c_long": 1.0, "rect": max(o.get("rect", 1.0), 0.7)}, rect, min(W, 26), L, rng, part)
        shape = g if g != "flat" else ("gabled" if rect >= 0.88 and W < 16 else "hipped")
    if not shape:
        shape = _roof_guess(arch, s, o, rect, W, L, rng, part)
    shape = {"gable": "gabled", "hip": "hipped", "half-hipped": "hipped", "gambrel": "mansard", "round": "gabled",
             "saltbox": "gabled", "quadruple_saltbox": "hipped", "cone": "pyramidal", "skillion": "skillion"}.get(shape, shape)
    if shape not in ("flat", "gabled", "hipped", "pyramidal", "dome", "onion", "mansard", "skillion"):
        shape = "flat"
    s.roof = shape
    if shape in ("gabled", "hipped", "pyramidal", "mansard", "skillion"):
        s.pitch = {"house": 35, "merchant": 27, "stalinka": 22, "church": 30, "shed": 25, "garage": 8, "industrial": 10,
                   "school": 18, "public": 20}.get(arch, 20) + float(rng.uniform(-3, 3))
        if shape == "skillion":
            s.pitch = min(s.pitch, 12)
        half = min(W, 24) / 2
        s.roof_h = half * math.tan(math.radians(s.pitch))
        cap = {"stalinka": 4.0, "merchant": 4.0, "public": 3.5, "school": 3.0, "industrial": 3.0, "garage": 0.8}.get(arch, 6.0)
        if roof_lv:
            cap = max(cap, roof_lv * 2.8)
        s.roof_h = min(s.roof_h, cap)
        if roof_h_tag:
            s.roof_h = roof_h_tag
    elif shape in ("dome", "onion"):
        rad = math.sqrt(poly.area / math.pi)
        s.roof_h = roof_h_tag or (roof_lv * fh if roof_lv else rad * (2.0 if shape == "onion" else 1.0))
    else:
        s.parapet = parapet if not part else 0.3
    # высота из тегов (height включает крышу)
    if h_tag:
        top = h_tag - (s.roof_h if shape not in ("flat",) else 0)
        s.wall_h = max(top, s.min_h + 1.0)
        if not part or _num(tg.get("building:levels")) is None:
            s.levels = max(1, int(round((s.wall_h - s.min_h - s.plinth) / fh)))
    elif part and s.levels == 0:
        s.wall_h = s.min_h + 0.5
    elif part:
        s.wall_h = s.plinth + s.levels * fh
        if s.min_h >= s.wall_h:
            s.wall_h = s.min_h + fh
    s.cornice = arch in ("stalinka", "merchant", "school", "public") and shape != "flat" or arch in ("stalinka", "merchant")
    # секции (подъезды) — для коробок лифтов и балконов
    ent = _num(rg.get("entrances"))
    sec_len = {"panel5": 16.0, "brick5": 16.0, "panel9": 24.0, "tower": 30.0, "modern": 22.0, "stalinka": 22.0}.get(arch, 20.0)
    s.sections = int(ent) if ent else max(1, int(round(L / sec_len)))
    # цвет фасада
    col = parse_colour(tg.get("building:colour"))
    if col:
        s.color, s.color_src = col, "osm"
    elif _facade_ok(fc) and not part:
        # цвет с панорам — сырые пиксели (L≈45–55): светлее ×1.3 по L*, при средней уверенности — к палитре архетипа
        conf = float(fc.get("confidence") or 0)
        lab = rgb2lab(np.array(hex2rgb(fc["color"])))
        lab[0] = min(lab[0] * 1.3, 92.0)
        c = lab2rgb(lab)
        if conf < 0.7:
            pal = PALETTE[arch]
            c = c * 0.7 + np.array(hex2rgb(pal[sd % len(pal)])) * 0.3
        s.color, s.color_src = tuple(float(x) for x in np.clip(c, 0, 1)), "panorama"
    else:
        pal = PALETTE[arch]
        wm = str(rg.get("wall_material") or "").lower()
        if "дерев" in wm:
            pal = PALETTE_WOOD
        elif "кирп" in wm and arch in ("brick5", "tower", "panel9", "stalinka", "house", "school", "public"):
            pal = PALETTE_BRICK if arch != "stalinka" else pal
        c = np.array(hex2rgb(pal[sd % len(pal)]))
        c = np.clip(c * rng.uniform(0.93, 1.06) + rng.normal(0, 0.015, 3), 0, 1)
        s.color, s.color_src = tuple(float(x) for x in c), "palette"
    # цвет крыши
    rc = parse_colour(tg.get("roof:colour"))
    if rc:
        s.roof_color = rc
    elif "шифер" in rm and shape != "flat":
        s.roof_color = hex2rgb(["#8d8d88", "#7f807c", "#9a9a94"][sd % 3])
    elif "оцинк" in rm and shape != "flat":
        s.roof_color = hex2rgb("#a4a7aa")
    elif o.get("roof_rgb") and shape not in ("dome", "onion"):
        # ортофото: медиана по крыше -> привязка к правдоподобной палитре кровель (один чистый цвет на крышу)
        c = np.array(o["roof_rgb"], float) / 255 * 0.9
        s.roof_color = snap_roof(c, flat=(shape == "flat"))
    else:
        pal = ROOF_PALETTE["flat" if shape == "flat" else "pitched"]
        if shape in ("dome", "onion"):
            pal = ["#d4a63a", "#3f6fa8", "#3f7a52", "#d4a63a", "#2f3a5a"]
        s.roof_color = hex2rgb(pal[(sd >> 4) % len(pal)])
    return s


# кровли: крашеный металл (зелёный, красно-коричневый, синий), оцинковка, шифер, битум
ROOF_SNAP_PITCHED = ["#4e6b4f", "#355440", "#7a4034", "#8f4a36", "#6b4a3a", "#4b6683", "#80848a", "#a4a7aa", "#8d8d88",
                     "#5d6064"]
ROOF_SNAP_FLAT = ["#4a4948", "#5a5856", "#6a6865", "#7c7a76", "#8e8b86"]


def snap_roof(c, flat=False):
    """Цвет крыши с ортофото -> ближайший из палитры (сравнение по цветности и яркости раздельно)."""
    pal = np.array([hex2rgb(h) for h in (ROOF_SNAP_FLAT if flat else ROOF_SNAP_PITCHED)])
    lum = lambda x: x @ np.array([0.3, 0.59, 0.11])
    lc, lp = lum(c), lum(pal)
    chroma = lambda x, l: x / max(l, 1e-3) if np.ndim(x) == 1 else x / np.maximum(l, 1e-3)[:, None]
    d = np.linalg.norm(chroma(pal, lp) - chroma(c, lc), axis=1) * 0.6 + np.abs(lp - lc) * 1.5
    return tuple(float(x) for x in pal[int(np.argmin(d))])


def _facade_ok(fc):
    """Правила агента фасадов (docs/stage1/facades.md): уверенность ≥ 0.5; dark_grey — чаще ошибка, нужна ≥ 0.6."""
    if not fc or not fc.get("color"):
        return False
    conf = float(fc.get("confidence") or 0)
    return conf >= (0.6 if fc.get("material") == "dark_grey" else 0.5)


def _srgb_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _lin_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


_M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
_WP = np.array([0.95047, 1.0, 1.08883])


def rgb2lab(c):
    xyz = _M @ _srgb_lin(np.asarray(c, float)) / _WP
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.array([116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])])


def lab2rgb(lab):
    fy = (lab[0] + 16) / 116
    f = np.array([fy + lab[1] / 500, fy, fy - lab[2] / 200])
    xyz = np.where(f ** 3 > 0.008856, f ** 3, (f - 16 / 116) / 7.787) * _WP
    return _lin_srgb(np.linalg.solve(_M, xyz))


def _roof_guess(arch, s, o, rect, W, L, rng, part):
    pitched_p = None
    if o.get("c_long") is not None and o.get("rect", 0) >= 0.7 and W <= 26:
        cl, cs = o["c_long"], o.get("c_short", 0)
        if cl >= 0.5 or cs >= 0.7:
            pitched_p = True
        elif cl < 0.22 and cs < 0.3:
            pitched_p = False
    big = s.poly.area > 3000 or W > 30
    if arch in ("panel9", "tower", "modern", "commercial") and s.levels >= 6:
        return "flat"
    if arch in ("panel5",):
        return "hipped" if pitched_p else "flat"
    if arch in ("brick5",):
        return ("hipped" if rng.random() < 0.6 else "gabled") if pitched_p else "flat"
    if arch == "house":
        if pitched_p is False and s.poly.area > 120:
            return "flat"
        if rect >= 0.88:   # по панорамам: у рязанских одноэтажных домов часто вальмовая (четырёхскатная) кровля
            return "gabled" if rng.random() < 0.45 else "hipped"
        return "hipped"
    if arch == "merchant":
        if pitched_p is False:
            return "flat"
        return "hipped" if (rect < 0.9 or rng.random() < 0.6) else "gabled"
    if arch == "stalinka":
        if pitched_p is False or big:
            return "flat"
        return "hipped"
    if arch == "church":
        return "gabled" if rect >= 0.85 else "hipped"
    if arch in ("garage", "industrial", "commercial", "school", "public", "other"):
        if pitched_p and not big:
            return "gabled" if rect >= 0.88 else "hipped"
        return "flat"
    if arch == "shed":
        return "gabled" if rect >= 0.85 and rng.random() < 0.6 else ("skillion" if rect >= 0.85 else "flat")
    return "flat"
