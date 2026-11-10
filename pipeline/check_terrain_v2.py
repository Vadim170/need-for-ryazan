"""Проверка рельефа v2: профили «v1 / v2» и отмывка рядом со спутником.
Запуск: cd pipeline && uv run python check_terrain_v2.py [--world ../data/processed/world_test]
Выход: data/processed/terrain_v2_check/*.png и summary.json.
Сравниваются базовые поверхности (до вжатия дорог): v1 = FABDEM + гаусс 17.5 м, v2 = world/terrain_v2.build.
С --world дополнительно рисуется итоговый heightmap мира (после вжатия дорог) — для v2-сборки.
"""
import argparse
import json
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from shapely.geometry import box

from build_world import CELL, world_bounds
from config import DATA_PROCESSED, DATA_RAW, WORLD_CRS, to_world
from world import terrain_v2 as T
from world.grid import Grid
from world.osm import OsmData
from world.terrain import load_dem

OUT = DATA_PROCESSED / "terrain_v2_check"
plt.rcParams["font.family"] = "DejaVu Sans"

# профили: (имя файла, заголовок, точки (lat, lon))
PROFILES = [
    ("p1_kremlin_trubezh", "Соборная пл. → Кремль → Трубеж", [(54.6328, 39.7440), (54.6363, 39.7496), (54.6375, 39.7560)]),
    ("p2_sobornaya_lybed", "Соборная пл. → Лыбедь (Кремлёвский вал, ров)", [(54.6328, 39.7440), (54.6345, 39.7475), (54.6352, 39.7530)]),
    ("p3_pervomaysky", "Первомайский пр.: пл. Победы → Соборная", [(54.6293, 39.7116), (54.6328, 39.7440)]),
    ("p4_solotcha", "Солотчинское ш.: Круиз → ДПС → СВ", [(54.6330, 39.7732), (54.6378, 39.7814), (54.6507, 39.7986)]),
    ("p5_lenina_dam", "ул. Ленина поперёк Лыбедского бульвара (дамба)", [(54.63055, 39.74186), (54.62830, 39.74557)]),
]
LYBED_XS = [(131695933, f, f"Лыбедь в трубе: поперечник на {int(f * 100)}% от верха коллектора") for f in (0.15, 0.4, 0.6, 0.85)] + \
           [(131695885, 0.5, "Лыбедь (открытый участок выше коллектора): поперечник"),
            (131695895, 0.5, "Лыбедь у Кремля (ров): поперечник")]


def hillshade(h, az=315, alt=45):
    gy, gx = np.gradient(h * 3.0, CELL)   # вертикальное преувеличение x3
    gy = -gy
    sl = np.arctan(np.hypot(gx, gy)); asp = np.arctan2(-gx, gy)
    a, e = np.radians(az), np.radians(alt)
    return np.clip(np.sin(e) * np.cos(sl) + np.cos(e) * np.sin(sl) * np.cos(a - asp), 0, 1)


def line_pts(P, step=2.0):
    out = [P[:1]]
    for a, b in zip(P[:-1], P[1:]):
        n = max(1, int(np.hypot(*(b - a)) / step))
        out.append(a + (b - a) * (np.arange(1, n + 1)[:, None] / n))
    Q = np.concatenate(out)
    return Q, np.r_[0, np.cumsum(np.hypot(*np.diff(Q, axis=0).T))]


def sat_crop(x0, x1, y0, y1, res=1.0):
    W = int((x1 - x0) / res); H = int((y1 - y0) / res)
    t = from_origin(x0, y1, res, res)
    with rasterio.open(DATA_PROCESSED / "ortho" / "yandex_0.5m.tif") as s:
        dst = np.zeros((3, H, W), np.uint8)
        reproject(s.read(window=s.window(x0 - 5, y0 - 5, x1 + 5, y1 + 5)), dst,
                  src_transform=s.window_transform(s.window(x0 - 5, y0 - 5, x1 + 5, y1 + 5)), src_crs=s.crs,
                  dst_transform=t, dst_crs=WORLD_CRS, resampling=Resampling.bilinear)
    return dst.transpose(1, 2, 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", help="каталог мира v2 (для итогового heightmap)")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    mx, Mx, my, My = world_bounds()
    g = Grid(mx, Mx, my, My, CELL)
    fab = DATA_RAW / "dem" / "fabdem" / "fabdem_crop.tif"
    v1, gtf = load_dem(fab, g, smooth_m=17.5)
    osm = OsmData(DATA_RAW / "osm" / "ryazan.osm")
    from config import ROOT
    from world import overrides as OV
    for f in ("roads.json", "elevation.json"):
        OV.apply(osm, ROOT / "data" / "overrides" / f, lambda *a: None)
    wb = box(mx, my, Mx, My)
    water = [p.intersection(wb) for p, _ in osm.water()]
    water = [p for p in water if not p.is_empty and p.area > 100]
    v2, layers, info = T.build(g, gtf, osm, water, fab, DATA_RAW / "topo" / "ggc250_z15.tif", DATA_PROCESSED / "terrain_v2")
    surfaces = [("v1 (FABDEM, гаусс 17.5 м)", v1, "tab:blue"), ("v2", v2, "tab:red")]
    if a.world:
        import json as _j
        from pathlib import Path
        man = _j.loads((Path(a.world) / "manifest.json").read_text())
        hm = np.fromfile(Path(a.world) / "terrain" / "heightmap.f32", "<f4").reshape(man["terrain"]["rows"], -1) + man["baseHeight"]
        surfaces.append(("мир v2 после вжатия дорог", hm.astype(float), "tab:green"))
    raw = layers["raw"]
    summary = {"profiles": {}, "lybed": [], "info": {k: v for k, v in info.items() if k != "valleys"}}

    # --- профили
    for fn, title, ll in PROFILES:
        P = np.array([to_world.transform(lon, lat) for lat, lon in ll])
        Q, s = line_pts(P)
        fig, ax = plt.subplots(figsize=(12, 4.5))
        ax.plot(s, g.sample_bilinear(raw, Q[:, 0], Q[:, 1]), color="0.6", lw=0.8, label="FABDEM сырой (5 м)")
        rec = {}
        for nm, H, c in surfaces:
            z = g.sample_bilinear(H, Q[:, 0], Q[:, 1])
            ax.plot(s, z, color=c, lw=1.4, label=nm)
            gr = np.abs(np.diff(z[::5])) / np.diff(s[::5])
            rec[nm] = {"min": round(float(z.min()), 1), "max": round(float(z.max()), 1), "max_grade_10m": round(float(gr.max()), 3)}
        ax.set_title(f"{title} ({s[-1]:.0f} м)"); ax.set_xlabel("м"); ax.set_ylabel("высота, м"); ax.grid(alpha=0.3); ax.legend(fontsize=8)
        fig.savefig(OUT / f"{fn}.png", dpi=90, bbox_inches="tight"); plt.close(fig)
        summary["profiles"][fn] = rec

    # --- поперечники Лыбеди (перпендикуляр к оси коллектора, ±220 м)
    fig, axs = plt.subplots(len(LYBED_XS), 1, figsize=(12, 3.2 * len(LYBED_XS)))
    for ax, (wid, f, title) in zip(axs, LYBED_XS):
        A = osm.way_xy(wid)
        Q0, s0 = line_pts(A)
        k = int(f * (len(Q0) - 1))
        t = Q0[min(k + 3, len(Q0) - 1)] - Q0[max(k - 3, 0)]
        t /= np.hypot(*t)
        nrm = np.array([-t[1], t[0]])
        d = np.arange(-220, 221, 2.0)
        X = Q0[k][None] + d[:, None] * nrm[None]
        ax.plot(d, g.sample_bilinear(raw, X[:, 0], X[:, 1]), color="0.6", lw=0.8, label="FABDEM сырой")
        rec = {"osm": wid, "frac": f, "xy": [round(float(Q0[k][0])), round(float(Q0[k][1]))]}
        for nm, H, c in surfaces:
            z = g.sample_bilinear(H, X[:, 0], X[:, 1])
            ax.plot(d, z, color=c, lw=1.4, label=nm)
            core = np.abs(d) <= 10
            # глубина: дно у оси vs бровки (максимум в ±150 м по каждой стороне)
            left = z[(d < -10) & (d >= -150)].max(); right = z[(d > 10) & (d <= 150)].max()
            rec[nm] = {"floor": round(float(z[core].min()), 1), "depth": round(float(min(left, right) - z[core].min()), 1),
                       "depth_mean_banks": round(float((left + right) / 2 - z[core].min()), 1),
                       "max_side_grade": round(float(np.abs(np.diff(z[::5]) / 10.0).max()), 3)}
        ax.axvline(0, color="b", lw=0.5, ls=":")
        ax.set_title(f"{title}, центр ({rec['xy'][0]}, {rec['xy'][1]})", fontsize=9); ax.grid(alpha=0.3)
        summary["lybed"].append(rec)
    axs[0].legend(fontsize=8)
    axs[-1].set_xlabel("м поперёк долины (− запад/левый берег по течению)")
    fig.tight_layout(); fig.savefig(OUT / "p0_lybed_cross_sections.png", dpi=85); plt.close(fig)

    # --- отмывка: v1 / v2 / спутник для нескольких окон
    views = [("hs_lybed", -1300, 700, -2300, 500), ("hs_kremlin", -700, 700, -900, 500), ("hs_south", -1600, 600, -4200, -2300)]
    for fn, x0, x1, y0, y1 in views:
        c0 = int((x0 - mx) / CELL); c1 = int((x1 - mx) / CELL); r0 = int((My - y1) / CELL); r1 = int((My - y0) / CELL)
        fig, axs = plt.subplots(1, 3, figsize=(24, 8.5 * (y1 - y0) / (x1 - x0)))
        for ax, (nm, H) in zip(axs[:2], [("v1", v1), ("v2", v2)]):
            sub = H[r0:r1, c0:c1]
            ax.imshow(hillshade(sub), cmap="gray", extent=[x0, x1, y0, y1], vmin=0.2, vmax=1)
            ax.contour(np.linspace(x0, x1, sub.shape[1]), np.linspace(y1, y0, sub.shape[0]), sub,
                       levels=np.arange(90, 170, 2.5), colors="saddlebrown", linewidths=0.35)
            ax.set_title(f"{nm}: отмывка + изолинии 2.5 м")
        axs[2].imshow(sat_crop(x0, x1, y0, y1, res=2.0), extent=[x0, x1, y0, y1]); axs[2].set_title("Яндекс-спутник")
        for ax in axs:
            for wid, (refs, tg) in osm.ways.items():
                if tg.get("waterway") in ("river", "stream"):
                    p = osm.way_xy(wid)
                    if len(p) > 1 and p[:, 0].max() > x0 and p[:, 0].min() < x1 and p[:, 1].max() > y0 and p[:, 1].min() < y1:
                        ax.plot(p[:, 0], p[:, 1], ":" if tg.get("tunnel") else "-", color="deepskyblue", lw=0.8)
            ax.set_xlim(x0, x1); ax.set_ylim(y0, y1)
        fig.tight_layout(); fig.savefig(OUT / f"{fn}.png", dpi=70); plt.close(fig)

    # --- карта разности v2 − v1
    fig, ax = plt.subplots(figsize=(12, 12.4))
    im = ax.imshow(v2 - v1, cmap="RdBu_r", vmin=-6, vmax=6, extent=[mx, Mx, my, My])
    plt.colorbar(im, shrink=0.7, label="v2 − v1, м"); ax.set_title("Разность рельефа v2 − v1 (база до вжатия дорог)")
    fig.savefig(OUT / "diff_v2_v1.png", dpi=80, bbox_inches="tight"); plt.close(fig)
    summary["diff"] = {"abs_mean": round(float(np.abs(v2 - v1).mean()), 2), "abs_p99": round(float(np.percentile(np.abs(v2 - v1), 99)), 2),
                       "abs_max": round(float(np.abs(v2 - v1).max()), 2)}
    (OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=float))
    print(json.dumps({"profiles": summary["profiles"], "lybed": summary["lybed"], "diff": summary["diff"]}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
