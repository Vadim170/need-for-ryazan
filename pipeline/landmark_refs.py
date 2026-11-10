"""Референсы для hero-моделей (docs/stage2/landmarks.md): панорамы Яндекса вокруг объекта + ортофото.

  cd pipeline && uv run python landmark_refs.py <id> [--lat .. --lon ..] [--radius 30] [--n 24] [--target-h 15]

Координаты по умолчанию берутся из game/public/assets/landmarks/landmarks.json (поле `anchor`) или задаются флагами.
Кэш: data/raw/panoramas/landmarks/<id>/
  pano/<panoid>_z<zoom>_c<c0>-<c1>_r<r0>-<r1>.jpg   кусок эквипрямоугольной панорамы (только тайлы в сторону объекта)
  crops/<NN>_<panoid>.jpg                          перспективный кадр на объект (прямолинейная проекция)
  index.json                                       список панорам: id, lat/lon, x/y мира, расстояние, азимут с объекта, дата
Ортофото 0.25 м с футпринтами OSM и сеткой 10 м — data/processed/landmarks/<id>_ortho.png.
Поиск панорам и метаданные — общий кэш pipeline/facades/yandex.py (lookup.json, meta/).
"""
import argparse
import io
import json
import math
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw

from config import DATA_PROCESSED, DATA_RAW, ROOT, to_wgs84, to_world
from facades.yandex import TILE_URL, Client, load_meta, pano_info

OUT_RAW = DATA_RAW / "panoramas" / "landmarks"
MANIFEST = ROOT / "game" / "public" / "assets" / "landmarks" / "landmarks.json"


def ring_points(x0, y0, radii, n_az=16):
    pts = []
    for r in radii:
        for k in range(n_az):
            a = 2 * math.pi * (k + 0.5 * (r // 10 % 2)) / n_az
            pts.append((x0 + r * math.sin(a), y0 + r * math.cos(a)))
    lon, lat = to_wgs84.transform([p[0] for p in pts], [p[1] for p in pts])
    return list(zip(lat, lon))


def select(cands, x0, y0, rmin, n, rmax):
    """Равномерно по азимуту: 12 секторов, в каждом — ближайшие (не ближе rmin), потом добор."""
    ok = [c for c in cands if rmin <= c["dist"] <= rmax]
    bins = {}
    for c in sorted(ok, key=lambda c: (c["dist"], -c["ts"])):
        bins.setdefault(int(c["az"] // 30), []).append(c)
    out, depth = [], 0
    while len(out) < n and any(len(v) > depth for v in bins.values()):
        for b in sorted(bins):
            if len(bins[b]) > depth and len(out) < n:
                out.append(bins[b][depth])
        depth += 1
    return out


def fetch_part(cl, pid, bearing, half_w, elev_lo, elev_hi, zoom_w, out_dir):
    meta = load_meta(pid)
    z = Client.pick_zoom(meta, zoom_w)
    W, H = z["width"], z["height"]
    tw, th = meta["Data"]["Images"]["Tiles"]["width"], meta["Data"]["Images"]["Tiles"]["height"]
    ppd = W / 360.0
    head = float(meta["Data"]["EquirectangularProjection"]["Origin"][0])
    u0 = ((bearing - half_w - head) % 360) * ppd
    ncols = math.ceil(W / tw)
    c0 = int(u0 // tw)
    cn = math.ceil(2 * half_w * ppd / tw) + 1
    cols = [(c0 + i) % ncols for i in range(cn)]
    r0 = max(0, int((90 - elev_hi) * ppd // th))
    r1 = min(math.ceil(H / th) - 1, int(min((90 - elev_lo) * ppd, H - 1) // th))
    path = out_dir / f"{pid}_z{z['level']}_c{c0}-{cn}_r{r0}-{r1}.jpg"
    info = {"W": W, "H": H, "ppd": ppd, "u0": c0 * tw, "v0": r0 * th, "head": head}
    if path.exists():
        return Image.open(path).convert("RGB"), info
    img = Image.new("RGB", (cn * tw, (r1 - r0 + 1) * th))
    image_id = meta["Data"]["Images"]["imageId"]
    jobs = [(i, c, r) for i, c in enumerate(cols) for r in range(r0, r1 + 1)]

    def get(j):
        i, c, r = j
        try:
            resp = cl._get(TILE_URL.format(image_id=image_id, zoom=z["level"], x=c, y=r))
        except IOError:
            resp = None
        return j, (Image.open(io.BytesIO(resp.content)).convert("RGB") if resp is not None else None)

    with ThreadPoolExecutor(cl.workers) as ex:
        for (i, c, r), t in ex.map(get, jobs):
            if t is not None:
                img.paste(t, (i * tw, (r - r0) * th))
    img.save(path, quality=92)
    return img, info


def perspective(img, info, yaw, pitch, hfov, size=(1280, 900)):
    """Прямолинейный кадр из куска эквипрямоугольной панорамы. yaw — азимут (°), pitch — угол места (°)."""
    Wo, Ho = size
    f = (Wo / 2) / math.tan(math.radians(hfov / 2))
    xs, ys = np.meshgrid(np.arange(Wo) - Wo / 2 + 0.5, np.arange(Ho) - Ho / 2 + 0.5)
    d = np.stack([xs, -ys, np.full_like(xs, f)], -1)
    p = math.radians(pitch)
    R = np.array([[1, 0, 0], [0, math.cos(p), math.sin(p)], [0, -math.sin(p), math.cos(p)]])
    d = d @ R.T
    az = (np.degrees(np.arctan2(d[..., 0], d[..., 2])) + yaw) % 360
    el = np.degrees(np.arctan2(d[..., 1], np.hypot(d[..., 0], d[..., 2])))
    u = ((az - info["head"]) % 360) * info["ppd"] - info["u0"]
    u = np.where(u < -info["W"] / 2, u + info["W"], u)
    v = (90 - el) * info["ppd"] - info["v0"]
    a = np.asarray(img)
    ui = np.clip(u.round().astype(int), 0, a.shape[1] - 1)
    vi = np.clip(v.round().astype(int), 0, a.shape[0] - 1)
    out = a[vi, ui]
    out[(u < 0) | (u >= a.shape[1]) | (v < 0) | (v >= a.shape[0])] = 0
    return Image.fromarray(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("id")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--radius", type=float, default=30.0, help="полуразмер объекта, м (ближе панорамы не берём)")
    ap.add_argument("--rmax", type=float, default=170.0)
    ap.add_argument("--n", type=int, default=24)
    ap.add_argument("--target-h", type=float, default=15.0, help="высота центра кадра над землёй, м")
    ap.add_argument("--zoom-w", type=int, default=3584, help="ширина панорамы выбранного зума (3584 — средний)")
    a = ap.parse_args()
    lat, lon = a.lat, a.lon
    if lat is None and MANIFEST.exists():
        for lm in json.loads(MANIFEST.read_text())["landmarks"]:
            if lm["id"] == a.id:
                lat, lon = lm["anchor"]["lat"], lm["anchor"]["lon"]
    x0, y0 = to_world.transform(lon, lat)
    out = OUT_RAW / a.id
    (out / "pano").mkdir(parents=True, exist_ok=True)
    (out / "crops").mkdir(parents=True, exist_ok=True)
    cl = Client(rate=6.0, workers=6)
    radii = [a.radius + d for d in (5, 15, 30, 50, 80, 120)]
    pids = cl.find_many(ring_points(x0, y0, radii, 24))
    cands = {}
    for pid in pids:
        if not pid or pid in cands:
            continue
        inf = pano_info(load_meta(pid))
        x, y = to_world.transform(inf["lon"], inf["lat"])
        dist = math.hypot(x - x0, y - y0)
        cands[pid] = dict(inf, x=round(x, 2), y=round(y, 2), dist=round(dist, 1),
                          az=round(math.degrees(math.atan2(x - x0, y - y0)) % 360, 1))
    sel = select(list(cands.values()), x0, y0, a.radius + 3, a.n, a.rmax)
    print(f"{a.id}: панорам рядом {len(cands)}, выбрано {len(sel)}")
    index = []
    for k, c in enumerate(sorted(sel, key=lambda c: c["az"])):
        bearing = (c["az"] + 180) % 360
        half = math.degrees(math.atan2(a.radius * 1.3, max(c["dist"], 1))) + 6
        half = min(max(half, 22), 75)
        elev_hi = min(80, math.degrees(math.atan2(a.target_h * 2.2, c["dist"])) + 12)
        img, info = fetch_part(cl, c["id"], bearing, half, -25, elev_hi, a.zoom_w, out / "pano")
        pitch = math.degrees(math.atan2(a.target_h - 2.5, c["dist"]))
        crop = perspective(img, info, bearing, min(pitch, 35), min(2 * half, 110))
        name = f"{k:02d}_{c['id']}.jpg"
        crop.save(out / "crops" / name, quality=90)
        index.append(dict(c, crop=f"crops/{name}", bearing_to_obj=round(bearing, 1), hfov=round(2 * half, 1)))
        print(f"  {name}: {c['dist']} м, с азимута {c['az']}°, {c['street']}")
    (out / "index.json").write_text(json.dumps({"id": a.id, "lat": lat, "lon": lon, "x": round(x0, 2), "y": round(y0, 2),
                                                "panoramas": index}, ensure_ascii=False, indent=1))
    print(f"запросов {cl.n_req}, ошибок {cl.n_err}")


if __name__ == "__main__":
    main()
