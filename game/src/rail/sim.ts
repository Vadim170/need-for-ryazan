import { RailNet, TrainPath, type PathStep, type RailCrossingJson } from './net';
import type { CarKind, CarModel } from './models';

/**
 * Симуляция поездов (docs/stage2/rail.md): кинематика по пути (TrainPath), огибающая скорости (ограничения
 * участков, станции 40 км/ч, кривые, длина поезда), остановки электричек у платформ, интервал до поезда впереди,
 * расписание по линиям «портал → портал» и маневровые рейсы на изолированных подъездных путях с переездами.
 * Переезды: закрываются за ~30 с до подхода; состояние читает отрисовка и трафик.
 */

export type TrainKind = 'suburban' | 'passenger' | 'freight' | 'shunter';

export interface TrainCar {
  model: CarModel;
  /** Кузов развёрнут (кабина назад). */
  flip: boolean;
  /** Центр вагона позади головы поезда, м по пути. */
  off: number;
  tint: number;
  /** Огни: 0 — нет, 1 — прожектор (голова), 2 — красные хвостовые. */
  lamp: 0 | 1 | 2;
}

export interface TrainStop { s: number; dwell: number; station: string }

export type RailEvent =
  | { type: 'horn'; train: number; x: number; y: number; z: number; reason: 'crossing' | 'player' | 'depart' }
  | { type: 'crossing'; crossing: number; closed: boolean }
  | { type: 'spawn' | 'despawn'; train: number; kind: TrainKind; line: string }
  | { type: 'crash'; train: number; speed: number }
  | { type: 'brake'; train: number };

const KMH = 1 / 3.6;
const STATION_LIMIT = 40 * KMH;
const CROSSING_LEAD = 30;      // с до подхода — переезд закрывается
const BARRIER_DELAY = 7;       // с от начала мигания до опускания шлагбаумов
const BARRIER_MOVE = 5;        // с на опускание/подъём

interface KindSpec { vmax: number; aMax: number; bServ: number; jerk: number }
const SPECS: Record<TrainKind, KindSpec> = {
  suburban: { vmax: 100 * KMH, aMax: 0.7, bServ: 0.6, jerk: 0.9 },
  passenger: { vmax: 110 * KMH, aMax: 0.35, bServ: 0.5, jerk: 0.5 },
  freight: { vmax: 80 * KMH, aMax: 0.18, bServ: 0.35, jerk: 0.35 },
  shunter: { vmax: 25 * KMH, aMax: 0.3, bServ: 0.4, jerk: 0.5 },
};

let nextTrainId = 1;

export class Train {
  readonly id = nextTrainId++;
  s = 0; sPrev = 0; v = 0; acc = 0;
  /** Длина состава, м. */
  length = 0;
  stops: TrainStop[] = [];
  nextStop = 0;
  dwell = 0;
  /** Переезды на пути: s центра, протрублено ли. */
  crossings: { id: number; s: number; horned: boolean }[] = [];
  env!: Float32Array;
  waitLeader = 0;
  hornCool = 0;
  done = false;
  /** Маневровый рейс: после остановки в тупике — разворот и обратно. */
  shuttleLegs = 0;
  /** Поезд впереди (s препятствия на своём пути), для отладки. */
  obstacleS = Infinity;
  braking = false;
  /** Число разворотов (маневровые). */
  reversals = 0;

  constructor(readonly kind: TrainKind, public path: TrainPath, public cars: TrainCar[], readonly line: string, readonly spec: KindSpec = SPECS[kind]) {
    this.layout();
  }

  layout(): void {
    let o = 0;
    for (const c of this.cars) { c.off = o + c.model.length / 2; o += c.model.length; }
    this.length = o;
  }

  get tailS(): number { return this.s - this.length; }
}

export interface RailSimHooks {
  /** Видна ли точка игроку (для появления/исчезновения вне кадра). */
  visible(x: number, y: number, z: number): boolean;
  player(): { x: number; y: number; z: number };
  models: Record<CarKind, CarModel>;
}

interface Line { name: string; from: string; to: string; path: TrainPath; stopsPath: TrainPath | null; timer: number; weight: Record<TrainKind, number> }
interface Shuttle { name: string; path: TrainPath; timer: number; crossings: number[]; ax: number; az: number }

export interface CrossingState {
  def: RailCrossingJson;
  /** Мигают огни (машины стоят). */
  active: boolean;
  /** 0 — шлагбаумы подняты, 1 — опущены. */
  barrier: number;
  activeT: number;
  /** ближайший поезд: с до подхода (для отладки). */
  eta: number;
}

export class RailSim {
  readonly trains: Train[] = [];
  readonly lines: Line[] = [];
  readonly shuttles: Shuttle[] = [];
  readonly crossings: CrossingState[];
  readonly events: RailEvent[] = [];
  readonly stats = { spawned: 0, despawned: 0, stops: 0, horns: 0, deadlocks: 0, stepMs: 0 };
  /** Множитель частоты поездов (1 — расписание по умолчанию: на линию 2–4 поезда за 10 мин). */
  frequency = 1;
  /** Автоматическое расписание (выключить — поезда только вручную через spawn). */
  autoSchedule = true;
  time = 0;
  private rnd: () => number;
  private tmp = new Float32Array(6);
  private obsAcc = 0;
  private hornAcc = 0;
  private stopsBySeg = new Map<number, { station: string; s0: number; s1: number }[]>();
  private crossingsBySeg = new Map<number, { id: number; s: number }[]>();

  constructor(readonly net: RailNet, private hooks: RailSimHooks) {
    let seed = 987654321;
    this.rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (const st of net.json.stops) (this.stopsBySeg.get(st.segment) ?? this.stopsBySeg.set(st.segment, []).get(st.segment)!).push({ station: st.station, s0: st.s0, s1: st.s1 });
    this.crossings = net.json.crossings.map((c) => ({ def: c, active: false, barrier: 0, activeT: 0, eta: Infinity }));
    for (const c of net.json.crossings) for (const t of c.tracks) (this.crossingsBySeg.get(t.segment) ?? this.crossingsBySeg.set(t.segment, []).get(t.segment)!).push({ id: c.id, s: t.s });
    this.buildLines();
    this.buildShuttles();
  }

  // ------------------------------------------------------------------ линии
  private buildLines(): void {
    const net = this.net, J = net.json;
    // группы порталов на главных путях (концы, ближе 150 м — одно направление)
    const portals = J.nodes.filter((n) => n.kind === 'portal');
    const segOfNode = new Map<number, { seg: number; end: number }>();
    net.segs.forEach((s) => { segOfNode.set(s.from, { seg: s.id, end: 0 }); segOfNode.set(s.to, { seg: s.id, end: 1 }); });
    const mainPortals = portals.filter((p) => { const e = segOfNode.get(p.id); return e && (net.segs[e.seg].usage === 'main' || net.segs[e.seg].usage === 'branch'); });
    const groups: { name: string; nodes: number[]; x: number; z: number }[] = [];
    for (const p of mainPortals) {
      const g = groups.find((q) => Math.hypot(q.x - p.x, q.z - p.z) < 150);
      if (g) g.nodes.push(p.id);
      else groups.push({ name: '', nodes: [p.id], x: p.x, z: p.z });
    }
    for (const g of groups) {
      const o = J.nodes[g.nodes[0]].out ?? [0, 0];
      const ang = Math.atan2(o[0], -o[1]) * 180 / Math.PI;   // 0 — север, по часовой
      const dirs = ['север', 'северо-восток', 'восток', 'юго-восток', 'юг', 'юго-запад', 'запад', 'северо-запад'];
      g.name = dirs[Math.round(((ang + 360) % 360) / 45) % 8];
      // рядом со станцией вне мира — её имя (Рязань-2)
      for (const st of J.stations) if (!st.inWorld && Math.hypot(st.x - g.x, st.z - g.z) < 900) g.name = st.name;
    }
    const names = new Set<string>();
    for (const g of groups) { let n = g.name, k = 2; while (names.has(n)) n = `${g.name}-${k++}`; g.name = n; names.add(n); }
    for (const A of groups) for (const B of groups) {
      if (A === B) continue;
      const starts: PathStep[] = A.nodes.map((n) => { const e = segOfNode.get(n)!; return { seg: e.seg, dir: e.end === 0 ? 1 : -1 } as PathStep; });
      const goalNodes = new Set(B.nodes);
      const r = net.route(starts, (st) => goalNodes.has(st.dir > 0 ? net.segs[st.seg].to : net.segs[st.seg].from));
      if (!r) continue;
      const straight = Math.hypot(A.x - B.x, A.z - B.z);
      const len = r.path.reduce((a, st) => a + net.segs[st.seg].len, 0);
      if (len > straight * 2.2 + 1500) continue;
      const path = new TrainPath(net, r.path);
      const viaPath = this.routeViaStations(r.path, starts, goalNodes);
      const isRz2 = A.name.startsWith('Рязань') || B.name.startsWith('Рязань');
      this.lines.push({ name: `${A.name} → ${B.name}`, from: A.name, to: B.name, path, stopsPath: viaPath, timer: 20 + this.rnd() * 120,
        weight: { suburban: 0.45, passenger: isRz2 ? 0.3 : 0.2, freight: isRz2 ? 0.25 : 0.35, shunter: 0 } });
    }
  }

  /** Путь электрички: для каждой станции, мимо которой идёт линия, — через путь у платформы. */
  private routeViaStations(base: PathStep[], starts: PathStep[], goalNodes: Set<number>): TrainPath | null {
    const net = this.net, J = net.json;
    const onPath = new Set(base.map((s) => s.seg));
    const stations = new Map<string, number[]>();
    for (const st of J.stops) (stations.get(st.station) ?? stations.set(st.station, []).get(st.station)!).push(st.segment);
    let steps = base;
    const pts: [number, number][] = [];
    for (const st of base) { const S = net.segs[st.seg]; for (let i = 0; i < S.pts.length; i += 9) pts.push([S.pts[i], S.pts[i + 2]]); }
    for (const [, segs] of stations) {
      if (segs.some((s) => onPath.has(s))) continue;
      // станция рядом с линией?
      const near = segs.some((sg) => { const S = net.segs[sg]; const x = S.pts[Math.floor(S.pts.length / 6) * 3], z = S.pts[Math.floor(S.pts.length / 6) * 3 + 2]; return pts.some(([px, pz]) => Math.hypot(px - x, pz - z) < 60); });
      if (!near) continue;
      let best: PathStep[] | null = null, bestC = Infinity;
      for (const via of new Set(segs)) {
        const a = net.route(starts, (st) => st.seg === via);
        if (!a) continue;
        const last = a.path[a.path.length - 1];
        const b = net.route([last], (st) => goalNodes.has(st.dir > 0 ? net.segs[st.seg].to : net.segs[st.seg].from));
        if (!b) continue;
        const c = a.cost + b.cost;
        if (c < bestC) { bestC = c; best = [...a.path, ...b.path.slice(1)]; }
      }
      if (best) { steps = best; best.forEach((s) => onPath.add(s.seg)); }
    }
    return steps === base ? null : new TrainPath(net, steps);
  }

  /** Маневровые рейсы: изолированные (или подъездные) пути с охраняемыми переездами на автодорогах. */
  private buildShuttles(): void {
    const net = this.net, J = net.json;
    const linePaths = new Set<number>();
    for (const l of this.lines) { l.path.steps.forEach((s) => linePaths.add(s.seg)); l.stopsPath?.steps.forEach((s) => linePaths.add(s.seg)); }
    const ends = J.nodes.filter((n) => n.kind === 'end');
    const segOfNode = new Map<number, { seg: number; end: number }>();
    net.segs.forEach((s) => { if (J.nodes[s.from].kind === 'end') segOfNode.set(s.from, { seg: s.id, end: 0 }); if (J.nodes[s.to].kind === 'end') segOfNode.set(s.to, { seg: s.id, end: 1 }); });
    const done = new Set<number>();
    for (const c of J.crossings) {
      if (!c.barrier || done.has(c.id)) continue;
      if (c.tracks.some((t) => linePaths.has(t.segment))) continue;
      const seg = c.tracks[0].segment;
      // лучшая пара тупиков, путь между которыми проходит переезд
      let best: { path: PathStep[]; len: number } | null = null;
      for (const a of ends) {
        const ea = segOfNode.get(a.id);
        if (!ea) continue;
        const start: PathStep = { seg: ea.seg, dir: ea.end === 0 ? 1 : -1 };
        for (const b of ends) {
          if (b.id === a.id) continue;
          const r = net.route([start], (st) => (st.dir > 0 ? net.segs[st.seg].to : net.segs[st.seg].from) === b.id);
          if (!r || !r.path.some((s) => s.seg === seg)) continue;
          const len = r.path.reduce((q, s) => q + net.segs[s.seg].len, 0);
          if (len < 250) continue;
          if (!best || len > best.len) best = { path: r.path, len };
        }
      }
      if (!best) continue;
      const path = new TrainPath(net, best.path, 0);
      const ids = J.crossings.filter((q) => q.tracks.some((t) => best!.path.some((s) => s.seg === t.segment))).map((q) => q.id);
      ids.forEach((i) => done.add(i));
      this.tmp.fill(0); path.at(0, this.tmp);
      this.shuttles.push({ name: `манёвры: ${c.roadName || c.highway} (${ids.length} пер.)`, path, timer: 10 + this.rnd() * 40, crossings: ids, ax: this.tmp[0], az: this.tmp[2] });
    }
  }

  // ------------------------------------------------------------------ составы
  private consist(kind: TrainKind, nCars?: number): TrainCar[] {
    const M = this.hooks.models, r = this.rnd;
    const car = (k: CarKind, flip = false, tint = 0xffffff, lamp: 0 | 1 | 2 = 0): TrainCar => ({ model: M[k], flip, off: 0, tint, lamp });
    const out: TrainCar[] = [];
    if (kind === 'suburban') {
      const n = nCars ?? 4 + Math.floor(r() * 7);            // 4–10 вагонов
      const tint = r() < 0.6 ? 0xc8142a : 0x1f5aa6;           // красно-серая / сине-белая ливрея
      out.push(car('emu_head', false, tint, 1));
      for (let i = 1; i < n - 1; i++) out.push(car(i % 2 ? 'emu_motor' : 'emu_trailer', r() < 0.5, tint));
      out.push(car('emu_head', true, tint, 2));
    } else if (kind === 'passenger') {
      const n = nCars ?? 10 + Math.floor(r() * 6);           // 10–15 вагонов
      out.push(car('loco_pass', false, 0xffffff, 1));
      for (let i = 0; i < n; i++) out.push(car('coach', r() < 0.5, 0xb0141c, 0));
      out[out.length - 1].flip = false;
      out[out.length - 1].lamp = 2;
    } else if (kind === 'freight') {
      const n = nCars ?? 30 + Math.floor(r() * 31);          // 30–60 вагонов
      out.push(car('loco_freight', false, 0xffffff, 1), car('loco_freight', true));
      const TANK = [0x1d1e20, 0x2a2c2e, 0x8c8f92, 0x5d4a3a], GOND = [0x6b3a22, 0x7a4528, 0x55402f, 0x4c5157], BOX = [0x5b2c20, 0x6e3b26, 0x3d4a52, 0x4a5a3c];
      let i = 0;
      while (i < n) {
        const t = r(), blk = 3 + Math.floor(r() * 12);
        const k: CarKind = t < 0.35 ? 'tank' : t < 0.7 ? 'gondola' : 'boxcar';
        const pal = k === 'tank' ? TANK : k === 'gondola' ? GOND : BOX;
        const base = pal[Math.floor(r() * pal.length)];
        for (let j = 0; j < blk && i < n; j++, i++) out.push(car(k, r() < 0.5, r() < 0.8 ? base : pal[Math.floor(r() * pal.length)]));
      }
    } else {
      const n = nCars ?? 3 + Math.floor(r() * 6);
      out.push(car('loco_freight', false, 0xffffff, 1));
      for (let i = 0; i < n; i++) { const k: CarKind = r() < 0.5 ? 'boxcar' : r() < 0.5 ? 'tank' : 'gondola'; out.push(car(k, r() < 0.5, [0x5b2c20, 0x1d1e20, 0x6b3a22][Math.floor(r() * 3)])); }
      out[out.length - 1].lamp = 2;
    }
    return out;
  }

  /** Огибающая скорости по точкам пути (без остановок): ограничения, станции, кривые, длина поезда, торможение. */
  private envelope(t: Train): void {
    const P = t.path, n = P.cum.length, net = this.net, spec = t.spec;
    const lim = new Float32Array(n);
    // зоны станций (40 км/ч) — по записям stops на шагах пути, ±250 м
    const zones: [number, number][] = [];
    P.steps.forEach((st, k) => {
      for (const sp of this.stopsBySeg.get(st.seg) ?? []) {
        const L = net.segs[st.seg].len;
        const a = P.stepS[k] + (st.dir > 0 ? sp.s0 : L - sp.s1), b = P.stepS[k] + (st.dir > 0 ? sp.s1 : L - sp.s0);
        zones.push([a - 250, b + 250]);
      }
    });
    const tmp = this.tmp, p = P.pts;
    for (let i = 0; i < n; i++) {
      let v = spec.vmax;
      const k = P.stepOf[i];
      if (k >= 0) {
        const S = net.segs[P.steps[k].seg];
        if (S.maxspeed) v = Math.min(v, S.maxspeed * KMH);
        if (S.service === 'siding' || S.service === 'crossover') v = Math.min(v, 40 * KMH);
        else if (S.service === 'spur' || S.service === 'yard') v = Math.min(v, 25 * KMH);
      }
      const s = P.cum[i];
      for (const [a, b] of zones) if (s >= a && s <= b) { v = Math.min(v, STATION_LIMIT); break; }
      // кривая: радиус по точкам ±15 м
      let i0 = i, i1 = i;
      while (i0 > 0 && s - P.cum[i0] < 15) i0--;
      while (i1 < n - 1 && P.cum[i1] - s < 15) i1++;
      if (i1 - i0 >= 2) {
        const ax = p[i * 3] - p[i0 * 3], az = p[i * 3 + 2] - p[i0 * 3 + 2], bx = p[i1 * 3] - p[i * 3], bz = p[i1 * 3 + 2] - p[i * 3 + 2];
        const ang = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
        if (ang > 1e-4) v = Math.min(v, Math.sqrt(0.6 * (P.cum[i1] - P.cum[i0]) / ang));
      }
      lim[i] = Math.max(v, 4 * KMH);
    }
    void tmp;
    // голова не разгоняется, пока хвост на ограничении: минимум по окну [s − длина, s]
    const win = new Float32Array(n);
    const dq: number[] = [];
    let h = 0;
    for (let i = 0; i < n; i++) {
      while (dq.length > h && lim[dq[dq.length - 1]] >= lim[i]) dq.pop();
      dq.push(i);
      while (P.cum[i] - P.cum[dq[h]] > t.length) h++;
      win[i] = lim[dq[h]];
    }
    // торможение заранее
    const b = spec.bServ;
    for (let i = n - 2; i >= 0; i--) win[i] = Math.min(win[i], Math.sqrt(win[i + 1] * win[i + 1] + 2 * b * (P.cum[i + 1] - P.cum[i])));
    t.env = win;
  }

  private envAt(t: Train, s: number): number {
    const c = t.path.cum, n = c.length;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
    const f = Math.min(Math.max((s - c[lo]) / ((c[hi] - c[lo]) || 1), 0), 1);
    return t.env[lo] + (t.env[hi] - t.env[lo]) * f;
  }

  /** Остановки электрички: по станции — одна (через все записи stops на пути), голова у дальнего конца платформы. */
  private planStops(t: Train): void {
    const P = t.path, net = this.net, by = new Map<string, [number, number]>();
    P.steps.forEach((st, k) => {
      for (const sp of this.stopsBySeg.get(st.seg) ?? []) {
        const L = net.segs[st.seg].len;
        const a = P.stepS[k] + (st.dir > 0 ? sp.s0 : L - sp.s1), b = P.stepS[k] + (st.dir > 0 ? sp.s1 : L - sp.s0);
        const q = by.get(sp.station);
        by.set(sp.station, q ? [Math.min(q[0], a), Math.max(q[1], b)] : [a, b]);
      }
    });
    t.stops = [...by.entries()].map(([station, [a, b]]) => {
      const s = t.length <= b - a - 16 ? b - 8 : (a + b) / 2 + t.length / 2;
      return { s, dwell: 30 + this.rnd() * 30, station };
    }).filter((x) => x.s > t.length + 20).sort((x, y) => x.s - y.s);
  }

  private planCrossings(t: Train): void {
    t.crossings = [];
    t.path.steps.forEach((st, k) => {
      for (const c of this.crossingsBySeg.get(st.seg) ?? []) {
        const L = this.net.segs[st.seg].len;
        const s = t.path.stepS[k] + (st.dir > 0 ? c.s : L - c.s);
        if (!t.crossings.some((q) => q.id === c.id)) t.crossings.push({ id: c.id, s, horned: false });
      }
    });
  }

  /** Создать поезд на пути: голова в s (по умолчанию — весь состав в продлении за порталом). */
  spawnOnPath(kind: TrainKind, path: TrainPath, line: string, opts: { s?: number; v?: number; cars?: number; stops?: boolean } = {}): Train {
    const t = new Train(kind, path, this.consist(kind, opts.cars), line);
    t.s = t.sPrev = opts.s ?? Math.min(path.ext - 5, path.length * 0.5);
    if (path.ext === 0 && opts.s === undefined) t.s = t.sPrev = t.length + 5;
    t.v = opts.v ?? 0;
    if (kind === 'suburban' && opts.stops !== false) this.planStops(t);
    this.planCrossings(t);
    this.envelope(t);
    t.v = Math.min(opts.v ?? t.spec.vmax * 0.8, this.envAt(t, t.s));
    while (t.nextStop < t.stops.length && t.stops[t.nextStop].s < t.s) t.nextStop++;
    this.trains.push(t);
    this.stats.spawned++;
    this.events.push({ type: 'spawn', train: t.id, kind, line });
    return t;
  }

  /** Поезд по линии (расписание). */
  spawnLine(line: Line, kind: TrainKind, opts: { s?: number; v?: number; cars?: number } = {}): Train {
    const path = kind === 'suburban' && line.stopsPath ? line.stopsPath : line.path;
    return this.spawnOnPath(kind, path, line.name, opts);
  }

  private pickKind(w: Record<TrainKind, number>): TrainKind {
    const tot = w.suburban + w.passenger + w.freight;
    let x = this.rnd() * tot;
    for (const k of ['suburban', 'passenger', 'freight'] as TrainKind[]) { x -= w[k]; if (x <= 0) return k; }
    return 'suburban';
  }

  /** Свободен ли начальный участок пути (никого ближе 1.5 км по ходу от точки появления). */
  private entryFree(path: TrainPath, sFrom: number, sTo: number): boolean {
    const P = this.tmp, pts: number[] = [];
    for (let s = sFrom; s <= sTo; s += 10) { path.at(s, P); pts.push(P[0], P[2]); }
    for (const t of this.trains) {
      for (let sv = t.tailS; sv <= t.s + 1; sv += 15) {
        t.path.at(Math.max(Math.min(sv, t.s), 0), P);
        for (let i = 0; i < pts.length; i += 2) if (Math.abs(pts[i] - P[0]) < 9 && Math.abs(pts[i + 1] - P[2]) < 9 && Math.hypot(pts[i] - P[0], pts[i + 1] - P[2]) < 8) return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------------ шаг
  step(dt: number): void {
    const t0 = performance.now();
    this.time += dt;
    if (this.autoSchedule) this.schedule(dt);
    this.obsAcc += dt;
    if (this.obsAcc > 0.25) { this.obsAcc = 0; this.leaders(); }
    this.hornAcc += dt;
    const checkPlayer = this.hornAcc > 0.5;
    if (checkPlayer) this.hornAcc = 0;
    const pl = this.hooks.player();
    for (const t of this.trains) this.move(t, dt, checkPlayer ? pl : null);
    // удалить ушедшие
    for (let i = this.trains.length - 1; i >= 0; i--) {
      const t = this.trains[i];
      if (t.done) { this.trains.splice(i, 1); this.stats.despawned++; this.events.push({ type: 'despawn', train: t.id, kind: t.kind, line: t.line }); }
    }
    this.updateCrossings(dt);
    this.stats.stepMs = performance.now() - t0;
  }

  private schedule(dt: number): void {
    const f = this.frequency;
    for (const L of this.lines) {
      L.timer -= dt * f;
      if (L.timer > 0) continue;
      const kind = this.pickKind(L.weight);
      const path = kind === 'suburban' && L.stopsPath ? L.stopsPath : L.path;
      // голова — в продлении за порталом; ждём, пока впереди свободно
      if (!this.entryFree(path, path.ext - 400, path.ext + 1200) || this.opposing(path)) { L.timer = 15; continue; }
      this.spawnLine(L, kind);
      L.timer = 100 + this.rnd() * 140;   // 2–4 поезда за 10 мин на направление (минус ожидание встречных)
    }
    const pl = this.hooks.player();
    for (const S of this.shuttles) {
      S.timer -= dt * f;
      if (S.timer > 0) continue;
      if (this.trains.some((t) => t.line === S.name) || this.opposing(S.path)) { S.timer = 30; continue; }
      // только рядом с игроком и вне кадра
      if (Math.hypot(S.ax - pl.x, S.az - pl.z) > 2500) { S.timer = 20; continue; }
      this.tmp.fill(0); S.path.at(20, this.tmp);
      if (this.hooks.visible(this.tmp[0], this.tmp[1] + 2, this.tmp[2]) && Math.hypot(this.tmp[0] - pl.x, this.tmp[2] - pl.z) < 400) { S.timer = 5; continue; }
      const t = this.spawnOnPath('shunter', S.path, S.name);
      t.shuttleLegs = 2;
      t.stops = [{ s: S.path.length - 12, dwell: 40 + this.rnd() * 30, station: 'тупик' }];
      t.nextStop = 0;
      S.timer = 120 + this.rnd() * 120;
    }
  }

  /** Препятствия на своём пути: другие поезда (любое направление) ближе 3 м к оси впереди. */
  private leaders(): void {
    const P = this.tmp;
    const samples = this.trains.map((t) => {
      const pts: number[] = [];
      for (let s = t.tailS; s <= t.s + 0.1; s += Math.max(t.length / 12, 15)) { t.path.at(Math.max(s, 0), P); pts.push(P[0], P[2]); }
      t.path.at(t.s, P); pts.push(P[0], P[2]);
      return pts;
    });
    const by: number[] = [];
    for (let a = 0; a < this.trains.length; a++) {
      const t = this.trains[a];
      t.obstacleS = Infinity;
      by[a] = -1;
      const look = Math.max(400, (t.v * t.v) / (2 * t.spec.bServ) + 250);
      for (let b = 0; b < this.trains.length; b++) {
        if (a === b) continue;
        const pts = samples[b];
        // быстрый отсев по расстоянию до головы
        t.path.at(t.s, P);
        let near = false;
        for (let i = 0; i < pts.length; i += 2) if (Math.hypot(pts[i] - P[0], pts[i + 1] - P[2]) < look + 50) { near = true; break; }
        if (!near) continue;
        for (let s = t.s + 2; s < t.s + look; s += 8) {
          t.path.at(s, P);
          let hit = false;
          for (let i = 0; i < pts.length; i += 2) if (Math.abs(pts[i] - P[0]) < 8 && Math.abs(pts[i + 1] - P[2]) < 8 && Math.hypot(pts[i] - P[0], pts[i + 1] - P[2]) < 3.0) { hit = true; break; }
          if (hit) { if (s < t.obstacleS) { t.obstacleS = s; by[a] = b; } break; }
        }
      }
    }
    // взаимная блокировка на слиянии путей: каждый видит другого впереди — едет тот, кто ближе к месту встречи
    for (let a = 0; a < this.trains.length; a++) {
      const b = by[a];
      if (b < 0 || by[b] !== a || b < a) continue;
      const A = this.trains[a], B = this.trains[b];
      if (A.obstacleS - A.s <= B.obstacleS - B.s) A.obstacleS = Infinity; else B.obstacleS = Infinity;
    }
  }

  /** Встречный по тем же путям: у кого-то из поездов впереди (от хвоста) есть сегмент нового пути в обратном направлении. */
  private opposing(path: TrainPath): boolean {
    const mine = new Map<number, number>();
    for (const st of path.steps) mine.set(st.seg, st.dir);
    for (const t of this.trains) {
      const tail = t.tailS;
      for (let k = 0; k < t.path.steps.length; k++) {
        const st = t.path.steps[k];
        if (t.path.stepS[k] + this.net.segs[st.seg].len < tail) continue;
        const d = mine.get(st.seg);
        if (d !== undefined && d !== st.dir) return true;
      }
    }
    return false;
  }

  private move(t: Train, dt: number, pl: { x: number; y: number; z: number } | null): void {
    t.sPrev = t.s;
    const spec = t.spec;
    t.hornCool -= dt;
    if (t.dwell > 0) {
      t.dwell -= dt;
      t.v = 0; t.acc = 0;
      if (t.dwell <= 0) {
        t.nextStop++;
        if (t.shuttleLegs > 0 && t.nextStop >= t.stops.length) { this.reverse(t); return; }
        this.horn(t, 'depart');
      }
      return;
    }
    let vT = this.envAt(t, t.s);
    const st = t.stops[t.nextStop];
    if (st) vT = Math.min(vT, Math.sqrt(2 * spec.bServ * Math.max(st.s - t.s - 0.3, 0)));
    if (t.obstacleS < Infinity) {
      vT = Math.min(vT, Math.sqrt(2 * spec.bServ * Math.max(t.obstacleS - t.s - 60, 0)));
      if (t.v < 0.1 && t.obstacleS - t.s < 90) t.waitLeader += dt; else t.waitLeader = 0;
    } else t.waitLeader = 0;
    const want = Math.min(Math.max((vT - t.v) * 1.2, -spec.bServ * 2.2), spec.aMax);
    const j = spec.jerk * dt;   // плавность: рывок ограничен, тормоз нарастает быстрее тяги
    t.acc = want > t.acc ? Math.min(want, t.acc + j) : Math.max(want, t.acc - j * 3);
    t.v = Math.max(0, t.v + t.acc * dt);
    if (t.v === 0 && t.acc < 0) t.acc = 0;
    const wasBraking = t.braking;
    t.braking = t.acc < -0.15;
    if (t.braking && !wasBraking && t.v > 5) this.events.push({ type: 'brake', train: t.id });
    t.s += t.v * dt;
    // остановка
    if (st && st.s - t.s < 0.6 && t.v < 0.6) {
      t.s = Math.min(t.s, st.s); t.v = 0; t.acc = 0; t.dwell = st.dwell;
      this.stats.stops++;
    }
    // гудки: переезды
    for (const c of t.crossings) {
      if (!c.horned && c.s > t.s && c.s - t.s < 350 && t.v > 3) { c.horned = true; this.horn(t, 'crossing'); }
    }
    // игрок у пути впереди
    if (pl && t.hornCool <= 0 && t.v > 3) {
      const P = this.tmp;
      t.path.at(t.s, P);
      if (Math.hypot(P[0] - pl.x, P[2] - pl.z) < 350) {
        for (let s = t.s + 15; s < t.s + 260; s += 10) {
          t.path.at(s, P);
          if (Math.hypot(P[0] - pl.x, P[2] - pl.z) < 9 && Math.abs(P[1] - pl.y) < 4) { this.horn(t, 'player'); break; }
        }
      }
    }
    // конец пути
    if (t.s >= t.path.length - 1) {
      if (t.path.ext > 0) t.done = true;
      else { t.s = t.path.length - 1; t.v = 0; }
    }
    // взаимная блокировка: долго стоим перед встречным — убрать того, кто дальше от игрока и не виден
    if (t.waitLeader > 90) {
      t.waitLeader = 0;
      this.stats.deadlocks++;
      const P = this.tmp; t.path.at(t.s, P);
      if (!this.hooks.visible(P[0], P[1] + 2, P[2])) t.done = true;
    }
  }

  horn(t: Train, reason: 'crossing' | 'player' | 'depart'): void {
    if (t.hornCool > 0 && reason !== 'crossing') return;
    t.hornCool = 12;
    const P = this.tmp;
    t.path.at(t.s, P);
    this.events.push({ type: 'horn', train: t.id, x: P[0], y: P[1] + 4, z: P[2], reason });
    this.stats.horns++;
  }

  /** Маневровый: разворот в тупике — путь обратный, голова = бывший хвост, вагоны в обратном порядке. */
  private reverse(t: Train): void {
    const old = t.path;
    const steps = old.steps.slice().reverse().map((s) => ({ seg: s.seg, dir: (s.dir > 0 ? -1 : 1) as 1 | -1 }));
    const np = new TrainPath(this.net, steps, old.ext);
    const tail = t.tailS;
    t.path = np;
    t.cars.reverse();
    for (const c of t.cars) { c.flip = !c.flip; c.lamp = 0; }
    t.cars[0].lamp = 1; t.cars[t.cars.length - 1].lamp = 2;
    t.layout();
    t.s = t.sPrev = np.length - tail;
    t.v = 0; t.acc = 0;
    t.shuttleLegs--;
    t.reversals++;
    this.planCrossings(t);
    this.envelope(t);
    t.stops = t.shuttleLegs > 0 ? [{ s: np.length - 12, dwell: 30, station: 'тупик' }] : [{ s: np.length - 12, dwell: 1e9, station: 'отстой' }];
    t.nextStop = 0;
    if (t.shuttleLegs === 0) t.shuttleLegs = -1;   // приехал обратно: стоит до исчезновения вне кадра
    this.horn(t, 'depart');
  }

  private updateCrossings(dt: number): void {
    const est = new Map<number, number>();
    for (const t of this.trains) {
      for (const c of t.crossings) {
        const tail = t.tailS;
        let eta: number;
        if (c.s >= tail - 4 && c.s <= t.s + 3) eta = 0;
        else if (c.s > t.s) {
          const d = c.s - t.s;
          eta = t.v > 0.5 ? d / Math.max(t.v, 1) : (d < 80 ? 0 : 1e9);
          if (t.dwell > 0 && d < 150) eta = Math.min(eta, t.dwell + 12);
        } else continue;
        est.set(c.id, Math.min(est.get(c.id) ?? 1e9, eta));
      }
    }
    // отстой маневрового в конце пути: убрать, когда не виден
    for (const t of this.trains) {
      if (t.shuttleLegs === -1 && t.dwell > 0) {
        const P = this.tmp; t.path.at(t.s - t.length / 2, P);
        if (!this.hooks.visible(P[0], P[1] + 2, P[2])) t.done = true;
      }
    }
    for (const c of this.crossings) {
      if (!c.def.barrier && !c.def.lights) continue;
      const eta = est.get(c.def.id) ?? Infinity;
      c.eta = eta;
      const want = eta < CROSSING_LEAD;
      if (want !== c.active) {
        c.active = want;
        c.activeT = 0;
        this.events.push({ type: 'crossing', crossing: c.def.id, closed: want });
      }
      c.activeT += dt;
      if (c.def.barrier) {
        if (c.active) c.barrier = c.activeT > BARRIER_DELAY ? Math.min(1, c.barrier + dt / BARRIER_MOVE) : c.barrier;
        else c.barrier = Math.max(0, c.barrier - dt / BARRIER_MOVE);
      }
    }
  }

  /** Мигают ли огни переезда (активен или шлагбаум ещё не поднят). */
  flashing(c: CrossingState): boolean { return c.active || c.barrier > 0.01; }
}
