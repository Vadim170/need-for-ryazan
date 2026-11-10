/** One-shot / loop samples (game/public/assets/audio/sfx, built by assets/scripts/audio/build_sfx.py). */

export interface SfxEntry {
  file: string;
  /** Loop region (s) for seamless loops; absent for one-shots. */
  loopStart?: number;
  loopEnd?: number;
  /** Suggested gain (linear), already loudness-normalised in the pipeline. */
  gain?: number;
}

export type SfxManifest = Record<string, SfxEntry>;

export const SFX_BASE_URL = '/assets/audio/sfx/';

export class SampleLib {
  readonly buffers = new Map<string, AudioBuffer>();
  manifest: SfxManifest = {};

  constructor(private readonly ctx: BaseAudioContext) {}

  /** Loads the manifest and decodes every sample (missing files are skipped with a warning). */
  async load(names?: string[] | ((name: string) => boolean)): Promise<void> {
    if (!Object.keys(this.manifest).length) {
      try {
        this.manifest = (await (await fetch(SFX_BASE_URL + 'sfx.json')).json()) as SfxManifest;
      } catch (e) {
        console.warn('[audio] sfx.json не загрузился', e);
        return;
      }
    }
    const list = typeof names === 'function' ? Object.keys(this.manifest).filter(names) : names ?? Object.keys(this.manifest);
    await Promise.all(list.map(async (n) => {
      const e = this.manifest[n];
      if (!e || this.buffers.has(n)) return;
      try {
        const bytes = await (await fetch(SFX_BASE_URL + e.file)).arrayBuffer();
        this.buffers.set(n, await this.ctx.decodeAudioData(bytes));
      } catch (err) {
        console.warn('[audio] sample failed', n, err);
      }
    }));
  }

  get(name: string): AudioBuffer | null { return this.buffers.get(name) ?? null; }

  /** All loaded names with a prefix (variants: impact_metal_1, impact_metal_2…). */
  variants(prefix: string): string[] {
    return [...this.buffers.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  /** Looping source (not started). */
  loop(name: string): AudioBufferSourceNode | null {
    const b = this.get(name);
    if (!b) return null;
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.loop = true;
    const e = this.manifest[name];
    if (e?.loopStart !== undefined && e.loopEnd !== undefined) {
      s.loopStart = e.loopStart;
      s.loopEnd = e.loopEnd;
    }
    return s;
  }

  /** Fire-and-forget one-shot at time t into `out`. Returns the gain node (for further automation) or null. */
  play(name: string, out: AudioNode, t: number, gain = 1, rate = 1, onEnded?: () => void): GainNode | null {
    const b = this.get(name);
    if (!b) return null;
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain * (this.manifest[name]?.gain ?? 1);
    s.connect(g).connect(out);
    s.start(t);
    s.onended = () => { s.disconnect(); g.disconnect(); onEnded?.(); };
    return g;
  }
}

/** Deterministic PRNG for reproducible offline renders. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
