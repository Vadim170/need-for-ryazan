import type { RoadGraph } from './city-world';

export interface RoadHit {
  edge: number;
  /** Индекс сегмента ломаной (между points[seg] и points[seg+1]) и параметр t на нём. */
  seg: number; t: number;
  /** Ближайшая точка на оси (координаты игры) и расстояние до неё в плане. */
  x: number; y: number; z: number; dist: number;
  /** Единичный касательный вектор вдоль points (from → to), план (x, z). */
  tx: number; tz: number;
  /** Клик слева (<0) или справа (>0) от направления from → to (векторное произведение). */
  side: number;
}

const CELL = 100;

/** Пространственная сетка по рёбрам roads/graph.json: ближайшая точка оси дороги (карта мира: быстрый переезд, подпись улицы под курсором). */
export class RoadIndex {
  private cells = new Map<number, number[]>();
  private stamp: Int32Array;
  private cur = 0;

  constructor(private graph: RoadGraph) {
    this.stamp = new Int32Array(graph.edges.length);
    graph.edges.forEach((e, i) => {
      const pts = e.points;
      let last = NaN;
      for (let k = 0; k < pts.length; k++) {
        // точки редкие на прямых: добавляем и промежуточные клетки вдоль сегмента
        const p = pts[k], q = pts[Math.min(k + 1, pts.length - 1)];
        const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[2] - p[2]) / (CELL / 2)));
        for (let j = 0; j < n; j++) {
          const x = p[0] + (q[0] - p[0]) * j / n, z = p[2] + (q[2] - p[2]) * j / n;
          const key = this.key(Math.floor(x / CELL), Math.floor(z / CELL));
          if (key === last) continue;
          last = key;
          const l = this.cells.get(key);
          if (!l) this.cells.set(key, [i]); else if (l[l.length - 1] !== i) l.push(i);
        }
      }
    });
  }

  private key(cx: number, cz: number): number { return (cx + 512) * 1024 + (cz + 512); }

  /** Ближайшая точка оси в радиусе maxR (м); filter — отбор рёбер (например, без service). null — ничего нет. */
  nearest(x: number, z: number, maxR: number, filter?: (e: RoadGraph['edges'][number]) => boolean): RoadHit | null {
    const E = this.graph.edges;
    const c0x = Math.floor((x - maxR) / CELL), c1x = Math.floor((x + maxR) / CELL);
    const c0z = Math.floor((z - maxR) / CELL), c1z = Math.floor((z + maxR) / CELL);
    this.cur++;
    let best: RoadHit | null = null, bd = maxR * maxR;
    for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
      const l = this.cells.get(this.key(cx, cz));
      if (!l) continue;
      for (const i of l) {
        if (this.stamp[i] === this.cur) continue;
        this.stamp[i] = this.cur;
        const e = E[i];
        if (filter && !filter(e)) continue;
        const pts = e.points;
        for (let k = 0; k + 1 < pts.length; k++) {
          const a = pts[k], b = pts[k + 1];
          const dx = b[0] - a[0], dz = b[2] - a[2], L2 = dx * dx + dz * dz;
          let t = L2 > 1e-9 ? ((x - a[0]) * dx + (z - a[2]) * dz) / L2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = a[0] + dx * t, pz = a[2] + dz * t;
          const d = (px - x) ** 2 + (pz - z) ** 2;
          if (d < bd) {
            bd = d;
            const L = Math.sqrt(L2) || 1;
            best = { edge: i, seg: k, t, x: px, y: a[1] + (b[1] - a[1]) * t, z: pz, dist: Math.sqrt(d), tx: dx / L, tz: dz / L,
              side: dx * (z - a[2]) - dz * (x - a[0]) };
          }
        }
      }
    }
    return best;
  }
}
