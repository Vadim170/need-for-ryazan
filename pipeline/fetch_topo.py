"""Старые топокарты для рельефа v2: тайлы nakarte.me (слой «GGC 250m» = карты Госгисцентра 1:25 000)
-> мозаика GeoTIFF в Web Mercator (EPSG:3857).

Запуск: cd pipeline && uv run python fetch_topo.py [--layer ggc250 --z 15]
Выход: data/raw/topo/<layer>_z<z>/ (тайлы PNG) и data/raw/topo/<layer>_z<z>.tif (RGB, EPSG:3857).

Слои nakarte (src/layers.js в github.com/wladich/nakarte): https://{a,b,c}.tiles.nakarte.me/<layer>/{z}/{x}/{y},
схема TMS (ось y снизу вверх). Для Рязани отвечают только ggc250 (z<=15) и ggc1000 (z<=13), topo250/topo500/ggc500 — 404.
"""
import argparse
import io
import math
import time

import numpy as np
import rasterio
import requests
from PIL import Image
from rasterio.transform import from_origin

from config import BBOX, DATA_RAW

R = 6378137.0
UA = {"User-Agent": "Mozilla/5.0 (need-for-ryazan pipeline)", "Referer": "https://nakarte.me/"}


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--layer", default="ggc250")
    ap.add_argument("--z", type=int, default=15)
    ap.add_argument("--pad", type=float, default=0.004, help="запас вокруг BBOX, градусы")
    a = ap.parse_args()
    S, W, N, E = BBOX
    S -= a.pad; W -= a.pad; N += a.pad; E += a.pad
    z = a.z
    x0, y0 = tile_xy(N, W, z); x1, y1 = tile_xy(S, E, z)
    tx0, ty0, tx1, ty1 = int(x0), int(y0), int(x1), int(y1)
    d = DATA_RAW / "topo" / f"{a.layer}_z{z}"
    d.mkdir(parents=True, exist_ok=True)
    nt = 2 ** z
    W_ = (tx1 - tx0 + 1) * 256; H_ = (ty1 - ty0 + 1) * 256
    mosaic = np.full((H_, W_, 3), 255, np.uint8)
    miss = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            f = d / f"{tx}_{ty}.png"
            if not f.exists():
                url = f"https://{'abc'[(tx + ty) % 3]}.tiles.nakarte.me/{a.layer}/{z}/{tx}/{nt - 1 - ty}"
                for k in range(3):
                    try:
                        r = requests.get(url, headers=UA, timeout=30)
                        break
                    except requests.RequestException:
                        time.sleep(2)
                if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image"):
                    miss += 1
                    continue
                f.write_bytes(r.content)
                time.sleep(0.05)
            im = np.asarray(Image.open(f).convert("RGB"))
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = im
    # геопривязка: Web Mercator, левый верхний угол тайла (tx0, ty0)
    res = 2 * math.pi * R / (nt * 256)
    ox = -math.pi * R + tx0 * 256 * res
    oy = math.pi * R - ty0 * 256 * res
    out = DATA_RAW / "topo" / f"{a.layer}_z{z}.tif"
    with rasterio.open(out, "w", driver="GTiff", width=W_, height=H_, count=3, dtype="uint8", crs="EPSG:3857",
                       transform=from_origin(ox, oy, res, res), compress="deflate") as dst:
        dst.write(mosaic.transpose(2, 0, 1))
    print(f"{a.layer} z{z}: тайлов {(tx1 - tx0 + 1) * (ty1 - ty0 + 1)}, нет {miss}; {W_}x{H_} px, "
          f"{res:.2f} м/px (меркатор), {res * math.cos(math.radians((S + N) / 2)):.2f} м/px на местности -> {out}")


if __name__ == "__main__":
    main()
