/**
 * Player-car sounds besides the engine: tyres, skid, road roar, wind, impacts, suspension thumps, horn,
 * nitro (activation 'pssh' + sustained airy rush with a low rumble body that follows the throttle + purge 'tsss' tail),
 * and weather / season surfaces (rain on the body, wet hiss / slush, snow-packed tyres).
 */
import { mulberry32, type SampleLib } from './sample-lib';

export interface PlayerTelemetry {
  rpm: number; throttle: number; load: number; gear: number;
  speed: number; // m/s
  nitro: boolean;
  skid: number; // 0..1 tyre slip (Vehicle.skid)
  handbrake: boolean;
  drifting: boolean;
  grounded: number; // wheels on the ground
  impact: number; // m/s velocity change in one physics step from a collision (0 = none)
  bump: number; // m/s vertical velocity change (suspension hit)
  idleRpm: number; redlineRpm: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smoothstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class VehicleSfx {
  readonly output: GainNode;
  private squeal: { src: AudioBufferSourceNode | null; gain: GainNode };
  private skid: { src: AudioBufferSourceNode | null; gain: GainNode };
  private road: { src: AudioBufferSourceNode | null; gain: GainNode; lp: BiquadFilterNode };
  private wind: { src: AudioBufferSourceNode | null; gain: GainNode; hp: BiquadFilterNode };
  private nitroRush: { src: AudioBufferSourceNode | null; gain: GainNode };
  private nitroBody: { src: AudioBufferSourceNode | null; gain: GainNode };
  private nitroLvl = 0;
  private prevNitro = false;
  private nitroOnT = 0;
  private nitroOffT = 1;
  private nitroRestT = 1;
  private rain: { src: AudioBufferSourceNode | null; gain: GainNode };
  private snowT: { src: AudioBufferSourceNode | null; gain: GainNode };
  private slush: { src: AudioBufferSourceNode | null; gain: GainNode };
  /** Road surface from weather / season (set by AudioSystem.setWeather / setSeason). */
  surface = { wet: 0, snow: 0, rain: 0 };
  /** Weather wind 0..1 adds gusty wind noise even at low speed. */
  windBoost = 0;
  private impactCool = 0;
  private bumpCool = 0;
  private squealLvl = 0;
  private gust = 0;
  private rnd = mulberry32(42);

  constructor(ctx: BaseAudioContext, private readonly lib: SampleLib) {
    this.output = ctx.createGain();
    const mk = (name: string) => {
      const gain = ctx.createGain(); gain.gain.value = 0;
      const src = lib.loop(name);
      return { src, gain };
    };
    this.squeal = mk('tire_squeal');
    this.skid = mk('tire_skid');
    const r = mk('road');
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 800;
    this.road = { ...r, lp };
    const w = mk('wind');
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 200;
    this.wind = { ...w, hp };
    this.squeal.src?.connect(this.squeal.gain);
    this.skid.src?.connect(this.skid.gain);
    this.road.src?.connect(lp).connect(this.road.gain);
    this.wind.src?.connect(hp).connect(this.wind.gain);
    for (const x of [this.squeal, this.skid, this.road, this.wind]) { x.gain.connect(this.output); x.src?.start(0, (x.src.loopStart || 0) + this.rnd() * 2); }
    this.nitroRush = mk('nitro_rush');
    this.nitroBody = mk('nitro_body');
    this.rain = mk('rain_roof');
    this.snowT = mk('snow_tires');
    this.slush = mk('slush');
    for (const x of [this.nitroRush, this.nitroBody, this.rain, this.snowT, this.slush]) {
      x.src?.connect(x.gain); x.gain.connect(this.output); x.src?.start(0, (x.src.loopStart || 0) + this.rnd() * 3);
    }
  }

  update(s: PlayerTelemetry, dt: number, t: number): void {
    const v = s.speed;
    const onGround = s.grounded >= 2 ? 1 : 0;
    // tyre squeal: by slip, needs some speed; skid layer for handbrake / heavy slides
    const slipT = onGround * smoothstep(0.12, 0.75, s.skid) * smoothstep(1.5, 6, v);
    this.squealLvl += (slipT - this.squealLvl) * (1 - Math.exp(-dt * (slipT > this.squealLvl ? 18 : 7)));
    const sq = this.squealLvl;
    this.squeal.gain.gain.setTargetAtTime(0.55 * sq, t, 0.03);
    this.squeal.src?.playbackRate.setTargetAtTime(0.85 + 0.25 * sq + 0.004 * v, t, 0.05);
    const sk = onGround * (s.handbrake ? 1 : 0.5 * smoothstep(0.5, 1, s.skid)) * smoothstep(2, 8, v);
    this.skid.gain.gain.setTargetAtTime(0.45 * sk, t, 0.04);
    this.skid.src?.playbackRate.setTargetAtTime(0.8 + 0.01 * v, t, 0.05);
    // road roar & wind
    const roadT = onGround * Math.pow(clamp(v / 33, 0, 1), 0.85);
    this.road.gain.gain.setTargetAtTime(0.42 * roadT, t, 0.08);
    this.road.lp.frequency.setTargetAtTime(400 + 90 * v, t, 0.1);
    this.road.src?.playbackRate.setTargetAtTime(0.75 + v / 70, t, 0.1);
    const windT = Math.pow(clamp(v / 50, 0, 1), 2) * (1 + 0.25 * clamp((v - 50) / 20, 0, 1)) + 0.35 * this.windBoost * (0.7 + 0.3 * Math.sin(this.gust += dt * 0.7));
    this.wind.gain.gain.setTargetAtTime(0.38 * windT, t, 0.08);
    this.wind.hp.frequency.setTargetAtTime(150 + 12 * v, t, 0.1);
    this.wind.src?.playbackRate.setTargetAtTime(0.85 + v / 120, t, 0.1);
    // nitro: pssh on activation, rush + rumble body follow the throttle, smooth release with a purge tail
    // debounced state: on at once, off only after 0.2 s without nitro (a flickering flag must not re-trigger the
    // one-shots — that machine-gun of 'pssh' was the crackle on long nitro runs); pssh needs ≥0.6 s of rest
    if (s.nitro) this.nitroOffT = 0; else this.nitroOffT += dt;
    const held = s.nitro || (this.prevNitro && this.nitroOffT < 0.2);
    if (held && !this.prevNitro) { if (this.nitroRestT > 0.6) this.lib.play('nitro_pssh', this.output, t, 0.85); this.nitroOnT = 0; }
    if (!held && this.prevNitro && this.nitroOnT > 0.3) this.lib.play('nitro_purge', this.output, t, 0.6);
    if (held) { this.nitroOnT += dt; this.nitroRestT = 0; } else this.nitroRestT += dt;
    this.prevNitro = held;
    const nT = held ? 0.45 + 0.55 * clamp(s.throttle, 0, 1) : 0;
    this.nitroLvl += (nT - this.nitroLvl) * (1 - Math.exp(-dt * (nT > this.nitroLvl ? 7 : 3)));
    const nl = this.nitroLvl;
    this.nitroRush.gain.gain.setTargetAtTime(0.34 * nl, t, 0.06);
    this.nitroRush.src?.playbackRate.setTargetAtTime(0.9 + 0.15 * nl + v / 200, t, 0.1);
    this.nitroBody.gain.gain.setTargetAtTime(0.42 * nl, t, 0.08);
    this.nitroBody.src?.playbackRate.setTargetAtTime(0.85 + 0.25 * nl, t, 0.1);
    // weather surfaces: rain drumming on the body, wet road hiss / slush, packed snow under the tyres
    const sf = this.surface;
    this.rain.gain.gain.setTargetAtTime(0.3 * sf.rain, t, 0.5);
    const roll = onGround * smoothstep(0.5, 8, v);
    this.slush.gain.gain.setTargetAtTime(roll * (0.25 * sf.wet + 0.35 * sf.snow * sf.wet) * clamp(v / 20, 0.3, 1.2), t, 0.15);
    this.slush.src?.playbackRate.setTargetAtTime(0.8 + v / 60, t, 0.1);
    this.snowT.gain.gain.setTargetAtTime(roll * 0.4 * sf.snow * (1 - 0.5 * sf.wet), t, 0.15);
    this.snowT.src?.playbackRate.setTargetAtTime(0.75 + v / 40, t, 0.1);
    // impacts
    this.impactCool = Math.max(0, this.impactCool - dt);
    if (s.impact > 2.2 && this.impactCool === 0) {
      this.impact(s.impact, t);
      this.impactCool = 0.18;
    }
    this.bumpCool = Math.max(0, this.bumpCool - dt);
    if (s.bump > 1.1 && this.bumpCool === 0 && s.impact < 2.2) {
      this.lib.play('thump', this.output, t, clamp(0.25 + 0.2 * (s.bump - 1), 0.25, 0.9), 0.8 + 0.3 * this.rnd());
      this.bumpCool = 0.12;
    }
  }

  /** Collision by impulse (velocity change, m/s). */
  impact(dv: number, t: number): void {
    const pick = (prefix: string) => { const v = this.lib.variants(prefix); return v.length ? v[Math.floor(this.rnd() * v.length)] : prefix; };
    const g = clamp(0.2 + dv / 14, 0.2, 0.85);
    const rate = 0.9 + 0.2 * this.rnd();
    if (dv < 5) {
      this.lib.play(this.rnd() < 0.5 ? 'impact_plastic' : 'impact_metal_2', this.output, t, g * 0.8, rate);
      this.lib.play('thump', this.output, t, g * 0.7, 0.7);
    } else if (dv < 10) {
      this.lib.play(pick('impact_metal'), this.output, t, g, rate);
      this.lib.play('thump', this.output, t, 0.9, 0.6);
      if (this.rnd() < 0.3) this.lib.play('impact_plastic', this.output, t + 0.02, g * 0.6, rate);
    } else {
      this.lib.play('impact_crash', this.output, t, g, rate);
      this.lib.play(pick('impact_metal'), this.output, t, g * 0.8, rate * 0.9);
      if (this.rnd() < 0.6) this.lib.play(pick('impact_glass'), this.output, t + 0.04, g * 0.6, 1);
    }
  }

  horn(t: number): void { this.lib.play('horn', this.output, t, 0.7); }
}
