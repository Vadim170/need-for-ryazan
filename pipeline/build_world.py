"""Этап 1: сборка «серого бокса» мира для игры.
Запуск: cd pipeline && uv run python build_world.py
Вход: data/raw/osm/ryazan.osm, data/raw/dem/fabdem/fabdem_crop.tif
Выход: game/public/world/ (формат: docs/world-format.md), промежуточное: data/processed/sumo/
"""
import json
import math
import shutil
import time
from collections import defaultdict

import numpy as np
from scipy.ndimage import gaussian_filter
from rasterio.warp import Resampling
from shapely.geometry import Point, box
from shapely.ops import unary_union

from config import BBOX, DATA_PROCESSED, DATA_RAW, ORIGIN_LAT, ORIGIN_LON, ROOT, to_world
from world import buildings as B
from world.gltf import Prim, fix_winding, smooth_normals, write_glb
from world.grid import Grid
from world.osm import OsmData
from world.roads import (base_class, bridge_crossings, bridge_profile, build_roads, dig_underpasses, cumlen, junction_heights, junction_polygon, offset, resample,
                         road_profile)
from world.sumo_net import Net, run_netconvert
from world import bridges as BR
from world.terrain import carve_water, clamp_under_bridges, condition_roads, load_dem, raster_mask

OUT = ROOT / "game" / "public" / "world"
WORK = DATA_PROCESSED / "sumo"
TILE = 250.0
CELL = 5.0
BASE_HEIGHT = 90.0           # уровень Оки в FABDEM
ROAD_LIFT = 0.05
DECK_THICK = 0.8
TERRAIN_MESH = False         # нода terrain в тайлах (v1 писала; с v1.1 игра строит рельеф из heightmap)
TERRAIN_V2 = True            # рельеф v2 (world/terrain_v2.py, docs/stage2/terrain-v2.md); False / --terrain v1 = FABDEM + гаусс 17.5 м
BUILDINGS_V2 = True          # здания v2 (архетипы); False — старая экструзия building_<type>
SPAWN_N = 50
SPAWN_CLASSES = {"primary", "secondary", "tertiary"}
SPAWN_FIXED = [("площадь Победы", 54.6293, 39.7116), ("пост ДПС", 54.6378, 39.7814)]

T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


def world_bounds():
    S, W, N, E = BBOX
    xs, ys = to_world.transform([W, E, W, E], [S, S, N, N])
    snap = lambda v, f: f(v / TILE) * TILE
    return snap(min(xs), math.floor), snap(max(xs), math.ceil), snap(min(ys), math.floor), snap(max(ys), math.ceil)


def tile_key(x, y):
    """(ix, iz) по мировым x, y (z = -y)."""
    return int(math.floor(x / TILE)), int(math.floor(-y / TILE))


def main():
    min_x, max_x, min_y, max_y = world_bounds()
    grid = Grid(min_x, max_x, min_y, max_y, CELL)
    log(f"мир x[{min_x},{max_x}] y[{min_y},{max_y}], сетка {grid.cols}x{grid.rows}")
    WORK.mkdir(parents=True, exist_ok=True)

    # ---------- OSM
    osm = OsmData(DATA_RAW / "osm" / "ryazan.osm")
    from world import overrides as OV   # правки дорог по снимку: data/overrides/roads.json (docs/stage1/junctions.md)
    OV.apply(osm, ROOT / "data" / "overrides" / "roads.json", log)
    OV.apply(osm, ROOT / "data" / "overrides" / "elevation.json", log)   # мосты/насыпи/выемки (docs/stage2/terrain-v2.md)
    from world import building_overrides as BO   # контуры зданий: data/overrides/buildings.json + отчёт о подозрительных
    BO.apply(osm, ROOT / "data" / "overrides" / "buildings.json", log)
    BO.check(osm, WORK / "building_outline_check.json", log, DATA_PROCESSED / "ortho" / "yandex_0.5m.tif")
    from world import landmarks as LM   # hero-модели: заменяемые здания OSM + футпринты-препятствия (docs/stage2/landmarks.md)
    LM.apply(osm, log=log)
    car = osm.car_ways()
    log(f"OSM: путей {len(osm.ways)}, автодорог {len(car)}")
    m = 3.0
    inside = lambda p: (p[:, 0] > min_x + m) & (p[:, 0] < max_x - m) & (p[:, 1] > min_y + m) & (p[:, 1] < max_y - m)
    osm.write_filtered_osm(WORK / "roads.osm", car, inside)
    run_netconvert(WORK / "roads.osm", WORK / "net.xml", WORK / "types.typ.xml", ORIGIN_LAT, ORIGIN_LON)
    net = Net(WORK / "net.xml")
    log(f"netconvert: рёбер {len(net.edges)}, узлов {len(net.junctions)}")

    # ---------- рельеф
    h0, gtf = load_dem(DATA_RAW / "dem" / "fabdem" / "fabdem_crop.tif", grid, smooth_m=17.5)
    raw, _ = load_dem(DATA_RAW / "dem" / "fabdem" / "fabdem_crop.tif", grid, smooth_m=0, resampling=Resampling.bilinear)
    world_box = box(min_x, min_y, max_x, max_y)
    water = []
    for poly, tg in osm.water():
        p = poly.intersection(world_box)
        if p.is_empty or p.area < 100:
            continue
        mk = raster_mask([(p, 1)], grid, gtf) > 0
        if mk.sum() >= 3:
            level = float(np.percentile(raw[mk], 10))
        else:
            rp = p.representative_point()
            level = float(grid.sample_bilinear(raw, [rp.x], [rp.y])[0])
        water.append((p, level, tg.get("name", "")))
    if TERRAIN_V2:
        from world import terrain_v2 as TV2
        h0, _, _ = TV2.build(grid, gtf, osm, [p for p, _, _ in water], DATA_RAW / "dem" / "fabdem" / "fabdem_crop.tif",
                             DATA_RAW / "topo" / "ggc250_z15.tif", DATA_PROCESSED / "terrain_v2", log)
    h1, water_mask = carve_water(h0, [(p, lv) for p, lv, _ in water], grid, gtf)
    log(f"вода: {len(water)} полигонов, уровни {sorted({round(lv, 1) for _, lv, _ in water})[:8]}...")

    # ---------- дороги: профили и вжатие
    roads = build_roads(net, osm.ways)
    from world import structures as ST   # габарит мостов над ж/д и водой, сооружения (docs/stage2/terrain-v2.md)
    lb, _ = ST.bridge_lower_bounds(roads, osm, grid, h1, log)
    # профили дорог — по слегка сглаженному рельефу: детали v2 (бровки, валы) не должны давать «волну» вдоль оси
    h0r = gaussian_filter(h0, 10.0 / CELL) if TERRAIN_V2 else h0
    ub = {}
    for it in range(4):
        zj, floating, jix = junction_heights(net, roads, grid, h0r, ub, lb=lb)
        for r in roads:
            if not r.bridge:
                road_profile(r, zj, grid, h0r)
        if it == 0:
            n_cross = bridge_crossings(roads)
        # узел «только мосты», но лежащий на земле (насыпь), считаем наземным: площадка вжимается в рельеф
        # (если рядом нет дороги, проходящей под мостом — там узел остаётся «висячим»)
        if it == 0:
            cross_xy = np.array([[np.interp(cs, cumlen(b.axis), b.axis[:, 0]), np.interp(cs, cumlen(b.axis), b.axis[:, 1])]
                                 for b in roads if b.bridge for cs, *_ in (getattr(b, "cross", None) or [])]).reshape(-1, 2)
        floating = floating.copy()
        for j, i in jix.items():
            if floating[i]:
                J = net.junctions[j]
                near = len(cross_xy) and np.hypot(*(cross_xy - [J["x"], J["y"]]).T).min() < BR.CROSS_KEEP + 5
                if not near and grid.sample_bilinear(h1, [J["x"]], [J["y"]])[0] > zj[j] - BR.EMBANK_CLEAR:
                    floating[i] = False
        # профиль настила: насыпи у опор, следование рельефу, выравнивание парных мостов (world/bridges.py)
        for r in roads:
            if r.bridge:
                BR.deck_profile(r, zj, grid, h1, (not floating[jix[r.frm]], not floating[jix[r.to]]))
        BR.harmonize([r for r in roads if r.bridge])
        for r in roads:
            if r.bridge:
                BR.finalize_deck(r, grid, h1)
        # габарит не набран -> опускаем дорогу снизу; задетые перекрёстки ограничиваем сверху и повторяем
        n_dig, ub_new = dig_underpasses(roads, zj)
        if not ub_new:
            break
        for j, v in ub_new.items():
            ub[j] = min(ub.get(j, 1e9), v)
    bad_clear = [r.osm_id for r in roads if r.bridge and getattr(r, "clearance_ok", True) is False]
    samples, deck = [], []
    for r in roads:
        hw = max(r.Wf, r.Wb) if r.fwd is not None and r.bwd is not None else r.Wf / 2
        if r.bridge:
            burn, clamp = BR.terrain_samples(r)
            samples.append(burn); deck.append(clamp)
        else:
            samples.append(np.c_[r.axis, r.z_axis, np.full(len(r.axis), hw)])
    samples = np.concatenate(samples)
    jpolys = []
    for j in zj:
        if floating[jix[j]]:
            continue
        p = junction_polygon(net.junctions[j])
        if p is not None:
            jpolys.append((p, zj[j]))
    h2, wroad = condition_roads(h1, grid, gtf, samples, jpolys, flat_margin=CELL if TERRAIN_V2 else 1.0)   # v2: полка на ячейку (тротуар; нет «купола» под кромкой ленты)
    deck = np.concatenate(deck) if deck else np.zeros((0, 5))
    if len(deck):   # под пролётом рельеф не выше исходного (ж/д и водотоки под путепроводами не засыпаны подходами),
        # кроме 8 м у площадок перекрёстков (иначе край площадки «проваливается» вслед за соседним узлом сетки)
        import shapely
        far = shapely.distance(unary_union([p for p, _ in jpolys]), shapely.points(deck[:, :2])) > 8.0
        deck[far, 4] = np.maximum(deck[far, 4], deck[far, 2] - grid.sample_bilinear(h1, deck[far, 0], deck[far, 1]))
    # смягчаем ступеньки между площадками/коридорами: сглаживаем только приращение от вжатия
    # мелкие детали рельефа (v2: бровки, валы) внутри коридоров дорог иначе переживают сглаживание приращения
    # и «просвечивают» сквозь ленты: у дорог берём рельеф, сглаженный на ту же сигму
    hs = h1 + (gaussian_filter(h1, 2.0) - h1) * np.clip(wroad * 2.0, 0, 1) if TERRAIN_V2 else h1
    h2 = hs + gaussian_filter(h2 - hs, 1.0)
    h2 = BR.enforce_underpasses(h2, grid, BR.underpass_samples(roads))
    H = clamp_under_bridges(h2, grid, deck, keep=wroad > 0.3)
    H = ST.open_under_rail(H, grid, roads)   # проём под путепроводами над ж/д (world/structures.py)
    from world import railways as RW   # ж/д: граф, профиль, вжатие коридоров в окончательный рельеф (docs/stage2/rail.md)
    H, rail = RW.prepare(osm, roads, grid, H, wroad, (min_x, max_x, min_y, max_y), DATA_RAW / "osm" / "ryazan.osm", log)
    log(f"дороги: {len(roads)} (мостов {sum(r.bridge for r in roads)}, тоннелей {sum(r.tunnel for r in roads)}), "
        f"узлов {len(zj)}; вжатие: изменено {np.mean(np.abs(H - h1) > 0.05) * 100:.1f}% узлов, "
        f"макс |dh| {np.abs(H - h1).max():.1f} м; пересечений мост/дорога {n_cross}, "
        f"мостов без габарита {len(bad_clear)} (дороги под ними опущены: {n_dig})")

    # ---------- вывод
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "terrain").mkdir(parents=True); (OUT / "tiles").mkdir(); (OUT / "roads").mkdir()
    hm = (H - BASE_HEIGHT).astype("<f4")
    from world import lybed as LY   # Лыбедский бульвар: выемка под арками Астраханского моста — только в файле игры (docs/stage3/lybed.md)
    LY.carve_heightmap(hm, grid, BASE_HEIGHT, log).tofile(OUT / "terrain" / "heightmap.f32")

    tiles = defaultdict(lambda: defaultdict(lambda: defaultdict(Prim)))  # key -> node -> material -> Prim
    keys = [(ix, iz) for ix in range(int(min_x // TILE), int(max_x // TILE))
            for iz in range(int(-max_y // TILE), int(-min_y // TILE))]

    # рельеф: меш в тайлы больше не пишем (игра строит его из heightmap.f32); TERRAIN_MESH = True вернёт ноду
    gz, gx = np.gradient(hm.astype(np.float64), CELL)  # строки = +z, столбцы = +x
    nrm = np.dstack([-gx, np.ones_like(gx), -gz])
    nrm /= np.linalg.norm(nrm, axis=2, keepdims=True)
    n = int(TILE / CELL)
    rr, cc = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
    v00 = (rr * (n + 1) + cc).ravel(); v10 = v00 + (n + 1); v11 = v10 + 1; v01 = v00 + 1
    tri_terrain = None
    for ix, iz in (keys if TERRAIN_MESH else []):
        c0 = int(round((ix * TILE - min_x) / CELL)); r0 = int(round((iz * TILE + max_y) / CELL))
        sub = hm[r0:r0 + n + 1, c0:c0 + n + 1]
        xs = ix * TILE + np.arange(n + 1) * CELL; zs = iz * TILE + np.arange(n + 1) * CELL
        X, Z = np.meshgrid(xs, zs)
        P = np.c_[X.ravel(), sub.ravel(), Z.ravel()]
        if tri_terrain is None:
            tri_terrain = fix_winding(P, np.c_[v00, v10, v11, v00, v11, v01].reshape(-1, 3), np.array([0, 1.0, 0]))
        tiles[(ix, iz)]["terrain"]["terrain"].add(P, tri_terrain, nrm[r0:r0 + n + 1, c0:c0 + n + 1].reshape(-1, 3))

    def surf(x, y):
        return grid.sample(H, x, y) - BASE_HEIGHT + ROAD_LIFT

    def add_ribbon(node, mat, L, R, y_l, y_r, v, extra_lift=0.0, uv=True):
        """Лента из левой/правой границы, режется по тайлам по середине сегмента."""
        mid = (L[:-1] + L[1:] + R[:-1] + R[1:]) / 4
        ks = [tile_key(x, y) for x, y in mid]
        i = 0
        while i < len(ks):
            j = i
            while j + 1 < len(ks) and ks[j + 1] == ks[i]:
                j += 1
            sl = slice(i, j + 2)
            k = j + 2 - i
            P = np.empty((2 * k, 3))
            P[0::2] = np.c_[R[sl, 0], y_r[sl] + extra_lift, -R[sl, 1]]
            P[1::2] = np.c_[L[sl, 0], y_l[sl] + extra_lift, -L[sl, 1]]
            q = 2 * np.arange(k - 1)[:, None]
            T = np.c_[q, q + 2, q + 3, q, q + 3, q + 1].reshape(-1, 3)
            T = fix_winding(P, T, np.array([0, 1.0, 0]))
            UV = None
            if uv:
                UV = np.empty((2 * k, 2)); UV[0::2, 0] = 0; UV[1::2, 0] = 1
                UV[0::2, 1] = v[sl]; UV[1::2, 1] = v[sl]
            tiles[ks[i]][node][mat].add(P, T, smooth_normals(P, T), UV)
            i = j + 1

    def add_slab(node, mat, L, R, y_l, y_r, thick, with_top, normals=True):
        """Плита моста: низ и боковины (+ верх) — для визуала и коллайдера. thick — массив по вершинам."""
        mid = (L[:-1] + L[1:] + R[:-1] + R[1:]) / 4
        ks = [tile_key(x, y) for x, y in mid]
        for s in range(len(mid)):
            a, b = s, s + 1
            corners_top = [(R[a], y_r[a], thick[a]), (R[b], y_r[b], thick[b]), (L[b], y_l[b], thick[b]),
                           (L[a], y_l[a], thick[a])]
            quads = []
            top = [np.r_[p[0], y, -p[1]] for p, y, _ in corners_top]
            bot = [np.r_[p[0], y - th, -p[1]] for p, y, th in corners_top]
            if with_top: quads.append((top, np.array([0, 1.0, 0])))
            quads.append((bot[::-1], np.array([0, -1.0, 0])))
            # боковины: правая R[a]-R[b], левая L[b]-L[a]
            for e0, e1 in ((0, 1), (2, 3)):
                q = [bot[e0], bot[e1], top[e1], top[e0]]
                mid3 = (top[0] + top[1] + top[2] + top[3]) / 4
                out = (q[0] + q[1]) / 2 - mid3; out[1] = 0
                quads.append((q, out))
            for q, want in quads:
                P = np.array(q)
                T = fix_winding(P, np.array([[0, 1, 2], [0, 2, 3]]), want)
                N = np.tile(want / (np.linalg.norm(want) or 1), (4, 1)) if normals else None
                tiles[ks[s]][node][mat].add(P, T, N)

    # ленты дорог (по направленным рёбрам)
    n_ribbons = 0
    road_len = 0.0
    for r in roads:
        road_len += cumlen(r.axis)[-1]
        for e, frm, to in ((r.fwd, r.frm, r.to), (r.bwd, r.to, r.frm)):
            if e is None:
                continue
            l0 = e["lanes"][0]
            W = sum(l["width"] for l in e["lanes"])
            lane = resample(l0["shape"], 4.0)
            if len(lane) < 2:
                continue
            Rb = offset(lane, -l0["width"] / 2); Lb = offset(lane, W - l0["width"] / 2)
            v = cumlen(lane)
            if r.bridge:
                t = v / max(v[-1], 1e-6)
                if e is r.bwd:
                    t = 1 - t
                sq = t * r.s_axis[-1]
                yl = BR.surface(r, sq, Lb[:, 0], Lb[:, 1], H, grid, BASE_HEIGHT, ROAD_LIFT)
                yr = BR.surface(r, sq, Rb[:, 0], Rb[:, 1], H, grid, BASE_HEIGHT, ROAD_LIFT)
                th = BR.slab_thickness(r, sq, DECK_THICK)
                add_ribbon("roads", "road_asphalt", Lb, Rb, yl, yr, v)
                add_slab("bridges", "bridge_concrete", Lb, Rb, yl - 0.02, yr - 0.02, np.maximum(th - 0.02, 0.01), with_top=False)
                add_slab("bridge_colliders", None, Lb, Rb, yl, yr, th, with_top=True, normals=False)
            else:
                add_ribbon("roads", "road_asphalt", Lb, Rb, surf(Lb[:, 0], Lb[:, 1]), surf(Rb[:, 0], Rb[:, 1]), v)
            n_ribbons += 1
    # площадки перекрёстков
    n_junc = 0
    for j in zj:
        J = net.junctions[j]
        p = junction_polygon(J)
        if p is None:
            continue
        V2, T = B.triangulate(p)
        if V2 is None:
            continue
        fl = floating[jix[j]]
        y = np.full(len(V2), zj[j] - BASE_HEIGHT + ROAD_LIFT) if fl else surf(V2[:, 0], V2[:, 1])
        P = np.c_[V2[:, 0], y + 0.01, -V2[:, 1]]
        T = fix_winding(P, T, np.array([0, 1.0, 0]))
        c = p.centroid
        tiles[tile_key(c.x, c.y)]["roads"]["road_junction"].add(P, T, smooth_normals(P, T), np.c_[P[:, 0], P[:, 2]])
        if fl:
            Pb = P.copy(); Pb[:, 1] -= DECK_THICK
            tiles[tile_key(c.x, c.y)]["bridge_colliders"][None].add(np.r_[P, Pb], np.r_[T, T[:, ::-1] + len(P)])
        n_junc += 1
    log(f"дороги: лент {n_ribbons}, площадок перекрёстков {n_junc}, длина осей {road_len / 1000:.1f} км")

    # ---------- здания
    stats_b = defaultdict(int)
    # здания v2 строятся ниже, после streetlife (витринные участки стен берутся из её storefronts)
    for poly, tg, oid in ([] if BUILDINGS_V2 else osm.buildings()):
        if tg.get("building") in B.SKIP or LM.is_hero(tg):
            stats_b["skipped_type"] += 1
            continue
        rp = poly.representative_point()
        if not (min_x + 1 < rp.x < max_x - 1 and min_y + 1 < rp.y < max_y - 1):
            continue
        cat = B.category(tg)
        hgt, src = B.height_of(tg, cat)
        stats_b[cat] += 1; stats_b["h_" + src] += 1
        key = tile_key(rp.x, rp.y)
        for part in B.polygons(poly.simplify(0.2, preserve_topology=True)):
            if part.area < 4:
                continue
            ext = np.asarray(part.exterior.coords)
            base = float(grid.sample(H, ext[:, 0], ext[:, 1]).min()) - BASE_HEIGHT
            res = B.prism(part, base, base + hgt)
            if res is None:
                continue
            P, N, U, I = res
            tiles[key]["buildings"]["building_" + cat].add(P, I, N, U)
            for cp in B.polygons(part.simplify(1.0, preserve_topology=True)):
                if cp.area < 4:
                    continue
                rc = B.prism(cp, base, base + hgt)
                if rc is not None:
                    tiles[key]["building_colliders"][None].add(rc[0], rc[3])
        stats_b["total"] += 1
    log(f"здания: {dict(stats_b)}")

    # ---------- вода
    for p, level, name in water:
        y = level - BASE_HEIGHT
        bx0, by0, bx1, by1 = p.bounds
        for ix, iz in keys:
            if (ix + 1) * TILE < bx0 or ix * TILE > bx1 or -iz * TILE < by0 or -(iz + 1) * TILE > by1:
                continue
            tb = box(ix * TILE, -(iz + 1) * TILE, (ix + 1) * TILE, -iz * TILE)
            q = p.intersection(tb)
            if q.is_empty:
                continue
            for part in B.polygons(q):
                V2, T = B.triangulate(part)
                if V2 is None:
                    continue
                P = np.c_[V2[:, 0], np.full(len(V2), y), -V2[:, 1]]
                T = fix_winding(P, T, np.array([0, 1.0, 0]))
                tiles[(ix, iz)]["water"]["water"].add(P, T, np.tile([0, 1.0, 0], (len(P), 1)), np.c_[P[:, 0], P[:, 2]])

    # ---------- разметка и тротуары (world/markings.py, world/sidewalks.py)
    from world import markings as MK, sidewalks as SW
    mctx = dict(net=net, roads=roads, osm=osm, zj=zj, floating=floating, jix=jix, grid=grid, H=H, surf=surf, base=BASE_HEIGHT,
                lift=ROAD_LIFT, tiles=tiles, tile_key=tile_key, tile=TILE, net_path=WORK / "net.xml", water=water)
    crossings, mst = MK.build_markings(mctx)
    log(f"разметка: {mst}")
    log(f"тротуары: {SW.build_sidewalks(mctx, crossings)}")
    log(f"сооружения: {ST.build(mctx, OUT, log)}")   # опоры, устои, ограждения, подпорные стены, roads/structures.json
    log(f"ж/д: {RW.build(rail, mctx, OUT, log)}")   # пути, платформы, переезды, контактная сеть, rail/net.json

    # ---------- дворы, парки, пропсы (world/yards.py, world/props.py)
    from world import yards as YD
    yard = YD.build(osm, DATA_RAW / "osm" / "ryazan.osm", grid, H, roads, net, water, BASE_HEIGHT, (min_x, max_x, min_y, max_y), log,
                    sidewalks=list(mctx.get("sidewalk_footprints", {}).values()))
    for k, mats in yard.areas.items():
        tiles[k]["areas"].update(mats)
    from world import streetlife as SL   # витрины, подъезды, клумбы, ограждения, фонари (docs/stage2/streetlife.md)
    sl = SL.build(yard.ctx, mctx, crossings, DATA_RAW / "osm" / "ryazan.osm", log, v2=BUILDINGS_V2)
    if BUILDINGS_V2:   # архетипы, крыши, балконы (world/city_buildings.py, docs/stage2/buildings.md)
        from world import city_buildings as CB
        rep_b = CB.build(osm, DATA_RAW / "osm" / "ryazan.osm", grid, H, BASE_HEIGHT,
                         lambda x, y: min_x + 1 < x < max_x - 1 and min_y + 1 < y < max_y - 1, tiles, tile_key, log,
                         report_path=WORK / "buildings_report.json",
                         storefronts=[r for v in getattr(sl, "tiles_sf", {}).values() for r in v])
        stats_b["total"] = rep_b["buildings"]
    LM.clear_props(yard.ctx, sl, log)   # пропсы/витрины внутри футпринтов hero-моделей
    log(f"лыбедский бульвар: {LY.furnish(yard.ctx, sl, log)}")   # ёлка, фонари/лавки аллеи, скейтпарк (world/lybed.py)
    # проходы в оградах (world/fence_gaps.py): пешеходный граф считается до записи props, рёбра сквозь ограды убираются
    from world import walk_export as WX, fence_gaps as FG
    yard.walk_out = WX.compute(WX.gather(mctx, crossings, yard, DATA_RAW / "osm" / "ryazan.osm"), log)
    log(f"проходы в оградах: {FG.build(yard.ctx, sl, yard.walk_out, DATA_RAW / 'osm' / 'ryazan.osm', log)}; "
        f"рёбер пешеходов сквозь ограды убрано {WX.drop_fence_edges(yard.walk_out, FG.fence_lines(yard.ctx))}")
    props_files = sl.write(OUT, yard.write_props(OUT))
    from world import walk_export as WX   # пешеходная сеть people/walk.json (docs/stage2/people.md)
    log(f"пешеходы: {WX.build(mctx, crossings, yard, OUT, DATA_RAW / 'osm' / 'ryazan.osm', log)}")
    from world import lanes_export as LX   # граф полос, светофоры, маршруты ОТ: traffic/ (docs/stage2/traffic.md)
    log(f"трафик: {LX.export(mctx, osm, OUT / 'traffic', log)}")

    # ---------- запись тайлов
    order = ["terrain", "areas", "roads", "markings", "sidewalks", "bridges", "bridge_colliders", "railway", "railway_colliders", "buildings", "building_colliders", "balconies", "water"]
    tile_list, total = [], 0
    for ix, iz in keys:
        t = tiles.get((ix, iz), {})
        nodes = []
        for nm in order:
            if nm in t:
                ex = {"collider": True} if nm.endswith("_colliders") else None
                nodes.append((nm, t[nm], ex))
        f = f"tiles/{ix}_{iz}.glb"
        total += write_glb(OUT / f, nodes)
        tile_list.append({"ix": ix, "iz": iz, "file": f, "minX": ix * TILE, "minZ": iz * TILE,
                          "maxX": (ix + 1) * TILE, "maxZ": (iz + 1) * TILE})
        if (ix, iz) in props_files:
            tile_list[-1]["props"] = props_files[(ix, iz)]
    log(f"тайлов {len(tile_list)}, {total / 1e6:.1f} МБ")

    # ---------- граф
    nodes_out, nid = [], {}
    for j in zj:
        J = net.junctions[j]
        y = zj[j] - BASE_HEIGHT + ROAD_LIFT if floating[jix[j]] else float(surf(np.array([J["x"]]), np.array([J["y"]]))[0])
        nid[j] = len(nodes_out)
        nodes_out.append({"id": nid[j], "x": round(J["x"], 2), "y": round(float(y), 2), "z": round(-J["y"], 2)})
    edges_out = []
    for r in roads:
        P, z = r.axis, r.z_axis
        sel = np.r_[np.arange(0, len(P) - 1, 5), len(P) - 1]
        P, z = P[sel], z[sel]
        if r.bridge:
            y = BR.surface(r, r.s_axis[sel], P[:, 0], P[:, 1], H, grid, BASE_HEIGHT, ROAD_LIFT)
        else:
            y = surf(P[:, 0], P[:, 1])
        edges_out.append({
            "id": r.id, "from": nid[r.frm], "to": nid[r.to], "osmId": r.osm_id, "name": r.name, "highway": r.hw,
            "lanesForward": len(r.fwd["lanes"]), "lanesBackward": len(r.bwd["lanes"]) if r.bwd else 0,
            "oneway": r.bwd is None, "width": round(r.Wf + r.Wb, 2), "bridge": bool(r.bridge),
            "points": [[round(a, 2), round(float(b), 2), round(-c, 2)] for (a, c), b in zip(P, y)]})
    graph = {"nodes": nodes_out, "edges": edges_out}
    (OUT / "roads" / "graph.json").write_text(json.dumps(graph, ensure_ascii=False, separators=(",", ":")))

    # ---------- точки спавна
    spawns = make_spawns(roads, surf)

    manifest = {
        "version": 1, "baseHeight": BASE_HEIGHT, "origin": {"lat": ORIGIN_LAT, "lon": ORIGIN_LON},
        "bounds": {"minX": min_x, "maxX": max_x, "minZ": -max_y, "maxZ": -min_y},
        "terrain": {"file": "terrain/heightmap.f32", "cols": grid.cols, "rows": grid.rows, "cellSize": CELL,
                    "minX": min_x, "minZ": -max_y},
        "tileSize": TILE, "tiles": tile_list, "roads": {"file": "roads/graph.json"}, "spawnPoints": spawns,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))

    # ---------- итог
    sz = lambda p: p.stat().st_size
    tsz = [sz(OUT / t["file"]) for t in tile_list]
    log("ИТОГ")
    print(f"  heightmap: {grid.cols}x{grid.rows}, {sz(OUT / 'terrain/heightmap.f32') / 1e6:.1f} МБ, "
          f"высоты {H.min():.1f}..{H.max():.1f} м (baseHeight {BASE_HEIGHT})")
    print(f"  тайлы: {len(tile_list)} шт, всего {sum(tsz) / 1e6:.1f} МБ, сред {np.mean(tsz) / 1e3:.0f} КБ, макс {max(tsz) / 1e3:.0f} КБ")
    print(f"  граф: узлов {len(nodes_out)}, рёбер {len(edges_out)}, {sz(OUT / 'roads/graph.json') / 1e6:.1f} МБ")
    if BUILDINGS_V2:
        print(f"  здания v2: {rep_b['buildings']} (объёмов {rep_b['volumes']}), треугольников {rep_b['triangles']}, "
              f"балконов {rep_b['balconies']['total']}; этажность из {rep_b['levels_sources']}")
    else:
        print(f"  здания: {stats_b['total']}  (по типам: " + ", ".join(f"{k} {stats_b[k]}" for k in ['apartments', 'house', 'commercial', 'garage', 'other']) +
              f"; высота из height {stats_b['h_height']}, из этажей {stats_b['h_levels']}, по умолчанию {stats_b['h_default']})")
    print(f"  вода: {len(water)} полигонов; спавнов: {len(spawns)}")
    np.save(WORK / "h_stages.npy", np.stack([h0, h1, H]).astype(np.float32))


def make_spawns(roads, surf):
    cands = []  # (x, y, heading, lane polyline, road)
    lanes = []
    for r in roads:
        if base_class(r.hw) not in SPAWN_CLASSES or r.hw.endswith("_link") or r.bridge or r.tunnel:
            continue
        for e in (r.fwd, r.bwd):
            if e is None:
                continue
            P = e["lanes"][0]["shape"]
            s = cumlen(P)
            if s[-1] < 40:
                continue
            lanes.append((P, s, r))
    def at(P, s, d):
        i = int(np.clip(np.searchsorted(s, d) - 1, 0, len(P) - 2))
        t = (d - s[i]) / max(s[i + 1] - s[i], 1e-9)
        p = P[i] + (P[i + 1] - P[i]) * t
        dx, dy = P[i + 1] - P[i]
        return p, math.atan2(dx, dy)
    def spawn(P, s, d, label=None):
        p, hd = at(P, s, d)
        y = float(surf(np.array([p[0]]), np.array([p[1]]))[0])
        o = {"x": round(float(p[0]), 2), "y": round(y, 2), "z": round(float(-p[1]), 2), "heading": round(hd, 4)}
        if label:
            o["name"] = label
        return o
    out = []
    for label, lat, lon in SPAWN_FIXED:
        x, y = to_world.transform(lon, lat)
        best = None
        for P, s, r in lanes:
            if base_class(r.hw) not in ("primary", "secondary"):
                continue
            d = Point(x, y).distance(_ls(P))
            if best is None or d < best[0]:
                best = (d, P, s)
        _, P, s = best
        dd = _ls(P).project(Point(x, y))
        dd = float(np.clip(dd, 10, s[-1] - 10))
        out.append(spawn(P, s, dd, label))
    # остальные: равномерно по карте (farthest point)
    mids = np.array([at(P, s, s[-1] / 2)[0] for P, s, _ in lanes])
    chosen = [np.array([o["x"], -o["z"]]) for o in out]
    dmin = np.min([np.hypot(*(mids - c).T) for c in chosen], axis=0)
    while len(out) < SPAWN_N:
        k = int(np.argmax(dmin))
        P, s, _ = lanes[k]
        out.append(spawn(P, s, s[-1] / 2))
        dmin = np.minimum(dmin, np.hypot(*(mids - mids[k]).T))
    return out


def _ls(P):
    from shapely.geometry import LineString
    return LineString(P)


if __name__ == "__main__":
    import argparse
    from pathlib import Path
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="каталог вывода (по умолчанию game/public/world); промежуточные файлы — в <out>_work")
    ap.add_argument("--terrain", choices=["v1", "v2"], help="версия рельефа (по умолчанию TERRAIN_V2)")
    a = ap.parse_args()
    if a.terrain:
        TERRAIN_V2 = a.terrain == "v2"
    if a.out:
        OUT = Path(a.out).resolve()
        WORK = OUT.parent / (OUT.name + "_work")
    main()
