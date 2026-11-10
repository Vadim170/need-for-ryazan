"""Лыбедский бульвар (docs/stage3/lybed.md): Астраханский мост с двумя пешеходными арками, обстановка аллеи,
скейтпарк и каркасная ёлка — по панорамам Яндекса (data/raw/panoramas/lybed/) и ортофото 0.25 м.

Хуки (малые, по одной строке):
  build_world.py, запись heightmap   -> carve_heightmap(hm, grid, base, H)   выемка под арками (только файл игры)
  build_world.py, после LM.clear_props -> furnish(yard.ctx, sl, log)       ёлка, фонари/лавки/урны аллеи, скейтпарк
  walk_export.gather / compute        -> walk_lines(), walk_y(XY, Y)        проходы под мостом в пешеходном графе

Мост. Ул. Ленина пересекает бульвар по дамбе (data/overrides/elevation.json, lenina_dam_*); в 2021 г. в ней открыли
два сквозных арочных прохода (панорамы 2026-03: data/raw/panoramas/lybed/crops/astrakhan/). Пайплайн по-прежнему
строит дамбу в рельефе (дорога, тротуары, разметка — по неизменённому H), а heightmap для игры вынимается под
проходами и перед фасадами (carve_heightmap). Пустоту закрывает hero-модель `astrakhan_bridge`
(assets/scripts/landmarks/astrakhan_bridge.py): фасады, своды, парапет с чугунной решёткой и коллайдеры —
плиты настила по поверхности дороги + массив кладки вокруг проходов. Система координат моста (локальная модели,
оси Blender): X — вдоль ул. Ленина на юго-восток, Y — поперёк к цирку (северо-восток), Z — вверх.
"""
import json
import math
from pathlib import Path

import numpy as np

from config import DATA_PROCESSED, ROOT
from . import landmarks as LM

BRIDGE_ID = "astrakhan_bridge"
# выемка (локальные X, Y моста, м): «ядро» — пол прохода; дальше — плавный выход к исходному рельефу
CORE_X = 12.0              # |X| <= CORE_X: узлы опускаются до пола (проходы X = ±4.2 ± 3.2 и простенки)
WALL_Y = 10.9              # плоскость фасадов (внешние кромки тротуаров ул. Ленина — 10.3, парапет 10.3…10.8)
APRON_Y = 20.0             # площадка перед порталами: |Y| <= APRON_Y — пол на уровне портала
BLEND = 10.0               # переход к исходному рельефу за ядром/площадкой, м (уклон до ~1:3)
FLOOR_SW, FLOOR_NE = 19.3, 18.6   # пол проходов у порталов (three.y = абс. − baseHeight): юго-запад / северо-восток
STATE = {}                 # carve: {"hm0", "hm1", "grid", "base"} — для walk_y и диагностики
HEIGHTS_OUT = DATA_PROCESSED / "lybed" / "astrakhan_heights.json"


# ------------------------------------------------------------------ система координат моста
def bridge_def():
    for lm in LM.load():
        if lm["id"] == BRIDGE_ID:
            return lm
    return None


def frame(lm):
    """(C, ux, uy): центр (мировые x, y пайплайна) и единичные оси X, Y модели (Blender) в мировых x, y.
    Локальная glTF-точка (x, z) -> мир по LM.local_to_world; Blender X = glTF x, Blender Y = −glTF z."""
    C = np.array(LM.local_to_world(lm, [(0.0, 0.0)])[0])
    ux = np.array(LM.local_to_world(lm, [(1.0, 0.0)])[0]) - C
    uy = np.array(LM.local_to_world(lm, [(0.0, -1.0)])[0]) - C
    return C, ux, uy


def to_local(lm, x, y):
    C, ux, uy = frame(lm)
    d = np.stack([np.asarray(x, float) - C[0], np.asarray(y, float) - C[1]], -1)
    return d @ ux, d @ uy


def to_world(lm, X, Y):
    C, ux, uy = frame(lm)
    X, Y = np.asarray(X, float), np.asarray(Y, float)
    return C[0] + X * ux[0] + Y * uy[0], C[1] + X * ux[1] + Y * uy[1]


def floor_at(Y):
    """Пол прохода (three.y) по локальному Y: линейно между порталами, снаружи — уровень портала."""
    t = np.clip((np.asarray(Y, float) + WALL_Y) / (2 * WALL_Y), 0, 1)
    return FLOOR_SW + (FLOOR_NE - FLOOR_SW) * t


def carve_target(X, Y, h0):
    """Высота после выемки (three.y) для узлов с локальными X, Y и исходной высотой h0; nan — узел не трогаем."""
    X, Y, h0 = np.asarray(X, float), np.asarray(Y, float), np.asarray(h0, float)
    ax, ay = np.abs(X), np.abs(Y)
    f = floor_at(Y)
    out = np.full(X.shape, np.nan)
    # внутри дамбы: только ядро (дальше дамба остаётся рельефом; плиты настила модели перекрывают переход)
    core = (ay <= WALL_Y) & (ax <= CORE_X)
    out[core] = f[core]
    # снаружи фасадов: площадка у порталов + плавный выход (только вниз)
    outside = ay > WALL_Y
    dx = np.maximum(ax - CORE_X, 0) / BLEND
    dy = np.maximum(ay - APRON_Y, 0) / BLEND
    k = np.clip(np.maximum(dx, dy), 0, 1)
    tgt = f + (h0 - f) * (k * k * (3 - 2 * k))
    sel = outside & (k < 1) & (tgt < h0)
    out[sel] = tgt[sel]
    return out


# ------------------------------------------------------------------ хук: heightmap игры
def carve_heightmap(hm, grid, base, log=print):
    """hm — heightmap (rows×cols, three.y). Возвращает копию с выемкой под мостом; пайплайн дальше работает с H без неё.
    Заодно пишет высоты дамбы (до выемки) для сборки модели: data/processed/lybed/astrakhan_heights.json."""
    lm = bridge_def()
    STATE.clear()
    if lm is None:
        return hm
    xs, ys = grid.node_xy()
    C, _, _ = frame(lm)
    c0 = max(0, int((C[0] - 60 - grid.min_x) / grid.cell)); c1 = min(grid.cols, int((C[0] + 60 - grid.min_x) / grid.cell) + 1)
    r0 = max(0, int((grid.max_y - (C[1] + 60)) / grid.cell)); r1 = min(grid.rows, int((grid.max_y - (C[1] - 60)) / grid.cell) + 1)
    X, Y = np.meshgrid(xs[c0:c1], ys[r0:r1])
    LX, LY = to_local(lm, X, Y)
    sub = hm[r0:r1, c0:c1].astype(np.float64)
    tgt = carve_target(LX, LY, sub)
    ok = np.isfinite(tgt)
    out = hm.copy()
    blk = out[r0:r1, c0:c1]
    blk[ok] = tgt[ok].astype(hm.dtype)
    STATE.update(hm0=hm, hm1=out, grid=grid, base=base)
    _export_heights(lm, grid, hm)
    log(f"лыбедский: выемка под Астраханским мостом — узлов {int(ok.sum())}, max глубина {float(np.max(sub[ok] - tgt[ok])):.1f} м")
    return out


def _export_heights(lm, grid, hm):
    """Поверхность дамбы (до выемки) в локальной сетке моста: для плит-коллайдеров и парапета модели."""
    gx = np.arange(-60.0, 66.0, 2.0)
    gy = np.arange(-12.0, 12.1, 1.0)
    X, Y = np.meshgrid(gx, gy)
    wx, wy = to_world(lm, X, Y)
    z = grid.sample(hm, wx, wy)
    HEIGHTS_OUT.parent.mkdir(parents=True, exist_ok=True)
    HEIGHTS_OUT.write_text(json.dumps({"_doc": "three.y дамбы (heightmap до выемки) в локальной сетке моста: z[iy][ix], "
                                               "дорога = z + 0.05, тротуар = z + 0.15", "x": gx.tolist(), "y": gy.tolist(),
                                       "z": np.round(z, 3).tolist(), "floor_sw": FLOOR_SW, "floor_ne": FLOOR_NE,
                                       "wall_y": WALL_Y, "core_x": CORE_X, "apron_y": APRON_Y}, ensure_ascii=False))


def carved_height(x, y):
    """three.y heightmap игры (с выемкой) в мировых x, y; None — выемки нет."""
    if not STATE:
        return None
    return STATE["grid"].sample(STATE["hm1"], np.asarray(x, float), np.asarray(y, float))


# ------------------------------------------------------------------ хук: пешеходный граф
def walk_lines():
    """Оси двух проходов под мостом (мировые x, y) — продолжают аллею сквозь дамбу."""
    lm = bridge_def()
    if lm is None:
        return []
    out = []
    for X in (-4.2, 4.2):
        Y = np.arange(-WALL_Y - 9.0, WALL_Y + 9.01, 2.0)
        wx, wy = to_world(lm, np.full_like(Y, X), Y)
        out.append(np.c_[wx, wy])
    return out


def walk_append(XY, Y, E, kind, st=None, link_r=10.0):
    """Хук walk_export.compute (после высот узлов): высоты у порталов по выемке + рёбра двух проходов под мостом.
    Проходы добавляются отдельно от общей нарезки линий: в плане они пересекают тротуары ул. Ленина, но связаны с
    графом только концами (на площадках перед порталами)."""
    lines = walk_lines()
    if not lines or not STATE:
        return XY, Y, E
    Y = walk_y(XY, Y)
    lm = bridge_def()
    LX, LY_ = to_local(lm, XY[:, 0], XY[:, 1])
    outside = (np.abs(LY_) > WALL_Y + 0.5) & ~((np.abs(LX) <= CORE_X + 2) & (np.abs(LY_) <= WALL_Y + 1.5))
    from scipy.spatial import cKDTree
    cand = np.nonzero(outside)[0]
    kd = cKDTree(XY[cand]) if len(cand) else None
    XY_new, Y_new, E = list(XY), list(Y), dict(E)
    n0 = len(XY)
    added_e = 0
    for P in lines:
        hz = carved_height(P[:, 0], P[:, 1]) + 0.03
        ids = []
        for p, h in zip(P, hz):
            ids.append(len(XY_new)); XY_new.append(p); Y_new.append(h)
        for a, b in zip(ids[:-1], ids[1:]):
            E[(a, b)] = (kind, -1); added_e += 1
        for end in (ids[0], ids[-1]):
            if kd is None:
                continue
            d, j = kd.query(XY_new[end], k=1, distance_upper_bound=link_r)
            if np.isfinite(d):
                k = int(cand[j])
                if d > 7.5:      # ребро не длиннее 8 м
                    mid = len(XY_new); XY_new.append((XY_new[end] + XY[k]) / 2); Y_new.append((Y_new[end] + Y[k]) / 2)
                    E[(min(end, mid), max(end, mid))] = (kind, -1); E[(min(mid, k), max(mid, k))] = (kind, -1); added_e += 2
                else:
                    E[(min(end, k), max(end, k))] = (kind, -1); added_e += 1
    XY = np.asarray(XY_new, float); Y = np.asarray(Y_new, float)
    if st is not None:
        st["lybed_tunnel_nodes"] = len(XY) - n0; st["lybed_tunnel_edges"] = added_e
        st["nodes"] = len(XY); st["edges"] = len(E)
    return XY, Y, E


def walk_y(XY, Y, lift=0.03):
    """Высоты узлов графа в зоне выемки — по heightmap игры (пол прохода), а не по дамбе."""
    if not STATE:
        return Y
    lm = bridge_def()
    LX, LY = to_local(lm, XY[:, 0], XY[:, 1])
    zone = (np.abs(LX) <= CORE_X + BLEND) & (np.abs(LY) > WALL_Y - 0.01) & (np.abs(LY) <= APRON_Y + BLEND)
    tun = (np.abs(np.abs(LX) - 4.2) <= 3.0) & (np.abs(LY) <= WALL_Y + 0.01)
    sel = zone | tun
    if not sel.any():
        return Y
    Y = Y.copy()
    hc = carved_height(XY[sel, 0], XY[sel, 1])
    h0 = STATE["grid"].sample(STATE["hm0"], XY[sel, 0], XY[sel, 1])
    Y[sel] = np.where(hc < h0 - 0.05, hc + lift, Y[sel])
    return Y


# ------------------------------------------------------------------ хук: обстановка (после LM.clear_props)
# Зоны бульвара (мировые x, y; по ортофото 0.25 м и OSM): центральная часть — от Астраханского моста до Брессюирского
# (ул. Горького), нижняя — от Брессюирского до стадиона «Спартак» (спортзона 2023 г.: скейтпарк и памп-трек).
ZONES = {
    "central": [(-470, -780), (-440, -790), (-440, -850), (-445, -960), (-470, -1005), (-505, -1035), (-540, -1060),
                (-560, -1050), (-560, -1020), (-545, -1005), (-540, -950), (-545, -880), (-530, -850), (-490, -800)],
    "lower": [(-560, -1060), (-600, -1075), (-640, -1120), (-665, -1190), (-640, -1240), (-600, -1290), (-575, -1390),
              (-535, -1395), (-535, -1300), (-550, -1200), (-560, -1120), (-545, -1080)],
}
# Фонари аллеи (панорамы 2026-03, crops/alley): центральная часть — тонкие серо-голубые опоры ~4.2 м с цилиндрическим
# плафоном (009–039); нижняя — опоры ~5 м с двумя дисковыми светильниками на разной высоте (042, 078–102).
LAMP_STYLE = {"central": "slim", "lower": "disc2"}
LAMP_STEP = 22.0           # шаг вдоль дорожки, стороны чередуются (панорамы: фонарь через ~20–25 м, то слева, то справа)
LAMP_MIN = 10.0
# Каркасная ёлка на круглой площади у гостиницы «Старый город» (OSM n5129539522 «Ёлка»): центр — триангуляция по
# панорамам 2024-06 (1310811760…, 1310809262…, 1310810581…; невязка ~1 м), высота каркаса ~21.5 м (+шпиль),
# основание — кольцо из 12 арок Ø ~10.4 м, высота арок ~3 м. Стоит круглый год (панорамы 2020-08 и 2024-06 — летом);
# гирлянды и звезда — только зимой (рисует игра по weatherUniforms.season).
XMAS_TREE = dict(x=-526.5, y=-998.6, height=21.5, radius=5.2, arches=12, archH=3.0, rings=11, spire=1.2)
# круглая площадь под ёлкой (ортофото: центр (−522.5, −1000.8), R ~19 м по внешнему красному кольцу; панорамы 2020/2024:
# бежевый бетон с жёлтыми радиальными линиями, красное кольцо по краю) — рисует игра вместе с ёлкой
XMAS_PLAZA = (-522.5, -1000.8, 19.0)
# Скейтпарк (OSM w1424802275 leisure=pitch sport=skateboard;bmx): ограда — чёрная решётка 1.8 м по западной кромке
# (панорамы 2026-03, crops/skatepark 05, 12).
SKATE_FENCE = [(-637.6, -1212.3), (-657.1, -1187.1), (-618.3, -1133.5)]
REPLACE = {"park_lamp"}    # процедурные фонари зоны заменяются фонарями бульвара


def _zone_polys():
    from shapely.geometry import Polygon
    return {k: Polygon(v) for k, v in ZONES.items()}


def furnish(yctx, sl=None, log=print):
    import shapely
    from shapely.geometry import LineString, Point
    from .yards import rot_of
    st = {"lamps": 0, "removed": 0, "xmas_tree": 0, "fence": 0}
    zones = _zone_polys()
    allz = shapely.union_all(list(zones.values()))
    shapely.prepare(allz)
    tx, ty = XMAS_TREE["x"], XMAS_TREE["y"]
    clear_r = XMAS_TREE["radius"] + 1.8
    # 1. убрать процедурные фонари зоны и всё, что стоит в основании ёлки
    for k, lst in yctx.tiles_props.items():
        keep = []
        for r in lst:
            x, y = r["x"], -r["z"]
            if (r["type"] in REPLACE and shapely.contains_xy(allz, x, y)) or math.hypot(x - tx, y - ty) < clear_r:
                st["removed"] += 1
                continue
            keep.append(r)
        lst[:] = keep
    # 2. ёлка
    px, py, pr = XMAS_PLAZA
    yctx.add("lybed_xmas_tree", tx, ty, 0.0, 1.0, **{k: v for k, v in XMAS_TREE.items() if k not in ("x", "y")},
             plaza=[px, round(float(yctx.ground(np.array([px]), np.array([py]))[0]), 2), -py, pr])
    st["xmas_tree"] = 1
    # 3. фонари вдоль дорожек OSM в зонах
    osm = yctx.osm
    have = [(r["x"], -r["z"]) for lst in yctx.tiles_props.values() for r in lst
            if r["type"] in ("street_lamp", "street_lamp_double", "lamp_classic", "lybed_lamp")]
    placed = []
    for wid in sorted(osm.ways):
        refs, tg = osm.ways[wid]
        if tg.get("highway") not in ("footway", "path", "pedestrian", "cycleway") or tg.get("area") == "yes" \
                or tg.get("footway") in ("sidewalk", "crossing") or tg.get("tunnel", "no") != "no" or tg.get("bridge", "no") != "no":
            continue
        xy = osm.way_xy(wid)
        if len(xy) < 2:
            continue
        line = LineString(xy)
        for zk, zp in zones.items():
            part = line.intersection(zp)
            for g in getattr(part, "geoms", [part]):
                if g.is_empty or g.geom_type != "LineString" or g.length < 25:
                    continue
                n = int((g.length - 8) // LAMP_STEP) + 1
                for i in range(n):
                    d = 8 + i * LAMP_STEP + (g.length - 16 - (n - 1) * LAMP_STEP) / 2
                    p = np.array(g.interpolate(d).coords[0]); q = np.array(g.interpolate(min(d + 1, g.length)).coords[0])
                    t = q - p; t /= (np.linalg.norm(t) or 1)
                    nrm = np.array([-t[1], t[0]]) * (1 if (i + wid) % 2 == 0 else -1)
                    half = float(tg.get("width", 3.0) if str(tg.get("width", "")).replace(".", "").isdigit() else 3.0) / 2
                    c = p + nrm * (half + 0.6)
                    if math.hypot(c[0] - tx, c[1] - ty) < clear_r + 2:
                        continue
                    if any(math.hypot(c[0] - a, c[1] - b) < LAMP_MIN for a, b in have + placed):
                        continue
                    yctx.add("lybed_lamp", c[0], c[1], float(rot_of(*-nrm)), 1.0, variant=LAMP_STYLE[zk])
                    placed.append((float(c[0]), float(c[1])))
                    st["lamps"] += 1
    # 4. на Астраханском мосту пешеходных ограждений у бордюра нет (панорамы 2024-06 / 2026-03) — убрать типовые
    lm = bridge_def()
    if lm is not None:
        for k, lst in yctx.tiles_segs.items():
            keep = []
            for r in lst:
                if r["type"] in ("ped_fence", "guardrail"):
                    LX, LY_ = to_local(lm, (r["x1"] + r["x2"]) / 2, -(r["z1"] + r["z2"]) / 2)
                    if abs(float(LX)) < 62 and abs(float(LY_)) < WALL_Y + 1:
                        st["bridge_fences_removed"] = st.get("bridge_fences_removed", 0) + 1
                        continue
                keep.append(r)
            lst[:] = keep
    # 5. ограда скейтпарка
    for a, b in zip(SKATE_FENCE[:-1], SKATE_FENCE[1:]):
        a, b = np.array(a, float), np.array(b, float)
        L = float(np.linalg.norm(b - a)); k = max(1, int(math.ceil(L / 4.0)))
        for i in range(k):
            yctx.add_seg("fence", a + (b - a) * i / k, a + (b - a) * (i + 1) / k, 1.8, style="metal")
            st["fence"] += 1
    return st
