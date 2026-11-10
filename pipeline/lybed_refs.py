"""Референсы Лыбедского бульвара (docs/stage3/lybed.md): панорамы Яндекса вдоль аллеи (шаг ~20 м) и вокруг объектов.

  cd pipeline && uv run python lybed_refs.py                 # поиск панорам + полные полосы + кадры на цели
  cd pipeline && uv run python lybed_refs.py --history       # + исторические панорамы (другие годы/сезоны) у целей
  cd pipeline && uv run python lybed_refs.py --view X Y [--from PID] [--hfov 70] [--pitch 0] [--h 1.5]
                                                              # кадр на мировую точку (x, y) с ближайшей панорамы

Кэш: data/raw/panoramas/lybed/
  pano/<panoid>_z<zoom>_full.jpg     полная полоса эквипрямоугольной панорамы (угол места −40…+50°)
  crops/<target>/<NN>_<panoid>.jpg   перспективные кадры на цели (ёлка, скейтпарк, мосты, аллея)
  index.json                         панорамы: id, дата, x/y мира, ближайшая точка маршрута
Поиск и метаданные — общий кэш pipeline/facades/yandex.py (lookup.json, meta/).
"""
import argparse
import datetime as dt
import io
import json
import math
import pickle
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

from config import DATA_RAW, to_wgs84, to_world
from facades.yandex import CACHE, META_DIR, TILE_URL, Client, load_meta, pano_info
from landmark_refs import perspective

OUT = DATA_RAW / "panoramas" / "lybed"
# маршрут по аллее (мировые x, y): от ул. Ленина (лестницы у цирка) на юго-запад до стадиона «Спартак»
ROUTE = [(-440, -775), (-452, -805), (-462, -850), (-466, -900), (-472, -950), (-490, -990), (-525, -1030),
         (-560, -1065), (-590, -1110), (-597, -1150), (-590, -1200), (-575, -1240), (-560, -1280), (-552, -1320),
         (-548, -1360), (-545, -1395)]
TARGETS = {   # цель: (x, y, высота центра кадра над землёй, радиус «объекта»)
    "elka": (-521.2, -994.9, 6.0, 8),
    "skatepark": (-618.0, -1160.0, 1.0, 25),
    "gorkogo_bridge": (-545.0, -1065.0, 3.0, 25),
    "south_ravine": (-552.0, -1330.0, 2.0, 30),
}


def route_points(step=20.0):
    pts = []
    for (x0, y0), (x1, y1) in zip(ROUTE[:-1], ROUTE[1:]):
        L = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(L // step))
        pts += [(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n) for k in range(n)]
    pts.append(ROUTE[-1])
    return pts


def ll(pts):
    lon, lat = to_wgs84.transform([p[0] for p in pts], [p[1] for p in pts])
    return list(zip(lat, lon))


def full_strip(cl, pid, zoom_w=3584, elev_hi=50, elev_lo=-40):
    meta = load_meta(pid)
    z = Client.pick_zoom(meta, zoom_w)
    W, H = z["width"], z["height"]
    tw, th = meta["Data"]["Images"]["Tiles"]["width"], meta["Data"]["Images"]["Tiles"]["height"]
    ppd = W / 360.0
    head = float(meta["Data"]["EquirectangularProjection"]["Origin"][0])
    r0 = max(0, int((90 - elev_hi) * ppd // th))
    r1 = min(math.ceil(H / th) - 1, int(min((90 - elev_lo) * ppd, H - 1) // th))
    ncols = math.ceil(W / tw)
    info = {"W": W, "H": H, "ppd": ppd, "u0": 0, "v0": r0 * th, "head": head}
    path = OUT / "pano" / f"{pid}_z{z['level']}_full.jpg"
    if path.exists():
        return Image.open(path).convert("RGB"), info
    img = Image.new("RGB", (W, min(H, (r1 + 1) * th) - r0 * th))
    image_id = meta["Data"]["Images"]["imageId"]
    jobs = [(c, r) for c in range(ncols) for r in range(r0, r1 + 1)]

    def get(j):
        c, r = j
        try:
            resp = cl._get(TILE_URL.format(image_id=image_id, zoom=z["level"], x=c, y=r))
        except IOError:
            resp = None
        return j, (Image.open(io.BytesIO(resp.content)).convert("RGB") if resp is not None else None)

    with ThreadPoolExecutor(cl.workers) as ex:
        for (c, r), t in ex.map(get, jobs):
            if t is not None:
                img.paste(t, (c * tw, (r - r0) * th))
    img.save(path, quality=90)
    return img, info


def pano_xy(pid):
    inf = pano_info(load_meta(pid))
    x, y = to_world.transform(inf["lon"], inf["lat"])
    return inf, x, y


def fetch_by_oid(cl, oid):
    """Метаданные исторической панорамы по её id (oid) -> кэш meta/."""
    path = META_DIR / f"{oid}.json"
    if path.exists():
        return oid
    url = (f"https://api-maps.yandex.ru/services/panoramas/1.x/?oid={oid}&provider=streetview&l=stv&lang=en_US")
    r = cl._get(url)
    if r is None:
        return None
    js = r.json()
    if js.get("status") != "success":
        return None
    data = js["data"]
    ann = data.get("Annotation", {})
    slim = {"Data": data["Data"], "Annotation": {"Markers": ann.get("Markers", []), "Thoroughfares": ann.get("Thoroughfares", []),
                                                "HistoricalPanoramas": ann.get("HistoricalPanoramas", [])}}
    path.write_text(json.dumps(slim, ensure_ascii=False))
    return oid


def view(img, info, cam_xy, tgt_xy, h_tgt, hfov, cam_h=2.5, pitch=None):
    dx, dy = tgt_xy[0] - cam_xy[0], tgt_xy[1] - cam_xy[1]
    bearing = math.degrees(math.atan2(dx, dy)) % 360
    d = max(math.hypot(dx, dy), 1.0)
    if pitch is None:
        pitch = math.degrees(math.atan2(h_tgt - cam_h, d))
    return perspective(img, info, bearing, max(-30, min(pitch, 35)), hfov), d, bearing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", action="store_true")
    ap.add_argument("--view", nargs=2, type=float)
    ap.add_argument("--from", dest="pid")
    ap.add_argument("--hfov", type=float, default=70)
    ap.add_argument("--pitch", type=float)
    ap.add_argument("--h", type=float, default=1.5)
    ap.add_argument("--out")
    a = ap.parse_args()
    (OUT / "pano").mkdir(parents=True, exist_ok=True)
    cl = Client(rate=6.0, workers=6)
    if a.view:
        tx, ty = a.view
        idx = json.loads((OUT / "index.json").read_text())
        allp = idx["panoramas"] + idx.get("history", [])
        c = next(p for p in allp if p["id"] == a.pid) if a.pid else min(allp, key=lambda p: math.hypot(p["x"] - tx, p["y"] - ty))
        img, info = full_strip(cl, c["id"])
        v, d, b = view(img, info, (c["x"], c["y"]), (tx, ty), a.h, a.hfov, pitch=a.pitch)
        out = a.out or str(OUT / f"view_{int(tx)}_{int(ty)}_{c['id']}.jpg")
        v.save(out, quality=90)
        print(out, c["id"], c["date"], f"{d:.0f} м, азимут {b:.0f}°")
        return
    pts = route_points(20.0)
    for tx, ty, _, r in TARGETS.values():
        pts += [(tx + rr * math.sin(k * math.pi / 4), ty + rr * math.cos(k * math.pi / 4)) for rr in (r + 8, r + 25) for k in range(8)]
    pids = cl.find_many(ll(pts))
    pan = {}
    for pid in pids:
        if not pid or pid in pan:
            continue
        inf, x, y = pano_xy(pid)
        rd = min(math.hypot(x - px, y - py) for px, py in route_points(5.0))
        pan[pid] = dict(id=pid, x=round(x, 2), y=round(y, 2), date=dt.datetime.utcfromtimestamp(inf["ts"]).strftime("%Y-%m-%d"),
                        street=inf["street"], route_dist=round(rd, 1))
    sel = [p for p in pan.values() if p["route_dist"] < 45 or any(math.hypot(p["x"] - t[0], p["y"] - t[1]) < 70 for t in TARGETS.values())]
    print(f"панорам найдено {len(pan)}, у бульвара {len(sel)}")
    hist = []
    if a.history:
        seen = set(pan)
        for p in sel:
            for h in load_meta(p["id"])["Annotation"].get("HistoricalPanoramas", []):
                oid = h["Connection"]["oid"]
                if oid in seen:
                    continue
                seen.add(oid)
                if fetch_by_oid(cl, oid):
                    inf, x, y = pano_xy(oid)
                    if any(math.hypot(x - t[0], y - t[1]) < 70 for t in TARGETS.values()) or \
                            min(math.hypot(x - px, y - py) for px, py in route_points(5.0)) < 30:
                        hist.append(dict(id=oid, x=round(x, 2), y=round(y, 2),
                                         date=dt.datetime.utcfromtimestamp(inf["ts"]).strftime("%Y-%m-%d"), street=inf["street"],
                                         historical=True))
        print(f"исторических панорам у бульвара: {len(hist)}")
    for name, (tx, ty, h, r) in TARGETS.items():
        d = OUT / "crops" / name
        d.mkdir(parents=True, exist_ok=True)
        near = sorted([p for p in sel + hist if math.hypot(p["x"] - tx, p["y"] - ty) < max(70, r + 45)],
                      key=lambda p: math.hypot(p["x"] - tx, p["y"] - ty))[:24]
        for k, p in enumerate(near):
            img, info = full_strip(cl, p["id"])
            dd = math.hypot(p["x"] - tx, p["y"] - ty)
            hfov = min(100, max(45, 2 * math.degrees(math.atan2(r * 1.4, max(dd, 1))) + 10))
            v, _, b = view(img, info, (p["x"], p["y"]), (tx, ty), h, hfov)
            v.save(d / f"{k:02d}_{p['date']}_{p['id']}.jpg", quality=88)
    # кадры вдоль аллеи: на каждой панораме у маршрута — вперёд и назад по маршруту
    d = OUT / "crops" / "alley"
    d.mkdir(parents=True, exist_ok=True)
    rp = route_points(5.0)
    for p in sorted(sel, key=lambda p: min(range(len(rp)), key=lambda i: math.hypot(rp[i][0] - p["x"], rp[i][1] - p["y"]))):
        if p["route_dist"] > 25:
            continue
        i = min(range(len(rp)), key=lambda i: math.hypot(rp[i][0] - p["x"], rp[i][1] - p["y"]))
        img, info = full_strip(cl, p["id"])
        for tag, j in (("fwd", min(i + 6, len(rp) - 1)), ("back", max(i - 6, 0))):
            if j == i:
                continue
            v, _, _ = view(img, info, (p["x"], p["y"]), rp[j], 1.5, 90, pitch=-4)
            v.save(d / f"{i:03d}_{tag}_{p['date']}_{p['id']}.jpg", quality=85)
    (OUT / "index.json").write_text(json.dumps({"route": ROUTE, "targets": TARGETS, "panoramas": sorted(sel, key=lambda p: p["date"]),
                                                "history": hist}, ensure_ascii=False, indent=1))
    print(f"запросов {cl.n_req}, ошибок {cl.n_err}")


if __name__ == "__main__":
    main()
