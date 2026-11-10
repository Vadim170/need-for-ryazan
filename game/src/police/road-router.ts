import * as THREE from 'three';
import type { RoadGraph } from '../world/city-world';

/**
 * Маршруты по дорожному графу roads/graph.json (7 тыс. узлов): A* без учёта одностороннего движения (полиции можно),
 * ближайший узел — сетка 60 м. Результат — ломаная (точки рёбер по ходу движения).
 */
export class RoadRouter {
  private adj: { to: number; edge: number; len: number; fwd: boolean }[][];
  private grid = new Map<number, number[]>();
  private readonly CELL = 60;
  private nodeX: Float32Array; private nodeY: Float32Array; private nodeZ: Float32Array;
  private idx = new Map<number, number>();

  constructor(readonly graph: RoadGraph) {
    const N = graph.nodes.length;
    this.nodeX = new Float32Array(N); this.nodeY = new Float32Array(N); this.nodeZ = new Float32Array(N);
    graph.nodes.forEach((n, i) => { this.idx.set(n.id, i); this.nodeX[i] = n.x; this.nodeY[i] = n.y; this.nodeZ[i] = n.z; });
    this.adj = Array.from({ length: N }, () => []);
    graph.edges.forEach((e, ei) => {
      const a = this.idx.get(e.from), b = this.idx.get(e.to);
      if (a === undefined || b === undefined) return;
      if (e.highway === 'service' && (e.width ?? 5) < 4) return; // узкие проезды — нет
      let len = 0;
      for (let k = 1; k < e.points.length; k++) len += Math.hypot(e.points[k][0] - e.points[k - 1][0], e.points[k][2] - e.points[k - 1][2]);
      const w = e.highway === 'service' ? 1.6 : e.highway === 'residential' ? 1.15 : 1;
      this.adj[a].push({ to: b, edge: ei, len: len * w, fwd: true });
      this.adj[b].push({ to: a, edge: ei, len: len * w, fwd: false });
    });
    for (let i = 0; i < N; i++) {
      if (!this.adj[i].length) continue;
      const k = this.key(this.nodeX[i], this.nodeZ[i]);
      (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(i);
    }
  }

  private key(x: number, z: number): number { return Math.floor(x / this.CELL) * 100003 + Math.floor(z / this.CELL); }

  nearestNode(x: number, z: number, maxR = 300): number {
    let best = -1, bd = maxR * maxR;
    const cx = Math.floor(x / this.CELL), cz = Math.floor(z / this.CELL);
    for (let r = 0; r <= Math.ceil(maxR / this.CELL); r++) {
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        for (const n of this.grid.get((cx + i) * 100003 + cz + j) ?? []) {
          const d = (this.nodeX[n] - x) ** 2 + (this.nodeZ[n] - z) ** 2;
          if (d < bd) { bd = d; best = n; }
        }
      }
      if (best >= 0 && r * this.CELL > Math.sqrt(bd) + this.CELL) break;
    }
    return best;
  }

  nodePos(n: number, out: THREE.Vector3): THREE.Vector3 { return out.set(this.nodeX[n], this.nodeY[n], this.nodeZ[n]); }

  /** Узлы на расстоянии [r0, r1] от точки (кандидаты спавна). */
  nodesInRing(x: number, z: number, r0: number, r1: number, out: number[] = []): number[] {
    out.length = 0;
    const c0x = Math.floor((x - r1) / this.CELL), c1x = Math.floor((x + r1) / this.CELL);
    const c0z = Math.floor((z - r1) / this.CELL), c1z = Math.floor((z + r1) / this.CELL);
    for (let i = c0x; i <= c1x; i++) for (let j = c0z; j <= c1z; j++) {
      for (const n of this.grid.get(i * 100003 + j) ?? []) {
        const d = Math.hypot(this.nodeX[n] - x, this.nodeZ[n] - z);
        if (d >= r0 && d <= r1) out.push(n);
      }
    }
    return out;
  }

  /** A* от узла a к узлу b: ломаная по рёбрам (x, y, z). null — нет пути. */
  route(a: number, b: number, maxExpand = 6000): THREE.Vector3[] | null {
    if (a < 0 || b < 0) return null;
    if (a === b) return [new THREE.Vector3(this.nodeX[a], this.nodeY[a], this.nodeZ[a])];
    const g = new Map<number, number>([[a, 0]]);
    const from = new Map<number, { n: number; edge: number; fwd: boolean }>();
    const open: [number, number][] = [[this.h(a, b), a]];
    const closed = new Set<number>();
    let exp = 0;
    while (open.length && exp++ < maxExpand) {
      // извлечь минимум (бинарная куча)
      const [, n] = heapPop(open);
      if (n === b) break;
      if (closed.has(n)) continue;
      closed.add(n);
      const gn = g.get(n)!;
      for (const e of this.adj[n]) {
        const ng = gn + e.len;
        if (ng < (g.get(e.to) ?? Infinity)) {
          g.set(e.to, ng);
          from.set(e.to, { n, edge: e.edge, fwd: e.fwd });
          heapPush(open, [ng + this.h(e.to, b), e.to]);
        }
      }
    }
    if (!from.has(b)) return null;
    const edges: { edge: number; fwd: boolean }[] = [];
    let cur = b;
    while (cur !== a) {
      const f = from.get(cur)!;
      edges.push({ edge: f.edge, fwd: f.fwd });
      cur = f.n;
    }
    edges.reverse();
    const pts: THREE.Vector3[] = [];
    for (const { edge, fwd } of edges) {
      const P = this.graph.edges[edge].points;
      const list = fwd ? P : [...P].reverse();
      for (const p of list) {
        const last = pts[pts.length - 1];
        if (last && Math.hypot(last.x - p[0], last.z - p[2]) < 0.5) continue;
        pts.push(new THREE.Vector3(p[0], p[1], p[2]));
      }
    }
    return pts;
  }

  private h(a: number, b: number): number { return Math.hypot(this.nodeX[a] - this.nodeX[b], this.nodeZ[a] - this.nodeZ[b]); }
}

function heapPush(h: [number, number][], v: [number, number]): void {
  h.push(v);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p][0] <= h[i][0]) break;
    [h[p], h[i]] = [h[i], h[p]];
    i = p;
  }
}
function heapPop(h: [number, number][]): [number, number] {
  const top = h[0];
  const last = h.pop()!;
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l][0] < h[m][0]) m = l;
      if (r < h.length && h[r][0] < h[m][0]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]];
      i = m;
    }
  }
  return top;
}
