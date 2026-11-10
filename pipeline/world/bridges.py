"""Мосты: профиль настила, насыпи у опор, поверхность ленты и толщина плиты.

Правила:
- настил = верхняя огибающая (линия между опорами, «шатёр» над дорогами снизу, сглаженный рельеф под осью),
  с ограничением уклона, концы на высотах перекрёстков;
- участок, где настил низко над землёй (< EMBANK_CLEAR) или ближе END_LEN к наземной опоре, считается насыпью:
  рельеф вжимается до настила (как у дороги), поверхность ленты = рельеф + 0.05;
- у наземной опоры поверхность ленты плавно переходит от рельефа к настилу на END_LEN, поэтому ступеньки нет;
- плита-коллайдер на концах сходит на нет (толщина от SLAB_MIN до полной на END_LEN).
"""
import numpy as np
from scipy.ndimage import gaussian_filter1d

from .roads import BRIDGE_GRADE, MAX_GRADE, base_class, clamp_grade, cumlen, left_normals, resample

END_LEN = 12.0        # м: насыпь у наземной опоры
EMBANK_CLEAR = 1.0    # м: ниже — не пролёт, а насыпь
CROSS_KEEP = 12.0     # м: у дороги снизу насыпь не делаем
RAIL_KEEP = 6.0       # м: у ж/д под пролётом насыпь не делаем
RAIL_S = {}           # r.id -> [s пересечений с ж/д] (заполняет world/structures.bridge_lower_bounds)
SLAB_MIN = 0.05
ROUND_M = 8.0         # м: сигма скругления профиля настила
TENT_EXTRA = 0.5      # м: запас «шатра» на скругление вершины


def deck_profile(r, zj, grid, h1, ground_end, step=2.0):
    """Профиль настила моста r. ground_end = (bool начало, bool конец) — опора на землю (не середина моста)."""
    P = resample(r.axis, step)
    s = cumlen(P)
    L = max(s[-1], 1e-6)
    zA, zB = zj[r.frm], zj[r.to]
    z = zA + (zB - zA) * s / L
    cross = getattr(r, "cross", None) or []
    g_lim = max(BRIDGE_GRADE, MAX_GRADE.get(base_class(r.hw), 0.08))
    if cross:
        tent = np.max([cz + TENT_EXTRA - BRIDGE_GRADE * np.abs(s - cs) for cs, cz, *_ in cross], axis=0)
        cap = np.minimum(zA + BRIDGE_GRADE * s, zB + BRIDGE_GRADE * (L - s))
        z = np.maximum(z, np.minimum(tent, cap))
    # рельеф под осью и по краям настила (максимум), сглаженный: если земля выше линии — это насыпь
    hw = max(r.Wf, r.Wb) if r.bwd is not None else r.Wf / 2
    n = left_normals(P)
    ht = np.max([grid.sample_bilinear(h1, *(P + k * hw * n).T) for k in (-1.0, 0.0, 1.0)], axis=0)
    if len(ht) > 3:
        ht = gaussian_filter1d(ht, 15.0 / step, mode="nearest")
    z = np.maximum(z, ht)
    r.axis, r.z_axis, r.s_axis = P, z, s
    r.ground_end = ground_end
    r.end_w = (zA, zB)   # временно: высоты опор до finalize_deck


def harmonize(bridges, radius=20.0, iters=2):
    """Параллельные мосты (две проезжие части одного путепровода) выравниваем по высоте: среднее с ближайшей
    точкой соседнего моста в пределах radius. Иначе насыпь одного вылезает стенкой рядом с другим."""
    from scipy.spatial import cKDTree
    if len(bridges) < 2:
        return
    for _ in range(iters):
        pts = np.concatenate([b.axis for b in bridges])
        zs = np.concatenate([b.z_axis for b in bridges])
        owner = np.concatenate([np.full(len(b.axis), i) for i, b in enumerate(bridges)])
        tree = cKDTree(pts)
        new = []
        for i, b in enumerate(bridges):
            d, idx = tree.query(b.axis, k=8, distance_upper_bound=radius)
            z = b.z_axis.copy()
            for row in range(len(z)):
                other = [j for dd, j in zip(d[row], idx[row]) if np.isfinite(dd) and owner[j] != i]
                if other:
                    z[row] = 0.5 * (z[row] + zs[other[0]])
            new.append(z)
        for b, z in zip(bridges, new):
            b.z_axis = z


def finalize_deck(r, grid, h1):
    """Концы на высотах опор, ограничение уклона, разметка насыпи/пролёта."""
    P, z, s = r.axis, r.z_axis.copy(), r.s_axis
    L = max(s[-1], 1e-6)
    zA, zB = r.end_w
    ground_end = r.ground_end
    cross = getattr(r, "cross", None) or []
    g_lim = max(BRIDGE_GRADE, MAX_GRADE.get(base_class(r.hw), 0.08))
    z[0], z[-1] = zA, zB
    z = clamp_grade(z, s, g_lim)
    # скругляем переломы («шатёр» над дорогой снизу): гаусс + поправка, чтобы концы остались на опорах
    if len(z) > 5:
        zs = gaussian_filter1d(z, ROUND_M / max(s[1] - s[0], 0.5), mode="nearest")
        t = s / L
        z = zs + (zA - zs[0]) * (1 - t) + (zB - zs[-1]) * t
        z = clamp_grade(z, s, g_lim)
    r.clearance_ok = all(np.interp(cs, s, z) >= cz - 0.3 for cs, cz, *_ in cross) if cross else True
    # насыпь: близко к наземной опоре или низко над землёй (и не над дорогой снизу)
    ground = grid.sample_bilinear(h1, P[:, 0], P[:, 1])
    near_cross = np.zeros(len(s), bool)
    for cs, *_ in cross:
        near_cross |= np.abs(s - cs) < CROSS_KEEP
    # длина перехода к рельефу у опоры: не дальше, чем до зоны дороги снизу
    cs_all = np.array([c[0] for c in cross]) if cross else np.array([])
    rail_s = RAIL_S.get(r.id, ())
    for cs in rail_s:
        near_cross |= np.abs(s - cs) < RAIL_KEEP
    len_a = min([END_LEN] + [max(cs - CROSS_KEEP, 2.0) for cs in cs_all] + [max(cs - RAIL_KEEP, 2.0) for cs in rail_s])
    len_b = min([END_LEN] + [max(L - cs - CROSS_KEEP, 2.0) for cs in cs_all] + [max(L - cs - RAIL_KEEP, 2.0) for cs in rail_s])
    # переход не должен доходить до «висячего» конца (там настил стыкуется с площадкой на высоте узла)
    if not ground_end[0]:
        len_b = min(len_b, L)
    if not ground_end[1]:
        len_a = min(len_a, L)
    end_w = np.zeros(len(s))
    if ground_end[0]:
        end_w = np.maximum(end_w, np.clip(1 - s / len_a, 0, 1))
    if ground_end[1]:
        end_w = np.maximum(end_w, np.clip(1 - (L - s) / len_b, 0, 1))
    end_w[near_cross] = 0.0
    embank = (((z - ground) < EMBANK_CLEAR) | (end_w > 0)) & ~near_cross
    r.end_len = (len_a, len_b)
    r.z_axis = z
    r.embank, r.end_w = embank, end_w
    return P, z


def surface(r, s_query, x, y, H, grid, base, lift):
    """Высота поверхности ленты моста (в координатах игры) в точках (x, y) с координатой s вдоль оси."""
    zd = np.interp(s_query, r.s_axis, r.z_axis)
    w = np.interp(s_query, r.s_axis, r.end_w)
    emb = np.interp(s_query, r.s_axis, r.embank.astype(float)) > 0.5
    zt = grid.sample(H, x, y)
    z = zd + w * (zt - zd)                       # переход к рельефу у опор
    z = np.where(emb & (w == 0), np.maximum(zd, zt), z)   # на насыпи не ниже рельефа
    return z - base + lift


def slab_thickness(r, s_query, full):
    L = r.s_axis[-1]
    t = np.full(len(s_query), full)
    la, lb = r.end_len
    if r.ground_end[0]:
        t = np.minimum(t, SLAB_MIN + (full - SLAB_MIN) * np.clip(s_query / la, 0, 1))
    if r.ground_end[1]:
        t = np.minimum(t, SLAB_MIN + (full - SLAB_MIN) * np.clip((L - s_query) / lb, 0, 1))
    return t


def underpass_samples(roads, reach=60.0):
    """Точки дорог под мостами (с выемкой) в пределах reach от пересечения: [x, y, z, hw]."""
    out = []
    for b in roads:
        for cs, cz, g, sg in (getattr(b, "cross", None) or []):
            m = np.abs(g.s_axis - sg) < reach
            hw = max(g.Wf, g.Wb) if g.bwd is not None else g.Wf / 2
            out.append(np.c_[g.axis[m], g.z_axis[m], np.full(m.sum(), hw)])
    return np.concatenate(out) if out else np.zeros((0, 4))


def enforce_underpasses(H, grid, samples, margin=1.0):
    """Рельеф в ядре дорог под мостами не выше их профиля (сглаживание вжатия не должно съедать габарит)."""
    from scipy.spatial import cKDTree
    if len(samples) == 0:
        return H
    xs, ys = grid.node_xy()
    R = samples[:, 3].max() + margin
    x0, y0 = samples[:, :2].min(0) - R; x1, y1 = samples[:, :2].max(0) + R
    ci = np.where((xs >= x0) & (xs <= x1))[0]; ri = np.where((ys >= y0) & (ys <= y1))[0]
    gx, gy = np.meshgrid(xs[ci], ys[ri])
    d, i = cKDTree(samples[:, :2]).query(np.c_[gx.ravel(), gy.ravel()], distance_upper_bound=R)
    ok = np.isfinite(d)
    ok[ok] = d[ok] <= samples[i[ok], 3] + margin
    sub = H[np.ix_(ri, ci)].ravel()
    sub[ok] = np.minimum(sub[ok], samples[i[ok], 2])
    H = H.copy()
    H[np.ix_(ri, ci)] = sub.reshape(len(ri), len(ci))
    return H


def terrain_samples(r):
    """(burn, clamp): точки для вжатия (насыпь) [x,y,z,hw] и для опускания рельефа под пролётом [x,y,z,hw,clear]."""
    hw = max(r.Wf, r.Wb) if r.bwd is not None else r.Wf / 2
    P, z, emb = r.axis, r.z_axis, r.embank
    burn = np.c_[P[emb], z[emb], np.full(emb.sum(), hw)]
    sp = ~emb
    clamp = np.c_[P[sp], z[sp], np.full(sp.sum(), hw), np.full(sp.sum(), 1.5)]
    return burn, clamp
