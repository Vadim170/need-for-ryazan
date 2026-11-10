/**
 * GTA-mode sounds (events from src/combat/events.ts, docs/stage3/gta-mode.md): gunshots per weapon with
 * distance filtering and echoes between buildings (delay from the wall distance of the acoustic probe), bullet impacts
 * by surface, punches, footsteps by surface / season, jump / land, car doors, explosions, reload / dry fire / weapon
 * switch / pickups, screams, wanted-level blips, wasted / busted stingers, and continuous police sirens (positional,
 * Doppler from the police car velocity). All world sounds go through PannerNodes into the world bus (+ reverb send).
 */
import type { SampleLib } from './sample-lib';
import { mulberry32 } from './sample-lib';
import type { EnvState } from './environment';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const C_SOUND = 343;

/** world/surface-mask SURF codes that sound soft underfoot. */
const SOFT_SURF = new Set([0, 5, 6, 7, 8]); // terrain, path, playground, grass, dirt

export interface SirenSource { id: number; x: number; y: number; z: number; vx: number; vz: number }

interface SirenVoice { id: number; src: AudioBufferSourceNode; gain: GainNode; pan: PannerNode }

export class GtaAudio {
  /** 2D UI-ish sounds (reload, pickups, wanted blips) — not spatialised. */
  readonly uiOut: GainNode;
  private sirens = new Map<number, SirenVoice>();
  private rnd = mulberry32(99);
  winter = false;
  snowCover = 0;
  private listener = { x: 0, y: 0, z: 0, vx: 0, vz: 0 };

  constructor(private readonly ctx: BaseAudioContext, private readonly lib: SampleLib, private readonly worldOut: AudioNode,
    uiTarget: AudioNode, private readonly env: () => EnvState) {
    this.uiOut = ctx.createGain();
    this.uiOut.connect(uiTarget);
  }

  setListener(x: number, y: number, z: number, vx: number, vz: number): void { Object.assign(this.listener, { x, y, z, vx, vz }); }

  private pick(prefix: string): string {
    const v = this.lib.variants(prefix);
    return v.length ? v[Math.floor(this.rnd() * v.length)] : prefix;
  }

  private panner(ref: number, x: number, y: number, z: number, t: number): PannerNode {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = 1;
    p.maxDistance = 2000;
    if (p.positionX) { p.positionX.setValueAtTime(x, t); p.positionY.setValueAtTime(y, t); p.positionZ.setValueAtTime(z, t); }
    else (p as unknown as { setPosition(a: number, b: number, c: number): void }).setPosition(x, y, z);
    p.connect(this.worldOut);
    return p;
  }

  /** Positional one-shot; far sounds lose their top end (air absorption). */
  play(name: string, x: number, y: number, z: number, t: number, gain = 1, ref = 8, rate = 1): void {
    if (!this.lib.get(name)) return;
    const d = Math.hypot(x - this.listener.x, z - this.listener.z);
    const p = this.panner(ref, x, y, z, t);
    let target: AudioNode = p;
    let lp: BiquadFilterNode | null = null;
    if (d > 60) {
      lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.value = clamp(18000 * Math.pow(60 / d, 0.9), 1200, 18000);
      lp.connect(p); target = lp;
    }
    const delay = d / C_SOUND; // sound travel time (noticeable for far gunshots / explosions)
    const g = this.lib.play(name, target, t + delay, gain, rate, () => { lp?.disconnect(); p.disconnect(); });
    if (!g) { lp?.disconnect(); p.disconnect(); }
  }

  gunshot(weapon: string, x: number, y: number, z: number, t: number, byPlayer: boolean): void {
    const kind = weapon === 'rifle' ? 'gun_rifle' : weapon === 'shotgun' ? 'gun_shotgun' : 'gun_pistol';
    const rate = 0.95 + 0.1 * this.rnd();
    this.play(this.pick(kind), x, y, z, t, byPlayer ? 0.9 : 1, 14, rate);
    // echoes between buildings: slap-back from the facades (delay = 2·d/c) + a longer rolling tail in canyons
    const e = this.env();
    const d = Math.hypot(x - this.listener.x, z - this.listener.z);
    if (e.canyon > 0.15) {
      const slap = (2 * e.wallDist) / C_SOUND;
      this.play('gun_echo', x, y + 4, z, t + slap, 0.55 * e.canyon, 30, 0.95 + 0.1 * this.rnd());
      if (e.canyon > 0.45) this.play('gun_echo', x, y + 6, z, t + slap * 2.3 + 0.08, 0.3 * e.canyon, 40, 0.85);
    } else if (d > 120) {
      this.play('gun_echo', x, y, z, t + 0.15, 0.4, 40, 0.9); // open field: distant rolling report
    }
  }

  impact(surface: string, x: number, y: number, z: number, t: number): void {
    if (surface === 'glass') this.play(this.pick('impact_glass'), x, y, z, t, 0.5, 6);
    else if (surface === 'vehicle') this.play(this.pick('impact_metal'), x, y, z, t, 0.35, 5, 1.3 + 0.3 * this.rnd());
    else if (surface === 'ped' || surface === 'cop' || surface === 'player') this.play('bullet_hit', x, y, z, t, 0.8, 4);
    else if (this.rnd() < 0.35) this.play(this.pick('ricochet'), x, y, z, t, 0.45, 8, 0.9 + 0.2 * this.rnd());
    else this.play('bullet_hit', x, y, z, t, 0.5, 5, 0.7);
  }

  footstep(x: number, y: number, z: number, speed: number, surface: number, t: number, byPlayer: boolean): void {
    const snow = this.winter && this.snowCover > 0.3;
    const name = snow ? 'step_snow' : SOFT_SURF.has(surface) ? 'step_grass' : 'step_hard';
    const g = (byPlayer ? 0.45 : 0.3) * clamp(0.5 + speed / 6, 0.5, 1.3);
    this.play(this.pick(name), x, y, z, t, g, 3, 0.92 + 0.16 * this.rnd());
  }

  ui(name: string, t: number, gain = 1): void { this.lib.play(name, this.uiOut, t, gain); }

  /** Wanted level change: short rising / falling two-tone blip (synthesised). */
  wanted(level: number, prev: number, t: number): void {
    const up = level > prev;
    for (let i = 0; i < 2; i++) {
      const o = this.ctx.createOscillator(); o.type = 'triangle';
      const f = (up ? [660, 880] : [660, 440])[i];
      o.frequency.value = f;
      const g = this.ctx.createGain(); g.gain.value = 0;
      g.gain.setValueAtTime(0, t + i * 0.12); g.gain.linearRampToValueAtTime(0.12, t + i * 0.12 + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.11);
      o.connect(g).connect(this.uiOut); o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.13);
      o.onended = () => { o.disconnect(); g.disconnect(); };
    }
  }

  /** Low dull hit + slowed body fall: 'wasted' / 'busted'. */
  stinger(t: number, busted: boolean): void {
    this.lib.play('thump', this.uiOut, t, 1, 0.5);
    this.lib.play(busted ? 'door_close' : 'body_fall', this.uiOut, t + 0.05, 0.8, 0.8);
  }

  /** Continuous police sirens (poll every frame): positional loops with Doppler. */
  updateSirens(list: SirenSource[], t: number): void {
    const L = this.listener;
    const seen = new Set<number>();
    for (const s of list) {
      seen.add(s.id);
      let v = this.sirens.get(s.id);
      if (!v) {
        const src = this.lib.loop('siren_police') ?? this.lib.loop('siren_synth');
        if (!src) continue;
        const gain = this.ctx.createGain(); gain.gain.value = 0;
        const pan = this.panner(20, s.x, s.y + 1.5, s.z, t);
        src.connect(gain).connect(pan);
        src.start(t, (src.loopStart || 0) + this.rnd() * 5);
        gain.gain.setTargetAtTime(0.9, t, 0.3);
        v = { id: s.id, src, gain, pan };
        this.sirens.set(s.id, v);
      }
      const p = v.pan;
      if (p.positionX) { p.positionX.setTargetAtTime(s.x, t, 0.03); p.positionY.setTargetAtTime(s.y + 1.5, t, 0.03); p.positionZ.setTargetAtTime(s.z, t, 0.03); }
      const d = Math.max(0.5, Math.hypot(L.x - s.x, L.z - s.z));
      const nx = (L.x - s.x) / d, nz = (L.z - s.z) / d;
      const dop = clamp((C_SOUND - (L.vx * nx + L.vz * nz)) / (C_SOUND - (s.vx * nx + s.vz * nz)), 0.75, 1.3);
      v.src.playbackRate.setTargetAtTime(dop, t, 0.05);
    }
    for (const [id, v] of this.sirens) {
      if (seen.has(id)) continue;
      v.gain.gain.setTargetAtTime(0, t, 0.25);
      v.src.stop(t + 1.5);
      v.src.onended = () => { v.gain.disconnect(); v.pan.disconnect(); };
      this.sirens.delete(id);
    }
  }
}
