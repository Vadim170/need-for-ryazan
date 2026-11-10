import * as THREE from 'three';
import { WalkGraph, EdgeKind, PoiType, ZONE, type Crossing } from './walk-graph';
import { randomLook, Body, Pose, type Look } from './human-factory';
import { ProceduralPeopleView, LOOK_STRIDE, type PeopleView } from './people-view';
import { RagdollPool, type RagdollResult, type RagdollLook } from './ragdoll';
import type { RoadMask } from './road-mask';

/**
 * Пешеходы: агенты на пешеходном графе (people/walk.json), спавн/деспавн в кольце вокруг игрока, переходы,
 * группы и «сценки» (остановки, лавки, парки, детские площадки), уклонение от машины игрока и «кувырок» при ударе.
 *
 * Без физических тел: всё на CPU в typed arrays (SoA). Столкновение с машиной — проверка по OBB машины только для
 * агентов в радиусе 30 м от неё. Подробности — docs/stage2/people.md.
 */

/** Машина игрока: позиция, скорость (м/с), направление «вперёд» (единичный, x/z). */
export interface PlayerCarState { x: number; y: number; z: number; vx: number; vz: number; fx: number; fz: number; halfLength?: number; halfWidth?: number }
/** Источник машин трафика (для решения «можно переходить» на нерегулируемом переходе). */
export interface TrafficCarsSource { forEachCar(fn: (x: number, z: number, vx: number, vz: number) => void): void }
/**
 * Пешеходная фаза светофора: можно ли переходить «рукав» регулируемого узла. Аргументы: id узла и ребра SUMO
 * (из walk.json: crossings[].sumoJunction / sumoEdge), плюс id узла/ребра roads/graph.json. null — неизвестно (фолбэк-таймер).
 */
export type PedSignalSource = (sumoJunction: string, sumoEdge: string, junction: number, road: number) => boolean | null;

export interface PeopleOptions {
  /** Максимум агентов (при плотности 1 в центре). */
  maxAgents?: number;
  ringMin?: number;
  ringMax?: number;
  heightAt?: (x: number, z: number) => number;
  view?: PeopleView;
  /** Проезжая часть (не шагать туда при уклонении). */
  roadMask?: RoadMask;
  /** Точка занята (здание и т.п.). */
  isBlocked?: (x: number, z: number) => boolean;
  /** Пул рэгдоллов (Rapier) для сбитых; без него — «кувырок» шейдером. */
  ragdolls?: RagdollPool;
  /** Статические препятствия (пропсы): обход на ходу и запрет точек уклонения. */
  obstacles?: ObstacleSource;
}

// состояния
const enum S {
  Free = 0, Walk, WaitPath, WaitCross, Approach, Stand, Sit, Play, Dodge, Fall, Lie, GetUp, Angry, Follow, Enter, Look, Hurry, Ragdoll,
}
const STATE_NAMES = ['free', 'walk', 'waitPath', 'waitCross', 'approach', 'stand', 'sit', 'play', 'dodge', 'fall', 'lie', 'getUp', 'angry', 'follow', 'enter', 'look', 'hurry', 'ragdoll'];
// что делать по приходу (цель)
const enum Goal { None = 0, Enter, BusStop, Bench, Park, Wander }

const LAT_W = [0.75, 0.35, 1.3, 2.2, 0.4, 0.15]; // допустимое боковое смещение по виду ребра (м)
/** Доля попыток спавна прямо на узлы пешеходной улицы (если она в кольце спавна). */
const PED_STREET_SPAWN = 0.12;
const GRAV = 14;
const PRED_N = 16, PRED_DT = 0.1; // прогноз машины: 1.5 с

interface Track { pred: Float32Array; speed: number; omega: number; headPrev: number | null; seen: number }
const newTrack = (): Track => ({ pred: new Float32Array(PRED_N * 4), speed: 0, omega: 0, headPrev: null, seen: 0 });

/**
 * Машины трафика (и любые другие, кроме игрока): fn(id, x, y, z, vx, vz, fx, fz, halfLength, halfWidth) на каждую.
 * id — стабильный между кадрами (для оценки поворота руля).
 */
export type VehicleSource = (fn: (id: number, x: number, y: number, z: number, vx: number, vz: number, fx: number, fz: number,
  halfLength: number, halfWidth: number) => void) => void;
/** Статические препятствия (Props.queryObstacles / isBlocked): столбы, стволы, припаркованные машины, ограды, остановки. */
export interface ObstacleSource {
  /** out: по 6 чисел на фигуру [0 круг | 1 прямоугольник, x, z, a, b, rotY]; возвращает число фигур. */
  queryObstacles(x: number, z: number, r: number, out: number[]): number;
  isBlocked(x: number, z: number, pad?: number): boolean;
}
const TAU = Math.PI * 2;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export class PeopleSystem {
  readonly view: PeopleView;
  readonly root: THREE.Object3D;
  readonly stats = {
    active: 0, target: 0, visible: 0, near: 0, updateMs: 0, pathsPerFrame: 0, pathFails: 0, spawned: 0, despawned: 0,
    waitingAtCrossings: 0, crossing: 0, dodges: 0, hits: 0, hitsByTraffic: 0, ragdolls: 0, flinches: 0, hitWhileDodging: 0, byState: {} as Record<string, number>,
  };
  /** Вызывается при ударе машиной (для звука/HUD). */
  onHit: ((speed: number, x: number, z: number, byPlayer: boolean) => void) | null = null;
  private curPrimary = true;

  private density = 1;
  private max: number;
  private ringMin: number; private ringMax: number; private despawnR: number;
  private heightAt: (x: number, z: number) => number;
  private rnd = rng(20261013);
  private signalSource: PedSignalSource | null = null;
  private traffic: TrafficCarsSource | null = null;
  private player: (() => PlayerCarState | null) | null = null;
  private time = 0;
  private warm = 2.0; // первые секунды — быстрое заполнение (можно спавнить в кадре)
  private localFactor = 1;
  private localAcc = 10;
  private poiAcc = 10;

  // --- SoA
  private cap: number;
  private stateA: Uint8Array; private goal: Uint8Array;
  private px: Float32Array; private py: Float32Array; private pz: Float32Array; private yaw: Float32Array;
  private vel: Float32Array; private vmax: Float32Array; private lat: Float32Array; private latPref: Float32Array;
  private path: (Int32Array | null)[]; private pi: Int32Array; private ps: Float32Array;
  private timer: Float32Array; private phase: Float32Array; private amp: Float32Array; private pose: Uint8Array; private poseP: Float32Array;
  private poi: Int32Array; private homePoi: Int32Array; private leader: Int32Array; private cross: Int32Array;
  private tx: Float32Array; private ty: Float32Array; private tz: Float32Array; private tyaw: Float32Array;
  private vx: Float32Array; private vy: Float32Array; private vz: Float32Array; private tumble: Float32Array; private tumbleV: Float32Array; private tumbleYaw: Float32Array;
  private ylift: Float32Array; private scale: Float32Array; private stride: Float32Array; private look: Float32Array; private bodyA: Uint8Array;
  private free: number[] = [];
  private activeList: Int32Array; private nActive = 0; private slotOf: Int32Array;
  // --- POI «сценки»
  private poiState = new Map<number, number>(); // poi -> число заспавненных статичных агентов (−1 — решено «пусто»)
  private poiCount: Int32Array;
  // --- запросы путей
  private pathQueue: number[] = [];
  // --- светофоры-фолбэк
  private junctionRef = new Map<number, number>();
  // --- сетка для расталкивания
  private hHead = new Int32Array(8192); private hNext: Int32Array;
  // --- матрицы
  private mBuf = new Float32Array(16);
  private mt = new THREE.Matrix4(); private mt2 = new THREE.Matrix4(); private mr = new THREE.Matrix4(); private ms = new THREE.Matrix4();
  private m4 = new THREE.Matrix4(); private q = new THREE.Quaternion(); private v3 = new THREE.Vector3(); private s3 = new THREE.Vector3();
  private frustum = new THREE.Frustum(); private pv = new THREE.Matrix4(); private sphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
  private debugLines: THREE.LineSegments | null = null;
  /** Отладка уклонения: отказы кандидатов [дорога, препятствие, всё ещё на пути]. */
  readonly dbgReject = [0, 0, 0];
  // --- машина игрока: прогноз и реакция
  private roadMask: RoadMask | null; private isBlocked: ((x: number, z: number) => boolean) | null;
  readonly ragdolls: RagdollPool | null;
  /** Прогноз текущей машины (игрок или машина трафика): см. predictCar. */
  private trk: Track = newTrack();
  private playerTrk: Track = newTrack();
  private vehTracks = new Map<number, Track>();
  private vehicleSource: VehicleSource | null = null;
  private vehCar: PlayerCarState = { x: 0, y: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: -1 };
  private obstacles: ObstacleSource | null; private ccx = 0; private ccz = 0; private obstBuf: number[] = []; private frameNo = 0;
  private thrT = -1; private thrLat = 0; private thrNx = 0; private thrNz = 0; private thrPass = 1e9;
  // уклонение как движение: кривая Безье S→C→T, длина, пройдено, скорость/ускорение, точка «смотреть на машину»
  private dCx!: Float32Array; private dCz!: Float32Array; private dLen!: Float32Array; private dS!: Float32Array;
  private dVmax!: Float32Array; private dAcc!: Float32Array; private lookX!: Float32Array; private lookZ!: Float32Array; private runV!: Float32Array;
  // плавное движение: скорость агента (м/с, x/z), сглаженные расталкивание и обход препятствий (как скорости)
  private avx!: Float32Array; private avz!: Float32Array; private sepVX!: Float32Array; private sepVZ!: Float32Array;
  private obsVX!: Float32Array; private obsVZ!: Float32Array;
  private react!: Float32Array; private reactTr!: Uint8Array; private reactDelay!: Float32Array; private resumeS!: Uint8Array;
  private rv = new THREE.Vector3(); private rs = new THREE.Vector3();
  private rlook: RagdollLook = { jacket: new THREE.Color(), pants: new THREE.Color(), head: new THREE.Color(), skin: new THREE.Color() };

  constructor(readonly graph: WalkGraph, opts: PeopleOptions = {}) {
    this.max = opts.maxAgents ?? 1300;
    this.cap = Math.max(this.max + 300, 512);
    this.ringMin = opts.ringMin ?? 40;
    this.ringMax = opts.ringMax ?? 300;
    this.despawnR = this.ringMax + 30;
    this.heightAt = opts.heightAt ?? (() => 0);
    this.roadMask = opts.roadMask ?? null; this.isBlocked = opts.isBlocked ?? null; this.ragdolls = opts.ragdolls ?? null;
    this.obstacles = opts.obstacles ?? null;
    this.view = opts.view ?? new ProceduralPeopleView(this.cap);
    this.root = this.view.root;
    const C = this.cap;
    const f32 = () => new Float32Array(C);
    this.stateA = new Uint8Array(C); this.goal = new Uint8Array(C);
    this.px = f32(); this.py = f32(); this.pz = f32(); this.yaw = f32();
    this.vel = f32(); this.vmax = f32(); this.lat = f32(); this.latPref = f32();
    this.path = new Array(C).fill(null); this.pi = new Int32Array(C); this.ps = f32();
    this.timer = f32(); this.phase = f32(); this.amp = f32(); this.pose = new Uint8Array(C); this.poseP = f32();
    this.poi = new Int32Array(C).fill(-1); this.homePoi = new Int32Array(C).fill(-1); this.leader = new Int32Array(C).fill(-1); this.cross = new Int32Array(C).fill(-1);
    this.tx = f32(); this.ty = f32(); this.tz = f32(); this.tyaw = f32();
    this.vx = f32(); this.vy = f32(); this.vz = f32(); this.tumble = f32(); this.tumbleV = f32(); this.tumbleYaw = f32();
    this.ylift = f32(); this.scale = f32(); this.stride = f32(); this.look = new Float32Array(C * LOOK_STRIDE); this.bodyA = new Uint8Array(C);
    this.activeList = new Int32Array(C); this.slotOf = new Int32Array(C).fill(-1);
    this.hNext = new Int32Array(C);
    this.dCx = f32(); this.dCz = f32(); this.dLen = f32(); this.dS = f32(); this.dVmax = f32(); this.dAcc = f32();
    this.lookX = new Float32Array(C).fill(NaN); this.lookZ = f32(); this.runV = f32();
    this.avx = f32(); this.avz = f32(); this.sepVX = f32(); this.sepVZ = f32(); this.obsVX = f32(); this.obsVZ = f32();
    this.react = new Float32Array(C).fill(-1); this.reactTr = new Uint8Array(C); this.reactDelay = f32(); this.resumeS = new Uint8Array(C);
    this.poiCount = new Int32Array(graph.poiN);
    for (let i = C - 1; i >= 0; i--) this.free.push(i);
  }

  // ================================================================ публичный API
  /** Множитель плотности (время суток): 0 — никого, 1 — день, до 2. */
  setDensityFactor(f: number): void { this.density = Math.max(0, Math.min(2, f)); }
  get densityFactor(): number { return this.density; }
  /** Пешеходные фазы светофоров (traffic/signals.ts → pedestrianWalk). null — фолбэк-таймер. */
  setSignalSource(fn: PedSignalSource | null): void { this.signalSource = fn; }
  setTrafficSource(src: TrafficCarsSource | null): void { this.traffic = src; }
  setPlayerSource(fn: (() => PlayerCarState | null) | null): void { this.player = fn; }
  /** Машины трафика: те же уклонение/удар/рэгдолл, что от машины игрока (кроме «посмотреть вслед»). */
  setVehicleSource(fn: VehicleSource | null): void { this.vehicleSource = fn; }
  setObstacleSource(o: ObstacleSource | null): void { this.obstacles = o; }

  /**
   * Разовый контакт с машиной (для внешних систем): если точка человека внутри габарита машины — удар (рэгдолл/кувырок),
   * иначе — обычная реакция. Возвращает число сбитых.
   */
  hitByVehicle(x: number, y: number, z: number, vx: number, vz: number, yaw: number, halfLength = 2.25, halfWidth = 0.9): number {
    const c = this.vehCar;
    c.x = x; c.y = y; c.z = z; c.vx = vx; c.vz = vz; c.fx = -Math.sin(yaw); c.fz = -Math.cos(yaw);
    c.halfLength = halfLength; c.halfWidth = halfWidth;
    this.trk = newTrack();
    this.predictCar(c, 0);
    const h0 = this.stats.hits;
    for (let k = this.nActive - 1; k >= 0; k--) {
      const i = this.activeList[k];
      const st = this.stateA[i];
      if (st === S.Fall || st === S.Lie || st === S.GetUp || st === S.Ragdoll) continue;
      this.reactToCar(i, c, 0, false);
    }
    this.trk = this.playerTrk;
    return this.stats.hits - h0;
  }

  /** Сколько пешеходов сейчас на переходе (для трафика: уступить). */
  crossingOccupancy(id: number): number {
    let n = 0;
    for (let k = 0; k < this.nActive; k++) if (this.cross[this.activeList[k]] === id && this.stateA[this.activeList[k]] === S.Walk) n++;
    return n;
  }
  /** Пешеходы в радиусе (для трафика): fn(x, z, vx, vz). */
  forEachNear(x: number, z: number, r: number, fn: (x: number, z: number, vx: number, vz: number) => void): void {
    const r2 = r * r;
    for (let k = 0; k < this.nActive; k++) {
      const i = this.activeList[k];
      const dx = this.px[i] - x, dz = this.pz[i] - z;
      if (dx * dx + dz * dz > r2) continue;
      const v = this.stateA[i] === S.Walk || this.stateA[i] === S.Follow ? this.vel[i] : 0;
      fn(this.px[i], this.pz[i], -Math.sin(this.yaw[i]) * v, -Math.cos(this.yaw[i]) * v);
    }
  }

  /** Убрать всех (телепорт игрока и т.п.). */
  clear(): void {
    while (this.nActive > 0) this.despawn(this.activeList[0]);
    this.poiState.clear();
    this.poiCount.fill(0);
    this.warm = 2.0;
  }

  // ================================================================ GTA-режим (src/combat, src/police; docs/stage3/gta-mode.md)
  /** Обход пешеходов в радиусе: fn(i, x, y, z, yaw, down) — down: лежит/падает/рэгдолл. */
  forEachAgent(x: number, z: number, r: number, fn: (i: number, x: number, y: number, z: number, yaw: number, down: boolean) => void): void {
    const r2 = r * r;
    for (let k = 0; k < this.nActive; k++) {
      const i = this.activeList[k];
      const dx = this.px[i] - x, dz = this.pz[i] - z;
      if (dx * dx + dz * dz > r2) continue;
      const st = this.stateA[i];
      if (st === S.Ragdoll) {
        const p = this.ragdolls?.position(i);
        if (p) { fn(i, p.x, p.y - 0.95, p.z, this.yaw[i], true); continue; }
      }
      fn(i, this.px[i], this.py[i], this.pz[i], this.yaw[i], st === S.Fall || st === S.Lie || st === S.GetUp || st === S.Ragdoll);
    }
  }
  /** Жив ли ещё агент i (не удалён). */
  isActive(i: number): boolean { return i >= 0 && this.slotOf[i] >= 0; }
  isDown(i: number): boolean { const st = this.stateA[i]; return st === S.Fall || st === S.Lie || st === S.GetUp || st === S.Ragdoll; }
  /** Ребёнок (их не бьют и не грабят). */
  isKid(i: number): boolean { return this.bodyA[i] === Body.Kid; }

  /** Ругань (src/audio/swear.ts): вызывается, когда человек начинает злиться. who/kind — тип говорящего и ситуация. */
  onShout: ((i: number, who: 'man' | 'woman' | 'elder_m' | 'elder_w' | 'kid', kind: 'miss' | 'hit' | 'bump',
    x: number, y: number, z: number, yaw: number) => void) | null = null;
  private prevS: Uint8Array | null = null;

  /** Переходы в «злится»: ситуация по предыдущему состоянию (увернулся → miss, встаёт после падения → hit, иначе bump). */
  private emitShouts(): void {
    const prev = (this.prevS ??= new Uint8Array(this.stateA.length));
    for (let k = 0; k < this.nActive; k++) {
      const i = this.activeList[k];
      const s = this.stateA[i], p = prev[i];
      prev[i] = s;
      if (s !== S.Angry || p === S.Angry || !this.onShout) continue;
      if (this.rnd() < 0.25) continue; // часть людей молча грозит кулаком
      const b = this.bodyA[i];
      const who = b === Body.Kid ? 'kid' : b === Body.Woman ? 'woman' : b === Body.Elder ? (i % 2 ? 'elder_w' : 'elder_m') : 'man';
      const kind = p === S.Dodge || p === S.Hurry || p === S.Look ? 'miss'
        : p === S.GetUp || p === S.Lie || p === S.Fall || p === S.Ragdoll ? 'hit' : 'bump';
      this.onShout(i, who, kind, this.px[i], this.py[i], this.pz[i], this.yaw[i]);
    }
  }

  /** Удар/выстрел/взрыв: человек падает (рэгдолл у взрослых, иначе кувырок). (vx, vy, vz) — скорость удара, м/с. */
  strike(i: number, vx: number, vy: number, vz: number): boolean {
    if (!this.isActive(i) || this.isDown(i)) return false;
    const sp = Math.max(Math.hypot(vx, vz), 3);
    const l = Math.hypot(vx, vz) || 1;
    const c = this.vehCar;
    c.x = this.px[i]; c.y = this.py[i]; c.z = this.pz[i];
    c.vx = (vx / l) * sp; c.vz = (vz / l) * sp; c.fx = vx / l; c.fz = vz / l;
    this.curPrimary = true;
    this.hit(i, c, sp, 0);
    if (vy > 0) this.vy[i] = Math.max(this.vy[i], vy);
    return true;
  }

  /** Паника: все в радиусе r бегут прочь от (x, z) (бег с огибанием пропсов), лежащие — потом. Возвращает число. */
  panic(x: number, z: number, r: number, except = -1): number {
    let n = 0;
    const r2 = r * r;
    for (let k = 0; k < this.nActive; k++) {
      const i = this.activeList[k];
      if (i === except) continue;
      const st = this.stateA[i];
      if (st === S.Fall || st === S.Lie || st === S.GetUp || st === S.Ragdoll || st === S.Hurry || st === S.Dodge) continue;
      const dx = this.px[i] - x, dz = this.pz[i] - z, d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      this.flee(i, x, z);
      n++;
    }
    return n;
  }

  /** Бежать от точки: цель 18–28 м в сторону от угрозы, лучшая из 7 направлений (проходима). */
  flee(i: number, x: number, z: number): void {
    const st = this.stateA[i];
    if (st === S.Sit) this.py[i] += 0.95 * this.scale[i] - 0.47;
    const hp = this.homePoi[i];
    if (hp >= 0 && this.poiCount[hp] > 0) { this.poiCount[hp]--; this.homePoi[i] = -1; }
    if (this.leader[i] >= 0) this.leader[i] = -1;
    const base = Math.atan2(this.pz[i] - z, this.px[i] - x);
    const dist = 18 + this.rnd() * 10;
    let bx = this.px[i] + Math.cos(base) * dist, bz = this.pz[i] + Math.sin(base) * dist;
    for (const da of [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5]) {
      const a = base + da, cx = this.px[i] + Math.cos(a) * dist, cz = this.pz[i] + Math.sin(a) * dist;
      const mx = this.px[i] + Math.cos(a) * dist * 0.4, mz = this.pz[i] + Math.sin(a) * dist * 0.4;
      if ((this.isBlocked?.(cx, cz) ?? false) || (this.isBlocked?.(mx, mz) ?? false)) continue;
      bx = cx; bz = cz;
      break;
    }
    this.tx[i] = bx; this.tz[i] = bz; this.ty[i] = this.heightAt(bx, bz);
    this.cross[i] = -1;
    const b = this.bodyA[i];
    this.runV[i] = b === Body.Elder ? 2.6 : b === Body.Kid ? 3.8 : 4.2 + this.rnd() * 1.3;
    if (st !== S.Walk && st !== S.Hurry) this.vel[i] = 0; // из стоячего — разгон с нуля
    this.stateA[i] = S.Hurry; this.pose[i] = Pose.Walk;
  }

  /** Поставить нового человека в точку (водитель, выброшенный из угнанной машины). Возвращает индекс или −1. */
  spawnAt(x: number, y: number, z: number, yaw: number): number {
    const i = this.alloc(randomLook(this.rnd, this.rnd() < 0.75 ? Body.Man : Body.Woman));
    if (i < 0) return -1;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.yaw[i] = yaw;
    this.resumeS[i] = S.Free;
    this.stateA[i] = S.Angry; this.pose[i] = Pose.Angry; this.timer[i] = 1.5;
    return i;
  }

  /** Поза «сердится» (грозит кулаком) на t секунд, лицом к (x, z). */
  anger(i: number, x: number, z: number, t = 2): void {
    if (!this.isActive(i) || this.isDown(i)) return;
    this.yaw[i] = Math.atan2(-(x - this.px[i]), -(z - this.pz[i]));
    this.resumeS[i] = S.Free;
    this.stateA[i] = S.Angry; this.pose[i] = Pose.Angry; this.timer[i] = t;
  }

  /** Подойти к точке (x, z) — «драться в ответ»: шаг к игроку, анимация бега. */
  stepToward(i: number, x: number, z: number, dt: number, speed = 3): void {
    if (!this.isActive(i) || this.isDown(i)) return;
    const dx = x - this.px[i], dz = z - this.pz[i], d = Math.hypot(dx, dz);
    if (d < 0.9) { this.yaw[i] = Math.atan2(-dx, -dz); return; }
    const s = Math.min(d - 0.8, speed * dt);
    this.px[i] += (dx / d) * s; this.pz[i] += (dz / d) * s;
    this.py[i] += (this.heightAt(this.px[i], this.pz[i]) - this.py[i]) * Math.min(1, dt * 8);
    this.yaw[i] = Math.atan2(-dx, -dz);
    this.animate(i, speed, dt);
    this.pose[i] = Pose.Walk;
  }

  /** Позиция агента. */
  agentPos(i: number, out: THREE.Vector3): THREE.Vector3 { return out.set(this.px[i], this.py[i], this.pz[i]); }

  // ================================================================ кадр
  update(dt: number, center: THREE.Vector3, camera: THREE.Camera): void {
    const t0 = performance.now();
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const cx = center.x, cz = center.z;
    this.ccx = cx; this.ccz = cz;
    if (this.warm > 0) this.warm -= dt;

    // локальная плотность (по зонам вокруг игрока) — раз в 2 с
    this.localAcc += dt;
    if (this.localAcc > 2) { this.localAcc = 0; this.localFactor = this.sampleLocal(cx, cz); }
    const target = Math.round(this.max * this.density * this.localFactor);
    this.stats.target = target;

    // деспавн далёких
    const dr2 = this.despawnR * this.despawnR;
    for (let k = this.nActive - 1; k >= 0; k--) {
      const i = this.activeList[k];
      const dx = this.px[i] - cx, dz = this.pz[i] - cz;
      if (dx * dx + dz * dz > dr2) this.despawn(i);
    }
    // лишние (ночь наступила): убираем невидимых
    if (this.nActive > target * 1.15 + 20) {
      let extra = Math.min(20, this.nActive - target);
      for (let k = this.nActive - 1; k >= 0 && extra > 0; k--) {
        const i = this.activeList[k];
        if (!this.visible(i, 0) && this.leader[i] < 0) { this.despawn(i); extra--; }
      }
    }
    // сценки у POI (остановки, лавки, площадки, парки)
    this.poiAcc += dt;
    if (this.poiAcc > 0.5) { this.poiAcc = 0; this.populatePois(cx, cz, target); }
    // спавн пешеходов на графе
    const budget = this.warm > 0 ? 400 : 12;
    let tries = 0, spawned = 0;
    while (this.nActive < target && spawned < budget && tries < budget * 4) {
      tries++;
      if (this.trySpawnWalker(cx, cz)) spawned++;
    }
    // пути
    this.processPaths();
    // поведение
    const car = this.player ? this.player() : null;
    this.trk = this.playerTrk;
    if (car) this.predictCar(car, dt);
    this.buildHash();
    this.stats.waitingAtCrossings = 0; this.stats.crossing = 0;
    this.frameNo++;
    for (let k = 0; k < this.nActive; k++) this.step(this.activeList[k], dt, car);
    this.trafficContacts(cx, cz, dt);
    this.trk = this.playerTrk;
    this.ragdolls?.update(dt, (a, r) => this.fromRagdoll(a, r));
    this.emitShouts();
    // снятые в процессе
    this.render(cx, cz, camera);
    this.stats.active = this.nActive;
    this.stats.updateMs = this.stats.updateMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  // ================================================================ спавн
  private zoneWeight(z: number): number {
    let w = 0.1;
    if (z & ZONE.yard) w = Math.max(w, 0.3);
    if (z & ZONE.residential) w = Math.max(w, 0.45);
    if (z & ZONE.park) w = Math.max(w, 0.55);
    if (z & ZONE.commercial) w = Math.max(w, 0.9);
    if (z & ZONE.center) w = Math.max(w, (z & (ZONE.commercial | ZONE.residential | ZONE.park)) ? 1.0 : 0.6);
    if (z & ZONE.industrial) w = Math.min(w, 0.08);
    if (z & ZONE.pedestrianStreet) w = 1.0;
    return w;
  }

  private sampleLocal(cx: number, cz: number): number {
    let s = 0, n = 0;
    for (let k = 0; k < 160; k++) {
      const a = this.rnd() * TAU, r = Math.sqrt(this.rnd()) * this.ringMax;
      const node = this.graph.randomNodeInCell(cx + Math.cos(a) * r, cz + Math.sin(a) * r, this.rnd());
      n++;
      if (node >= 0) s += this.zoneWeight(this.graph.zone[node]);
    }
    // 0.55 средней «городской» плотности ≈ полная загрузка; в чистом поле — минимум
    return Math.min(1, Math.max(0.05, (s / n) / 0.45));
  }

  private ringPoint(cx: number, cz: number): [number, number] {
    const a = this.rnd() * TAU;
    const r0 = this.ringMin, r1 = this.ringMax;
    const r = Math.sqrt(r0 * r0 + this.rnd() * (r1 * r1 - r0 * r0));
    return [cx + Math.cos(a) * r, cz + Math.sin(a) * r];
  }

  /** Видим ли агент/точку камерой ближе maxD (для «не появляться на глазах»). */
  private visibleAt(x: number, y: number, z: number, cx: number, cz: number, maxD: number): boolean {
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz > maxD * maxD) return false;
    this.sphere.center.set(x, y + 0.9, z);
    return this.frustum.intersectsSphere(this.sphere);
  }
  private visible(i: number, _maxD: number): boolean {
    this.sphere.center.set(this.px[i], this.py[i] + 0.9, this.pz[i]);
    return this.frustum.intersectsSphere(this.sphere);
  }

  private alloc(look?: Look): number {
    const i = this.free.pop();
    if (i === undefined) return -1;
    this.slotOf[i] = this.nActive;
    this.activeList[this.nActive++] = i;
    const L = look ?? randomLook(this.rnd);
    this.bodyA[i] = L.body;
    this.scale[i] = L.scale;
    this.vmax[i] = L.speed;
    this.stride[i] = 1.45 * L.scale;
    const o = i * LOOK_STRIDE;
    const lk = this.look;
    lk[o] = L.jacket.r; lk[o + 1] = L.jacket.g; lk[o + 2] = L.jacket.b;
    lk[o + 3] = L.pants.r; lk[o + 4] = L.pants.g; lk[o + 5] = L.pants.b;
    lk[o + 6] = L.head.r; lk[o + 7] = L.head.g; lk[o + 8] = L.head.b; lk[o + 9] = L.bag;
    lk[o + 10] = L.coat; lk[o + 11] = L.girth; lk[o + 12] = L.headScale; lk[o + 13] = L.stoop;
    this.phase[i] = this.rnd() * TAU; this.amp[i] = 0; this.pose[i] = Pose.Walk; this.poseP[i] = this.rnd() * 10;
    this.goal[i] = Goal.None; this.poi[i] = -1; this.homePoi[i] = -1; this.leader[i] = -1; this.cross[i] = -1;
    this.path[i] = null; this.pi[i] = 0; this.ps[i] = 0; this.vel[i] = 0; this.timer[i] = 0;
    this.latPref[i] = (this.rnd() - 0.5) * 1.2; this.lat[i] = this.latPref[i];
    this.tumble[i] = 0; this.tumbleV[i] = 0; this.ylift[i] = 0;
    this.avx[i] = 0; this.avz[i] = 0; this.sepVX[i] = 0; this.sepVZ[i] = 0; this.obsVX[i] = 0; this.obsVZ[i] = 0;
    this.react[i] = -1; this.reactTr[i] = 0; this.reactDelay[i] = (L.body === Body.Kid ? 0.15 : 0.2) + this.rnd() * 0.3;
    this.stats.spawned++;
    return i;
  }

  private despawn(i: number, far = true): void {
    const k = this.slotOf[i];
    if (k < 0) return;
    const last = this.activeList[--this.nActive];
    this.activeList[k] = last; this.slotOf[last] = k;
    this.slotOf[i] = -1;
    if (this.stateA[i] === S.Ragdoll) this.ragdolls?.cancel(i);
    this.stateA[i] = S.Free;
    this.path[i] = null;
    const hp = this.homePoi[i];
    if (hp >= 0 && this.poiCount[hp] > 0) this.poiCount[hp]--;
    this.free.push(i);
    this.stats.despawned++;
    // ведомый: вошёл вместе с ведущим в дверь / уехал — исчезает тоже, иначе идёт один
    const entering = this.stateA[i] === S.Free && this.goal[i] === Goal.Enter;
    const fol: number[] = [];
    for (let kk = 0; kk < this.nActive; kk++) if (this.leader[this.activeList[kk]] === i) fol.push(this.activeList[kk]);
    for (const j of fol) {
      this.leader[j] = -1;
      if (entering || far) this.despawn(j); else this.startNewTrip(j);
    }
  }

  private placeAtNode(i: number, node: number): void {
    const g = this.graph;
    this.px[i] = g.x[node] + (this.rnd() - 0.5) * 0.8; this.py[i] = g.y[node]; this.pz[i] = g.z[node] + (this.rnd() - 0.5) * 0.8;
    this.yaw[i] = this.rnd() * TAU;
  }

  private trySpawnWalker(cx: number, cz: number): boolean {
    const g = this.graph;
    const [x, z] = this.ringPoint(cx, cz);
    let node = g.randomNodeInCell(x, z, this.rnd());
    // пешеходная улица рядом: ~12% попыток спавна — прямо на неё (там всегда людно, docs/stage2/pochtovaya.md)
    if (g.pedNodes.length && this.rnd() < PED_STREET_SPAWN) {
      const pn = g.pedNodes[Math.floor(this.rnd() * g.pedNodes.length)];
      const d2 = (g.x[pn] - cx) ** 2 + (g.z[pn] - cz) ** 2;
      if (d2 >= this.ringMin * this.ringMin && d2 <= this.ringMax * this.ringMax) node = pn;
    }
    if (node < 0) return false;
    if (this.rnd() > this.zoneWeight(g.zone[node])) return false;
    const nx = g.x[node], nz = g.z[node];
    const d2 = (nx - cx) ** 2 + (nz - cz) ** 2;
    if (d2 < this.ringMin * this.ringMin || d2 > this.ringMax * this.ringMax) return false;
    if (this.warm <= 0 && this.visibleAt(nx, g.y[node], nz, cx, cz, 140)) return false;
    // ночью дети не гуляют
    const look = randomLook(this.rnd, this.density < 0.35 && this.rnd() < 0.9 ? (this.rnd() < 0.5 ? Body.Man : Body.Woman) : undefined);
    const i = this.alloc(look);
    if (i < 0) return false;
    this.placeAtNode(i, node);
    this.startNewTrip(i, node);
    // пара: второй рядом, идёт следом бок о бок
    if (this.rnd() < 0.16 && this.nActive < this.cap - 2) {
      const pairKid = look.body === Body.Woman && this.rnd() < 0.35;
      const j = this.alloc(randomLook(this.rnd, pairKid ? Body.Kid : undefined));
      if (j >= 0) {
        this.px[j] = this.px[i] + 0.6; this.py[j] = this.py[i]; this.pz[j] = this.pz[i];
        this.leader[j] = i; this.stateA[j] = S.Follow;
        this.vmax[i] = Math.min(this.vmax[i], this.vmax[j]);
      }
    }
    return true;
  }

  /** Новая цель: POI нужного типа в 50–260 м (A*) или прогулка. */
  private startNewTrip(i: number, fromNode = -1): void {
    const g = this.graph;
    const node = fromNode >= 0 ? fromNode : g.nearestNode(this.px[i], this.pz[i], 40);
    this.cross[i] = -1;
    if (node < 0) { this.stateA[i] = S.Stand; this.timer[i] = 5 + this.rnd() * 10; this.pose[i] = Pose.Walk; return; }
    const r = this.rnd();
    // 55% — к цели (A*), остальные — прогулка по графу
    if (r < 0.55) {
      const want = this.rnd();
      const type = want < 0.36 ? PoiType.Entrance : want < 0.66 ? PoiType.Shop : want < 0.78 ? PoiType.BusStop : want < 0.9 ? PoiType.Park : PoiType.Bench;
      const p = this.pickPoi(g.x[node], g.z[node], type, 40, 240, g.comp[node]);
      if (p >= 0) {
        this.poi[i] = p;
        this.goal[i] = type === PoiType.Entrance || type === PoiType.Shop ? Goal.Enter : type === PoiType.BusStop ? Goal.BusStop :
          type === PoiType.Bench ? Goal.Bench : Goal.Park;
        this.path[i] = Int32Array.of(node, g.poiNode[p]);
        this.stateA[i] = S.WaitPath;
        this.pose[i] = Pose.Walk;
        this.pathQueue.push(i);
        return;
      }
    }
    this.goal[i] = Goal.Wander; this.poi[i] = -1;
    this.setPath(i, g.randomWalk(node, 25 + Math.floor(this.rnd() * 40), this.rnd, 0.5));
  }

  private pickPoi(x: number, z: number, type: number, rmin: number, rmax: number, comp: number): number {
    const g = this.graph;
    for (let k = 0; k < 14; k++) {
      const a = this.rnd() * TAU, r = rmin + this.rnd() * (rmax - rmin);
      const p = g.randomPoiInCell(x + Math.cos(a) * r, z + Math.sin(a) * r, this.rnd());
      if (p >= 0 && g.poiT[p] === type && g.comp[g.poiNode[p]] === comp) return p;
    }
    return -1;
  }

  private setPath(i: number, path: Int32Array): void {
    this.path[i] = path; this.pi[i] = 0; this.ps[i] = 0;
    this.stateA[i] = path.length >= 2 ? S.Walk : S.Stand;
    if (path.length < 2) this.timer[i] = 3;
    this.cross[i] = -1;
  }

  private processPaths(): void {
    const g = this.graph;
    let n = 0;
    const limit = this.warm > 0 ? 40 : 6;
    while (this.pathQueue.length && n < limit) {
      const i = this.pathQueue.shift()!;
      if (this.stateA[i] !== S.WaitPath || !this.path[i]) continue;
      n++;
      const [a, b] = this.path[i]!;
      const p = g.findPath(a, b, 4000);
      if (p && p.length >= 2) this.setPath(i, p);
      else {
        this.stats.pathFails++;
        this.goal[i] = Goal.Wander; this.poi[i] = -1;
        this.setPath(i, g.randomWalk(a, 30, this.rnd, 0.5));
      }
    }
    this.stats.pathsPerFrame = n;
  }

  // ---------------------------------------------------------------- сценки у POI
  private populatePois(cx: number, cz: number, target: number): void {
    const g = this.graph;
    const R = this.ringMax, R2 = (R + 40) ** 2;
    // забываем далёкие решения
    for (const [p] of this.poiState) {
      if ((g.poiX[p] - cx) ** 2 + (g.poiZ[p] - cz) ** 2 > R2) this.poiState.delete(p);
    }
    if (this.nActive >= Math.min(target * 1.3 + 10, this.cap - 8)) return;
    g.forPoisInRadius(cx, cz, R, (p) => {
      if (this.poiState.has(p)) return;
      const t = g.poiT[p];
      if (t !== PoiType.BusStop && t !== PoiType.Bench && t !== PoiType.Playground && t !== PoiType.Park && t !== PoiType.Busker) return;
      const x = g.poiX[p], y = g.poiY[p], z = g.poiZ[p];
      const d2 = (x - cx) ** 2 + (z - cz) ** 2;
      if (d2 > R * R) return;
      if (this.warm <= 0 && this.visibleAt(x, y, z, cx, cz, 120)) return; // решим позже, не на глазах
      const dens = this.density;
      let n = 0;
      const r = this.rnd();
      if (t === PoiType.BusStop) n = Math.floor(r * 5 * dens);
      else if (t === PoiType.Bench) n = r < 0.3 * Math.min(dens, 1.2) ? (this.rnd() < 0.5 ? 2 : 1) : 0;
      else if (t === PoiType.Playground) n = dens > 0.4 && r < 0.45 * dens ? 2 + Math.floor(this.rnd() * 3) : 0;
      else if (t === PoiType.Busker) n = dens > 0.3 && r < 0.75 ? 1 + Math.floor(this.rnd() * 5 * Math.min(dens, 1)) : 0;
      else n = r < 0.3 * dens ? 2 + Math.floor(this.rnd() * 2) : 0;
      this.poiState.set(p, n);
      if (n > 0) this.spawnScene(p, t, n);
    });
  }

  private spawnScene(p: number, t: number, n: number): void {
    const g = this.graph;
    const x = g.poiX[p], y = g.poiY[p], z = g.poiZ[p], r = g.poiR[p];
    const fx = -Math.sin(r), fz = -Math.cos(r); // «вперёд» POI
    const sx = -fz, sz = fx; // вбок
    const mk = (body?: Body): number => {
      const i = this.alloc(randomLook(this.rnd, body));
      if (i >= 0) { this.homePoi[i] = p; this.poiCount[p]++; }
      return i;
    };
    if (t === PoiType.BusStop) {
      for (let k = 0; k < n; k++) {
        const i = mk(); if (i < 0) return;
        const o = (this.rnd() - 0.5) * 4.5, b = (this.rnd() - 0.3) * 1.4;
        this.px[i] = x + sx * o - fx * b; this.pz[i] = z + sz * o - fz * b; this.py[i] = y;
        this.yaw[i] = r + (this.rnd() - 0.5) * 1.6;
        this.stateA[i] = S.Stand; this.timer[i] = 30 + this.rnd() * 120; this.goal[i] = Goal.BusStop;
        this.pose[i] = this.rnd() < 0.25 ? Pose.Phone : Pose.Walk;
      }
    } else if (t === PoiType.Bench) {
      for (let k = 0; k < n; k++) {
        const i = mk(this.rnd() < 0.3 ? Body.Elder : undefined); if (i < 0) return;
        const o = n === 1 ? (this.rnd() - 0.5) * 0.6 : (k === 0 ? -0.45 : 0.45);
        this.sitAt(i, x + sx * o, y, z + sz * o, r);
        this.timer[i] = 40 + this.rnd() * 150;
        this.pose[i] = n === 2 ? Pose.Sit : Pose.Sit;
      }
    } else if (t === PoiType.Playground) {
      for (let k = 0; k < n; k++) {
        const i = mk(Body.Kid); if (i < 0) return;
        this.px[i] = x + (this.rnd() - 0.5) * 8; this.pz[i] = z + (this.rnd() - 0.5) * 8; this.py[i] = y;
        this.stateA[i] = S.Play; this.timer[i] = 0; this.tx[i] = x; this.tz[i] = z; this.ty[i] = y;
        this.vmax[i] = 1.8 + this.rnd() * 1.2;
      }
      const a = mk(this.rnd() < 0.5 ? Body.Woman : Body.Elder);
      if (a >= 0) {
        const ang = this.rnd() * TAU;
        this.px[a] = x + Math.cos(ang) * 7; this.pz[a] = z + Math.sin(ang) * 7; this.py[a] = y;
        this.yaw[a] = Math.atan2(-(x - this.px[a]), -(z - this.pz[a]));
        this.stateA[a] = S.Stand; this.timer[a] = 1e6; this.pose[a] = this.rnd() < 0.4 ? Pose.Phone : Pose.Walk;
      }
    } else if (t === PoiType.Busker) {
      // уличный музыкант (стоит лицом к улице, «играет» — поза разговора) и полукруг слушателей перед ним
      const m = mk(Body.Man); if (m < 0) return;
      this.px[m] = x; this.pz[m] = z; this.py[m] = y; this.yaw[m] = r;
      this.stateA[m] = S.Stand; this.timer[m] = 200 + this.rnd() * 300; this.pose[m] = Pose.Talk; this.goal[m] = Goal.Park;
      for (let k = 1; k < n; k++) {
        const i = mk(); if (i < 0) return;
        const a = (k / n - 0.5) * 2.2, d = 2.4 + this.rnd() * 1.2;
        const ox = fx * Math.cos(a) + sx * Math.sin(a), oz = fz * Math.cos(a) + sz * Math.sin(a);
        this.px[i] = x + ox * d; this.pz[i] = z + oz * d; this.py[i] = y;
        this.yaw[i] = Math.atan2(ox, oz); // лицом к музыканту
        this.stateA[i] = S.Stand; this.timer[i] = 15 + this.rnd() * 60; this.pose[i] = this.rnd() < 0.3 ? Pose.Phone : Pose.Walk; this.goal[i] = Goal.Park;
      }
    } else {
      // парк: компания болтает, стоя кружком
      const ang0 = this.rnd() * TAU;
      for (let k = 0; k < n; k++) {
        const i = mk(); if (i < 0) return;
        const a = ang0 + (k / n) * TAU;
        this.px[i] = x + Math.cos(a) * 0.65 + 1.5; this.pz[i] = z + Math.sin(a) * 0.65; this.py[i] = y;
        this.yaw[i] = Math.atan2(Math.cos(a), Math.sin(a)); // лицом к центру
        this.stateA[i] = S.Stand; this.timer[i] = 40 + this.rnd() * 120; this.pose[i] = Pose.Talk; this.goal[i] = Goal.Park;
      }
    }
  }

  private sitAt(i: number, x: number, y: number, z: number, rot: number): void {
    // сиденье лавки ~0.45 м; таз модели на 0.95 м -> опускаем на 0.5 м (с учётом роста) и сдвигаем назад к спинке
    const s = this.scale[i];
    const fx = -Math.sin(rot), fz = -Math.cos(rot);
    this.px[i] = x - fx * 0.12; this.pz[i] = z - fz * 0.12; this.py[i] = y + 0.47 - 0.95 * s;
    this.yaw[i] = rot;
    this.stateA[i] = S.Sit; this.pose[i] = Pose.Sit;
  }

  // ================================================================ поведение
  private buildHash(): void {
    this.hHead.fill(-1);
    for (let k = 0; k < this.nActive; k++) {
      const i = this.activeList[k];
      const h = this.hashKey(Math.floor(this.px[i] / 1.5), Math.floor(this.pz[i] / 1.5));
      this.hNext[i] = this.hHead[h]; this.hHead[h] = i;
    }
  }
  private hashKey(cx: number, cz: number): number { return ((cx * 73856093) ^ (cz * 19349663)) & 8191; }

  private canCross(i: number, c: Crossing): boolean {
    if (c.signal) {
      let ok: boolean | null = null;
      if (this.signalSource && c.junction >= 0) ok = this.signalSource(c.sumoJunction ?? '', c.sumoEdge ?? '', c.junction, c.road);
      if (ok === null) ok = this.fallbackSignal(c);
      if (!ok) return false;
    }
    // и так смотрим по сторонам: машина близко и едет к переходу — ждём
    return !this.carThreat(c.x, c.z, c.signal ? 2.0 : 4.0, i);
  }

  /**
   * TODO(traffic): фолбэк, пока нет traffic/signals.ts (или узел ему неизвестен): цикл 40 с на узел, две группы направлений
   * (по углу дороги относительно первой встреченной в узле). Пешеходам «зелёный», когда своей дороге красный.
   */
  private fallbackSignal(c: Crossing): boolean {
    const key = c.junction >= 0 ? c.junction : 100000 + c.id;
    const ang = Math.atan2(this.graph.z[c.b] - this.graph.z[c.a], this.graph.x[c.b] - this.graph.x[c.a]);
    let ref = this.junctionRef.get(key);
    if (ref === undefined) { ref = ang; this.junctionRef.set(key, ang); }
    const group = Math.cos(2 * (ang - ref)) > 0 ? 0 : 1;
    const h = Math.sin(key * 12.9898) * 43758.5453;
    const ph = ((this.time / 40 + (h - Math.floor(h))) % 1 + 1) % 1;
    // машины группы 0 едут при ph < 0.5; пешеходы поперёк дороги группы 0 идут, когда её машинам красный (с запасом)
    return group === 0 ? ph > 0.55 && ph < 0.9 : ph > 0.05 && ph < 0.4;
  }

  /** Машина (игрок или трафик) подъедет к точке быстрее, чем за tSafe с? */
  private carThreat(x: number, z: number, tSafe: number, _i: number): boolean {
    let threat = false;
    const test = (cx: number, cz: number, vx: number, vz: number) => {
      if (threat) return;
      const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz);
      if (d > 60) return;
      const v = Math.hypot(vx, vz);
      if (d < 7 && v > 0.5) { threat = true; return; }
      const closing = (dx * vx + dz * vz) / (d || 1);
      if (closing > 1 && d / closing < tSafe + 1.5 && Math.abs(dx * vz - dz * vx) / (v || 1) < 8) threat = true;
    };
    const car = this.player ? this.player() : null;
    if (car) test(car.x, car.z, car.vx, car.vz);
    this.traffic?.forEachCar(test);
    return threat;
  }

  private step(i: number, dt: number, car: PlayerCarState | null): void {
    const st = this.stateA[i];
    const ox0 = this.px[i], oz0 = this.pz[i];
    // реакция на машину игрока
    if (st === S.Ragdoll) return; // тело ведёт Rapier (ragdoll.ts)
    if (car && st !== S.Fall && st !== S.Lie && st !== S.GetUp) this.reactToCar(i, car, dt);
    switch (this.stateA[i]) {
      case S.Walk: this.walk(i, dt); break;
      case S.WaitPath: this.idle(i, dt, 0); break;
      case S.WaitCross: {
        this.stats.waitingAtCrossings++;
        this.idle(i, dt, 0);
        const c = this.graph.crossings[this.cross[i]];
        this.timer[i] += dt;
        // нетерпеливые на нерегулируемом переходе через 40 с всё же идут (если чисто)
        if (this.canCross(i, c)) { this.stateA[i] = S.Walk; this.timer[i] = 0; }
        break;
      }
      case S.Approach: this.approach(i, dt); break;
      case S.Stand: {
        this.idle(i, dt, 0);
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) {
          this.pose[i] = Pose.Walk;
          const hp = this.homePoi[i];
          if (hp >= 0 && this.poiCount[hp] > 0) { this.poiCount[hp]--; this.homePoi[i] = -1; }
          if (this.goal[i] === Goal.BusStop && !this.visible(i, 0)) { this.despawn(i); return; } // уехал на автобусе
          this.goal[i] = Goal.None;
          this.startNewTrip(i);
        }
        break;
      }
      case S.Sit: {
        this.amp[i] = 0;
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) {
          this.pose[i] = Pose.Walk;
          const hp = this.homePoi[i];
          if (hp >= 0 && this.poiCount[hp] > 0) { this.poiCount[hp]--; this.homePoi[i] = -1; }
          const s = this.scale[i];
          this.py[i] += 0.95 * s - 0.47;
          this.startNewTrip(i);
        }
        break;
      }
      case S.Play: this.play(i, dt); break;
      case S.Dodge: this.dodge(i, dt); break;
      case S.Fall: case S.Lie: case S.GetUp: this.fall(i, dt); break;
      case S.Angry: {
        this.idle(i, dt, 0);
        this.faceLook(i, dt); // после уклонения — поворачивается к машине
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) { this.lookX[i] = NaN; this.resume(i); } // уходит, всё ещё грозя кулаком
        break;
      }
      case S.Look: this.lookAtCar(i, dt, car); break;
      case S.Hurry: this.hurry(i, dt); break;
      case S.Follow: this.follow(i, dt); break;
      case S.Enter: {
        this.approach(i, dt);
        break;
      }
    }
    const s2 = this.stateA[i];
    // состояния, где позиция задаётся напрямую (уклонение, бег, падение, сидит): скорость — по факту, для плавного перехода
    if (s2 === S.Dodge || s2 === S.Hurry) { this.avx[i] = (this.px[i] - ox0) / Math.max(dt, 1e-4); this.avz[i] = (this.pz[i] - oz0) / Math.max(dt, 1e-4); }
    else if (s2 === S.Fall || s2 === S.Lie || s2 === S.GetUp || s2 === S.Sit || s2 === S.Ragdoll) { this.avx[i] = 0; this.avz[i] = 0; }
    if (this.obstacles && (s2 === S.Walk || s2 === S.Approach || s2 === S.Play || s2 === S.Follow || s2 === S.Hurry) &&
        (this.px[i] - this.ccx) ** 2 + (this.pz[i] - this.ccz) ** 2 < 14400) this.avoidObstacles(i);
    else { this.obsVX[i] *= 0.9; this.obsVZ[i] *= 0.9; }
    if (this.pose[i] === Pose.Angry && this.stateA[i] === S.Walk) {
      this.poseP[i] -= dt;
      if (this.poseP[i] <= 0) this.pose[i] = Pose.Walk;
    }
  }

  /** Стоит/ждёт: плавно гасит скорость (≤ 3 м/с²), расталкивание — тоже скоростью, без скачков позиции. */
  private idle(i: number, dt: number, _v: number): void {
    this.vel[i] = 0;
    this.separate(i, dt, 0.5);
    this.steerVel(i, this.sepVX[i] * 0.5 + this.obsVX[i], this.sepVZ[i] * 0.5 + this.obsVZ[i], this.py[i], dt, 3, false);
  }

  private walk(i: number, dt: number): void {
    const g = this.graph;
    const P = this.path[i]!;
    // скорость: разгон к vmax (на переходе бодрее)
    const vTarget = this.vmax[i] * (this.cross[i] >= 0 ? 1.18 : 1);
    this.vel[i] = vTarget;
    let k = this.pi[i];
    let a = P[k], b = P[k + 1];
    let L = Math.hypot(g.x[b] - g.x[a], g.z[b] - g.z[a]);
    let e = g.edgeBetween(a, b);
    // прогресс по пути = проекция позиции агента на ребро (морковка всегда впереди него по пути → нет «орбит» вокруг неё),
    // но не меньше 0.3·vTarget (развороты > 90°, толкучка)
    const ex0 = (g.x[b] - g.x[a]) / (L || 1), ez0 = (g.z[b] - g.z[a]) / (L || 1);
    const proj = (this.px[i] - g.x[a]) * ex0 + (this.pz[i] - g.z[a]) * ez0;
    let s = Math.max(this.ps[i] + 0.3 * vTarget * dt, Math.min(proj, this.ps[i] + vTarget * 2 * dt));
    while (s >= L) {
      s -= L;
      k++;
      if (k >= P.length - 1) { this.arrive(i); return; }
      a = P[k]; b = P[k + 1];
      L = Math.hypot(g.x[b] - g.x[a], g.z[b] - g.z[a]);
      const ne = g.edgeBetween(a, b);
      const prevCross = this.cross[i];
      if (ne >= 0 && g.edgeKind[ne] === EdgeKind.Crossing) {
        const c = g.edgeCross[ne];
        if (c !== prevCross) {
          this.cross[i] = c;
          if (c >= 0 && !this.canCross(i, g.crossings[c])) {
            this.pi[i] = k; this.ps[i] = 0;
            this.stateA[i] = S.WaitCross; this.timer[i] = 0;
            this.vel[i] = 0;
            // ждущие стоят чуть разбросанно у бордюра
            this.lat[i] = (this.rnd() - 0.5) * 2.2;
            return;
          }
        }
      } else this.cross[i] = -1;
      e = ne;
    }
    this.pi[i] = k; this.ps[i] = s;
    if (this.cross[i] >= 0) this.stats.crossing++;
    const t = L > 1e-6 ? s / L : 0;
    const cy = g.y[a] + (g.y[b] - g.y[a]) * t;
    // боковое смещение: плавно (≤ 0.5 м/с) к предпочтительному в пределах ширины ребра
    const kind = e >= 0 ? g.edgeKind[e] : EdgeKind.Link;
    const w = LAT_W[kind];
    const want = Math.max(-w, Math.min(w, this.latPref[i]));
    this.lat[i] += Math.max(-0.5 * dt, Math.min(0.5 * dt, want - this.lat[i]));
    // «морковка» в 1.4 м впереди по пути (через узлы), со смещением поперёк своего ребра — угол срезается плавно
    let la = 1.4, kk = k, ss = s, qa = a, qb = b, qL = L;
    while (ss + la > qL && kk + 2 < P.length) { la -= qL - ss; kk++; ss = 0; qa = P[kk]; qb = P[kk + 1]; qL = Math.hypot(g.x[qb] - g.x[qa], g.z[qb] - g.z[qa]); }
    const qt = qL > 1e-6 ? Math.min(1, (ss + la) / qL) : 1;
    const qdx = (g.x[qb] - g.x[qa]) / (qL || 1), qdz = (g.z[qb] - g.z[qa]) / (qL || 1);
    const qe = kk === k ? e : g.edgeBetween(qa, qb);
    const qw = LAT_W[qe >= 0 ? g.edgeKind[qe] : EdgeKind.Link];
    const lat = Math.max(-qw, Math.min(qw, this.lat[i]));
    const tx = g.x[qa] + (g.x[qb] - g.x[qa]) * qt + qdz * lat;
    const tz = g.z[qa] + (g.z[qb] - g.z[qa]) * qt - qdx * lat;
    const lastLeg = kk + 2 >= P.length;
    this.separate(i, dt, 1);
    this.steerTo(i, tx, cy, tz, vTarget, dt, lastLeg);
  }

  /**
   * Рулёжка к точке: желаемая скорость к цели (с торможением к концу, если arrive) + расталкивание + обход пропсов;
   * скорость агента меняется с ограниченным ускорением (радиус поворота ≥ v²/a), позиция = интеграл скорости, корпус
   * поворачивается с ограниченной угловой скоростью. Никаких прямых сдвигов позиции → ноги (вид меряет скорость по
   * смещению) и корпус двигаются плавно при любом dt.
   */
  private steerTo(i: number, x: number, y: number, z: number, vT: number, dt: number, arrive: boolean, acc = 2.6): void {
    const dx = x - this.px[i], dz = z - this.pz[i], d = Math.hypot(dx, dz);
    let v = vT;
    if (arrive) v = Math.min(v, Math.sqrt(2 * acc * 0.8 * d));
    const k = d > 1e-4 ? v / d : 0;
    this.steerVel(i, dx * k + this.sepVX[i] + this.obsVX[i], dz * k + this.sepVZ[i] + this.obsVZ[i], y, dt, acc, true);
  }

  private steerVel(i: number, dvx: number, dvz: number, y: number, dt: number, acc: number, faceMove: boolean): void {
    let ax = dvx - this.avx[i], az = dvz - this.avz[i];
    const al = Math.hypot(ax, az), lim = acc * dt;
    if (al > lim) { ax *= lim / al; az *= lim / al; }
    this.avx[i] += ax; this.avz[i] += az;
    this.px[i] += this.avx[i] * dt; this.pz[i] += this.avz[i] * dt;
    this.py[i] += (y - this.py[i]) * Math.min(1, dt * 6);
    const sp = Math.hypot(this.avx[i], this.avz[i]);
    if (faceMove && sp > 0.2) {
      let d = Math.atan2(-this.avx[i], -this.avz[i]) - this.yaw[i];
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const turn = 4.0 * dt; // ≤ 4 рад/с
      this.yaw[i] += Math.max(-turn, Math.min(turn, d * Math.min(1, dt * 8)));
    }
    this.animate(i, sp, dt);
  }

  /** Плавно тянет агента к точке (x, z), обновляет yaw и анимацию шага. */
  private animate(i: number, speed: number, dt: number): void {
    const run = speed > 2.2;
    this.amp[i] += (Math.min(run ? 1.35 : 1.05, speed / 1.25) - this.amp[i]) * Math.min(1, dt * 5);
    this.phase[i] = (this.phase[i] + (speed / this.stride[i]) * TAU * dt) % (TAU * 100);
  }

  /** Расталкивание: соседи ближе 0.7 м отодвигаются; встречные смещаются вправо. */
  /**
   * Расталкивание как скорость (sepVX/Z, сглажено по времени — без «пинг-понга» соседей): ближе 0.75 м — отталкивание
   * до ~1 м/с; встречный впереди — сдвиг бокового смещения вправо (одно правило на кадр, ≤ 0.6 м/с).
   */
  private separate(i: number, dt: number, mobility: number): void {
    const x = this.px[i], z = this.pz[i];
    const cx = Math.floor(x / 1.5), cz = Math.floor(z / 1.5);
    const fy = this.yaw[i], fx = -Math.sin(fy), fz = -Math.cos(fy);
    const moving = this.stateA[i] === S.Walk;
    let sx = 0, sz = 0, keepRight = false;
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
      for (let j = this.hHead[this.hashKey(cx + ox, cz + oz)]; j >= 0; j = this.hNext[j]) {
        if (j === i || this.leader[j] === i || this.leader[i] === j) continue;
        const dx = x - this.px[j], dz = z - this.pz[j];
        const d2 = dx * dx + dz * dz;
        if (d2 > 6.25 || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        if (d < 0.75) { const f = (0.75 - d) / 0.75 * 1.2; sx += (dx / d) * f; sz += (dz / d) * f; }
        if (moving && !keepRight) {
          const ahead = -(dx * fx + dz * fz);
          if (ahead > 0 && ahead < 2.5 && Math.abs(dx * fz - dz * fx) < 1.0) {
            const jf = this.yaw[j];
            const dot = fx * -Math.sin(jf) + fz * -Math.cos(jf);
            if (dot < -0.3 || this.stateA[j] !== S.Walk) keepRight = true;
          }
        }
      }
    }
    const sl = Math.hypot(sx, sz);
    if (sl > 1.2) { sx *= 1.2 / sl; sz *= 1.2 / sl; }
    const k = Math.min(1, dt * 6);
    this.sepVX[i] += (sx * mobility - this.sepVX[i]) * k; this.sepVZ[i] += (sz * mobility - this.sepVZ[i]) * k;
    if (keepRight) this.lat[i] += 0.6 * dt;
    else if (this.lat[i] > this.latPref[i] + 0.05) this.lat[i] -= 0.15 * dt; // потом не спеша обратно
  }

  private arrive(i: number): void {
    const g = this.graph;
    const p = this.poi[i];
    const goal = this.goal[i];
    this.cross[i] = -1;
    if (p >= 0 && goal !== Goal.None && goal !== Goal.Wander) {
      // последний отрезок — прямо к POI
      this.tx[i] = g.poiX[p]; this.ty[i] = g.poiY[p]; this.tz[i] = g.poiZ[p]; this.tyaw[i] = g.poiR[p];
      if (goal === Goal.BusStop) {
        const r = g.poiR[p], fx = -Math.sin(r), fz = -Math.cos(r);
        const o = (this.rnd() - 0.5) * 4;
        this.tx[i] += -fz * o - fx * this.rnd(); this.tz[i] += fx * o - fz * this.rnd();
      }
      if (goal === Goal.Park) { this.tx[i] += (this.rnd() - 0.5) * 6; this.tz[i] += (this.rnd() - 0.5) * 6; }
      if (goal === Goal.Bench && this.poiCount[p] >= 2) { this.goal[i] = Goal.None; this.startNewTrip(i); return; }
      this.stateA[i] = goal === Goal.Enter ? S.Enter : S.Approach;
      return;
    }
    // прогулка кончилась: новая цель
    this.startNewTrip(i);
  }

  private approach(i: number, dt: number): void {
    const dx = this.tx[i] - this.px[i], dz = this.tz[i] - this.pz[i];
    const d = Math.hypot(dx, dz);
    const v = this.vmax[i] * 0.9;
    if (d < 0.25) {
      const goal = this.goal[i];
      if (this.stateA[i] === S.Enter) { this.goal[i] = Goal.Enter; this.despawn(i, false); return; }
      const p = this.poi[i];
      this.goal[i] = goal;
      if (goal === Goal.Bench && p >= 0) {
        const o = this.poiCount[p] === 0 ? (this.rnd() - 0.5) * 0.5 : 0.45 * (this.rnd() < 0.5 ? -1 : 1);
        const r = this.tyaw[i];
        this.homePoi[i] = p; this.poiCount[p]++;
        this.sitAt(i, this.tx[i] - Math.cos(r) * o, this.ty[i], this.tz[i] + Math.sin(r) * o, r);
        this.timer[i] = 30 + this.rnd() * 120;
        return;
      }
      this.stateA[i] = S.Stand;
      this.vel[i] = 0;
      if (goal === Goal.BusStop) { this.yaw[i] = this.tyaw[i] + (this.rnd() - 0.5) * 1.2; this.timer[i] = 20 + this.rnd() * 90; this.pose[i] = this.rnd() < 0.3 ? Pose.Phone : Pose.Walk; }
      else { this.timer[i] = 8 + this.rnd() * 25; this.pose[i] = this.rnd() < 0.3 ? Pose.Phone : Pose.Walk; }
      return;
    }
    this.separate(i, dt, 0.6);
    this.steerTo(i, this.tx[i], this.ty[i], this.tz[i], v, dt, true);
  }

  private play(i: number, dt: number): void {
    // ребёнок бегает вокруг площадки: случайные точки в радиусе 6 м, иногда стоит
    this.timer[i] -= dt;
    if (this.timer[i] <= 0) {
      if (this.rnd() < 0.25) { this.timer[i] = 1 + this.rnd() * 3; this.vel[i] = 0; this.poseP[i] = 1; }
      else {
        const a = this.rnd() * TAU, r = 1.5 + this.rnd() * 5;
        this.poseP[i] = 0;
        this.timer[i] = 2 + this.rnd() * 4;
        this.tyaw[i] = a; this.vel[i] = r; // запоминаем цель в vel/tyaw (дёшево)
      }
    }
    if (this.poseP[i] > 0.5) { this.idle(i, dt, 0); return; }
    const p = this.homePoi[i];
    const cx = p >= 0 ? this.graph.poiX[p] : this.tx[i], cz = p >= 0 ? this.graph.poiZ[p] : this.tz[i];
    const gx = cx + Math.cos(this.tyaw[i]) * this.vel[i], gz = cz + Math.sin(this.tyaw[i]) * this.vel[i];
    const dx = gx - this.px[i], dz = gz - this.pz[i], d = Math.hypot(dx, dz);
    if (d < 0.3) { this.poseP[i] = 1; this.timer[i] = 0.5 + this.rnd() * 2; return; }
    this.separate(i, dt, 1);
    this.steerTo(i, gx, this.ty[i], gz, this.vmax[i], dt, true, 4);
  }

  private follow(i: number, dt: number): void {
    const l = this.leader[i];
    if (l < 0 || this.stateA[l] === S.Free) { this.leader[i] = -1; this.startNewTrip(i); return; }
    const ls = this.stateA[l];
    if (ls === S.Dodge || ls === S.Fall || ls === S.Lie || ls === S.GetUp || ls === S.Angry) { this.leader[i] = -1; this.startNewTrip(i); return; }
    const fy = this.yaw[l];
    const fx = -Math.sin(fy), fz = -Math.cos(fy);
    // справа от ведущего на 0.6 м, чуть позади
    const tx = this.px[l] - fz * 0.62 - fx * 0.15, tz = this.pz[l] + fx * 0.62 - fz * 0.15;
    if (ls === S.Sit || ls === S.Stand || ls === S.WaitCross || ls === S.WaitPath) {
      if (ls === S.Sit) {
        // садится рядом
        const p = this.homePoi[l];
        if (p >= 0) { this.leader[i] = -1; this.homePoi[i] = p; this.poiCount[p]++; this.sitAt(i, tx, this.py[l] - 0.47 + 0.95 * this.scale[l], tz, this.yaw[l]); this.timer[i] = this.timer[l]; return; }
      }
      this.idle(i, dt, 0);
      const dx = tx - this.px[i], dz = tz - this.pz[i];
      if (dx * dx + dz * dz > 0.04) this.steerTo(i, tx, this.py[l], tz, Math.min(1.2, Math.hypot(dx, dz) * 2), dt, true);
      else if (ls !== S.WaitPath && this.pose[l] === Pose.Walk && ls === S.Stand) this.pose[i] = Pose.Talk;
      if (ls === S.Stand) {
        let d = this.yaw[l] - this.yaw[i]; d = Math.atan2(Math.sin(d), Math.cos(d));
        this.yaw[i] += d * Math.min(1, dt * 3);
      }
      return;
    }
    this.pose[i] = Pose.Walk;
    // идти со скоростью ведущего + поправка к месту рядом с ним (P-регулятор), с тем же ограничением ускорения
    const ex = tx - this.px[i], ez = tz - this.pz[i];
    this.separate(i, dt, 0.5);
    this.steerVel(i, this.avx[l] + ex * 1.5 + this.sepVX[i] + this.obsVX[i], this.avz[l] + ez * 1.5 + this.sepVZ[i] + this.obsVZ[i],
      this.py[l], dt, 3, true);
  }

  // ---------------------------------------------------------------- машина игрока
  /**
   * Прогноз траектории машины на PRED_N·PRED_DT с: постоянная скорость и угловая скорость курса (руль),
   * направление движения — по вектору скорости. Считается раз в кадр (update → predictCar).
   */
  private predictCar(car: PlayerCarState, dt: number): void {
    const v = Math.hypot(car.vx, car.vz);
    this.trk.speed = v;
    // курс по скорости (в заносе машина едет не туда, куда смотрит); при малой скорости — по кузову
    const hx = v > 1 ? car.vx / v : car.fx, hz = v > 1 ? car.vz / v : car.fz;
    const head = Math.atan2(hx, hz);
    if (this.trk.headPrev !== null && dt > 0) {
      let d = head - this.trk.headPrev; d = Math.atan2(Math.sin(d), Math.cos(d));
      this.trk.omega += (Math.max(-1.5, Math.min(1.5, d / dt)) - this.trk.omega) * Math.min(1, dt * 6);
    }
    this.trk.headPrev = head;
    const P = this.trk.pred;
    let x = car.x, z = car.z, h = head;
    for (let k = 0; k < PRED_N; k++) {
      const o = k * 4;
      P[o] = x; P[o + 1] = z; P[o + 2] = Math.sin(h); P[o + 3] = Math.cos(h);
      x += P[o + 2] * v * PRED_DT; z += P[o + 3] * v * PRED_DT; h += this.trk.omega * PRED_DT;
    }
  }

  /**
   * Опасность для точки (x, z): первое время, когда точка внутри (габарит машины + запас), и боковое смещение точки
   * от оси машины в этот момент (знак — сторона). Плюс минимальное боковое расстояние при проезде мимо.
   */
  private threatAt(x: number, z: number, hl: number, hw: number): void {
    const P = this.trk.pred;
    this.thrT = -1; this.thrLat = 0; this.thrNx = 0; this.thrNz = 0; this.thrPass = 1e9;
    for (let k = 0; k < PRED_N; k++) {
      const o = k * 4;
      const rx = x - P[o], rz = z - P[o + 1];
      const along = rx * P[o + 2] + rz * P[o + 3];
      const lat = rx * P[o + 3] - rz * P[o + 2];          // вправо от направления движения: (dz, −dx)
      if (Math.abs(along) < hl + 1.0) this.thrPass = Math.min(this.thrPass, Math.abs(lat));
      if (Math.abs(along) < hl && Math.abs(lat) < hw) {
        this.thrT = k * PRED_DT; this.thrLat = lat; this.thrNx = P[o + 3]; this.thrNz = -P[o + 2];
        return;
      }
    }
  }

  /** primary — машина игрока (сбрасывает ожидание реакции, «посмотреть вслед»); трафик только пугает и сбивает. */
  private reactToCar(i: number, car: PlayerCarState, dt: number, primary = true): void {
    const st = this.stateA[i];
    const dx = this.px[i] - car.x, dz = this.pz[i] - car.z;
    const v = this.trk.speed;
    const reach = v * PRED_N * PRED_DT + 8;
    if (dx * dx + dz * dz > reach * reach) { if (primary && !this.reactTr[i]) this.react[i] = -1; return; }
    if (Math.abs(this.py[i] - car.y) > 4) return; // мост/подземный уровень
    const hl = (car.halfLength ?? 2.25), hw = (car.halfWidth ?? 0.9);
    // удар: точка внутри габарита машины сейчас
    const fwd = dx * car.fx + dz * car.fz, side = dx * -car.fz + dz * car.fx;
    if (Math.abs(fwd) < hl + 0.25 && Math.abs(side) < hw + 0.25 && v > 1.5) {
      if (st === S.Dodge) this.stats.hitWhileDodging++;
      this.curPrimary = primary;
      if (!primary) this.stats.hitsByTraffic++;
      this.hit(i, car, v, side);
      return;
    }
    if (st === S.Dodge || st === S.Angry || st === S.Hurry || st === S.Ragdoll) return;
    if (v < 3) { if (primary && !this.reactTr[i]) this.react[i] = -1; return; } // медленная машина — без реакции
    this.threatAt(this.px[i], this.pz[i], hl + 0.35, hw + 0.45);
    const inPath = this.thrT >= 0 && this.thrT < (v > 8 ? 1.5 : 1.0);
    if (inPath) {
      if (this.react[i] < 0) {
        this.reactTr[i] = primary ? 0 : 1;
        // время реакции: 0.2–0.5 с, у пожилых и сидящих дольше, у детей чуть быстрее
        const b = this.bodyA[i];
        this.react[i] = this.reactDelay[i] + (b === Body.Elder ? 0.15 : 0) + (st === S.Sit ? 0.15 : 0);
      }
      this.react[i] -= dt;
      if (this.react[i] <= 0) { this.react[i] = -1; this.reactTr[i] = 0; this.respond(i, car, hw + 0.45); }
      return;
    }
    if (!primary) return;
    if (!this.reactTr[i]) this.react[i] = -1;
    // мимо, но близко и быстро: остановиться и посмотреть (не на переходе)
    if (v > 7 && this.thrPass < hw + 1.8 && (st === S.Walk || st === S.Stand || st === S.Follow) && this.cross[i] < 0 &&
        dx * dx + dz * dz < 400 && this.rnd() < dt * 3) {
      this.resumeS[i] = st;
      this.stateA[i] = S.Look; this.timer[i] = 0.8 + this.rnd() * 0.8;
      this.tx[i] = car.x; this.tz[i] = car.z;
    }
  }

  /** Машины трафика рядом с игроком: прогноз каждой и реакция людей в её досягаемости (удар, уклонение, бег с перехода). */
  private trafficContacts(cx: number, cz: number, dt: number): void {
    if (!this.vehicleSource) return;
    const c = this.vehCar;
    const R2 = (this.ringMax * 0.6) ** 2;
    const frame = this.frameNo;
    this.vehicleSource((id, x, y, z, vx, vz, fx, fz, hl, hw) => {
      if ((x - cx) ** 2 + (z - cz) ** 2 > R2) return;
      let t = this.vehTracks.get(id);
      if (!t) this.vehTracks.set(id, (t = newTrack()));
      t.seen = frame;
      c.x = x; c.y = y; c.z = z; c.vx = vx; c.vz = vz; c.fx = fx; c.fz = fz; c.halfLength = hl; c.halfWidth = hw;
      this.trk = t;
      this.predictCar(c, dt);
      if (t.speed < 1.5) return;
      const reach = t.speed * PRED_N * PRED_DT + 8, r2 = reach * reach;
      for (let k = this.nActive - 1; k >= 0; k--) {
        const i = this.activeList[k];
        const ddx = this.px[i] - x, ddz = this.pz[i] - z;
        if (ddx * ddx + ddz * ddz > r2) continue;
        const st = this.stateA[i];
        if (st === S.Fall || st === S.Lie || st === S.GetUp || st === S.Ragdoll || st === S.Free) continue;
        this.reactToCar(i, c, dt, false);
      }
    });
    if ((frame & 63) === 0) for (const [id, t] of this.vehTracks) if (frame - t.seen > 30) this.vehTracks.delete(id);
  }

  /**
   * Обход статических препятствий (пропсы): человек выталкивается из столбов/машин/оград (+0.35 м), а боковое смещение
   * на ребре сдвигается в сторону от препятствия — на следующих кадрах он идёт в обход. Раз в 3 кадра на человека, только
   * ближе 120 м к игроку.
   */
  private avoidObstacles(i: number): void {
    const ob = this.obstacles;
    if (!ob || ((i + this.frameNo) % 3) !== 0) return;
    const x = this.px[i], z = this.pz[i];
    const buf = this.obstBuf;
    const n = ob.queryObstacles(x, z, 2.5, buf);
    const fy = this.yaw[i], fx = -Math.sin(fy), fz = -Math.cos(fy);
    let vx = 0, vz = 0;
    for (let k = 0; k < n; k++) {
      const o = k * 6;
      let ex: number, ez: number, d: number;
      if (buf[o] === 0) {
        ex = x - buf[o + 1]; ez = z - buf[o + 2];
        d = Math.hypot(ex, ez) - buf[o + 3];
        const l = Math.hypot(ex, ez) || 1; ex /= l; ez /= l;
      } else {
        // прямоугольник: локальные оси X = (cos, −sin), Z = (sin, cos)
        const c = Math.cos(buf[o + 5]), s = Math.sin(buf[o + 5]);
        const dx = x - buf[o + 1], dz = z - buf[o + 2];
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        const qx = Math.max(-buf[o + 3], Math.min(buf[o + 3], lx)), qz = Math.max(-buf[o + 4], Math.min(buf[o + 4], lz));
        let nx = lx - qx, nz = lz - qz;
        d = Math.hypot(nx, nz);
        if (d < 1e-4) { // внутри: наружу через ближайшую грань
          const px = buf[o + 3] - Math.abs(lx), pz = buf[o + 4] - Math.abs(lz);
          if (px < pz) { nx = Math.sign(lx) || 1; nz = 0; d = -px; } else { nx = 0; nz = Math.sign(lz) || 1; d = -pz; }
        } else { nx /= d; nz /= d; }
        ex = nx * c + nz * s; ez = -nx * s + nz * c;
      }
      const pad = 0.35;
      // отталкивание скоростью (до ~1.4 м/с у самой кромки), применяется каждый кадр через steer — без скачков
      if (d < pad + 0.25) { const f = Math.min(1.4, (pad + 0.25 - d) * 2.5); vx += ex * f; vz += ez * f; }
      // препятствие впереди по ходу: предпочтительное боковое смещение — в сторону от него (lat меняется плавно в walk)
      const ox = -ex, oz = -ez;
      if (this.stateA[i] === S.Walk && d < 1.6 && ox * fx + oz * fz > 0.3) {
        const side = ex * -fz + ez * fx; // + — препятствие слева от направления → уходим вправо
        this.latPref[i] = Math.max(-1, Math.min(1, this.latPref[i] + (side >= 0 ? -0.15 : 0.15)));
      }
    }
    const vl = Math.hypot(vx, vz);
    if (vl > 1.4) { vx *= 1.4 / vl; vz *= 1.4 / vl; }
    this.obsVX[i] += (vx - this.obsVX[i]) * 0.5; this.obsVZ[i] += (vz - this.obsVZ[i]) * 0.5;
  }

  /** Решение после задержки реакции: к бордюру (на переходе), шаг в сторону, назад — или замереть. */
  private respond(i: number, car: PlayerCarState, hwz: number): void {
    const st = this.stateA[i];
    const g = this.graph;
    // на переходе (на проезжей части): к ближайшему бордюру вдоль перехода
    if (st === S.Walk && this.cross[i] >= 0 && this.roadMask?.onRoad(this.px[i], this.pz[i], 0) !== false) {
      const c = g.crossings[this.cross[i]];
      const da = Math.hypot(this.px[i] - g.x[c.a], this.pz[i] - g.z[c.a]), db = Math.hypot(this.px[i] - g.x[c.b], this.pz[i] - g.z[c.b]);
      const n = da < db ? c.a : c.b;
      this.tx[i] = g.x[n]; this.ty[i] = g.y[n]; this.tz[i] = g.z[n];
      this.runV[i] = this.bodyA[i] === Body.Elder ? 2.2 : 3.4;
      this.stateA[i] = S.Hurry; this.pose[i] = Pose.Walk;
      this.stats.dodges++;
      return;
    }
    // шаг из коридора: сначала на «свою» сторону (дальше от оси машины), потом на другую, потом назад
    const lat = this.thrLat, nx = this.thrNx, nz = this.thrNz;
    const ttc = this.thrT; // через сколько машина будет здесь
    const acc = this.dodgeAcc(i);
    const sideA = lat >= 0 ? 1 : -1;
    const opts: [number, number][] = [];
    const needA = hwz + 0.35 - Math.abs(lat), needB = hwz + 0.35 + Math.abs(lat);
    if (needA <= 2.2) opts.push([nx * sideA * Math.max(needA, 0.8), nz * sideA * Math.max(needA, 0.8)]);
    if (needA <= 1.6) opts.push([nx * sideA * (needA + 0.6), nz * sideA * (needA + 0.6)]);
    // на другую сторону — если ближняя сторона упирается в дорогу (тогда прыжок длиннее, до 2.9 м)
    if (needB <= 2.9) opts.push([-nx * sideA * needB, -nz * sideA * needB]);
    // по диагонали назад от машины (к фасадам/оградам), в обе стороны
    const bx = this.px[i] - car.x, bz = this.pz[i] - car.z, bl = Math.hypot(bx, bz) || 1;
    opts.push([nx * sideA * 1.2 + bx / bl * 0.8, nz * sideA * 1.2 + bz / bl * 0.8]);
    opts.push([-nx * sideA * (needB + 0.2) + bx / bl * 0.6, -nz * sideA * (needB + 0.2) + bz / bl * 0.6]);
    // два прохода: сначала только точки подальше от проезжей части (к фасадам/оградам), потом любые безопасные
    for (let pass = 0; pass < 2; pass++) for (const [ox, oz] of opts) {
      const x = this.px[i] + ox, z = this.pz[i] + oz;
      if (!this.walkable(x, z) || !this.walkable(this.px[i] + ox * 0.5, this.pz[i] + oz * 0.5)) {
        this.dbgReject[this.roadMask?.onRoad(x, z, 0.3) ? 0 : 1]++; continue;
      }
      if (pass === 0 && this.roadMask && this.roadMask.onRoad(x, z, 1.3)) continue;
      this.threatAt(x, z, (car.halfLength ?? 2.25) + 0.3, hwz - 0.1);
      if (this.thrT >= 0) { this.dbgReject[2]++; this.threatAt(this.px[i], this.pz[i], (car.halfLength ?? 2.25) + 0.35, hwz); continue; }
      // успеет ли: разворот 0.15 с + разгон/торможение; из коридора выходит примерно на 3/4 пути
      const d = Math.hypot(ox, oz);
      if (ttc >= 0 && 0.15 + 2 * Math.sqrt(d / acc) * 0.75 > ttc + 0.2) { this.dbgReject[2]++; continue; }
      this.startDodge(i, car, x, z, d);
      return;
    }
    // некуда или поздно: съёжиться и отшатнуться назад от машины на 0.3–0.5 м (без «прыжка»)
    this.stats.flinches++;
    const fl = 0.3 + this.rnd() * 0.2;
    const fx = this.px[i] + (bx / bl) * fl, fz = this.pz[i] + (bz / bl) * fl;
    if (this.walkable(fx, fz)) this.startDodge(i, car, fx, fz, 0);
    else this.startDodge(i, car, this.px[i], this.pz[i], 0);
  }

  private walkable(x: number, z: number): boolean {
    if (this.roadMask && this.roadMask.onRoad(x, z, 0.3)) return false;
    if (this.isBlocked && this.isBlocked(x, z)) return false;
    if (this.obstacles && this.obstacles.isBlocked(x, z, 0.35)) return false;
    return true;
  }

  /** Ускорение рывка в сторону, м/с²: взрослые 10–13, пожилые 6, дети 9. */
  private dodgeAcc(i: number): number {
    const b = this.bodyA[i];
    return b === Body.Elder ? 6 : b === Body.Kid ? 9 : 10 + this.reactDelay[i] * 6;
  }

  /**
   * Уклонение — непрерывное движение: разворот к направлению ухода (~0.15 с), разгон до 4–6 м/с (пожилые до 3) по короткой
   * кривой Безье к цели с торможением к концу (v ≤ √(2·a·остаток)), потом разворот к машине и «сердится». Смещение за кадр
   * никогда не больше v·dt, поэтому вид (gltf-people-view) меряет скорость по движению и крутит бег с нужным темпом.
   * flinch (dist ≈ 0) — отшатнуться на месте/назад на 0.3–0.5 м с клипом испуга.
   */
  private startDodge(i: number, car: PlayerCarState, x: number, z: number, dist: number): void {
    const st = this.stateA[i];
    if (st === S.Sit) this.py[i] += 0.95 * this.scale[i] - 0.47;
    this.resumeS[i] = st === S.Walk || st === S.Follow ? S.Walk : st === S.Sit ? S.Free : st;
    if (st === S.Follow) { this.resumeS[i] = S.Free; this.leader[i] = -1; }
    const hp = this.homePoi[i];
    if (st === S.Sit && hp >= 0 && this.poiCount[hp] > 0) { this.poiCount[hp]--; this.homePoi[i] = -1; }
    const sx = this.px[i], sz = this.pz[i];
    this.vx[i] = sx; this.vz[i] = sz; // старт
    this.tx[i] = x; this.tz[i] = z; this.ty[i] = this.py[i];
    const dx = x - sx, dz = z - sz, L = Math.hypot(dx, dz);
    // контрольная точка: середина + немного «по инерции» вперёд по текущему направлению (кривая, а не ломаная)
    const hx = -Math.sin(this.yaw[i]), hz = -Math.cos(this.yaw[i]);
    const keep = (st === S.Walk || st === S.Follow) ? Math.min(0.35 * L, 0.6) : 0;
    let cx = sx + dx * 0.5 + hx * keep, cz = sz + dz * 0.5 + hz * keep;
    if (keep > 0 && !this.walkable(cx, cz)) { cx = sx + dx * 0.5; cz = sz + dz * 0.5; }
    this.dCx[i] = cx; this.dCz[i] = cz;
    // длина кривой (8 отрезков)
    let len = 0, px = sx, pz = sz;
    for (let k = 1; k <= 8; k++) {
      const t = k / 8, u = 1 - t;
      const qx = u * u * sx + 2 * u * t * cx + t * t * x, qz = u * u * sz + 2 * u * t * cz + t * t * z;
      len += Math.hypot(qx - px, qz - pz); px = qx; pz = qz;
    }
    this.dLen[i] = len; this.dS[i] = 0;
    const b = this.bodyA[i];
    this.dVmax[i] = dist > 0 ? (b === Body.Elder ? 3 : b === Body.Kid ? 4.5 : 4.6 + (0.5 - this.reactDelay[i]) * 4) : 1.6;
    this.dAcc[i] = this.dodgeAcc(i);
    this.vel[i] = Math.min(this.vel[i], 2); // была скорость ходьбы — с неё и разгоняемся
    this.tyaw[i] = L > 0.05 ? Math.atan2(-dx, -dz) : Math.atan2(-(car.x - sx), -(car.z - sz)); // куда развернуться
    this.lookX[i] = car.x; this.lookZ[i] = car.z;
    this.timer[i] = 0;
    this.stateA[i] = S.Dodge;
    // ноги: бег/шаг по фактической скорости (pose Walk); клип испуга — только для отшатывания на месте (≤ 0.5 м)
    this.pose[i] = dist > 0 ? Pose.Walk : Pose.Dodge;
    this.stats.dodges++;
  }

  private dodge(i: number, dt: number): void {
    this.timer[i] += dt;
    const T = 0.15; // разворот к направлению ухода
    // поворот корпуса: быстро, но не мгновенно (≤ 14 рад/с)
    let dy = this.tyaw[i] - this.yaw[i]; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw[i] += Math.max(-14 * dt, Math.min(14 * dt, dy));
    const L = this.dLen[i];
    const rest = L - this.dS[i];
    // во время разворота уже начинаем движение, но медленно (не более 1.5 м/с)
    const turning = this.timer[i] < T && Math.abs(dy) > 0.5;
    const vCap = turning ? 1.5 : this.dVmax[i];
    const vStop = Math.sqrt(Math.max(0, 2 * this.dAcc[i] * rest)); // успеть остановиться к концу
    const vT = Math.min(vCap, vStop);
    const a = this.dAcc[i];
    this.vel[i] += Math.max(-a * 1.3 * dt, Math.min(a * dt, vT - this.vel[i]));
    if (this.vel[i] < 0) this.vel[i] = 0;
    const step = this.vel[i] * dt;
    this.dS[i] = Math.min(L, this.dS[i] + step);
    if (L > 0.02) {
      const t = this.dS[i] / L, u = 1 - t;
      const sx = this.vx[i], sz = this.vz[i];
      let qx = u * u * sx + 2 * u * t * this.dCx[i] + t * t * this.tx[i];
      let qz = u * u * sz + 2 * u * t * this.dCz[i] + t * t * this.tz[i];
      // параметр Безье ≠ длина дуги: смещение за кадр жёстко ограничиваем v·dt
      const mx = qx - this.px[i], mz = qz - this.pz[i], m = Math.hypot(mx, mz);
      if (m > step * 1.02 && m > 1e-6) { qx = this.px[i] + mx / m * step; qz = this.pz[i] + mz / m * step; }
      if (m > 1e-4 && !turning) {
        // корпус — по касательной к пути
        let d2 = Math.atan2(-mx, -mz) - this.yaw[i]; d2 = Math.atan2(Math.sin(d2), Math.cos(d2));
        this.yaw[i] += d2 * Math.min(1, dt * 10);
      }
      this.px[i] = qx; this.pz[i] = qz;
    }
    this.py[i] += (this.ty[i] - this.py[i]) * Math.min(1, dt * 8);
    // старая (процедурная) модель: амплитуда шага и фаза по скорости
    this.animate(i, this.vel[i], dt);
    const arrived = this.dS[i] >= L - 0.01 && this.vel[i] < 0.25;
    if (arrived || this.timer[i] > 2.5) {
      this.vel[i] = 0;
      this.stateA[i] = S.Angry; this.pose[i] = Pose.Angry; this.timer[i] = 1.0 + this.rnd() * 1.2;
    }
  }

  /** Повернуться к точке lookX/Z (машина) с ограниченной скоростью поворота. */
  private faceLook(i: number, dt: number): void {
    if (Number.isNaN(this.lookX[i])) return;
    const ty = Math.atan2(-(this.lookX[i] - this.px[i]), -(this.lookZ[i] - this.pz[i]));
    let d = ty - this.yaw[i]; d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw[i] += Math.max(-6 * dt, Math.min(6 * dt, d));
  }

  /** После испуга/падения: вернуться к своему делу (идти дальше по пути) или к новой цели. */
  private resume(i: number): void {
    const r = this.resumeS[i];
    this.pose[i] = Pose.Angry; this.poseP[i] = 3 + this.rnd() * 3; // ещё немного ворчит на ходу
    if (r === S.Walk && this.path[i] && this.pi[i] < this.path[i]!.length - 1) { this.stateA[i] = S.Walk; return; }
    if (r === S.Stand) { this.stateA[i] = S.Stand; this.timer[i] = 2 + this.rnd() * 6; this.pose[i] = Pose.Walk; return; }
    this.goal[i] = Goal.None; this.homePoi[i] = -1;
    this.startNewTrip(i);
  }

  private hurry(i: number, dt: number): void {
    // бегом к бордюру по переходу, потом — новая цель от этого узла
    const dx = this.tx[i] - this.px[i], dz = this.tz[i] - this.pz[i], d = Math.hypot(dx, dz);
    if (d < 0.3) {
      this.cross[i] = -1;
      this.pose[i] = Pose.Angry; this.poseP[i] = 3;
      this.goal[i] = Goal.None;
      this.startNewTrip(i);
      return;
    }
    // разгон/торможение (a ≈ 6 м/с²) до скорости бега runV (бордюр 3.3 м/с, паника 4–5.5); пока корпус не развернулся — медленно
    const vMax = this.runV[i] > 0 ? this.runV[i] : 3.3;
    const ty = Math.atan2(-dx, -dz);
    let dy = ty - this.yaw[i]; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw[i] += Math.max(-10 * dt, Math.min(10 * dt, dy));
    const vT = Math.min(vMax * Math.max(0.25, Math.cos(Math.min(Math.abs(dy), 1.4))), Math.sqrt(2 * 6 * d) + 0.3);
    const acc = this.bodyA[i] === Body.Elder ? 4 : 6;
    this.vel[i] += Math.max(-acc * 1.5 * dt, Math.min(acc * dt, vT - this.vel[i]));
    const step = Math.min(d, Math.max(0, this.vel[i]) * dt);
    this.px[i] += (dx / d) * step; this.pz[i] += (dz / d) * step;
    this.py[i] += (this.ty[i] - this.py[i]) * Math.min(1, step / Math.max(d, 1e-3));
    this.animate(i, this.vel[i], dt);
  }

  private lookAtCar(i: number, dt: number, car: PlayerCarState | null): void {
    this.idle(i, dt, 0);
    if (car) { this.tx[i] = car.x; this.tz[i] = car.z; }
    const ty = Math.atan2(-(this.tx[i] - this.px[i]), -(this.tz[i] - this.pz[i]));
    let d = ty - this.yaw[i]; d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw[i] += d * Math.min(1, dt * 6);
    this.timer[i] -= dt;
    if (this.timer[i] <= 0) {
      const r = this.resumeS[i];
      this.stateA[i] = r === S.Follow && this.leader[i] >= 0 ? S.Follow : r === S.Stand ? S.Stand : S.Walk;
      if (this.stateA[i] === S.Stand) this.timer[i] = 3 + this.rnd() * 5;
      if (this.stateA[i] === S.Walk && !this.path[i]) this.startNewTrip(i);
    }
  }

  private hit(i: number, car: PlayerCarState, speed: number, side: number): void {
    const st = this.stateA[i];
    if (st === S.Sit) this.py[i] += 0.95 * this.scale[i] - 0.47;
    const hp = this.homePoi[i];
    if (hp >= 0 && this.poiCount[hp] > 0) { this.poiCount[hp]--; this.homePoi[i] = -1; }
    this.leader[i] = -1; this.cross[i] = -1;
    this.resumeS[i] = S.Free;
    this.stats.hits++;
    this.onHit?.(speed, this.px[i], this.pz[i], this.curPrimary);
    // настоящий рэгдолл (взрослые; пул ограничен), иначе — «кувырок» шейдером
    if (this.ragdolls && this.bodyA[i] !== Body.Kid && speed > 2.5) {
      const k = Math.min(speed, 16) / Math.max(speed, 1e-3);
      const sgn = Math.sign(side) || 1;
      this.rv.set(car.vx * k * 0.9 + -car.fz * sgn * 1.5, 1.5 + Math.min(speed, 20) * 0.12, car.vz * k * 0.9 + car.fx * sgn * 1.5);
      // вращение: «подсечка» — вокруг горизонтальной оси, перпендикулярной удару
      const hl = Math.hypot(this.rv.x, this.rv.z) || 1;
      const w = 3 + Math.min(speed, 20) * 0.25;
      this.rs.set(this.rv.z / hl * w, (this.rnd() - 0.5) * 3, -this.rv.x / hl * w);
      const o = i * LOOK_STRIDE, lk = this.look;
      this.rlook.jacket.setRGB(lk[o], lk[o + 1], lk[o + 2]);
      this.rlook.pants.setRGB(lk[o + 3], lk[o + 4], lk[o + 5]);
      this.rlook.head.setRGB(lk[o + 6], lk[o + 7], lk[o + 8]);
      const sk = lk[o + 11] * 37 % 1;
      this.rlook.skin.setRGB(0.78 + 0.15 * sk, 0.58 + 0.18 * sk, 0.47 + 0.18 * sk);
      if (this.ragdolls.launch(i, this.px[i], this.py[i] + 0.02, this.pz[i], this.yaw[i], this.scale[i], this.rlook, this.rv, this.rs)) {
        this.stateA[i] = S.Ragdoll; this.timer[i] = 0;
        this.stats.ragdolls++;
        return;
      }
    }
    const k = Math.min(speed, 14) / Math.max(speed, 1e-3);
    const sgn = Math.sign(side) || 1;
    this.vx[i] = car.vx * k * 0.75 + -car.fz * sgn * 2.5;
    this.vz[i] = car.vz * k * 0.75 + car.fx * sgn * 2.5;
    this.vy[i] = 2.5 + Math.min(speed, 20) * 0.12;
    this.tumble[i] = 0;
    this.tumbleV[i] = 6 + Math.min(speed, 20) * 0.35; // + = заваливается назад (на спину)
    this.tumbleYaw[i] = Math.atan2(-this.vx[i], -this.vz[i]);
    this.yaw[i] = this.tumbleYaw[i] + Math.PI; // спиной по ходу удара → падает на спину
    this.ylift[i] = Math.max(0, this.py[i] - this.heightAt(this.px[i], this.pz[i]));
    this.stateA[i] = S.Fall; this.pose[i] = Pose.Fallen; this.timer[i] = 0;
  }

  /** Рэгдолл улёгся: человек лежит в его позе и встаёт (обычная анимация подъёма). */
  private fromRagdoll(i: number, r: RagdollResult): void {
    if (this.slotOf[i] < 0) return;
    this.px[i] = r.x; this.pz[i] = r.z;
    const gy = this.heightAt(r.x, r.z);
    this.ylift[i] = Math.min(0.16, Math.max(0, r.y - 0.12 - gy));
    this.py[i] = gy + this.ylift[i] + 0.02;
    // tumble +π/2 — лежит на спине, голова в локальном +Z; −π/2 — лицом вниз, голова в −Z (вперёд)
    if (r.faceUp) { this.tumble[i] = Math.PI / 2; this.yaw[i] = Math.atan2(r.headX, r.headZ); }
    else { this.tumble[i] = -Math.PI / 2; this.yaw[i] = Math.atan2(-r.headX, -r.headZ); }
    this.stateA[i] = S.Lie; this.pose[i] = Pose.Fallen; this.timer[i] = 0.3 + this.rnd() * 0.5;
  }

  private fall(i: number, dt: number): void {
    const st = this.stateA[i];
    const ground = this.heightAt(this.px[i], this.pz[i]) + Math.min(this.ylift[i], 0.16) + 0.02;
    if (st === S.Fall) {
      this.vy[i] -= GRAV * dt;
      this.px[i] += this.vx[i] * dt; this.pz[i] += this.vz[i] * dt; this.py[i] += this.vy[i] * dt;
      this.tumble[i] += this.tumbleV[i] * dt;
      if (this.py[i] <= ground && this.vy[i] < 0) {
        this.py[i] = ground;
        this.vy[i] = -this.vy[i] * 0.25;
        this.vx[i] *= 0.55; this.vz[i] *= 0.55;
        this.tumbleV[i] *= 0.5;
        if (Math.hypot(this.vx[i], this.vz[i]) < 1.2 && Math.abs(this.vy[i]) < 1.0) {
          this.stateA[i] = S.Lie; this.timer[i] = 1.4 + this.rnd() * 1.2;
          this.vx[i] = this.vz[i] = this.vy[i] = 0;
        }
      }
      this.timer[i] += dt;
      if (this.timer[i] > 4) { this.stateA[i] = S.Lie; this.timer[i] = 1.5; }
    } else if (st === S.Lie) {
      // докатиться до ближайшего «лежит» (±π/2 по модулю 2π)
      const want = Math.sin(this.tumble[i]) >= 0 ? Math.PI / 2 : -Math.PI / 2;
      const d = want - this.tumble[i];
      this.tumble[i] += Math.atan2(Math.sin(d), Math.cos(d)) * Math.min(1, dt * 6);
      this.py[i] += (ground - this.py[i]) * Math.min(1, dt * 10);
      this.timer[i] -= dt;
      if (this.timer[i] <= 0 && !this.view.holdDown?.(i)) { this.stateA[i] = S.GetUp; this.timer[i] = 0; this.tumbleV[i] = this.tumble[i]; }
    } else {
      // встаёт
      this.timer[i] += dt;
      const t = Math.min(1, this.timer[i] / 0.8);
      const e = t * t * (3 - 2 * t);
      const target = this.tumbleV[i] - Math.atan2(Math.sin(this.tumbleV[i]), Math.cos(this.tumbleV[i]));
      this.tumble[i] = this.tumbleV[i] + (target - this.tumbleV[i]) * e;
      this.py[i] = ground;
      this.pose[i] = t < 0.6 ? Pose.Fallen : Pose.Walk;
      if (t >= 1) {
        this.tumble[i] = 0;
        this.stateA[i] = S.Angry; this.pose[i] = Pose.Angry; this.timer[i] = 2 + this.rnd() * 1.5;
        this.py[i] = ground;
      }
    }
  }

  // ================================================================ отрисовка
  private render(cx: number, cz: number, camera: THREE.Camera): void {
    const view = this.view;
    view.begin(this.time);
    let vis = 0, near = 0;
    const cam = camera.position;
    const counts: Record<string, number> = {};
    for (let k = 0; k < this.nActive; k++) {
      const i = this.activeList[k];
      const sn = STATE_NAMES[this.stateA[i]];
      counts[sn] = (counts[sn] ?? 0) + 1;
      if (this.stateA[i] === S.Ragdoll) continue;
      const x = this.px[i], y = this.py[i], z = this.pz[i];
      const dc2 = (x - cam.x) ** 2 + (z - cam.z) ** 2;
      if (dc2 > 225) { // ближе 15 м — всегда (тени)
        this.sphere.center.set(x, y + 0.9, z);
        if (!this.frustum.intersectsSphere(this.sphere)) continue;
      }
      const s = this.scale[i];
      // матрица: T(pos) · R(yaw) · [кувырок вокруг центра масс: T(0,c) · Rx · T(0,−c)] · S
      this.q.setFromAxisAngle(this.v3.set(0, 1, 0), this.yaw[i]);
      this.m4.compose(this.s3.set(x, y, z), this.q, this.v3.set(s, s, s));
      const tb = this.tumble[i];
      if (tb !== 0) {
        const c = 0.9 * s;
        const lie = -(c - 0.14) * Math.abs(Math.sin(tb));
        this.mt.makeTranslation(0, c + lie / 1, 0);
        this.mr.makeRotationX(tb);
        this.mt2.makeTranslation(0, -c, 0);
        this.q.setFromAxisAngle(this.v3.set(0, 1, 0), this.yaw[i]);
        this.m4.compose(this.s3.set(x, y, z), this.q, this.v3.set(1, 1, 1));
        this.m4.multiply(this.mt).multiply(this.mr).multiply(this.mt2).multiply(this.ms.makeScale(s, s, s));
      }
      this.m4.toArray(this.mBuf);
      const o = i * LOOK_STRIDE;
      const lk = this.look;
      lk[o + 14] = this.phase[i]; lk[o + 15] = this.amp[i]; lk[o + 16] = this.pose[i]; lk[o + 17] = this.poseP[i];
      const nearOne = dc2 < 70 * 70;
      view.push(this.mBuf, 0, lk, o, nearOne, this.bodyA[i]);
      vis++; if (nearOne) near++;
    }
    view.end(this.time);
    this.stats.visible = vis; this.stats.near = near;
    this.stats.byState = counts;
    void cx; void cz;
  }

  // ================================================================ отладка
  /** Показать рёбра графа в радиусе r вокруг точки (цвет по виду ребра). */
  showGraph(scene: THREE.Scene, x: number, z: number, r = 250): void {
    this.hideGraph(scene);
    const g = this.graph;
    const pos: number[] = [], col: number[] = [];
    const C = [[0.2, 0.4, 1], [0.1, 0.8, 0.1], [1, 0, 0], [0.8, 0.1, 0.8], [1, 0.6, 0], [0, 0.9, 0.9]];
    for (let a = 0; a < g.n; a++) {
      if ((g.x[a] - x) ** 2 + (g.z[a] - z) ** 2 > r * r) continue;
      for (let k = g.start[a]; k < g.start[a + 1]; k++) {
        const b = g.adj[k];
        if (b < a) continue;
        const c = C[g.edgeKind[g.adjEdge[k]]];
        pos.push(g.x[a], g.y[a] + 0.12, g.z[a], g.x[b], g.y[b] + 0.12, g.z[b]);
        col.push(...c, ...c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.debugLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
    this.debugLines.renderOrder = 999;
    scene.add(this.debugLines);
  }
  hideGraph(scene: THREE.Scene): void {
    if (this.debugLines) { scene.remove(this.debugLines); this.debugLines.geometry.dispose(); this.debugLines = null; }
  }

  /** Отладка: ряд людей всех типов и поз у точки (смотрят на +X… вдоль ряда по Z). */
  debugLineup(x: number, y: number, z: number, n = 14): number[] {
    const ids: number[] = [];
    for (let k = 0; k < n; k++) {
      const i = this.alloc(randomLook(this.rnd, (k % 4) as Body));
      if (i < 0) break;
      this.px[i] = x; this.py[i] = y; this.pz[i] = z + k * 1.2;
      this.yaw[i] = -Math.PI / 2; // лицом к +X
      this.stateA[i] = S.Stand; this.timer[i] = 1e6;
      this.pose[i] = [Pose.Walk, Pose.Talk, Pose.Phone, Pose.Angry, Pose.Dodge][k % 5];
      if (k >= 10) { this.stateA[i] = S.Sit; this.pose[i] = Pose.Sit; this.py[i] = y + 0.47 - 0.95 * this.scale[i]; }
      ids.push(i);
    }
    return ids;
  }
  /** Отладка: фаза/амплитуда шага агенту (для проверки анимации на месте). */
  debugAnim(i: number, phase: number, amp: number): void { this.phase[i] = phase; this.amp[i] = amp; }

  /** Сводка по агентам для автоматических проверок. */
  debugAgents(limit = 2000): { x: number; y: number; z: number; state: string; edgeKind: number; crossing: number; body: number }[] {
    const out = [];
    const g = this.graph;
    for (let k = 0; k < Math.min(this.nActive, limit); k++) {
      const i = this.activeList[k];
      let ek = -1;
      const P = this.path[i];
      if (P && this.stateA[i] === S.Walk && this.pi[i] < P.length - 1) {
        const e = g.edgeBetween(P[this.pi[i]], P[this.pi[i] + 1]);
        ek = e >= 0 ? g.edgeKind[e] : -1;
      }
      out.push({ x: this.px[i], y: this.py[i], z: this.pz[i], state: STATE_NAMES[this.stateA[i]], edgeKind: ek, crossing: this.cross[i], body: this.bodyA[i] });
    }
    return out;
  }
}
