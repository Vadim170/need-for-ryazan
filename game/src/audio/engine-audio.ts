/**
 * Player engine sound: sample-based cycle-synchronous granular synthesis (AudioWorklet "engine-synth",
 * see engine-worklet.ts) from real recordings sliced into RPM × load loops (docs/stage2/audio.md), plus
 * induction, overrun crackles, shift cut / blip, limiter bounce, turbo (preset), reverse-gear whine,
 * "velvet" tone shaping (low shelf, mid scoop, soft saturation, load-dependent lowpass).
 *
 * Public API kept from the placeholder: setRpm / setThrottle / setLoad (+ update(telemetry) for everything else).
 * All automation is scheduled at an explicit context time `t`, so the same code renders in OfflineAudioContext.
 */
import workletUrl from './engine-worklet.ts?worker&url';
import { bankMessage, loadEngineBank, mapRpm, type EngineBank } from './engine-bank';
import { mulberry32, type SampleLib } from './sample-lib';

export interface EngineTone {
  label: string;
  /** Loop bank directory in public/assets/audio/engine/. */
  bank: string;
  gainDb: number;
  shelfHz: number; shelfDb: number;
  midHz: number; midDb: number; midQ: number;
  presenceHz: number; presenceDb: number;
  drive: number; // waveshaper drive (soft tanh), 1 = clean
  lpBase: number; lpLoad: number; lpRpm: number; // lowpass cutoff = base + load*lpLoad + rpmRel*lpRpm
  offLoadDb: number; // level of the overrun layer relative to full load
  intake: number; // induction layer level
  crackle: number; // 0..1 overrun pops density
  popGainDb: number;
  turbo: number; // 0 = none
}

export const ENGINE_PRESETS: Record<string, EngineTone> = {
  velvet: {
    label: 'Бархатный (V6 3.2, спорт-выхлоп)', bank: 'velvet', gainDb: -0.5,
    shelfHz: 140, shelfDb: 4.5, midHz: 2600, midDb: -3, midQ: 0.8, presenceHz: 5500, presenceDb: -4,
    drive: 1.6, lpBase: 2600, lpLoad: 4200, lpRpm: 3500, offLoadDb: -7, intake: 0.18, crackle: 0.55, popGainDb: -9, turbo: 0,
  },
  aggressive: {
    label: 'Агрессивный (оппозит 2.0, прямоток, турбо)', bank: 'aggressive', gainDb: -3,
    shelfHz: 110, shelfDb: 3, midHz: 1800, midDb: 1.5, midQ: 0.9, presenceHz: 4200, presenceDb: 1,
    drive: 2.6, lpBase: 3500, lpLoad: 6000, lpRpm: 4000, offLoadDb: -5, intake: 0.35, crackle: 1, popGainDb: -5, turbo: 1,
  },
  stock: {
    label: 'Сток Largus (рядная 4-ка)', bank: 'stock', gainDb: 2.5,
    shelfHz: 160, shelfDb: 1, midHz: 2200, midDb: 0, midQ: 0.8, presenceHz: 5000, presenceDb: -2,
    drive: 1.15, lpBase: 2000, lpLoad: 3500, lpRpm: 3000, offLoadDb: -9, intake: 0.12, crackle: 0, popGainDb: -20, turbo: 0,
  },
};

export interface EngineTelemetry {
  rpm: number; // game rpm
  throttle: number; // pedal 0..1 (drive input, also in reverse)
  load: number; // 0..1 torque fraction from the vehicle (0 during shift cut / limiter)
  gear: number; // -1 = R, 1..N
  speed: number; // m/s
  nitro: boolean;
  idleRpm: number;
  redlineRpm: number;
}

const dbg = (db: number) => Math.pow(10, db / 20);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smoothstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

const workletLoaded = new WeakMap<BaseAudioContext, Promise<void>>();
export function loadEngineWorklet(ctx: BaseAudioContext): Promise<void> {
  let p = workletLoaded.get(ctx);
  if (!p) { p = ctx.audioWorklet.addModule(workletUrl); workletLoaded.set(ctx, p); }
  return p;
}

function softClipCurve(drive: number, n = 2048): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const k = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // slightly asymmetric soft clip -> a touch of even harmonics ("warmth")
    c[i] = (Math.tanh(drive * (x + 0.08 * x * x)) - Math.tanh(drive * 0)) / k;
  }
  return c;
}

/** Debug readout of the internal state (GUI / lab). */
export interface EngineDebug { soundRpm: number; loadEff: number; wOff: number; wCruise: number; wOn: number; crackle: number; boost: number; maxGrains: number; dropped: number }

export class EngineAudio {
  readonly output: GainNode; // dry engine (exhaust + intake + pops)
  readonly popsOut: GainNode; // pops only (extra reverb send)
  private node: AudioWorkletNode | null = null;
  private bank: EngineBank | null = null;
  private tone: EngineTone = ENGINE_PRESETS.velvet;
  presetName = 'velvet';

  // tone chain
  private hp: BiquadFilterNode;
  private shelf: BiquadFilterNode;
  private mid: BiquadFilterNode;
  private presence: BiquadFilterNode;
  private shaper: WaveShaperNode;
  private lp: BiquadFilterNode;
  private exGain: GainNode;
  private inBp: BiquadFilterNode;
  private inGain: GainNode;
  private popHp: BiquadFilterNode;
  private popShaper: WaveShaperNode;
  private popGain: GainNode;
  // extras
  private whine: OscillatorNode;
  private whine2: OscillatorNode;
  private whineGain: GainNode;
  private turboOsc: OscillatorNode;
  private turboGain: GainNode;
  private master: GainNode;

  // compat setters (placeholder API)
  private rpmIn = 900;
  private thrIn = 0;
  private loadIn = 0;

  // control state
  private rpmA = 900; private rpmS = 900; private thrS = 0; private loadEff = 0; private thrPeak = 0;
  private prevGear = 1; private shiftT = 0; private blipT = 0; private crackleT = 0; private crackleAmt = 0;
  private limPh = 0; private limOff = 0; private limAmt = 0; private boost = 0; private nitroAmt = 0;
  private rnd = mulberry32(1234);
  /** Highest sound rpm with real material per layer (0 = layer missing in this bank). */
  private layerTop = { off: 0, cruise: 0, on: 0 };
  readonly debug: EngineDebug = { soundRpm: 0, loadEff: 0, wOff: 0, wCruise: 0, wOn: 0, crackle: 0, boost: 0, maxGrains: 0, dropped: 0 };

  constructor(private readonly ctx: BaseAudioContext, private readonly lib: SampleLib | null = null) {
    const c = ctx;
    this.master = c.createGain();
    this.master.gain.value = 1;
    this.output = this.master;
    this.popsOut = c.createGain();

    this.hp = c.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 26; this.hp.Q.value = 0.6;
    this.shelf = c.createBiquadFilter(); this.shelf.type = 'lowshelf';
    this.mid = c.createBiquadFilter(); this.mid.type = 'peaking';
    this.presence = c.createBiquadFilter(); this.presence.type = 'highshelf';
    this.shaper = c.createWaveShaper(); this.shaper.oversample = '2x';
    this.lp = c.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.Q.value = 0.5;
    this.exGain = c.createGain();
    this.hp.connect(this.shelf).connect(this.mid).connect(this.presence).connect(this.shaper).connect(this.lp).connect(this.exGain).connect(this.master);

    this.inBp = c.createBiquadFilter(); this.inBp.type = 'bandpass'; this.inBp.frequency.value = 1400; this.inBp.Q.value = 0.7;
    this.inGain = c.createGain(); this.inGain.gain.value = 0;
    this.inBp.connect(this.inGain).connect(this.master);

    this.popHp = c.createBiquadFilter(); this.popHp.type = 'highpass'; this.popHp.frequency.value = 60;
    this.popShaper = c.createWaveShaper(); this.popShaper.curve = softClipCurve(3); this.popShaper.oversample = '2x';
    this.popGain = c.createGain();
    this.popHp.connect(this.popShaper).connect(this.popGain);
    this.popGain.connect(this.master);
    this.popGain.connect(this.popsOut);

    // reverse gear whine (straight-cut gears): two partials through a resonant bandpass
    this.whine = c.createOscillator(); this.whine.type = 'sawtooth';
    this.whine2 = c.createOscillator(); this.whine2.type = 'sine';
    const wbp = c.createBiquadFilter(); wbp.type = 'bandpass'; wbp.Q.value = 3; wbp.frequency.value = 700;
    this.whineGain = c.createGain(); this.whineGain.gain.value = 0;
    const w2g = c.createGain(); w2g.gain.value = 0.4;
    this.whine.connect(wbp); this.whine2.connect(w2g).connect(wbp);
    wbp.connect(this.whineGain).connect(this.master);
    this.whine.start(); this.whine2.start();
    // turbo whistle
    this.turboOsc = c.createOscillator(); this.turboOsc.type = 'sine'; this.turboOsc.frequency.value = 2000;
    this.turboGain = c.createGain(); this.turboGain.gain.value = 0;
    this.turboOsc.connect(this.turboGain).connect(this.master);
    this.turboOsc.start();
    this.applyTone(this.tone);
  }

  /** Loads the worklet + bank for a preset. Safe to call again to switch presets. */
  async init(preset = 'velvet'): Promise<void> {
    await loadEngineWorklet(this.ctx);
    if (!this.node) {
      this.node = new AudioWorkletNode(this.ctx, 'engine-synth', { numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [1, 1, 1] });
      this.node.connect(this.hp, 0);
      this.node.connect(this.inBp, 1);
      this.node.connect(this.popHp, 2);
      this.node.port.postMessage({ type: 'seed', seed: 777 });
      this.node.port.onmessage = (e) => {
        const d = e.data as { type?: string; maxGrains?: number; dropped?: number };
        if (d?.type === 'stats') { this.debug.maxGrains = d.maxGrains ?? 0; this.debug.dropped += d.dropped ?? 0; }
      };
    }
    await this.setPreset(preset);
  }

  async setPreset(name: string): Promise<void> {
    const tone = ENGINE_PRESETS[name] ?? ENGINE_PRESETS.velvet;
    const bank = await loadEngineBank(this.ctx, tone.bank);
    this.bank = bank;
    this.tone = tone;
    for (const k of ['off', 'cruise', 'on'] as const) {
      const r = bank.manifest.loops.filter((l) => l.layer === k).map((l) => l.rpm);
      this.layerTop[k] = r.length ? Math.max(...r) : 0;
    }
    this.presetName = ENGINE_PRESETS[name] ? name : 'velvet';
    this.applyTone(tone);
    const msg = bankMessage(bank);
    const node = this.node;
    if (!node) return;
    const ready = new Promise<void>((res) => {
      const prev = node.port.onmessage;
      node.port.onmessage = (e) => { if ((e.data as { type?: string })?.type === 'ready') { node.port.onmessage = prev; res(); } else prev?.call(node.port, e); };
    });
    node.port.postMessage(msg, [msg.data.buffer]);
    await ready;
  }

  get presetTitle(): string { return this.bank?.manifest.title ?? ''; }

  private applyTone(t: EngineTone): void {
    this.shelf.frequency.value = t.shelfHz; this.shelf.gain.value = t.shelfDb;
    this.mid.frequency.value = t.midHz; this.mid.gain.value = t.midDb; this.mid.Q.value = t.midQ;
    this.presence.frequency.value = t.presenceHz; this.presence.gain.value = t.presenceDb;
    this.shaper.curve = softClipCurve(t.drive);
    this.popGain.gain.value = dbg(t.popGainDb);
  }

  // ---- placeholder-compatible API (main loop used these) ----
  setRpm(rpm: number): void { this.rpmIn = rpm; }
  /** 0..1 pedal position. */
  setThrottle(t: number): void { this.thrIn = t; }
  /** 0..1 engine load (torque fraction). */
  setLoad(l: number): void { this.loadIn = l; }
  /** Compat: master level of the engine only. */
  setVolume(v: number): void { this.master.gain.value = v; }

  /** Uses the values from setRpm/setThrottle/setLoad (compat path). */
  updateSimple(dt: number, t: number, idleRpm = 900, redlineRpm = 6800): void {
    this.update({ rpm: this.rpmIn, throttle: this.thrIn, load: this.loadIn, gear: 1, speed: 0, nitro: false, idleRpm, redlineRpm }, dt, t);
  }

  /** Per control step (frame or fixed 60 Hz in offline renders). `t` = context time the values apply at. */
  update(s: EngineTelemetry, dt: number, t: number): void {
    const node = this.node, bank = this.bank;
    if (!node || !bank || dt <= 0) return;
    const tone = this.tone;
    const p = node.parameters;
    const tc = 0.02;

    // --- audio-facing rpm: slew-limited + smoothed (physics rpm can jump at launch / gear changes) ---
    const rpmTarget = clamp(s.rpm, s.idleRpm * 0.85, s.redlineRpm + 300);
    this.rpmA += clamp(rpmTarget - this.rpmA, -5200 * dt, 8000 * dt);
    this.rpmS += (this.rpmA - this.rpmS) * damp(16, dt);
    // throttle smoothing (keyboard is binary): quick but not instant
    const thr = clamp(s.throttle, 0, 1);
    this.thrS += (thr - this.thrS) * damp(thr > this.thrS ? 14 : 9, dt);
    this.thrPeak = Math.max(this.thrPeak * Math.exp(-dt / 0.35), this.thrS);
    const rel = clamp((this.rpmS - s.idleRpm) / (s.redlineRpm - s.idleRpm), 0, 1);

    // --- gear events ---
    if (s.gear !== this.prevGear) {
      if (s.gear > this.prevGear && this.prevGear > 0) {
        this.shiftT = 0.2;
        if (rel > 0.55 && tone.crackle > 0) this.crackleT = Math.max(this.crackleT, 0.25);
        this.lib?.play('shift', this.master, t, 0.25 + 0.2 * rel);
      } else if (s.gear < this.prevGear && s.gear > 0) {
        this.blipT = 0.16;
        this.lib?.play('shift', this.master, t, 0.2);
      } else {
        this.lib?.play('shift', this.master, t, 0.35, 0.8); // into / out of reverse
      }
      this.prevGear = s.gear;
    }
    this.shiftT = Math.max(0, this.shiftT - dt);
    this.blipT = Math.max(0, this.blipT - dt);

    // --- nitro (smoothed: a flickering flag must not modulate the sound) ---
    this.nitroAmt += ((s.nitro ? 1 : 0) - this.nitroAmt) * damp(s.nitro ? 6 : 1.5, dt);
    // --- limiter: a soft fuel cut. Sitting on the limiter (top speed) = gentle ~7 Hz rpm wobble and a slight load dip,
    // no hard on/off gating and no pops (a machine-gun of cuts reads as crackling). Fades in/out over ~0.15 s. ---
    const onLim = s.rpm >= s.redlineRpm - 80 && thr > 0.5 ? 1 : 0;
    this.limAmt += (onLim - this.limAmt) * damp(onLim ? 7 : 5, dt);
    this.limPh += dt * 7;
    const limWob = 0.5 + 0.5 * Math.sin(this.limPh * 2 * Math.PI);
    this.limOff = this.limAmt * 140 * limWob;

    // --- effective load: pedal + torque, overridden by shift cut / blip / limiter ---
    let loadT = clamp(0.55 * this.thrS + 0.45 * clamp(s.load, 0, 1) + 0.15 * this.nitroAmt, 0, 1);
    if (this.shiftT > 0) loadT = 0.12;
    if (this.blipT > 0) loadT = Math.max(loadT, 0.85);
    loadT -= 0.25 * this.limAmt * limWob;
    this.loadEff += (loadT - this.loadEff) * damp(loadT > this.loadEff ? 18 : 10, dt);
    const L = this.loadEff;

    // layer weights (amplitude, coherent bins): off -> cruise (0..0.35) -> on (0.35..1)
    let wOff = 0, wCruise = 0, wOn = 0;
    if (L < 0.35) { const x = L / 0.35; wCruise = 0.5 - 0.5 * Math.cos(Math.PI * x); wOff = 1 - wCruise; }
    else { const x = (L - 0.35) / 0.65; wOn = 0.5 - 0.5 * Math.cos(Math.PI * x); wCruise = 1 - wOn; }
    // --- sound rpm / firing frequency ---
    const blipRpm = this.blipT > 0 ? 250 : 0;
    const soundRpm = mapRpm(bank.manifest.rpmMap, this.rpmS - this.limOff + blipRpm) * (1 + 0.035 * this.nitroAmt);
    // layers without recorded material at this rpm hand their weight to a neighbour (off -> cruise -> on, cruise -> on)
    const cov = (k: 'off' | 'cruise' | 'on') => (this.layerTop[k] ? 1 - smoothstep(this.layerTop[k] * 1.06, this.layerTop[k] * 1.45, soundRpm) : 0);
    const cOff = cov('off'), cCr = cov('cruise'), cOn = cov('on');
    const offAtt = dbg(tone.offLoadDb * smoothstep(0.03, 0.25, rel)); // overrun quieter, but not at idle
    let spill = wOff * (1 - cOff) * offAtt; wOff *= cOff;
    wCruise += spill * cCr; spill *= 1 - cCr;
    spill += wCruise * (1 - cCr); wCruise *= cCr;
    wOn += spill;
    if (cOn < 1) { const s2 = wOn * (1 - cOn); wOn *= cOn; if (cCr > 0) wCruise += s2; else wOff += s2; }
    wOff *= offAtt;
    const firing = (Math.max(300, soundRpm) * bank.manifest.cylinders) / 120;
    p.get('firing')!.setTargetAtTime(firing, t, 0.012);
    p.get('wOff')!.setTargetAtTime(wOff, t, tc);
    p.get('wCruise')!.setTargetAtTime(wCruise, t, tc);
    p.get('wOn')!.setTargetAtTime(wOn, t, tc);

    // --- level & tone ---
    const lvl = tone.gainDb + (-4.5 + 4.5 * Math.pow(rel, 0.6)) + (-3.5 + 3.5 * L) + 2.5 * this.nitroAmt;
    this.exGain.gain.setTargetAtTime(dbg(lvl), t, 0.03);
    this.lp.frequency.setTargetAtTime(tone.lpBase + tone.lpLoad * L + tone.lpRpm * rel + 2500 * this.nitroAmt, t, 0.03);
    // induction: grows with throttle and rpm
    const inLvl = tone.intake * this.thrS * (0.25 + 0.75 * rel) * (1 + 0.6 * this.nitroAmt);
    p.get('intake')!.setTargetAtTime(1, t, tc);
    this.inGain.gain.setTargetAtTime(inLvl, t, 0.03);
    this.inBp.frequency.setTargetAtTime(900 + 2400 * rel, t, 0.05);

    // --- crackles on lift-off at high rpm, shifts, limiter; light overrun burble while coasting ---
    if (tone.crackle > 0) {
      if (this.thrPeak > 0.6 && this.thrS < 0.25 && rel > 0.4 && this.crackleT <= 0) {
        this.crackleT = 0.5 + 1.1 * rel * (0.6 + 0.4 * this.rnd());
        this.thrPeak = 0;
        // recorded anti-lag crackle burst layered over the procedural pops (stronger presets, high rpm)
        if (this.lib && rel > 0.55 && this.rnd() < 0.35 + 0.4 * (tone.crackle - 0.5)) {
          this.lib.play(this.rnd() < 0.5 ? 'crackle_1' : 'crackle_2', this.popGain, t + 0.05, 0.6 * tone.crackle * rel, 0.95 + 0.1 * this.rnd());
        }
        if (this.lib && tone.crackle >= 1 && rel > 0.75 && this.rnd() < 0.25) this.lib.play('backfire', this.popGain, t + 0.12, 0.5);
      }
      this.crackleT = Math.max(0, this.crackleT - dt);
      let c = this.crackleT > 0 ? Math.min(1, this.crackleT * 1.6) * (0.5 + 0.5 * rel) : 0;
      if (thr < 0.1 && rel > 0.45 && s.gear > 0) c = Math.max(c, 0.12 * rel);
      if (tone.crackle >= 1 && this.limAmt > 0.5) c = Math.max(c, 0.08); // only the anti-lag preset burbles on the limiter
      this.crackleAmt = c * tone.crackle;
    } else this.crackleAmt = 0;
    p.get('crackle')!.setTargetAtTime(this.crackleAmt, t, 0.01);

    // --- reverse whine ---
    const rev = s.gear < 0 ? clamp(s.speed / 2.5, 0, 1) : 0;
    const wf = (this.rpmS / 60) * 7.5;
    this.whine.frequency.setTargetAtTime(wf, t, 0.03);
    this.whine2.frequency.setTargetAtTime(wf * 2, t, 0.03);
    this.whineGain.gain.setTargetAtTime(rev * (0.035 + 0.05 * this.thrS), t, 0.05);

    // --- turbo ---
    if (tone.turbo > 0) {
      const target = L > 0.55 && rel > 0.25 ? clamp(rel * 1.4, 0, 1) : 0;
      this.boost += (target - this.boost) * damp(target > this.boost ? 1.8 : 6, dt);
      if (this.boost > 0.45 && this.thrS < 0.3 && this.thrPeak > 0.5) {
        this.lib?.play('bov', this.master, t, 0.35 * tone.turbo * this.boost);
        this.boost *= 0.3;
      }
      this.turboOsc.frequency.setTargetAtTime(2400 + 5200 * this.boost, t, 0.05);
      this.turboGain.gain.setTargetAtTime(0.012 * tone.turbo * this.boost * this.boost * (0.4 + 0.6 * this.thrS), t, 0.05);
    }

    const d = this.debug;
    d.soundRpm = soundRpm; d.loadEff = L; d.wOff = wOff; d.wCruise = wCruise; d.wOn = wOn; d.crackle = this.crackleAmt; d.boost = this.boost;
  }

  /** Snap internal smoothing to a state (after teleport / at render start). */
  reset(rpm: number): void {
    this.rpmA = this.rpmS = rpm;
    this.thrS = 0; this.loadEff = 0; this.thrPeak = 0; this.shiftT = this.blipT = this.crackleT = 0;
  }

  dispose(): void {
    this.node?.disconnect();
    this.master.disconnect();
    this.whine.stop(); this.whine2.stop(); this.turboOsc.stop();
  }
}
