/** Engine loop bank: manifest + AAC sprite produced by assets/scripts/audio/build_engine.py. */

export interface EngineLoopInfo {
  layer: 'idle' | 'off' | 'cruise' | 'on';
  rpm: number;
  firingHz: number;
  cycles: number;
  start: number; // s, in the decoded sprite
  length: number; // s
  levelDb: number;
  src: number;
}

export interface EngineManifest {
  preset: string;
  title: string;
  cylinders: number;
  sampleRate: number;
  file: string;
  pad: number;
  /** game rpm -> sound rpm (piecewise linear). */
  rpmMap: [number, number][];
  idleRpm: number;
  loops: EngineLoopInfo[];
  sources: { id: number; title: string; author: string; license: string; url: string }[];
}

export interface EngineBank {
  manifest: EngineManifest;
  data: Float32Array;
  sampleRate: number;
  /** sound-rpm range covered by loops. */
  minRpm: number;
  maxRpm: number;
}

const LAYER_INDEX: Record<EngineLoopInfo['layer'], number> = { idle: -1, off: 0, cruise: 1, on: 2 };

export const ENGINE_BASE_URL = '/assets/audio/engine/';

export async function loadEngineBank(ctx: BaseAudioContext, preset: string): Promise<EngineBank> {
  const base = `${ENGINE_BASE_URL}${preset}/`;
  const manifest = (await (await fetch(base + 'manifest.json')).json()) as EngineManifest;
  const bytes = await (await fetch(base + manifest.file)).arrayBuffer();
  const buf = await ctx.decodeAudioData(bytes);
  const data = buf.getChannelData(0).slice();
  const rpms = manifest.loops.map((l) => l.rpm);
  return { manifest, data, sampleRate: buf.sampleRate, minRpm: Math.min(...rpms), maxRpm: Math.max(...rpms) };
}

/** Message for the worklet (data is copied so the bank stays reusable). */
export function bankMessage(bank: EngineBank) {
  const cyl = bank.manifest.cylinders;
  return {
    type: 'bank' as const,
    data: bank.data.slice(),
    loops: bank.manifest.loops.map((l) => ({
      layer: LAYER_INDEX[l.layer],
      firingHz: l.firingHz,
      firings: l.cycles * cyl,
      start: l.start * bank.sampleRate,
      length: l.length * bank.sampleRate,
    })),
  };
}

/** Piecewise-linear map (clamped extrapolation by the end slopes). */
export function mapRpm(map: [number, number][], rpm: number): number {
  if (rpm <= map[0][0]) return map[0][1];
  for (let i = 1; i < map.length; i++) {
    if (rpm <= map[i][0]) {
      const [x0, y0] = map[i - 1], [x1, y1] = map[i];
      return y0 + ((y1 - y0) * (rpm - x0)) / (x1 - x0);
    }
  }
  const [x0, y0] = map[map.length - 2], [x1, y1] = map[map.length - 1];
  return y1 + ((y1 - y0) * (rpm - x1)) / (x1 - x0);
}
