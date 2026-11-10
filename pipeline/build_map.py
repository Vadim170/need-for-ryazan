"""Карта мира для игры (клавиша M): растровая пирамида тайлов в координатах игры.

Вход:  game/public/world/{manifest.json, roads/graph.json, rail/net.json}, data/raw/osm/ryazan.osm (здания, вода, парки),
       data/processed/ortho/yandex_{2m,0.5m}.tif (спутник).
Выход: game/public/world-map/{meta.json, scheme/{z}/{x}_{y}.webp, sat/{z}/{x}_{y}.webp}
       (вне public/world/, чтобы пересборка мира не стирала; формат — docs/world-format.md, раздел «Карта мира»).

Сетка: пиксель (0,0) уровня = угол (minX, minZ) мира в координатах игры; x → восток, строка → юг (+Z), север сверху.
Уровни: res[z] м/пиксель, тайл 256 px.

    cd pipeline && uv run python build_map.py [--no-sat] [--no-scheme]
"""
import argparse
import json
import math
import shutil
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import MultiPolygon

from config import DATA_PROCESSED, DATA_RAW, ROOT
from world.osm import OsmData

OUT = ROOT / "game" / "public" / "world-map"
WORLD = ROOT / "game" / "public" / "world"
TILE = 256
RES = [8.0, 4.0, 2.0, 1.0]   # м/пиксель по уровням (0 — обзор)
SS = 2                        # суперсэмплинг схемы

BG = (29, 33, 39)
COL = {
    "grass": (36, 62, 44), "park": (38, 70, 48), "wood": (30, 56, 38), "scrub": (34, 58, 40), "residential": (33, 37, 44),
    "industrial": (40, 40, 46), "cemetery": (34, 52, 42), "allot": (42, 58, 40), "sport": (40, 78, 56), "water": (42, 82, 128),
    "bldg": (62, 68, 78), "bldg_edge": (82, 90, 102), "rail": (150, 140, 126), "rail_d": (225, 218, 200),
}
# класс дороги -> (минимальная ширина м на карте, заливка, обводка, порядок)
ROADS = {
    "service": (3.0, (92, 96, 104), (44, 48, 55), 0), "living_street": (4.0, (100, 104, 112), (44, 48, 55), 0),
    "unclassified": (5.0, (118, 122, 130), (44, 48, 55), 1), "residential": (5.5, (128, 132, 140), (44, 48, 55), 1),
    "tertiary": (7.0, (190, 192, 198), (50, 54, 62), 2), "tertiary_link": (5.0, (190, 192, 198), (50, 54, 62), 2),
    "secondary": (9.0, (238, 200, 120), (64, 52, 30), 3), "secondary_link": (6.0, (238, 200, 120), (64, 52, 30), 3),
    "primary": (11.0, (247, 168, 96), (74, 44, 24), 4), "primary_link": (7.0, (247, 168, 96), (74, 44, 24), 4),
}
AREA_RULES = [  # (ключ тега, значения, цвет, порядок)
    ("landuse", {"residential"}, "residential", 0), ("landuse", {"industrial", "commercial", "retail", "garages", "construction"}, "industrial", 0),
    ("landuse", {"grass", "meadow", "recreation_ground", "village_green", "conservation", "religious"}, "grass", 1),
    ("natural", {"grassland", "wetland", "beach"}, "grass", 1), ("natural", {"scrub"}, "scrub", 2), ("landuse", {"allotments"}, "allot", 1),
    ("landuse", {"cemetery"}, "cemetery", 1), ("leisure", {"park", "garden", "nature_reserve"}, "park", 2),
    ("natural", {"wood"}, "wood", 3), ("landuse", {"forest"}, "wood", 3), ("leisure", {"pitch", "stadium", "track"}, "sport", 4),
]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def polys(p):
    return list(p.geoms) if isinstance(p, MultiPolygon) else [p]


def collect_areas(osm):
    items = []  # (order, color, polygon)
    def tag_color(tg):
        for k, vals, c, o in AREA_RULES:
            if tg.get(k) in vals:
                return c, o
        return None
    for wid, (refs, tg) in osm.ways.items():
        cc = tag_color(tg)
        if cc and refs[0] == refs[-1]:
            p = osm.way_polygon(wid)
            if p is not None and not p.is_empty:
                items.append((cc[1], cc[0], p))
    for rid, tg, mem in osm.rels:
        cc = tag_color(tg)
        if cc and tg.get("type") == "multipolygon":
            p = osm.rel_polygon(mem)
            if p is not None and not p.is_empty:
                items.append((cc[1], cc[0], p))
    items.sort(key=lambda t: t[0])
    return items


def collect_waterways(osm):
    """Линии рек/ручьёв (ширина м) — для узких водотоков, не покрытых полигонами воды."""
    out = []
    wid_w = {"river": 12.0, "canal": 8.0, "stream": 3.0, "drain": 2.0, "ditch": 2.0}
    for wid, (refs, tg) in osm.ways.items():
        w = tg.get("waterway")
        if w in wid_w and tg.get("tunnel") != "yes":
            pts = osm.way_xy(wid)
            if len(pts) > 1:
                out.append((pts, wid_w[w]))
    return out


class Scene:
    """Всё, что рисуется на схеме, в координатах игры (x, z)."""
    def __init__(self, osm, minx, minz):
        self.minx, self.minz = minx, minz
        log("области…")
        self.areas = [(c, [(np.c_[np.array(pg.exterior.coords)[:, 0], -np.array(pg.exterior.coords)[:, 1]],
                            [np.c_[np.array(h.coords)[:, 0], -np.array(h.coords)[:, 1]] for h in pg.interiors]) for pg in polys(p)])
                      for _, c, p in collect_areas(osm)]
        log(f"  {len(self.areas)}")
        self.water = [[(np.c_[np.array(pg.exterior.coords)[:, 0], -np.array(pg.exterior.coords)[:, 1]],
                        [np.c_[np.array(h.coords)[:, 0], -np.array(h.coords)[:, 1]] for h in pg.interiors]) for pg in polys(p)]
                      for p, _ in osm.water()]
        self.waterways = [(np.c_[p[:, 0], -p[:, 1]], w) for p, w in collect_waterways(osm)]
        self.bldg = []
        for p, tg, _ in osm.buildings():
            for pg in polys(p):
                self.bldg.append(np.c_[np.array(pg.exterior.coords)[:, 0], -np.array(pg.exterior.coords)[:, 1]])
        log(f"  вода {len(self.water)}, зданий {len(self.bldg)}")
        g = json.load(open(WORLD / "roads" / "graph.json"))
        self.roads = []
        for e in g["edges"]:
            hw = e.get("highway") or "service"
            if hw not in ROADS:
                continue
            self.roads.append((hw, e.get("width") or 6.0, bool(e.get("bridge")), np.array([[p[0], p[2]] for p in e["points"]])))
        net = json.load(open(WORLD / "rail" / "net.json"))
        self.rails = [np.array([[p[0], p[2]] for p in s["points"]]) for s in net["segments"]]
        log(f"  дорог {len(self.roads)}, путей {len(self.rails)}")

    def render(self, res, ss, w, h, lite=False):
        """Растр всего мира res м/пикс (w × h px) в суперсэмплинге ss."""
        k = ss / res
        W, H = w * ss, h * ss
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)
        T = lambda a: [(float((x - self.minx) * k), float((z - self.minz) * k)) for x, z in a]
        for c, parts in self.areas:
            for ext, holes in parts:
                if len(ext) > 2:
                    d.polygon(T(ext), fill=COL[c])
                    for hl in holes:
                        d.polygon(T(hl), fill=BG)
        for parts in self.water:
            for ext, holes in parts:
                d.polygon(T(ext), fill=COL["water"])
                for hl in holes:
                    d.polygon(T(hl), fill=BG)
        for pts, wd in self.waterways:
            d.line(T(pts), fill=COL["water"], width=max(1, round(max(wd, res * 1.2) * k)), joint="curve")
        for ring in self.bldg:
            if res >= 8 and len(ring) < 4:
                continue
            t = T(ring)
            d.polygon(t, fill=COL["bldg"], outline=COL["bldg_edge"] if res <= 2 else None)
        # дороги: обводка, затем заливка, по классам снизу вверх; мосты поверх
        order = sorted(self.roads, key=lambda r: (r[2], ROADS[r[0]][3]))
        def rw(hw, width):
            mn = ROADS[hw][0]
            # на мелких масштабах дорога не тоньше ~1.6 px заливки
            return max(width, mn * 0.75, res * 1.6)
        for hw, width, br, pts in order:
            if res >= 8 and hw == "service":
                continue
            w_ = rw(hw, width) * k
            d.line(T(pts), fill=ROADS[hw][2], width=max(2, round(w_ + (2.2 if res <= 4 else 1.6) * ss)), joint="curve")
        for hw, width, br, pts in order:
            if res >= 8 and hw == "service":
                continue
            w_ = rw(hw, width) * k
            d.line(T(pts), fill=ROADS[hw][1], width=max(1, round(w_)), joint="curve")
        # железная дорога: серая линия + светлый пунктир
        rw_px = max(1.5 * ss, 3.0 * k)
        dash = max(3.0 * ss, 7.0 * k)
        for pts in self.rails:
            t = T(pts)
            d.line(t, fill=COL["rail"], width=max(1, round(rw_px)), joint="curve")
            acc = 0.0
            for (x0, y0), (x1, y1) in zip(t, t[1:]):
                L = math.hypot(x1 - x0, y1 - y0)
                if L <= 0:
                    continue
                s = 0.0
                while s < L:
                    on = int((acc + s) // dash) % 2 == 1
                    e = min(L, s + dash - (acc + s) % dash)
                    if on:
                        d.line([(x0 + (x1 - x0) * s / L, y0 + (y1 - y0) * s / L), (x0 + (x1 - x0) * e / L, y0 + (y1 - y0) * e / L)],
                               fill=COL["rail_d"], width=max(1, round(rw_px * 0.55)))
                    s = e
                acc += L
        if ss > 1:
            img = img.resize((w, h), Image.LANCZOS)
        return img


def export_labels(osm, b):
    """labels.json: районы (place=suburb/quarter/village/hamlet) и крупные именованные парки/леса — центроиды в координатах игры."""
    out = []
    def inside(x, z):
        return b["minX"] <= x <= b["maxX"] and b["minZ"] <= z <= b["maxZ"]
    def add(kind, name, x, z, area=0.0):
        if inside(x, z):
            out.append({"kind": kind, "name": name, "x": round(x, 1), "z": round(z, 1), "area": round(area)})
    place_kinds = {"suburb", "quarter", "village", "hamlet"}
    seen = set()
    for wid, (refs, tg) in osm.ways.items():
        name = tg.get("name")
        if not name or refs[0] != refs[-1]:
            continue
        is_place = tg.get("place") in place_kinds
        is_green = tg.get("leisure") == "park" or tg.get("natural") == "wood" or tg.get("landuse") == "forest"
        if not (is_place or is_green):
            continue
        p = osm.way_polygon(wid)
        if p is None or p.is_empty or (is_green and not is_place and p.area < 60000):
            continue
        c = p.representative_point()
        add("district" if is_place else "park", name, c.x, -c.y, p.area)
        seen.add(name)
    for rid, tg, mem in osm.rels:
        name = tg.get("name")
        if not name or name in seen or tg.get("type") != "multipolygon":
            continue
        is_place = tg.get("place") in place_kinds
        is_green = tg.get("leisure") == "park" or tg.get("natural") == "wood" or tg.get("landuse") == "forest"
        if not (is_place or is_green):
            continue
        p = osm.rel_polygon(mem)
        if p is None or p.is_empty or (is_green and not is_place and p.area < 60000):
            continue
        c = p.representative_point()
        add("district" if is_place else "park", name, c.x, -c.y, p.area)
    # узлы place=suburb (Кальное, Соколовка) — их в osm.node_tags нет, читаем из xml отдельно
    import xml.etree.ElementTree as ET
    from config import to_world
    for _, el in ET.iterparse(DATA_RAW / "osm" / "ryazan.osm"):
        if el.tag == "node" and len(el):
            tg = {c.get("k"): c.get("v") for c in el.iter("tag")}
            if tg.get("place") in place_kinds and tg.get("name"):
                x, y = to_world.transform(float(el.get("lon")), float(el.get("lat")))
                add("district", tg["name"], x, -y)
        el.clear()
    json.dump({"version": 1, "labels": out}, open(OUT / "labels.json", "w"), ensure_ascii=False, indent=0)
    log(f"labels.json: {len(out)}")


def save_tiles(img, zdir, lossless, quality, level_w, level_h):
    zdir.mkdir(parents=True, exist_ok=True)
    n = 0
    total = 0
    for ty in range(math.ceil(level_h / TILE)):
        for tx in range(math.ceil(level_w / TILE)):
            tile = img.crop((tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE))
            if tile.size != (TILE, TILE):
                full = Image.new("RGB", (TILE, TILE), BG)
                full.paste(tile, (0, 0))
                tile = full
            ex = tile.getextrema()
            if all(lo == hi for lo, hi in ex) and (lossless and tuple(lo for lo, _ in ex) == BG or not lossless and ex[0][1] < 3):
                continue  # пустой тайл (вне мира): клиент рисует фон
            f = zdir / f"{tx}_{ty}.webp"
            if lossless:
                tile.save(f, "WEBP", lossless=True, quality=60, method=3)
            else:
                tile.save(f, "WEBP", quality=quality, method=4)
            n += 1
            total += f.stat().st_size
    return n, total


def sat_image(res, w, h, minx, minz):
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds
    src_name = "yandex_0.5m.tif" if res <= 1.0 else "yandex_2m.tif"
    with rasterio.open(DATA_PROCESSED / "ortho" / src_name) as r:
        # окно в мировых (x, y): y = -z. Мир по сетке карты: x ∈ [minx, minx + w*res], y ∈ [-(minz + h*res), -minz]
        x0, x1 = minx, minx + w * res
        y0, y1 = -(minz + h * res), -minz
        arr = r.read(indexes=[1, 2, 3], window=from_bounds(x0, y0, x1, y1, r.transform), out_shape=(3, h, w),
                     boundless=True, fill_value=0, resampling=Resampling.average)
    return Image.fromarray(np.moveaxis(arr, 0, -1).astype(np.uint8), "RGB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-sat", action="store_true")
    ap.add_argument("--no-scheme", action="store_true")
    ap.add_argument("--labels-only", action="store_true")
    ap.add_argument("--sat-quality", type=int, default=68)
    a = ap.parse_args()
    man = json.load(open(WORLD / "manifest.json"))
    b = man["bounds"]
    minx, minz = b["minX"], b["minZ"]
    W_m, H_m = b["maxX"] - minx, b["maxZ"] - minz
    levels = []
    for r in RES:
        levels.append({"res": r, "w": math.ceil(W_m / r), "h": math.ceil(H_m / r)})
    for lv in levels:
        lv["cols"], lv["rows"] = math.ceil(lv["w"] / TILE), math.ceil(lv["h"] / TILE)
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {"version": 1, "tile": TILE, "minX": minx, "minZ": minz, "maxX": b["maxX"], "maxZ": b["maxZ"], "levels": levels,
            "layers": {}, "format": "webp"}
    sizes = {}
    osm = OsmData(DATA_RAW / "osm" / "ryazan.osm")
    export_labels(osm, b)
    if a.labels_only:
        return
    if not a.no_scheme:
        sc = Scene(osm, minx, minz)
        shutil.rmtree(OUT / "scheme", ignore_errors=True)
        for z, lv in enumerate(levels):
            log(f"схема z{z} ({lv['res']} м/px, {lv['w']}×{lv['h']})")
            img = sc.render(lv["res"], SS, lv["w"], lv["h"])
            n, tot = save_tiles(img, OUT / "scheme" / str(z), True, 100, lv["w"], lv["h"])
            sizes["scheme"] = sizes.get("scheme", 0) + tot
            log(f"  {n} тайлов, {tot / 1e6:.1f} МБ")
            del img
    if not a.no_sat:
        shutil.rmtree(OUT / "sat", ignore_errors=True)
        for z, lv in enumerate(levels):
            log(f"спутник z{z}")
            img = sat_image(lv["res"], lv["w"], lv["h"], minx, minz)
            n, tot = save_tiles(img, OUT / "sat" / str(z), False, a.sat_quality, lv["w"], lv["h"])
            sizes["sat"] = sizes.get("sat", 0) + tot
            log(f"  {n} тайлов, {tot / 1e6:.1f} МБ")
            del img
    for name in ("scheme", "sat"):
        if (OUT / name).exists():
            meta["layers"][name] = True
    json.dump(meta, open(OUT / "meta.json", "w"), indent=1)
    log("итого:", {k: f"{v / 1e6:.1f} МБ" for k, v in sizes.items()})


if __name__ == "__main__":
    main()
