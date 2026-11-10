"""Build engine loop bank for a preset: pitch-flattened, cycle-aligned, phase-aligned seamless loops at RPM bins
for layers idle/off/cruise/on, packed into one sprite (m4a AAC) + manifest JSON.
Usage: build_engine.py <preset> [--no-encode]"""
import sys, os, json, subprocess, pathlib
import numpy as np, scipy.signal as sps, soundfile as sf
sys.path.insert(0, os.path.dirname(__file__))
import enginelib as E
from presets import PRESETS

SR = 44100
UP = 4
GAME = pathlib.Path(__file__).resolve().parents[3] / "game" / "public" / "assets" / "audio" / "engine"
PAD = 0.1  # s, periodic padding around each loop in the sprite (codec priming safety)


def hp(y, fc=28):
    b, a = sps.butter(2, fc / (SR / 2), "high")
    return sps.filtfilt(b, a, y)


class Source:
    def __init__(self, cid, cfg, cyl):
        self.cid = cid
        self.y, self.meta = E.load(cid, SR)
        self.y = hp(self.y)
        self.yu = sps.resample_poly(self.y, UP, 1)
        d = np.load(E.ANA / f"gtrack_{self.meta['id']}.npz")
        self.tt, self.ff, self.conf = d["t"], d["f"], d["conf"]
        ts = np.arange(len(self.y)) / SR
        self.fs = np.interp(ts, self.tt, self.ff)
        self.phi = np.concatenate([[0], np.cumsum(self.fs[:-1]) / SR])  # firings
        self.ts = ts
        self.segments = cfg["segments"]
        self.penalty = cfg.get("penalty", 0.0)

    def read(self, tpos):
        x = tpos * SR * UP
        i = np.clip(np.floor(x).astype(np.int64), 0, len(self.yu) - 2)
        fr = x - i
        return self.yu[i] * (1 - fr) + self.yu[i + 1] * fr

    def flatten(self, phi0, nfirings, F, L):
        """Output L samples at constant firing freq F starting at source phase phi0."""
        target = phi0 + F * np.arange(L) / SR
        tpos = np.interp(target, self.phi, self.ts)
        return self.read(tpos), tpos


def candidates(src, kind, F, cyl, dur):
    """Yield (score, center_time, warp) for windows of the given kind where f crosses/holds near F."""
    out = []
    for (a, b, k) in src.segments:
        if k != kind: continue
        m = (src.tt >= a) & (src.tt <= b)
        idx = np.where(m)[0]
        if len(idx) < 3: continue
        for j in idx[::2]:
            tc = src.tt[j]
            if abs(np.log(src.ff[j] / F)) > 0.04: continue
            # window in phase domain: dur seconds at F
            half = dur / 2
            t0, t1 = tc - half * 1.15, tc + half * 1.15
            if t0 < a - 0.05 or t1 > b + 0.05: continue
            w = (src.tt >= t0) & (src.tt <= t1)
            lr = np.log(src.ff[w] / F)
            warp = np.abs(lr).max()
            conf = np.median(src.conf[w])
            score = np.abs(lr).mean() + 0.5 * warp - 0.01 * conf
            out.append((score, tc, warp, conf))
    return out


def make_loop(src, tc, F, cyl, dur, xfade_frac=0.3):
    N = max(2, int(round(dur * F / cyl)))  # engine cycles
    M = N * cyl  # firings
    L = int(round(M / F * SR))
    Fp = M * SR / L
    X = int(min(0.18 * SR, xfade_frac * L))
    phic = np.interp(tc, src.ts, src.phi)
    phi0 = phic - (M + X * Fp / SR) / 2
    seg, tpos = src.flatten(phi0, M, Fp, L + X)
    # seamless loop: blend the tail (seg[L:L+X]) into the head (seg[0:X])
    w = np.sin(0.5 * np.pi * np.arange(X) / X) ** 2
    loop = seg[:L].copy()
    loop[:X] = seg[L:L + X] * (1 - w) + seg[:X] * w
    # equal-power-ish compensation for partially decorrelated noise in the blend region
    loop[:X] *= 1 / np.sqrt(w ** 2 + (1 - w) ** 2) ** 0.5
    return loop, Fp, N, (tpos[0], tpos[-1])


def phase_align(loop, Fp):
    """Rotate so that low harmonics of the firing frequency have consistent phase (cos phase 0 at start)."""
    L = len(loop); n = np.arange(L)
    per = SR / Fp
    cs = [np.sum(loop * np.exp(-2j * np.pi * k * Fp * n / SR)) for k in (1, 2, 3, 4)]
    s_cand = np.arange(int(np.ceil(per)))
    best, bs = -1e18, 0
    for s in s_cand:
        v = sum(abs(c) * np.cos(np.angle(c) + 2 * np.pi * (k + 1) * Fp * s / SR) for k, c in enumerate(cs))
        if v > best: best, bs = v, s
    return np.roll(loop, -bs)


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9)


def seam_click(loop):
    """Ratio of |second difference| at the wrap to the 99.9th percentile elsewhere (<~1 means no click)."""
    ext = np.concatenate([loop[-3:], loop[:3]])
    d2w = np.abs(np.diff(ext, 2)).max()
    d2 = np.abs(np.diff(loop, 2))
    return float(d2w / (np.percentile(d2, 99.9) + 1e-12))


def pitch_dev_cents(loop, Fp):
    """Short-time harmonic-salience f0 within ±5% of Fp; return max |dev| in cents (pitch stability)."""
    t, f, c = E.track_guided(np.tile(loop, 2), SR, [(0, Fp), (100, Fp)], tol=0.05)
    k = len(f) // 4
    f = f[k:-k] if len(f) > 8 else f
    return float(np.abs(1200 * np.log2(f / Fp)).max())


def build(name, encode=True):
    P = PRESETS[name]; cyl = P["cyl"]
    srcs = [Source(cid, cfg, cyl) for cid, cfg in P["sources"].items()]
    out_dir = GAME / name; out_dir.mkdir(parents=True, exist_ok=True)
    loops = []
    report = []
    idle_rpm = P["bins"][0]
    layers = {"on": 0.7, "cruise": 0.9, "off": 0.9}
    # idle: one long loop
    for s in srcs:
        for (a, b, k) in s.segments:
            if k == "idle":
                fmed = float(np.median(s.ff[(s.tt > a) & (s.tt < b)]))
                tc = (a + b) / 2
                dur = min(3.2, (b - a) * 0.8)
                loop, Fp, N, span = make_loop(s, tc, fmed, cyl, dur, xfade_frac=0.25)
                loops.append(dict(layer="idle", rpm=Fp * 120 / cyl, F=Fp, cycles=N, data=phase_align(loop, Fp), src=s.meta["id"], span=span, warp=0))
    for layer, dur in layers.items():
        for R in P["bins"][1:]:
            F = R * cyl / 120
            # longer loops at low rpm (more natural irregularity), shorter at high rpm
            d = dur * float(np.interp(R, [800, 2000, 4000, 6000], [1.25, 1.0, 0.75, 0.6]))
            cands = []
            for dd in (d, d * 0.7, d * 0.5, d * 0.35):
                if dd * F / cyl < 6: break  # at least 6 engine cycles (shorter loops sound periodic/buzzy)
                for s in srcs:
                    for c in candidates(s, layer, F, cyl, dd):
                        if c[2] <= 0.10: cands.append(((c[0] + 0.02 * (d / dd - 1) + s.penalty,) + c[1:], s, dd))
                if cands: break
            if not cands:
                report.append(f"  {layer:6} {R:5}: no data"); continue
            # best-scoring window whose flattened loop really holds a steady pitch (tracking glitches -> wobble)
            best = None
            for (score, tc, warp, conf), s, d in sorted(cands, key=lambda z: z[0][0])[:12]:
                loop, Fp, N, span = make_loop(s, tc, F, cyl, d)
                pd = pitch_dev_cents(loop, Fp)
                if best is None or pd < best[0]: best = (pd, loop, Fp, N, span, s, warp)
                if pd < 20: break
            pd, loop, Fp, N, span, s, warp = best
            if pd > 40:
                report.append(f"  {layer:6} {R:5}: rejected (pitch wobble {pd:.0f} c)"); continue
            loops.append(dict(layer=layer, rpm=Fp * 120 / cyl, F=Fp, cycles=N, data=phase_align(loop, Fp), src=s.meta["id"], span=span, warp=float(warp)))
    # levels + normalization
    for L_ in loops:
        L_["level"] = rms_db(L_["data"])
        L_["data"] = L_["data"] * 10 ** ((-20 - L_["level"]) / 20)
        L_["click"] = seam_click(L_["data"])
        L_["pdev"] = pitch_dev_cents(L_["data"], L_["F"])
    # sprite
    pad = int(PAD * SR)
    chunks, pos = [], 0
    man_loops = []
    for L_ in sorted(loops, key=lambda z: (z["layer"], z["rpm"])):
        x = L_["data"]; n = len(x)
        idx = np.arange(-pad, n + pad) % n
        chunks.append(x[idx]); start = pos + pad
        man_loops.append(dict(layer=L_["layer"], rpm=round(L_["rpm"], 2), firingHz=round(L_["F"], 4), cycles=L_["cycles"],
                              start=start / SR, length=n / SR, startSample=start, lengthSamples=n,
                              levelDb=round(L_["level"], 2), src=L_["src"], srcSpan=[round(L_["span"][0], 3), round(L_["span"][1], 3)],
                              warp=round(L_["warp"], 3), seamClick=round(L_["click"], 3), pitchDevCents=round(L_["pdev"], 1)))
        pos += n + 2 * pad
    sprite = np.concatenate(chunks)
    peak = np.abs(sprite).max()
    if peak > 0.98: sprite *= 0.98 / peak
    wav = E.ANA / f"engine_{name}.wav"
    sf.write(wav, sprite.astype(np.float32), SR, subtype="FLOAT")
    if encode:
        m4a = out_dir / "engine.m4a"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-c:a", "aac_at", "-b:a", "160k", str(m4a)], check=True)
    srcs_meta = [dict(id=s.meta["id"], title=s.meta["title"], author=s.meta["author"], license=s.meta["license"], url=s.meta["url"]) for s in srcs]
    manifest = dict(preset=name, title=P["title"], cylinders=cyl, sampleRate=SR, file="engine.m4a", pad=PAD,
                    rpmMap=P["rpmMap"], idleRpm=round([l for l in man_loops if l["layer"] == "idle"][0]["rpm"], 1),
                    loops=man_loops, sources=srcs_meta)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"{name}: {len(man_loops)} loops, sprite {len(sprite)/SR:.1f}s")
    for l in man_loops:
        print(f"  {l['layer']:6} rpm {l['rpm']:7.1f} cyc {l['cycles']:3} len {l['length']:.2f}s lvl {l['levelDb']:6.1f} warp {l['warp']:.3f} "
              f"click {l['seamClick']:.2f} pdev {l['pitchDevCents']:5.1f}c src {l['src']} {l['srcSpan']}")
    print("\n".join(report))


if __name__ == "__main__":
    build(sys.argv[1], encode="--no-encode" not in sys.argv)
