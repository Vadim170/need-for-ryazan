"""Track all sources of a preset with guides, save npz + overlay PNGs. Usage: track_preset.py <preset>"""
import sys, os, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import enginelib as E
from presets import PRESETS
P = PRESETS[sys.argv[1]]
cols = {"on": "lime", "off": "cyan", "idle": "yellow", "cruise": "orange"}
for cid, s in P["sources"].items():
    y, m = E.load(cid)
    t, f, conf = E.track_guided(y, 44100, s["guide"])
    np.savez(E.ANA / f"gtrack_{m['id']}.npz", t=t, f=f, conf=conf)
    ext = [(a, b, cols[k]) for a, b, k in s["segments"]]
    E.plot_track(y, 44100, t, f, f"{m['id']} {m['title']}  (rpm=f*{120//P['cyl']})", E.ANA / f"gtrack_{m['id']}.png",
                 fmax=min(600, max(g[1] for g in s["guide"]) * 2.3), mults=(1, 2), extra=ext)
    print(m["id"], "conf median", np.median(conf).round(2), E.ANA / f"gtrack_{m['id']}.png")
