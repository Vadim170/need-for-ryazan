"""Проверка привязки ортофото: кропы 400x400 м с осями дорог OSM (красные) + оценка сдвига в метрах.

Запуск: uv run python verify_ortho.py [--sources yandex esri]
Выход: data/processed/ortho/check_<src>_<place>.png и сводка сдвигов (dx — восток, dy — север; куда надо
сдвинуть оси OSM, чтобы совпасть со снимком).
"""
import argparse
import xml.etree.ElementTree as ET

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import rasterio
from PIL import Image, ImageDraw
from rasterio.windows import from_bounds
from scipy.ndimage import gaussian_filter, uniform_filter

from config import DATA_PROCESSED, DATA_RAW, to_world

OUT = DATA_PROCESSED / "ortho"
CAR = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service",
       "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "living_street"}
PLACES = {
    "pobedy": (54.6293, 39.7116),
    "kremlin": (54.6363, 39.7496),
    "teatralnaya": (54.6218, 39.7571),
    "dps": (54.6378, 39.7814),
}
SIZE = 400.0
MAJOR = {"trunk", "primary", "secondary", "tertiary", "trunk_link", "primary_link", "secondary_link"}
MAJ = []  # флаг «магистраль» для каждого way (по индексу)


def load_roads():
    nodes, ways = {}, []
    for _, el in ET.iterparse(DATA_RAW / "osm" / "ryazan.osm"):
        if el.tag == "node":
            nodes[el.get("id")] = (float(el.get("lon")), float(el.get("lat")))
            el.clear()
        elif el.tag == "way":
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if tags.get("highway") in CAR and tags.get("area") != "yes":
                major = tags.get("highway") in MAJOR
                pts = [nodes[n.get("ref")] for n in el.findall("nd") if n.get("ref") in nodes]
                if len(pts) > 1:
                    ways.append(np.array([to_world.transform(*p) for p in pts]))
                    MAJ.append(major)
            el.clear()
    return ways


def estimate_shift(img, ways, cx, cy, res, rng=12):
    """Максимизируем тёмность снимка вдоль осей дорог (асфальт темнее окружения). Возвращает (dx, dy, контраст)."""
    h, w = img.shape[:2]
    g = img.astype(float).mean(axis=2)
    dark = uniform_filter(g, int(40 / res)) - g  # положительно там, где темнее окрестности
    m = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(m)
    for wy, mj in zip(ways, MAJ):
        if not mj:
            continue
        px = (wy[:, 0] - (cx - SIZE / 2)) / res
        py = (cy + SIZE / 2 - wy[:, 1]) / res
        d.line(list(zip(px, py)), fill=255, width=max(1, int(4 / res)))
    m = gaussian_filter(np.asarray(m, float) / 255, 1.0)
    best, base = None, []
    n = int(rng / res)
    step = max(1, int(1 / res))
    for sy in range(-n, n + 1, step):
        for sx in range(-n, n + 1, step):
            a = np.roll(np.roll(m, sy, 0), sx, 1)[n:-n, n:-n]
            b = dark[n:-n, n:-n]
            s = (a * b).sum() / max(a.sum(), 1e-9)
            base.append(s)
            if best is None or s > best[0]:
                best = (s, sx, sy)
    s, sx, sy = best
    # сдвиг маски на (sx,sy) px вправо/вниз == оси надо сместить на +sx*res востока, -sy*res севера
    return sx * res, -sy * res, s - float(np.median(base))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", nargs="+", default=["yandex", "esri"])
    a = ap.parse_args()
    ways = load_roads()
    print("дорог (car ways):", len(ways))
    for src in a.sources:
        with rasterio.open(OUT / f"{src}_0.5m.tif") as ds:
            for name, (lat, lon) in PLACES.items():
                cx, cy = to_world.transform(lon, lat)
                x0, y0, x1, y1 = cx - SIZE / 2, cy - SIZE / 2, cx + SIZE / 2, cy + SIZE / 2
                img = ds.read(window=from_bounds(x0, y0, x1, y1, ds.transform), out_shape=(3, 800, 800),
                              boundless=True, fill_value=0).transpose(1, 2, 0)
                dx, dy, c = estimate_shift(img, ways, cx, cy, 0.5)
                fig = plt.figure(figsize=(8, 8), dpi=125)
                ax = fig.add_axes([0, 0, 1, 1])
                ax.imshow(img, extent=(x0, x1, y0, y1))
                for wy in ways:
                    if (wy[:, 0].max() > x0 and wy[:, 0].min() < x1 and wy[:, 1].max() > y0 and wy[:, 1].min() < y1):
                        ax.plot(wy[:, 0], wy[:, 1], "r-", lw=0.7)
                ax.set_xlim(x0, x1)
                ax.set_ylim(y0, y1)
                ax.axis("off")
                fig.savefig(OUT / f"check_{src}_{name}.png")
                plt.close(fig)
                print(f"{src:7s} {name:12s} оценка сдвига: dE={dx:+.1f} м, dN={dy:+.1f} м (контраст {c:.2f})")


if __name__ == "__main__":
    main()
