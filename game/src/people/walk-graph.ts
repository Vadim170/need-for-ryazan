/**
 * Пешеходный граф из `people/walk.json` (формат: docs/world-format.md, «Дополнение: пешеходная сеть»).
 * Всё в typed arrays: CSR-смежность, сетка-бакеты узлов и POI для выборок вокруг игрока, A* с ограничением.
 */

export const enum EdgeKind { Sidewalk = 0, Path = 1, Crossing = 2, Square = 3, Yard = 4, Link = 5 }
export const enum PoiType { Entrance = 0, Shop = 1, BusStop = 2, Bench = 3, Playground = 4, Park = 5, Busker = 6 }
export const POI_NAMES = ['entrance', 'shop', 'bus_stop', 'bench', 'playground', 'park', 'busker'];

/** pedestrianStreet — пешеходная улица (Почтовая): высокая плотность, часть спавна прямо туда (people-system). */
export const ZONE = { center: 1, commercial: 2, residential: 4, park: 8, industrial: 16, yard: 32, pedestrianStreet: 64 };

export interface Crossing {
  id: number;
  /** Узлы графа у бордюров. */
  a: number; b: number;
  x: number; y: number; z: number;
  width: number;
  /** id ребра roads/graph.json (дорога, которую пересекают). */
  road: number;
  /** id узла roads/graph.json со светофором (−1 — нет). */
  junction: number;
  signal: boolean;
  marked: boolean;
  /** id узла и ребра SUMO (для traffic/signals.ts pedestrianWalk); '' — нет. */
  sumoJunction?: string;
  sumoEdge?: string;
}

export interface WalkJson {
  version: number;
  nodes: number[];
  zone: number[];
  edges: number[];
  crossings: Crossing[];
  pois: { t: string; x: number; y: number; z: number; n: number; r?: number }[];
  stats?: Record<string, number>;
}

const CELL = 32;

export class WalkGraph {
  readonly n: number;
  readonly x: Float32Array; readonly y: Float32Array; readonly z: Float32Array;
  readonly zone: Uint8Array;
  /** CSR: соседи узла i — adj[start[i]..start[i+1]), ребро — adjEdge. */
  readonly start: Int32Array; readonly adj: Int32Array; readonly adjEdge: Int32Array;
  readonly edgeKind: Uint8Array; readonly edgeCross: Int32Array;
  readonly crossings: Crossing[];
  /** Переход по узлу (у бордюра) — для быстрого «следующий шаг — переход?». */
  readonly poiN: number;
  readonly poiX: Float32Array; readonly poiY: Float32Array; readonly poiZ: Float32Array;
  readonly poiR: Float32Array; readonly poiT: Uint8Array; readonly poiNode: Int32Array;
  // сетка
  readonly minX: number; readonly minZ: number; readonly cols: number; readonly rows: number;
  private cellStart: Int32Array; private cellItems: Int32Array;
  private pcellStart: Int32Array; private pcellItems: Int32Array;
  // A*
  private g: Float32Array; private from: Int32Array; private stamp: Uint32Array; private closed: Uint32Array; private gen = 1;
  private heap: Int32Array; private heapF: Float32Array;
  readonly stats: Record<string, number>;
  /** Компонента связности узла (цели выбираем только в своей компоненте — A* не тратится на недостижимые). */
  readonly comp: Int32Array;
  /** Узлы пешеходных улиц (ZONE.pedestrianStreet) — для прицельного спавна. */
  readonly pedNodes: Int32Array;

  constructor(js: WalkJson) {
    const N = (this.n = js.nodes.length / 3);
    this.x = new Float32Array(N); this.y = new Float32Array(N); this.z = new Float32Array(N);
    for (let i = 0; i < N; i++) { this.x[i] = js.nodes[3 * i]; this.y[i] = js.nodes[3 * i + 1]; this.z[i] = js.nodes[3 * i + 2]; }
    this.zone = Uint8Array.from(js.zone);
    const E = js.edges.length / 4;
    this.edgeKind = new Uint8Array(E); this.edgeCross = new Int32Array(E);
    const deg = new Int32Array(N + 1);
    for (let e = 0; e < E; e++) {
      deg[js.edges[4 * e]]++; deg[js.edges[4 * e + 1]]++;
      this.edgeKind[e] = js.edges[4 * e + 2]; this.edgeCross[e] = js.edges[4 * e + 3];
    }
    this.start = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) this.start[i + 1] = this.start[i] + deg[i];
    this.adj = new Int32Array(this.start[N]); this.adjEdge = new Int32Array(this.start[N]);
    const fill = this.start.slice(0, N);
    for (let e = 0; e < E; e++) {
      const a = js.edges[4 * e], b = js.edges[4 * e + 1];
      this.adj[fill[a]] = b; this.adjEdge[fill[a]++] = e;
      this.adj[fill[b]] = a; this.adjEdge[fill[b]++] = e;
    }
    this.crossings = js.crossings;
    // POI
    const types = new Map(POI_NAMES.map((n, i) => [n, i]));
    const P = js.pois.filter((p) => types.has(p.t));
    this.poiN = P.length;
    this.poiX = new Float32Array(P.length); this.poiY = new Float32Array(P.length); this.poiZ = new Float32Array(P.length);
    this.poiR = new Float32Array(P.length); this.poiT = new Uint8Array(P.length); this.poiNode = new Int32Array(P.length);
    P.forEach((p, i) => {
      this.poiX[i] = p.x; this.poiY[i] = p.y; this.poiZ[i] = p.z; this.poiR[i] = p.r ?? 0;
      this.poiT[i] = types.get(p.t)!; this.poiNode[i] = p.n;
    });
    // сетка
    let mnx = Infinity, mnz = Infinity, mxx = -Infinity, mxz = -Infinity;
    for (let i = 0; i < N; i++) {
      mnx = Math.min(mnx, this.x[i]); mxx = Math.max(mxx, this.x[i]); mnz = Math.min(mnz, this.z[i]); mxz = Math.max(mxz, this.z[i]);
    }
    this.minX = mnx - 1; this.minZ = mnz - 1;
    this.cols = Math.ceil((mxx - mnx + 2) / CELL) + 1; this.rows = Math.ceil((mxz - mnz + 2) / CELL) + 1;
    [this.cellStart, this.cellItems] = this.bucket(N, this.x, this.z);
    [this.pcellStart, this.pcellItems] = this.bucket(P.length, this.poiX, this.poiZ);
    this.g = new Float32Array(N); this.from = new Int32Array(N); this.stamp = new Uint32Array(N); this.closed = new Uint32Array(N);
    this.heap = new Int32Array(Math.max(16, this.start[N] + 16)); this.heapF = new Float32Array(this.heap.length);
    this.comp = new Int32Array(N).fill(-1);
    const stack = new Int32Array(N);
    let nc = 0;
    for (let s0 = 0; s0 < N; s0++) {
      if (this.comp[s0] >= 0) continue;
      let sp = 0; stack[sp++] = s0; this.comp[s0] = nc;
      while (sp > 0) {
        const u = stack[--sp];
        for (let k = this.start[u]; k < this.start[u + 1]; k++) {
          const v = this.adj[k];
          if (this.comp[v] < 0) { this.comp[v] = nc; stack[sp++] = v; }
        }
      }
      nc++;
    }
    const ped: number[] = [];
    for (let i = 0; i < N; i++) if (this.zone[i] & ZONE.pedestrianStreet) ped.push(i);
    this.pedNodes = Int32Array.from(ped);
    this.stats = { components: nc, nodes: N, edges: E, crossings: js.crossings.length, pois: P.length, pedNodes: ped.length };
  }

  static async load(baseUrl: string): Promise<WalkGraph | null> {
    try {
      const r = await fetch(`${baseUrl}people/walk.json`);
      if (!r.ok) return null;
      const js = (await r.json()) as WalkJson;
      return new WalkGraph(js);
    } catch (e) {
      console.warn('[people] walk.json не загрузился', e);
      return null;
    }
  }

  private bucket(n: number, xs: Float32Array, zs: Float32Array): [Int32Array, Int32Array] {
    const nc = this.cols * this.rows;
    const cnt = new Int32Array(nc + 1);
    const cell = new Int32Array(n);
    for (let i = 0; i < n; i++) { const c = this.cellOf(xs[i], zs[i]); cell[i] = c; cnt[c + 1]++; }
    for (let c = 0; c < nc; c++) cnt[c + 1] += cnt[c];
    const items = new Int32Array(n);
    const fill = cnt.slice(0, nc);
    for (let i = 0; i < n; i++) items[fill[cell[i]]++] = i;
    return [cnt, items];
  }

  cellOf(x: number, z: number): number {
    const c = Math.min(Math.max(Math.floor((x - this.minX) / CELL), 0), this.cols - 1);
    const r = Math.min(Math.max(Math.floor((z - this.minZ) / CELL), 0), this.rows - 1);
    return r * this.cols + c;
  }

  /** Узлы в ячейке, содержащей (x, z): [from, to) по cellItemsArr. */
  forNodesInCell(x: number, z: number, fn: (i: number) => void): void {
    const c = this.cellOf(x, z);
    for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) fn(this.cellItems[k]);
  }

  randomNodeInCell(x: number, z: number, rnd: number): number {
    const c = this.cellOf(x, z);
    const a = this.cellStart[c], b = this.cellStart[c + 1];
    if (b <= a) return -1;
    return this.cellItems[a + Math.min(b - a - 1, Math.floor(rnd * (b - a)))];
  }

  forPoisInRadius(x: number, z: number, r: number, fn: (i: number) => void): void {
    const c0 = Math.max(0, Math.floor((x - r - this.minX) / CELL)), c1 = Math.min(this.cols - 1, Math.floor((x + r - this.minX) / CELL));
    const r0 = Math.max(0, Math.floor((z - r - this.minZ) / CELL)), r1 = Math.min(this.rows - 1, Math.floor((z + r - this.minZ) / CELL));
    for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) {
      const c = rr * this.cols + cc;
      for (let k = this.pcellStart[c]; k < this.pcellStart[c + 1]; k++) fn(this.pcellItems[k]);
    }
  }

  randomPoiInCell(x: number, z: number, rnd: number): number {
    const c = this.cellOf(x, z);
    const a = this.pcellStart[c], b = this.pcellStart[c + 1];
    if (b <= a) return -1;
    return this.pcellItems[a + Math.min(b - a - 1, Math.floor(rnd * (b - a)))];
  }

  nearestNode(x: number, z: number, maxR = 64): number {
    let best = -1, bd = maxR * maxR;
    const c0 = Math.max(0, Math.floor((x - maxR - this.minX) / CELL)), c1 = Math.min(this.cols - 1, Math.floor((x + maxR - this.minX) / CELL));
    const r0 = Math.max(0, Math.floor((z - maxR - this.minZ) / CELL)), r1 = Math.min(this.rows - 1, Math.floor((z + maxR - this.minZ) / CELL));
    for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) {
      const c = rr * this.cols + cc;
      for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
        const i = this.cellItems[k];
        const d = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  }

  edgeBetween(a: number, b: number): number {
    for (let k = this.start[a]; k < this.start[a + 1]; k++) if (this.adj[k] === b) return this.adjEdge[k];
    return -1;
  }

  /**
   * A* от a до b. Стоимость = длина × вид ребра (дворы, связки дороже; переход +6 м — люди не бегают туда-сюда).
   * Возвращает путь (узлы a..b) или null, если не нашли за maxExpand раскрытий.
   */
  findPath(a: number, b: number, maxExpand = 5000): Int32Array | null {
    if (a === b) return Int32Array.of(a);
    const gen = ++this.gen;
    const { x, z, g, from, stamp, closed, heap, heapF } = this;
    const bx = x[b], bz = z[b];
    let hn = 0;
    const push = (i: number, f: number) => {
      let k = hn++;
      while (k > 0) { const p = (k - 1) >> 1; if (heapF[p] <= f) break; heap[k] = heap[p]; heapF[k] = heapF[p]; k = p; }
      heap[k] = i; heapF[k] = f;
    };
    const pop = (): number => {
      const top = heap[0];
      const li = heap[--hn], lf = heapF[hn];
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= hn) break;
        if (c + 1 < hn && heapF[c + 1] < heapF[c]) c++;
        if (heapF[c] >= lf) break;
        heap[k] = heap[c]; heapF[k] = heapF[c]; k = c;
      }
      heap[k] = li; heapF[k] = lf;
      return top;
    };
    stamp[a] = gen; g[a] = 0; from[a] = -1;
    push(a, Math.hypot(x[a] - bx, z[a] - bz));
    let exp = 0;
    while (hn > 0) {
      const u = pop();
      if (closed[u] === gen) continue;
      closed[u] = gen;
      if (u === b) break;
      if (++exp > maxExpand || hn >= heap.length - 64) return null;
      for (let k = this.start[u]; k < this.start[u + 1]; k++) {
        const v = this.adj[k];
        if (closed[v] === gen) continue;
        const kind = this.edgeKind[this.adjEdge[k]];
        const len = Math.hypot(x[v] - x[u], z[v] - z[u]);
        const cost = len * (kind === EdgeKind.Yard ? 1.35 : kind === EdgeKind.Link ? 1.2 : kind === EdgeKind.Path ? 0.95 : 1) +
          (kind === EdgeKind.Crossing ? 3 : 0);
        const ng = g[u] + cost;
        if (stamp[v] !== gen || ng < g[v]) {
          stamp[v] = gen; g[v] = ng; from[v] = u;
          push(v, ng + Math.hypot(x[v] - bx, z[v] - bz));
        }
      }
    }
    if (closed[b] !== gen) return null;
    let len = 1;
    for (let u = b; from[u] >= 0; u = from[u]) len++;
    const out = new Int32Array(len);
    for (let u = b, k = len - 1; k >= 0; u = from[u], k--) out[k] = u;
    return out;
  }

  /** Случайная прогулка без цели: steps рёбер, без разворотов, через переходы — с вероятностью pCross. */
  randomWalk(a: number, steps: number, rnd: () => number, pCross = 0.4): Int32Array {
    const out = [a];
    let prev = -1, u = a;
    for (let s = 0; s < steps; s++) {
      const s0 = this.start[u], s1 = this.start[u + 1];
      const deg = s1 - s0;
      if (deg === 0) break;
      let pick = -1;
      for (let tries = 0; tries < 4; tries++) {
        const k = s0 + Math.floor(rnd() * deg);
        const v = this.adj[k];
        if (v === prev && deg > 1) continue;
        if (this.edgeKind[this.adjEdge[k]] === EdgeKind.Crossing && rnd() > pCross && deg > 1) continue;
        pick = v; break;
      }
      if (pick < 0) pick = this.adj[s0 + Math.floor(rnd() * deg)];
      out.push(pick);
      prev = u; u = pick;
    }
    return Int32Array.from(out);
  }
}
