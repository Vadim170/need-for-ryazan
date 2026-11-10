"""Мозаика спутниковых тайлов -> GeoTIFF/COG в WORLD_CRS (метры, начало — Кремль).

Запуск:  uv run python build_ortho.py [--sources yandex esri] [--skip-core]
Выход (data/processed/ortho):
  <src>_0.5m.tif   — z18, 0.5 м/px, весь bbox + 200 м
  <src>_2m.tif     — обзор 2 м/px
  yandex_core_0.25m.tif — z19, 0.25 м/px, ядро центра (только Яндекс: у Esri z19 — заглушки)
Цвета: RGB, JPEG-сжатие внутри COG; вне покрытия — чёрный (0,0,0).
"""
import argparse
import math
from pathlib import Path

import numpy as np
import rasterio
import rasterio.shutil
from PIL import Image
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import Affine, from_origin
from rasterio.warp import reproject
from pyproj import Transformer

from config import BBOX, DATA_PROCESSED, WORLD_CRS
from fetch_satellite import CORE_BBOX, H, MARGIN_M, SOURCES, grow, path, tile_range

OUT = DATA_PROCESSED / "ortho"
NATIVE_CRS = {"yandex": CRS.from_epsg(3395), "esri": CRS.from_epsg(3857)}
WORLD_PROJ = WORLD_CRS


def world_bounds(bbox, res):
    s, w, n, e = bbox
    tr = Transformer.from_crs(4326, WORLD_PROJ, always_xy=True)
    xs, ys = zip(*[tr.transform(lo, la) for lo, la in [(w, s), (e, s), (w, n), (e, n)]])
    x0 = math.floor(min(xs) / res) * res
    x1 = math.ceil(max(xs) / res) * res
    y0 = math.floor(min(ys) / res) * res
    y1 = math.ceil(max(ys) / res) * res
    return x0, y0, x1, y1


def mosaic_native(src, z, bbox, tmp):
    """Склеивает тайлы в GeoTIFF в нативной проекции источника (тайловая раскладка 256)."""
    xa, xb, ya, yb = tile_range(SOURCES[src]["tr"], bbox, z)
    n = 2 ** z
    px = 2 * H / n / 256
    prof = dict(driver="GTiff", width=(xb - xa + 1) * 256, height=(yb - ya + 1) * 256, count=3,
                dtype="uint8", crs=NATIVE_CRS[src], tiled=True, blockxsize=256, blockysize=256,
                compress="deflate", predictor=2, BIGTIFF="YES",
                transform=from_origin(-H + xa * 2 * H / n, H - ya * 2 * H / n, px, px))
    missing = 0
    with rasterio.open(tmp, "w", **prof) as dst:
        for x in range(xa, xb + 1):
            col = np.zeros(((yb - ya + 1) * 256, 256, 3), np.uint8)
            for y in range(ya, yb + 1):
                p = path(src, z, x, y)
                if not p.exists():
                    missing += 1
                    continue
                try:
                    col[(y - ya) * 256:(y - ya + 1) * 256] = np.asarray(Image.open(p).convert("RGB").resize((256, 256)))
                except Exception:
                    missing += 1
            dst.write(col.transpose(2, 0, 1), window=rasterio.windows.Window((x - xa) * 256, 0, 256, col.shape[0]))
    print(f"  мозаика {src} z{z}: {prof['width']}x{prof['height']}, отсутствует тайлов: {missing}")
    return tmp


def warp_to_world(src, native, res, bbox, out_cog):
    x0, y0, x1, y1 = world_bounds(bbox, res)
    w, h = round((x1 - x0) / res), round((y1 - y0) / res)
    tmp = out_cog.with_suffix(".warp.tif")
    prof = dict(driver="GTiff", width=w, height=h, count=3, dtype="uint8", crs=WORLD_PROJ,
                transform=Affine(res, 0, x0, 0, -res, y1), tiled=True, blockxsize=512, blockysize=512,
                compress="deflate", predictor=2, BIGTIFF="YES")
    with rasterio.open(native) as s, rasterio.open(tmp, "w", **prof) as d:
        for b in (1, 2, 3):
            reproject(rasterio.band(s, b), rasterio.band(d, b), resampling=Resampling.cubic,
                      num_threads=4, warp_mem_limit=1024)
    rasterio.shutil.copy(tmp, out_cog, driver="COG", COMPRESS="JPEG", QUALITY=90, BLOCKSIZE=512,
                         OVERVIEW_RESAMPLING="AVERAGE", BIGTIFF="IF_SAFER", NUM_THREADS="4")
    tmp.unlink()
    print(f"  {out_cog.name}: {w}x{h} px, {out_cog.stat().st_size / 1e6:.0f} МБ, "
          f"x[{x0:.0f},{x1:.0f}] y[{y0:.0f},{y1:.0f}]")


def make_overview(src_tif, out_cog, res=2.0):
    with rasterio.open(src_tif) as s:
        f = res / s.res[0]
        w, h = int(s.width / f), int(s.height / f)
        data = s.read(out_shape=(3, h, w), resampling=Resampling.average)
        tr = s.transform * Affine.scale(s.width / w, s.height / h)
        prof = dict(driver="GTiff", width=w, height=h, count=3, dtype="uint8", crs=s.crs, transform=tr,
                    tiled=True, blockxsize=256, blockysize=256, compress="deflate")
    tmp = out_cog.with_suffix(".tmp.tif")
    with rasterio.open(tmp, "w", **prof) as d:
        d.write(data)
    rasterio.shutil.copy(tmp, out_cog, driver="COG", COMPRESS="JPEG", QUALITY=90, BLOCKSIZE=256)
    tmp.unlink()
    print(f"  {out_cog.name}: {w}x{h} px, {out_cog.stat().st_size / 1e6:.0f} МБ")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", nargs="+", default=["yandex", "esri"])
    ap.add_argument("--skip-core", action="store_true")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    for src in a.sources:
        print(src)
        nat = OUT / f"_{src}_native.tif"
        mosaic_native(src, 18, grow(BBOX, MARGIN_M), nat)
        warp_to_world(src, nat, 0.5, grow(BBOX, MARGIN_M), OUT / f"{src}_0.5m.tif")
        nat.unlink()
        make_overview(OUT / f"{src}_0.5m.tif", OUT / f"{src}_2m.tif")
        if not a.skip_core and 19 in SOURCES[src]["zooms"]:
            mosaic_native(src, 19, grow(CORE_BBOX, MARGIN_M), nat)
            warp_to_world(src, nat, 0.25, grow(CORE_BBOX, MARGIN_M), OUT / f"{src}_core_0.25m.tif")
            nat.unlink()


if __name__ == "__main__":
    main()
