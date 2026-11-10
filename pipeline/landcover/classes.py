"""Классы покрова, сетка 1 м мира и общие пути."""
import math

from config import BBOX, DATA_PROCESSED, ROOT, to_world

TILE = 250.0
RES = 1.0

# код класса (uint8 в растре; 0 — нет данных). Порядок = индекс в модели + 1.
CLASSES = [
    ("canopy", "кроны лиственных", (40, 120, 30)),
    ("conifer", "кроны хвойных", (10, 70, 40)),
    ("thicket", "заросли (клён ясенелистный, ивняк, молодняк)", (150, 190, 40)),
    ("meadow", "высокая трава / луг / поле", (200, 210, 90)),
    ("lawn", "газон (кошеный)", (110, 220, 110)),
    ("garden", "огород / грядки", (170, 110, 60)),
    ("bare", "голый грунт / вытоптано", (150, 120, 90)),
    ("sand", "песок", (240, 225, 160)),
    ("gravel", "щебень / промплощадка / балласт", (150, 150, 160)),
    ("water", "вода", (40, 90, 200)),
    ("paved", "асфальт / плитка", (70, 70, 75)),
    ("building", "крыши", (230, 60, 60)),
]
NAMES = [c[0] for c in CLASSES]
C = {n: i + 1 for i, n in enumerate(NAMES)}      # имя -> код
NCLS = len(CLASSES)
PALETTE = [(0, 0, 0)] + [c[2] for c in CLASSES]

OUT = DATA_PROCESSED / "landcover"
ORTHO = DATA_PROCESSED / "ortho"
MANUAL = ROOT / "data" / "landcover"      # ручные метки (обучение) и точки проверки (не для обучения)


def world_bounds():
    """Как build_world.world_bounds: (min_x, max_x, min_y, max_y), кратно тайлу."""
    S, W, N, E = BBOX
    xs, ys = to_world.transform([W, E, W, E], [S, S, N, N])
    snap = lambda v, f: f(v / TILE) * TILE
    return snap(min(xs), math.floor), snap(max(xs), math.ceil), snap(min(ys), math.floor), snap(max(ys), math.ceil)


class Grid1m:
    """Растр 1 м на весь мир: строка 0 = север (max_y), столбец 0 = min_x (как маски yards.py)."""

    def __init__(self):
        self.min_x, self.max_x, self.min_y, self.max_y = world_bounds()
        self.cols = int(round(self.max_x - self.min_x))
        self.rows = int(round(self.max_y - self.min_y))

    def rc(self, x, y):
        import numpy as np
        return (np.floor(self.max_y - np.asarray(y, float)).astype(int), np.floor(np.asarray(x, float) - self.min_x).astype(int))

    def xy(self, r, c):
        import numpy as np
        return self.min_x + np.asarray(c) + 0.5, self.max_y - np.asarray(r) - 0.5

    @property
    def transform(self):
        from rasterio.transform import from_origin
        return from_origin(self.min_x, self.max_y, RES, RES)
