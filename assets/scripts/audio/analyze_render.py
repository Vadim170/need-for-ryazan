"""Analyze offline renders (assets/audio/test_renders/<name>.wav + .json):
clipping, true peak, loudness (LUFS), clicks (sample discontinuities), RPM tracking accuracy, spectrogram PNG.
Usage: analyze_render.py <name> [<name> ...]   (or 'all')"""
import json, os, pathlib, sys
import numpy as np, soundfile as sf, scipy.signal as sps, pyloudnorm as pyln
sys.path.insert(0, os.path.dirname(__file__))
import enginelib as E

R = E.ROOT / "test_renders"
GAME = pathlib.Path(__file__).resolve().parents[3] / "game" / "public" / "assets" / "audio" / "engine"


def clicks(x, sr):
    """Sample discontinuities: |2nd difference| far above the local 99th percentile (±60 ms) — sharp exhaust-pulse
    edges of the engine itself stay below that, a real click/step sticks out. Returns event times (s)."""
    d2 = np.abs(np.diff(x, 2))
    blk = int(0.03 * sr)
    nb = len(d2) // blk
    p99 = np.array([np.percentile(d2[i * blk:(i + 1) * blk], 99) for i in range(nb)])
    # local reference = max of neighbouring blocks' p99, excluding the block's own peak influence
    ref = np.maximum.reduce([np.roll(p99, -1), np.roll(p99, 1), p99, np.roll(p99, -2), np.roll(p99, 2)])
    ev = []
    for i in range(nb):
        seg = d2[i * blk:(i + 1) * blk]
        j = int(np.argmax(seg))
        if seg[j] > 3.0 * ref[i] and seg[j] > 0.03:
            ev.append((i * blk + j) / sr)
    return ev


def analyze(name):
    wav = R / f"{name}.wav"
    meta = json.loads((R / f"{name}.json").read_text())
    y, sr = sf.read(wav, dtype="float64")
    mono = y.mean(1) if y.ndim > 1 else y
    peak = np.abs(y).max()
    up = sps.resample_poly(mono, 4, 1)
    tpeak = np.abs(up).max()
    nclip = int((np.abs(y) >= 0.999).sum())
    meter = pyln.Meter(sr)
    lufs = meter.integrated_loudness(y)
    # short-term loudness (3 s) max/min over active part
    st = []
    for a in np.arange(0, len(y) / sr - 3, 1.0):
        seg = y[int(a * sr):int((a + 3) * sr)]
        st.append(meter.integrated_loudness(seg))
    st = np.array([v for v in st if np.isfinite(v)])
    ck = clicks(mono, sr)
    # RPM tracking
    man = json.loads((GAME / meta["preset"] / "manifest.json").read_text())
    cyl = man["cylinders"]
    tel = meta["tel"]; lead = meta["lead"]
    tt = np.array([f["t"] for f in tel]) + lead
    fexp = np.array([f["soundRpm"] for f in tel]) * cyl / 120
    guide = list(zip(tt, fexp))
    t, f, conf = E.track_guided(mono, sr, guide, tol=0.08)
    fe = np.interp(t, tt, fexp)
    rms = np.sqrt(np.convolve(mono ** 2, np.ones(2048) / 2048, mode="same"))[(t * sr).astype(int).clip(0, len(mono) - 1)]
    ok = (t > lead + 0.6) & (t < tt[-1]) & (conf > 1.5) & (rms > 1e-3)
    cents = 1200 * np.log2(f[ok] / fe[ok])
    res = dict(name=name, seconds=round(len(y) / sr, 1), peak_dbfs=round(20 * np.log10(peak + 1e-12), 2),
               true_peak_dbfs=round(20 * np.log10(tpeak + 1e-12), 2), clipped_samples=nclip, lufs=round(lufs, 2),
               short_term_lufs_max=round(float(st.max()), 1) if len(st) else None, short_term_lufs_min=round(float(st.min()), 1) if len(st) else None,
               clicks=len(ck), click_times=[round(c, 2) for c in ck[:30]],
               rpm_track_frames=int(ok.sum()), rpm_cents_median=round(float(np.median(np.abs(cents))), 1) if ok.any() else None,
               rpm_cents_p90=round(float(np.percentile(np.abs(cents), 90)), 1) if ok.any() else None,
               render_realtime_factor=round(meta["audioSeconds"] * 1000 / meta["renderMs"], 1))
    # plot
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    import librosa
    ya = librosa.resample(mono, orig_sr=sr, target_sr=11025)
    S = np.abs(librosa.stft(ya, n_fft=4096, hop_length=256))
    fr = librosa.fft_frequencies(sr=11025, n_fft=4096); fmax = max(400, min(1000, fexp.max() * 2.6)); k = fr <= fmax
    D = librosa.amplitude_to_db(S[k], ref=np.max)
    T = len(ya) / 11025
    fig, (ax, ax2) = plt.subplots(2, 1, figsize=(22, 9), gridspec_kw=dict(height_ratios=[3, 1]), sharex=True)
    ax.imshow(D, origin="lower", aspect="auto", extent=[0, T, 0, fmax], vmin=-70, vmax=0, cmap="magma")
    for m in (1, 2):
        ax.plot(tt, fexp * m, "--", color="lime", lw=0.8, dashes=(3, 5))
    for c in ck: ax.axvline(c, color="red", lw=0.6, alpha=0.6)
    ax.set_title(f"{name}: firing-freq expected (green dashed, ×1 ×2), clicks (red)")
    gear = np.array([f["gear"] for f in tel]); spd = np.array([f["speed"] for f in tel]) * 3.6
    rpm = np.array([f["rpm"] for f in tel]); thr = np.array([f["throttle"] for f in tel])
    ax2.plot(tt, rpm / 100, label="game rpm/100"); ax2.plot(tt, np.array([f["soundRpm"] for f in tel]) / 100, label="sound rpm/100")
    ax2.plot(tt, spd, label="km/h"); ax2.plot(tt, gear * 10, label="gear×10"); ax2.plot(tt, thr * 50, label="throttle×50")
    lt = np.arange(0, len(mono) / sr, 0.05)
    lv = [20 * np.log10(np.sqrt(np.mean(mono[int(a * sr):int((a + 0.05) * sr)] ** 2)) + 1e-9) for a in lt]
    ax2.plot(lt, np.array(lv) + 60, label="level dB+60", lw=0.7)
    ax2.legend(loc="upper right", fontsize=8); ax2.grid(alpha=0.3); ax2.set_xticks(np.arange(0, T, 1))
    plt.tight_layout(); plt.savefig(R / f"{name}.png", dpi=55); plt.close(fig)
    return res


if __name__ == "__main__":
    names = sys.argv[1:]
    if names == ["all"]: names = sorted(p.stem for p in R.glob("*.wav"))
    out = [analyze(n) for n in names]
    for r in out: print(json.dumps(r, ensure_ascii=False))
    summ = R / "metrics.json"
    old = json.loads(summ.read_text()) if summ.exists() else {}
    old.update({r["name"]: r for r in out}); summ.write_text(json.dumps(old, ensure_ascii=False, indent=1))
