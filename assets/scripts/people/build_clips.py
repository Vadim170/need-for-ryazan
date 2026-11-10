"""Клипы анимации пешеходов из CMU mocap (BVH cgspeed «MotionBuilder-friendly», 120 fps) -> общий файл для всех персонажей.

Запуск: python3 -I assets/scripts/people/build_clips.py <bvh_dir> <out_dir>
Выход: <out_dir>/clips.bin (float32) и <out_dir>/clips.json (метаданные; build_people.sh вкладывает их в people.json).

Формат (на кадр, 30 fps): для каждой из 23 костей скелета (порядок SKELETON) кватернион (x, y, z, w) ПОВОРОТА КОСТИ В МИРЕ
ОТНОСИТЕЛЬНО Т-ПОЗЫ (Δ), затем смещение таза (x, y, z) от его положения в Т-позе в долях длины ноги (таз–лодыжка).
Оси игровые: +Y вверх, вперёд −Z (BVH смотрит в +Z — поворот на 180°).
Ретаргет в игре (gltf-people-view.ts): R_кости(t) = Δ(t) · C, где C — поворот, переводящий кость персонажа из его
позы покоя (A-поза MakeHuman) в Т-позу (только кости рук/ног, по направлению «сустав -> следующий сустав»;
канонические направления Т-позы — skeleton.tposeDirs). Позиции суставов — по иерархии от таза.
Δ каждого клипа уже домножены на поворот «канонические направления Т-позы -> Т-поза этого BVH», так что разница
Т-поз разных актёров учтена.

Обработка клипов: вырезка, поворот так, чтобы смотреть/идти в −Z, циклы ходьбы/бега — автоматический поиск самого
похожего кадра через период; на месте (убран линейный дрейф/проход таза); шов цикла закрыт распределением разницы
поворотов по всему клипу. Синтетический клип «fallen» (раскинутые руки/ноги, лёгкое дыхание) — поза стоя: игра
сама кладёт человека матрицей (кувырок вокруг X).
"""
import sys
import os
import json
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bvh  # noqa: E402

SKELETON = ['Hips', 'LHipJoint', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RHipJoint', 'RightUpLeg', 'RightLeg', 'RightFoot',
            'LowerBack', 'Spine', 'Spine1', 'Neck', 'Neck1', 'Head',
            'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand']
PARENT = {'Hips': None, 'LHipJoint': 'Hips', 'LeftUpLeg': 'LHipJoint', 'LeftLeg': 'LeftUpLeg', 'LeftFoot': 'LeftLeg',
          'RHipJoint': 'Hips', 'RightUpLeg': 'RHipJoint', 'RightLeg': 'RightUpLeg', 'RightFoot': 'RightLeg',
          'LowerBack': 'Hips', 'Spine': 'LowerBack', 'Spine1': 'Spine', 'Neck': 'Spine1', 'Neck1': 'Neck', 'Head': 'Neck1',
          'LeftShoulder': 'Spine1', 'LeftArm': 'LeftShoulder', 'LeftForeArm': 'LeftArm', 'LeftHand': 'LeftForeArm',
          'RightShoulder': 'Spine1', 'RightArm': 'RightShoulder', 'RightForeArm': 'RightArm', 'RightHand': 'RightForeArm'}
# кости, у которых выравнивается направление (кость -> сустав-«кончик» в BVH)
DIR_BONES = {'LeftUpLeg': 'LeftLeg', 'LeftLeg': 'LeftFoot', 'LeftFoot': 'LeftToeBase',
             'RightUpLeg': 'RightLeg', 'RightLeg': 'RightFoot', 'RightFoot': 'RightToeBase',
             'LeftArm': 'LeftForeArm', 'LeftForeArm': 'LeftHand', 'LeftHand': 'LeftHandIndex1',
             'RightArm': 'RightForeArm', 'RightForeArm': 'RightHand', 'RightHand': 'RightHandIndex1'}
FPS = 30
STEP = 4  # 120 -> 30 fps

# name, file, start s, end s, mode, extra
CLIPS = [
    dict(name='idle', file='111_28', t0=0.5, t1=3.3, mode='stand'),
    dict(name='walk', file='08_01', t0=0.3, t1=2.2, mode='cycle', period=(0.85, 1.35)),
    dict(name='run', file='16_35', t0=0.2, t1=1.3, mode='cycle', period=(0.55, 0.9)),
    dict(name='sit', file='114_05', t0=2.0, t1=10.0, mode='stand', rootY=1.05),
    dict(name='talk', file='18_08', t0=3.0, t1=17.0, mode='stand'),
    dict(name='phone', file='80_25', t0=3.0, t1=7.3, mode='stand'),
    dict(name='angry', file='80_48', t0=3.5, t1=8.5, mode='stand'),
    dict(name='dodge', file='79_74', t0=2.0, t1=3.0, mode='once'),
    dict(name='fallen', mode='synthetic', dur=2.0),
    # подъём с земли (разовые): с кадра «ещё лежит» до «стоит»; ускорены (speed), в конце смотрит в −Z
    dict(name='getup_back', file='139_18', t0=0.8, t1=6.9, mode='getup', speed=1.5),
    dict(name='getup_front', file='140_01', t0=1.2, t1=5.3, mode='getup', speed=1.25),
]

# ----------------------------------------------------------------- кватернионы (x, y, z, w)


def m2q(M):
    """(…,3,3) -> (…,4)"""
    M = np.asarray(M)
    sh = M.shape[:-2]
    M = M.reshape(-1, 3, 3)
    q = np.zeros((len(M), 4))
    for i, m in enumerate(M):
        t = m[0, 0] + m[1, 1] + m[2, 2]
        if t > 0:
            s = np.sqrt(t + 1.0) * 2
            q[i] = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
        elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
            s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
            q[i] = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
        elif m[1, 1] > m[2, 2]:
            s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
            q[i] = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
        else:
            s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
            q[i] = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    return q.reshape(*sh, 4)


def qmul(a, b):
    ax, ay, az, aw = np.moveaxis(a, -1, 0)
    bx, by, bz, bw = np.moveaxis(b, -1, 0)
    return np.stack([aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz], -1)


def qinv(q):
    return q * np.array([-1, -1, -1, 1.0])


def qaxis(axis, ang):
    axis = np.asarray(axis, float)
    axis = axis / np.linalg.norm(axis)
    s = np.sin(ang / 2)
    return np.array([axis[0] * s, axis[1] * s, axis[2] * s, np.cos(ang / 2)])


def qslerp(a, b, t):
    d = np.sum(a * b, -1, keepdims=True)
    b = np.where(d < 0, -b, b)
    d = np.abs(d)
    t = np.asarray(t, float)[..., None] if np.ndim(t) else t
    res = a * (1 - t) + b * t  # nlerp (углы маленькие)
    return res / np.linalg.norm(res, axis=-1, keepdims=True)


def qrotv(q, v):
    u = q[..., :3]
    w = q[..., 3:4]
    return v + 2 * np.cross(u, np.cross(u, v) + w * v)


def arc(a, b):
    """Кратчайший поворот a -> b (единичные векторы)."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    c = np.cross(a, b)
    d = np.dot(a, b)
    q = np.array([c[0], c[1], c[2], 1 + d])
    if q[3] < 1e-6:
        q = np.array([0, 0, 1.0, 0]) if abs(a[0]) > 0.5 else np.array([1.0, 0, 0, 0])
    return q / np.linalg.norm(q)


def yaw_q(ang):
    return qaxis([0, 1, 0], ang)

# ----------------------------------------------------------------- загрузка


def load(path):
    J, D, ft = bvh.parse(path)
    W, P = bvh.fk(J, D)
    names = [j.name for j in J]
    ix = {n: i for i, n in enumerate(names)}
    L = P[0, ix['Hips'], 1] - 0.5 * (P[0, ix['LeftFoot'], 1] + P[0, ix['RightFoot'], 1])
    return dict(W=W, P=P, ix=ix, L=L, ft=ft, n=len(D))


def tpose_dirs(c):
    P, ix = c['P'], c['ix']
    return {b: (P[0, ix[t]] - P[0, ix[b]]) / np.linalg.norm(P[0, ix[t]] - P[0, ix[b]]) for b, t in DIR_BONES.items()}


def deltas(c, f0, f1, canon):
    """Δ (F,23,4), смещение таза (F,3) в долях L; кадры [f0, f1] через STEP."""
    W, P, ix = c['W'], c['P'], c['ix']
    fr = np.arange(f0, f1 + 1, STEP)
    Q = m2q(W[:, [ix[b] for b in SKELETON]])  # (F, 23, 4)
    Q0 = Q[0]
    D = qmul(Q[fr], qinv(Q0)[None])
    # Т-поза канон -> Т-поза этого BVH
    td = tpose_dirs(c)
    for b in DIR_BONES:
        k = SKELETON.index(b)
        A = arc(canon[b], td[b])
        D[:, k] = qmul(D[:, k], A[None])
    off = (P[fr, ix['Hips']] - P[0, ix['Hips']]) / c['L']
    # вертикаль: от опорной лодыжки (минимум по клипу) — стоящая/опорная нога персонажа ровно на земле
    af = min(P[fr, ix['LeftFoot'], 1].min(), P[fr, ix['RightFoot'], 1].min())
    off[:, 1] = (P[fr, ix['Hips'], 1] - af) / c['L'] - 1.0
    return D, off


def canonical_dirs(c):
    return {b: v.tolist() for b, v in tpose_dirs(c).items()}


def align_yaw(D, off, fwd):
    """Повернуть клип вокруг Y так, чтобы горизонтальный вектор fwd смотрел в −Z."""
    ang = np.arctan2(fwd[0], fwd[2])  # угол fwd от +Z
    target = np.pi  # −Z
    q = yaw_q(target - ang)
    D = qmul(np.broadcast_to(q, D.shape), D)
    off = qrotv(np.broadcast_to(q, off.shape[:-1] + (4,)), off)
    return D, off


def hips_forward(D):
    f = qrotv(D[:, 0], np.array([0, 0, -1.0]))
    f = f.mean(0)
    f[1] = 0
    return f / np.linalg.norm(f)


def close_loop(D, off, keep_travel=False):
    """Последний кадр = первому: разница поворотов распределяется по клипу (последний кадр потом выкидывается)."""
    n = len(D)
    t = np.linspace(0, 1, n)
    corr = qmul(D[0], qinv(D[-1]))  # (23,4)
    for k in range(D.shape[1]):
        c = corr[k] if corr[k, 3] >= 0 else -corr[k]
        part = qslerp(np.tile([0, 0, 0, 1.0], (n, 1)), np.tile(c, (n, 1)), t)
        D[:, k] = qmul(part, D[:, k])
    d = off[0] - off[-1]
    off = off + t[:, None] * d[None]
    return D[:-1], off[:-1]


def pose_dist(Q, a, b):
    return float(np.sum(1 - np.abs(np.sum(Q[a] * Q[b], -1))))


def best_cycle(c, t0, t1, pmin, pmax):
    W, ix = c['W'], c['ix']
    Q = m2q(W[:, [ix[b] for b in SKELETON[1:]]])  # без таза (курс меняется)
    f0, f1 = int(t0 * 120), int(t1 * 120)
    best = (1e9, 0, 0)
    for a in range(f0, f1, 2):
        for L in range(int(pmin * 120), int(pmax * 120) + 1, 4):
            b = a + L
            if b > f1 or b >= c['n']:
                break
            d = pose_dist(Q, a, b)
            if d < best[0]:
                best = (d, a, b)
    return best


def synthetic_fallen(dur):
    """Раскинутые руки и ноги, колени и локти чуть согнуты, лёгкое дыхание/подёргивание. Δ от Т-позы (мировые оси)."""
    n = int(dur * FPS)
    D = np.tile([0, 0, 0, 1.0], (n, len(SKELETON), 1))
    off = np.zeros((n, 3))
    t = np.arange(n) / FPS
    w = 2 * np.pi / dur
    for i in range(n):
        s = np.sin(w * t[i])
        def setb(b, q):
            D[i, SKELETON.index(b)] = q
        # руки: из Т-позы на 25° вниз (левая рука вдоль −X: поворот вокруг +Z опускает), локти согнуты к голове
        armL = qaxis([0, 0, 1], np.radians(20 + 4 * s))
        armR = qaxis([0, 0, 1], -np.radians(20 + 4 * s))
        setb('LeftArm', armL)
        setb('RightArm', armR)
        setb('LeftForeArm', qmul(qaxis([0, 0, 1], -np.radians(35)), armL))
        setb('RightForeArm', qmul(qaxis([0, 0, 1], np.radians(35)), armR))
        setb('LeftHand', qmul(qaxis([0, 0, 1], -np.radians(45)), armL))
        setb('RightHand', qmul(qaxis([0, 0, 1], np.radians(45)), armR))
        # ноги врозь, колени согнуты (стопа уходит назад: поворот вокруг X)
        legL = qaxis([0, 0, 1], -np.radians(14))
        legR = qaxis([0, 0, 1], np.radians(10))
        setb('LeftUpLeg', qmul(qaxis([1, 0, 0], np.radians(10)), legL))
        setb('RightUpLeg', qmul(qaxis([1, 0, 0], np.radians(4)), legR))
        setb('LeftLeg', qmul(qaxis([1, 0, 0], -np.radians(25)), legL))
        setb('RightLeg', qmul(qaxis([1, 0, 0], -np.radians(12)), legR))
        setb('LeftFoot', qmul(qaxis([1, 0, 0], -np.radians(15)), legL))
        setb('RightFoot', qmul(qaxis([1, 0, 0], -np.radians(8)), legR))
        # голова набок, грудь дышит
        setb('Spine1', qaxis([1, 0, 0], np.radians(2 * s)))
        setb('Neck', qaxis([0, 0, 1], np.radians(8)))
        setb('Head', qmul(qaxis([0, 1, 0], np.radians(20)), qaxis([0, 0, 1], np.radians(12))))
        setb('Neck1', qaxis([0, 0, 1], np.radians(10)))
    return D, off


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    ref = load(os.path.join(src, '08_01.bvh'))
    canon = {b: np.array(v) for b, v in canonical_dirs(ref).items()}
    blobs, meta = [], []
    offset = 0
    for spec in CLIPS:
        name = spec['name']
        info = dict(name=name)
        if spec['mode'] == 'getup':
            c = load(os.path.join(src, spec['file'] + '.bvh'))
            info['source'] = 'CMU ' + spec['file']
            f0, f1 = int(spec['t0'] * 120), int(spec['t1'] * 120)
            stp = STEP * spec['speed']
            frs = [int(round(f0 + k * stp)) for k in range(int((f1 - f0) / stp) + 1)]
            D, off = deltas(c, f0, f1, canon)  # кадры через STEP; пересэмплируем по frs
            idx = [min(len(D) - 1, int(round((f - f0) / STEP))) for f in frs]
            D, off = D[idx], off[idx]
            fwd_end = qrotv(D[-1, 0], np.array([0, 0, -1.0]))
            fwd_end[1] = 0
            D, off = align_yaw(D, off, fwd_end / np.linalg.norm(fwd_end))
            off[:, 0] -= off[0, 0]
            off[:, 2] -= off[0, 2]
            loop = False
            info['range'] = [spec['t0'], spec['t1']]
            info['speed'] = spec['speed']
        elif spec['mode'] == 'synthetic':
            D, off = synthetic_fallen(spec['dur'])
            loop = True
            info['source'] = 'synthetic'
        else:
            c = load(os.path.join(src, spec['file'] + '.bvh'))
            info['source'] = 'CMU ' + spec['file']
            if spec['mode'] == 'cycle':
                d, a, b = best_cycle(c, spec['t0'], spec['t1'], *spec['period'])
                # кратно шагу 4
                b = a + ((b - a) // STEP) * STEP
                D, off = deltas(c, a, b, canon)
                travel = off[-1] - off[0]
                travel[1] = 0
                D, off = align_yaw(D, off, travel / np.linalg.norm(travel))
                vert = off[:, 1].copy()
                trav = off[-1] - off[0]
                stride = float(np.hypot(trav[0], trav[2]))
                tt = np.linspace(0, 1, len(off))[:, None]
                off = off - off[0] - tt * trav[None]  # на месте
                off[:, 1] = vert
                # фаза: кадр 0 = удар пяткой левой ноги (стопа дальше всего впереди таза) — ходьба и бег совпадают по фазе
                P_, ix_ = c['P'], c['ix']
                tdir = travel / np.linalg.norm(travel)
                fwd = (P_[a:b + 1:STEP, ix_['LeftFoot']] - P_[a:b + 1:STEP, ix_['Hips']]) @ tdir
                D, off = close_loop(D, off)
                k0 = int(np.argmax(fwd[:len(D)]))
                D = np.roll(D, -k0, axis=0)
                off = np.roll(off, -k0, axis=0)
                loop = True
                info['strideNorm'] = round(stride, 4)  # на один цикл, в долях длины ноги
                info['speedNorm'] = round(stride / (len(D) / FPS), 4)  # естественная скорость, длин ноги в секунду
                info['loopErr'] = round(d, 4)
                info['range'] = [round(a / 120, 3), round(b / 120, 3)]
            else:
                f0, f1 = int(spec['t0'] * 120), int(spec['t1'] * 120)
                f1 = f0 + ((f1 - f0) // STEP) * STEP
                D, off = deltas(c, f0, f1, canon)
                D, off = align_yaw(D, off, hips_forward(D))
                m = off.mean(0)
                off[:, 0] -= m[0]
                off[:, 2] -= m[2]
                if spec['mode'] == 'stand':
                    D, off = close_loop(D, off)
                    loop = True
                else:
                    off[:, 0] -= off[0, 0] - m[0] * 0
                    off[:, 2] -= off[0, 2]
                    loop = False
                info['range'] = [spec['t0'], spec['t1']]
            if 'rootY' in spec:
                info['rootY'] = spec['rootY']
                off[:, 1] -= off[:, 1].mean()
        n = len(D)
        info.update(frames=n, duration=round(n / FPS, 4), loop=loop, offset=offset)
        arr = np.concatenate([D.reshape(n, -1), off], 1).astype(np.float32)
        blobs.append(arr.ravel())
        offset += arr.size
        meta.append(info)
        print(name, info)
    data = np.concatenate(blobs)
    data.tofile(os.path.join(out, 'clips.bin'))
    res = dict(fps=FPS, bones=SKELETON, parents=[PARENT[b] for b in SKELETON], frameFloats=len(SKELETON) * 4 + 3,
               tposeDirs={b: [round(x, 5) for x in v] for b, v in canonical_dirs(ref).items()},
               clips=meta, file='clips.bin')
    json.dump(res, open(os.path.join(out, 'clips.json'), 'w'), indent=1)
    print('clips.bin', data.nbytes, 'bytes')


if __name__ == '__main__':
    main()
