/**
 * Граф путей (world/rail/net.json, контракт — docs/world-format.md, «Дополнение: железная дорога»).
 * Сегмент — ломаная оси пути между узлами (стрелка, конец, портал на границе мира), y точек = головка рельса.
 * Направленное состояние: (seg, dir), dir = +1 — от `from` к `to` (s растёт), −1 — обратно.
 */

export interface RailNodeJson { id: number; kind: 'switch' | 'pass' | 'end' | 'portal'; x: number; y: number; z: number; osm?: number; out?: [number, number] }
export interface RailSegJson {
  id: number; from: number; to: number; osm: number; len: number; usage: string; service: string; electrified: boolean;
  maxspeed?: number; dir?: number; ref?: string; name?: string; bridge: boolean; supports: number[]; points: [number, number, number][];
}
export interface RailStopJson { station: string; platform: number; segment: number; s0: number; s1: number; side: number }
export interface RailStationJson { name: string; osm: number; kind: string; x: number; z: number; inWorld: boolean; platforms: number[] }
export interface RailPlatformJson { id: number; osm: number; station: string; ref: string; x: number; y: number; z: number; area: number; length: number; tracks: number[] }
export interface CrossingEquipJson { type: 'barrier' | 'light'; x: number; y: number; z: number; rotY: number; armDir?: [number, number]; armLength?: number }
export interface RailCrossingJson {
  id: number; x: number; y: number; z: number; road: number; osmRoad: number; roadName: string; highway: string; sumoEdges: string[];
  roadDir: [number, number]; roadWidth: number; spread: number; barrier: boolean; lights: boolean; main: boolean;
  tracks: { segment: number; s: number }[]; equipment: CrossingEquipJson[]; osm?: number; carRoad?: boolean;
}
export interface RailSignalJson { segment: number; s: number; dir: number; kind: string; x: number; y: number; z: number; rotY: number; head: number }
export interface RailMastJson { x: number; y: number; z: number; rotY: number; arm: number; top: number; wire: number; segment: number }
export interface RailPortalJson { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; beam: number }
export interface RailBufferJson { x: number; y: number; z: number; rotY: number; segment: number; end: number }
export interface RailNetJson {
  version: number; nodes: RailNodeJson[]; segments: RailSegJson[]; links: [number, number, number, number, number][];
  stations: RailStationJson[]; platforms: RailPlatformJson[]; stops: RailStopJson[]; crossings: RailCrossingJson[];
  signals: RailSignalJson[]; masts: RailMastJson[]; portals: RailPortalJson[]; buffers: RailBufferJson[];
  dims?: { wireH: number };
}

export interface RailSeg {
  id: number; from: number; to: number; len: number; usage: string; service: string; elec: boolean; maxspeed: number; dirPref: number;
  bridge: boolean; supports: number[];
  /** x, y, z подряд. */
  pts: Float32Array;
  /** накопленная длина в точках. */
  cum: Float32Array;
}

/** Шаг по пути: сегмент и направление. */
export interface PathStep { seg: number; dir: 1 | -1 }

export class RailNet {
  readonly segs: RailSeg[];
  /** (seg*2 + end) → куда можно уехать, прибыв в этот конец: [seg2*2 + end2 (въезд)]. */
  readonly next = new Map<number, number[]>();
  readonly nodes: RailNodeJson[];

  constructor(readonly json: RailNetJson) {
    this.nodes = json.nodes;
    this.segs = json.segments.map((s) => {
      const n = s.points.length;
      const pts = new Float32Array(n * 3), cum = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        pts[i * 3] = s.points[i][0]; pts[i * 3 + 1] = s.points[i][1]; pts[i * 3 + 2] = s.points[i][2];
        if (i) cum[i] = cum[i - 1] + Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
      }
      return {
        id: s.id, from: s.from, to: s.to, len: cum[n - 1], usage: s.usage, service: s.service, elec: s.electrified,
        maxspeed: s.maxspeed ?? 0, dirPref: s.dir ?? 0, bridge: s.bridge, supports: s.supports, pts, cum,
      };
    });
    for (const [, s1, e1, s2, e2] of json.links) {
      const a = s1 * 2 + e1, b = s2 * 2 + e2;
      (this.next.get(a) ?? this.next.set(a, []).get(a)!).push(b);
      (this.next.get(b) ?? this.next.set(b, []).get(b)!).push(a);
    }
  }

  static async load(baseUrl: string): Promise<RailNet | null> {
    try {
      const r = await fetch(baseUrl + 'rail/net.json');
      if (!r.ok) return null;
      const j = (await r.json()) as RailNetJson;
      if (!j || j.version !== 1 || !j.segments?.length) return null;
      return new RailNet(j);
    } catch {
      return null;
    }
  }

  /** Точка на сегменте по s (м от начала): out = [x, y, z, tx, ty, tz] (касательная по возрастанию s). */
  pointAt(seg: number, s: number, out: Float32Array | number[]): void {
    const S = this.segs[seg], c = S.cum, p = S.pts, n = c.length;
    s = Math.min(Math.max(s, 0), c[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
    const L = c[hi] - c[lo] || 1, t = (s - c[lo]) / L;
    const a = lo * 3, b = hi * 3;
    out[0] = p[a] + (p[b] - p[a]) * t; out[1] = p[a + 1] + (p[b + 1] - p[a + 1]) * t; out[2] = p[a + 2] + (p[b + 2] - p[a + 2]) * t;
    out[3] = (p[b] - p[a]) / L; out[4] = (p[b + 1] - p[a + 1]) / L; out[5] = (p[b + 2] - p[a + 2]) / L;
  }

  /** Стоимость проезда сегмента в направлении (выбор маршрута): главные пути дешевле, правостороннее движение. */
  cost(seg: number, dir: number): number {
    const S = this.segs[seg];
    let f = 1;
    if (S.service === 'siding') f = 2.5;
    else if (S.service === 'crossover') f = 1.6;
    else if (S.service === 'spur' || S.service === 'yard') f = 40;
    else if (S.usage === 'branch') f = 1.15;
    else if (S.usage !== 'main') f = 3;
    if (S.dirPref && S.dirPref !== dir) f *= 5;
    return S.len * f + 1;
  }

  /**
   * Кратчайший путь (Дейкстра по направленным состояниям) из набора стартов в набор целей.
   * starts — (seg, dir) въезда; goal(seg, dir) — true, если доехать до конца этого шага = цель.
   * Возвращает шаги или null. via — необязательный обязательный сегмент (любое направление).
   */
  route(starts: PathStep[], goal: (st: PathStep) => boolean, avoid?: Set<number>): { path: PathStep[]; cost: number } | null {
    const key = (s: number, d: number) => s * 2 + (d > 0 ? 1 : 0);
    const dist = new Map<number, number>(), prev = new Map<number, number>();
    const heap: [number, number][] = [];
    const push = (c: number, k: number) => {
      heap.push([c, k]);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = (): [number, number] => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    for (const st of starts) {
      const k = key(st.seg, st.dir), c = this.cost(st.seg, st.dir);
      if ((dist.get(k) ?? Infinity) > c) { dist.set(k, c); prev.set(k, -1); push(c, k); }
    }
    while (heap.length) {
      const [c, k] = pop();
      if (c > (dist.get(k) ?? Infinity)) continue;
      const seg = k >> 1, dir: 1 | -1 = k & 1 ? 1 : -1;
      if (goal({ seg, dir })) {
        const path: PathStep[] = [];
        for (let q = k; q !== -1; q = prev.get(q)!) path.push({ seg: q >> 1, dir: q & 1 ? 1 : -1 });
        return { path: path.reverse(), cost: c };
      }
      const arriveEnd = dir > 0 ? 1 : 0;
      for (const nx of this.next.get(seg * 2 + arriveEnd) ?? []) {
        const s2 = nx >> 1, e2 = nx & 1;
        if (avoid?.has(s2)) continue;
        const d2 = e2 === 0 ? 1 : -1;
        const k2 = key(s2, d2), c2 = c + this.cost(s2, d2);
        if (c2 < (dist.get(k2) ?? Infinity)) { dist.set(k2, c2); prev.set(k2, k); push(c2, k2); }
      }
    }
    return null;
  }
}

/**
 * Путь поезда: склеенная ломаная шагов + продление на EXT м по прямой за порталы (поезд появляется и исчезает
 * за краем мира, в тумане). s = 0 — начало продления.
 */
export class TrainPath {
  pts: Float32Array;
  cum: Float32Array;
  /** Для каждой точки: индекс шага (−1 — продление). */
  stepOf: Int32Array;
  /** s начала каждого шага на пути. */
  stepS: number[] = [];
  length: number;

  constructor(readonly net: RailNet, readonly steps: PathStep[], readonly ext = 1500) {
    const P: number[] = [], St: number[] = [];
    const pushPt = (x: number, y: number, z: number, st: number) => {
      const n = P.length;
      if (n && Math.hypot(P[n - 3] - x, P[n - 2] - y, P[n - 1] - z) < 0.05) return;
      P.push(x, y, z); St.push(st);
    };
    steps.forEach((step, k) => {
      const S = net.segs[step.seg], n = S.cum.length;
      for (let i = 0; i < n; i++) {
        const j = step.dir > 0 ? i : n - 1 - i;
        pushPt(S.pts[j * 3], S.pts[j * 3 + 1], S.pts[j * 3 + 2], k);
      }
    });
    // продление концов
    const n = P.length / 3;
    const dir = (a: number, b: number) => {
      const dx = P[b * 3] - P[a * 3], dz = P[b * 3 + 2] - P[a * 3 + 2], l = Math.hypot(dx, dz) || 1;
      return [dx / l, dz / l];
    };
    const [sx, sz] = dir(Math.min(3, n - 1), 0), [ex, ez] = dir(Math.max(n - 4, 0), n - 1);
    const head: number[] = [], hs: number[] = [];
    for (let d = ext; d > 0; d -= 50) { head.push(P[0] + sx * d, P[1], P[2] + sz * d); hs.push(-1); }
    const tailP: number[] = [], ts: number[] = [];
    for (let d = 50; d <= ext; d += 50) { tailP.push(P[(n - 1) * 3] + ex * d, P[(n - 1) * 3 + 1], P[(n - 1) * 3 + 2] + ez * d); ts.push(-1); }
    const all = [...head, ...P, ...tailP], allS = [...hs, ...St, ...ts];
    this.pts = new Float32Array(all);
    this.stepOf = new Int32Array(allS);
    const m = allS.length;
    this.cum = new Float32Array(m);
    for (let i = 1; i < m; i++) this.cum[i] = this.cum[i - 1] + Math.hypot(all[i * 3] - all[i * 3 - 3], all[i * 3 + 1] - all[i * 3 - 2], all[i * 3 + 2] - all[i * 3 - 1]);
    this.length = this.cum[m - 1];
    let k = -2;
    for (let i = 0; i < m; i++) if (allS[i] !== k && allS[i] >= 0) { k = allS[i]; this.stepS[k] = this.cum[i]; }
  }

  /** Точка пути по s: out = [x, y, z, tx, ty, tz]; возвращает индекс звена. */
  at(s: number, out: Float32Array | number[], hint = -1): number {
    const c = this.cum, p = this.pts, n = c.length;
    if (s <= 0) s = 0; else if (s >= c[n - 1]) s = c[n - 1] - 1e-3;
    let lo: number, hi: number;
    if (hint >= 0 && hint < n - 1 && c[hint] <= s && c[hint + 1] >= s) { lo = hint; hi = hint + 1; }
    else {
      lo = 0; hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
    }
    const L = c[hi] - c[lo] || 1, t = (s - c[lo]) / L, a = lo * 3, b = hi * 3;
    out[0] = p[a] + (p[b] - p[a]) * t; out[1] = p[a + 1] + (p[b + 1] - p[a + 1]) * t; out[2] = p[a + 2] + (p[b + 2] - p[a + 2]) * t;
    out[3] = (p[b] - p[a]) / L; out[4] = (p[b + 1] - p[a + 1]) / L; out[5] = (p[b + 2] - p[a + 2]) / L;
    return lo;
  }

  /** s на пути для (сегмент, s на сегменте); NaN — сегмента нет в пути. */
  sOf(seg: number, sOnSeg: number): number {
    for (let k = 0; k < this.steps.length; k++) {
      const st = this.steps[k];
      if (st.seg !== seg) continue;
      const L = this.net.segs[seg].len;
      return this.stepS[k] + (st.dir > 0 ? sOnSeg : L - sOnSeg);
    }
    return NaN;
  }
}
