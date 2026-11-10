"""Cut, clean, loop and encode one-shots / loops for the game -> game/public/assets/audio/sfx/*.m4a + sfx.json.
Loops: tail-into-head crossfade (seamless) + periodic padding (codec priming safety); loopStart/loopEnd in sfx.json.
Usage: build_sfx.py"""
import json, os, pathlib, subprocess, sys
import numpy as np, scipy.signal as sps, soundfile as sf, librosa, pyloudnorm as pyln
sys.path.insert(0, os.path.dirname(__file__))
import enginelib as E

SR = 44100
OUT = pathlib.Path(__file__).resolve().parents[3] / "game" / "public" / "assets" / "audio" / "sfx"
TMP = E.ANA / "sfx_tmp"
PAD = 0.1

# name: (source, t0, t1, kind, opts)   kind: loop | shot
SFX = {
    "start":        ("engine/754779", 0.0, 3.6, "shot", dict(lufs=-18, fade_out=0.5)),
    "shift":        ("fx/442766", 5.55, 6.15, "shot", dict(peak=-6, hp=120)),
    "shift_2":      ("fx/442766", 8.55, 9.15, "shot", dict(peak=-6, hp=120)),
    "bov":          ("fx/659544", 0.05, 1.75, "shot", dict(peak=-3, hp=300, fade_out=0.4)),
    "backfire":     ("fx/105351", 0.0, 1.6, "shot", dict(peak=-1, fade_out=0.6)),
    "crackle_1":    ("fx/797835", 1.15, 3.05, "shot", dict(peak=-2, hp=50, fade_in=0.02, fade_out=0.2)),
    "crackle_2":    ("fx/797835", 6.6, 8.05, "shot", dict(peak=-2, hp=50, fade_in=0.02, fade_out=0.2)),
    "nitro_on":     ("fx/701104", 0.0, 2.0, "shot", dict(peak=-3, fade_out=0.6)),
    "tire_squeal":  ("tires/71739", 4.0, 14.0, "loop", dict(lufs=-20, hp=300)),
    "tire_skid":    ("tires/178889", 0.4, 4.15, "loop", dict(lufs=-20, hp=200)),  # click at 4.25 s in the source
    "impact_metal_1": ("impact/151624", 0.0, 1.0, "shot", dict(peak=-1)),
    "impact_metal_2": ("impact/332056", 0.0, 0.35, "shot", dict(peak=-1)),
    "impact_metal_3": ("impact/332058", 0.0, 0.95, "shot", dict(peak=-1)),
    "impact_metal_4": ("impact/726486", 0.0, 1.6, "shot", dict(peak=-1, fade_out=0.5)),
    "impact_crash":   ("impact/592388", 0.0, 2.7, "shot", dict(peak=-1, fade_out=0.3)),
    "impact_glass_1": ("impact/861043", 0.0, 1.1, "shot", dict(peak=-2, fade_out=0.3)),
    "impact_glass_2": ("impact/758207", 0.0, 1.9, "shot", dict(peak=-2, fade_out=0.4)),
    "impact_plastic": ("impact/385940", 0.0, 1.0, "shot", dict(peak=-2, fade_out=0.3)),
    "thump":          ("impact/778421", 0.0, 0.45, "shot", dict(peak=-3, lp=1500)),
    "horn":           ("horn/371833", 0.0, 2.0, "shot", dict(peak=-3, fade_out=0.08)),
    "horn_2":         ("horn/547667", 0.0, 1.2, "shot", dict(peak=-3, fade_out=0.08)),
    "road":         ("road/795866", 30.0, 52.0, "loop", dict(lufs=-20)),
    "wind":         ("road/82267", 57.0, 83.0, "loop", dict(lufs=-20, hp=80)),  # click-free window
    "bus_idle":     ("traffic/453415", 2.0, 18.0, "loop", dict(lufs=-20)),
    "trolley":      ("traffic/652360", 8.0, 38.0, "loop", dict(lufs=-20)),
    "train_rumble": ("rail/631590", 22.0, 52.0, "loop", dict(lufs=-18)),
    "train_horn":   ("rail/591873", 0.2, 3.6, "shot", dict(peak=-2, fade_out=0.4)),
    "train_horn_2": ("rail/662553", 0.0, 1.0, "shot", dict(peak=-2, fade_out=0.15)),
    "amb_city":     ("ambience/667218", 10.0, 55.0, "loop", dict(lufs=-24, stereo=True)),
    "amb_street":   ("ambience/612854", 60.0, 105.0, "loop", dict(lufs=-24, stereo=True)),
    "amb_birds":    ("ambience/457616", 20.0, 65.0, "loop", dict(lufs=-24, stereo=True)),
    "amb_dawn":     ("ambience/631479", 20.0, 65.0, "loop", dict(lufs=-24, stereo=True)),
    "amb_night":    ("ambience/776263", 2.0, 52.0, "loop", dict(lufs=-24, stereo=True)),
    "amb_roar":     ("ambience/454255", 20.0, 65.0, "loop", dict(lufs=-24, stereo=True)),
    # --- city ambience (layered, position-aware: src/audio/city-ambience.ts) ---
    "amb_kids":     ("city/238549", 20.0, 65.0, "loop", dict(lufs=-24, stereo=True)),
    "amb_crowd":    ("city/869048", 20.0, 65.0, "loop", dict(lufs=-24, stereo=True)),
    "amb_trees":    ("city/574553", 40.0, 85.0, "loop", dict(lufs=-24, stereo=True)),
    "amb_crows":    ("city/776151", 25.0, 70.0, "loop", dict(lufs=-26, stereo=True)),
    "amb_industry": ("city/637521", 25.0, 80.0, "loop", dict(lufs=-24)),
    "amb_construction": ("city/613176", 90.0, 140.0, "loop", dict(lufs=-24, stereo=True)),
    "footsteps":    ("city/789609", 0.2, 10.0, "loop", dict(lufs=-22)),
    "dogs_1":       ("city/820267", 0.0, 16.0, "shot", dict(peak=-3, fade_out=0.5)),
    "dogs_2":       ("city/615258", 2.0, 14.0, "shot", dict(peak=-3, fade_out=0.8)),
    "siren_1":      ("city/451068", 3.0, 10.0, "shot", dict(peak=-3, fade_in=0.5, fade_out=1.5)),
    "siren_2":      ("city/568814", 3.0, 33.0, "shot", dict(peak=-3, fade_in=1.0, fade_out=4.0)),
    "car_alarm":    ("city/548470", 0.0, 8.5, "shot", dict(peak=-3, fade_out=0.3)),
    "air_brake":    ("city/801435", 0.0, 2.3, "shot", dict(peak=-3, fade_out=0.4)),
    "air_brake_2":  ("city/454420", 10.5, 13.5, "shot", dict(peak=-3, fade_out=0.6)),
    "bells":        ("city/592873", 60.0, 105.0, "shot", dict(peak=-3, fade_in=0.5, fade_out=6.0)),
    "bells_2":      ("city/870015", 5.0, 40.0, "shot", dict(peak=-3, fade_in=0.5, fade_out=5.0)),
    # --- weather / season (setWeather / setSeason) ---
    "rain_roof":    ("weather/344460", 2.0, 30.0, "loop", dict(lufs=-22)),
    "rain_street":  ("weather/380651", 10.0, 60.0, "loop", dict(lufs=-24, stereo=True)),
    "thunder":      ("weather/476739", 5.0, 30.0, "shot", dict(peak=-2, fade_out=4.0)),
    "snow_tires":   ("weather/71099", 1.8, 10.5, "loop", dict(lufs=-22)),
    "slush":        ("weather/190997", 40.0, 70.0, "loop", dict(lufs=-22)),
    # --- nitro ---
    "nitro_pssh":   ("nitro/642961", 0.0, 1.4, "shot", dict(peak=-3, hp=150, fade_out=0.35)),
    "nitro_rush":   ("nitro/152540", 25.0, 55.0, "loop", dict(lufs=-22, hp=350)),
    "nitro_body":   ("nitro/515122", 5.0, 35.0, "loop", dict(lufs=-22, lp=900)),
    "nitro_purge":  ("nitro/457294", 6.2, 9.5, "shot", dict(peak=-6, hp=500, fade_in=0.02, fade_out=1.6)),
    # --- GTA mode (src/audio/gta-audio.ts) ---
    "gun_pistol_1": ("gta/371440", 0.0, 1.1, "shot", dict(peak=-1, fade_out=0.4)),
    "gun_pistol_2": ("gta/392229", 0.0, 1.6, "shot", dict(peak=-1, fade_out=0.6)),
    "gun_rifle_1":  ("gta/855841", 0.0, 1.2, "shot", dict(peak=-1, fade_out=0.5)),
    "gun_rifle_2":  ("gta/855843", 0.0, 1.4, "shot", dict(peak=-1, fade_out=0.6)),
    "gun_shotgun_1": ("gta/163455", 0.0, 0.7, "shot", dict(peak=-1, fade_out=0.3)),
    "gun_shotgun_2": ("gta/405504", 0.0, 2.0, "shot", dict(peak=-1, fade_out=0.8)),
    "gun_echo":     ("gta/541164", 0.15, 3.3, "shot", dict(peak=-3, hp=120, fade_in=0.05, fade_out=1.5)),
    "ricochet_1":   ("gta/30932", 0.0, 0.55, "shot", dict(peak=-4, fade_out=0.2)),
    "ricochet_2":   ("gta/523403", 0.0, 0.8, "shot", dict(peak=-4, fade_out=0.3)),
    "bullet_hit":   ("gta/778028", 0.0, 0.3, "shot", dict(peak=-4, fade_out=0.1)),
    "punch_1":      ("gta/439747", 0.0, 0.6, "shot", dict(peak=-3, fade_out=0.2)),
    "punch_2":      ("gta/383883", 0.0, 22.0, "slices", dict(peak=-3, n=4, len=0.45)),
    "body_fall":    ("gta/119825", 1.4, 2.8, "shot", dict(peak=-3, fade_in=0.01, fade_out=0.4)),
    "step_hard":    ("gta/637556", 0.0, 9.0, "slices", dict(peak=-6, n=6, len=0.3)),
    "step_grass":   ("gta/521587", 0.0, 4.4, "slices", dict(peak=-6, n=4, len=0.35)),
    "step_snow":    ("weather/611277", 2.0, 20.0, "slices", dict(peak=-6, n=4, len=0.4)),
    "door_open":    ("gta/556690", 0.3, 1.6, "shot", dict(peak=-4, fade_out=0.3)),
    "door_close":   ("gta/556690", 4.5, 5.5, "shot", dict(peak=-3, fade_out=0.3)),
    "door_handle":  ("gta/50697", 0.0, 0.7, "shot", dict(peak=-6, fade_out=0.2)),
    "siren_police": ("gta/239948", 27.5, 39.5, "loop", dict(lufs=-18, hp=300)),
    "siren_synth":  ("gta/746302", 0.4, 12.4, "loop", dict(lufs=-18)),
    "explosion_1":  ("gta/753843", 0.0, 5.5, "shot", dict(peak=-1, fade_out=2.0)),
    "explosion_2":  ("gta/108641", 0.0, 4.0, "shot", dict(peak=-1, fade_out=1.5)),
    "reload":       ("gta/686661", 0.0, 0.45, "shot", dict(peak=-6, fade_out=0.1)),
    "dry_fire":     ("gta/725402", 0.0, 0.5, "shot", dict(peak=-8, fade_out=0.15)),
    "pickup":       ("gta/341979", 0.0, 0.6, "shot", dict(peak=-8, fade_out=0.2)),
    "scream_f":     ("gta/222528", 0.0, 3.0, "shot", dict(peak=-4, fade_out=0.6)),
    "scream_m":     ("gta/460036", 0.3, 2.3, "shot", dict(peak=-4, fade_out=0.4)),
}


def load_src(cid, stereo):
    d = E.SRC / cid
    m = json.loads((d / "meta.json").read_text())
    y, _ = librosa.load(d / m["file"], sr=SR, mono=not stereo)
    if y.ndim == 1: y = y[None, :]
    return y, m


def filt(y, o):
    if "hp" in o:
        b, a = sps.butter(2, o["hp"] / (SR / 2), "high"); y = sps.filtfilt(b, a, y, axis=-1)
    else:
        b, a = sps.butter(2, 25 / (SR / 2), "high"); y = sps.filtfilt(b, a, y, axis=-1)
    if "lp" in o:
        b, a = sps.butter(2, o["lp"] / (SR / 2), "low"); y = sps.filtfilt(b, a, y, axis=-1)
    return y


def main():
    OUT.mkdir(parents=True, exist_ok=True); TMP.mkdir(parents=True, exist_ok=True)
    meter = pyln.Meter(SR)
    man, credits = {}, {}
    for name, (cid, t0, t1, kind, o) in SFX.items():
        stereo = o.get("stereo", False)
        y, m = load_src(cid, stereo)
        credits[m["id"]] = m
        seg = filt(y[:, int(t0 * SR):int(t1 * SR)], o)
        if kind == "slices":
            mono = seg.mean(0)
            on = librosa.onset.onset_detect(y=mono, sr=SR, units="samples", backtrack=True)
            L = int(o["len"] * SR)
            cands = sorted([(np.sqrt(np.mean(mono[a:a + L] ** 2)), a) for a in on if a + L < len(mono)], reverse=True)[:o["n"]]
            for k, (_, a) in enumerate(sorted(cands, key=lambda z: z[1])):
                d = seg[:, max(0, a - 64):a + L].copy()
                d[:, :64] *= np.linspace(0, 1, 64); d[:, -int(0.12 * SR):] *= np.linspace(1, 0, int(0.12 * SR)) ** 2
                d *= 10 ** (o.get("peak", -3) / 20) / (np.abs(d).max() + 1e-9)
                nm = f"{name}_{k + 1}" if not name[-1].isdigit() else f"{name[:-2]}_{k + 3}"
                wav = TMP / f"{nm}.wav"; sf.write(wav, d.T.astype(np.float32), SR, subtype="FLOAT")
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-c:a", "aac_at", "-b:a", "96k", str(OUT / f"{nm}.m4a")], check=True)
                man[nm] = {"file": f"{nm}.m4a", "src": m["id"]}
            print(f"{name:16} slices x{len(cands)} src {m['id']}")
            continue
        entry = {}
        if kind == "loop":
            X = int(min(1.5 * SR, seg.shape[1] * 0.15))
            L = seg.shape[1] - X
            w = np.sin(0.5 * np.pi * np.arange(X) / X) ** 2
            loop = seg[:, :L].copy()
            loop[:, :X] = seg[:, L:L + X] * (1 - w) + seg[:, :X] * w
            loop[:, :X] /= np.sqrt(w ** 2 + (1 - w) ** 2)  # uncorrelated material -> equal power
            lufs = meter.integrated_loudness(loop.T if stereo else loop[0])
            loop *= 10 ** ((o.get("lufs", -20) - lufs) / 20)
            pad = int(PAD * SR)
            idx = np.arange(-pad, L + pad) % L
            data = loop[:, idx]
            entry.update(loopStart=round(pad / SR, 6), loopEnd=round((pad + L) / SR, 6))
        else:
            data = seg.copy()
            n = data.shape[1]
            fi = int(o.get("fade_in", 0.003) * SR); fo = int(o.get("fade_out", 0.05) * SR)
            data[:, :fi] *= np.linspace(0, 1, fi)
            data[:, n - fo:] *= np.linspace(1, 0, fo) ** 2
            if "lufs" in o:
                lufs = meter.integrated_loudness(data.T if stereo else data[0])
                data *= 10 ** ((o["lufs"] - lufs) / 20)
            else:
                data *= 10 ** (o.get("peak", -1) / 20) / (np.abs(data).max() + 1e-9)
        pk = np.abs(data).max()
        if pk > 0.99: data *= 0.99 / pk
        wav = TMP / f"{name}.wav"
        sf.write(wav, data.T.astype(np.float32), SR, subtype="FLOAT")
        br = "96k" if stereo else "96k"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-c:a", "aac_at", "-b:a", br, str(OUT / f"{name}.m4a")], check=True)
        entry["file"] = f"{name}.m4a"
        entry["src"] = m["id"]
        man[name] = entry
        print(f"{name:16} {kind:4} {data.shape[1]/SR:5.1f}s {'st' if stereo else 'mo'} src {m['id']} {m['license']}")
    (OUT / "sfx.json").write_text(json.dumps(man, ensure_ascii=False, indent=1))
    (E.ANA / "sfx_credits.json").write_text(json.dumps({k: {x: v[x] for x in ("title", "author", "license", "url")} for k, v in credits.items()}, ensure_ascii=False, indent=1))
    tot = sum(f.stat().st_size for f in OUT.glob("*.m4a"))
    print(f"total {tot/1e6:.2f} MB")


if __name__ == "__main__":
    main()
