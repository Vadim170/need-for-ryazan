"""Контрольные картинки: кропы панорам с проекцией фасада + образец цвета; карта футпринтов по цвету."""
import json
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from config import DATA_PROCESSED
from . import analyze as _an
from .analyze import observe, rings
from .proj import PanoCam
from .yandex import Client, load_meta, pano_info

CHECK_DIR = DATA_PROCESSED / "facades_check"


def _font(sz=14):
    for p in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(p, sz)
        except OSError:
            pass
    return ImageFont.load_default()


def draw_building(img, cam, b, dem, color=(255, 255, 0)):
    """Проекция рёбер футпринта на уровне основания и верха (тонкие линии) — для проверки привязки."""
    d = ImageDraw.Draw(img)
    W = img.width
    for r in rings(b.poly):
        for top in (0.0, b.height):
            # плотная дискретизация ребра, чтобы рисовать кривые эквипрямоугольной проекции
            pts = []
            for a, c in zip(r[:-1], r[1:]):
                for s in np.linspace(0, 1, 12, endpoint=False):
                    pts.append(a + s * (c - a))
            pts.append(r[-1])
            pts = np.array(pts)
            u, v, dist = cam.project(pts[:, 0], pts[:, 1], dem.at(pts[:, 0], pts[:, 1]) + top)
            for k in range(len(u) - 1):
                if abs(u[k + 1] - u[k]) < W / 2:
                    d.line([(u[k], v[k]), (u[k + 1], v[k + 1])], fill=color, width=1)
        for p in r[:-1]:
            zb = float(dem.at(p[0], p[1]))
            u, v0, _ = cam.project(p[0], p[1], zb)
            _, v1, _ = cam.project(p[0], p[1], zb + b.height)
            d.line([(u, v0), (u, v1)], fill=color, width=1)


def run(B, dem, res, n=12, seed=7):
    CHECK_DIR.mkdir(parents=True, exist_ok=True)
    for old in CHECK_DIR.glob("*.png"):
        old.unlink()
    fac = res["facades"]
    sidx = res["sidx"]
    obs = json.loads(_an.OBS_PATH.read_text()) if _an.OBS_PATH.exists() else {}
    by_key = {b.key: b for b in B}
    best = {}
    for pid, d in obs.items():
        for key, rs in d.items():
          for r in rs:
            if key not in best or r["w"] > best[key][1]["w"]:
                best[key] = (pid, r)
    keys = sorted(k for k in fac if k in best)
    random.Random(seed).shuffle(keys)
    cl = Client()
    font = _font(14)
    made = []
    for key in keys[:n]:
        pid, r = best[key]
        b = by_key[key]
        img, sinfo = cl.strip(pid)
        info = pano_info(load_meta(pid))
        cam = PanoCam(info, sinfo["W"], sinfo["y0"], H=sinfo["H"])
        cam.z = float(dem.at(cam.x, cam.y)) + cam.z
        lst = observe(pid, np.asarray(img), sinfo, cam, sidx, dem, keep_geom=True).get(b.idx)
        if not lst:
            continue
        o = min(lst, key=lambda x: abs(x["w"] - r["w"]))
        # для наглядности рисуем на полной панораме (тот же зум), строки сдвигаем на y0 полосы
        full, finfo = cl.strip(pid, 90, -90)
        if full is not None and finfo["W"] == sinfo["W"]:
            dy = sinfo["y0"] - finfo["y0"]
            img, sinfo = full, finfo
        else:
            dy = 0
        cols = [(c[0], c[1] + dy, c[2] + dy, c[3], c[4]) for c in o["cols"]]
        us = np.array([c[0] for c in cols])
        # кроп по столбцам (с учётом перехода через 0)
        W = img.width
        shift = 0
        if us.max() - us.min() > W / 2:
            shift = W // 2
        us2 = (us + shift) % W
        rolled = Image.fromarray(np.roll(np.asarray(img), shift, axis=1))
        overlay = rolled.copy()
        cam2 = PanoCam(info, sinfo["W"], sinfo["y0"], H=sinfo["H"])
        cam2.z = cam.z
        cam2.heading = cam.heading - shift * 360.0 / W
        draw_building(overlay, cam2, b, dem)
        dr = ImageDraw.Draw(overlay)
        top = [((c[0] + shift) % W, c[1]) for c in cols]
        bot = [((c[0] + shift) % W, c[2]) for c in cols]
        for (u, v0), (_, v1) in zip(top, bot):
            dr.point((u, v0), fill=(255, 0, 0)); dr.point((u, v1), fill=(255, 0, 0))
        dr.line(sorted(top), fill=(255, 0, 0), width=2)
        dr.line(sorted(bot), fill=(255, 0, 0), width=2)
        x0, x1 = max(0, int(us2.min()) - 120), min(W, int(us2.max()) + 120)
        crop_raw = rolled.crop((x0, 0, x1, rolled.height))
        crop = overlay.crop((x0, 0, x1, overlay.height))
        s = 2
        crop = crop.resize((crop.width * s, crop.height * s), Image.LANCZOS)
        crop_raw = crop_raw.resize((crop_raw.width * s, crop_raw.height * s), Image.LANCZOS)
        Wc = max(crop.width, 520)
        canvas = Image.new("RGB", (Wc, crop.height * 2 + 130), (30, 30, 30))
        canvas.paste(crop_raw, (0, 0))
        canvas.paste(crop, (0, crop.height))
        dc = ImageDraw.Draw(canvas)
        yb = crop.height * 2 + 8
        f = fac[key]
        from .color import hexcolor
        dc.rectangle([8, yb, 108, yb + 100], fill=f["color"])
        dc.rectangle([116, yb, 166, yb + 100], fill=hexcolor(o["lab"]))
        tg = b.tags
        txt = (f"{key}  {tg.get('building')}  {tg.get('addr:street', '')} {tg.get('addr:housenumber', '')}\n"
               f"final {f['color']} conf {f['confidence']} n={f['samples']} {f['material']}\n"
               f"this obs: d={o['d']}m cos={o['cos']} px={o['npix']} share={o['share']} lit={o['lit']}\n"
               f"h={b.height:.0f}m ({b.hsrc})  pano {pid}")
        dc.multiline_text((176, yb), txt, fill=(240, 240, 240), font=font, spacing=4)
        path = CHECK_DIR / f"{key}.png"
        canvas.save(path)
        made.append(path.name)
    print("check images:", made)
    draw_map(B, fac, obs)


def draw_map(B, fac, obs, path=None):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import PolyCollection
    from config import to_world
    path = path or (CHECK_DIR.parent / "facades_map.png")
    polys, cols = [], []
    for b in B:
        f = fac.get(b.key)
        for p in ([b.poly] if b.poly.geom_type == "Polygon" else list(b.poly.geoms)):
            polys.append(np.asarray(p.exterior.coords))
            cols.append(f["color"] if f else "#3a3a3a")
    fig, ax = plt.subplots(figsize=(22, 22), dpi=110)
    ax.set_facecolor("#141414")
    ax.add_collection(PolyCollection(polys, facecolors=cols, edgecolors="none"))
    pts = []
    for pid in obs:
        try:
            i = pano_info(load_meta(pid))
            pts.append(to_world.transform(i["lon"], i["lat"]))
        except FileNotFoundError:
            pass
    if pts:
        pts = np.array(pts)
        ax.scatter(pts[:, 0], pts[:, 1], s=1.5, c="#00e5ff", lw=0)
    allp = np.vstack(polys)
    ax.set_xlim(allp[:, 0].min(), allp[:, 0].max()); ax.set_ylim(allp[:, 1].min(), allp[:, 1].max())
    ax.set_aspect("equal")
    ax.set_title("Facade colours from Yandex panoramas (dark grey = no data, cyan dots = panoramas)")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    print("map:", path)

