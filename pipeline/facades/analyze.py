"""Видимость фасадов из панорамы, сбор пикселей стены, агрегация цвета по зданиям."""
import json
import time
from collections import defaultdict

import numpy as np
from shapely.geometry import MultiPolygon, Point, Polygon
from shapely.strtree import STRtree

from config import DATA_PROCESSED
from .color import (MATERIALS, hexcolor, kmeans_mode, material_of, pixel_ok, sky_mask_columns,
                    srgb_to_lab)
from .proj import PanoCam
from .sun import sun_az_el
from .yandex import Client, load_meta, pano_info

OBS_PATH = DATA_PROCESSED / "facades_obs.json"

MAX_D = 60.0        # дальность учёта фасадов, м
MIN_D = 4.0
BIN_DEG = 0.25      # шаг лучей по азимуту
Z_LO = 3.0          # низ окна выборки над основанием здания (отсекаем машины, заборы, вывески 1-го этажа частично)
Z_HI = 12.0         # верх окна выборки
MIN_COS = 0.30      # отсекаем фасады под скользящим углом (>72° от нормали)
MIN_PIX = 40
Z_LO_DEFAULT, Z_HI_DEFAULT = 2.0, 4.5
MIN_ELEV = 1.0     # град над горизонтом камеры


def rings(poly):
    ps = [poly] if isinstance(poly, Polygon) else list(poly.geoms)
    for p in ps:
        yield np.asarray(p.exterior.coords)
        for r in p.interiors:
            yield np.asarray(r.coords)


def cast(o, segA, segB, bearings):
    """Ближайшее пересечение лучей из o по азимутам (град) с отрезками. -> (t, seg_index) (t=inf если нет)."""
    br = np.radians(bearings)
    D = np.c_[np.sin(br), np.cos(br)]                       # (M, 2)  x=восток, y=север
    E = segB - segA                                         # (N, 2)
    AO = segA - o                                           # (N, 2)
    den = D[:, 0:1] * E[None, :, 1] - D[:, 1:2] * E[None, :, 0]     # cross(D, E)
    with np.errstate(divide="ignore", invalid="ignore"):
        t = (AO[None, :, 0] * E[None, :, 1] - AO[None, :, 1] * E[None, :, 0]) / den
        s = (AO[None, :, 0] * D[:, 1:2] - AO[None, :, 1] * D[:, 0:1]) / den
    ok = (np.abs(den) > 1e-9) & (s >= 0) & (s <= 1) & (t > 0.3)
    t = np.where(ok, t, np.inf)
    j = t.argmin(1)
    return t[np.arange(len(D)), j], j


class SceneIndex:
    def __init__(self, buildings):
        self.B = buildings
        self.tree = STRtree([b.poly for b in buildings])


def observe(pano_id, img, sinfo, cam, sidx, dem, keep_geom=False):
    """Наблюдения одной панорамы: {bidx: dict(lab, npix, w, d, cos, ...)}."""
    o = np.array([cam.x, cam.y])
    cand = sidx.tree.query(Point(o).buffer(MAX_D + 5))
    if len(cand) == 0:
        return {}
    # камера внутри футпринта (арки, ошибки) — пропуск
    for i in cand:
        if sidx.B[i].poly.contains(Point(o)):
            return {}
    A, Bs, owner = [], [], []
    for i in cand:
        for r in rings(sidx.B[i].poly):
            A.append(r[:-1]); Bs.append(r[1:]); owner.append(np.full(len(r) - 1, i))
    A, Bs, owner = np.vstack(A), np.vstack(Bs), np.concatenate(owner)
    bearings = np.arange(0, 360, BIN_DEG) + BIN_DEG / 2
    t, seg = cast(o, A, Bs, bearings)
    hit = np.isfinite(t) & (t >= MIN_D) & (t <= MAX_D)
    # угол падения
    br = np.radians(bearings)
    D = np.c_[np.sin(br), np.cos(br)]
    E = Bs[seg] - A[seg]
    En = E / np.maximum(np.linalg.norm(E, axis=1, keepdims=True), 1e-9)
    cosi = np.abs(D[:, 0] * En[:, 1] - D[:, 1] * En[:, 0])
    hit &= cosi >= MIN_COS
    # отбрасываем крайние бины каждого прогона (углы зданий, ошибки привязки) — сужение на 1 бин с каждой стороны
    same_prev = np.r_[seg[-1] == seg[0], seg[1:] == seg[:-1]] & np.r_[hit[-1], hit[:-1]]
    same_next = np.r_[seg[1:] == seg[:-1], seg[0] == seg[-1]] & np.r_[hit[1:], hit[0]]
    hit &= same_prev & same_next
    # освещённость: внешняя нормаль ребра (к камере) против азимута Солнца на момент съёмки
    nrm = np.c_[En[:, 1], -En[:, 0]]
    flip = (nrm * D).sum(1) > 0          # нормаль должна смотреть на камеру (против луча)
    nrm[flip] *= -1
    s_az, s_el = sun_az_el(cam.info["ts"], cam.info["lat"], cam.info["lon"])
    sd = np.array([np.sin(np.radians(s_az)), np.cos(np.radians(s_az))])
    lit = (s_el > 4.0) & ((nrm @ sd) > 0.12)

    H, W = img.shape[:2]
    lab_img = srgb_to_lab(img.reshape(-1, 3)).reshape(H, W, 3)
    sky = sky_mask_columns(lab_img)
    okpix = pixel_ok(lab_img) & ~sky
    # ясно/пасмурно: цвет неба в полосе
    skypx = lab_img[sky]
    clear = bool(len(skypx) > 500 and np.median(skypx[:, 2]) < -12)
    if not clear:
        lit[:] = False
    # основание фасада — рельеф в точке попадания луча (на склонах min под футпринтом занижает)
    hx, hy = o[0] + np.where(hit, t, 0) * D[:, 0], o[1] + np.where(hit, t, 0) * D[:, 1]
    zbase = dem.at(hx, hy)

    obs = {}
    cam_z = cam.z
    for k in np.nonzero(hit)[0]:
        bi = int(owner[seg[k]])
        b = sidx.B[bi]
        d = t[k]
        z0 = float(zbase[k])
        if b.hsrc == "default":
            # высота неизвестна: у мелких зданий берём заведомо «стенной» пояс 2–4.5 м (одноэтажки часты,
            # а завышенная высота даёт небо/дома за зданием); у жилых/крупных — 3–8 м (минимум 2–3 этажа)
            big = b.tags.get("building") in ("apartments", "residential", "dormitory", "office", "hotel") \
                or b.poly.area > 400
            z_lo_rel, z_hi_rel = (3.0, 8.0) if big else (Z_LO_DEFAULT, Z_HI_DEFAULT)
        else:
            z_lo_rel = Z_LO if b.height >= 5 else 1.5
            z_hi_rel = min(b.height - (1.0 if b.height >= 5 else 0.3), Z_HI)
        z_hi = z0 + z_hi_rel
        # низ: не ниже z_lo_rel над основанием и не ниже +MIN_ELEV над горизонтом (заборы, машины, кусты вдали)
        z_lo = max(z0 + z_lo_rel, cam_z + d * np.tan(np.radians(MIN_ELEV)))
        if z_hi - z_lo < 1.0:
            continue
        v_top = cam.v_of_elev(np.degrees(np.arctan2(z_hi - cam_z, d)))
        v_bot = cam.v_of_elev(np.degrees(np.arctan2(z_lo - cam_z, d)))
        v0, v1 = int(np.ceil(max(v_top, 0))), int(np.floor(min(v_bot, H - 1)))
        if v1 - v0 < 2:
            continue
        u = int(cam.u_of_bearing(bearings[k])) % W
        col_ok = okpix[v0:v1 + 1, u]
        px = lab_img[v0:v1 + 1, u][col_ok]
        o_ = obs.setdefault((bi, bool(lit[k])), {"px": [], "d": [], "cos": [], "nbin": 0, "ntot": 0, "segs": set(), "cols": []})
        o_["px"].append(px)
        o_["d"].append(d)
        o_["cos"].append(cosi[k])
        o_["nbin"] += 1
        o_["ntot"] += v1 - v0 + 1
        o_["segs"].add(int(seg[k]))
        if keep_geom:
            o_["cols"].append((u, v0, v1, float(bearings[k]), float(d)))
    res = {}
    for (bi, lt), o_ in obs.items():
        px = np.vstack(o_["px"]) if o_["px"] else np.zeros((0, 3))
        frac = len(px) / max(o_["ntot"], 1)
        if len(px) < MIN_PIX or frac < 0.25:
            continue
        lab, share, spread = kmeans_mode(px)
        d = float(np.median(o_["d"]))
        c = float(np.median(o_["cos"]))
        w = c * (1.0 / (1.0 + (d / 25.0) ** 2)) * min(1.0, len(px) / 300.0) * (0.5 + 0.5 * frac) * (0.5 + 0.5 * share)
        r = {"lab": [round(float(x), 2) for x in lab], "npix": int(len(px)), "frac": round(frac, 3),
             "share": round(float(share), 3), "spread": round(spread, 2), "d": round(d, 1), "cos": round(c, 3),
             "w": round(float(w), 4), "nbin": o_["nbin"], "lit": lt, "clear": clear, "sun_el": round(s_el, 1)}
        if keep_geom:
            r["cols"] = o_["cols"]
        res.setdefault(bi, []).append(r)
    return res


def weighted_median(x, w):
    o = np.argsort(x)
    cw = np.cumsum(w[o])
    return float(x[o][np.searchsorted(cw, cw[-1] / 2)])


def _wmed3(labs, w):
    return np.array([weighted_median(labs[:, j], w) for j in range(3)])


def calibrate_shade(obs_by_b):
    """Поправка «тень -> солнце» по зданиям, у которых есть и освещённые, и теневые наблюдения.
    Возвращает (kL, da, db): L_lit ≈ kL * L_shade, a_lit ≈ a_shade + da, b_lit ≈ b_shade + db."""
    rows = []
    for lst in obs_by_b.values():
        good = [o for o in lst if o["cos"] >= 0.5 and o["npix"] >= 300]
        lit = [o for o in good if o["lit"]]
        sh = [o for o in good if not o["lit"] and o.get("clear")]
        if not lit or not sh:
            continue
        a = _wmed3(np.array([o["lab"] for o in lit]), np.array([o["w"] for o in lit]))
        b = _wmed3(np.array([o["lab"] for o in sh]), np.array([o["w"] for o in sh]))
        if b[0] > 15:
            rows.append((a[0] / b[0], a[1] - b[1], a[2] - b[2]))
    if len(rows) < 20:
        return (1.0, 0.0, 0.0), len(rows)
    r = np.array(rows)
    kL = float(np.clip(np.median(r[:, 0]), 1.0, 1.6))
    return (kL, float(np.median(r[:, 1])), float(np.median(r[:, 2]))), len(rows)


def aggregate(B, obs_by_b):
    """Цвет здания = взвешенная медиана наблюдений в Lab; теневые наблюдения приводятся к «солнечным»
    калиброванной поправкой и весят меньше."""
    (kL, da, db), ncal = calibrate_shade(obs_by_b)
    out = {}
    for bi, lst in obs_by_b.items():
        labs, w, lit = [], [], []
        for o in lst:
            L, a, b = o["lab"]
            if not o["lit"] and o.get("clear"):
                L, a, b = min(L * kL, 96.0), a + da, b + db
            labs.append((L, a, b))
            w.append(o["w"] * (1.0 if o["lit"] else (0.5 if o.get("clear") else 0.6)))
            lit.append(o["lit"])
        labs, w = np.array(labs), np.array(w)
        med = _wmed3(labs, w)
        # отбрасываем выбросы (> 18 ΔE от взвешенной медианы), пересчитываем
        de = np.linalg.norm(labs - med, axis=1)
        keep = de <= 18.0
        if keep.sum() == 0:
            keep = de <= np.median(de)
        labs, w = labs[keep], w[keep]
        med = _wmed3(labs, w)
        spread = float(np.sqrt(np.average(np.linalg.norm(labs - med, axis=1) ** 2, weights=w))) if len(w) > 1 else 10.0
        W = float(w.sum())
        conf = (1 - np.exp(-W / 0.25)) * float(np.clip(1.15 - spread / 25.0, 0.2, 1.0))
        if len(w) == 1:
            conf *= 0.75
        if not any(lit):
            conf *= 0.8
        b = B[bi]
        out[b.key] = {"color": hexcolor(med), "confidence": round(float(np.clip(conf, 0, 1)), 2),
                      "samples": int(len(w)), "material": material_of(med), "levels_est": None,
                      "lab": [round(float(x), 1) for x in med], "spread": round(spread, 1),
                      "lit_samples": int(sum(lit))}
    return out, {"shade_correction": {"kL": round(kL, 3), "da": round(da, 2), "db": round(db, 2),
                                      "buildings_used": ncal}}


def run(B, dem, pano_ids, out_path, do_analyze=True):
    sidx = SceneIndex(B)
    if not do_analyze and out_path.exists():
        return {"facades": json.loads(out_path.read_text())["buildings"], "sidx": sidx}
    cl = Client()
    obs_by_b = defaultdict(list)
    raw = {}
    t0 = time.time()
    n_used = 0
    for n, pid in enumerate(pano_ids):
        img, sinfo = cl.strip(pid, cache_only=True)
        if img is None:
            continue
        info = pano_info(load_meta(pid))
        cam = PanoCam(info, sinfo["W"], sinfo["y0"], H=sinfo["H"])
        cam.z = float(dem.at(cam.x, cam.y)) + cam.z
        res = observe(pid, np.asarray(img), sinfo, cam, sidx, dem)
        if res:
            n_used += 1
        for bi, rs in res.items():
            for r in rs:
                r["pano"] = pid
                obs_by_b[bi].append(r)
        raw[pid] = {B[bi].key: rs for bi, rs in res.items()}
        if (n + 1) % 200 == 0:
            print(f"  analyze {n + 1}/{len(pano_ids)}  buildings seen {len(obs_by_b)}  {time.time() - t0:.0f}s",
                  flush=True)
    OBS_PATH.write_text(json.dumps(raw))
    fac, cal = aggregate(B, obs_by_b)
    stats = coverage(B, fac, len(pano_ids), n_used)
    stats.update(cal)
    out_path.write_text(json.dumps({"meta": {"source": "Yandex panoramas (personal use)",
                                             "method": "docs/stage1/facades.md", "stats": stats},
                                    "buildings": fac}, ensure_ascii=False, indent=0))
    print(json.dumps(stats, ensure_ascii=False, indent=1))
    return {"facades": fac, "sidx": sidx}


def coverage(B, fac, n_panos, n_used):
    from .scene import CORE_BBOX, bbox_poly
    core = bbox_poly(CORE_BBOX)
    tot = len(B)
    incore = [b for b in B if core.contains(b.poly.centroid)]
    area = sum(b.poly.area for b in B)
    cov_area = sum(b.poly.area for b in B if b.key in fac)
    conf = [v["confidence"] for v in fac.values()]
    mats = defaultdict(int)
    for v in fac.values():
        mats[v["material"]] += 1
    by_type = defaultdict(lambda: [0, 0])
    for b in B:
        t = b.tags.get("building", "yes")
        t = t if t in ("yes", "apartments", "house", "garages", "detached", "retail", "commercial", "office") else "other"
        by_type[t][0] += 1
        by_type[t][1] += b.key in fac
    return {
        "panoramas": n_panos, "panoramas_with_obs": n_used,
        "buildings_total": tot, "buildings_with_color": len(fac),
        "coverage_pct": round(100 * len(fac) / tot, 1),
        "coverage_area_pct": round(100 * cov_area / area, 1),
        "core_total": len(incore), "core_with_color": sum(b.key in fac for b in incore),
        "core_coverage_pct": round(100 * sum(b.key in fac for b in incore) / max(len(incore), 1), 1),
        "confidence_ge_0_5": sum(c >= 0.5 for c in conf),
        "confidence_median": float(np.median(conf)) if conf else 0,
        "materials": dict(mats),
        "by_type_total_covered": {k: v for k, v in by_type.items()},
    }
