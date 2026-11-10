/**
 * «Это проезжая часть?» по roads/graph.json: оси рёбер с полуширинами в сетке-бакетах 24 м.
 * Нужна пешеходам, чтобы при уклонении от машины не шагать с бордюра на дорогу.
 * service / living_street не считаются (во дворах по проездам ходят).
 */
export interface RoadGraphLike {
  edges: { highway?: string; width?: number; bridge?: boolean; points: number[][] }[];
}

const CELL = 24;

export class RoadMask {
  private segs: Float32Array; // x0 z0 x1 z1 halfWidth
  private cells = new Map<number, number[]>();

  constructor(g: RoadGraphLike) {
    const s: number[] = [];
    for (const e of g.edges) {
      if (e.highway === 'service' || e.highway === 'living_street' || e.bridge) continue;
      const hw = (e.width ?? 7) / 2;
      for (let i = 0; i < e.points.length - 1; i++) {
        const a = e.points[i], b = e.points[i + 1];
        s.push(a[0], a[2], b[0], b[2], hw);
      }
    }
    this.segs = Float32Array.from(s);
    const n = this.segs.length / 5;
    for (let k = 0; k < n; k++) {
      const o = k * 5, S = this.segs, r = S[o + 4] + 1;
      const c0 = Math.floor((Math.min(S[o], S[o + 2]) - r) / CELL), c1 = Math.floor((Math.max(S[o], S[o + 2]) + r) / CELL);
      const r0 = Math.floor((Math.min(S[o + 1], S[o + 3]) - r) / CELL), r1 = Math.floor((Math.max(S[o + 1], S[o + 3]) + r) / CELL);
      for (let cz = r0; cz <= r1; cz++) for (let cx = c0; cx <= c1; cx++) {
        const key = cx * 100003 + cz;
        let l = this.cells.get(key);
        if (!l) this.cells.set(key, (l = []));
        l.push(k);
      }
    }
  }

  /** Точка ближе (полуширина + margin) к оси дороги. Площадки перекрёстков покрываются концами рёбер приблизительно. */
  onRoad(x: number, z: number, margin = 0.3): boolean {
    const l = this.cells.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
    if (!l) return false;
    const S = this.segs;
    for (const k of l) {
      const o = k * 5;
      const dx = S[o + 2] - S[o], dz = S[o + 3] - S[o + 1];
      const L2 = dx * dx + dz * dz || 1;
      let t = ((x - S[o]) * dx + (z - S[o + 1]) * dz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - S[o] - dx * t, ez = z - S[o + 1] - dz * t;
      const r = S[o + 4] + margin;
      if (ex * ex + ez * ez < r * r) return true;
    }
    return false;
  }
}
