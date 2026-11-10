"""Рельеф: FABDEM -> сетка мира, сглаживание, вода, «вжатие» дорог, мосты."""
import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from scipy.ndimage import distance_transform_edt, gaussian_filter
from scipy.spatial import cKDTree

from config import WORLD_CRS


def load_dem(path, grid, smooth_m=17.5, resampling=Resampling.cubic):
    """FABDEM -> узлы сетки (бикубика), гаусс smooth_m (сигма, м)."""
    dst = np.full((grid.rows, grid.cols), np.nan, np.float32)
    t = from_origin(grid.min_x - grid.cell / 2, grid.max_y + grid.cell / 2, grid.cell, grid.cell)
    with rasterio.open(path) as s:
        a = s.read(1).astype(np.float32)
        if s.nodata is not None:
            a[a == s.nodata] = np.nan
        reproject(a, dst, src_transform=s.transform, src_crs=s.crs, dst_transform=t, dst_crs=WORLD_CRS,
                  resampling=resampling, src_nodata=np.nan, dst_nodata=np.nan)
    if np.isnan(dst).any():
        # края без данных: ближайшее значение
        m = np.isnan(dst)
        _, (ri, ci) = distance_transform_edt(m, return_indices=True)
        dst = dst[ri, ci]
    h = dst.astype(np.float64)
    if smooth_m > 0:
        h = gaussian_filter(h, smooth_m / grid.cell, mode="nearest")
    return h, t


def raster_mask(geoms_values, grid, transform, fill=0, dtype="int32"):
    return rasterize(geoms_values, out_shape=(grid.rows, grid.cols), transform=transform, fill=fill, dtype=dtype,
                     all_touched=False)


def carve_water(h, water, grid, transform, depth=1.5, bank_slope=0.4, bank_m=30.0):
    """water: [(polygon, level)]. Внутри полигона дно level-depth, берег ограничен уклоном bank_slope на bank_m."""
    if not water:
        return h, np.zeros_like(h, dtype=bool)
    ids = raster_mask(((p, i + 1) for i, (p, _) in enumerate(water)), grid, transform)
    levels = np.array([0.0] + [lv for _, lv in water])
    inside = ids > 0
    out = h.copy()
    out[inside] = np.minimum(h[inside], levels[ids[inside]] - depth)
    dist, (ri, ci) = distance_transform_edt(~inside, sampling=grid.cell, return_indices=True)
    near = (~inside) & (dist < bank_m)
    lv = levels[ids[ri, ci]][near]
    out[near] = np.minimum(out[near], lv + 0.3 + dist[near] * bank_slope)
    return out, inside


def _smoothstep(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def condition_roads(h, grid, transform, samples, junction_polys, shoulder=8.0, flat_margin=1.0):
    """«Вжатие» дорог в рельеф.
    samples: массив (N, 4) [x, y, z, halfwidth] — точки осей дорог (не мостов) с высотой профиля.
    junction_polys: [(polygon, z)] — площадки перекрёстков с их высотой.
    Вес 1 внутри (полуширина + flat_margin), затем smoothstep до 0 на + shoulder."""
    rows, cols = grid.rows, grid.cols
    xs, ys = grid.node_xy()
    W = np.zeros((rows, cols)); T = np.zeros((rows, cols))
    # перекрёстки
    if junction_polys:
        ids = raster_mask(((p, i + 1) for i, (p, _) in enumerate(junction_polys)), grid, transform)
        jz = np.array([0.0] + [z for _, z in junction_polys])
        inside = ids > 0
        dist, (ri, ci) = distance_transform_edt(~inside, sampling=grid.cell, return_indices=True)
        wj = 1.0 - _smoothstep((dist - flat_margin) / shoulder)
        wj[inside] = 1.0
        W = wj; T = jz[ids[ri, ci]]
    # оси дорог
    max_hw = samples[:, 3].max()
    R = max_hw + flat_margin + shoulder
    tree = cKDTree(samples[:, :2])
    # только узлы рядом с дорогами
    gx, gy = np.meshgrid(xs, ys)
    pts = np.c_[gx.ravel(), gy.ravel()]
    k = 8
    d, idx = tree.query(pts, k=k, distance_upper_bound=R, workers=-1)
    valid = np.isfinite(d)
    idx_c = np.where(valid, idx, 0)
    hw = samples[idx_c, 3]
    w = 1.0 - _smoothstep((d - hw - flat_margin) / shoulder)
    w[(d <= hw + flat_margin)] = 1.0
    w[~valid] = 0.0
    # при равных весах — ближайшая ось: штраф за расстояние минимальный
    score = w - 1e-4 * np.where(valid, d, 1e9)
    best = np.argmax(score, axis=1)
    rr = np.arange(len(pts))
    wr = w[rr, best].reshape(rows, cols)
    tr = samples[idx_c[rr, best], 2].reshape(rows, cols)
    use_road = wr > W
    W = np.where(use_road, wr, W); T = np.where(use_road, tr, T)
    out = h * (1 - W) + T * W
    return out, W


def clamp_under_bridges(h, grid, deck_samples, keep=None):
    """deck_samples: (N,5) [x,y,zdeck,halfwidth,clearance]: под настилом рельеф не выше zdeck - clearance."""
    if len(deck_samples) == 0:
        return h
    xs, ys = grid.node_xy()
    gx, gy = np.meshgrid(xs, ys)
    pts = np.c_[gx.ravel(), gy.ravel()]
    tree = cKDTree(deck_samples[:, :2])
    R = deck_samples[:, 3].max() + 2.0
    d, i = tree.query(pts, k=1, distance_upper_bound=R, workers=-1)
    ok = np.isfinite(d)
    ok[ok] = d[ok] <= deck_samples[i[ok], 3] + 2.0
    if keep is not None:
        ok &= ~keep.ravel()   # наземные дороги под мостом не трогаем
    out = h.ravel().copy()
    lim = deck_samples[i[ok], 2] - deck_samples[i[ok], 4]
    out[ok] = np.minimum(out[ok], lim)
    return out.reshape(h.shape)
