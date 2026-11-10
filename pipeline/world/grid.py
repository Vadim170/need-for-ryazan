"""Сетка высот мира: узлы через cell м, строка 0 = север. Выборка высоты в точке теми же треугольниками,
что у коллайдера (диагональ ячейки от узла (r,c) к (r+1,c+1), как в heightfield Rapier)."""
import numpy as np


class Grid:
    def __init__(self, min_x, max_x, min_y, max_y, cell):
        self.min_x, self.max_x, self.min_y, self.max_y, self.cell = min_x, max_x, min_y, max_y, cell
        self.cols = int(round((max_x - min_x) / cell)) + 1
        self.rows = int(round((max_y - min_y) / cell)) + 1

    # узлы
    def node_xy(self):
        xs = self.min_x + np.arange(self.cols) * self.cell
        ys = self.max_y - np.arange(self.rows) * self.cell
        return xs, ys

    def to_rc(self, x, y):
        return (self.max_y - np.asarray(y)) / self.cell, (np.asarray(x) - self.min_x) / self.cell

    def sample(self, h, x, y):
        """Высота в (x, y) мировых: кусочно-линейно по треугольникам ячейки."""
        r, c = self.to_rc(x, y)
        r = np.clip(r, 0, self.rows - 1 - 1e-9); c = np.clip(c, 0, self.cols - 1 - 1e-9)
        r0 = np.floor(r).astype(np.int64); c0 = np.floor(c).astype(np.int64)
        fr = r - r0; fc = c - c0
        h00 = h[r0, c0]; h11 = h[r0 + 1, c0 + 1]
        h10 = h[r0 + 1, c0]; h01 = h[r0, c0 + 1]
        # треугольник A: (00,10,11) при fr >= fc; B: (00,11,01) при fr < fc
        a = fr >= fc
        za = h00 + fr * (h10 - h00) + fc * (h11 - h10)
        zb = h00 + fc * (h01 - h00) + fr * (h11 - h01)
        return np.where(a, za, zb)

    def sample_bilinear(self, h, x, y):
        from scipy.ndimage import map_coordinates
        r, c = self.to_rc(x, y)
        return map_coordinates(h, [np.atleast_1d(r), np.atleast_1d(c)], order=1, mode="nearest")
