"""Detailed spectrogram of one source. Usage: zoom.py <cat>/<id> fmax [t0 t1] [nfft]"""
import json, pathlib, sys
import numpy as np, librosa, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
ROOT = pathlib.Path(__file__).resolve().parents[2] / "audio"
d = ROOT / "sources" / sys.argv[1]; fmax = float(sys.argv[2])
m = json.loads((d / "meta.json").read_text())
y, sr = librosa.load(d / m["file"], sr=11025, mono=True)
t0 = float(sys.argv[3]) if len(sys.argv) > 3 else 0; t1 = min(float(sys.argv[4]), len(y)/sr) if len(sys.argv) > 4 else len(y)/sr
nfft = int(sys.argv[5]) if len(sys.argv) > 5 else 8192
y = y[int(t0*sr):int(t1*sr)]
S = np.abs(librosa.stft(y, n_fft=nfft, hop_length=128))
f = librosa.fft_frequencies(sr=sr, n_fft=nfft); k = f <= fmax
D = librosa.amplitude_to_db(S[k], ref=np.max)
fig, ax = plt.subplots(figsize=(20, 7))
ax.imshow(D, origin="lower", aspect="auto", extent=[t0, t1, 0, fmax], vmin=-60, vmax=0, cmap="magma")
ax.set_yticks(np.arange(0, fmax, fmax/30 if fmax <= 300 else 25)); ax.set_xticks(np.arange(int(t0), t1, 1)); ax.grid(alpha=0.25)
ax.set_title(f"{m['id']} {m['title']}")
out = ROOT / "analysis" / f"zoom_{m['id']}_{int(t0)}_{int(t1)}.png"
plt.tight_layout(); plt.savefig(out, dpi=60); print(out)
