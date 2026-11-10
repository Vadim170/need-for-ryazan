/**
 * Audio zone map (assets/scripts/audio/build_audio_zones.py from OSM): a 25 m grid of ambience affinities
 * (traffic, green, industrial, crowd, yards, playground, water) + church / bus-stop points.
 * sample(x, z) is bilinear, game coordinates (three.x = east, three.z = -north).
 */
export const ZONE_URL = '/assets/audio/zones/';

export interface ZoneSample { traffic: number; green: number; industrial: number; crowd: number; yards: number; playground: number; water: number }
export const EMPTY_ZONE: ZoneSample = { traffic: 0.4, green: 0.2, industrial: 0, crowd: 0, yards: 0.3, playground: 0, water: 0 };

interface ZoneMeta {
  cell: number; cols: number; rows: number; channels: string[]; x0: number; y0: number;
  churches: { x: number; z: number; name: string }[];
  busStops: { x: number; z: number }[];
}

export class CityZones {
  private constructor(readonly meta: ZoneMeta, private readonly data: Uint8Array) {}

  static async load(): Promise<CityZones | null> {
    try {
      const meta = (await (await fetch(ZONE_URL + 'zones.json')).json()) as ZoneMeta;
      const data = new Uint8Array(await (await fetch(ZONE_URL + 'zones.bin')).arrayBuffer());
      if (data.length !== meta.cols * meta.rows * meta.channels.length) throw new Error('zones.bin size mismatch');
      return new CityZones(meta, data);
    } catch (e) {
      console.warn('[audio] zones not loaded', e);
      return null;
    }
  }

  get churches() { return this.meta.churches; }
  get busStops() { return this.meta.busStops; }

  sample(x: number, z: number, out: ZoneSample = { ...EMPTY_ZONE }): ZoneSample {
    const m = this.meta, C = m.channels.length;
    const fc = (x - m.x0) / m.cell - 0.5, fr = (-z - m.y0) / m.cell - 0.5;
    const c0 = Math.floor(fc), r0 = Math.floor(fr), tx = fc - c0, ty = fr - r0;
    const get = (r: number, c: number, ch: number) =>
      r < 0 || c < 0 || r >= m.rows || c >= m.cols ? 0 : this.data[(r * m.cols + c) * C + ch] / 255;
    const v = (ch: number) =>
      (get(r0, c0, ch) * (1 - tx) + get(r0, c0 + 1, ch) * tx) * (1 - ty) + (get(r0 + 1, c0, ch) * (1 - tx) + get(r0 + 1, c0 + 1, ch) * tx) * ty;
    out.traffic = v(0); out.green = v(1); out.industrial = v(2); out.crowd = v(3); out.yards = v(4); out.playground = v(5); out.water = v(6);
    return out;
  }

  /** Nearest church within maxDist (m). */
  nearestChurch(x: number, z: number, maxDist = 700): { x: number; z: number; name: string; d: number } | null {
    let best: { x: number; z: number; name: string; d: number } | null = null;
    for (const c of this.meta.churches) {
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < maxDist && (!best || d < best.d)) best = { ...c, d };
    }
    return best;
  }

  nearBusStop(x: number, z: number, r = 25): boolean {
    for (const s of this.meta.busStops) if (Math.abs(s.x - x) < r && Math.abs(s.z - z) < r) return true;
    return false;
  }
}
