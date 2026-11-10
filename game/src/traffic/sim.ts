import { CLS_BUS, CLS_CAR, type TrafficNet } from './net';
import { SIGNAL_CODES, type SignalController } from './signals';
import type { VehicleKind, VehicleModel } from './models';

/**
 * Симуляция трафика по графу полос (src/traffic/net.ts):
 * - машина — точка «перед» на сегменте (полоса или соединение через перекрёсток) + длина; путь — очередь сегментов впереди;
 * - продольное движение — IDM (лидер на полосе и на пути впереди, стоп-линии, ограничения скорости, игрок/аварии);
 * - перекрёстки: светофоры (signals.ts), без светофора — приоритеты SUMO (response/foes) с принятием интервала;
 * - перестроения: стратегические (нужная полоса для поворота/остановки) и MOBIL-lite (обгон медленного лидера);
 * - выбор маршрута — случайные повороты с весом по классу дороги; автобусы/троллейбусы/маршрутки — по маршрутам OSM;
 * - спавн/удаление в кольце вокруг игрока, плотность по классу дороги × densityFactor.
 */

const { CH_G, CH_g, CH_y, CH_r, CH_u, CH_o, CH_O } = SIGNAL_CODES;
const CH_M = 77, CH_m = 109, CH_eq = 61, CH_s_ = 115, CH_w = 119;

/** Минимальный рывок: 0 → 1 при u 0 → 1. */
const minJerk = (u: number) => u * u * u * (10 - 15 * u + 6 * u * u);

export interface SimOptions {
  maxVehicles: number;
  maxBuses: number;
  spawnMin: number;     // м, ближе — не спавнить (кроме первой заливки)
  spawnMax: number;     // м, радиус кольца
  despawn: number;      // м
  /** Высота поверхности (рельеф) — для крена кузова по поперечному уклону дороги. */
  heightAt?: (x: number, z: number) => number;
}

/** Плотность, машин на км полосы при densityFactor = 1. */
const DENSITY: Record<string, number> = {
  primary: 15, secondary: 12, tertiary: 8, unclassified: 4, residential: 2.5, living_street: 0.8, service: 0.3,
  primary_link: 6, secondary_link: 6, tertiary_link: 4,
};
/** Ограничение скорости по классу, м/с (город 40–60 км/ч). */
const CAP: Record<string, number> = {
  primary: 60 / 3.6, secondary: 60 / 3.6, tertiary: 50 / 3.6, unclassified: 40 / 3.6, residential: 40 / 3.6,
  living_street: 20 / 3.6, service: 20 / 3.6, primary_link: 45 / 3.6, secondary_link: 45 / 3.6, tertiary_link: 40 / 3.6,
};
const DIR_W: Record<string, number> = { s: 3, r: 1.2, l: 1, R: 0.6, L: 0.6, t: 0.02 };

const CAR_MIX: [VehicleKind, number][] = [['sedan', 33], ['hatch', 20], ['wagon', 12], ['suv', 20], ['taxi', 5], ['police', 2], ['gazelle', 8]];
// Рязань (панорамы): белый/серебро/серый/чёрный ≈ 70%, остальное — синий, красный, вишня, зелёный, бежевый, коричневый
const PALETTE: [number, number][] = [
  [0xe9e9e6, 23], [0xb5b8bb, 16], [0x1b1c1e, 14], [0x6b6f73, 12], [0x23365c, 5], [0x8e1a1a, 5], [0x5a1222, 4],
  [0x2f4d32, 3], [0xc9b994, 3], [0x3b2a40, 2], [0x7a8fa8, 4], [0xd8d0b8, 3], [0x9a5a18, 2], [0x14385a, 3],
];

let nextId = 1;

export class SimVehicle {
  readonly id = nextId++;
  kind: VehicleKind;
  len: number; halfW: number;
  color = 0xffffff;
  seg = -1; s = 0; v = 0; acc = 0;
  /** Сегменты впереди (соединение, полоса, соединение…). */
  path: number[] = [];
  /** Рёбра после текущего (намерение). */
  plan: number[] = [];
  /** Ребро текущей полосы (на соединении — ребро, куда оно ведёт). */
  edge = -1;
  prev: number[] = [];
  /** Соединения, на которые решено въехать (не пересматривается на жёлтый). */
  commits: number[] = [];
  /** Путь обрывается не из-за горизонта (нужна смена полосы или тупик). */
  pathOpen = true;
  /** Зазор до ближайшего препятствия впереди (лидер, стоп-линия, игрок), м. */
  gap = 1e9;
  /** Зазор до внешнего препятствия (игрок, авария) на своей полосе, м. */
  obsGap = 1e9;
  // параметры водителя
  vf = 1; T = 1.4; aMax = 1.8; b = 2.6; s0 = 2.2;
  wait = 0; stuck = 0;
  /** Боковое смещение у переднего бампера от оси полосы (м, + вправо) — для проверок; сама кривая — lcFrom/lcStart/lcLen. */
  lcOff = 0; lcCool = 0; lcTimer = 0;
  /** Смена полосы — S-кривая минимального рывка по пройденному пути: смещение lcFrom → 0 на участке [lcStart, lcStart+lcLen] одометра. */
  lcFrom = 0; lcStart = 0; lcLen = 1;
  /** Отложенная смена полосы (поворотник заранее): целевая полоса и сколько ещё мигать до начала. */
  lcPending = -1; lcDelay = 0;
  /** Полоса, из которой идёт перестроение (пока кузов в ней — смотрим и на её лидера). */
  lcOld = -1;
  /** Одометр (м) — по переднему бамперу. */
  odo = 0;
  /** Применённое ускорение (с ограничением рывка), м/с²; aUp/aDn — пределы рывка, emerg — экстренное торможение. */
  aCur = 0; jUp = 3; emerg = 7; aLat = 2.6;
  // геометрия (из модели): база, оси, колея
  wb = 2.6; dFront = 0.9; zr = 1.3; track = 1.45;
  // ориентация кузова: руление передних колёс, крен дороги, динамические тангаж/крен (пружина)
  steer = 0; rollRoad = 0; pitchDyn = 0; pitchVel = 0; rollDyn = 0; rollVel = 0; curvK = 0;
  near = false;
  /** Задняя ось (трактриса). */
  rax = 0; raz = 0; hasRear = false;
  /** Поза в момент перехода в физику (для возврата в поток); dead — разбита окончательно (обстрел/взрыв). */
  detX = 0; detZ = 0; detFx = 0; detFz = -1; dead = false;
  // общественный транспорт
  route = -1; piece = 0; pieceEdge = 0; nextStop = 0; dwell = 0; dwellDone = false;
  // поза (текущая и предыдущий шаг для интерполяции)
  x = 0; y = 0; z = 0; fx = 0; fy = 0; fz = -1;
  ox = 0; oy = 0; oz = 0; ofx = 0; ofy = 0; ofz = -1;
  spin = 0;
  brake = false; ind = 0; beacon = false;
  /** Авария: тело стало динамическим, поза — из физики (кватернион). */
  crashed = false; crashT = 0;
  qx = 0; qy = 0; qz = 0; qw = 1;
  /** Слот кинематического тела (traffic/physics.ts). */
  body: unknown = null;
  alive = true;

  constructor(kind: VehicleKind, m: VehicleModel) {
    this.kind = kind;
    this.len = m.length; this.halfW = m.width / 2;
    const zf = Math.min(...m.wheels.map((w) => w[2])), zr = Math.max(...m.wheels.map((w) => w[2]));
    this.wb = zr - zf; this.zr = zr; this.dFront = m.length / 2 + zf;
    this.track = 2 * Math.abs(m.wheels[0][0]);
  }
  get isBus(): boolean { return this.route >= 0; }
}

export interface Obstacle { x: number; z: number; vx: number; vz: number; fx: number; fz: number; halfLen: number; halfW: number; ped?: boolean; self?: number }

const OBS_CELL = 25;

export class TrafficSim {
  readonly vehicles: SimVehicle[] = [];
  densityFactor = 1;
  readonly opts: SimOptions;
  readonly stats = { spawned: 0, despawned: 0, stuckRemoved: 0, desired: 0, buses: 0, stepMs: 0, waitingRed: 0, laneChanges: 0 };
  /** Внешние препятствия (игрок, разбитые машины, пешеходы) — setObstacles из traffic/index.ts. */
  obstacles: Obstacle[] = [];
  private obsGrid = new Map<number, Obstacle[]>();
  time = 0;
  private segVeh: (SimVehicle[] | undefined)[];
  private edgeNext: { edge: number; w: number }[][];
  private ringLanes: number[] = [];
  private ringCum: number[] = [];
  private ringAt = { x: 1e9, z: 1e9 };
  private spawnAcc = 0;
  private busAcc = 0;
  private player = { x: 0, z: 0 };
  private cam = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1 };
  private tmp = new Float32Array(12);
  private rnd: () => number;
  private dtCur = 1 / 60;
  /** Причина последнего отказа canEnter (отладка). */
  why = '';
  private pieceCells: { route: number; piece: number; xz: Float32Array }[] = [];

  constructor(readonly net: TrafficNet, readonly signals: SignalController, readonly models: Record<VehicleKind, VehicleModel>, opts: Partial<SimOptions> = {}) {
    this.opts = { maxVehicles: 600, maxBuses: 16, spawnMin: 140, spawnMax: 600, despawn: 680, ...opts };
    this.segVeh = new Array(net.nSegs);
    let seed = 1234567;
    this.rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    // соседние рёбра с весами (для случайного выбора поворота)
    const nE = net.edges.length;
    this.edgeNext = Array.from({ length: nE }, () => []);
    const seen = new Map<number, number>();
    for (let c = 0; c < net.nConns; c++) {
      const fe = net.laneEdge[net.connFrom[c]], te = net.laneEdge[net.connTo[c]];
      const E = net.edges[te];
      if (!E.main || !(net.laneCls[net.connTo[c]] & CLS_CAR)) continue;
      const key = fe * 100000 + te;
      if (seen.has(key)) continue;
      seen.set(key, 1);
      const w = Math.pow(E.prio, 1.6) * (DIR_W[net.connDir[c]] ?? 1);
      this.edgeNext[fe].push({ edge: te, w });
    }
    // маршруты ОТ: точки рёбер для поиска ближайших к игроку
    net.routes.forEach((r, ri) => r.pieces.forEach((p, pi) => {
      const xz = new Float32Array(p.edges.length * 2);
      p.edges.forEach((e, k) => {
        const l = net.edges[e].lanes[0];
        net.pointAt(l, net.segLen[l] / 2, this.tmp);
        xz[k * 2] = this.tmp[0]; xz[k * 2 + 1] = this.tmp[2];
      });
      this.pieceCells.push({ route: ri, piece: pi, xz });
    }));
  }

  setObstacles(list: Obstacle[]): void {
    this.obstacles = list;
    for (const a of this.obsGrid.values()) a.length = 0;
    for (const o of list) {
      const k = Math.floor(o.x / OBS_CELL) * 100003 + Math.floor(o.z / OBS_CELL);
      let a = this.obsGrid.get(k);
      if (!a) this.obsGrid.set(k, (a = []));
      a.push(o);
    }
  }

  setPlayer(x: number, z: number): void { this.player.x = x; this.player.z = z; }
  setCamera(x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    Object.assign(this.cam, { x, y, z, dx, dy, dz });
  }

  // ---------------- списки по сегментам
  private list(seg: number): SimVehicle[] {
    let a = this.segVeh[seg];
    if (!a) this.segVeh[seg] = a = [];
    return a;
  }
  private insert(v: SimVehicle): void {
    const a = this.list(v.seg);
    let i = 0;
    while (i < a.length && a[i].s < v.s) i++;
    a.splice(i, 0, v);
  }
  private unlink(v: SimVehicle): void {
    const a = this.segVeh[v.seg];
    if (!a) return;
    const i = a.indexOf(v);
    if (i >= 0) a.splice(i, 1);
  }
  vehiclesOn(seg: number): readonly SimVehicle[] { return this.segVeh[seg] ?? []; }

  // ---------------- скорость
  private desired(v: SimVehicle, seg: number): number {
    const net = this.net;
    let lim = net.segSpeed[seg];
    if (seg < net.nLanes) lim = Math.min(lim, CAP[net.edges[net.laneEdge[seg]].hw] ?? 50 / 3.6);
    else lim = Math.min(lim, CAP[net.edges[net.laneEdge[net.connTo[seg - net.nLanes]]].hw] ?? 50 / 3.6);
    return Math.max(lim * v.vf, 2);
  }

  private idm(v: SimVehicle, v0: number, gap: number, vl: number): number {
    const free = 1 - Math.pow(v.v / v0, 4);
    if (gap > 500) return v.aMax * free;
    const ss = v.s0 + Math.max(0, v.v * v.T + (v.v * (v.v - vl)) / (2 * Math.sqrt(v.aMax * v.b)));
    const g = Math.max(gap, 0.1);
    return v.aMax * (free - (ss / g) * (ss / g));
  }

  // ---------------- маршрут
  private pickNextEdge(edge: number): number {
    const c = this.edgeNext[edge];
    if (!c.length) return -1;
    let sum = 0;
    for (const x of c) sum += x.w;
    let r = this.rnd() * sum;
    for (const x of c) { r -= x.w; if (r <= 0) return x.edge; }
    return c[c.length - 1].edge;
  }

  /** Добавить в план одно ребро (маршрут ОТ или случайный поворот); false — некуда. */
  private extendPlan(v: SimVehicle): boolean {
    const net = this.net;
    if (v.route >= 0) {
      const p = net.routes[v.route].pieces[v.piece];
      const idx = v.pieceEdge + 1 + v.plan.length;
      if (idx < p.edges.length) { v.plan.push(p.edges[idx]); return true; }
    }
    const n = this.pickNextEdge(v.plan.length ? v.plan[v.plan.length - 1] : v.edge);
    if (n < 0) return false;
    v.plan.push(n);
    return true;
  }

  private fillPlan(v: SimVehicle): void {
    while (v.plan.length < 3 && this.extendPlan(v));
  }

  private leaveRoute(v: SimVehicle): void {
    if (v.route < 0) return;
    v.route = -1;
    this.stats.buses--;
  }

  /** Соединение из полосы lane на ребро E (с учётом следующего ребра E2); -1 — нет. */
  private pickConn(v: SimVehicle, lane: number, E: number, E2: number): number {
    const net = this.net;
    let best = -1, bestScore = -1e9;
    const myIdx = net.laneIndex[lane];
    for (const c of net.laneOut[lane]) {
      const tl = net.connTo[c];
      if (net.laneEdge[tl] !== E) continue;
      const cls = net.laneCls[tl];
      if (!(cls & (v.isBus ? CLS_BUS | CLS_CAR : CLS_CAR))) continue;
      let score = -Math.abs(net.laneIndex[tl] - myIdx);
      if (E2 >= 0) {
        let ok = false;
        for (const c2 of net.laneOut[tl]) if (net.laneEdge[net.connTo[c2]] === E2) { ok = true; break; }
        if (ok) score += 10;
      }
      if (v.isBus) score -= net.laneIndex[tl] * 3;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  private buildPath(v: SimVehicle): void {
    const net = this.net, nL = net.nLanes;
    v.path.length = 0;
    let lane: number;
    let k = 0;
    let acc = net.segLen[v.seg] - v.s;
    if (v.seg >= nL) { lane = net.connTo[v.seg - nL]; v.path.push(lane); acc += net.segLen[lane]; }
    else lane = v.seg;
    v.pathOpen = true;
    while (acc < 200 || k < 2) {
      if (k + 1 >= v.plan.length && !this.extendPlan(v) && k >= v.plan.length) { v.pathOpen = false; break; }
      let c = this.pickConn(v, lane, v.plan[k], k + 1 < v.plan.length ? v.plan[k + 1] : -1);
      if (c < 0 && k > 0) {
        // с выбранной впереди полосы на plan[k] не уехать (короткая полоса, перестроиться негде) — меняем план отсюда
        const outs = net.laneOut[lane].filter((x) => (net.laneCls[net.connTo[x]] & CLS_CAR) && net.edges[net.laneEdge[net.connTo[x]]].main);
        if (outs.length) {
          v.plan.length = k;
          v.plan.push(net.laneEdge[net.connTo[outs[Math.floor(this.rnd() * outs.length)]]]);
          c = this.pickConn(v, lane, v.plan[k], -1);
        }
      }
      if (c < 0) { v.pathOpen = false; break; }
      v.path.push(nL + c, net.connTo[c]);
      acc += net.segLen[nL + c] + net.segLen[net.connTo[c]];
      lane = net.connTo[c];
      k++;
    }
  }

  // ---------------- перекрёсток: можно ли въехать в соединение c (seg = nL + c) с расстояния dist
  private canEnter(v: SimVehicle, c: number, dist: number): boolean {
    const net = this.net, sig = this.signals, nL = net.nLanes;
    const code = sig.connCode(c);
    const tl = net.connTl[c];
    if (tl >= 0) {
      if (code === CH_r || code === CH_u) { this.why = 'red'; return false; }
      if (code === CH_y) { this.why = 'yellow'; return dist < (v.v * v.v) / (2 * 4) + 0.5; }
    }
    // занятость пересекающихся соединений
    for (const f of net.connFoes[c]) {
      const occ = this.segVeh[nL + f];
      if (occ && occ.length) {
        for (const o of occ) if (o !== v && o.s < net.segLen[nL + f] - 0.5) { this.why = `foe#${o.id}`; return false; }
      }
    }
    const major = code === CH_G || code === CH_M || code === CH_O;
    if (!major) {
      const gapT = v.wait > 18 ? 0 : v.wait > 7 ? 2.2 : 4.5;
      if (gapT > 0) {
        for (const r of net.connResp[c]) {
          const lane = net.connFrom[r];
          const a = this.segVeh[lane];
          if (!a || !a.length) continue;
          if (net.connTl[r] >= 0) {
            const cr = sig.connCode(r);
            if (cr !== CH_G && cr !== CH_g && cr !== CH_y) continue;
          }
          for (let i = a.length - 1; i >= Math.max(0, a.length - 2); i--) {
            const o = a[i];
            if (o.path[0] !== nL + r) continue;
            const d = net.segLen[lane] - o.s;
            if (o.v < 0.5 && d > 4) continue;
            if (d / Math.max(o.v, 0.8) < gapT) { this.why = `yield#${o.id}`; return false; }
          }
        }
      }
    }
    // не въезжать, если за перекрёстком некуда встать
    const to = this.segVeh[net.connTo[c]];
    if (to && to.length) {
      const last = to[0];
      if (last !== v && last.s - last.len < v.len + 1.5 && last.v < 3) { this.why = `full#${last.id}`; return false; }
    }
    return true;
  }

  private foeOccupied(v: SimVehicle, c: number): boolean {
    const net = this.net, nL = net.nLanes;
    for (const f of net.connFoes[c]) {
      const occ = this.segVeh[nL + f];
      if (occ) for (const o of occ) if (o !== v && o.s < net.segLen[nL + f] - 0.5) return true;
    }
    return false;
  }

  // ---------------- ускорение машины
  private accel(v: SimVehicle): number {
    const net = this.net, nL = net.nLanes;
    let a = this.idm(v, this.desired(v, v.seg), 1e9, 0);
    let gapMin = 1e9, vlMin = 0;
    const lst = this.segVeh[v.seg]!;
    const i = lst.indexOf(v);
    if (i + 1 < lst.length) {
      const l = lst[i + 1];
      gapMin = l.s - l.len - v.s; vlMin = l.v;
    }
    // хвосты машин, уже въехавших на перекрёсток с этой полосы в другую сторону, ещё торчат в полосе
    if (v.seg < nL && net.segLen[v.seg] - v.s < 12) {
      const dist0 = net.segLen[v.seg] - v.s;
      for (const c of net.laneOut[v.seg]) {
        if (nL + c === v.path[0]) continue;
        const q = this.segVeh[nL + c];
        if (q && q.length) { const o = q[0]; const g = dist0 + o.s - o.len; if (g < gapMin) { gapMin = g; vlMin = o.v; } }
        const cl = net.segLen[nL + c], q2 = this.segVeh[net.connTo[c]];
        if (q2 && q2.length && q2[0].s < q2[0].len) { const o = q2[0]; const g = dist0 + cl + o.s - o.len; if (g < gapMin) { gapMin = g; vlMin = o.v; } }
      }
    }
    // посреди перестроения — лидер и в старом ряду
    if (v.lcOld >= 0 && v.lcFrom !== 0 && Math.abs(v.lcOff) > 0.6 && v.seg < nL) {
      const q = this.segVeh[v.lcOld];
      if (q) {
        const s2 = v.s * net.segLen[v.lcOld] / net.segLen[v.seg];
        for (const o of q) if (o.s > s2) { const g = o.s - o.len - s2; if (g < gapMin) { gapMin = g; vlMin = o.v; } break; }
      }
    }
    const look = Math.max(60, v.v * v.v / 2 + 40);
    let dist = net.segLen[v.seg] - v.s;
    let blocked = false, found = false, k = 0;
    v.ind = 0;
    if (v.seg >= nL) {
      // в повороте поворотник продолжает мигать
      const d = net.connDir[v.seg - nL];
      v.ind = d === 'r' || d === 'R' ? 1 : d === 'l' || d === 'L' || d === 't' ? -1 : 0;
    }
    // автобус: остановка на текущей полосе
    // (+s0: IDM держит дистанцию s0 до «препятствия», а нос должен встать у остановки)
    const stopGap = v.route >= 0 ? this.stopDistance(v) + v.s0 - 0.3 : 1e9;
    if (stopGap < gapMin) { gapMin = stopGap; vlMin = 0; }
    for (; k < v.path.length && dist < look; k++) {
      const seg = v.path[k];
      if (seg >= nL) {
        const c = seg - nL;
        if (k === 0 && dist < 40) {
          const d = net.connDir[c];
          v.ind = d === 'r' || d === 'R' ? 1 : d === 'l' || d === 'L' || d === 't' ? -1 : 0;
        }
        if (v.commits.indexOf(seg) >= 0 && dist > (v.v * v.v) / (2 * v.emerg) + 1 && this.foeOccupied(v, c)) {
          // решили ехать, но перекрёсток занят поперечным потоком и ещё можно остановиться — стоим
          if (dist - 1 < gapMin) { gapMin = dist - 1; vlMin = 0; }
          blocked = true;
          break;
        }
        if (v.commits.indexOf(seg) < 0 && dist < 110) {
          if (this.canEnter(v, c, dist)) {
            if (dist < (v.v * v.v) / (2 * 3.2) + 3) v.commits.push(seg);
          } else {
            if (dist - 1 < gapMin) { gapMin = dist - 1; vlMin = 0; }
            blocked = true;
            if (k === 0 && dist < 15 && v.v < 1) v.wait += this.dtCur;
            break;
          }
        }
      }
      // скорость впереди
      const lim = this.desired(v, seg);
      if (lim < v.v) {
        const need = (v.v * v.v - lim * lim) / (2 * Math.max(dist, 1));
        if (need > 0.8) a = Math.min(a, -need);
      }
      const q = this.segVeh[seg];
      if (q && q.length) {
        const l = q[0];
        const g = dist + l.s - l.len;
        if (g < gapMin) { gapMin = g; vlMin = l.v; }
        found = true;
        break;
      }
      dist += net.segLen[seg];
    }
    // путь кончился раньше горизонта и дальше не продлевается (нужно перестроиться / тупик) — стоять у конца
    if (!blocked && !found && k === v.path.length && dist < look && !v.pathOpen) {
      if (dist - 1 < gapMin) { gapMin = dist - 1; vlMin = 0; }
    }
    // препятствия: игрок, разбитые машины, пешеходы (сетка obsGrid, клетки вдоль 50 м впереди)
    v.obsGap = 1e9;
    if (this.obstacles.length) {
      const fl = Math.hypot(v.fx, v.fz) || 1, fx = v.fx / fl, fz = v.fz / fl;
      const fx0 = v.x + fx * v.len / 2, fz0 = v.z + fz * v.len / 2; // перед машины
      const ex = fx0 + fx * 50, ez = fz0 + fz * 50;
      const c0x = Math.floor((Math.min(fx0, ex) - 4) / OBS_CELL), c1x = Math.floor((Math.max(fx0, ex) + 4) / OBS_CELL);
      const c0z = Math.floor((Math.min(fz0, ez) - 4) / OBS_CELL), c1z = Math.floor((Math.max(fz0, ez) + 4) / OBS_CELL);
      for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
        const cell = this.obsGrid.get(cx * 100003 + cz);
        if (!cell) continue;
        for (const o of cell) {
          if (o.self === v.id) continue;
          const dx = o.x - fx0, dz = o.z - fz0;
          const d = dx * fx + dz * fz;
          if (d > 50 || d < -6) continue;
          let lat = -dx * fz + dz * fx;
          // проекция габарита препятствия на поперечную ось
          const ext = Math.abs(o.fx * -fz + o.fz * fx) * o.halfLen + Math.abs(o.fx * fx + o.fz * fz) * o.halfW;
          const along = Math.abs(o.fx * fx + o.fz * fz) * o.halfLen + Math.abs(o.fx * -fz + o.fz * fx) * o.halfW;
          if (d < -along) continue;
          const corr = v.halfW + ext + (o.ped ? 0.4 : 0.35);
          if (o.ped && Math.abs(lat) >= corr) {
            // пешеход идёт поперёк: где он будет, когда машина доедет (до 3 с)
            const t = Math.min(Math.max(d, 0) / Math.max(v.v, 1), 3);
            const lat2 = lat + (-o.vx * fz + o.vz * fx) * t;
            if (Math.sign(lat2) === Math.sign(lat) && Math.abs(lat2) >= corr) continue;
            lat = 0;
          }
          if (Math.abs(lat) < corr) {
            const g = d - along - (o.ped ? 1.5 : 0);
            v.obsGap = Math.min(v.obsGap, g);
            if (g < gapMin) { gapMin = g; vlMin = o.ped ? 0 : Math.max(0, o.vx * fx + o.vz * fz); }
          }
        }
      }
    }
    v.gap = gapMin;
    if (gapMin < 1e8) a = Math.min(a, this.idm(v, this.desired(v, v.seg), gapMin, vlMin));
    a = Math.min(a, this.curveLimit(v));
    if (v.dwell > 0) a = Math.min(a, -4);
    return Math.max(a, -v.emerg);
  }

  /** Торможение перед поворотом: поперечное ускорение v²·k ≤ aLat по точкам пути впереди (кривизна сглаженной ломаной). */
  private curveLimit(v: SimVehicle): number {
    if (v.v < 1.5) return 10;
    const net = this.net, cum = net.cum, cv = net.curv;
    const look = Math.min(90, (v.v * v.v) / (2 * 1.5) + 10);
    let worst = 10;
    let seg = v.seg, base = -v.s - 0, k = -1;
    for (let step = 0; step <= v.path.length && base < look; step++) {
      if (step > 0) { seg = v.path[step - 1]; }
      const p0 = net.segP0[seg], pn = net.segPn[seg];
      for (let i = 0; i < pn; i++) {
        const d = base + cum[p0 + i];
        if (d < -v.dFront) continue;
        if (d > look) break;
        const kk = Math.abs(cv[p0 + i]);
        if (kk < 0.004) continue;
        const vlim = Math.sqrt(v.aLat / kk);
        if (vlim >= v.v + 3) continue;
        // ускорение, при котором к точке приедем ровно с vlim (может быть и положительным — тогда «не разгоняться»)
        const allow = (vlim * vlim - v.v * v.v) / (2 * Math.max(d, 1.5));
        if (allow < worst) worst = allow;
      }
      base += net.segLen[seg];
      void k;
    }
    return Math.max(worst, -v.emerg);
  }

  /** Боковое смещение S-кривой смены полосы в точке одометра o. */
  lcOffsetAt(v: SimVehicle, o: number): number {
    if (v.lcFrom === 0) return 0;
    const u = (o - v.lcStart) / v.lcLen;
    if (u <= 0) return v.lcFrom;
    if (u >= 1) return 0;
    return v.lcFrom * (1 - minJerk(u));
  }

  /** Расстояние до следующей остановки автобуса (по пути), 1e9 — нет. */
  private stopDistance(v: SimVehicle): number {
    const net = this.net;
    const p = net.routes[v.route].pieces[v.piece];
    if (v.nextStop >= p.stops.length) return 1e9;
    const [k, s] = p.stops[v.nextStop];
    if (v.seg < net.nLanes && k === v.pieceEdge) {
      const d = s - v.s;
      if (d < -3) { v.nextStop++; return 1e9; }
      return Math.max(d, 0);
    }
    // на ребре впереди
    let dist = net.segLen[v.seg] - v.s, e = v.pieceEdge;
    for (const seg of v.path) {
      if (seg < net.nLanes) {
        e++;
        if (e === k) return dist + s;
        if (e > k) break;
      }
      dist += net.segLen[seg];
      if (dist > 150) break;
    }
    if (k < v.pieceEdge) v.nextStop++;
    return 1e9;
  }

  // ---------------- шаг
  step(dt: number): void {
    const t0 = performance.now();
    this.time += dt;
    this.dtCur = dt;
    this.signals.update(dt);
    const net = this.net, nL = net.nLanes, V = this.vehicles;
    // 1) ускорения
    for (const v of V) if (!v.crashed) v.acc = this.accel(v);
    // 2) интеграция
    let waiting = 0;
    for (const v of V) {
      if (v.crashed) continue;
      v.ox = v.x; v.oy = v.y; v.oz = v.z; v.ofx = v.fx; v.ofy = v.fy; v.ofz = v.fz;
      // ограничение рывка: плавные трогания и остановки; резкое торможение нарастает быстрее
      if (v.v < 0.05 && v.acc <= 0) v.aCur = Math.min(v.aCur, 0) * 0.5;
      else {
        const da = v.acc - v.aCur;
        const rate = da > 0 ? v.jUp : (v.acc < -3 ? 14 : 5);
        v.aCur += Math.max(-rate * dt, Math.min(rate * dt, da));
      }
      v.v = Math.max(0, v.v + v.aCur * dt);
      if (v.v === 0 && v.aCur < 0) v.aCur = 0;
      let ds = v.v * dt;
      // не обгонять лидера на той же полосе
      const lst = this.segVeh[v.seg]!;
      const i = lst.indexOf(v);
      if (i + 1 < lst.length) ds = Math.min(ds, Math.max(0, lst[i + 1].s - 0.05 - v.s));
      ds = Math.min(ds, Math.max(0, v.gap - 0.25)); // не въезжать в лидера / за стоп-линию
      if (ds < v.v * dt - 0.5) v.v = ds / dt;
      v.s += ds;
      v.odo += ds;
      v.brake = v.aCur < -0.6 || v.v < 0.2;
      if (v.v < 0.3) { v.stuck += dt; waiting++; } else { v.stuck = 0; if (v.wait > 0 && v.seg >= nL) v.wait = 0; }
      if (v.lcCool > 0) v.lcCool -= dt;
      if (v.lcFrom !== 0) {
        v.lcOff = this.lcOffsetAt(v, v.odo);
        // кривая кончилась и для задней оси — смена полосы завершена
        if (v.odo - v.dFront - v.wb > v.lcStart + v.lcLen) { v.lcFrom = 0; v.lcOff = 0; }
        else v.ind = v.lcFrom > 0 ? -1 : 1;
      }
      if (v.lcPending >= 0) v.ind = this.net.laneIndex[v.lcPending] > this.net.laneIndex[v.seg] ? -1 : 1;
      while (v.s > net.segLen[v.seg]) {
        const next = v.path.shift();
        if (next === undefined) { v.s = net.segLen[v.seg]; v.v = 0; break; }
        const over = v.s - net.segLen[v.seg];
        this.unlink(v);
        v.prev.push(v.seg);
        if (v.prev.length > 3) v.prev.shift();
        v.seg = next; v.s = over;
        v.lcOld = -1;
        if (next >= nL) {
          const ci = v.commits.indexOf(next);
          if (ci >= 0) v.commits.splice(ci, 1);
          v.wait = 0;
          v.edge = net.laneEdge[net.connTo[next - nL]];
          if (v.plan[0] === v.edge) v.plan.shift();
        } else {
          if (v.route >= 0) {
            const p = net.routes[v.route].pieces[v.piece];
            const k = p.edges.indexOf(net.laneEdge[next], v.pieceEdge);
            if (k >= 0) v.pieceEdge = k; else this.leaveRoute(v);
          }
          v.edge = net.laneEdge[next];
          this.fillPlan(v);
          this.buildPath(v);
        }
        this.insert(v);
      }
      // автобус на остановке
      if (v.route >= 0 && v.seg < nL) {
        const p = net.routes[v.route].pieces[v.piece];
        if (v.nextStop < p.stops.length && p.stops[v.nextStop][0] === v.pieceEdge) {
          const d = p.stops[v.nextStop][1] - v.s;
          if (v.dwell <= 0 && d < 1.5 && v.v < 0.3) v.dwell = 10 + this.rnd() * 10;
        }
        if (v.dwell > 0) {
          v.dwell -= dt;
          v.ind = v.dwell < 3 ? -1 : 1;
          if (v.dwell <= 0) { v.dwell = 0; v.nextStop++; }
        }
      }
    }
    this.stats.waitingRed = waiting;
    // 3) перестроения
    for (const v of V) if (!v.crashed && v.seg < nL) this.laneChange(v, dt);
    // 4) поза
    const px = this.player.x, pz = this.player.z;
    for (const v of V) {
      if (v.crashed) continue;
      this.pose(v);
      v.near = Math.abs(v.x - px) < 150 && Math.abs(v.z - pz) < 150;
      this.attitude(v, dt);
    }
    // 5) спавн / удаление
    this.spawnAcc += dt;
    if (this.spawnAcc > 0.1) { this.manage(this.spawnAcc); this.spawnAcc = 0; }
    this.busAcc += dt;
    if (this.busAcc > 1.5) { this.manageBuses(); this.busAcc = 0; }
    this.stats.stepMs = this.stats.stepMs * 0.95 + (performance.now() - t0) * 0.05;
  }

  // ---------------- перестроения
  private laneChange(v: SimVehicle, dt: number): void {
    const net = this.net;
    const lane = v.seg;
    const E = net.edges[net.laneEdge[lane]];
    const distEnd = net.segLen[lane] - v.s;
    const want = v.plan[0] ?? -1;
    const needStrategic = want >= 0 && !this.reaches(lane, want);
    // автобус к остановке — в правый ряд
    const busRight = v.route >= 0 && net.laneIndex[lane] > 0 && this.stopDistance(v) < 200;
    if (E.lanes.length < 2) {
      if (needStrategic && distEnd < 30) this.replan(v);
      return;
    }
    // идёт перестроение: следующее — только стратегическое (нужный ряд) и не раньше, чем кузов почти встал в полосу;
    // задняя ось — трактриса, поэтому новая S-кривая от текущего смещения начинается без скачка
    const urgent = (needStrategic || busRight) && (distEnd < 40 || v.v < 1);
    if ((v.lcFrom !== 0 && !(urgent && Math.abs(v.lcOff) < 1.2)) || (v.lcCool > 0 && !urgent)) {
      if (needStrategic && distEnd < 12 && v.v < 0.5 && v.stuck > 4) this.replan(v);
      return;
    }
    // поворотник мигает заранее (~1.5 с), потом — если всё ещё безопасно — начинаем
    if (v.lcPending >= 0) {
      const tl = v.lcPending;
      if (net.laneEdge[tl] !== net.laneEdge[lane]) { v.lcPending = -1; return; }
      v.lcDelay -= dt;
      if (v.lcDelay > 0 && distEnd > 20) return;
      v.lcPending = -1;
      if (this.safeChange(v, tl, 2.5, 3.5) || (distEnd < 15 && v.isBus)) this.doChange(v, tl);
      return;
    }
    // хвост ещё на перекрёстке — перестраиваться нельзя (на короткой полосе — сменить направление)
    if (v.s < v.len + 4) {
      if ((needStrategic || busRight) && distEnd < 12 && v.v < 0.5 && !busRight) this.replan(v);
      return;
    }
    if (needStrategic || busRight) {
      // ближайшая полоса, откуда есть соединение
      let target = -1;
      if (busRight) target = E.lanes[net.laneIndex[lane] - 1];
      else {
        let bestD = 99;
        for (const l of E.lanes) {
          if (l === lane) continue;
          if (!net.laneOut[l].some((c) => net.laneEdge[net.connTo[c]] === want)) continue;
          const d = Math.abs(net.laneIndex[l] - net.laneIndex[lane]);
          if (d < bestD) { bestD = d; target = l; }
        }
        if (target >= 0) target = E.lanes[net.laneIndex[lane] + Math.sign(net.laneIndex[target] - net.laneIndex[lane])];
      }
      if (target < 0 || target === undefined) { if (distEnd < 30) this.replan(v); return; }
      const urgency = distEnd < 60 ? 1 - distEnd / 60 : 0;
      // стоя боком не перестраиваются: в пробке у стоп-линии легковая меняет направление, автобус ждёт и «втискивается»
      if (v.v < 1.5 && !v.isBus) { if (distEnd < 30) this.replan(v); return; }
      if (this.safeChange(v, target, 1 + 2.5 * urgency, urgency > 0.7 ? 1.0 : 3)) this.requestChange(v, target, distEnd < 25 ? 0 : 1.5);
      else if (distEnd < 12 && v.v < 0.5) {
        if (v.isBus) this.doChange(v, target); // автобус «втискивается»
        else this.replan(v);
      }
      return;
    }
    // MOBIL-lite: раз в 1–3 с
    v.lcTimer -= dt;
    if (v.lcTimer > 0) return;
    v.lcTimer = 1 + this.rnd() * 2;
    if (v.isBus || v.s < 10 || (distEnd < 50 && v.obsGap > 40)) return;
    const lst = this.segVeh[lane]!;
    const i = lst.indexOf(v);
    const lead = i + 1 < lst.length ? lst[i + 1] : null;
    const blockedByObs = v.obsGap < 40 && (!lead || v.obsGap < lead.s - lead.len - v.s);
    if (!blockedByObs && (!lead || lead.s - lead.len - v.s > 60)) {
      // свободно — иногда вернуться вправо
      if (net.laneIndex[lane] > 0 && this.rnd() < 0.3) {
        const r = E.lanes[net.laneIndex[lane] - 1];
        if (this.reaches(r, want) && this.safeChange(v, r, 4, 25)) this.requestChange(v, r, 1.5);
      }
      return;
    }
    const v0 = this.desired(v, lane);
    const aCur = blockedByObs ? this.idm(v, v0, v.obsGap, 0) : this.idm(v, v0, lead!.s - lead!.len - v.s, lead!.v);
    let best = -1, bestGain = 0.6;
    for (const d of [1, -1]) {
      const idx = net.laneIndex[lane] + d;
      if (idx < 0 || idx >= E.lanes.length) continue;
      const tl = E.lanes[idx];
      if (!(net.laneCls[tl] & CLS_CAR) || !this.reaches(tl, want)) continue;
      const s2 = v.s * net.segLen[tl] / net.segLen[lane];
      const q = this.list(tl);
      let ld: SimVehicle | null = null;
      for (const o of q) if (o.s > s2) { ld = o; break; }
      const aNew = ld ? this.idm(v, v0, ld.s - ld.len - s2, ld.v) : this.idm(v, v0, 1e9, 0);
      const gain = aNew - aCur - (d > 0 ? 0 : -0.2);
      if (gain > bestGain && this.safeChange(v, tl, 3, 3)) { bestGain = gain; best = tl; }
    }
    if (best >= 0) this.requestChange(v, best, 1.5);
  }

  private reaches(lane: number, edge: number): boolean {
    if (edge < 0) return true;
    for (const c of this.net.laneOut[lane]) if (this.net.laneEdge[this.net.connTo[c]] === edge) return true;
    return false;
  }

  /** Безопасно ли перестроиться: зазоры до лидера/последователя на целевой полосе, торможение последователя. */
  private safeChange(v: SimVehicle, tl: number, minGap: number, maxBrake: number): boolean {
    const net = this.net;
    const s2 = v.s * net.segLen[tl] / net.segLen[v.seg];
    const q = this.list(tl);
    for (const o of q) {
      if (o.s > s2) {
        if (o.s - o.len - s2 < minGap) return false;
        break;
      }
    }
    let f: SimVehicle | null = null;
    for (const o of q) if (o.s <= s2) f = o;
    if (f) {
      const g = s2 - v.len - f.s;
      if (g < minGap) return false;
      if (this.idm(f, this.desired(f, tl), g, v.v) < -maxBrake) return false;
    } else if (s2 < v.len + 2) {
      // хвост может задеть машину на соединении перед полосой — не рискуем
      for (const c of net.laneIn[tl]) { const a = this.segVeh[net.nLanes + c]; if (a && a.length) return false; }
    }
    return true;
  }

  /** Начать смену полосы через delay с (поворотник), 0 — сразу. */
  private requestChange(v: SimVehicle, tl: number, delay: number): void {
    if (delay <= 0) { this.doChange(v, tl); return; }
    v.lcPending = tl; v.lcDelay = delay;
  }

  private doChange(v: SimVehicle, tl: number): void {
    const net = this.net;
    const from = v.seg;
    const s2 = v.s * net.segLen[tl] / net.segLen[from];
    this.unlink(v);
    const w = (net.laneWidth[tl] + net.laneWidth[from]) / 2;
    // S-кривая по пути: длительность 3–6 с (на скорости дольше), не короче 15 м; началась у переднего бампера
    const cur = this.lcOffsetAt(v, v.odo);
    v.lcFrom = cur + (net.laneIndex[tl] - net.laneIndex[from]) * w;
    v.lcStart = v.odo;
    v.lcLen = Math.max(15, v.v * Math.min(6, Math.max(3, 2.5 + 0.15 * v.v)));
    v.lcPending = -1;
    v.lcOld = from;
    v.lcOff = v.lcFrom;
    v.seg = tl; v.s = s2;
    this.insert(v);
    v.commits.length = 0;
    this.buildPath(v);
    v.lcCool = 2.5;
    this.stats.laneChanges++;
  }

  private replan(v: SimVehicle): void {
    // выбрать другое ребро, достижимое с текущей полосы
    const net = this.net;
    const outs = net.laneOut[v.seg].filter((c) => {
      const e = net.edges[net.laneEdge[net.connTo[c]]];
      return (net.laneCls[net.connTo[c]] & CLS_CAR) && (e.main || v.isBus);
    });
    if (!outs.length) {
      // с этой полосы никуда: втиснуться в соседнюю, откуда можно уехать
      const E = net.edges[net.laneEdge[v.seg]];
      for (const d of [-1, 1]) {
        const l = E.lanes[net.laneIndex[v.seg] + d];
        if (l === undefined || !(net.laneCls[l] & CLS_CAR)) continue;
        if (!net.laneOut[l].some((c) => net.edges[net.laneEdge[net.connTo[c]]].main)) continue;
        if (this.safeChange(v, l, 0.5, 9)) {
          v.plan.length = 0;
          this.doChange(v, l);
          this.fillPlan(v);
          this.buildPath(v);
          return;
        }
      }
      return;
    }
    const c = outs[Math.floor(this.rnd() * outs.length)];
    this.leaveRoute(v); // автобус сошёл с маршрута — дальше как обычная машина
    v.plan.length = 0;
    v.plan.push(net.laneEdge[net.connTo[c]]);
    this.fillPlan(v);
    this.buildPath(v);
  }

  // ---------------- поза
  /** Точка пути на расстоянии rel от носа (rel ≤ 0, назад через предыдущие сегменты) → tmp[o..o+2], касательная → tmp[o+3..o+5]. */
  private along(v: SimVehicle, rel: number, o: number): number {
    const net = this.net, t = this.tmp;
    let seg = v.seg, s = v.s + rel, pi = v.prev.length - 1;
    while (s < 0 && pi >= 0) { seg = v.prev[pi--]; s += net.segLen[seg]; }
    if (s < 0) s = 0;
    const lo = net.pointAt(seg, s, t, o);
    const p0 = net.segP0[seg], P = net.pts;
    const a = (p0 + lo) * 3, b = a + 3;
    if (net.segPn[seg] >= 2) { t[o + 3] = P[b] - P[a]; t[o + 4] = P[b + 1] - P[a + 1]; t[o + 5] = P[b + 2] - P[a + 2]; }
    return net.curvatureAt(seg, s);
  }

  /**
   * Кинематика «велосипеда» без бокового скольжения: передняя ось идёт по пути (со смещением S-кривой смены полосы),
   * задняя — тянется за ней на расстоянии базы (трактриса: скорость задней оси всегда вдоль кузова, «крабом» машина не едет;
   * в тесном повороте задняя ось срезает внутрь, как у настоящей). Курс — от задней оси к передней, руль — угол между курсом
   * и касательной пути у передней оси. Высоты осей — с пути (тангаж по уклону/въездам на мосты).
   */
  private pose(v: SimVehicle): void {
    const t = this.tmp;
    const kF = this.along(v, -v.dFront, 0);
    const offF = this.lcOffsetAt(v, v.odo - v.dFront);
    let h = Math.hypot(t[3], t[5]) || 1;
    const tx = t[3] / h, tz = t[5] / h;
    const fxp = t[0] - tz * offF, fzp = t[2] + tx * offF, fyp = t[1];
    // высота задней оси — с пути на базу назад
    this.along(v, -v.dFront - v.wb, 6);
    const ryp = t[7];
    let rxp = v.rax, rzp = v.raz;
    let dx = fxp - rxp, dz = fzp - rzp, d = Math.hypot(dx, dz);
    if (!v.hasRear || d < v.wb * 0.5 || d > v.wb * 1.6) {
      // старт / скачок: задняя ось — на путь (со смещением)
      const offR = this.lcOffsetAt(v, v.odo - v.dFront - v.wb);
      h = Math.hypot(t[9], t[11]) || 1;
      rxp = t[6] - (t[11] / h) * offR; rzp = t[8] + (t[9] / h) * offR;
      dx = fxp - rxp; dz = fzp - rzp; d = Math.hypot(dx, dz) || 1;
      v.hasRear = true;
    }
    // трактриса: задняя ось на расстоянии базы от передней, вдоль прежнего направления
    rxp = fxp - (dx / d) * v.wb; rzp = fzp - (dz / d) * v.wb;
    v.rax = rxp; v.raz = rzp;
    let fx = fxp - rxp, fy = fyp - ryp, fz = fzp - rzp;
    const l = Math.hypot(fx, fy, fz) || 1;
    fx /= l; fy /= l; fz /= l;
    v.fx = fx; v.fy = fy; v.fz = fz;
    v.x = rxp + fx * v.zr; v.y = ryp + fy * v.zr; v.z = rzp + fz * v.zr;
    v.curvK = kF;
    // руль: угол от курса к направлению движения передней оси (касательная пути + наклон S-кривой)
    const lcSlope = v.lcFrom !== 0 ? (this.lcOffsetAt(v, v.odo - v.dFront + 0.5) - offF) / 0.5 : 0;
    const mx = tx - tz * lcSlope, mz = tz + tx * lcSlope;
    const hh = Math.hypot(fx, fz) || 1;
    const cross = (fx / hh) * mz - (fz / hh) * mx, dot = (fx / hh) * mx + (fz / hh) * mz;
    v.steer = Math.max(-0.6, Math.min(0.6, -Math.atan2(cross, dot)));
  }

  /** Крен по поперечному уклону дороги и пружина тангажа/крена (разгон/торможение, повороты) — только ближние машины. */
  private attitude(v: SimVehicle, dt: number): void {
    const bus = v.len > 5.5;
    if (!v.near) {
      v.pitchDyn *= 0.9; v.rollDyn *= 0.9; v.pitchVel = 0; v.rollVel = 0;
      return;
    }
    const hAt = this.opts.heightAt;
    if (hAt && this.net.isConn(v.seg) === false && !this.net.edges[this.net.laneEdge[v.seg]].bridge) {
      const h = Math.hypot(v.fx, v.fz) || 1, lx = v.fz / h, lz = -v.fx / h, ht = v.track / 2;
      const hl = hAt(v.x + lx * ht, v.z + lz * ht), hr = hAt(v.x - lx * ht, v.z - lz * ht);
      const target = Math.max(-0.08, Math.min(0.08, Math.atan((hl - hr) / v.track)));
      v.rollRoad += (target - v.rollRoad) * Math.min(1, dt * 8);
    } else v.rollRoad *= 0.9;
    // тангаж: + нос вверх (разгон), − «клевок» (торможение); крен: + правый борт вниз (наружу в левом повороте)
    const aLat = v.v * v.v * v.curvK;
    const pT = Math.max(-0.06, Math.min(0.05, (bus ? 0.007 : 0.011) * v.aCur));
    const rT = Math.max(-0.09, Math.min(0.09, (bus ? 0.022 : 0.012) * aLat));
    const w = bus ? 4.2 : 7, z = 0.5;
    v.pitchVel += (w * w * (pT - v.pitchDyn) - 2 * z * w * v.pitchVel) * dt;
    v.pitchDyn += v.pitchVel * dt;
    v.rollVel += (w * w * (rT - v.rollDyn) - 2 * z * w * v.rollVel) * dt;
    v.rollDyn += v.rollVel * dt;
  }

  // ---------------- спавн
  private visible(x: number, z: number): boolean {
    const c = this.cam;
    const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz);
    if (d < 25) return true;
    return d < 320 && (dx * c.dx + dz * c.dz) / d > 0.35;
  }

  private refreshRing(): void {
    const p = this.player, net = this.net;
    if (Math.hypot(p.x - this.ringAt.x, p.z - this.ringAt.z) < 40) return;
    this.ringAt.x = p.x; this.ringAt.z = p.z;
    const R = this.opts.spawnMax;
    this.ringLanes.length = 0; this.ringCum.length = 0;
    let acc = 0;
    for (const l of net.lanesNear(p.x, p.z, R)) {
      const E = net.edges[net.laneEdge[l]];
      if (!E.main || !(net.laneCls[l] & CLS_CAR) || net.segLen[l] < 12) continue;
      net.pointAt(l, net.segLen[l] / 2, this.tmp);
      const d = Math.hypot(this.tmp[0] - p.x, this.tmp[2] - p.z);
      if (d > R) continue;
      acc += (net.segLen[l] / 1000) * (DENSITY[E.hw] ?? 2);
      this.ringLanes.push(l); this.ringCum.push(acc);
    }
    this.stats.desired = acc;
  }

  private manage(dt: number): void {
    const p = this.player, o = this.opts;
    this.refreshRing();
    // удаление
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      if (v.crashed) continue;
      const d = Math.hypot(v.x - p.x, v.z - p.z);
      let kill = d > o.despawn;
      if (!kill && v.stuck > 90 && !this.visible(v.x, v.z) && d > 60) { kill = true; this.stats.stuckRemoved++; }
      if (!kill && v.stuck > 3 && !v.path.length && this.net.laneOut[v.seg]?.length === 0 && !this.visible(v.x, v.z)) kill = true;
      if (kill) this.remove(v);
    }
    // спавн
    const total = this.ringCum.length ? this.ringCum[this.ringCum.length - 1] : 0;
    const want = Math.min(o.maxVehicles, Math.round(total * this.densityFactor));
    const initial = this.time < 4;
    let budget = initial ? 60 : Math.max(2, Math.round(dt * 40));
    for (let tries = 0; tries < 200 && budget > 0 && this.vehicles.length - this.stats.buses < want; tries++) {
      const r = this.rnd() * total;
      let lo = 0, hi = this.ringCum.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (this.ringCum[m] < r) lo = m + 1; else hi = m; }
      const lane = this.ringLanes[lo];
      if (lane === undefined) break;
      const s = 6 + this.rnd() * Math.max(this.net.segLen[lane] - 8, 0.1);
      this.net.pointAt(lane, s, this.tmp);
      const d = Math.hypot(this.tmp[0] - p.x, this.tmp[2] - p.z);
      if (d > o.spawnMax) continue;
      if (!initial && (d < o.spawnMin || this.visible(this.tmp[0], this.tmp[2]))) continue;
      if (initial && d < 25) continue;
      if (this.spawnCar(lane, s, this.pickKind())) budget--;
    }
  }

  private pickKind(): VehicleKind {
    let sum = 0;
    for (const [, w] of CAR_MIX) sum += w;
    let r = this.rnd() * sum;
    for (const [k, w] of CAR_MIX) { r -= w; if (r <= 0) return k; }
    return 'sedan';
  }

  private pickColor(): number {
    let sum = 0;
    for (const [, w] of PALETTE) sum += w;
    let r = this.rnd() * sum;
    for (const [c, w] of PALETTE) { r -= w; if (r <= 0) return c; }
    return 0xffffff;
  }

  /** Свободно ли место на полосе lane около s для машины длины len. */
  private free(lane: number, s: number, len: number): boolean {
    const q = this.segVeh[lane];
    if (q) for (const o of q) if (o.s > s - len - 14 && o.s - o.len < s + 14) return false;
    if (s < len + 2) for (const c of this.net.laneIn[lane]) { const a = this.segVeh[this.net.nLanes + c]; if (a && a.length) return false; }
    if (s > this.net.segLen[lane] - 16) for (const c of this.net.laneOut[lane]) { const a = this.segVeh[this.net.nLanes + c]; if (a && a.length) return false; }
    return true;
  }

  spawnCar(lane: number, s: number, kind: VehicleKind, route = -1, piece = 0, pieceEdge = 0): SimVehicle | null {
    const m = this.models[kind];
    if (!this.free(lane, s, m.length)) return null;
    const v = new SimVehicle(kind, m);
    v.color = m.fixedPaint ?? (kind === 'gazelle' ? (this.rnd() < 0.6 ? 0xf2f2ee : 0xe8c21a) : this.pickColor());
    v.vf = 0.88 + this.rnd() * 0.24;
    // разгон/торможение по типу: легковые ~2.5 м/с², ГАЗель ~1.8, автобусы ~1.2; комфортное торможение ~3, экстренное до 7
    const heavy = kind === 'paz' || kind === 'liaz' || kind === 'trolleybus';
    v.T = 1.1 + this.rnd() * 0.6;
    v.aMax = heavy ? 1.1 + this.rnd() * 0.2 : kind === 'gazelle' ? 1.6 + this.rnd() * 0.4 : 2.2 + this.rnd() * 0.6;
    v.b = heavy ? 1.8 + this.rnd() * 0.4 : 2.7 + this.rnd() * 0.5;
    v.jUp = heavy ? 1.3 : kind === 'gazelle' ? 2.2 : 3;
    v.emerg = heavy ? 5 : 7;
    v.aLat = heavy ? 1.8 : 2.4 + this.rnd() * 0.5;
    v.lcTimer = this.rnd() * 3;
    v.beacon = kind === 'police' && this.rnd() < 0.35;
    if (route >= 0) {
      v.route = route; v.piece = piece; v.pieceEdge = pieceEdge;
      v.vf = 0.82 + this.rnd() * 0.1; v.T = 1.6;
      const st = this.net.routes[route].pieces[piece].stops;
      v.nextStop = 0;
      while (v.nextStop < st.length && (st[v.nextStop][0] < pieceEdge || (st[v.nextStop][0] === pieceEdge && st[v.nextStop][1] < s + 2))) v.nextStop++;
      const t = this.net.routes[route].type;
      v.color = t === 'trolleybus' ? [0xeef0f2, 0xe9e4d4, 0x9fc3e0][Math.floor(this.rnd() * 3)]
        : t === 'share_taxi' ? (this.rnd() < 0.6 ? 0xf2f2ee : 0xe8c21a)
        : kind === 'paz' ? [0xe9c22b, 0xeeeeea, 0xd8742a][Math.floor(this.rnd() * 3)] : [0xeeeeea, 0x3f8f4a, 0xe3c32c][Math.floor(this.rnd() * 3)];
    }
    v.seg = lane; v.s = s; v.edge = this.net.laneEdge[lane];
    this.fillPlan(v);
    this.buildPath(v);
    v.v = this.desired(v, lane) * (0.55 + 0.3 * this.rnd());
    this.insert(v);
    this.pose(v);
    v.ox = v.x; v.oy = v.y; v.oz = v.z; v.ofx = v.fx; v.ofy = v.fy; v.ofz = v.fz;
    this.vehicles.push(v);
    if (route >= 0) this.stats.buses++;
    this.stats.spawned++;
    return v;
  }

  private manageBuses(): void {
    const p = this.player, net = this.net, o = this.opts;
    const initial = this.time < 4;
    const have = new Map<number, number>();
    for (const v of this.vehicles) if (v.route >= 0 && !v.crashed) have.set(v.route * 64 + v.piece, (have.get(v.route * 64 + v.piece) ?? 0) + 1);
    let n = this.stats.buses;
    const order = this.pieceCells.map((_, i) => i).sort(() => this.rnd() - 0.5);
    for (const i of order) {
      if (n >= o.maxBuses) break;
      const pc = this.pieceCells[i];
      if (have.get(pc.route * 64 + pc.piece)) continue;
      const cand: number[] = [];
      for (let k = 0; k < pc.xz.length / 2; k++) {
        const d = Math.hypot(pc.xz[k * 2] - p.x, pc.xz[k * 2 + 1] - p.z);
        if (d > o.spawnMax - 50) continue;
        if (!initial && (d < o.spawnMin || this.visible(pc.xz[k * 2], pc.xz[k * 2 + 1]))) continue;
        cand.push(k);
      }
      if (!cand.length) continue;
      const k = cand[Math.floor(this.rnd() * cand.length)];
      const R = net.routes[pc.route];
      const E = net.edges[R.pieces[pc.piece].edges[k]];
      const lane = E.lanes.find((l) => net.laneCls[l] & (CLS_BUS | CLS_CAR)) ?? E.lanes[0];
      if (net.segLen[lane] < 16) continue;
      const kind: VehicleKind = R.type === 'trolleybus' ? 'trolleybus' : R.type === 'share_taxi' ? 'gazelle'
        : (hashStr(R.ref) & 1 ? 'liaz' : 'paz');
      const len = this.models[kind].length;
      const s = Math.min(net.segLen[lane] - 1, len + 1 + this.rnd() * Math.max(net.segLen[lane] - len - 2, 0));
      if (this.spawnCar(lane, s, kind, pc.route, pc.piece, k)) n++;
    }
  }

  remove(v: SimVehicle): void {
    if (!v.alive) return;
    v.alive = false;
    if (!v.crashed) this.unlink(v);
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
    if (v.route >= 0) this.stats.buses--;
    this.stats.despawned++;
  }

  /** Машина стала физическим телом (авария): убрать из полос, дальше поза — из физики. */
  detach(v: SimVehicle): void {
    if (v.crashed) return;
    this.unlink(v);
    v.crashed = true; v.crashT = 0;
    v.detX = v.x; v.detZ = v.z; v.detFx = v.fx; v.detFz = v.fz;
    this.leaveRoute(v);
  }

  /**
   * Вернуть машину из физики в поток (её чуть сдвинули): полоса та же, s — со сдвигом вдоль полосы, боковой сдвиг
   * плавно убирается S-кривой. false — некуда (полосы нет / занято).
   */
  reattach(v: SimVehicle): boolean {
    if (!v.crashed || v.dead || v.seg < 0) return false;
    const h = Math.hypot(v.detFx, v.detFz) || 1, fx = v.detFx / h, fz = v.detFz / h;
    const dx = v.x - v.detX, dz = v.z - v.detZ;
    const along = dx * fx + dz * fz, lat = dx * -fz + dz * fx;
    v.s = Math.max(0, Math.min(this.net.segLen[v.seg], v.s + along));
    const q = this.segVeh[v.seg];
    if (q) for (const o of q) if (Math.abs(o.s - v.s) < Math.max(o.len, v.len) - 0.5) return false;
    v.crashed = false; v.crashT = 0;
    v.v = 0; v.aCur = 0; v.acc = 0; v.ind = 0; v.stuck = 0;
    v.lcFrom = lat; v.lcStart = v.odo; v.lcLen = 10; v.lcOld = -1; v.lcPending = -1; v.lcOff = lat;
    v.hasRear = false;
    v.commits.length = 0;
    this.insert(v);
    this.buildPath(v);
    this.pose(v);
    v.ox = v.x; v.oy = v.y; v.oz = v.z; v.ofx = v.fx; v.ofy = v.fy; v.ofz = v.fz;
    return true;
  }

  /** Отладка: почему машина стоит — лидер / стоп-линия (причина) / препятствие. */
  explain(v: SimVehicle): string {
    const net = this.net, nL = net.nLanes;
    const lst = this.segVeh[v.seg] ?? [];
    const i = lst.indexOf(v);
    if (i + 1 < lst.length) return `leader#${lst[i + 1].id} same seg`;
    let dist = net.segLen[v.seg] - v.s;
    for (const seg of v.path) {
      if (seg >= nL && v.commits.indexOf(seg) < 0 && !this.canEnter(v, seg - nL, dist)) return `stopline ${this.why} d=${dist.toFixed(1)}`;
      const q = this.segVeh[seg];
      if (q && q.length) return `leader#${q[0].id} d=${(dist + q[0].s - q[0].len).toFixed(1)}`;
      dist += net.segLen[seg];
      if (dist > 150) break;
    }
    return `free? path=${v.path.length} open=${v.pathOpen} gap=${v.gap.toFixed(1)}`;
  }

  /** Отладка: пары машин с перекрытием габаритов (в плане), кроме разбитых. */
  overlaps(maxPairs = 20): { a: number; b: number; d: number }[] {
    const out: { a: number; b: number; d: number }[] = [];
    const V = this.vehicles.filter((v) => !v.crashed);
    const cell = new Map<number, SimVehicle[]>();
    for (const v of V) {
      const k = Math.floor(v.x / 20) * 100000 + Math.floor(v.z / 20);
      (cell.get(k) ?? cell.set(k, []).get(k)!).push(v);
    }
    for (const v of V) {
      const cx = Math.floor(v.x / 20), cz = Math.floor(v.z / 20);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const u of cell.get((cx + i) * 100000 + cz + j) ?? []) {
          if (u.id <= v.id || Math.abs(u.y - v.y) > 3) continue;
          const g = obbGap(v, u);
          if (g < -0.3 && out.length < maxPairs) out.push({ a: v.id, b: u.id, d: g });
        }
      }
    }
    return out;
  }
}

/** Зазор между двумя машинами в плане (OBB, разделяющие оси); < 0 — перекрытие. */
export function obbGap(a: { x: number; z: number; fx: number; fz: number; len: number; halfW: number },
  b: { x: number; z: number; fx: number; fz: number; len: number; halfW: number }): number {
  const al = Math.hypot(a.fx, a.fz) || 1, bl = Math.hypot(b.fx, b.fz) || 1;
  const ax = [a.fx / al, a.fz / al], bx = [b.fx / bl, b.fz / bl];
  const axes = [ax, [-ax[1], ax[0]], bx, [-bx[1], bx[0]]];
  const dx = b.x - a.x, dz = b.z - a.z;
  let gap = -Infinity;
  for (const [ux, uz] of axes) {
    const ra = Math.abs(ax[0] * ux + ax[1] * uz) * a.len / 2 + Math.abs(-ax[1] * ux + ax[0] * uz) * a.halfW;
    const rb = Math.abs(bx[0] * ux + bx[1] * uz) * b.len / 2 + Math.abs(-bx[1] * ux + bx[0] * uz) * b.halfW;
    gap = Math.max(gap, Math.abs(dx * ux + dz * uz) - ra - rb);
  }
  return gap;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export { CH_g, CH_o, CH_eq, CH_s_, CH_w, CH_m };
