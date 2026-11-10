/**
 * City ambience as a layered, position-aware system (docs/stage2/audio.md):
 * - beds (looped recordings) whose levels follow the audio zone map around the listener (src/audio/city-zones.ts,
 *   built from OSM), the time of day, traffic / pedestrian density, weather and season: city hum, distant traffic
 *   (road class nearby), crowd murmur + footsteps (pedestrian streets, shops, stops, people nearby), birds / crows /
 *   wind in trees (parks, forest), kids on playgrounds by day, industrial hum and construction, night quiet, rain;
 * - positional voices: engine hums of the nearest traffic cars (Doppler, equal-power panning), buses (+ air brakes
 *   when they stop at a bus stop), trolleybus traction whine, train rumble;
 * - random positional events: dogs in yards, car alarms and distant sirens (mostly at night), church bells near
 *   churches (on the hour by day, Kremlin included), thunder in storms; rail horn events (Rail.onEvent).
 */
import type { SampleLib } from './sample-lib';
import { mulberry32 } from './sample-lib';
import { CityZones, EMPTY_ZONE, type ZoneSample } from './city-zones';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const C_SOUND = 343;

/** Structural view of a traffic vehicle (src/traffic/sim.ts SimVehicle). */
export interface TrafficCarLike { id: number; kind: string; x: number; y: number; z: number; fx: number; fz: number; v: number; crashed?: boolean }
export interface WorldAudioInput {
  listener: { x: number; y: number; z: number; fx: number; fy: number; fz: number; ux: number; uy: number; uz: number; vx: number; vz: number };
  hour: number;
  traffic?: Iterable<TrafficCarLike> | null;
  trafficDensity: number; // 0..~1.2
  pedestrians: number; // people within ~40 m
  pedDensity: number; // 0..~1.2 (time of day curve)
  trainRumble: number; // 0..1 (Rail.rumble)
  trainPos?: { x: number; y: number; z: number } | null;
  inCity: boolean;
}

export interface WeatherState { rain: number; snow: number; wind: number; storm?: number }
export type Season = 'summer' | 'winter';

/** Loop region inside a decoded buffer (traffic car hums reuse the 'stock' engine bank sprite). */
export interface HumLoop { buffer: AudioBuffer; start: number; end: number }

interface Voice {
  id: number;
  kind: string;
  src: AudioBufferSourceNode | null;
  extra: OscillatorNode | null; // trolleybus whine
  extraGain: GainNode | null;
  gain: GainNode;
  pan: PannerNode;
  prevV: number;
  stopped: boolean;
}

const BEDS = ['amb_city', 'amb_roar', 'amb_street', 'amb_crowd', 'footsteps', 'amb_birds', 'amb_crows', 'amb_trees', 'amb_kids',
  'amb_industry', 'amb_construction', 'amb_dawn', 'amb_night', 'rain_street'] as const;
type Bed = typeof BEDS[number];

export class Ambience {
  readonly output: GainNode;
  /** World (positional) sounds, also sent to the environment reverb. */
  readonly worldOut: GainNode;
  /** Beds go through a lowpass that closes in snow / at night (snow absorbs, quiet city). */
  private bedLp: BiquadFilterNode;
  private beds = new Map<Bed, GainNode>();
  private voices: Voice[] = [];
  private rumble: { gain: GainNode; pan: PannerNode; started: boolean };
  private rnd = mulberry32(7);
  private zones: CityZones | null = null;
  private z: ZoneSample = { ...EMPTY_ZONE };
  private zoneTimer = 0;
  private weather: WeatherState = { rain: 0, snow: 0, wind: 0.2 };
  season: Season = 'summer';
  private nextEvent: Record<string, number> = { dogs: 8, alarm: 40, siren: 25, thunder: 20, bells: 30 };
  private lastHour = -1;
  private time = 0;
  /** Debug readout. */
  readonly debug = { zone: this.z, beds: {} as Record<string, number> };

  constructor(private readonly ctx: BaseAudioContext, private readonly lib: SampleLib, private hums: HumLoop[], private readonly maxVoices = 6) {
    this.output = ctx.createGain();
    this.worldOut = ctx.createGain();
    this.worldOut.connect(this.output);
    this.bedLp = ctx.createBiquadFilter(); this.bedLp.type = 'lowpass'; this.bedLp.frequency.value = 16000; this.bedLp.Q.value = 0.5;
    this.bedLp.connect(this.output);
    const rg = ctx.createGain(); rg.gain.value = 0;
    const rp = this.panner();
    rg.connect(rp).connect(this.worldOut);
    this.rumble = { gain: rg, pan: rp, started: false };
    void CityZones.load().then((z) => { this.zones = z; });
  }

  setWeather(w: Partial<WeatherState>): void { Object.assign(this.weather, w); }
  /** Set once the weather system drives lightning itself (thunder()) — the random storm thunder is then off. */
  private externalThunder = false;
  /** Thunder clap after `delay` s (sound travel time from the lightning), intensity 0..1. */
  thunder(delay: number, intensity: number, t: number): void {
    this.externalThunder = true;
    const rate = 0.85 + 0.25 * this.rnd();
    // distant strikes are duller: route through a lowpass whose cutoff falls with distance
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300 + 3500 * intensity * intensity;
    lp.connect(this.worldOut);
    if (!this.lib.play('thunder', lp, t + Math.max(0, delay), 0.5 + 1.4 * intensity, rate, () => lp.disconnect())) lp.disconnect();
  }
  setHums(h: HumLoop[]): void { this.hums = h; }

  /** Bed gain node, created lazily once its sample is decoded (ambience loads after the engine). */
  private bed(name: Bed): GainNode | null {
    let g = this.beds.get(name);
    if (g) return g;
    const s = this.lib.loop(name);
    if (!s) return null;
    g = this.ctx.createGain(); g.gain.value = 0;
    s.connect(g); g.connect(this.bedLp);
    s.start(this.ctx.currentTime, (s.loopStart || 0) + this.rnd() * 20);
    this.beds.set(name, g);
    return g;
  }

  private panner(ref = 6): PannerNode {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = 1.1;
    p.maxDistance = 600;
    return p;
  }

  private setListener(L: WorldAudioInput['listener'], t: number): void {
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.setTargetAtTime(L.x, t, 0.02); l.positionY.setTargetAtTime(L.y, t, 0.02); l.positionZ.setTargetAtTime(L.z, t, 0.02);
      l.forwardX.setTargetAtTime(L.fx, t, 0.02); l.forwardY.setTargetAtTime(L.fy, t, 0.02); l.forwardZ.setTargetAtTime(L.fz, t, 0.02);
      l.upX.setTargetAtTime(L.ux, t, 0.02); l.upY.setTargetAtTime(L.uy, t, 0.02); l.upZ.setTargetAtTime(L.uz, t, 0.02);
    } else {
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(L.x, L.y, L.z);
      (l as unknown as { setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void }).setOrientation(L.fx, L.fy, L.fz, L.ux, L.uy, L.uz);
    }
  }

  private setPos(p: PannerNode, x: number, y: number, z: number, t: number): void {
    if (p.positionX) { p.positionX.setTargetAtTime(x, t, 0.03); p.positionY.setTargetAtTime(y, t, 0.03); p.positionZ.setTargetAtTime(z, t, 0.03); }
    else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }

  private makeVoice(car: TrafficCarLike, t: number): Voice {
    const c = this.ctx;
    const gain = c.createGain(); gain.gain.value = 0;
    const pan = this.panner();
    let src: AudioBufferSourceNode | null = null;
    let extra: OscillatorNode | null = null, extraGain: GainNode | null = null;
    const heavy = car.kind === 'paz' || car.kind === 'liaz';
    if (car.kind === 'trolleybus') {
      src = this.lib.loop('trolley');
      extra = c.createOscillator(); extra.type = 'triangle';
      extraGain = c.createGain(); extraGain.gain.value = 0;
      extra.connect(extraGain).connect(gain); extra.start(t);
    } else if (heavy) {
      src = this.lib.loop('bus_idle');
    } else if (this.hums.length) {
      const h = this.hums[car.id % this.hums.length];
      src = c.createBufferSource();
      src.buffer = h.buffer;
      src.loop = true; src.loopStart = h.start; src.loopEnd = h.end;
    }
    if (src) { src.connect(gain); src.start(t, (src.loopStart || 0) + this.rnd() * 0.3); }
    gain.connect(pan).connect(this.worldOut);
    return { id: car.id, kind: car.kind, src, extra, extraGain, gain, pan, prevV: car.v, stopped: car.v < 0.5 };
  }

  private dropVoice(v: Voice, t: number): void {
    v.gain.gain.setTargetAtTime(0, t, 0.15);
    const stopAt = t + 1;
    v.src?.stop(stopAt);
    v.extra?.stop(stopAt);
    if (v.src) v.src.onended = () => { v.gain.disconnect(); v.pan.disconnect(); };
  }

  /** Random positional one-shot around the listener (distance range, m). */
  private eventAround(name: string, L: WorldAudioInput['listener'], t: number, dMin: number, dMax: number, gain: number): void {
    const a = this.rnd() * Math.PI * 2, d = dMin + (dMax - dMin) * this.rnd();
    this.playAt(name, L.x + Math.cos(a) * d, L.y + 2, L.z + Math.sin(a) * d, t, gain);
  }

  update(w: WorldAudioInput, dt: number, t: number): void {
    const L = w.listener;
    this.time += dt;
    this.setListener(L, t);
    // ---- zone affinities around the listener (4 Hz, smoothed) ----
    this.zoneTimer -= dt;
    if (this.zoneTimer <= 0) {
      this.zoneTimer = 0.25;
      const s = this.zones ? this.zones.sample(L.x, L.z) : EMPTY_ZONE;
      for (const k of Object.keys(s) as (keyof ZoneSample)[]) this.z[k] += (s[k] - this.z[k]) * 0.35;
    }
    const z = this.z, W = this.weather;
    const winter = this.season === 'winter' ? 1 : 0;
    const city = w.inCity ? 1 : 0.35;

    // ---- beds by hour, zone, weather ----
    const h = w.hour;
    const day = smooth(4.5, 7, h) * (1 - smooth(20, 22.5, h));
    const night = 1 - day;
    const dawn = smooth(4, 5.5, h) * (1 - smooth(7, 8.5, h));
    const work = smooth(7.5, 8.5, h) * (1 - smooth(18, 19, h));
    const rain = clamp(W.rain, 0, 1), snow = clamp(W.snow, 0, 1), wind = clamp(W.wind, 0, 1);
    const dryOut = 1 - 0.7 * rain; // people / kids / birds hide in the rain
    const trafficNear = clamp(0.25 + z.traffic, 0, 1.2);
    const set = (n: Bed, v: number, tc = 1.2) => { const g = this.bed(n); g?.gain.setTargetAtTime(v, t, tc); this.debug.beds[n] = v; };
    set('amb_city', city * (0.28 + 0.25 * day) * (1 - 0.4 * z.green));
    set('amb_roar', city * 0.55 * clamp(w.trafficDensity, 0, 1.3) * trafficNear);
    set('amb_street', city * 0.35 * clamp(w.pedDensity, 0.1, 1.2) * z.crowd * dryOut);
    set('amb_crowd', city * clamp(0.6 * z.crowd + w.pedestrians / 40, 0, 1) * 0.55 * clamp(w.pedDensity, 0.05, 1.2) * dryOut);
    set('footsteps', clamp(w.pedestrians / 30, 0, 1) * 0.35 * (0.4 + 0.6 * z.crowd) * (1 - 0.6 * snow), 0.6);
    set('amb_birds', 0.5 * day * (1 - 0.5 * smooth(12, 17, h)) * (0.35 + 0.65 * z.green) * (1 - winter) * dryOut + 0.2 * dawn * (1 - winter));
    set('amb_crows', 0.3 * day * (0.2 + 0.8 * z.green) * (0.5 + 0.5 * winter));
    set('amb_trees', (0.05 + 0.6 * wind) * z.green * (1 - 0.5 * winter));
    set('amb_kids', 0.6 * z.playground * smooth(8.5, 10, h) * (1 - smooth(20, 21.5, h)) * (1 - 0.7 * winter) * dryOut);
    set('amb_industry', 0.55 * z.industrial * (0.55 + 0.45 * day));
    set('amb_construction', 0.5 * z.industrial * work);
    set('amb_dawn', 0.4 * dawn);
    set('amb_night', 0.5 * night * (1 - 0.5 * z.traffic));
    set('rain_street', 0.75 * rain, 2);
    // snow absorbs high frequencies and quietens the city; night is a little duller too
    this.bedLp.frequency.setTargetAtTime(16000 - 11000 * snow - 3000 * night * (1 - snow), t, 1.5);

    // ---- random events ----
    const ev = this.nextEvent;
    for (const k of Object.keys(ev)) ev[k] -= dt;
    if (ev.dogs <= 0) {
      ev.dogs = 20 + this.rnd() * 50;
      if (this.rnd() < 0.3 + 0.7 * z.yards) this.eventAround(this.rnd() < 0.5 ? 'dogs_1' : 'dogs_2', L, t, 60, 220, 0.5 + 0.3 * night);
    }
    if (ev.alarm <= 0) {
      ev.alarm = 120 + this.rnd() * 240;
      if (z.yards > 0.3 && this.rnd() < 0.25 + 0.5 * night) this.eventAround('car_alarm', L, t, 50, 160, 0.35);
    }
    if (ev.siren <= 0) {
      ev.siren = 60 + this.rnd() * 140;
      if (city > 0.5 && this.rnd() < 0.35 + 0.4 * night) this.eventAround(this.rnd() < 0.5 ? 'siren_1' : 'siren_2', L, t, 250, 500, 0.9);
    }
    if (ev.thunder <= 0 && !this.externalThunder) {
      ev.thunder = 15 + this.rnd() * 45 * (1.5 - rain);
      if (rain > 0.6 && this.rnd() < rain) this.eventAround('thunder', L, t, 800, 2000, 1.6 * rain);
    }
    // church bells: on the hour (8..20) near a church; occasional random peal near the Kremlin cathedrals
    const hourNow = Math.floor(h);
    const ch = this.zones?.nearestChurch(L.x, L.z, 800) ?? null;
    if (this.lastHour >= 0 && hourNow !== this.lastHour && hourNow >= 8 && hourNow <= 20 && ch) this.playAt(this.rnd() < 0.6 ? 'bells' : 'bells_2', ch.x, 30, ch.z, t, 2.2);
    this.lastHour = hourNow;
    if (ev.bells <= 0) {
      ev.bells = 180 + this.rnd() * 300;
      if (ch && day > 0.5 && this.rnd() < 0.4) this.playAt('bells', ch.x, 30, ch.z, t, 1.8);
    }

    // ---- traffic voices: nearest N within 90 m ----
    const near: { car: TrafficCarLike; d: number }[] = [];
    if (w.traffic) {
      for (const car of w.traffic) {
        const dx = car.x - L.x, dz = car.z - L.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 90 * 90 || car.crashed) continue;
        near.push({ car, d: Math.sqrt(d2) });
      }
      near.sort((a, b) => a.d - b.d);
      near.length = Math.min(near.length, this.maxVoices);
    }
    const keep = new Set(near.map((n) => n.car.id));
    this.voices = this.voices.filter((v) => { if (!keep.has(v.id)) { this.dropVoice(v, t); return false; } return true; });
    for (const { car, d } of near) {
      let v = this.voices.find((x) => x.id === car.id);
      if (!v) { v = this.makeVoice(car, t); this.voices.push(v); }
      this.setPos(v.pan, car.x, car.y + 0.6, car.z, t);
      // Doppler: f' = f (c - vl·n)/(c - vs·n), n = unit vector source -> listener
      const nx = (L.x - car.x) / Math.max(d, 0.1), nz = (L.z - car.z) / Math.max(d, 0.1);
      const vsx = car.fx * car.v, vsz = car.fz * car.v;
      const dop = clamp((C_SOUND - (L.vx * nx + L.vz * nz)) / (C_SOUND - (vsx * nx + vsz * nz)), 0.8, 1.25);
      const heavy = v.kind === 'paz' || v.kind === 'liaz';
      const accel = clamp(car.v / 14, 0, 1);
      let rate = 1, lvl = 0.5;
      if (v.kind === 'trolleybus') { rate = 0.9 + 0.2 * accel; lvl = 0.35; }
      else if (heavy) { rate = 0.85 + 0.45 * accel; lvl = 0.55; }
      else { rate = 0.62 + 0.75 * accel; lvl = 0.22 + 0.25 * accel; }
      v.src?.playbackRate.setTargetAtTime(rate * dop, t, 0.08);
      v.gain.gain.setTargetAtTime(lvl, t, 0.12);
      if (v.extra && v.extraGain) {
        v.extra.frequency.setTargetAtTime((260 + car.v * 55) * dop, t, 0.1);
        v.extraGain.gain.setTargetAtTime(0.05 * smooth(0.5, 3, car.v), t, 0.15);
      }
      // buses / trolleybuses: air brakes when they come to a halt (louder at a bus stop)
      const big = heavy || v.kind === 'trolleybus';
      if (big && !v.stopped && car.v < 0.4 && v.prevV >= 0.4) {
        const atStop = this.zones?.nearBusStop(car.x, car.z) ?? false;
        if (atStop || this.rnd() < 0.5) this.playAt(this.rnd() < 0.6 ? 'air_brake' : 'air_brake_2', car.x, car.y + 1, car.z, t, atStop ? 0.9 : 0.6);
      }
      v.stopped = car.v < 0.4;
      v.prevV = car.v;
    }
    // ---- trains ----
    if (!this.rumble.started) {
      const s = this.lib.loop('train_rumble');
      if (s) { s.connect(this.rumble.gain); s.start(t); this.rumble.started = true; }
    }
    this.rumble.gain.gain.setTargetAtTime(0.9 * w.trainRumble, t, 0.3);
    if (w.trainPos) this.setPos(this.rumble.pan, w.trainPos.x, w.trainPos.y, w.trainPos.z, t);
  }

  /** Positional one-shot (train horn, bells, dogs…). */
  playAt(name: string, x: number, y: number, z: number, t: number, gain = 1): void {
    if (!this.lib.get(name)) return;
    const p = this.panner(25);
    this.setPos(p, x, y, z, t);
    p.connect(this.worldOut);
    const g = this.lib.play(name, p, t, gain, 1, () => p.disconnect());
    if (!g) p.disconnect();
  }
}
