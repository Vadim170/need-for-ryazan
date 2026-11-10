"""Минимальный клиент панорам Яндекса (по мотивам sk-zk/streetlevel, MIT), без streetlevel.exif/pyexiv2.

Кэш: data/raw/panoramas/
  lookup.json            "lat,lon" (6 знаков) -> panoramaId | null  (результат поиска по точке)
  meta/<panoid>.json     ответ API (data.Data + урезанная Annotation)
  img/<panoid>_z<zoom>_r<r0>-<r1>.jpg   горизонтальная полоса эквипрямоугольной панорамы (ряды тайлов r0..r1)

Конвенции (проверены на панорамах Рязани, см. docs/stage1/facades.md):
  * пиксель x=0 смотрит на азимут Origin[0] (градусы, по часовой от севера); азимут растёт вправо;
  * верх изображения — зенит (+90°), 1 пиксель = 360/W градусов по обеим осям; у автомобильных камер
    низ обрезан (H < W/2), у сферических H = W/2.
"""
import io
import json
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from PIL import Image

from config import DATA_RAW

CACHE = DATA_RAW / "panoramas"
META_DIR = CACHE / "meta"
IMG_DIR = CACHE / "img"
LOOKUP = CACHE / "lookup.json"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/131.0.0.0 Safari/537.36 need-for-ryazan-personal")
FIND_URL = ("https://api-maps.yandex.ru/services/panoramas/1.x/?l=stv&lang=en_US&ll={lon:.6f},{lat:.6f}"
            "&origin=userAction&provider=streetview")
TILE_URL = "https://pano.maps.yandex.net/{image_id}/{zoom}.{x}.{y}"


class RateLimiter:
    def __init__(self, rate):
        self.dt = 1.0 / rate
        self.lock = threading.Lock()
        self.next = 0.0

    def wait(self):
        with self.lock:
            now = time.monotonic()
            t = max(now, self.next)
            self.next = t + self.dt
        d = t - time.monotonic()
        if d > 0:
            time.sleep(d)


class Client:
    def __init__(self, rate=4.0, workers=6):
        for d in (META_DIR, IMG_DIR):
            d.mkdir(parents=True, exist_ok=True)
        self.rl = RateLimiter(rate)
        self.workers = workers
        self.local = threading.local()
        self.lookup = json.loads(LOOKUP.read_text()) if LOOKUP.exists() else {}
        self.lock = threading.Lock()
        self.n_req = 0
        self.n_err = 0

    # ---------------- HTTP
    def _session(self):
        s = getattr(self.local, "s", None)
        if s is None:
            s = self.local.s = requests.Session()
            s.headers["User-Agent"] = UA
            s.headers["Referer"] = "https://yandex.ru/maps/"
        return s

    def _get(self, url, tries=5):
        for k in range(tries):
            self.rl.wait()
            try:
                r = self._session().get(url, timeout=30)
                with self.lock:
                    self.n_req += 1
                if r.status_code == 200:
                    return r
                if r.status_code == 404:
                    return None
                if r.status_code == 500 and k >= 1:
                    return None  # у старых панорам тайлы стабильно отдают 500 — считаем отсутствующими
                if r.status_code in (429, 500, 502, 503, 504):
                    time.sleep(2 ** k * 2)
                    continue
                return None
            except requests.RequestException:
                time.sleep(2 ** k)
        with self.lock:
            self.n_err += 1
        raise IOError(f"failed: {url}")

    # ---------------- поиск и метаданные
    @staticmethod
    def key(lat, lon):
        return f"{lat:.6f},{lon:.6f}"

    def find(self, lat, lon):
        """panoramaId ближайшей панорамы (или None). Метаданные кладутся в кэш."""
        k = self.key(lat, lon)
        if k in self.lookup:
            return self.lookup[k]
        try:
            r = self._get(FIND_URL.format(lat=lat, lon=lon))
        except IOError:
            return None  # сетевой сбой: не кэшируем, повторим при следующем запуске
        pid = None
        if r is not None:
            try:
                js = r.json()
            except ValueError:
                js = {}
            if js.get("status") == "success":
                data = js["data"]
                pid = data["Data"]["panoramaId"]
                path = META_DIR / f"{pid}.json"
                if not path.exists():
                    ann = data.get("Annotation", {})
                    slim = {"Data": data["Data"],
                            "Annotation": {"Markers": ann.get("Markers", []),
                                           "Thoroughfares": ann.get("Thoroughfares", []),
                                           "HistoricalPanoramas": ann.get("HistoricalPanoramas", [])}}
                    path.write_text(json.dumps(slim, ensure_ascii=False))
        with self.lock:
            self.lookup[k] = pid
        return pid

    def find_many(self, latlons, save_every=200, progress=None):
        todo = [(la, lo) for la, lo in latlons if self.key(la, lo) not in self.lookup]
        done = 0
        with ThreadPoolExecutor(self.workers) as ex:
            for _ in ex.map(lambda p: self.find(*p), todo):
                done += 1
                if done % save_every == 0:
                    self.save_lookup()
                    if progress:
                        progress(done, len(todo))
        self.save_lookup()
        return [self.lookup.get(self.key(la, lo)) for la, lo in latlons]

    def save_lookup(self):
        with self.lock:
            tmp = LOOKUP.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.lookup))
            tmp.replace(LOOKUP)

    # ---------------- изображения
    @staticmethod
    def pick_zoom(meta, target_w=1792):
        zooms = meta["Data"]["Images"]["Zooms"]
        best = min(zooms, key=lambda z: (abs(math.log(z["width"] / target_w)), -z["width"]))
        return best

    def strip(self, pid, elev_hi=37.0, elev_lo=-12.0, target_w=1792, cache_only=False):
        """Полоса панорамы между углами места elev_lo..elev_hi (по рядам тайлов).
        Возвращает (PIL.Image, info) где info = {W, H, y0, zoom}; y0 — строка полного изображения,
        соответствующая верху полосы."""
        meta = load_meta(pid)
        z = self.pick_zoom(meta, target_w)
        W, H = z["width"], z["height"]
        tw, th = meta["Data"]["Images"]["Tiles"]["width"], meta["Data"]["Images"]["Tiles"]["height"]
        ppd = W / 360.0
        ya, yb = (90 - elev_hi) * ppd, (90 - elev_lo) * ppd
        r0 = max(0, int(ya // th))
        r1 = min(math.ceil(H / th) - 1, int(min(yb, H - 1) // th))
        path = IMG_DIR / f"{pid}_z{z['level']}_r{r0}-{r1}.jpg"
        info = {"W": W, "H": H, "y0": r0 * th, "zoom": z["level"]}
        if path.exists():
            return Image.open(path).convert("RGB"), info
        bad = IMG_DIR / f"{pid}.bad"
        if cache_only or bad.exists():
            return None, info
        cols = math.ceil(W / tw)
        img = Image.new("RGB", (W, min(H, (r1 + 1) * th) - r0 * th))
        image_id = meta["Data"]["Images"]["imageId"]
        jobs = [(x, y) for y in range(r0, r1 + 1) for x in range(cols)]

        def fetch(xy):
            x, y = xy
            try:
                r = self._get(TILE_URL.format(image_id=image_id, zoom=z["level"], x=x, y=y))
            except IOError:
                r = None
            return xy, (Image.open(io.BytesIO(r.content)).convert("RGB") if r is not None else None)

        ok = True
        with ThreadPoolExecutor(self.workers) as ex:
            for (x, y), t in ex.map(fetch, jobs):
                if t is None:
                    ok = False
                    continue
                img.paste(t, (x * tw, (y - r0) * th))
        if not ok:
            bad.write_text("missing tiles")
            return None, info
        img.save(path, quality=92)
        return img, info


def load_meta(pid):
    return json.loads((META_DIR / f"{pid}.json").read_text())


def pano_info(meta):
    D = meta["Data"]
    lon, lat = D["Point"]["coordinates"][:2]
    return {"id": D["panoramaId"], "lat": float(lat), "lon": float(lon),
            "heading": float(D["EquirectangularProjection"]["Origin"][0]),
            "origin_v": float(D["EquirectangularProjection"]["Origin"][1]),
            "ts": int(D["panoramaId"].split("_")[-1]),  # точное время съёмки (Data.timestamp — округлённая дата)
            "street": D["Point"].get("name", "")}
