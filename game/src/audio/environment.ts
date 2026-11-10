/**
 * Acoustic environment: three procedurally generated stereo impulse responses (open field, street canyon, tunnel /
 * under a bridge) on parallel ConvolverNodes, blended by a cheap geometry probe around the car (horizontal raycasts
 * against buildings + one upward ray), plus a distance-tuned slap-back echo between facades.
 */
import { mulberry32 } from './sample-lib';

export interface EnvState {
  /** 0..1 how enclosed by walls (buildings close on several sides). */
  canyon: number;
  /** 0..1 roof overhead (bridge / tunnel). */
  covered: number;
  /** mean distance to hit walls (m). */
  wallDist: number;
}

export const OPEN_ENV: EnvState = { canyon: 0, covered: 0, wallDist: 60 };

type IrKind = 'open' | 'street' | 'tunnel';

function makeIR(ctx: BaseAudioContext, kind: IrKind, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const P = {
    open: { len: 0.7, rt60: 0.45, early: [[0.011, 0.35], [0.023, 0.22]], density: 0.25, lpHz: 3500, pre: 0.004 },
    street: { len: 1.8, rt60: 1.2, early: [[0.018, 0.55], [0.031, 0.45], [0.047, 0.4], [0.071, 0.3], [0.094, 0.28], [0.13, 0.2], [0.17, 0.16]], density: 0.7, lpHz: 5000, pre: 0.008 },
    tunnel: { len: 2.6, rt60: 2.2, early: [[0.006, 0.6], [0.014, 0.55], [0.022, 0.5], [0.031, 0.45], [0.043, 0.4]], density: 1, lpHz: 2800, pre: 0.003 },
  }[kind];
  const n = Math.floor(P.len * sr);
  const buf = ctx.createBuffer(2, n, sr);
  const rnd = mulberry32(seed);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const k = Math.log(1000) / (P.rt60 * sr); // -60 dB at rt60
    let lp = 0;
    const a = 1 - Math.exp((-2 * Math.PI * P.lpHz) / sr);
    const pre = Math.floor(P.pre * sr);
    for (let i = pre; i < n; i++) {
      // sparse at first, denser later (diffusion build-up)
      const dens = Math.min(1, P.density * (0.15 + (i - pre) / (0.08 * sr)));
      const x = rnd() < dens ? rnd() * 2 - 1 : 0;
      // the high end decays faster: cutoff drops along the tail
      const aa = a * Math.exp(-(i - pre) / (0.6 * sr));
      lp += (x - lp) * Math.max(0.02, aa);
      d[i] = lp * Math.exp(-k * (i - pre));
    }
    // discrete early reflections, slightly different per ear
    for (const [tt, g] of P.early) {
      const j = Math.floor((tt * (ch ? 1.06 : 0.95)) * sr);
      if (j < n) { d[j] += g * (ch ? 0.9 : 1); if (j + 1 < n) d[j + 1] += g * 0.4; }
    }
    // normalise energy
    let e = 0;
    for (let i = 0; i < n; i++) e += d[i] * d[i];
    const s = 1 / Math.sqrt(e + 1e-9);
    for (let i = 0; i < n; i++) d[i] *= s * 0.5;
  }
  return buf;
}

export class Environment {
  /** Feed reverb sends here. */
  readonly input: GainNode;
  readonly output: GainNode;
  private wet: Record<IrKind, GainNode>;
  private feeds: Record<IrKind, ConvolverNode>;
  private linked: Record<IrKind, boolean> = { open: false, street: false, tunnel: false };
  private quietSince: Record<IrKind, number> = { open: 0, street: 0, tunnel: 0 };
  private slap: DelayNode;
  private slapGain: GainNode;
  private state: EnvState = { ...OPEN_ENV };
  amount = 1;

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    const kinds: IrKind[] = ['open', 'street', 'tunnel'];
    this.wet = {} as Record<IrKind, GainNode>;
    this.feeds = {} as Record<IrKind, ConvolverNode>;
    kinds.forEach((k, i) => {
      const c = ctx.createConvolver();
      c.normalize = false;
      c.buffer = makeIR(ctx, k, 100 + i);
      const g = ctx.createGain();
      g.gain.value = 0;
      c.connect(g).connect(this.output);
      this.wet[k] = g;
      this.feeds[k] = c;
    });
    // slap-back between facades: delay = 2·d / c, low-passed, light feedback
    this.slap = ctx.createDelay(0.6);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2500;
    const fb = ctx.createGain(); fb.gain.value = 0.28;
    this.slapGain = ctx.createGain(); this.slapGain.gain.value = 0;
    this.input.connect(this.slap).connect(lp).connect(this.slapGain).connect(this.output);
    lp.connect(fb).connect(this.slap);
  }

  get current(): EnvState { return this.state; }

  /**
   * Convolvers are expensive (~2–3 % of a core each): only the ones with a audible weight are fed;
   * a convolver is unlinked after its weight stayed ~0 for 4 s (its tail has died out by then).
   */
  private link(k: IrKind, w: number, t: number): void {
    if (w > 0.01) {
      this.quietSince[k] = t;
      if (!this.linked[k]) { this.input.connect(this.feeds[k]); this.linked[k] = true; }
    } else if (this.linked[k] && t - this.quietSince[k] > 4) {
      this.input.disconnect(this.feeds[k]);
      this.linked[k] = false;
    }
  }

  /** Smoothly move to a new environment state at time t. */
  set(s: EnvState, t: number, tc = 0.35): void {
    this.state = s;
    const a = this.amount;
    const tunnel = s.covered * (0.4 + 0.6 * s.canyon);
    const street = (1 - tunnel) * s.canyon;
    const open = Math.max(0, 1 - tunnel - street);
    const wOpen = a * 0.3 * open, wStreet = a * 0.55 * street, wTunnel = a * 0.8 * tunnel + a * 0.3 * s.covered * (1 - s.canyon);
    this.link('open', wOpen, t); this.link('street', wStreet, t); this.link('tunnel', wTunnel, t);
    this.wet.open.gain.setTargetAtTime(wOpen, t, tc);
    this.wet.street.gain.setTargetAtTime(wStreet, t, tc);
    this.wet.tunnel.gain.setTargetAtTime(wTunnel, t, tc);
    const d = Math.min(0.5, Math.max(0.03, (2 * s.wallDist) / 343));
    this.slap.delayTime.setTargetAtTime(d, t, 0.25);
    this.slapGain.gain.setTargetAtTime(a * 0.32 * s.canyon * (1 - tunnel), t, tc);
  }
}
