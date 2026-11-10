"""Контекст из OSM и рельефа на сетке 1 м: битовые слои (слабые метки и маски) + дистанции/рельеф (признаки)."""
import json

import numpy as np
import shapely
from rasterio import features
from scipy.ndimage import distance_transform_edt, gaussian_filter, uniform_filter, zoom

from config import DATA_RAW, ROOT
from .classes import OUT, Grid1m

BITS = ["bld", "road", "rail", "water", "parking", "wood", "conif", "park", "scrub", "grassland", "lawnpoly", "allot",
        "constr", "beach", "indus", "resid", "house", "apt", "track", "cemetery", "wetland", "pitch", "garages", "hard"]
B = {n: 1 << i for i, n in enumerate(BITS)}

# ширина проезжей части по классу (м) — для меток «асфальт» берём осевую полосу (без кромок)
ROAD_W = {"motorway": 16, "trunk": 14, "primary": 14, "secondary": 11, "tertiary": 9, "unclassified": 6, "residential": 6,
          "living_street": 5, "service": 4, "primary_link": 7, "secondary_link": 7, "tertiary_link": 6}
UNPAVED = {"ground", "dirt", "unpaved", "grass", "sand", "mud", "earth", "compacted", "gravel", "fine_gravel"}


def _polys(osm):
    """[(polygon, tags)] — площадные пути и мультиполигоны."""
    out = []
    for wid, (refs, tg) in osm.ways.items():
        if not tg or len(refs) < 4 or refs[0] != refs[-1]:
            continue
        if tg.get("highway") and tg.get("area") != "yes":
            continue
        p = osm.way_polygon(wid)
        if p is not None:
            out.append((p, tg))
    for rid, tg, mem in osm.rels:
        if tg.get("type") == "multipolygon":
            p = osm.rel_polygon(mem)
            if p is not None:
                out.append((p, tg))
    return out


def build(log=print):
    """Строит и кэширует data/processed/landcover/context.npz."""
    from world.osm import OsmData
    g = Grid1m()
    osm = OsmData(DATA_RAW / "osm" / "ryazan.osm")
    M = np.zeros((g.rows, g.cols), np.uint32)
    lay = {k: [] for k in BITS}

    for p, tg in _polys(osm):
        lu, na, le, am = tg.get("landuse"), tg.get("natural"), tg.get("leisure"), tg.get("amenity")
        if tg.get("building", "no") != "no":
            continue
        if na == "wood" or lu == "forest":
            (lay["conif"] if tg.get("leaf_type") == "needleleaved" else lay["wood"]).append(p)
        if le in ("park", "garden"):
            lay["park"].append(p)
        if na in ("scrub", "heath"):
            lay["scrub"].append(p)
        if na == "grassland" or lu in ("meadow", "farmland"):
            lay["grassland"].append(p)
        if lu in ("grass", "village_green", "recreation_ground") or le == "common":
            lay["lawnpoly"].append(p)
        if le == "pitch":
            lay["pitch"].append(p)
            if tg.get("surface") in ("asphalt", "concrete", "paving_stones", "paved", "tartan", "rubber"):
                lay["hard"].append(p)
        if lu in ("allotments", "orchard") or tg.get("place") == "allotments":
            lay["allot"].append(p)
        if lu in ("construction", "brownfield", "landfill", "quarry", "greenfield"):
            lay["constr"].append(p)
        if na in ("beach", "sand") or tg.get("surface") == "sand":
            lay["beach"].append(p)
        if lu in ("industrial", "railway", "commercial", "retail") or tg.get("man_made") == "works":
            lay["indus"].append(p)
        if lu == "garages":
            lay["garages"].append(p)
        if lu == "residential":
            lay["resid"].append(p)
        if lu == "cemetery" or am == "grave_yard":
            lay["cemetery"].append(p)
        if na == "wetland":
            lay["wetland"].append(p)
        if am == "parking" and tg.get("parking") not in ("underground", "multi-storey", "rooftop"):
            lay["parking"].append(p)
        if tg.get("highway") in ("pedestrian", "footway") or tg.get("place") == "square":
            lay["hard"].append(p)
    for p, tg in osm.water():
        lay["water"].append(p)
    for p, tg, _ in osm.buildings():
        lay["bld"].append(p)
        b = tg.get("building")
        if b in ("house", "detached", "semidetached_house", "bungalow", "cabin", "farm", "hut", "shed"):
            lay["house"].append(p)
        elif b in ("apartments", "dormitory", "residential"):
            lay["apt"].append(p)
    for wid, (refs, tg) in osm.ways.items():
        hw, rw = tg.get("highway"), tg.get("railway")
        if hw is None and rw is None:
            continue
        if tg.get("tunnel") not in (None, "no") or tg.get("bridge") not in (None, "no") or tg.get("area") == "yes":
            continue
        xy = osm.way_xy(wid)
        if len(xy) < 2:
            continue
        ln = shapely.LineString(xy)
        if rw in ("rail", "light_rail", "tram", "narrow_gauge") and tg.get("service") not in ("spur",):
            lay["rail"].append(ln.buffer(1.4, cap_style="flat"))
        elif hw in ROAD_W:
            if hw == "service" and tg.get("service") in ("parking_aisle", "drive-through"):
                continue
            if tg.get("surface") in UNPAVED:
                lay["track"].append(ln.buffer(1.2, cap_style="flat"))
                continue
            lay["road"].append(ln.buffer(ROAD_W[hw] / 2, cap_style="flat"))
        elif hw in ("track", "path", "footway", "bridleway") and tg.get("surface") in UNPAVED | {None} and hw != "footway" \
                or (hw == "footway" and tg.get("surface") in UNPAVED):
            lay["track"].append(ln.buffer(0.9 if hw != "track" else 1.4, cap_style="flat"))
    tr = g.transform
    for k in BITS:
        geoms = [x for x in lay[k] if x is not None and not x.is_empty]
        if not geoms:
            continue
        a = features.rasterize(((x, 1) for x in geoms), out_shape=(g.rows, g.cols), transform=tr, dtype="uint8")
        M[a.astype(bool)] |= np.uint32(B[k])
        log(f"  слой {k}: {len(geoms)} фигур, {a.sum() / 1e6:.2f} км²")

    # дистанции (м, ограничены) и плотность частных домов
    def dist(mask, cap):
        return np.minimum(distance_transform_edt(~mask), cap).astype(np.float16)
    D = {
        "d_bld": dist((M & B["bld"]) != 0, 200),
        "d_road": dist((M & B["road"]) != 0, 200),
        "d_rail": dist((M & B["rail"]) != 0, 300),
        "d_apt": dist((M & B["apt"]) != 0, 300),
        "d_water": dist((M & B["water"]) != 0, 300),
        "house_frac": uniform_filter(((M & B["house"]) != 0).astype(np.float32), 61).astype(np.float16),
        "bld_frac": uniform_filter(((M & B["bld"]) != 0).astype(np.float32), 61).astype(np.float16),
    }
    # рельеф: heightmap мира (5 м) → 1 м
    man = json.loads((ROOT / "game/public/world/manifest.json").read_text())
    t = man["terrain"]
    hm = np.fromfile(ROOT / "game/public/world" / t["file"], np.float32).reshape(t["rows"], t["cols"])
    # строка heightmap 0 = min three.z = max y (как наша сетка), шаг 5 м; узлы в minX + c*5
    h1 = zoom(hm.astype(np.float32), 5.0, order=1)[: g.rows, : g.cols]
    pad = ((0, g.rows - h1.shape[0]), (0, g.cols - h1.shape[1]))
    h1 = np.pad(h1, pad, mode="edge")
    gy, gx = np.gradient(gaussian_filter(h1, 2.0))
    D["slope"] = np.hypot(gx, gy).astype(np.float16)
    D["relief"] = (h1 - gaussian_filter(h1, 40.0)).astype(np.float16)
    D["height"] = h1.astype(np.float16)
    OUT.mkdir(parents=True, exist_ok=True)
    np.savez(OUT / "context.npz", M=M, **D)
    log(f"контекст: {g.rows}x{g.cols}")
    return load()


def load():
    z = np.load(OUT / "context.npz")
    return {k: z[k] for k in z.files}
