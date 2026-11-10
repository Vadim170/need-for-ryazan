"""Скачивание DEM для bbox + 1 км запаса (только окна COG, без гигантских архивов).

Источники (все открыты, без регистрации):
  cop30   Copernicus GLO-30 (DSM)      AWS open data copernicus-dem-30m
  fabdem  FABDEM v1.2 (DTM, 30 м)      HuggingFace bucket links-ads/fabdem (COG по тайлам)
  alos    ALOS AW3D30 (DSM, 30 м)      Microsoft Planetary Computer (публичный SAS-токен)
  nasadem NASADEM (SRTM-реобработка)   Microsoft Planetary Computer
  terrarium  AWS Terrain Tiles z15 (смешанные источники), PNG -> GeoTIFF

Результат: data/raw/dem/<source>/<source>_crop.tif (EPSG:4326 или 3857 для terrarium).
Запуск: cd pipeline && uv run python fetch_dem.py
"""
import io
import json
import math
import urllib.request

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.windows import from_bounds as win_from_bounds

from config import BBOX, DATA_RAW

MARGIN_M = 1000
S, W, N, E = BBOX
DLAT = MARGIN_M / 111_200
DLON = MARGIN_M / (111_200 * math.cos(math.radians((S + N) / 2)))
CROP = (W - DLON, S - DLAT, E + DLON, N + DLAT)  # west, south, east, north

COP30 = ("https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N54_00_E039_00_DEM/"
         "Copernicus_DSM_COG_10_N54_00_E039_00_DEM.tif")
FABDEM = ("https://huggingface.co/buckets/links-ads/fabdem/resolve/tiles/"
          "N50E030-N60E040_FABDEM_V1-2/N54E039_FABDEM_V1-2.tif")
ALOS = "https://ai4edataeuwest.blob.core.windows.net/alos-dem/AW3D30_global/ALPSMLC30_N054E039_DSM.tif"
NASADEM = "https://nasademeuwest.blob.core.windows.net/nasadem-cog/v001/NASADEM_HGT_n54e039.tif"


def pc_token(collection):
    with urllib.request.urlopen(f"https://planetarycomputer.microsoft.com/api/sas/v1/token/{collection}") as r:
        return json.load(r)["token"]


def crop_cog(url, name):
    out_dir = DATA_RAW / "dem" / name
    out_dir.mkdir(parents=True, exist_ok=True)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif"):
        with rasterio.open(url) as src:
            win = win_from_bounds(*CROP, transform=src.transform).round_offsets().round_lengths()
            data = src.read(1, window=win)
            prof = src.profile
            tr = src.window_transform(win)
    prof.update(driver="GTiff", height=data.shape[0], width=data.shape[1], transform=tr,
                tiled=False, compress="deflate", count=1)
    prof.pop("blockxsize", None); prof.pop("blockysize", None)
    path = out_dir / f"{name}_crop.tif"
    with rasterio.open(path, "w", **prof) as dst:
        dst.write(data, 1)
    print(name, data.shape, data.dtype, path)


def fetch_terrarium(z=15):
    out_dir = DATA_RAW / "dem" / "terrarium"
    out_dir.mkdir(parents=True, exist_ok=True)
    from PIL import Image

    def tile(lat, lon):
        n = 2 ** z
        return (int((lon + 180) / 360 * n),
                int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n))

    x0, y1 = tile(CROP[1], CROP[0])
    x1, y0 = tile(CROP[3], CROP[2])
    R = 6378137.0
    org = math.pi * R
    size = 2 * org / 2 ** z
    mosaic = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), np.float32)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
            with urllib.request.urlopen(url) as r:
                im = np.asarray(Image.open(io.BytesIO(r.read())).convert("RGB"), dtype=np.float32)
            mosaic[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = (
                im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768)
    left, top = -org + x0 * size, org - y0 * size
    right, bottom = -org + (x1 + 1) * size, org - (y1 + 1) * size
    path = out_dir / "terrarium_z15.tif"
    with rasterio.open(path, "w", driver="GTiff", height=mosaic.shape[0], width=mosaic.shape[1], count=1,
                       dtype="float32", crs="EPSG:3857", transform=from_bounds(left, bottom, right, top, mosaic.shape[1], mosaic.shape[0]),
                       compress="deflate") as dst:
        dst.write(mosaic, 1)
    print("terrarium", mosaic.shape, path)


if __name__ == "__main__":
    print("crop (W,S,E,N):", CROP)
    crop_cog(COP30, "cop30")
    crop_cog(FABDEM, "fabdem")
    crop_cog(ALOS + "?" + pc_token("alos-dem"), "alos")
    crop_cog(NASADEM + "?" + pc_token("nasadem"), "nasadem")
    fetch_terrarium(15)
