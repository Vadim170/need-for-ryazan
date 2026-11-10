"""Клипы игрока пешком (src/player/rig-assets.ts, docs/stage3/gta-mode.md) из CMU mocap — отдельный файл, чтобы не трогать
клипы пешеходов: game/public/assets/player/clips.bin + clips.json (тот же формат кадра, что у build_clips.py).

Запуск: python3 -I assets/scripts/people/build_player_clips.py assets/downloads/cmu/bvh game/public/assets/player
BVH (cgspeed, зеркало github.com/una-dinosauria/cmu-mocap data/<subj>/<id>.bvh): 143_01 (бег-спринт), 13_39 (прыжок),
02_05 (удар рукой), 74_03 (удар ногой), 16_45 (бег трусцой). Остальные клипы (idle/walk/run/fallen) игра берёт из people/clips.bin.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_clips as bc  # noqa: E402

CLIPS = [
    dict(name='sprint', file='143_01', t0=0.1, t1=0.84, mode='cycle', period=(0.5, 0.74)),
    dict(name='jump', file='13_39', t0=1.22, t1=1.62, mode='once'),
    dict(name='punch', file='02_05', t0=0.8, t1=1.5, mode='once'),
    dict(name='kick', file='74_03', t0=1.3, t1=2.25, mode='once'),
    # бег трусцой (~3.7 м/с, тот же исполнитель, что run 16_35): между run (2.6 м/с) и sprint — каденс при 4.6 м/с близок к
    # естественному (run в 1.7× «семенил»); последним, чтобы смещения остальных клипов не менялись
    dict(name='jog', file='16_45', t0=0.0, t1=1.1, mode='cycle', period=(0.5, 0.9)),
]


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    ref = bc.load(os.path.join(src, '08_01.bvh'))
    canon = {b: np.array(v) for b, v in bc.canonical_dirs(ref).items()}
    blobs, meta, offset = [], [], 0
    for spec in CLIPS:
        c = bc.load(os.path.join(src, spec['file'] + '.bvh'))
        info = dict(name=spec['name'], source='CMU ' + spec['file'])
        if spec['mode'] == 'cycle':
            d, a, b = bc.best_cycle(c, spec['t0'], spec['t1'], *spec['period'])
            b = a + ((b - a) // bc.STEP) * bc.STEP
            D, off = bc.deltas(c, a, b, canon)
            travel = off[-1] - off[0]
            travel[1] = 0
            D, off = bc.align_yaw(D, off, travel / np.linalg.norm(travel))
            vert = off[:, 1].copy()
            trav = off[-1] - off[0]
            stride = float(np.hypot(trav[0], trav[2]))
            tt = np.linspace(0, 1, len(off))[:, None]
            off = off - off[0] - tt * trav[None]
            off[:, 1] = vert
            P_, ix_ = c['P'], c['ix']
            tdir = travel / np.linalg.norm(travel)
            fwd = (P_[a:b + 1:bc.STEP, ix_['LeftFoot']] - P_[a:b + 1:bc.STEP, ix_['Hips']]) @ tdir
            D, off = bc.close_loop(D, off)
            k0 = int(np.argmax(fwd[:len(D)]))  # кадр 0 = левая стопа впереди (как ходьба/бег пешеходов)
            D, off = np.roll(D, -k0, axis=0), np.roll(off, -k0, axis=0)
            loop = True
            info['strideNorm'] = round(stride, 4)
            info['strideM'] = round(stride * 0.85, 4)
            info['loopErr'] = round(d, 4)
        else:
            f0, f1 = int(spec['t0'] * 120), int(spec['t1'] * 120)
            f1 = f0 + ((f1 - f0) // bc.STEP) * bc.STEP
            D, off = bc.deltas(c, f0, f1, canon)
            D, off = bc.align_yaw(D, off, bc.hips_forward(D))
            off[:, 0] -= off[0, 0]
            off[:, 2] -= off[0, 2]
            loop = False
        info['range'] = [spec['t0'], spec['t1']]
        n = len(D)
        info.update(frames=n, duration=round(n / bc.FPS, 4), loop=loop, offset=offset)
        arr = np.concatenate([D.reshape(n, -1), off], 1).astype(np.float32)
        blobs.append(arr.ravel())
        offset += arr.size
        meta.append(info)
        print(spec['name'], info)
    data = np.concatenate(blobs)
    data.tofile(os.path.join(out, 'clips.bin'))
    json.dump(dict(fps=bc.FPS, bones=bc.SKELETON, frameFloats=len(bc.SKELETON) * 4 + 3, clips=meta, file='clips.bin',
                   license='CMU Graphics Lab Motion Capture Database, mocap.cs.cmu.edu. "The data used in this project was obtained from '
                           'mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217."'),
              open(os.path.join(out, 'clips.json'), 'w'), ensure_ascii=False, indent=1)
    print('clips.bin', data.nbytes, 'bytes')


if __name__ == '__main__':
    main()
