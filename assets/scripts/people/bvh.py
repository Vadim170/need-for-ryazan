"""Минимальный парсер BVH + прямая кинематика (numpy). Используется build_clips.py.

Оси на выходе — игровые: +Y вверх, персонаж смотрит в −Z (BVH cgspeed/CMU смотрит в +Z, поэтому поворот на 180° вокруг Y).
Единицы — как в файле (CMU: ~дюймы/0.45); дальше всё нормируется на высоту таза в Т-позе (кадр 0).
"""
import numpy as np


class Joint:
    def __init__(self, name, parent):
        self.name, self.parent = name, parent
        self.offset = np.zeros(3)
        self.channels = []
        self.end = None  # смещение End Site
        self.children = []


def parse(path):
    toks = open(path).read().split()
    i = 0
    joints, stack = [], []
    cur = None
    while True:
        t = toks[i]
        if t in ('ROOT', 'JOINT'):
            j = Joint(toks[i + 1], stack[-1] if stack else None)
            if j.parent is not None:
                j.parent.children.append(j)
            joints.append(j)
            cur = j
            i += 2
        elif t == 'End':
            # End Site { OFFSET x y z }
            assert toks[i + 2] == '{' and toks[i + 3] == 'OFFSET'
            cur_end = np.array([float(x) for x in toks[i + 4:i + 7]])
            stack[-1].end = cur_end
            i += 8
            continue
        elif t == '{':
            stack.append(cur)
            i += 1
        elif t == '}':
            stack.pop()
            i += 1
        elif t == 'OFFSET':
            cur.offset = np.array([float(x) for x in toks[i + 1:i + 4]])
            i += 4
        elif t == 'CHANNELS':
            n = int(toks[i + 1])
            cur.channels = toks[i + 2:i + 2 + n]
            i += 2 + n
        elif t == 'MOTION':
            break
        else:
            i += 1
    nf = int(toks[i + 2])
    ft = float(toks[i + 5])
    data = np.array(toks[i + 6:], dtype=np.float64)
    nch = sum(len(j.channels) for j in joints)
    data = data[:nf * nch].reshape(nf, nch)
    return joints, data, ft


def _rot(axis, ang):
    c, s = np.cos(ang), np.sin(ang)
    n = len(ang)
    R = np.zeros((n, 3, 3))
    if axis == 'X':
        R[:, 0, 0] = 1; R[:, 1, 1] = c; R[:, 1, 2] = -s; R[:, 2, 1] = s; R[:, 2, 2] = c
    elif axis == 'Y':
        R[:, 1, 1] = 1; R[:, 0, 0] = c; R[:, 0, 2] = s; R[:, 2, 0] = -s; R[:, 2, 2] = c
    else:
        R[:, 2, 2] = 1; R[:, 0, 0] = c; R[:, 0, 1] = -s; R[:, 1, 0] = s; R[:, 1, 1] = c
    return R


FLIP = np.diag([-1.0, 1.0, -1.0])  # поворот на 180° вокруг Y: BVH (+Z вперёд) -> игра (−Z вперёд)


def fk(joints, data):
    """Мировые повороты (F,J,3,3) и позиции (F,J,3) в игровых осях."""
    F = data.shape[0]
    J = len(joints)
    W = np.zeros((F, J, 3, 3))
    P = np.zeros((F, J, 3))
    idx = {j: k for k, j in enumerate(joints)}
    c = 0
    for k, j in enumerate(joints):
        R = np.tile(np.eye(3), (F, 1, 1))
        pos = np.tile(j.offset, (F, 1))
        for ch in j.channels:
            v = data[:, c]
            c += 1
            if ch.endswith('position'):
                pos = pos.copy()
                pos[:, 'XYZ'.index(ch[0])] = v + (0 if j.parent is None else j.offset['XYZ'.index(ch[0])])
            else:
                R = R @ _rot(ch[0], np.radians(v))
        if j.parent is None:
            W[:, k] = R
            P[:, k] = pos
        else:
            pk = idx[j.parent]
            W[:, k] = W[:, pk] @ R
            P[:, k] = P[:, pk] + np.einsum('fij,j->fi', W[:, pk], j.offset)
    # в игровые оси: p' = FLIP p, R' = FLIP R FLIP
    P = P @ FLIP.T
    W = FLIP @ W @ FLIP
    return W, P
