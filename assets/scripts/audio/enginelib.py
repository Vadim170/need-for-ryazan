"""Engine recording analysis: firing-frequency (order) tracking, pitch flattening, loop extraction."""
import json, pathlib
import numpy as np, librosa, scipy.signal as sps, soundfile as sf

ROOT = pathlib.Path(__file__).resolve().parents[2] / "audio"
SRC = ROOT / "sources"
ANA = ROOT / "analysis"


def load(cid, sr=44100):
    d = SRC / cid
    m = json.loads((d / "meta.json").read_text())
    y, _ = librosa.load(d / m["file"], sr=sr, mono=True)
    return y.astype(np.float64), m


def harmonic_salience(y, sr, fgrid, nfft=4096, hop=256, asr=11025, K=10, fmax_h=2500):
    """Whitened log spectrogram -> salience[f_cand, frame] = mean over k of S(k*f)."""
    ya = librosa.resample(y, orig_sr=sr, target_sr=asr)
    S = np.abs(librosa.stft(ya, n_fft=nfft, hop_length=hop, window="hann"))
    L = np.log(S + 1e-7)
    # whitening: subtract a smooth spectral envelope (median over ~40 Hz)
    binhz = asr / nfft
    w = int(40 / binhz) | 1
    env = sps.medfilt2d(L, kernel_size=(w, 1)) if w > 1 else L
    W = np.clip(L - env, 0, None)
    freqs = np.arange(W.shape[0]) * binhz
    sal = np.zeros((len(fgrid), W.shape[1]))
    for i, f in enumerate(fgrid):
        ks = np.arange(1, K + 1) * f
        ks = ks[ks < fmax_h]
        idx = ks / binhz
        i0 = np.floor(idx).astype(int); fr = idx - i0
        v = W[i0] * (1 - fr)[:, None] + W[i0 + 1] * fr[:, None]
        wts = 1 / np.sqrt(np.arange(1, len(ks) + 1))
        sal[i] = (v * wts[:, None]).sum(0) / wts.sum()
    t = np.arange(W.shape[1]) * hop / asr
    return t, sal, W, freqs


def viterbi_track(sal, fgrid, max_jump_rel=0.05, jump_cost=0.8):
    """Max-salience path with penalty on relative frequency jumps per frame."""
    n, T = sal.shape
    logf = np.log(fgrid)
    # normalize salience per frame
    s = (sal - sal.mean(0)) / (sal.std(0) + 1e-9)
    score = s[:, 0].copy(); back = np.zeros((n, T), dtype=np.int32)
    step = np.median(np.diff(logf))
    J = max(1, int(np.ceil(max_jump_rel / step)))
    offs = np.arange(-J, J + 1)
    pen = jump_cost * (offs * step / max_jump_rel) ** 2
    for t in range(1, T):
        best = np.full(n, -1e18); arg = np.zeros(n, dtype=np.int32)
        for o, p in zip(offs, pen):
            src = np.clip(np.arange(n) - o, 0, n - 1)
            cand = score[src] - p
            better = cand > best
            best[better] = cand[better]; arg[better] = src[better]
        score = best + s[:, t]; back[:, t] = arg
    path = np.zeros(T, dtype=np.int32); path[-1] = int(np.argmax(score))
    for t in range(T - 1, 0, -1): path[t - 1] = back[path[t], t]
    conf = s[path, np.arange(T)]
    return fgrid[path], conf


def refine(W, freqs, t, f0, K=10, rel=0.03):
    """Sub-grid refinement: parabolic peak of harmonic salience around each frame's f0."""
    out = f0.copy()
    for j in range(len(t)):
        cands = f0[j] * np.linspace(1 - rel, 1 + rel, 61)
        best = -1; bf = f0[j]
        for c in cands:
            ks = np.arange(1, K + 1) * c
            ks = ks[ks < freqs[-1] - 5]
            v = np.interp(ks, freqs, W[:, j]).mean()
            if v > best: best, bf = v, c
        out[j] = bf
    return out


def track(y, sr, fmin, fmax, **kw):
    fgrid = np.geomspace(fmin, fmax, 400)
    t, sal, W, freqs = harmonic_salience(y, sr, fgrid, **{k: v for k, v in kw.items() if k in ("nfft", "hop", "K")})
    f, conf = viterbi_track(sal, fgrid, **{k: v for k, v in kw.items() if k in ("max_jump_rel", "jump_cost")})
    f = refine(W, freqs, t, f)
    f = sps.medfilt(f, 5)
    f = sps.savgol_filter(f, 9, 2)
    return t, f, conf


def plot_track(y, sr, t, f, title, out, fmax=400, mults=(1, 2, 3), extra=None):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    ya = librosa.resample(y, orig_sr=sr, target_sr=11025)
    S = np.abs(librosa.stft(ya, n_fft=4096, hop_length=128))
    fr = librosa.fft_frequencies(sr=11025, n_fft=4096); k = fr <= fmax
    D = librosa.amplitude_to_db(S[k], ref=np.max)
    T = len(ya) / 11025
    fig, ax = plt.subplots(figsize=(22, 6))
    ax.imshow(D, origin="lower", aspect="auto", extent=[0, T, 0, fmax], vmin=-60, vmax=0, cmap="magma")
    for m in mults: ax.plot(t, f * m, "--", color="lime", lw=1.0, alpha=0.9, dashes=(4, 6))
    if extra is not None:
        for (a, b, c) in extra: ax.axvspan(a, b, color=c, alpha=0.15)
    ax.set_xticks(np.arange(0, T, 1)); ax.grid(alpha=0.2); ax.set_title(title)
    plt.tight_layout(); plt.savefig(out, dpi=55); plt.close(fig)


def track_guided(y, sr, guide, tol=0.14, nfft=4096, hop=256, asr=11025, K=10, fmax_h=2500, jump_cost=0.6):
    """Firing-frequency track constrained to guide(t)*(1±tol). guide: [(t, f), ...] piecewise-linear (log)."""
    ya = librosa.resample(y, orig_sr=sr, target_sr=asr)
    S = np.abs(librosa.stft(ya, n_fft=nfft, hop_length=hop, window="hann"))
    L = np.log(S + 1e-7)
    binhz = asr / nfft
    w = int(40 / binhz) | 1
    env = sps.medfilt2d(L, kernel_size=(w, 1))
    W = np.clip(L - env, 0, None)
    T = W.shape[1]
    t = np.arange(T) * hop / asr
    gt, gf = np.array(guide, dtype=float).T
    g = np.exp(np.interp(t, gt, np.log(gf)))
    r = np.geomspace(1 - tol, 1 + tol, 141)
    sal = np.zeros((len(r), T))
    wk = 1 / np.sqrt(np.arange(1, K + 1))
    freqs = np.arange(W.shape[0]) * binhz
    for j in range(T):
        F = g[j] * r[:, None] * np.arange(1, K + 1)[None, :]
        ok = F < min(fmax_h, freqs[-1] - 1)
        v = np.interp(F, freqs, W[:, j]) * ok
        sal[:, j] = (v * wk).sum(1) / ((ok * wk).sum(1) + 1e-9)
    # viterbi in absolute log-f: account for guide drift between frames
    s = (sal - sal.mean(0)) / (sal.std(0) + 1e-9)
    logr = np.log(r); step = logr[1] - logr[0]
    score = s[:, 0].copy(); back = np.zeros((len(r), T), dtype=np.int32)
    J = 8
    for j in range(1, T):
        dg = np.log(g[j] / g[j - 1])  # guide change -> shift in r index for constant f
        shift = -dg / step
        best = np.full(len(r), -1e18); arg = np.zeros(len(r), dtype=np.int32)
        for o in range(-J, J + 1):
            src = np.clip(np.arange(len(r)) - o, 0, len(r) - 1)
            p = jump_cost * ((o - shift) * step / 0.02) ** 2
            cand = score[src] - p
            b = cand > best; best[b] = cand[b]; arg[b] = src[b]
        score = best + s[:, j]; back[:, j] = arg
    path = np.zeros(T, dtype=np.int32); path[-1] = int(np.argmax(score))
    for j in range(T - 1, 0, -1): path[j - 1] = back[path[j], j]
    f = g * r[path]
    conf = s[path, np.arange(T)]
    f = np.exp(sps.savgol_filter(np.log(f), 7, 2))
    return t, f, conf
