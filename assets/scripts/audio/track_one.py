"""Usage: track_one.py <cat/id> fmin fmax [plot_fmax] -> analysis/track_<id>.png + .npz"""
import sys, numpy as np
sys.path.insert(0, __import__("os").path.dirname(__file__))
import enginelib as E
cid, fmin, fmax = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
pf = float(sys.argv[4]) if len(sys.argv) > 4 else 400
y, m = E.load(cid)
t, f, conf = E.track(y, 44100, fmin, fmax)
np.savez(E.ANA / f"track_{m['id']}.npz", t=t, f=f, conf=conf)
E.plot_track(y, 44100, t, f, f"{m['id']} {m['title']}", E.ANA / f"track_{m['id']}.png", fmax=pf)
print(E.ANA / f"track_{m['id']}.png")
