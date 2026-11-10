/**
 * AudioWorklet processor "engine-synth": cycle-synchronous granular (TD-PSOLA) engine synthesis from a bank of
 * pitch-flattened, phase-aligned loops (one loop per RPM bin and load layer, see assets/scripts/audio/build_engine.py).
 *
 * - A single firing-phase accumulator Φ advances at the current firing frequency f (Hz = rpm·cyl/120).
 *   Every integer crossing of Φ is a firing "epoch": every active voice emits one grain — the firing with the same
 *   index (epoch mod M) from its loop, Hann-windowed over ±max(P, Q) (P = source period, Q = output period).
 *   Exhaust resonances (formants) stay put while pitch follows rpm, neighbouring bins are phase-coherent (no comb
 *   filtering in crossfades) and the natural cylinder-to-cylinder irregularity of the recording is kept.
 * - Layers 0 = off (overrun), 1 = cruise (part load), 2 = on (full load); the idle loop is the lowest bin of every layer.
 * - Output 0: exhaust (mono). Output 1: induction pulses (noise bursts per firing, gated by `intake`).
 *   Output 2: overrun pops/crackles (random per-firing events, density `crackle`).
 * Everything is deterministic (seeded RNG) so OfflineAudioContext renders are reproducible.
 *
 * Kept free of imports: it runs in AudioWorkletGlobalScope.
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export interface BankLoopMsg { layer: number; firingHz: number; firings: number; start: number; length: number }
export interface BankMsg { type: 'bank'; data: Float32Array; loops: BankLoopMsg[] }

interface Voice { F: number; M: number; start: number; P: number }

const MAX_GRAINS = 128;
const HANN_N = 2048;
const HANN = new Float32Array(HANN_N + 1);
for (let i = 0; i <= HANN_N; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / HANN_N);

class EngineSynth extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = 'k-rate';
    return [
      { name: 'firing', defaultValue: 40, minValue: 5, maxValue: 2000, automationRate: k },
      { name: 'wOff', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: k },
      { name: 'wCruise', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: k },
      { name: 'wOn', defaultValue: 1, minValue: 0, maxValue: 4, automationRate: k },
      { name: 'intake', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: k },
      { name: 'crackle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'smoothMs', defaultValue: 25, minValue: 0, maxValue: 500, automationRate: k },
    ];
  }

  private data: Float32Array | null = null;
  private layers: Voice[][] = [[], [], []];
  private f = 40;
  private phi = 0;
  private epoch = 0;
  // grains (struct of arrays)
  private gPos = new Float64Array(MAX_GRAINS);
  private gJ = new Float64Array(MAX_GRAINS);
  private gLen = new Float64Array(MAX_GRAINS);
  private gAmp = new Float32Array(MAX_GRAINS);
  private gActive = new Uint8Array(MAX_GRAINS);
  private nGrains = 0;
  /** Indices of active grains (dense list -> the per-sample loop touches only live grains). */
  private live = new Int32Array(MAX_GRAINS);
  private nLive = 0;
  private statMax = 0;
  private statDropped = 0;
  private statFrames = 0;
  // induction pulse
  private inEnv = 0;
  private inDecay = 0.99;
  private inLp = 0;
  // pops
  private popNoiseEnv = [0, 0, 0];
  private popNoiseDecay = [0.99, 0.99, 0.99];
  private popThEnv = [0, 0, 0];
  private popThDecay = [0.99, 0.99, 0.99];
  private popThPh = [0, 0, 0];
  private popThInc = [0, 0, 0];
  /** Samples since the pop started (0.7 ms attack ramp: a pop, not a digital click). */
  private popAge = [1e9, 1e9, 1e9];
  private popHp = 0;
  private popLp = 0;
  private popPrev = 0;
  private popSlot = 0;
  private popCool = 0;
  private seed = 0x9e3779b9;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as BankMsg | { type: 'reset'; firing: number } | { type: 'seed'; seed: number };
      if (m.type === 'bank') this.setBank(m);
      else if (m.type === 'reset') { this.f = m.firing; this.phi = 0; this.epoch = 0; }
      else if (m.type === 'seed') this.seed = m.seed >>> 0 || 1;
    };
  }

  private setBank(m: BankMsg): void {
    this.data = m.data;
    this.layers = [[], [], []];
    const idle: Voice[] = [];
    for (const l of m.loops) {
      const v: Voice = { F: l.firingHz, M: l.firings, start: l.start, P: sampleRate / l.firingHz };
      if (l.layer < 0) idle.push(v);
      else this.layers[l.layer].push(v);
    }
    for (const L of this.layers) {
      L.push(...idle);
      L.sort((a, b) => a.F - b.F);
    }
    this.gActive.fill(0);
    this.nGrains = 0;
    this.nLive = 0;
    this.port.postMessage({ type: 'ready', loops: m.loops.length });
  }

  private rnd(): number {
    // xorshift32
    let x = this.seed;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.seed = x;
    return x / 4294967296;
  }

  private spawn(v: Voice, amp: number, f: number, delta: number): void {
    if (amp < 1e-4) return;
    let slot = -1;
    for (let i = 0; i < MAX_GRAINS; i++) if (!this.gActive[i]) { slot = i; break; }
    if (slot < 0) { this.statDropped++; return; }
    const Q = sampleRate / f;
    const len = 2 * Math.max(v.P, Q);
    const kk = this.epoch % v.M;
    const center = v.start + kk * v.P;
    this.gActive[slot] = 1;
    this.gLen[slot] = len;
    this.gJ[slot] = delta;
    this.gPos[slot] = center - len / 2 + delta;
    this.gAmp[slot] = (amp * 2 * Q) / len;
    this.nGrains++;
    this.live[this.nLive++] = slot;
  }

  private onEpoch(f: number, delta: number, w: number[], intake: number, crackle: number): void {
    // engine grains: per layer the two bins around f, raised-cosine crossfade in log-frequency
    for (let li = 0; li < 3; li++) {
      const wl = w[li];
      if (wl < 1e-4) continue;
      const L = this.layers[li];
      const n = L.length;
      if (!n) continue;
      if (f <= L[0].F) { this.spawn(L[0], wl, f, delta); continue; }
      if (f >= L[n - 1].F) { this.spawn(L[n - 1], wl, f, delta); continue; }
      let i = 0;
      while (i < n - 2 && L[i + 1].F <= f) i++;
      const a = L[i], b = L[i + 1];
      const x = Math.log(f / a.F) / Math.log(b.F / a.F);
      const wb = 0.5 - 0.5 * Math.cos(Math.PI * x);
      this.spawn(a, wl * (1 - wb), f, delta);
      this.spawn(b, wl * wb, f, delta);
    }
    // induction pulse: noise burst decaying over ~35% of the firing period, slightly random level
    if (intake > 1e-4) {
      this.inEnv = intake * (0.65 + 0.35 * this.rnd());
      const tau = (0.35 * sampleRate) / f;
      this.inDecay = Math.exp(-1 / Math.max(8, tau));
    }
    // overrun pops: random firings ignite in the hot exhaust
    if (this.popCool > 0) this.popCool--;
    if (crackle > 1e-3 && this.popCool === 0 && this.rnd() < crackle * 0.32) {
      const s = this.popSlot = (this.popSlot + 1) % 3;
      const a = Math.exp(Math.log(0.12) * this.rnd()); // log-uniform 0.12..1
      const big = this.rnd() < 0.18;
      this.popNoiseEnv[s] = a * (big ? 1.0 : 0.7);
      this.popNoiseDecay[s] = Math.exp(-1 / (sampleRate * (big ? 0.014 : 0.003 + 0.006 * this.rnd())));
      this.popThEnv[s] = a * (big ? 1.2 : 0.5);
      this.popThDecay[s] = Math.exp(-1 / (sampleRate * (big ? 0.045 : 0.018)));
      this.popThPh[s] = 0;
      this.popAge[s] = 0;
      this.popThInc[s] = (2 * Math.PI * (55 + 90 * this.rnd())) / sampleRate;
      this.popCool = big ? 3 : 0;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    const out0 = outputs[0]?.[0], out1 = outputs[1]?.[0], out2 = outputs[2]?.[0];
    if (!out0) return true;
    const N = out0.length;
    const data = this.data;
    const fT = Math.max(5, params.firing[0]);
    const w = [params.wOff[0], params.wCruise[0], params.wOn[0]];
    const intake = params.intake[0], crackle = params.crackle[0];
    const sm = params.smoothMs[0];
    const kf = sm > 0 ? 1 - Math.exp(-1000 / (sm * sampleRate)) : 1;
    let f = this.f, phi = this.phi;
    const gPos = this.gPos, gJ = this.gJ, gLen = this.gLen, gAmp = this.gAmp, gAct = this.gActive;
    for (let n = 0; n < N; n++) {
      // one-pole smoothing of the firing frequency in the log domain (no zipper, natural inertia)
      f = Math.exp(Math.log(f) + (Math.log(fT) - Math.log(f)) * kf);
      const inc = f / sampleRate;
      phi += inc;
      if (phi >= 1) {
        phi -= 1;
        this.epoch++;
        if (data) this.onEpoch(f, phi / inc, w, intake, crackle);
      }
      // grains
      let s = 0;
      if (data && this.nLive > 0) {
        const live = this.live;
        let k = 0;
        while (k < this.nLive) {
          const g = live[k];
          const j = gJ[g], len = gLen[g];
          if (j >= len) { gAct[g] = 0; this.nGrains--; live[k] = live[--this.nLive]; continue; }
          const p = gPos[g];
          const i0 = p | 0, fr = p - i0;
          const x = data[i0] + (data[i0 + 1] - data[i0]) * fr;
          const hp = (j / len) * HANN_N, hi = hp | 0;
          const win = HANN[hi] + (HANN[hi + 1] - HANN[hi]) * (hp - hi);
          s += x * win * gAmp[g];
          gPos[g] = p + 1;
          gJ[g] = j + 1;
          k++;
        }
        if (this.nLive > this.statMax) this.statMax = this.nLive;
      }
      out0[n] = s;
      // induction: band-limited noise burst (one-pole lowpass of white noise; further shaped on the main thread)
      if (out1) {
        const nz = this.rnd() * 2 - 1;
        this.inLp += (nz - this.inLp) * 0.35;
        out1[n] = this.inLp * this.inEnv;
        this.inEnv *= this.inDecay;
      }
      if (out2) {
        let p = 0;
        for (let k = 0; k < 3; k++) {
          const atk = this.popAge[k] < 32 ? this.popAge[k]++ / 32 : 1;
          if (this.popNoiseEnv[k] > 1e-5) {
            p += (this.rnd() * 2 - 1) * this.popNoiseEnv[k] * atk;
            this.popNoiseEnv[k] *= this.popNoiseDecay[k];
          }
          if (this.popThEnv[k] > 1e-5) {
            p += Math.sin(this.popThPh[k]) * this.popThEnv[k] * atk;
            this.popThPh[k] += this.popThInc[k];
            this.popThEnv[k] *= this.popThDecay[k];
          }
        }
        // soften the very top of the crack (a real exhaust pop is band-limited by the pipe)
        p = this.popLp += (p - this.popLp) * 0.55;
        // gentle DC/rumble blocker
        const y = p - this.popPrev + 0.995 * this.popHp;
        this.popPrev = p;
        this.popHp = y;
        out2[n] = y;
      }
    }
    this.f = f;
    this.phi = phi;
    // ~1 s stats for the debug readout: peak concurrent grains, grains dropped for lack of slots
    if (++this.statFrames >= 375) {
      this.port.postMessage({ type: 'stats', maxGrains: this.statMax, dropped: this.statDropped, firing: f });
      this.statFrames = 0; this.statMax = 0; this.statDropped = 0;
    }
    return true;
  }
}

registerProcessor('engine-synth', EngineSynth);
