"""Цвет: sRGB <-> Lab, маски неба/зелени/теней, робастный цвет стены, класс материала."""
import numpy as np

_M = np.array([[0.4124564, 0.3575761, 0.1804375],
               [0.2126729, 0.7151522, 0.0721750],
               [0.0193339, 0.1191920, 0.9503041]])
_MI = np.linalg.inv(_M)
_WP = np.array([0.95047, 1.0, 1.08883])


def srgb_to_lab(rgb):
    c = np.asarray(rgb, np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = lin @ _M.T / _WP
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], -1)


def lab_to_srgb(lab):
    lab = np.asarray(lab, np.float64)
    fy = (lab[..., 0] + 16) / 116
    fx = fy + lab[..., 1] / 500
    fz = fy - lab[..., 2] / 200
    f = np.stack([fx, fy, fz], -1)
    xyz = np.where(f > 6 / 29, f ** 3, 3 * (6 / 29) ** 2 * (f - 4 / 29)) * _WP
    lin = np.clip(xyz @ _MI.T, 0, 1)
    c = np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * lin ** (1 / 2.4) - 0.055)
    return np.clip(np.round(c * 255), 0, 255).astype(int)


def hexcolor(lab):
    r, g, b = lab_to_srgb(lab)
    return f"#{r:02x}{g:02x}{b:02x}"


def sky_like(lab):
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    C = np.hypot(a, b)
    return ((b < -10) & (L > 40)) | ((L > 90) & (C < 8))


def sky_mask_columns(lab_img):
    """Небо = непрерывный сверху ряд «небесных» пикселей в каждом столбце (допуск 2 пикселя-выброса)."""
    sk = sky_like(lab_img)
    H, W = sk.shape
    # ведущий прогон: накопленное число НЕ-небесных пикселей сверху <= 2 и сам пиксель небесный
    non = np.cumsum(~sk, axis=0)
    lead = sk & (non <= 2)
    # всё выше последнего «небесного» пикселя прогона + 3 пикселя вниз (кромка крыши) — небо
    last = np.where(lead.any(0), H - 1 - np.argmax(lead[::-1], axis=0), -10)
    rows = np.arange(H)[:, None]
    return rows <= (last + 3)[None, :]


def pixel_ok(lab):
    """Пиксели, годные как «стена»: не зелень, не небо, не глубокая тень/стекло, не пересвет."""
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    C = np.hypot(a, b)
    h = np.degrees(np.arctan2(b, a)) % 360
    green = (a < -6) & (b > -5)
    green |= (h > 100) & (h < 200) & (C > 7)            # листва, в т.ч. тёмная и жёлто-зелёная
    blue_sky = ((b < -12) & (L > 45)) | (b < -20)
    dark = L < 22
    blown = L > 97
    return ~(green | blue_sky | dark | blown)


def kmeans_mode(lab, k=4, iters=12, seed=0):
    """Цвет стены: k-means в Lab (L с половинным весом), затем выбор кластера по доле с бонусом за
    насыщенность — окна, рамы и белый декор нейтральны, а окрашенная стена обычно хроматична;
    у серых/белых домов хроматичных кластеров с заметной долей нет, и побеждает самый крупный.
    -> (медиана Lab кластера, доля, разброс)."""
    n = len(lab)
    if n < 20:
        return np.median(lab, 0), 1.0, float(np.std(lab, 0).mean())
    X = lab * np.array([0.5, 1.0, 1.0])
    rng = np.random.default_rng(seed)
    qs = np.quantile(X[:, 0], np.linspace(0.15, 0.85, k))
    cent = np.array([X[np.argmin(np.abs(X[:, 0] - q))] for q in qs])
    for _ in range(iters):
        d = ((X[:, None, :] - cent[None]) ** 2).sum(-1)
        lbl = d.argmin(1)
        for j in range(k):
            m = lbl == j
            cent[j] = X[m].mean(0) if m.any() else X[rng.integers(n)]
    cnt = np.bincount(lbl, minlength=k)
    best, score = None, -1
    for j in range(k):
        if cnt[j] < 0.15 * n:
            continue
        med = np.median(lab[lbl == j], 0)
        if med[0] < 33:
            continue
        sc = cnt[j] / n * (1 + np.hypot(med[1], med[2]) / 12.0)
        if sc > score:
            best, score = j, sc
    if best is None:
        best = cnt.argmax()
    sel = lab[lbl == best]
    return np.median(sel, 0), cnt[best] / n, float(np.std(sel, 0).mean())


MATERIALS = ["brick_red", "white_silicate_or_plaster", "panel_grey", "dark_grey", "plaster_beige",
             "plaster_yellow", "plaster_pink", "plaster_colored"]


def material_of(lab):
    """Эвристика только по цвету (фактуру на этом разрешении не различить)."""
    L, a, b = lab
    C = float(np.hypot(a, b))
    h = float(np.degrees(np.arctan2(b, a)) % 360)
    if C < 9:
        if L >= 68:
            return "white_silicate_or_plaster"
        if L >= 42:
            return "panel_grey"
        return "dark_grey"
    if 20 <= h < 60 and C >= 16 and L < 62:
        return "brick_red"
    if (h < 20 or h >= 330) and C >= 12:
        return "brick_red" if L < 55 else "plaster_pink"
    if 55 <= h < 100:
        return "plaster_yellow" if C >= 22 else "plaster_beige"
    if 20 <= h < 55:
        return "plaster_beige" if C < 22 else "plaster_pink"
    if C < 14:
        return "white_silicate_or_plaster" if L >= 68 else "panel_grey"
    return "plaster_colored"
