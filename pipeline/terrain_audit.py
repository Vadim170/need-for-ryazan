"""Сравнение DEM-источников для bbox: статистика, hillshade, профили.
Запуск: cd pipeline && uv run python terrain_audit.py  (после fetch_dem.py)
Выход: data/processed/terrain/*.png, stats.json, *.tif (общая сетка 10 м в WORLD_CRS)
"""
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import rasterio
from rasterio.warp import Resampling, reproject
from rasterio.transform import from_origin
from scipy.ndimage import map_coordinates

from config import BBOX, DATA_RAW, DATA_PROCESSED, ORIGIN_LAT, ORIGIN_LON, WORLD_CRS, to_world, to_wgs84

OUT = DATA_PROCESSED / "terrain"
OUT.mkdir(parents=True, exist_ok=True)
SRC = {
    "cop30": DATA_RAW / "dem/cop30/cop30_crop.tif",
    "fabdem": DATA_RAW / "dem/fabdem/fabdem_crop.tif",
    "alos": DATA_RAW / "dem/alos/alos_crop.tif",
    "nasadem": DATA_RAW / "dem/nasadem/nasadem_crop.tif",
    "terrarium": DATA_RAW / "dem/terrarium/terrarium_z15.tif",
}
LABEL = {"cop30": "Copernicus GLO-30 (DSM)", "fabdem": "FABDEM v1.2 (DTM)", "alos": "ALOS AW3D30 (DSM)",
         "nasadem": "NASADEM (SRTM, DSM)", "terrarium": "AWS Terrarium z15 (mixed)"}
RES = 10.0

# общая сетка: bbox в мировой СК, шаг 10 м
S, W, N, E = BBOX
xs, ys = to_world.transform([W, E, W, E], [S, S, N, N])
x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
nx, ny = int((x1 - x0) / RES), int((y1 - y0) / RES)
GRID_T = from_origin(x0, y1, RES, RES)


def to_grid(path, method=Resampling.bilinear):
    with rasterio.open(path) as s:
        a = s.read(1).astype("float32")
        nod = s.nodata
        if nod is not None:
            a[a == nod] = np.nan
        dst = np.full((ny, nx), np.nan, "float32")
        reproject(a, dst, src_transform=s.transform, src_crs=s.crs, dst_transform=GRID_T,
                  dst_crs=WORLD_CRS, resampling=method, src_nodata=np.nan, dst_nodata=np.nan)
    return dst


def hillshade(z, res=RES, az=315, alt=40, exag=2.0):
    dzdy, dzdx = np.gradient(z * exag, res)  # y вниз по строкам
    slope = np.arctan(np.hypot(dzdx, dzdy))
    aspect = np.arctan2(-dzdx, dzdy)
    azr, altr = np.radians(360 - az + 90), np.radians(alt)
    return np.clip(np.sin(altr) * np.cos(slope) + np.cos(altr) * np.sin(slope) * np.cos(azr - aspect), 0, 1)


class Sampler:
    """Билинейная выборка из исходной (родной) сетки источника в точках (lon,lat)."""
    def __init__(self, path):
        self.s = rasterio.open(path)
        self.a = self.s.read(1).astype("float32")
        if self.s.nodata is not None:
            self.a[self.a == self.s.nodata] = np.nan
        self.t = self.s.transform
        self.crs = self.s.crs

    def __call__(self, lon, lat):
        from pyproj import Transformer
        x, y = Transformer.from_crs("EPSG:4326", self.crs, always_xy=True).transform(lon, lat)
        col = (np.asarray(x) - self.t.c) / self.t.a - 0.5
        row = (np.asarray(y) - self.t.f) / self.t.e - 0.5
        return map_coordinates(self.a, [row, col], order=1, mode="nearest")


def profile_line(pts, step=5.0):
    """pts: список (lat,lon); возвращает расстояние, lon, lat."""
    w = np.array([to_world.transform(lo, la) for la, lo in pts])
    seg = np.hypot(*np.diff(w, axis=0).T)
    cum = np.r_[0, np.cumsum(seg)]
    d = np.arange(0, cum[-1], step)
    x = np.interp(d, cum, w[:, 0]); y = np.interp(d, cum, w[:, 1])
    lon, lat = to_wgs84.transform(x, y)
    return d, lon, lat, cum


def main():
    grids = {k: to_grid(p) for k, p in SRC.items()}
    stats = {"grid": {"nx": nx, "ny": ny, "res_m": RES}, "per_source": {}, "diff_vs_fabdem": {}, "pairs": {}}
    for k, g in grids.items():
        if k == "terrarium":
            g[g < 50] = np.nan  # единичные битые пиксели в тайлах Terrarium (до -2000 м)
        stats["per_source"][k] = {"min": float(np.nanmin(g)), "max": float(np.nanmax(g)), "mean": float(np.nanmean(g)),
                                  "p1": float(np.nanpercentile(g, 1)), "p99": float(np.nanpercentile(g, 99)),
                                  "nan_frac": float(np.isnan(g).mean())}
        with rasterio.open(OUT / f"{k}_grid10m.tif", "w", driver="GTiff", height=ny, width=nx, count=1, dtype="float32",
                           crs=WORLD_CRS, transform=GRID_T, compress="deflate", nodata=np.nan) as d:
            d.write(g, 1)

    def dstats(a, b):
        d = (a - b)[~np.isnan(a - b)]
        n_out = int((np.abs(d) > 40).sum())  # битые пиксели (выбросы > 40 м) исключаем и считаем отдельно
        d = d[np.abs(d) <= 40]
        return {"n_outliers_gt40m": n_out, "mean": float(d.mean()), "std": float(d.std()), "rmse": float(np.sqrt((d ** 2).mean())),
                "p5": float(np.percentile(d, 5)), "p50": float(np.percentile(d, 50)), "p95": float(np.percentile(d, 95)),
                "max": float(d.max()), "min": float(d.min())}
    names = list(grids)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            stats["pairs"][f"{a}-{b}"] = dstats(grids[a], grids[b])
    # высокочастотная часть (убираем систематический сдвиг и крупную долю) — сравнение на пиксель
    # hillshades
    fig_all, axs = plt.subplots(2, 3, figsize=(18, 11))
    ext = (0, nx * RES, 0, ny * RES)
    for ax, (k, g) in zip(axs.ravel(), grids.items()):
        hs = hillshade(np.nan_to_num(g, nan=np.nanmean(g)))
        ax.imshow(hs, cmap="gray", extent=ext, vmin=0, vmax=1)
        ax.set_title(LABEL[k]); ax.axis("off")
        plt.imsave(OUT / f"hillshade_{k}.png", hs, cmap="gray", vmin=0, vmax=1)
    # разность DSM - DTM
    d = grids["cop30"] - grids["fabdem"]
    im = axs.ravel()[5].imshow(d, cmap="RdBu_r", vmin=-15, vmax=15, extent=ext)
    axs.ravel()[5].set_title("cop30 - fabdem, м (здания/деревья)"); plt.colorbar(im, ax=axs.ravel()[5], fraction=0.04)
    fig_all.tight_layout(); fig_all.savefig(OUT / "hillshade_all.png", dpi=80); plt.close(fig_all)
    fig, ax = plt.subplots(figsize=(9, 8))
    im = ax.imshow(grids["fabdem"], cmap="terrain", extent=ext)
    ax.contour(np.flipud(grids["fabdem"]), levels=np.arange(80, 200, 5), colors="k", linewidths=0.4, extent=ext)
    plt.colorbar(im, label="м"); ax.set_title("FABDEM, изолинии 5 м")
    fig.savefig(OUT / "fabdem_elevation.png", dpi=90); plt.close(fig)

    # профили
    samplers = {k: Sampler(p) for k, p in SRC.items()}
    lines = {
        "a_kremlin_trubezh": ("(a) Соборная пл. -> Кремль -> Трубеж", [(54.6328, 39.7440), (54.6363, 39.7496), (54.6375, 39.7560)]),
        "b_lybed_valley": ("(b) Лыбедский бульвар, поперечник В-З через долину Лыбеди", [(54.6281, 39.7340), (54.6281, 39.7424), (54.6281, 39.7520)]),
        "c_pervomaysky": ("(c) Первомайский пр.: пл. Победы -> Соборная", [(54.6293, 39.7116), (54.6328, 39.7440)]),
        "d_solotcha": ("(d) Солотчинское шоссе: Круиз -> ДПС -> СВ", [(54.6330, 39.7732), (54.6378, 39.7814), (54.6507, 39.7986)]),
    }
    stats["profiles"] = {}
    for key, (title, pts) in lines.items():
        d, lon, lat, cum = profile_line(pts)
        fig, ax = plt.subplots(figsize=(11, 4.5))
        st = {}
        for k, s in samplers.items():
            z = s(lon, lat)
            ax.plot(d, z, label=LABEL[k], lw=2 if k == "fabdem" else 1.1)
            st[k] = {"min": float(z.min()), "max": float(z.max()), "range": float(z.max() - z.min()),
                     "start": float(z[0]), "end": float(z[-1])}
        for c in cum[1:-1]:
            ax.axvline(c, color="gray", ls=":", lw=0.8)
        ax.set_xlabel("м вдоль линии"); ax.set_ylabel("высота, м"); ax.set_title(title + f"  (длина {cum[-1]:.0f} м)")
        ax.grid(alpha=0.3); ax.legend(fontsize=8); fig.tight_layout()
        fig.savefig(OUT / f"profile_{key}.png", dpi=90); plt.close(fig)
        zc, zf = samplers["cop30"](lon, lat), samplers["fabdem"](lon, lat)
        st["cop_minus_fab"] = {"mean": float(np.mean(zc - zf)), "max": float(np.max(zc - zf)), "min": float(np.min(zc - zf))}
        # макс. уклон FABDEM на 30 м базе
        zz = samplers["fabdem"](lon, lat)
        k6 = 6
        sl = (zz[k6:] - zz[:-k6]) / (d[k6:] - d[:-k6]) * 100
        st["fabdem_max_slope_pct_30m"] = float(np.max(np.abs(sl)))
        st["length_m"] = float(cum[-1])
        stats["profiles"][key] = st
    (OUT / "stats.json").write_text(json.dumps(stats, indent=1, ensure_ascii=False))
    print(json.dumps(stats, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
