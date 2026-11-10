"""Маска растительности для травы в игре: зелёность спутника (yandex_2m.tif, WORLD_CRS) → один PNG на весь мир.

Пишет game/public/world-veg/veg.png (+ veg.json) — ВНЕ game/public/world/ (build_world.py его пересоздаёт).
Пиксель: 4 м, строка 0 = север (min three.z), столбец 0 = min x (как heightmap). Значение 0..255 — «насколько тут
зелено» (индекс ExG = 2g − r − b по нормированным каналам, тени и асфальт → 0). Игра: game/src/world/grass.ts.

    cd pipeline && uv run python build_vegmask.py
"""
import json
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data/processed/ortho/yandex_2m.tif"
OUT = ROOT / "game/public/world-veg"
CELL = 4.0


def main() -> None:
    man = json.loads((ROOT / "game/public/world/manifest.json").read_text())
    b = man["bounds"]  # координаты игры: z = -y
    min_x, max_x = b["minX"], b["maxX"]
    min_y, max_y = -b["maxZ"], -b["minZ"]
    cols = int(round((max_x - min_x) / CELL))
    rows = int(round((max_y - min_y) / CELL))
    with rasterio.open(SRC) as r:
        win = from_bounds(min_x, min_y, max_x, max_y, r.transform)
        rgb = r.read(window=win, out_shape=(3, rows, cols), resampling=Resampling.average, boundless=True, fill_value=0).astype(np.float32)
    s = rgb.sum(0) + 1e-3
    rn, gn, bn = rgb[0] / s, rgb[1] / s, rgb[2] / s
    exg = 2 * gn - rn - bn
    lum = s / 3
    v = np.clip((exg - 0.015) / 0.11, 0, 1)
    v[lum < 25] *= 0.6  # глубокие тени — неуверенно
    v[s < 1] = 0  # вне снимка
    img = (v * 255).round().astype(np.uint8)  # строка 0 = север = max y = min three.z
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img, "L").save(OUT / "veg.png", optimize=True)
    (OUT / "veg.json").write_text(json.dumps({"version": 1, "cell": CELL, "cols": cols, "rows": rows, "minX": min_x, "minZ": b["minZ"], "source": SRC.name}, indent=1))
    print(f"veg.png {cols}x{rows}, mean {v.mean():.2f}, {(OUT / 'veg.png').stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
