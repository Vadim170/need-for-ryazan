"""Сверка hero-модели с панорамами (docs/stage2/landmarks.md): камеры панорам -> локальные координаты модели.
  cd pipeline && uv run python landmark_compare.py <id> [--world ../game/public/world] [--crops 16,19,21]
Пишет data/processed/landmarks/<id>_cams.json; рендер — blender -b --python assets/scripts/landmarks/compare_render.py --
<id> <cams.json>; затем этот же скрипт с --compose склеивает «панорама | модель» в data/processed/landmarks/<id>_compare.jpg.
"""
import argparse, json, math
import numpy as np
from PIL import Image, ImageDraw
from config import DATA_PROCESSED, DATA_RAW, ROOT, to_world

ap = argparse.ArgumentParser()
ap.add_argument("id"); ap.add_argument("--world", default=str(ROOT / "game" / "public" / "world"))
ap.add_argument("--crops", default=""); ap.add_argument("--compose", action="store_true")
a = ap.parse_args()
OUT = DATA_PROCESSED / "landmarks"
man = {l["id"]: l for l in json.loads((ROOT / "game/public/assets/landmarks/landmarks.json").read_text())["landmarks"]}
lm = man[a.id]
idx = json.loads((DATA_RAW / "panoramas/landmarks" / a.id / "index.json").read_text())
sel = [int(x) for x in a.crops.split(",")] if a.crops else list(range(len(idx["panoramas"])))
camf = OUT / f"{a.id}_cams.json"
if not a.compose:
    from pathlib import Path
    W = Path(a.world)
    m = json.loads((W / "manifest.json").read_text()); t = m["terrain"]
    H = np.fromfile(W / t["file"], np.float32).reshape(t["rows"], t["cols"])
    def h(x, z):
        fx = (x - t["minX"]) / t["cellSize"]; fz = (z - t["minZ"]) / t["cellSize"]
        c, r = int(fx), int(fz); tx, tz = fx - c, fz - r
        return float((H[r, c] * (1 - tx) + H[r, c + 1] * tx) * (1 - tz) + (H[r + 1, c] * (1 - tx) + H[r + 1, c + 1] * tx) * tz)
    r = lm["rotY"]; cr, sr = math.cos(r), math.sin(r)
    w = lambda x, z: (lm["x"] + x * cr + z * sr, lm["z"] - x * sr + z * cr)
    y0 = min(h(*w(x, z)) for x, z in lm["ground"]["points"]) + lm.get("yOffset", 0)
    A = (-r) % (2 * math.pi)                 # азимут переда модели
    cams = []
    for k in sel:
        p = idx["panoramas"][k]
        x, y = to_world.transform(p["lon"], p["lat"])
        dx, dy = x - lm["x"], y - (-lm["z"])
        lx = dx * math.cos(A) - dy * math.sin(A); ly = dx * math.sin(A) + dy * math.cos(A)
        dist = p["dist"]; half = p["hfov"] / 2
        th = {"drama_theatre": 12, "circus": 12, "lenin_monument": 6}.get(a.id, 12)
        pitch = min(math.degrees(math.atan2(th - 2.5, dist)), 35)
        cams.append({"k": k, "crop": str(DATA_RAW / "panoramas/landmarks" / a.id / p["crop"]),
                     "x": lx, "y": ly, "z": h(x, -y) + 2.6 - y0, "yaw": math.degrees(math.radians(p["bearing_to_obj"]) - A),
                     "pitch": pitch, "hfov": p["hfov"]})
    camf.write_text(json.dumps({"id": a.id, "glb": str(ROOT / "assets/build/landmarks" / a.id / f"{a.id}_raw.glb"), "cams": cams,
                                "out": str(OUT / f"{a.id}_cmp")}, indent=1))
    print(camf, len(cams), "камер; модель y0", round(y0, 2))
else:
    cams = json.loads(camf.read_text())["cams"]
    rows = []
    for c in cams:
        ref = Image.open(c["crop"]).convert("RGB").resize((640, 450))
        ren = Image.open(OUT / f"{a.id}_cmp" / f"{c['k']:02d}.png").convert("RGB").resize((640, 450))
        row = Image.new("RGB", (1280, 450)); row.paste(ref, (0, 0)); row.paste(ren, (640, 0))
        ImageDraw.Draw(row).text((8, 8), f"#{c['k']} панорама | модель", fill=(255, 255, 0))
        rows.append(row)
    S = Image.new("RGB", (1280, 450 * len(rows)))
    for i, r_ in enumerate(rows):
        S.paste(r_, (0, 450 * i))
    S.save(OUT / f"{a.id}_compare.jpg", quality=85)
    print(OUT / f"{a.id}_compare.jpg")
