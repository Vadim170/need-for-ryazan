"""Скачивание спутниковых тайлов (Яндекс — эллипсоидальный Меркатор EPSG:3395, Esri — Web Mercator).

Запуск:  uv run python fetch_satellite.py [--count-only] [--sources yandex esri] [--zooms 18 19]
Тайлы: data/raw/satellite/<source>/z{z}/{x}/{y}.jpg. Уже скачанные пропускаются (resume).
z18 — весь bbox + 200 м; z19 — только ядро CORE_BBOX.
"""
import argparse
import math
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

import requests
from pyproj import Transformer

from config import BBOX, DATA_RAW

MARGIN_M = 200.0
# ядро для z19: Кремль – Соборная – Первомайский – Театральная (south, west, north, east)
CORE_BBOX = (54.6150, 39.7300, 54.6420, 39.7700)
UA = "Mozilla/5.0 (personal-use hobby project need-for-ryazan)"
RATE = 8.0  # запросов/с суммарно
H = 20037508.342789244  # полуразмер мира в метрах (и для 3857, и для 3395)

_t3395 = Transformer.from_crs(4326, 3395, always_xy=True)
_t3857 = Transformer.from_crs(4326, 3857, always_xy=True)

SOURCES = {
    "yandex": dict(
        url="https://core-sat.maps.yandex.net/tiles?l=sat&x={x}&y={y}&z={z}&lang=ru_RU",
        tr=_t3395, zooms=(18, 19)),
    "esri": dict(
        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        tr=_t3857, zooms=(18,)),  # Esri z19 в Рязани — заглушки "Map data not yet available"
}


def grow(bbox, m):
    s, w, n, e = bbox
    dlat = m / 111320.0
    dlon = m / (111320.0 * math.cos(math.radians((s + n) / 2)))
    return s - dlat, w - dlon, n + dlat, e + dlon


def tile_range(tr, bbox, z):
    s, w, n, e = bbox
    n_t = 2 ** z
    x0, y1 = tr.transform(w, s)
    x1, y0 = tr.transform(e, n)
    f = lambda v: (v + H) / (2 * H) * n_t
    g = lambda v: (H - v) / (2 * H) * n_t
    return int(f(x0)), int(f(x1)), int(g(y0)), int(g(y1))  # xmin,xmax,ymin,ymax


def jobs_for(src, z):
    bbox = grow(BBOX if z == 18 else CORE_BBOX, MARGIN_M)
    xa, xb, ya, yb = tile_range(SOURCES[src]["tr"], bbox, z)
    return [(x, y) for x in range(xa, xb + 1) for y in range(ya, yb + 1)]


def path(src, z, x, y):
    return DATA_RAW / "satellite" / src / f"z{z}" / str(x) / f"{y}.jpg"


lock, last = Lock(), [0.0]


def throttle():
    with lock:
        now = time.time()
        wait = last[0] + 1 / RATE - now
        last[0] = max(now, last[0] + 1 / RATE)
    if wait > 0:
        time.sleep(wait)


def fetch(args):
    src, z, x, y, sess = args
    p = path(src, z, x, y)
    if p.exists():
        return "skip"
    for attempt in range(5):
        throttle()
        try:
            r = sess.get(SOURCES[src]["url"].format(x=x, y=y, z=z), timeout=20)
            if r.status_code == 200 and len(r.content) > 200:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(r.content)
                return "ok"
            if r.status_code in (404, 400):
                return "missing"
        except requests.RequestException:
            pass
        time.sleep(1.5 * (attempt + 1))
    return "fail"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count-only", action="store_true")
    ap.add_argument("--sources", nargs="+", default=list(SOURCES))
    ap.add_argument("--zooms", nargs="+", type=int, default=[18, 19])
    a = ap.parse_args()
    sess = requests.Session()
    sess.headers["User-Agent"] = UA
    for src in a.sources:
        for z in a.zooms:
            if z not in SOURCES[src]["zooms"]:
                continue
            js = jobs_for(src, z)
            print(f"{src} z{z}: {len(js)} тайлов")
            if a.count_only:
                continue
            stats = {}
            with ThreadPoolExecutor(6) as ex:
                for i, r in enumerate(ex.map(fetch, [(src, z, x, y, sess) for x, y in js])):
                    stats[r] = stats.get(r, 0) + 1
                    if i % 500 == 0:
                        print(" ", i, stats, flush=True)
            print(f"{src} z{z}:", stats)


if __name__ == "__main__":
    main()
