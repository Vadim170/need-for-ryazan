"""Кропы ортофото вокруг перекрёстков с осями OSM и полосами SUMO (для правок data/overrides/roads.json).

Запуск:
  uv run python verify_junctions.py --at X,Y [--size 160] [--net path] [--out file.png] [--raw] [--nodes]
  uv run python verify_junctions.py --checks [--before NET] [--after NET]   # before/after по списку checks из overrides
Выход по умолчанию: data/processed/junctions_check/*.png

Слева сырой снимок (для подсчёта полос), справа тот же кроп с наложением:
  красный — оси автодорог OSM (с учётом overrides, подпись — id пути), жёлтый — границы полос SUMO,
  оранжевый — внешние кромки проезжих частей SUMO, голубой — площадки перекрёстков, стрелки — направление рёбер.
Режим --checks рисует три панели: снимок, «до» (net без overrides), «после».
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image, ImageDraw, ImageFont
from rasterio.enums import Resampling
from rasterio.windows import from_bounds
from shapely.geometry import LineString

sys.path.insert(0, str(Path(__file__).parent))
from config import DATA_PROCESSED, DATA_RAW, ROOT  # noqa: E402
from world.osm import OsmData  # noqa: E402
from world.sumo_net import Net  # noqa: E402

ORTHO = DATA_PROCESSED / "ortho" / "yandex_0.5m.tif"
ORTHO_CORE = DATA_PROCESSED / "ortho" / "yandex_core_0.25m.tif"
OUT = DATA_PROCESSED / "junctions_check"
OVR = ROOT / "data" / "overrides" / "roads.json"
PX = 900  # размер панели, px


def font(sz):
    for f in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(f, sz)
        except OSError:
            pass
    return ImageFont.load_default()


def ortho(cx, cy, size):
    h = size / 2
    for path in (ORTHO_CORE, ORTHO):
        if not path.exists():
            continue
        with rasterio.open(path) as ds:
            b = ds.bounds
            if not (b.left <= cx - h and cx + h <= b.right and b.bottom <= cy - h and cy + h <= b.top):
                continue
            win = from_bounds(cx - h, cy - h, cx + h, cy + h, ds.transform)
            a = ds.read(window=win, out_shape=(3, PX, PX), resampling=Resampling.bilinear, boundless=True)
            return Image.fromarray(np.moveaxis(a, 0, -1).astype(np.uint8))
    return Image.new("RGB", (PX, PX), (40, 40, 40))


class View:
    def __init__(self, cx, cy, size):
        self.cx, self.cy, self.size = cx, cy, size
        self.s = PX / size

    def px(self, P):
        P = np.asarray(P, float)
        return list(zip((P[:, 0] - self.cx + self.size / 2) * self.s, (self.cy + self.size / 2 - P[:, 1]) * self.s))

    def inside(self, P, pad=0):
        P = np.asarray(P)
        h = self.size / 2 + pad
        return bool(np.any((np.abs(P[:, 0] - self.cx) < h) & (np.abs(P[:, 1] - self.cy) < h)))


def grid(d, v):
    """Клетка 10 м и масштабная линейка."""
    step = 10.0
    x0 = np.floor((v.cx - v.size / 2) / step) * step
    y0 = np.floor((v.cy - v.size / 2) / step) * step
    for k in range(int(v.size / step) + 2):
        x = x0 + k * step
        X = (x - v.cx + v.size / 2) * v.s
        d.line([(X, 0), (X, 6)], fill=(255, 255, 255))
        y = y0 + k * step
        Y = (v.cy + v.size / 2 - y) * v.s
        d.line([(0, Y), (6, Y)], fill=(255, 255, 255))
    L = 20 * v.s
    d.rectangle([10, PX - 22, 10 + L, PX - 16], fill=(255, 255, 255), outline=(0, 0, 0))
    d.text((14 + L, PX - 30), "20 m", fill=(255, 255, 255), font=font(16), stroke_width=2, stroke_fill=(0, 0, 0))


def draw_net(d, v, net):
    for e in net.edges.values():
        for ln in e["lanes"]:
            S = ln["shape"]
            if len(S) < 2 or not v.inside(S, 30):
                continue
            ls = LineString(S)
            hw = ln["width"] / 2
            for side in (-1, 1):
                try:
                    o = ls.offset_curve(side * hw)
                except Exception:
                    continue
                if o.is_empty:
                    continue
                outer = (side < 0 and ln["index"] == 0) or (side > 0 and ln["index"] == len(e["lanes"]) - 1)
                for g in getattr(o, "geoms", [o]):
                    d.line(v.px(np.array(g.coords)), fill=(255, 150, 0) if outer else (255, 235, 0), width=2 if outer else 1)
        # стрелка направления у конца крайней левой полосы
        S = e["lanes"][-1]["shape"] if e["lanes"] else None
        if S is not None and len(S) >= 2 and v.inside(S):
            a, b = S[-2], S[-1]
            t = (b - a) / max(np.hypot(*(b - a)), 1e-6)
            n = np.array([-t[1], t[0]])
            tip = b - t * 1.0
            tri = np.array([tip, tip - t * 3 + n * 1.2, tip - t * 3 - n * 1.2])
            d.polygon(v.px(tri), fill=(255, 235, 0))
    for j in net.junctions.values():
        if j["shape"] is not None and len(j["shape"]) >= 3 and v.inside(j["shape"]):
            P = np.vstack([j["shape"], j["shape"][:1]])
            d.line(v.px(P), fill=(0, 230, 255), width=2)


def draw_osm(d, v, osm, ways, label=True, nodes=False):
    f = font(13)
    for wid, (refs, tg) in ways.items():
        P = osm.way_xy(wid)
        if len(P) < 2 or not v.inside(P, 5):
            continue
        d.line(v.px(P), fill=(255, 40, 40), width=1)
        if nodes:
            i, ok = osm.node_index(refs)
            for nid, q in zip(refs[ok], osm.xy[i[ok]]):
                if v.inside(q[None]):
                    (X, Y), = v.px(q[None])
                    d.ellipse([X - 2, Y - 2, X + 2, Y + 2], fill=(255, 40, 40))
                    d.text((X + 3, Y + 1), str(nid), fill=(255, 200, 200), font=font(10), stroke_width=1, stroke_fill=(0, 0, 0))
        if label:
            ls = LineString(P)
            h = v.size / 2
            # подпись в точке пути, ближайшей к центру кропа (но внутри)
            from shapely.geometry import Point, box
            c = ls.intersection(box(v.cx - h + 5, v.cy - h + 5, v.cx + h - 5, v.cy + h - 5))
            if c.is_empty:
                continue
            q = c.interpolate(0.5, normalized=True) if c.geom_type == "LineString" else c.representative_point()
            (X, Y), = v.px(np.array([[q.x, q.y]]))
            lanes = tg.get("lanes", "?")
            txt = f"{wid} {tg.get('highway', '')[:3]} L{lanes}{' ow' if tg.get('oneway') in ('yes', '-1') else ''}"
            if "turn:lanes" in " ".join(tg):
                txt += " T"
            d.text((X + 3, Y - 7), txt, fill=(255, 255, 255), font=f, stroke_width=2, stroke_fill=(150, 0, 0))


def panel(osm, ways, net, cx, cy, size, title, nodes=False, img=None):
    v = View(cx, cy, size)
    im = (img or ortho(cx, cy, size)).copy()
    d = ImageDraw.Draw(im)
    if net is not None:
        draw_net(d, v, net)
    if osm is not None:
        draw_osm(d, v, osm, ways, nodes=nodes)
    grid(d, v)
    d.text((10, 8), title, fill=(255, 255, 255), font=font(20), stroke_width=2, stroke_fill=(0, 0, 0))
    return im


def raw_panel(cx, cy, size, title):
    v = View(cx, cy, size)
    im = ortho(cx, cy, size)
    d = ImageDraw.Draw(im)
    grid(d, v)
    d.text((10, 8), title, fill=(255, 255, 255), font=font(20), stroke_width=2, stroke_fill=(0, 0, 0))
    return im


def concat(ims):
    out = Image.new("RGB", (PX * len(ims) + 6 * (len(ims) - 1), PX), (0, 0, 0))
    for k, im in enumerate(ims):
        out.paste(im, (k * (PX + 6), 0))
    return out


_cache = {}


def load_net(path):
    path = Path(path)
    if path not in _cache:
        _cache[path] = Net(path)
    return _cache[path]


def load_osm(apply_overrides=True):
    osm = OsmData(DATA_RAW / "osm" / "ryazan.osm")
    if apply_overrides and OVR.exists():
        from world import overrides as OV
        OV.apply(osm, OVR, log=lambda *a: None)
    return osm, osm.car_ways()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--at", help="X,Y (мировые метры)")
    ap.add_argument("--size", type=float, default=160)
    ap.add_argument("--net", default=str(DATA_PROCESSED / "sumo" / "net.xml"))
    ap.add_argument("--out")
    ap.add_argument("--nodes", action="store_true", help="подписать id узлов OSM")
    ap.add_argument("--no-overrides", action="store_true")
    ap.add_argument("--checks", action="store_true", help="before/after по списку checks из overrides")
    ap.add_argument("--before", help="net.xml без overrides")
    ap.add_argument("--after", default=str(DATA_PROCESSED / "sumo" / "net.xml"))
    ap.add_argument("--only", help="имена checks через запятую")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if a.checks:
        cfg = json.loads(OVR.read_text())
        osm0, car0 = load_osm(False)
        osm1, car1 = load_osm(True)
        nb = load_net(a.before) if a.before else None
        na = load_net(a.after)
        only = set(a.only.split(",")) if a.only else None
        for c in cfg.get("checks", []):
            if only and c["name"] not in only:
                continue
            x, y = c["at"]
            size = c.get("size", 160)
            img = ortho(x, y, size)
            ims = [raw_panel(x, y, size, c.get("title", c["name"]))]
            if nb is not None:
                ims.append(panel(osm0, car0, nb, x, y, size, "до", img=img))
            ims.append(panel(osm1, car1, na, x, y, size, "после", img=img))
            p = OUT / f"{c['name']}.png"
            concat(ims).save(p)
            print("png:", p)
        return
    x, y = map(float, a.at.split(","))
    osm, car = load_osm(not a.no_overrides)
    net = load_net(a.net)
    ims = [raw_panel(x, y, a.size, f"{x:.0f},{y:.0f} {a.size:.0f} m"),
           panel(osm, car, net, x, y, a.size, Path(a.net).parent.name, nodes=a.nodes)]
    p = Path(a.out) if a.out else OUT / f"at_{x:.0f}_{y:.0f}.png"
    concat(ims).save(p)
    print("png:", p)


if __name__ == "__main__":
    main()
