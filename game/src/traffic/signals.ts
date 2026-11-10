import type { TrafficNet } from './net';

/**
 * Светофоры: исполняет программы tlLogic SUMO (фазы: длительность + строка состояний по linkIndex).
 *
 * Состояния ссылки (символ SUMO): G — зелёный главный, g — зелёный с уступкой (налево/направо через встречный поток),
 * y — жёлтый, r — красный, u — красный+жёлтый (синтезируется: последние 2 с красного перед зелёным), o/O — выключен (мигает жёлтый).
 *
 * API для визуала и пешеходов (README, «Трафик»):
 * - `getSignalState(junctionId, linkIndex)` — символ состояния ссылки (linkIndex в нумерации светофора, как в net.xml);
 * - `getApproachColor(junction, edge)` — цвет подхода: 0 красный, 1 жёлтый, 2 зелёный, 3 красный+жёлтый, 4 жёлтый мигает;
 * - `approaches(junction)` — подходы регулируемого узла (ребро, точка стоп-линии, направление движения, число полос);
 * - `pedestrianWalk(junction, edge)` — можно ли пешеходам переходить «рукав» узла (ребро входа или выхода): true, когда все
 *   машины со входящего ребра стоят на красном и прямые потоки в исходящее ребро тоже красные; null — узел без светофора;
 * - `propSource()` — функция для `city.props.setSignalSource` (сопоставляет пропсы светофоров подходам по положению).
 */

export type SignalColor = 0 | 1 | 2 | 3 | 4;

export interface Approach {
  junction: number;
  edge: number;
  /** Середина стоп-линии (конец правой полосы ребра), координаты игры. */
  x: number; y: number; z: number;
  /** Единичный вектор направления движения на подходе (x, z). */
  dx: number; dz: number;
  lanes: number;
  /** Соединения узла с этого ребра. */
  conns: number[];
}

const CH_G = 71, CH_g = 103, CH_y = 121, CH_r = 114, CH_u = 117, CH_o = 111, CH_O = 79, CH_s = 115;

export class SignalController {
  time = 0;
  /** Текущее состояние каждого светофора: номер фазы и время от её начала. */
  private phase: Int32Array;
  private inPhase: Float32Array;
  private cycle: Float32Array;
  private shift: Float32Array;
  private approachList: Approach[][] = [];
  private approachByKey = new Map<number, Approach>();
  private lightMap = new WeakMap<object, Approach | null>();

  constructor(private net: TrafficNet) {
    const n = net.tls.length;
    this.phase = new Int32Array(n); this.inPhase = new Float32Array(n);
    this.cycle = new Float32Array(n); this.shift = new Float32Array(n);
    net.tls.forEach((t, i) => {
      this.cycle[i] = t.phases.reduce((a, p) => a + p[0], 0) || 1;
      // SUMO даёт offset = 0 всем: сдвигаем детерминированно, чтобы соседние перекрёстки не переключались синхронно
      const h = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
      this.shift[i] = t.offset + (h - Math.floor(h)) * this.cycle[i];
    });
    // подходы регулируемых узлов
    const nJ = net.junctionId.length;
    this.approachList = Array.from({ length: nJ }, () => []);
    for (let j = 0; j < nJ; j++) {
      if (net.junctionTl[j] < 0) continue;
      const byEdge = new Map<number, number[]>();
      for (const c of net.junctionConns[j]) {
        if (net.connTl[c] < 0) continue;
        const e = net.laneEdge[net.connFrom[c]];
        (byEdge.get(e) ?? byEdge.set(e, []).get(e)!).push(c);
      }
      for (const [e, conns] of byEdge) {
        const lane = net.edges[e].lanes[0];
        const p0 = net.segP0[lane], pn = net.segPn[lane], P = net.pts;
        const b = (p0 + pn - 1) * 3, a = (p0 + Math.max(pn - 2, 0)) * 3;
        const dx = P[b] - P[a], dz = P[b + 2] - P[a + 2], l = Math.hypot(dx, dz) || 1;
        // середина правых полос: сдвиг влево от правой полосы на половину ширины ребра
        const nl = net.edges[e].lanes.length;
        const w = net.edges[e].lanes.reduce((acc, ln) => acc + net.laneWidth[ln], 0);
        const off = (w - net.laneWidth[lane]) / 2;
        const ap: Approach = {
          junction: j, edge: e, x: P[b] + (dz / l) * off, y: P[b + 1], z: P[b + 2] - (dx / l) * off,
          dx: dx / l, dz: dz / l, lanes: nl, conns,
        };
        this.approachList[j].push(ap);
        this.approachByKey.set(j * 65536 + e, ap);
      }
    }
    this.update(0);
  }

  update(dt: number): void {
    this.time += dt;
    const tls = this.net.tls;
    for (let i = 0; i < tls.length; i++) {
      let t = (this.time + this.shift[i]) % this.cycle[i];
      const ph = tls[i].phases;
      let k = 0;
      while (k < ph.length - 1 && t >= ph[k][0]) { t -= ph[k][0]; k++; }
      this.phase[i] = k; this.inPhase[i] = t;
    }
  }

  /** Код символа состояния ссылки светофора tls (индекс) / linkIndex. */
  linkCode(tls: number, link: number): number {
    const ph = this.net.tls[tls].phases, k = this.phase[tls];
    const c = ph[k][1].charCodeAt(link);
    if (c === CH_r && ph[k][0] - this.inPhase[tls] < 2) {
      const n = ph[(k + 1) % ph.length][1].charCodeAt(link);
      if (n === CH_G || n === CH_g) return CH_u;
    }
    return c;
  }

  /** Состояние соединения conn (символ SUMO) — для машин. Без светофора — состояние из net.xml. */
  connCode(conn: number): number {
    const tl = this.net.connTl[conn];
    return tl >= 0 ? this.linkCode(tl, this.net.connLink[conn]) : this.net.connState.charCodeAt(conn);
  }

  private junctionOf(j: string | number): number {
    return typeof j === 'number' ? j : (this.net.junctionIndex.get(j) ?? -1);
  }
  private edgeOf(e: string | number): number {
    return typeof e === 'number' ? e : (this.net.edgeIndex.get(e) ?? -1);
  }

  /** Символ состояния ссылки linkIndex светофора узла junctionId (id SUMO или индекс узла). '' — нет светофора. */
  getSignalState(junctionId: string | number, linkIndex: number): string {
    const j = this.junctionOf(junctionId);
    const tl = j >= 0 ? this.net.junctionTl[j] : this.net.tls.findIndex((t) => t.id === junctionId);
    if (tl < 0) return '';
    return String.fromCharCode(this.linkCode(tl, linkIndex));
  }

  /** Подходы регулируемого узла (пусто для нерегулируемого). */
  approaches(junction: string | number): Approach[] {
    const j = this.junctionOf(junction);
    return j >= 0 ? this.approachList[j] : [];
  }

  /** Цвет светофора подхода (ребро edge к узлу junction): 0 красный, 1 жёлтый, 2 зелёный, 3 красный+жёлтый, 4 мигает жёлтый. */
  getApproachColor(junction: string | number, edge: string | number): SignalColor | null {
    const ap = this.approachByKey.get(this.junctionOf(junction) * 65536 + this.edgeOf(edge));
    return ap ? this.approachColor(ap) : null;
  }

  approachColor(ap: Approach): SignalColor {
    // главный сигнал подхода — прямо (если есть), иначе «лучший» из направлений
    let best: SignalColor = 0;
    for (const c of ap.conns) {
      const s = this.connCode(c);
      const col: SignalColor = s === CH_G || s === CH_g ? 2 : s === CH_y ? 1 : s === CH_u ? 3 : s === CH_o || s === CH_O ? 4 : 0;
      if (this.net.connDir.charCodeAt(c) === CH_s) return col;
      if (col === 2 || (col !== 0 && best === 0)) best = col;
    }
    return best;
  }

  /**
   * Пешеходам можно переходить рукав узла (ребро edge — входящее или исходящее; парное ребро встречного направления
   * учитывается само): все соединения со входящего ребра рукава красные, прямые потоки в исходящее — тоже.
   * null — узел без светофора (пешеходы решают сами).
   */
  pedestrianWalk(junction: string | number, edge: string | number): boolean | null {
    const j = this.junctionOf(junction), e = this.edgeOf(edge);
    if (j < 0 || e < 0 || this.net.junctionTl[j] < 0) return null;
    const id = this.net.edges[e].id;
    const rev = this.net.edgeIndex.get(id.startsWith('-') ? id.slice(1) : '-' + id) ?? -1;
    for (const c of this.net.junctionConns[j]) {
      const fe = this.net.laneEdge[this.net.connFrom[c]], te = this.net.laneEdge[this.net.connTo[c]];
      const inArm = fe === e || fe === rev;
      const intoArm = (te === e || te === rev) && this.net.connDir.charCodeAt(c) === CH_s;
      if (!inArm && !intoArm) continue;
      const s = this.connCode(c);
      if (s !== CH_r && s !== CH_u) return false;
    }
    return true;
  }

  /** Подход, которому соответствует светофор-пропс (по положению и направлению), или null. */
  matchLight(x: number, z: number, rotY: number, maxDist = 30): Approach | null {
    const fx = -Math.sin(rotY), fz = -Math.cos(rotY); // лицо светофора (−Z модели) смотрит на подъезжающих
    let best: Approach | null = null, bestScore = Infinity;
    const near = this.net.lanesNear(x, z, maxDist);
    const seen = new Set<number>();
    for (const l of near) {
      const j = this.net.edges[this.net.laneEdge[l]].to;
      if (j < 0 || seen.has(j)) continue;
      seen.add(j);
      for (const ap of this.approachList[j]) {
        const d = Math.hypot(ap.x - x, ap.z - z);
        if (d > maxDist) continue;
        const align = -(fx * ap.dx + fz * ap.dz); // 1 — смотрит навстречу потоку
        if (align < 0.5) continue;
        const score = d + 12 * (1 - align);
        if (score < bestScore) { bestScore = score; best = ap; }
      }
    }
    return best;
  }

  /** Источник состояний для `city.props.setSignalSource`. */
  propSource(): (light: { x: number; z: number; rotY: number }) => SignalColor | null {
    return (light) => {
      let ap = this.lightMap.get(light);
      if (ap === undefined) {
        ap = this.matchLight(light.x, light.z, light.rotY);
        this.lightMap.set(light, ap);
      }
      return ap ? this.approachColor(ap) : null;
    };
  }
}

export const SIGNAL_CODES = { CH_G, CH_g, CH_y, CH_r, CH_u, CH_o, CH_O, CH_s };
