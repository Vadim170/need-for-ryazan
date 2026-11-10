"""Деревья и заросли по карте покрова (docs/stage3/landcover.md): хуки в world/props.py.

Вход (строит build_landcover.py; нет файлов — хуки ничего не делают):
  data/processed/landcover/lc_1m.tif          — классы 1 м (та же сетка, что растр масок yards.Ctx.M)
  data/processed/landcover/canopy_trees.npz   — вершины крон
  data/processed/landcover/thicket_pts.npz    — точки клумп зарослей

- allow(): процедурное дерево остаётся, только если в радиусе 2 м спутник видит кроны (или заросли), либо класс
  неизвестен; на газоне/лугу/огороде/грунте/асфальте его нет.
- add_canopy_trees(): деревья в вершинах крон, где своих деревьев нет (дворы, овраги, обочины); порода — по классу
  (хвойные → сосна) и виду кроны (светлая мелкая → берёза, высокая тень → тополь, иначе клён/липа/берёза).
- thickets(): клумпы зарослей (`thicket`: многоствольный клён ясенелистный, 3–8 м) по точкам класса thicket + отдельные
  `tree_negundo` по краям массивов.
"""
import math

import numpy as np
import rasterio

from config import DATA_PROCESSED
from landcover.classes import C

LC = DATA_PROCESSED / "landcover"
CANOPY = (C["canopy"], C["conifer"], C["thicket"])


class LandcoverVeg:
    def __init__(self, ctx):
        self.ctx = ctx
        with rasterio.open(LC / "lc_1m.tif") as r:
            self.L = r.read(1)
            t = r.transform
        assert abs(t.c - ctx.min_x) < 1e-6 and abs(t.f - ctx.max_y) < 1e-6 and self.L.shape == ctx.M.shape, "сетка покрова ≠ сетка масок"
        self.tree_lut = np.zeros(256, bool)
        self.tree_lut[list(CANOPY)] = True
        self.tree_lut[0] = True

    def cls(self, x, y):
        r, c = self.ctx.rc(x, y)
        ok = (r >= 0) & (r < self.L.shape[0]) & (c >= 0) & (c < self.L.shape[1])
        out = np.zeros(np.shape(r), np.uint8)
        out[ok] = self.L[r[ok], c[ok]]
        return out

    def allow(self, xy, radius=2.0):
        """Можно ли дерево в точках (N, 2): кроны/заросли/нет данных в центре или на окружности radius."""
        if len(xy) == 0:
            return np.zeros(0, bool)
        x, y = xy[:, 0], xy[:, 1]
        ok = self.tree_lut[self.cls(x, y)]
        for a in np.arange(8) * (math.pi / 4):
            ok |= self.tree_lut[self.cls(x + radius * math.cos(a), y + radius * math.sin(a))]
        return ok

    # ------------------------------------------------------------------ кроны → деревья
    def add_canopy_trees(self, T, forbid):
        ctx = self.ctx
        z = np.load(LC / "canopy_trees.npz")
        x, y, r, conif, lum, tall = z["x"], z["y"], z["r"], z["conif"], z["lum"], z["tall"]
        xy = np.c_[x, y]
        ok = ctx.inside(x, y, 3) & ctx.free(x, y, forbid, 1.0)
        # уже есть дерево ближе ~0.9 радиуса кроны — не добавляем
        if len(T.xy):
            from scipy.spatial import cKDTree
            d, _ = cKDTree(T.xy).query(xy, distance_upper_bound=8.0)
            ok &= d >= np.maximum(3.0, 0.9 * r)
        idx = np.nonzero(ok)[0]
        rng = ctx.rng(901, 0)
        types, scales = [], []
        for i in idx:
            u = rng.random()
            if conif[i]:
                t = "tree_pine"
            elif tall[i] > 0.45 and r[i] > 3.0 and u < 0.7:
                t = "tree_poplar"
            elif lum[i] > 0.36 and r[i] < 3.6 and u < 0.65:
                t = "tree_birch"
            else:
                t = "tree_maple" if u < 0.4 else "tree_lime" if u < 0.75 else "tree_birch"
            nominal = {"tree_pine": 3.0, "tree_poplar": 2.8, "tree_birch": 3.0, "tree_maple": 4.0, "tree_lime": 4.0}[t]
            types.append(t)
            scales.append(float(np.clip(r[i] / nominal, 0.6, 1.3)))
        if len(idx):
            # не ближе 3.5 м друг к другу среди добавляемых (жадно, от больших)
            from scipy.spatial import cKDTree
            P = xy[idx]
            order = np.argsort(-r[idx])
            kd = cKDTree(P)
            keep = np.ones(len(idx), bool)
            for j in order:
                if keep[j]:
                    for q in kd.query_ball_point(P[j], 3.5):
                        if q != j:
                            keep[q] = False if r[idx][q] <= r[idx][j] else keep[q]
            sel = np.nonzero(keep)[0]
            T.add(P[sel], [types[j] for j in sel], np.array(scales)[sel], rng.uniform(-math.pi, math.pi, len(sel)), "canopy")
            for j in sel:
                ctx.stamp(P[j, 0], P[j, 1], 1.0)
            return len(sel)
        return 0

    # ------------------------------------------------------------------ заросли
    def thickets(self, T, forbid, bld_bit):
        """Клумпы `thicket` (поля: radius — радиус клумпы, м; height — высота, м; seed) и редкие `tree_negundo`."""
        ctx = self.ctx
        z = np.load(LC / "thicket_pts.npz")
        x, y, thick = z["x"], z["y"], z["thick"]
        ok = ctx.inside(x, y, 3) & ctx.free(x, y, forbid, 0.9) & ctx.free(x, y, bld_bit, 2.2)
        # не наползать на пути/щебень/асфальт/воду по карте покрова (ж/д балласт в масках дворов не размечен)
        hard = np.zeros(256, bool)
        hard[[C["gravel"], C["paved"], C["water"], C["building"]]] = True
        for a in np.arange(8) * (math.pi / 4):
            ok &= ~hard[self.cls(x + 2.0 * math.cos(a), y + 2.0 * math.sin(a))]
        # бюджет: в лесах/парках OSM подлесок в основном дают деревья — клумпы по краю (≤ 12 м от не-леса) и редко внутри;
        # вдали от застройки (вне URBAN) — каждая вторая клумпа, крупнее
        from .yards import PARK, URBAN, WOOD
        m = ctx.m(x, y)
        inwood = (m & (WOOD | PARK)) != 0
        edge = np.zeros(len(x), bool)
        for a in np.arange(8) * (math.pi / 4):
            edge |= (ctx.m(x + 12 * math.cos(a), y + 12 * math.sin(a)) & (WOOD | PARK)) == 0
        rng0 = ctx.rng(903, 0)
        far = (m & URBAN) == 0
        # в глубине леса/парка — каждая третья клумпа (подлесок/молодняк по оврагам; остальное дают деревья)
        ok &= ~inwood | edge | (rng0.random(len(x)) < 0.35)
        ok &= ~far | (rng0.random(len(x)) < 0.5)
        if len(T.xy):
            from scipy.spatial import cKDTree
            d, _ = cKDTree(T.xy).query(np.c_[x, y], distance_upper_bound=4.0)
            ok &= d >= 1.8
        idx = np.nonzero(ok)[0]
        rng = ctx.rng(902, 0)
        n_cl = n_tr = 0
        for i in idx:
            xi, yi, th = float(x[i]), float(y[i]), float(thick[i])
            # край массива (тонкий) — ниже и реже; глубина массива — выше и гуще
            h = float(np.clip(3.8 + th * 0.5 + rng.normal(0, 0.8), 3.2, 8.0))
            rad = float(np.clip(1.9 + 0.12 * th + rng.uniform(0, 0.7), 1.9, 2.9))
            if th < 2.0 and rng.random() < 0.12:
                ctx.add("tree_negundo", xi, yi, rng.uniform(-math.pi, math.pi), round(float(rng.uniform(0.75, 1.15)), 2))
                n_tr += 1
            else:
                ctx.add("thicket", xi, yi, rng.uniform(-math.pi, math.pi), 1.0, radius=round(rad, 2), height=round(h, 2),
                        seed=int(rng.integers(0, 65536)))
                n_cl += 1
            ctx.stamp(xi, yi, 1.2)
        return n_cl, n_tr


def load(ctx):
    """LandcoverVeg или None (нет карты покрова — пайплайн работает как раньше)."""
    if not (LC / "lc_1m.tif").exists():
        return None
    try:
        return LandcoverVeg(ctx)
    except AssertionError as e:
        print("landcover:", e)
        return None
