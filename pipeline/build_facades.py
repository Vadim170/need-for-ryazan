"""Цвет/материал фасадов зданий по панорамам Яндекса.

Этапы:
  fetch    — точки вдоль дорог (шаг --step м) -> поиск ближайших панорам -> метаданные + полосы изображений
  analyze  — видимость фасадов, проекция в панорамы, робастный цвет, агрегация по зданиям
  check    — контрольные картинки data/processed/facades_check/*.png и карта

Примеры:
  uv run python build_facades.py fetch --area core
  uv run python build_facades.py fetch --area all
  uv run python build_facades.py analyze check
Повторный запуск продолжает с кэша data/raw/panoramas/.
"""
import argparse
import json
import sys
import time

from config import BBOX, DATA_PROCESSED
from facades.scene import CORE_BBOX, bbox_poly, load_scene, road_samples
from facades.yandex import META_DIR, Client, load_meta, pano_info

OUT = DATA_PROCESSED / "building_facades.json"
PANO_LIST = DATA_PROCESSED / "facades_panos.json"


def area_poly(name):
    return bbox_poly(CORE_BBOX if name == "core" else BBOX)


def cmd_fetch(args, osm):
    cl = Client(rate=args.rate, workers=args.workers)
    pts, ll = road_samples(osm, args.step, area_poly(args.area))
    todo = sum(1 for la, lo in ll if cl.key(la, lo) not in cl.lookup)
    print(f"sample points: {len(ll)} (uncached {todo})", flush=True)
    t0 = time.time()
    pids = cl.find_many([tuple(p) for p in ll], progress=lambda d, n: print(
        f"  lookup {d}/{n}  req={cl.n_req} err={cl.n_err}  {time.time() - t0:.0f}s", flush=True))
    uniq = sorted({p for p in pids if p})
    print(f"unique panoramas: {len(uniq)} (no pano: {sum(1 for p in pids if not p)})", flush=True)
    # дедуп по месту: панорамы ближе 8 м друг к другу — оставляем самую свежую
    infos = [pano_info(load_meta(p)) for p in uniq]
    from config import to_world
    import numpy as np
    xy = np.array([to_world.transform(i["lon"], i["lat"]) for i in infos])
    order = np.argsort([-i["ts"] for i in infos])
    keep = []
    for k in order:
        if all(np.hypot(*(xy[k] - xy[j])) > args.min_sep for j in keep[-400:]):
            keep.append(k)
    sel = [uniq[k] for k in keep]
    print(f"after {args.min_sep} m spacing: {len(sel)}", flush=True)
    done = 0
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(4) as ex:
      for _ in ex.map(lambda p: cl.strip(p)[1], sel):
        done += 1
        if done % 50 == 0:
            print(f"  images {done}/{len(sel)} req={cl.n_req} err={cl.n_err} {time.time() - t0:.0f}s", flush=True)
    prev = json.loads(PANO_LIST.read_text()) if PANO_LIST.exists() else []
    allp = sorted(set(prev) | set(sel))
    PANO_LIST.write_text(json.dumps(allp))
    print(f"done: {len(sel)} panoramas in area, {len(allp)} total; requests {cl.n_req}, errors {cl.n_err}, "
          f"{time.time() - t0:.0f}s", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stages", nargs="+", choices=["fetch", "analyze", "check"])
    ap.add_argument("--area", default="core", choices=["core", "all"])
    ap.add_argument("--step", type=float, default=50.0)
    ap.add_argument("--min-sep", type=float, default=15.0)
    ap.add_argument("--rate", type=float, default=4.0)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--n-check", type=int, default=12)
    args = ap.parse_args()
    osm, buildings, dem = load_scene()
    if "fetch" in args.stages:
        cmd_fetch(args, osm)
    if "analyze" in args.stages or "check" in args.stages:
        from facades import analyze
        res = analyze.run(buildings, dem, json.loads(PANO_LIST.read_text()), OUT,
                          do_analyze="analyze" in args.stages)
        if "check" in args.stages:
            from facades import viz
            viz.run(buildings, dem, res, n=args.n_check)


if __name__ == "__main__":
    sys.exit(main())
