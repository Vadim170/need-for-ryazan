/**
 * Audio graph for the game and for offline renders (works on any BaseAudioContext):
 *
 *   engine ─┐                      ┌─> env send ─> Environment (3 convolvers + slap-back) ─┐
 *   car sfx ┴─> playerBus ─────────┤                                                       ├─> mix ─> master (volume/mute) ─> limiter ─> out
 *   ambience beds + world voices ──┴─(world part also to env send)─────────────────────────┘
 */
import { EngineAudio, ENGINE_PRESETS } from './engine-audio';
import { VehicleSfx, type PlayerTelemetry } from './vehicle-sfx';
import { Environment, type EnvState } from './environment';
import { Ambience, type HumLoop, type Season, type WeatherState, type WorldAudioInput } from './ambience';
import { SampleLib } from './sample-lib';
import { GtaAudio } from './gta-audio';
import { ENGINE_BASE_URL, type EngineManifest } from './engine-bank';

export interface AudioSystemOptions {
  preset: string;
  /** Ambience / traffic / trains (off for engine-only renders). */
  world: boolean;
  /** Wait until all ambience samples are decoded (offline renders). */
  waitWorld?: boolean;
}

/** Samples only needed by the world ambience (loaded after the player car). */
const WORLD_ONLY = /^(amb_|bells|dogs|siren|car_alarm|air_brake|footsteps|thunder|train_|bus_idle|trolley|horn_2|gun_|ricochet|bullet|punch|body_fall|step_|door_|explosion|reload|dry_fire|pickup|scream)/;

export class AudioSystem {
  readonly lib: SampleLib;
  readonly engine: EngineAudio;
  sfx!: VehicleSfx;
  readonly env: Environment;
  amb: Ambience | null = null;
  gta: GtaAudio | null = null;
  /** Player car heard in 3D when the player walks away from it (GTA mode): dry path vs panned path. */
  private playerDry: GainNode;
  private playerPan: PannerNode;
  private playerPanGain: GainNode;
  private spatial = false;
  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;
  private playerBus: GainNode;
  private envSend: GainNode;
  private mix: GainNode;
  volume = 0.7;
  /** Output meter (after limiter + soft clip): debug checks of peaks / overs. */
  meter!: AnalyserNode;
  private meterBuf = new Float32Array(2048);
  /** Peak |sample| of the last ~43 ms at the output and the limiter's current gain reduction (dB). */
  meterRead(): { peak: number; reductionDb: number } {
    this.meter.getFloatTimeDomainData(this.meterBuf);
    let p = 0;
    for (const v of this.meterBuf) p = Math.max(p, Math.abs(v));
    return { peak: p, reductionDb: this.limiter.reduction };
  }
  muted = false;

  private constructor(readonly ctx: BaseAudioContext) {
    this.lib = new SampleLib(ctx);
    this.engine = new EngineAudio(ctx, this.lib);
    this.env = new Environment(ctx);
    this.mix = ctx.createGain();
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.limiter = ctx.createDynamicsCompressor();
    // gain staging: the mix runs ~-14 LUFS at full chat (engine + nitro + wind + city); the compressor only rides peaks
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.2;
    // the compressor is not a brick wall: a transparent soft clipper after it catches the remaining overs (impacts)
    const clip = ctx.createWaveShaper();
    const n = 4096, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
      curve[i] = Math.sign(x) * (a < 0.8 ? a : 0.8 + 0.19 * Math.tanh((a - 0.8) / 0.19));
    }
    clip.curve = curve;
    clip.oversample = '4x';
    this.mix.connect(this.master).connect(this.limiter).connect(clip).connect(ctx.destination);
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 2048;
    clip.connect(this.meter);
    this.playerBus = ctx.createGain();
    this.playerBus.gain.value = 0.85;
    this.envSend = ctx.createGain();
    this.envSend.gain.value = 0.45;
    this.playerDry = ctx.createGain();
    this.playerPan = ctx.createPanner();
    this.playerPan.panningModel = 'equalpower'; this.playerPan.distanceModel = 'inverse'; this.playerPan.refDistance = 5; this.playerPan.rolloffFactor = 1.1;
    this.playerPanGain = ctx.createGain(); this.playerPanGain.gain.value = 0;
    this.playerBus.connect(this.playerDry).connect(this.mix);
    this.playerBus.connect(this.playerPan).connect(this.playerPanGain).connect(this.mix);
    this.playerBus.connect(this.envSend);
    this.engine.popsOut.connect(this.envSend); // pops ring out more in the street
    this.envSend.connect(this.env.input);
    this.env.output.connect(this.mix);
    this.engine.output.connect(this.playerBus);
  }

  static async create(ctx: BaseAudioContext, opts: AudioSystemOptions): Promise<AudioSystem> {
    const a = new AudioSystem(ctx);
    const preset = ENGINE_PRESETS[opts.preset] ? opts.preset : 'velvet';
    // player-car samples first (engine starts quickly); world ambience streams in afterwards
    await Promise.all([a.lib.load((n) => !WORLD_ONLY.test(n)), a.engine.init(preset)]);
    a.sfx = new VehicleSfx(ctx, a.lib);
    a.sfx.output.connect(a.playerBus);
    if (opts.world) {
      a.amb = new Ambience(ctx, a.lib, []);
      a.amb.output.connect(a.mix);
      a.amb.worldOut.connect(a.envSend);
      const amb = a.amb;
      const rest = Promise.all([a.lib.load(), loadHums(ctx).then((h) => amb.setHums(h))]).catch((e) => console.warn('[audio] ambience', e));
      a.gta = new GtaAudio(ctx, a.lib, amb.worldOut, a.mix, () => a.env.current);
      if (opts.waitWorld) await rest;
    }
    a.applyWeather();
    return a;
  }

  get presetName(): string { return this.engine.presetName; }
  async setPreset(name: string): Promise<void> { await this.engine.setPreset(name); }

  setVolume(v: number): void {
    this.volume = v;
    this.applyMaster();
  }
  setMuted(m: boolean): void { this.muted = m; this.applyMaster(); }
  toggleMute(): boolean { this.setMuted(!this.muted); return this.muted; }
  private applyMaster(): void {
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, t, 0.05);
  }

  /** Player car: engine + tyres/wind/impacts. */
  updatePlayer(s: PlayerTelemetry, dt: number, t: number): void {
    this.engine.update(s, dt, t);
    this.sfx?.update(s, dt, t);
  }

  updateEnv(e: EnvState, t: number): void { this.env.set(e, t); }

  /** On foot (GTA mode): the parked / last driven car is heard from its position; in the car: dry, close. */
  setPlayerSpatial(onFoot: boolean, x: number, y: number, z: number, t: number): void {
    const p = this.playerPan;
    if (p.positionX) { p.positionX.setTargetAtTime(x, t, 0.03); p.positionY.setTargetAtTime(y + 0.5, t, 0.03); p.positionZ.setTargetAtTime(z, t, 0.03); }
    if (onFoot !== this.spatial) {
      this.spatial = onFoot;
      this.playerDry.gain.setTargetAtTime(onFoot ? 0 : 1, t, 0.25);
      this.playerPanGain.gain.setTargetAtTime(onFoot ? 1 : 0, t, 0.25);
    }
  }

  // ---- weather / season hooks (src/render/weather.ts) ----
  private weather: WeatherState = { rain: 0, snow: 0, wind: 0.2 };
  private season: Season = 'summer';
  /** rain / snow / wind intensity 0..1 (any subset). */
  setWeather(w: Partial<WeatherState>): void { Object.assign(this.weather, w); this.applyWeather(); }
  setSeason(s: Season): void { this.season = s; this.applyWeather(); }
  thunder(delay: number, intensity: number): void { this.amb?.thunder(delay, intensity, this.ctx.currentTime); }
  get weatherState(): WeatherState & { season: Season } { return { ...this.weather, season: this.season }; }
  private applyWeather(): void {
    const w = this.weather, winter = this.season === 'winter';
    this.amb?.setWeather(w);
    if (this.amb) this.amb.season = this.season;
    if (this.gta) { this.gta.winter = winter; this.gta.snowCover = winter ? Math.max(0.6, w.snow) : w.snow; }
    if (this.sfx) {
      this.sfx.surface.rain = w.rain;
      this.sfx.surface.wet = Math.min(1, w.rain + (winter ? 0.3 * w.snow : 0));
      this.sfx.surface.snow = winter ? Math.max(0.6, w.snow) : w.snow;
      this.sfx.windBoost = w.wind;
    }
  }

  updateWorld(w: WorldAudioInput, dt: number, t: number): void { this.amb?.update(w, dt, t); }
}

/** Traffic car hums: cruise loops (≈1600–2400 rpm) of the 'stock' engine bank, played straight from its sprite. */
async function loadHums(ctx: BaseAudioContext): Promise<HumLoop[]> {
  const base = `${ENGINE_BASE_URL}stock/`;
  const man = (await (await fetch(base + 'manifest.json')).json()) as EngineManifest;
  const buf = await ctx.decodeAudioData(await (await fetch(base + man.file)).arrayBuffer());
  return man.loops
    .filter((l) => (l.layer === 'cruise' || l.layer === 'on') && l.rpm >= 1500 && l.rpm <= 2600)
    .slice(0, 4)
    .map((l) => ({ buffer: buf, start: l.start, end: l.start + l.length }));
}
