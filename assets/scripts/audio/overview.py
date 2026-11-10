"""Contact sheet of spectrograms (0..fmax Hz) for every source in a category. Usage: overview.py <category> [fmax] [out.png]"""
import json, pathlib, sys
import numpy as np, librosa, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = pathlib.Path(__file__).resolve().parents[2] / "audio"
cat = sys.argv[1]; fmax = float(sys.argv[2]) if len(sys.argv) > 2 else 600
out = sys.argv[3] if len(sys.argv) > 3 else str(ROOT / "analysis" / f"overview_{cat}.png")
dirs = sorted((ROOT / "sources" / cat).iterdir())
n = len(dirs); cols = 2; rows = (n + 1) // 2
fig, axes = plt.subplots(rows, cols, figsize=(22, 2.3 * rows))
for ax, d in zip(axes.flat, dirs):
    m = json.loads((d / "meta.json").read_text())
    y, sr = librosa.load(d / m["file"], sr=11025, mono=True)
    S = np.abs(librosa.stft(y, n_fft=4096, hop_length=256))
    f = librosa.fft_frequencies(sr=sr, n_fft=4096); k = f <= fmax
    D = librosa.amplitude_to_db(S[k], ref=np.max)
    t = np.arange(D.shape[1]) * 256 / sr
    ax.imshow(D, origin="lower", aspect="auto", extent=[0, t[-1], 0, fmax], vmin=-70, vmax=0, cmap="magma")
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=256)[0]
    ax2 = ax.twinx(); ax2.plot(t[:len(rms)], 20*np.log10(rms+1e-6), "c", lw=0.6); ax2.set_ylim(-60, 0); ax2.set_yticks([])
    ax.set_title(f"{m['id']} {m['license']} {m['title'][:70]} ({len(y)/sr:.0f}s)", fontsize=8)
    ax.tick_params(labelsize=6)
    ax.set_xticks(np.arange(0, t[-1], 5))
for ax in list(axes.flat)[n:]: ax.axis("off")
plt.tight_layout(); plt.savefig(out, dpi=55); print(out)
