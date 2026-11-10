"""Plot waveform + 2nd difference around given times. Usage: clickzoom.py <render> t1 t2 ..."""
import sys, numpy as np, soundfile as sf, matplotlib
matplotlib.use("Agg"); import matplotlib.pyplot as plt
sys.path.insert(0, __import__("os").path.dirname(__file__)); import enginelib as E
name = sys.argv[1]; ts = [float(x) for x in sys.argv[2:]]
y, sr = sf.read(E.ROOT / "test_renders" / f"{name}.wav"); m = y.mean(1)
fig, axes = plt.subplots(len(ts), 1, figsize=(18, 2.6 * len(ts)))
for ax, t in zip(np.atleast_1d(axes), ts):
    a, b = int((t - 0.03) * sr), int((t + 0.03) * sr)
    x = np.arange(a, b) / sr
    ax.plot(x, m[a:b], lw=0.7); ax2 = ax.twinx(); ax2.plot(x[2:], np.abs(np.diff(m[a:b], 2)), "r", lw=0.5, alpha=0.6); ax.set_title(f"{name} @ {t}")
plt.tight_layout(); out = E.ANA / f"clicks_{name}.png"; plt.savefig(out, dpi=60); print(out)
