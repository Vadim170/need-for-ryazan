"""Audio zone map for city ambience (run with the pipeline venv: ../../../pipeline/.venv/bin/python build_audio_zones.py).

Rasterises OSM (data/raw/ryazan.osm) into a coarse grid (25 m) of ambience "affinities" 0..255 that the game samples
at the listener position (src/audio/city-zones.ts):
  0 traffic    — road loudness by class (primary 1 … service 0.1), blurred ~70 m  (distant traffic bed)
  1 green      — parks / forest / wood / grass / cemetery                    (birds, crows, wind in trees)
  2 industrial — landuse industrial / construction / railway / works        (industrial hum, construction)
  3 crowd      — pedestrian streets, shops/cafes, bus stops, markets         (crowd murmur, footsteps)
  4 yards      — residential landuse away from big roads                     (dogs, car alarms, quiet)
  5 playground — leisure=playground                                           (kids by day)
  6 water      — river / lakes                                                (quieter, open)
Plus point lists: churches (bells), bus stops (air brakes).
Output: game/public/assets/audio/zones/zones.bin (uint8, row-major [row][col][ch]) + zones.json.
"""
import json, pathlib, sys
import numpy as np
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))
from config import to_world, DATA_RAW, BBOX  # noqa: E402
from world.osm import OsmData  # noqa: E402
from shapely.geometry import Point  # noqa: E402
from scipy.ndimage import gaussian_filter  # noqa: E402

OUT = ROOT / "game" / "public" / "assets" / "audio" / "zones"
CELL = 25.0
CH = ["traffic", "green", "industrial", "crowd", "yards", "playground", "water"]
ROAD_W = {"primary": 1.0, "primary_link": 0.8, "trunk": 1.0, "secondary": 0.8, "secondary_link": 0.6, "tertiary": 0.55,
          "tertiary_link": 0.45, "unclassified": 0.3, "residential": 0.25, "living_street": 0.1, "service": 0.08}


def main():
    import time; T0 = time.time()
    lg = lambda m: print(f"[{time.time()-T0:6.1f}s] {m}", flush=True)
    osm_path = DATA_RAW / "osm" / "ryazan.osm"
    osm = OsmData(osm_path)
    lg(f"osm parsed: {len(osm.ways)} ways")
    # POI nodes (OsmData keeps only highway nodes' tags)
    pois = []
    for _, el in ET.iterparse(osm_path):
        if el.tag == "node":
            if len(el):
                tg = {c.get("k"): c.get("v") for c in el.iter("tag")}
                if any(k in tg for k in ("amenity", "shop", "leisure", "highway", "public_transport", "building", "historic")):
                    x, y = to_world.transform(float(el.get("lon")), float(el.get("lat")))
                    pois.append((x, y, tg))
            el.clear()
        elif el.tag in ("way", "relation"):
            el.clear()
    lg(f"pois: {len(pois)}")
    # world bbox (config.BBOX = south, west, north, east) + margin
    bx, by = to_world.transform([BBOX[1], BBOX[3], BBOX[1], BBOX[3]], [BBOX[0], BBOX[0], BBOX[2], BBOX[2]])
    x0, x1 = min(bx) - 500, max(bx) + 500
    y0, y1 = min(by) - 500, max(by) + 500
    W, H = int((x1 - x0) / CELL) + 1, int((y1 - y0) / CELL) + 1
    G = np.zeros((len(CH), H, W), np.float32)

    def cell(x, y):
        return int((y - y0) / CELL), int((x - x0) / CELL)

    def stamp_line(ch, pts, w):
        for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
            n = max(1, int(np.hypot(bx - ax, by - ay) / (CELL * 0.5)))
            for t in np.linspace(0, 1, n + 1):
                r, c = cell(ax + (bx - ax) * t, ay + (by - ay) * t)
                if 0 <= r < H and 0 <= c < W: G[ch, r, c] = max(G[ch, r, c], w)

    from matplotlib.path import Path as MPath

    def stamp_poly(ch, poly, w):
        if poly is None or poly.is_empty: return
        geoms = getattr(poly, "geoms", [poly])
        for g in geoms:
            if g.geom_type != "Polygon": continue
            bx0, by0, bx1, by1 = g.bounds
            r0, c0 = cell(bx0, by0); r1, c1 = cell(bx1, by1)
            r0, c0 = max(0, r0), max(0, c0); r1, c1 = min(H - 1, r1), min(W - 1, c1)
            if r1 < r0 or c1 < c0: continue
            cc, rr = np.meshgrid(np.arange(c0, c1 + 1), np.arange(r0, r1 + 1))
            pts = np.c_[x0 + (cc.ravel() + 0.5) * CELL, y0 + (rr.ravel() + 0.5) * CELL]
            inside = MPath(np.asarray(g.exterior.coords)).contains_points(pts)
            for hole in g.interiors:
                inside &= ~MPath(np.asarray(hole.coords)).contains_points(pts)
            if not inside.any():
                # tiny polygon: stamp its centroid
                r, c = cell(g.centroid.x, g.centroid.y)
                if 0 <= r < H and 0 <= c < W: G[ch, r, c] = max(G[ch, r, c], w)
                continue
            sub = G[ch, r0:r1 + 1, c0:c1 + 1]
            m = inside.reshape(sub.shape)
            sub[m] = np.maximum(sub[m], w)

    def stamp_point(ch, x, y, w):
        r, c = cell(x, y)
        if 0 <= r < H and 0 <= c < W: G[ch, r, c] = max(G[ch, r, c], w)

    lg(f"grid {W}x{H}")
    churches, stops = [], []
    for wid, (refs, tg) in osm.ways.items():
        hw = tg.get("highway")
        closed = len(refs) > 3 and refs[0] == refs[-1]
        if hw in ROAD_W:
            stamp_line(0, osm.way_xy(wid), ROAD_W[hw])
        if hw in ("pedestrian",) or tg.get("place") == "square":
            (stamp_poly(3, osm.way_polygon(wid), 1.0) if closed else stamp_line(3, osm.way_xy(wid), 1.0))
        if hw == "footway" and tg.get("footway") not in ("sidewalk", "crossing"):
            stamp_line(3, osm.way_xy(wid), 0.25)
        if tg.get("railway") in ("rail", "tram"):
            stamp_line(2, osm.way_xy(wid), 0.25)
        if tg.get("waterway") in ("river", "canal"):
            stamp_line(6, osm.way_xy(wid), 1.0)
        if not closed: continue
        lu, le, nat = tg.get("landuse"), tg.get("leisure"), tg.get("natural")
        if lu in ("forest", "grass", "meadow", "cemetery", "recreation_ground", "village_green", "orchard") or le in ("park", "garden") or nat in ("wood", "scrub", "grassland"):
            stamp_poly(1, osm.way_polygon(wid), 0.6 if lu == "grass" else 1.0)
        if lu in ("industrial", "construction", "railway", "garages") or tg.get("man_made") == "works":
            stamp_poly(2, osm.way_polygon(wid), 1.0 if lu in ("industrial", "construction") else 0.5)
        if lu in ("retail", "commercial") or tg.get("amenity") == "marketplace":
            stamp_poly(3, osm.way_polygon(wid), 0.6)
        if lu == "residential":
            stamp_poly(4, osm.way_polygon(wid), 1.0)
        if le == "playground":
            stamp_poly(5, osm.way_polygon(wid), 1.0)
        if nat == "water" or tg.get("water"):
            stamp_poly(6, osm.way_polygon(wid), 1.0)
        if tg.get("amenity") == "place_of_worship" and tg.get("religion", "christian") == "christian":
            p = osm.way_polygon(wid)
            if p is not None: churches.append((p.centroid.x, p.centroid.y, tg.get("name", "")))
    lg("ways stamped")
    for rid, tg, mem in osm.rels:
        if tg.get("type") != "multipolygon": continue
        lu, le, nat = tg.get("landuse"), tg.get("leisure"), tg.get("natural")
        if lu in ("forest", "cemetery", "recreation_ground") or le == "park" or nat in ("wood",):
            stamp_poly(1, osm.rel_polygon(mem), 1.0)
        elif lu in ("industrial", "construction"):
            stamp_poly(2, osm.rel_polygon(mem), 1.0)
        elif nat == "water":
            stamp_poly(6, osm.rel_polygon(mem), 1.0)
    lg("rels stamped")
    # world props (game coords: three.z = -y): playground sets, bus stops, container sites (yards), park benches/lamps
    prop_w = {"playground_set": (5, 1.0), "bus_stop": (3, 0.7), "container_site": (4, 0.8), "park_lamp": (1, 0.5),
              "cafe_terrace": (3, 0.8), "kiosk": (3, 0.5)}
    for f in sorted((ROOT / "game" / "public" / "world" / "props").glob("*.json")):
        for it in json.loads(f.read_text()).get("instances", []):
            pw = prop_w.get(it.get("type"))
            if pw: stamp_point(pw[0], it["x"], -it["z"], pw[1])
    lg("props stamped")
    for x, y, tg in pois:
        if tg.get("shop") or tg.get("amenity") in ("cafe", "restaurant", "fast_food", "bar", "pub", "theatre", "cinema", "bank", "pharmacy"):
            stamp_point(3, x, y, 0.5)
        if tg.get("highway") == "bus_stop" or tg.get("public_transport") == "platform":
            stamp_point(3, x, y, 0.7)
            stops.append((x, y))
        if tg.get("leisure") == "playground":
            stamp_point(5, x, y, 1.0)
        if tg.get("amenity") == "place_of_worship" and tg.get("religion", "christian") == "christian":
            churches.append((x, y, tg.get("name", "")))
    # blur (sound spreads) — per-channel radius in metres
    sig = {"traffic": 70, "green": 40, "industrial": 90, "crowd": 45, "yards": 30, "playground": 45, "water": 60}
    for i, n in enumerate(CH):
        g = gaussian_filter(G[i], sig[n] / CELL)
        # keep the inside of areas at full value, soft edge outside
        boost = {"playground": 12.0, "crowd": 3.0, "traffic": 2.2}.get(n, 1.6)  # point-like sources need more gain after the blur
        g = np.maximum(G[i] * 0.85, g * boost)
        G[i] = np.clip(g, 0, 1)
    # yards: residential minus loud roads
    G[4] *= np.clip(1 - G[0] * 0.9, 0, 1)
    OUT.mkdir(parents=True, exist_ok=True)
    data = (np.transpose(G, (1, 2, 0)) * 255).round().astype(np.uint8)  # [row][col][ch], row = +north
    (OUT / "zones.bin").write_bytes(data.tobytes())
    # game coordinates: three.x = x, three.z = -y
    ch_list = sorted({(round(x), round(y), n) for x, y, n in churches})
    meta = dict(cell=CELL, cols=W, rows=H, channels=CH, x0=x0, y0=y0,
                note="row r covers pipeline y in [y0+r*cell, y0+(r+1)*cell); three.z = -y",
                churches=[dict(x=x, z=-y, name=n) for x, y, n in ch_list],
                busStops=[dict(x=round(x), z=-round(y)) for x, y in stops])
    (OUT / "zones.json").write_text(json.dumps(meta, ensure_ascii=False))
    print(f"grid {W}x{H} @ {CELL} m, {len(ch_list)} churches, {len(stops)} stops, {data.nbytes/1e6:.2f} MB")
    for i, n in enumerate(CH): print(f"  {n:11} cover>0.3: {(G[i] > 0.3).mean()*100:5.1f}%")
    # preview
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    fig, axes = plt.subplots(2, 4, figsize=(24, 12))
    for i, n in enumerate(CH):
        ax = axes.flat[i]; ax.imshow(G[i], origin="lower", cmap="magma"); ax.set_title(n)
    ax = axes.flat[7]; ax.imshow(G[0] * 0 + G[3], origin="lower", cmap="gray")
    for x, y, n in ch_list: ax.plot((x - x0) / CELL, (y - y0) / CELL, "r+")
    ax.set_title("crowd + churches")
    plt.tight_layout(); plt.savefig(ROOT / "assets" / "audio" / "analysis" / "zones_preview.png", dpi=45)


if __name__ == "__main__":
    main()
