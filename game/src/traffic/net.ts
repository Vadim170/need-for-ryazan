/**
 * Граф полос для трафика: traffic/net.json + traffic/geom.bin (формат: docs/world-format.md, «Дополнение: трафик»).
 *
 * «Сегмент» — единый номер для полос и соединений: seg < nLanes — полоса, seg >= nLanes — соединение (conn = seg - nLanes),
 * то есть путь машины — чередование полоса → соединение (через перекрёсток) → полоса …
 * Точки — координаты игры (y — поверхность дороги, на мостах — настил).
 */

export const CLS_CAR = 1, CLS_BUS = 2, CLS_SERVICE = 4;

export interface NetEdge {
  id: string; from: number; to: number; hw: string; prio: number; name: string;
  lanes: number[]; osmId: number | null; bridge: boolean; main: number;
}
export interface NetTls { id: string; offset: number; phases: [number, string][]; junctions: number[] }
export interface NetRoute {
  osmId: number; type: 'bus' | 'trolleybus' | 'share_taxi'; ref: string; name: string;
  pieces: { edges: number[]; stops: [number, number][] }[];
}
interface NetJson {
  version: number; geom: string; points: number;
  edges: NetEdge[];
  lanes: { edge: number[]; index: number[]; speed: number[]; length: number[]; width: number[]; cls: number[]; p0: number[]; pn: number[] };
  conns: {
    from: number[]; to: number[]; junction: number[]; length: number[]; speed: number[]; p0: number[]; pn: number[];
    tl: number[]; link: number[]; dir: string; state: string; resp: number[][]; foes: number[][];
  };
  junctions: { id: string[]; type: string[]; x: number[]; y: number[]; z: number[]; tl: number[] };
  tls: NetTls[];
  routes: NetRoute[];
}

const GRID = 100;

export class TrafficNet {
  readonly nLanes: number;
  readonly nConns: number;
  readonly nSegs: number;
  readonly edges: NetEdge[];
  readonly tls: NetTls[];
  readonly routes: NetRoute[];
  /** xyz точек всех сегментов. */
  readonly pts: Float32Array;
  /** Накопленная 3D-длина вдоль сегмента в каждой точке. */
  readonly cum: Float32Array;
  /** Кривизна в плане в каждой точке, 1/м (+ — поворот влево). */
  readonly curv: Float32Array;
  readonly segP0: Int32Array;
  readonly segPn: Int32Array;
  readonly segLen: Float32Array;
  readonly segSpeed: Float32Array;
  // полосы
  readonly laneEdge: Int32Array;
  readonly laneIndex: Int32Array;
  readonly laneCls: Uint8Array;
  readonly laneWidth: Float32Array;
  /** Соединения из полосы (номера conn). */
  readonly laneOut: number[][];
  readonly laneIn: number[][];
  // соединения
  readonly connFrom: Int32Array;
  readonly connTo: Int32Array;
  readonly connJunction: Int32Array;
  readonly connTl: Int32Array;
  readonly connLink: Int32Array;
  readonly connDir: string;
  readonly connState: string;
  /** Кому уступает соединение (SUMO response). */
  readonly connResp: number[][];
  /** С кем пересекается (SUMO foes). */
  readonly connFoes: number[][];
  // узлы
  readonly junctionId: string[];
  readonly junctionType: string[];
  readonly junctionXYZ: Float32Array;
  readonly junctionTl: Int32Array;
  readonly junctionIndex = new Map<string, number>();
  readonly edgeIndex = new Map<string, number>();
  /** Соединения, проходящие через узел. */
  readonly junctionConns: number[][];
  readonly stats = { addedFoes: 0 };
  /** Сетка 100 м → полосы. */
  private grid = new Map<number, number[]>();

  constructor(j: NetJson, geom: Float32Array) {
    this.edges = j.edges; this.tls = j.tls; this.routes = j.routes;
    const L = j.lanes, C = j.conns;
    const nL = (this.nLanes = L.edge.length), nC = (this.nConns = C.from.length);
    const nS = (this.nSegs = nL + nC);
    this.segP0 = new Int32Array(nS); this.segPn = new Int32Array(nS);
    this.segLen = new Float32Array(nS); this.segSpeed = new Float32Array(nS);
    const rawP0 = new Int32Array(nS), rawPn = new Int32Array(nS);
    for (let i = 0; i < nL; i++) { rawP0[i] = L.p0[i]; rawPn[i] = L.pn[i]; this.segSpeed[i] = L.speed[i]; }
    for (let i = 0; i < nC; i++) { rawP0[nL + i] = C.p0[i]; rawPn[nL + i] = C.pn[i]; this.segSpeed[nL + i] = C.speed[i]; }
    // сглаживание: центростремительный Катмулл–Ром по каждому сегменту; у соединений касательные на концах —
    // от полос, которые они связывают (C1 на стыке полоса → перекрёсток → полоса)
    geom = smoothSegments(geom, rawP0, rawPn, nL, C.from, C.to, this.segP0, this.segPn);
    this.pts = geom;
    this.cum = new Float32Array(geom.length / 3);
    this.curv = new Float32Array(geom.length / 3);
    for (let s = 0; s < nS; s++) {
      const p0 = this.segP0[s], pn = this.segPn[s];
      let acc = 0;
      this.cum[p0] = 0;
      for (let k = 1; k < pn; k++) {
        const a = (p0 + k - 1) * 3, b = (p0 + k) * 3;
        acc += Math.hypot(geom[b] - geom[a], geom[b + 1] - geom[a + 1], geom[b + 2] - geom[a + 2]);
        this.cum[p0 + k] = acc;
      }
      this.segLen[s] = Math.max(acc, 0.05);
      // кривизна (Менгер, в плане), знак: + влево
      const cv = this.curv;
      for (let k = 1; k + 1 < pn; k++) {
        const o = (p0 + k) * 3;
        const ax = geom[o] - geom[o - 3], az = geom[o + 2] - geom[o - 1];
        const bx = geom[o + 3] - geom[o], bz = geom[o + 5] - geom[o + 2];
        const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz), lc = Math.hypot(ax + bx, az + bz);
        cv[p0 + k] = la * lb * lc > 1e-6 ? (-2 * (ax * bz - az * bx)) / (la * lb * lc) : 0;
      }
      if (pn > 2) { cv[p0] = cv[p0 + 1]; cv[p0 + pn - 1] = cv[p0 + pn - 2]; }
    }
    this.laneEdge = Int32Array.from(L.edge); this.laneIndex = Int32Array.from(L.index);
    this.laneCls = Uint8Array.from(L.cls); this.laneWidth = Float32Array.from(L.width);
    this.connFrom = Int32Array.from(C.from); this.connTo = Int32Array.from(C.to);
    this.connJunction = Int32Array.from(C.junction); this.connTl = Int32Array.from(C.tl); this.connLink = Int32Array.from(C.link);
    this.connDir = C.dir; this.connState = C.state; this.connResp = C.resp; this.connFoes = C.foes;
    this.laneOut = Array.from({ length: nL }, () => []);
    this.laneIn = Array.from({ length: nL }, () => []);
    for (let c = 0; c < nC; c++) { this.laneOut[C.from[c]].push(c); this.laneIn[C.to[c]].push(c); }
    const J = j.junctions;
    this.junctionId = J.id; this.junctionType = J.type; this.junctionTl = Int32Array.from(J.tl);
    this.junctionXYZ = new Float32Array(J.id.length * 3);
    J.id.forEach((id, i) => {
      this.junctionIndex.set(id, i);
      this.junctionXYZ[i * 3] = J.x[i]; this.junctionXYZ[i * 3 + 1] = J.y[i]; this.junctionXYZ[i * 3 + 2] = J.z[i];
    });
    this.junctionConns = Array.from({ length: J.id.length }, () => []);
    for (let c = 0; c < nC; c++) if (C.junction[c] >= 0) this.junctionConns[C.junction[c]].push(c);
    this.stats.addedFoes = this.addGeometricFoes();
    this.edges.forEach((e, i) => this.edgeIndex.set(e.id, i));
    // сетка полос
    for (let l = 0; l < nL; l++) {
      const seen = new Set<number>();
      const p0 = this.segP0[l], pn = this.segPn[l];
      for (let k = 0; k < pn; k++) {
        const key = this.cellKey(geom[(p0 + k) * 3], geom[(p0 + k) * 3 + 2]);
        if (seen.has(key)) continue;
        seen.add(key);
        let a = this.grid.get(key);
        if (!a) this.grid.set(key, (a = []));
        a.push(l);
      }
    }
  }

  /**
   * Дополнение конфликтов по геометрии: у поворотов через внутренний узел SUMO (левые на больших перекрёстках) в request
   * узла нет foes/response — пересечение траекторий находим сами. Слияние в одну полосу — тоже конфликт.
   * Кто уступает (если SUMO не сказал): налево/разворот — прямому и направо; второстепенный — главному.
   */
  private addGeometricFoes(): number {
    const nL = this.nLanes, P = this.pts;
    let added = 0;
    const rank = (c: number) => {
      const d = this.connDir[c], st = this.connState[c];
      return (st === 'M' || st === 'O' ? 10 : 0) + (d === 's' ? 3 : d === 'r' || d === 'R' ? 2 : d === 'l' || d === 'L' ? 1 : 0);
    };
    const cross = (a: number, b: number): boolean => {
      if (this.connTo[a] === this.connTo[b]) return true;
      const sa = nL + a, sb = nL + b;
      const a0 = this.segP0[sa], an = this.segPn[sa], b0 = this.segP0[sb], bn = this.segPn[sb];
      for (let i = 0; i + 1 < an; i++) {
        if (this.cum[a0 + i + 1] < 1.0) continue; // старт у стоп-линии — соседние полосы рядом, это не конфликт
        const ax = P[(a0 + i) * 3], az = P[(a0 + i) * 3 + 2], bx = P[(a0 + i + 1) * 3], bz = P[(a0 + i + 1) * 3 + 2];
        for (let k = 0; k + 1 < bn; k++) {
          if (this.cum[b0 + k + 1] < 1.0) continue;
          const cx = P[(b0 + k) * 3], cz = P[(b0 + k) * 3 + 2], dx = P[(b0 + k + 1) * 3], dz = P[(b0 + k + 1) * 3 + 2];
          const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax), d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
          const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx), d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
          if (d1 * d2 < 0 && d3 * d4 < 0) return true;
        }
      }
      return false;
    };
    for (const cs of this.junctionConns) {
      if (cs.length < 2) continue;
      for (let i = 0; i < cs.length; i++) for (let k = i + 1; k < cs.length; k++) {
        const a = cs[i], b = cs[k];
        if (this.laneEdge[this.connFrom[a]] === this.laneEdge[this.connFrom[b]]) continue;
        if (this.connFoes[a].includes(b) || this.connFoes[b].includes(a)) continue;
        if (!cross(a, b)) continue;
        this.connFoes[a].push(b); this.connFoes[b].push(a);
        const ra = rank(a), rb = rank(b);
        if (ra < rb && !this.connResp[a].includes(b)) this.connResp[a].push(b);
        else if (rb < ra && !this.connResp[b].includes(a)) this.connResp[b].push(a);
        added++;
      }
    }
    return added;
  }

  static async load(baseUrl: string): Promise<TrafficNet | null> {
    try {
      const r = await fetch(`${baseUrl}traffic/net.json`);
      if (!r.ok) return null;
      const j = (await r.json()) as NetJson;
      const g = await fetch(`${baseUrl}traffic/${j.geom}`);
      if (!g.ok) return null;
      return new TrafficNet(j, new Float32Array(await g.arrayBuffer()));
    } catch (e) {
      console.warn('[traffic] net.json не загрузился', e);
      return null;
    }
  }

  private cellKey(x: number, z: number): number {
    return (Math.floor(x / GRID) + 1000) * 4096 + (Math.floor(z / GRID) + 1000);
  }

  /** Полосы, проходящие через клетки в радиусе r от (x, z) (с запасом до клетки). */
  lanesNear(x: number, z: number, r: number, out: Set<number> = new Set()): Set<number> {
    const c0 = Math.floor((x - r) / GRID), c1 = Math.floor((x + r) / GRID);
    const r0 = Math.floor((z - r) / GRID), r1 = Math.floor((z + r) / GRID);
    for (let cx = c0; cx <= c1; cx++) for (let cz = r0; cz <= r1; cz++) {
      const a = this.grid.get((cx + 1000) * 4096 + (cz + 1000));
      if (a) for (const l of a) out.add(l);
    }
    return out;
  }

  isConn(seg: number): boolean { return seg >= this.nLanes; }
  laneOfEdge(edge: number, index: number): number {
    const ls = this.edges[edge].lanes;
    return ls[Math.max(0, Math.min(ls.length - 1, index))];
  }

  /** Точка на сегменте на расстоянии s (м, зажимается в [0, len]) → out[o..o+2]; возвращает номер точки отрезка. */
  pointAt(seg: number, s: number, out: Float32Array | number[], o = 0): number {
    const p0 = this.segP0[seg], pn = this.segPn[seg], cum = this.cum, P = this.pts;
    if (s <= 0 || pn < 2) { out[o] = P[p0 * 3]; out[o + 1] = P[p0 * 3 + 1]; out[o + 2] = P[p0 * 3 + 2]; return 0; }
    let lo = 0, hi = pn - 1;
    if (s >= cum[p0 + hi]) { const b = (p0 + hi) * 3; out[o] = P[b]; out[o + 1] = P[b + 1]; out[o + 2] = P[b + 2]; return hi - 1; }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[p0 + m] <= s) lo = m; else hi = m; }
    const a = (p0 + lo) * 3, b = (p0 + hi) * 3;
    const t = (s - cum[p0 + lo]) / Math.max(cum[p0 + hi] - cum[p0 + lo], 1e-6);
    out[o] = P[a] + (P[b] - P[a]) * t; out[o + 1] = P[a + 1] + (P[b + 1] - P[a + 1]) * t; out[o + 2] = P[a + 2] + (P[b + 2] - P[a + 2]) * t;
    return lo;
  }

  /** Кривизна на сегменте в точке s (линейно между точками). */
  curvatureAt(seg: number, s: number): number {
    const p0 = this.segP0[seg], pn = this.segPn[seg], cum = this.cum;
    if (pn < 2) return 0;
    let lo = 0, hi = pn - 1;
    if (s <= 0) return this.curv[p0];
    if (s >= cum[p0 + hi]) return this.curv[p0 + hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[p0 + m] <= s) lo = m; else hi = m; }
    const t = (s - cum[p0 + lo]) / Math.max(cum[p0 + hi] - cum[p0 + lo], 1e-6);
    return this.curv[p0 + lo] * (1 - t) + this.curv[p0 + hi] * t;
  }

  /** Ближайшая точка полосы к (x, z): {lane, s, d} (поиск по сетке, радиус r). */
  nearestLane(x: number, z: number, r = 30, filter?: (lane: number) => boolean): { lane: number; s: number; d: number } | null {
    let best: { lane: number; s: number; d: number } | null = null;
    for (const l of this.lanesNear(x, z, r)) {
      if (filter && !filter(l)) continue;
      const p0 = this.segP0[l], pn = this.segPn[l], P = this.pts;
      for (let k = 0; k + 1 < pn; k++) {
        const a = (p0 + k) * 3, b = a + 3;
        const dx = P[b] - P[a], dz = P[b + 2] - P[a + 2];
        const L2 = dx * dx + dz * dz || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - P[a]) * dx + (z - P[a + 2]) * dz) / L2));
        const d = Math.hypot(P[a] + dx * t - x, P[a + 2] + dz * t - z);
        if (!best || d < best.d) best = { lane: l, s: this.cum[p0 + k] + t * (this.cum[p0 + k + 1] - this.cum[p0 + k]), d };
      }
    }
    return best && best.d <= r ? best : null;
  }
}

/**
 * Сглаживание ломаных сегментов центростремительным сплайном Катмулла–Рома: на изгибах точки через ≤ 1.5 м,
 * прямые участки не дробятся. Концы сегментов сохраняются; для соединений фантомные точки берутся с соседних полос.
 */
function smoothSegments(G: Float32Array, rawP0: Int32Array, rawPn: Int32Array, nL: number, cFrom: number[], cTo: number[],
  outP0: Int32Array, outPn: Int32Array): Float32Array {
  const nS = rawP0.length;
  let out = new Float32Array(G.length * 2);
  let n = 0;
  const push = (x: number, y: number, z: number) => {
    if (n * 3 + 3 > out.length) { const o2 = new Float32Array(out.length * 2); o2.set(out); out = o2; }
    out[n * 3] = x; out[n * 3 + 1] = y; out[n * 3 + 2] = z; n++;
  };
  const P = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let s = 0; s < nS; s++) {
    const p0 = rawP0[s], pn = rawPn[s];
    outP0[s] = n;
    const pt = (k: number, o: number) => { const b = (p0 + k) * 3; P[o] = G[b]; P[o + 1] = G[b + 1]; P[o + 2] = G[b + 2]; };
    // фантомы
    let preX = NaN, preY = 0, preZ = 0, postX = NaN, postY = 0, postZ = 0;
    if (s >= nL) {
      const fl = cFrom[s - nL], tl = cTo[s - nL];
      if (rawPn[fl] >= 2) { const b = (rawP0[fl] + rawPn[fl] - 2) * 3; preX = G[b]; preY = G[b + 1]; preZ = G[b + 2]; }
      if (rawPn[tl] >= 2) { const b = (rawP0[tl] + 1) * 3; postX = G[b]; postY = G[b + 1]; postZ = G[b + 2]; }
    }
    if (pn < 2) { for (let k = 0; k < pn; k++) { const b = (p0 + k) * 3; push(G[b], G[b + 1], G[b + 2]); } outPn[s] = n - outP0[s]; continue; }
    const b0 = p0 * 3;
    push(G[b0], G[b0 + 1], G[b0 + 2]);
    for (let k = 0; k + 1 < pn; k++) {
      // P0..P3 = точки k-1, k, k+1, k+2
      pt(k, 3); pt(k + 1, 6);
      if (k > 0) pt(k - 1, 0);
      else if (!Number.isNaN(preX)) { P[0] = preX; P[1] = preY; P[2] = preZ; }
      else { P[0] = 2 * P[3] - P[6]; P[1] = 2 * P[4] - P[7]; P[2] = 2 * P[5] - P[8]; }
      if (k + 2 < pn) pt(k + 2, 9);
      else if (!Number.isNaN(postX)) { P[9] = postX; P[10] = postY; P[11] = postZ; }
      else { P[9] = 2 * P[6] - P[3]; P[10] = 2 * P[7] - P[4]; P[11] = 2 * P[8] - P[5]; }
      const len = Math.hypot(P[6] - P[3], P[8] - P[5]);
      // изгиб: угол между касательными на концах пролёта
      const a1 = Math.atan2(P[6] - P[0], P[8] - P[2]), a2 = Math.atan2(P[9] - P[3], P[11] - P[5]);
      let da = Math.abs(a2 - a1); if (da > Math.PI) da = 2 * Math.PI - da;
      const m = da < 0.01 || len < 0.3 ? 1 : Math.min(40, Math.max(2, Math.ceil(len / 1.5)));
      if (m > 1) {
        const d01 = Math.max(Math.sqrt(Math.hypot(P[3] - P[0], P[4] - P[1], P[5] - P[2])), 1e-3);
        const d12 = Math.max(Math.sqrt(Math.hypot(P[6] - P[3], P[7] - P[4], P[8] - P[5])), 1e-3);
        const d23 = Math.max(Math.sqrt(Math.hypot(P[9] - P[6], P[10] - P[7], P[11] - P[8])), 1e-3);
        const t0 = 0, t1 = d01, t2 = t1 + d12, t3 = t2 + d23;
        for (let i = 1; i < m; i++) {
          const t = t1 + (t2 - t1) * (i / m);
          const v = [0, 0, 0];
          for (let c = 0; c < 3; c++) {
            const p0c = P[c], p1c = P[3 + c], p2c = P[6 + c], p3c = P[9 + c];
            const A1 = ((t1 - t) / (t1 - t0)) * p0c + ((t - t0) / (t1 - t0)) * p1c;
            const A2 = ((t2 - t) / (t2 - t1)) * p1c + ((t - t1) / (t2 - t1)) * p2c;
            const A3 = ((t3 - t) / (t3 - t2)) * p2c + ((t - t2) / (t3 - t2)) * p3c;
            const B1 = ((t2 - t) / (t2 - t0)) * A1 + ((t - t0) / (t2 - t0)) * A2;
            const B2 = ((t3 - t) / (t3 - t1)) * A2 + ((t - t1) / (t3 - t1)) * A3;
            v[c] = ((t2 - t) / (t2 - t1)) * B1 + ((t - t1) / (t2 - t1)) * B2;
          }
          // высота — линейно (точки пайплайна уже лежат на меше дорог)
          v[1] = P[4] + (P[7] - P[4]) * (i / m);
          push(v[0], v[1], v[2]);
        }
      }
      push(P[6], P[7], P[8]);
    }
    outPn[s] = n - outP0[s];
  }
  return out.slice(0, n * 3);
}
