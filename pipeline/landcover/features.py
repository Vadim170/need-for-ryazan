"""Признаки пикселя 1 м по двум снимкам 0.5 м (Яндекс — лето, надир; Esri — другая дата, длинные тени) + контекст.

Все фильтры считаются на 0.5 м, потом среднее 2×2 → 1 м. Чанк читается с полем MARGIN м (фильтры не видят края).
"""
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from scipy.ndimage import gaussian_filter, uniform_filter, sobel

from .classes import ORTHO

MARGIN = 48           # м
# направление тени (мировые x восток, y север; от предмета к тени), оценено по зданиям OSM (estimate_shadow_dir)
SHADOW_DIR = {"yandex": (-0.26, 0.97), "esri": (-0.26, 0.97)}
SHADOW_D = (2.0, 4.0, 8.0)      # м — «высота» через тень на этом расстоянии

CTX_FEATS = ["house_frac", "slope", "relief"]   # без d_bld/d_road/d_water: они почти совпадают с источниками меток (утечка)


def read(src, x0, y0, x1, y1):
    """RGB float32 0..1 (3, h, w) на 0.5 м, строка 0 = север."""
    with rasterio.open(ORTHO / f"{src}.tif") as r:
        w = from_bounds(x0, y0, x1, y1, r.transform)
        a = r.read(window=w, boundless=True, fill_value=0, out_shape=(3, int(round((y1 - y0) * 2)), int(round((x1 - x0) * 2))))
    return a.astype(np.float32) / 255.0


def down2(a):
    h, w = a.shape[-2] // 2 * 2, a.shape[-1] // 2 * 2
    a = a[..., :h, :w]
    return 0.25 * (a[..., 0::2, 0::2] + a[..., 1::2, 0::2] + a[..., 0::2, 1::2] + a[..., 1::2, 1::2])


def shift(a, dr, dc):
    """out[r, c] = a[r + dr, c + dc] (целые пиксели, края — повтор)."""
    h, w = a.shape
    rr = np.clip(np.arange(h) + dr, 0, h - 1)
    cc = np.clip(np.arange(w) + dc, 0, w - 1)
    return a[rr][:, cc]


def align(ref, mov, maxs=14):
    """Целочисленный сдвиг (dr, dc) mov относительно ref по фазовой корреляции градиентов (≤ maxs пикселей)."""
    def prep(x):
        g = np.hypot(sobel(gaussian_filter(x, 1.5), 0), sobel(gaussian_filter(x, 1.5), 1))
        g -= g.mean()
        return g * np.hanning(g.shape[0])[:, None] * np.hanning(g.shape[1])[None, :]
    A, Bm = np.fft.rfft2(prep(ref)), np.fft.rfft2(prep(mov))
    R = A * np.conj(Bm)
    R /= np.abs(R) + 1e-9
    c = np.fft.irfft2(R, s=ref.shape)
    c = np.fft.fftshift(c)
    h, w = c.shape
    sub = c[h // 2 - maxs: h // 2 + maxs + 1, w // 2 - maxs: w // 2 + maxs + 1]
    i, j = np.unravel_index(np.argmax(sub), sub.shape)
    return -(i - maxs), -(j - maxs)


def colour(rgb):
    r, g, b = rgb
    s = r + g + b + 1e-3
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    exg = (2 * g - r - b) / s
    vari = np.clip((g - r) / (g + r - b + 1e-2), -1, 1)
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    sat = (mx - mn) / (mx + 1e-3)
    # тон: угол в плоскости (r−g, g−b) — cos/sin
    hx = (2 * r - g - b) / 2
    hy = (np.sqrt(3) / 2) * (g - b)
    hn = np.hypot(hx, hy) + 1e-3
    return dict(r=r, g=g, b=b, lum=lum, exg=exg, vari=vari, sat=sat, hcos=hx / hn, hsin=hy / hn, bratio=b / s, rratio=r / s)


def shadow_mask(c):
    """Тень: тёмное (абсолютно и относительно окрестности 15 м) и синеватое."""
    loc = gaussian_filter(c["lum"], 30)
    return ((c["lum"] < 0.16) | (c["lum"] < 0.55 * loc)) & (c["bratio"] > 0.28) & (c["lum"] < 0.3)


def lstd(x, size):
    m = uniform_filter(x, size)
    return np.sqrt(np.maximum(uniform_filter(x * x, size) - m * m, 0))


def chunk(x0, y0, x1, y1, ctx_slices):
    """Признаки для прямоугольника мира [x0,x1]×[y0,y1] (кратно 1 м). ctx_slices — dict контекста той же области 1 м.
    Возвращает (F float32 (n, h, w), names)."""
    m = MARGIN
    Y = read("yandex_0.5m", x0 - m, y0 - m, x1 + m, y1 + m)
    E = read("esri_0.5m", x0 - m, y0 - m, x1 + m, y1 + m)
    valid = (Y.sum(0) > 0.02)
    cy = colour(Y)
    # Esri: совместить с Яндексом (сдвиг привязки 2–5 м)
    ce0 = colour(E)
    dr, dc = align(cy["lum"], ce0["lum"])
    E = np.stack([shift(E[i], -dr, -dc) for i in range(3)])
    ce = colour(E)
    F, names = [], []

    def add(name, a):
        names.append(name)
        F.append(down2(a.astype(np.float32)))

    # --- Яндекс: цвет пикселя
    for k in ("r", "g", "b", "lum", "exg", "vari", "sat", "hcos", "hsin", "bratio"):
        add("y_" + k, cy[k])
    # окрестность 3 и 10 м
    for k in ("exg", "lum", "sat", "rratio", "bratio"):
        add("y_" + k + "_s3", gaussian_filter(cy[k], 6))
    for k in ("exg", "lum"):
        add("y_" + k + "_s10", gaussian_filter(cy[k], 20))
    # фактура
    L = cy["lum"]
    add("y_std2", lstd(L, 4))
    add("y_std5", lstd(L, 10))
    add("y_std5_s10", gaussian_filter(lstd(L, 10), 20))
    add("y_exgstd5", lstd(cy["exg"], 10))
    dog = np.abs(gaussian_filter(L, 1.0) - gaussian_filter(L, 3.0))
    add("y_dog", gaussian_filter(dog, 4))
    dog2 = np.abs(gaussian_filter(L, 3.0) - gaussian_filter(L, 8.0))
    add("y_dog2", gaussian_filter(dog2, 8))
    # полосы (грядки, покос): когерентность структурного тензора на 3 м
    Ls = gaussian_filter(L, 1.0)
    gx, gy = sobel(Ls, 1), sobel(Ls, 0)
    J11, J22, J12 = (gaussian_filter(v, 6) for v in (gx * gx, gy * gy, gx * gy))
    tr = J11 + J22 + 1e-6
    add("y_coh", np.sqrt((J11 - J22) ** 2 + 4 * J12 ** 2) / tr)
    add("y_energy", np.log(tr + 1e-4))
    # тени и «высота» (тень на расстоянии d по направлению тени)
    for src, cc in (("y", cy), ("e", ce)):
        S = shadow_mask(cc).astype(np.float32)
        add(src + "_shadow", gaussian_filter(S, 1.0))
        Sb = uniform_filter(S, 6)
        dx, dy = SHADOW_DIR["yandex" if src == "y" else "esri"]
        for d in SHADOW_D:
            add(f"{src}_sh{int(d)}", shift(Sb, int(round(-dy * d * 2)), int(round(dx * d * 2))))
    # --- Esri (другой сезон): сглаженный цвет и фактура
    for k in ("r", "g", "b", "lum", "exg", "sat"):
        add("e_" + k + "_s1", gaussian_filter(ce[k], 2))
    add("e_exg_s4", gaussian_filter(ce["exg"], 8))
    add("e_std5", lstd(ce["lum"], 10))
    # сезонные разности
    add("d_exg", gaussian_filter(cy["exg"], 4) - gaussian_filter(ce["exg"], 4))
    add("d_lum", gaussian_filter(cy["lum"], 4) - gaussian_filter(ce["lum"], 4))
    add("valid", valid.astype(np.float32))
    mm = m  # поле в 1 м
    F = np.stack(F)[:, mm: F[0].shape[0] - mm, mm: F[0].shape[1] - mm]
    for k in CTX_FEATS:
        names.append(k)
    F = np.concatenate([F, np.stack([ctx_slices[k].astype(np.float32) for k in CTX_FEATS])], 0)
    return F, names, (dr, dc)


def estimate_shadow_dir(src, x0, y0, x1, y1, bld_mask):
    """Направление тени по зданиям: максимум доли тени на расстоянии 4–10 м от здания в направлении θ."""
    a = read(src, x0, y0, x1, y1)
    S = shadow_mask(colour(a))
    S1 = down2(S.astype(np.float32))
    best = None
    for th in np.radians(np.arange(0, 360, 5)):
        dx, dy = np.cos(th), np.sin(th)
        v = 0
        for d in (4, 7, 10):
            sh = shift(S1, int(round(-dy * d)), int(round(dx * d)))
            v += sh[bld_mask].mean()
        if best is None or v > best[0]:
            best = (v, dx, dy, np.degrees(th))
    return best
