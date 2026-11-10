/**
 * Realtime adapter between the game and AudioSystem: creates the AudioContext on the first user gesture,
 * derives player telemetry (impacts / bumps from velocity changes), probes the acoustic environment around the car
 * (raycasts, 5 Hz), feeds traffic / trains / pedestrians / time of day to the ambience, rail horn events,
 * master volume + mute (N), engine preset (?engine=velvet|aggressive|stock or the debug GUI).
 */
import * as THREE from 'three';
import type GUI from 'lil-gui';
import { AudioSystem } from './audio-system';
import { ENGINE_PRESETS } from './engine-audio';
import { OPEN_ENV, type EnvState } from './environment';
import type { PlayerTelemetry } from './vehicle-sfx';
import type { Season, TrafficCarLike, WeatherState } from './ambience';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import type { Vehicle } from '../vehicle/vehicle';
import { gameEvents } from '../combat/events';
import type { SirenSource } from './gta-audio';

/** Ray filter: only static world geometry (membership bit 1: ground, buildings, bridges). */
const WORLD_ONLY = (0xffff << 16) | 0x0001;

export interface GameAudioFrame {
  car: Vehicle;
  camera: THREE.Camera;
  hour: number;
  inCity: boolean;
  traffic?: { sim: { vehicles: Iterable<TrafficCarLike> } } | null;
  trafficDensity?: number;
  pedDensity?: number;
  /** Count people within r metres of (x,z). */
  pedestriansNear?: (x: number, z: number, r: number) => number;
  rail?: { rumble: number; forEachTrain(cb: (xz: number[]) => void): void } | null;
  /** GTA mode: player walks (car is heard from where it stands), player position, police sirens (polled). */
  onFoot?: boolean;
  focus?: THREE.Vector3;
  sirens?: () => SirenSource[];
}

import { SwearVoices, type SwearWho, type SwearKind } from './swear';

export class GameAudio {
  sys: AudioSystem | null = null;
  /** Ругань пешеходов (src/audio/swear.ts). */
  swear: SwearVoices | null = null;
  private listenerXZ = { x: 0, z: 0 };
  private ctx: AudioContext | null = null;
  private starting: Promise<void> | null = null;
  private volume = 0.7;
  private muted = false;
  preset: string;
  private prevV = new THREE.Vector3();
  private hasPrev = false;
  private envTimer = 0;
  private env: EnvState = { ...OPEN_ENV };
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  private railHooked = false;
  private v = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private up = new THREE.Vector3();
  private lastCam = new THREE.Vector3();
  private pedTimer = 0;
  private peds = 0;
  private status = { state: 'not started', preset: '' };

  constructor(private readonly physics: PhysicsWorld | null = null) {
    const q = new URLSearchParams(location.search).get('engine');
    this.preset = q && ENGINE_PRESETS[q] ? q : 'velvet';
    try {
      const v = localStorage.getItem('nfr.audio.volume');
      if (v !== null) this.volume = Math.min(1, Math.max(0, +v));
      this.muted = localStorage.getItem('nfr.audio.muted') === '1';
    } catch { /* private mode */ }
  }

  /** Пешеход ругается (people-system onShout): позиционно, только вблизи, громче если кричит в сторону слушателя. */
  shout(agent: number, who: SwearWho, kind: SwearKind, x: number, y: number, z: number, yaw: number): void {
    this.swear?.shout(agent, who, kind, x, y, z, yaw, this.listenerXZ);
  }

  /** Call from a user gesture (autoplay policy). Safe to call repeatedly. */
  start(): Promise<void> {
    if (this.ctx) { void this.ctx.resume(); return this.starting ?? Promise.resolve(); }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return Promise.resolve();
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    this.status.state = 'loading';
    this.starting = AudioSystem.create(ctx, { preset: this.preset, world: true })
      .then((sys) => {
        this.sys = sys;
        sys.setVolume(this.volume);
        sys.setMuted(this.muted);
        sys.setWeather(this.weather);
        sys.setSeason(this.season);
        sys.lib.play('start', sys.master, ctx.currentTime + 0.05, 0.6);
        this.status.state = ctx.state;
        this.status.preset = sys.presetName;
        ctx.onstatechange = () => { this.status.state = ctx.state; };
        this.hookGameEvents();
        this.swear = new SwearVoices(ctx, sys.amb?.worldOut ?? sys.master);
      })
      .catch((e) => { console.error('[audio] init failed', e); this.status.state = 'error: ' + e; });
    return this.starting;
  }

  setVolume(v: number): void {
    this.volume = v;
    this.sys?.setVolume(v);
    try { localStorage.setItem('nfr.audio.volume', String(v)); } catch { /* ignore */ }
  }
  setMuted(m: boolean): void {
    this.muted = m;
    this.sys?.setMuted(m);
    try { localStorage.setItem('nfr.audio.muted', m ? '1' : '0'); } catch { /* ignore */ }
  }
  toggleMute(): boolean { this.setMuted(!this.muted); return this.muted; }
  async setPreset(name: string): Promise<void> {
    this.preset = name;
    if (this.sys) { await this.sys.setPreset(name); this.status.preset = this.sys.presetName; }
  }

  /** Debug GUI folder: volume, mute, engine preset, reverb amount, live readout. */
  addGui(gui: GUI): void {
    const f = gui.addFolder('audio (N = mute)');
    const o = {
      volume: this.volume, mute: this.muted, engine: this.preset, reverb: 1,
    };
    f.add(o, 'volume', 0, 1, 0.01).onChange((v: number) => this.setVolume(v));
    const mc = f.add(o, 'mute').onChange((m: boolean) => this.setMuted(m));
    f.add(o, 'engine', Object.keys(ENGINE_PRESETS)).name('engine preset').onChange((n: string) => void this.setPreset(n));
    f.add(o, 'reverb', 0, 2, 0.05).name('reverb amount').onChange((r: number) => { if (this.sys) this.sys.env.amount = r; });
    const wx = { rain: this.weather.rain, snow: this.weather.snow, wind: this.weather.wind, winter: this.season === 'winter' };
    const wf = f.addFolder('weather test (normally set by weather.ts)');
    wf.add(wx, 'rain', 0, 1, 0.05).onChange((v: number) => this.setWeather({ rain: v }));
    wf.add(wx, 'snow', 0, 1, 0.05).onChange((v: number) => this.setWeather({ snow: v }));
    wf.add(wx, 'wind', 0, 1, 0.05).onChange((v: number) => this.setWeather({ wind: v }));
    wf.add(wx, 'winter').onChange((v: boolean) => this.setSeason(v ? 'winter' : 'summer'));
    wf.close();
    f.add(this.status, 'state').name('context').listen().disable();
    f.close();
    this.onMuteChange = (m) => { o.mute = m; mc.updateDisplay(); };
  }
  private onMuteChange: ((m: boolean) => void) | null = null;
  /** Keyboard N. */
  toggleMuteFromKey(): void { const m = this.toggleMute(); this.onMuteChange?.(m); }

  private probeEnv(pos: THREE.Vector3, exclude: RAPIER.RigidBody): EnvState {
    const ph = this.physics;
    if (!ph) return OPEN_ENV;
    const w = ph.world, r = this.ray;
    let hits = 0, distSum = 0, sideL = 99, sideR = 99;
    const N = 8, R = 45;
    r.origin.x = pos.x; r.origin.y = pos.y + 1.6; r.origin.z = pos.z;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      r.dir.x = Math.cos(a); r.dir.y = 0; r.dir.z = Math.sin(a);
      const h = w.castRay(r, R, true, undefined, WORLD_ONLY, undefined, exclude);
      if (h) {
        hits++; distSum += h.timeOfImpact;
        if (i === 0) sideR = h.timeOfImpact;
        if (i === 4) sideL = h.timeOfImpact;
      }
    }
    r.dir.x = 0; r.dir.y = 1; r.dir.z = 0;
    const upHit = w.castRay(r, 25, true, undefined, WORLD_ONLY, undefined, exclude);
    const meanD = hits ? distSum / hits : 60;
    const canyon = Math.min(1, 1.6 * (hits / N) * Math.max(0, 1 - meanD / 55));
    const covered = upHit ? Math.max(0, 1 - upHit.timeOfImpact / 25) * 0.6 + 0.4 : 0;
    const narrow = Math.min(sideL, sideR) < 12 ? 0.3 : 0;
    return { canyon: Math.min(1, canyon + narrow * covered), covered, wallDist: meanD };
  }

  update(dt: number, f: GameAudioFrame): void {
    const sys = this.sys, ctx = this.ctx;
    if (!sys || !ctx || ctx.state !== 'running' || dt <= 0) return;
    const t = ctx.currentTime;
    const car = f.car;
    const lv = car.body.linvel();
    this.v.set(lv.x, lv.y, lv.z);
    let impact = 0, bump = 0;
    if (this.hasPrev) {
      const dvx = this.v.x - this.prevV.x, dvy = this.v.y - this.prevV.y, dvz = this.v.z - this.prevV.z;
      const k = Math.min(1, (1 / 60) / dt); // per-physics-step equivalent when frames are long
      const dv = Math.hypot(dvx, dvy, dvz) * k;
      if (dv > 1.5) impact = dv;
      if (Math.abs(dvy) * k > 0.6 && car.groundedWheels >= 2) bump = Math.abs(dvy) * k * 1.5;
    }
    this.prevV.copy(this.v); this.hasPrev = true;
    const eng = car.cfg.engine;
    const tel: PlayerTelemetry = {
      rpm: car.rpm, throttle: car.throttleOut, load: car.engineLoad, gear: car.gear, speed: car.speed,
      nitro: car.nitroActive, skid: car.skid, handbrake: car.input.handbrake, drifting: car.drifting,
      grounded: car.groundedWheels, impact, bump, idleRpm: eng.idleRpm, redlineRpm: eng.redlineRpm,
    };
    sys.updatePlayer(tel, dt, t);
    const onFoot = !!f.onFoot;
    sys.setPlayerSpatial(onFoot, car.position.x, car.position.y, car.position.z, t);
    // environment probe @5 Hz (around the player: the car, or the pedestrian in GTA mode)
    this.envTimer -= dt;
    if (this.envTimer <= 0) {
      this.envTimer = 0.2;
      this.env = this.probeEnv(onFoot && f.focus ? f.focus : car.position, car.body);
      sys.updateEnv(this.env, t);
    }
    // world
    if (!this.railHooked && f.rail && 'onEvent' in f.rail) {
      this.railHooked = true;
      (f.rail as unknown as { onEvent(cb: (e: { type: string; x?: number; y?: number; z?: number }) => void): void })
        .onEvent((e) => {
          if (e.type === 'horn' && e.x !== undefined && this.sys?.amb && this.ctx)
            this.sys.amb.playAt(Math.random() < 0.6 ? 'train_horn' : 'train_horn_2', e.x, e.y ?? 0, e.z!, this.ctx.currentTime, 1.4);
        });
    }
    const cam = f.camera;
    cam.getWorldDirection(this.fwd);
    this.up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const cp = cam.position;
    const cvx = (cp.x - this.lastCam.x) / dt, cvz = (cp.z - this.lastCam.z) / dt;
    this.lastCam.copy(cp);
    this.pedTimer -= dt;
    if (this.pedTimer <= 0 && f.pedestriansNear) { this.pedTimer = 0.5; this.peds = f.pedestriansNear(cp.x, cp.z, 40); }
    let trainPos: { x: number; y: number; z: number } | null = null;
    if (f.rail && f.rail.rumble > 0.01) {
      let best = 1e9;
      f.rail.forEachTrain((xz) => {
        for (let i = 0; i < xz.length; i += 2) {
          const d = Math.hypot(xz[i] - cp.x, xz[i + 1] - cp.z);
          if (d < best) { best = d; trainPos = { x: xz[i], y: cp.y, z: xz[i + 1] }; }
        }
      });
    }
    sys.gta?.setListener(cp.x, cp.y, cp.z, Math.abs(cvx) < 100 ? cvx : 0, Math.abs(cvz) < 100 ? cvz : 0);
    if (f.sirens) sys.gta?.updateSirens(f.sirens(), t);
    this.listenerXZ.x = cp.x; this.listenerXZ.z = cp.z;
    sys.updateWorld({
      listener: { x: cp.x, y: cp.y, z: cp.z, fx: this.fwd.x, fy: this.fwd.y, fz: this.fwd.z, ux: this.up.x, uy: this.up.y, uz: this.up.z,
        vx: Math.abs(cvx) < 100 ? cvx : 0, vz: Math.abs(cvz) < 100 ? cvz : 0 },
      hour: f.hour, traffic: f.traffic?.sim.vehicles ?? null, trafficDensity: f.trafficDensity ?? 0.5,
      pedestrians: this.peds, pedDensity: f.pedDensity ?? 0.5, trainRumble: f.rail?.rumble ?? 0, trainPos, inCity: f.inCity,
    }, dt, t);
  }

  // ---- hooks for the weather system (src/render/weather.ts) ----
  private weather: WeatherState = { rain: 0, snow: 0, wind: 0.2 };
  private season: Season = 'summer';
  /** Weather intensities 0..1: rain (rain on the car, street rain, thunder, wet tyres), snow (muffled city,
   * snow under the tyres), wind (gusts, wind in trees). Partial updates are fine; safe before audio starts. */
  setWeather(w: Partial<WeatherState>): void { Object.assign(this.weather, w); this.sys?.setWeather(this.weather); }
  /** Lightning hook (src/render/weather-system.ts): thunder after `delaySec` (distance / 340), intensity 0..1. */
  thunder(delaySec: number, intensity: number): void { this.sys?.thunder(delaySec, Math.max(0, Math.min(1, intensity))); }
  /** 'winter': packed snow / slush tyre layers, no songbirds, fewer kids outside. */
  setSeason(s: Season): void { this.season = s; this.sys?.setSeason(s); }

  /** GTA-mode events (src/combat/events.ts) -> sounds. */
  private hookGameEvents(): void {
    const now = () => this.ctx?.currentTime ?? 0;
    const g = () => this.sys?.gta ?? null;
    gameEvents.on('gunshot', (e) => g()?.gunshot(e.weapon, e.x, e.y, e.z, now(), e.byPlayer));
    gameEvents.on('impact', (e) => g()?.impact(e.surface, e.x, e.y, e.z, now()));
    gameEvents.on('punch', (e) => { if (e.hit) g()?.play(Math.random() < 0.5 ? 'punch_1' : 'punch_3', e.x, e.y, e.z, now(), e.kick ? 0.9 : 0.7, 4); });
    gameEvents.on('footstep', (e) => g()?.footstep(e.x, e.y, e.z, e.speed, e.surface, now(), e.byPlayer));
    gameEvents.on('jump', (e) => g()?.footstep(e.x, e.y, e.z, 4, -1, now(), true));
    gameEvents.on('land', (e) => g()?.play('body_fall', e.x, e.y, e.z, now(), Math.min(0.8, 0.2 + e.speed / 12), 4, 1.3));
    gameEvents.on('carDoor', (e) => {
      const t = now();
      if (e.open) { g()?.play('door_handle', e.x, e.y, e.z, t, 0.6, 3); g()?.play('door_open', e.x, e.y, e.z, t + 0.12, 0.7, 4); }
      else g()?.play('door_close', e.x, e.y, e.z, t, 0.9, 5);
    });
    gameEvents.on('explosion', (e) => {
      const t = now(), p = Math.max(0.4, Math.min(1.5, e.power));
      g()?.play(Math.random() < 0.5 ? 'explosion_1' : 'explosion_2', e.x, e.y, e.z, t, p, 30);
      g()?.gunshot('shotgun', e.x, e.y, e.z, t, false); // extra crack + facade echoes
    });
    gameEvents.on('reload', () => g()?.ui('reload', now(), 0.7));
    gameEvents.on('dryFire', () => g()?.ui('dry_fire', now(), 0.8));
    gameEvents.on('weaponSwitch', () => g()?.ui('reload', now(), 0.35));
    gameEvents.on('pickup', () => g()?.ui('pickup', now(), 0.6));
    gameEvents.on('wanted', (e) => g()?.wanted(e.level, e.prev, now()));
    gameEvents.on('scream', (e) => g()?.play(Math.random() < 0.5 ? 'scream_f' : 'scream_m', e.x, e.y, e.z, now(), 0.6, 8, 0.9 + 0.2 * Math.random()));
    gameEvents.on('wasted', () => g()?.stinger(now(), false));
    gameEvents.on('busted', () => g()?.stinger(now(), true));
  }

  horn(): void { if (this.sys && this.ctx) this.sys.sfx.horn(this.ctx.currentTime); }
}
