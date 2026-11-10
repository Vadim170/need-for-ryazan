"""Загрузка OSM-данных bbox региона через Overpass (с зеркалами, ретраями и фолбэком на квадранты)."""
import sys
import time
from pathlib import Path

import requests

from config import BBOX, DATA_RAW

OUT_DIR = DATA_RAW / "osm"
OUT = OUT_DIR / "ryazan.osm"
MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
HEADERS = {"User-Agent": "need-for-ryazan-pipeline/0.1 (personal project; v.makarov@dodobrands.io)"}


def query(bbox):
    s, w, n, e = bbox
    b = f"{s},{w},{n},{e}"
    return f"[out:xml][timeout:300];(nwr({b});>;);out meta;"


def fetch(q, tries=3):
    for attempt in range(tries):
        for url in MIRRORS:
            try:
                print(f"POST {url} (attempt {attempt + 1})", flush=True)
                r = requests.post(url, data={"data": q}, headers=HEADERS, timeout=400)
                if r.status_code == 200 and r.content.rstrip().endswith(b"</osm>"):
                    return r.content
                print("  status", r.status_code, len(r.content), flush=True)
            except Exception as ex:  # noqa: BLE001
                print("  error", repr(ex)[:200], flush=True)
            time.sleep(10)
        time.sleep(30 * (attempt + 1))
    raise RuntimeError("Overpass недоступен")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch(query(BBOX))
    OUT.write_bytes(data)
    print("saved", OUT, len(data) / 1e6, "MB")


if __name__ == "__main__":
    sys.exit(main())
