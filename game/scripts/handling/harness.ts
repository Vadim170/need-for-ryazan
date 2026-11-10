/**
 * Стенд управляемости (docs/stage3/handling.md): детерминированные сценарии на своём полигоне (Rapier, 60 Гц, без рендера).
 * Запуск в Node: `node scripts/handling/run.mjs` (грузит этот модуль через vite SSR). В браузере: `await import('/scripts/handling/harness.ts')`.
 * Машина и конфиги передаются снаружи (Mods), чтобы прогонять и текущий код, и сохранённую базовую версию.
 */
import * as THREE from 'three';
import { RAPIER, PhysicsWorld } from '../../src/physics/world';
import type { VehicleConfig } from '../../src/vehicle/config';
import type { DriveInput } from '../../src/core/input';

/** Минимальный интерфейс машины, который нужен стенду (есть и у старой, и у новой Vehicle). */
export interface CarLike {
  body: RAPIER.RigidBody;
  input: DriveInput;
  cfg: VehicleConfig;
  speed: number;
  forwardSpeed: number;
  slipAngle: number;
  groundedWheels: number;
  gear: number;
  reset(pos?: THREE.Vector3, yaw?: number): void;
}

export interface Mods {
  label: string;
  Vehicle: new (p: PhysicsWorld, cfg: VehicleConfig, spawn: THREE.Vector3, yaw?: number) => CarLike;
  /** 'largus' — машина игрока; иначе вид трафика (sedan, suv, gazelle, paz, liaz, trolleybus, police). */
  makeConfig: (kind: string) => VehicleConfig;
  weatherGrip: { value: number };
}

/** Геометрия процедурных моделей трафика (src/vehicles/procedural, эталоны видов) — для классов GTA-режима. */
export const KIND_GEOM: Record<string, { length: number; width: number; height: number; wheelbase: number; track: number; wheelRadius: number }> = {
  sedan: { length: 4.268, width: 1.7, height: 1.496, wheelbase: 2.476, track: 1.539, wheelRadius: 0.292 },
  police: { length: 4.268, width: 1.7, height: 1.496, wheelbase: 2.476, track: 1.539, wheelRadius: 0.292 },
  suv: { length: 4.315, width: 1.822, height: 1.691, wheelbase: 2.673, track: 1.631, wheelRadius: 0.34 },
  gazelle: { length: 6, width: 2.09, height: 2.446, wheelbase: 3.4, track: 1.889, wheelRadius: 0.36 },
  paz: { length: 7, width: 2.44, height: 2.95, wheelbase: 3.6, track: 2.204, wheelRadius: 0.45 },
  liaz: { length: 11.9, width: 2.5, height: 3, wheelbase: 5.9, track: 2.224, wheelRadius: 0.5 },
  trolleybus: { length: 12, width: 2.55, height: 3.45, wheelbase: 5.9, track: 2.274, wheelRadius: 0.5 },
};

const DT = 1 / 60;
const G = 9.81;
const KMH = 1 / 3.6;
const deg = (r: number) => (r * 180) / Math.PI;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export interface Sample {
  t: number; v: number; vF: number; x: number; s: number; y: number;
  heading: number; roll: number; pitch: number; upY: number;
  latG: number; longG: number; yawRate: number; slip: number; steer: number;
  grounded: number; loads: number[];
}

type Feature = (w: RAPIER.World) => void;
const box = (w: RAPIER.World, x: number, y: number, z: number, hx: number, hy: number, hz: number, rotY = 0, rotX = 0, rotZ = 0) => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, rotZ, 'YXZ'));
  w.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(1));
};

/** Одна машина в своём мире: плоскость 4×4 км + элементы сценария. Курс — по −Z (s = −z), x — вбок (вправо +). */
export class Sim {
  t = 0;
  readonly log: Sample[] = [];
  private prevV = new THREE.Vector3();
  private latEma = 0; private lonEma = 0;
  private q = new THREE.Quaternion();
  steerKb = 0;
  rolled = false;

  private constructor(readonly physics: PhysicsWorld, readonly car: CarLike) {}

  static async create(mods: Mods, cfg: VehicleConfig, features: Feature[] = [], pose = { x: 0, z: 0, yaw: 0 }): Promise<Sim> {
    const physics = await PhysicsWorld.create();
    const w = physics.world;
    w.createCollider(RAPIER.ColliderDesc.cuboid(2000, 1, 2000).setTranslation(0, -1, 0).setFriction(1));
    for (const f of features) f(w);
    const car = new mods.Vehicle(physics, cfg, new THREE.Vector3(pose.x, 1.2, pose.z), pose.yaw);
    car.reset(new THREE.Vector3(pose.x, 1.0 + cfg.suspension.wheelRadius, pose.z), pose.yaw);
    const sim = new Sim(physics, car);
    for (let i = 0; i < 120; i++) sim.tick({}); // осесть на подвеске
    sim.log.length = 0; sim.t = 0; sim.rolled = false;
    return sim;
  }

  dispose(): void { this.physics.world.free(); }

  /** Задать скорость вдоль курса машины (мгновенный «разгон»). */
  setSpeed(kmh: number, lateral = 0): void {
    const r = this.car.body.rotation();
    this.q.set(r.x, r.y, r.z, r.w);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.q).multiplyScalar(kmh * KMH);
    const rt = new THREE.Vector3(1, 0, 0).applyQuaternion(this.q).multiplyScalar(lateral * KMH);
    this.car.body.setLinvel({ x: f.x + rt.x, y: 0, z: f.z + rt.z }, true);
    this.prevV.set(f.x + rt.x, 0, f.z + rt.z);
    // передача по скорости, чтобы коробка не «догоняла» с первой
    const e = this.car.cfg.engine, rr = this.car.cfg.suspension.wheelRadius;
    let g = 1;
    for (; g < e.gearRatios.length; g++) {
      const rpm = ((kmh * KMH) / rr) * e.gearRatios[g - 1] * e.finalDrive * 60 / (2 * Math.PI);
      if (rpm < e.shiftUpRpm * 0.9) break;
    }
    this.car.gear = g;
  }

  /** Клавиатурный руль (как core/input.ts): разгон 4.5/с, возврат/смена знака 8/с. */
  kbSteer(target: number): number {
    const rate = target === 0 || Math.sign(target) !== Math.sign(this.steerKb) ? 8 : 4.5;
    this.steerKb += clamp(target - this.steerKb, -rate * DT, rate * DT);
    return this.steerKb;
  }

  tick(inp: Partial<DriveInput>): Sample {
    Object.assign(this.car.input, { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false }, inp);
    this.physics.update(DT + 1e-9);
    this.t += DT;
    return this.sample();
  }

  sample(): Sample {
    const b = this.car.body, tr = b.translation(), r = b.rotation(), lv = b.linvel(), av = b.angvel();
    const q = this.q.set(r.x, r.y, r.z, r.w);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q), right = new THREE.Vector3(1, 0, 0).applyQuaternion(q), up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const v = new THREE.Vector3(lv.x, lv.y, lv.z);
    const a = v.clone().sub(this.prevV).divideScalar(DT);
    this.prevV.copy(v);
    const hr = new THREE.Vector3(right.x, 0, right.z).normalize(), hf = new THREE.Vector3(fwd.x, 0, fwd.z).normalize();
    const k = 1 - Math.exp(-DT / 0.08); // EMA 80 мс: сырые разности скорости шумят от контактов
    this.latEma += (a.dot(hr) / G - this.latEma) * k;
    this.lonEma += (a.dot(hf) / G - this.lonEma) * k;
    const wheels = (this.car as unknown as { wheels?: { load: number; grounded: boolean }[] }).wheels ?? [];
    if (up.y < 0.3) this.rolled = true;
    const s: Sample = {
      t: this.t, v: v.length(), vF: v.dot(fwd), x: tr.x, s: -tr.z, y: tr.y,
      heading: Math.atan2(fwd.x, -fwd.z), roll: deg(Math.asin(clamp(right.y, -1, 1))), pitch: deg(Math.asin(clamp(fwd.y, -1, 1))), upY: up.y,
      latG: this.latEma, longG: this.lonEma, yawRate: -(av.x * up.x + av.y * up.y + av.z * up.z), slip: deg(this.car.slipAngle), steer: this.car.input.steer,
      grounded: this.car.groundedWheels, loads: wheels.map((wh) => (wh.grounded ? wh.load : 0)),
    };
    this.log.push(s);
    return s;
  }

  /** Удержание скорости газом/тормозом (P-регулятор). */
  hold(kmh: number): Partial<DriveInput> {
    const err = kmh * KMH - this.car.forwardSpeed;
    return { throttle: clamp(0.35 + err * 0.5, 0, 1), brake: err < -2 ? clamp(-err * 0.15, 0, 1) : 0 };
  }

  /** Водитель-робот: чистое преследование + PI по угловой скорости. path(s) → x. */
  follow(path: (s: number) => number, look: number): number {
    const last = this.log[this.log.length - 1] ?? this.sample();
    const v = Math.max(last.v, 3);
    const L = clamp(look * v + 3, 4, 40);
    const tx = path(last.s + L), ts = last.s + L;
    const dx = tx - last.x, ds = ts - last.s;
    // угол на цель относительно курса машины (вправо +)
    const alpha = Math.atan2(dx, ds) - last.heading;
    const al = Math.atan2(Math.sin(alpha), Math.cos(alpha));
    const rDes = (2 * v * Math.sin(al)) / L;
    const c = this.car.cfg;
    const wb = c.chassis.wheelbase;
    const sF = clamp(Math.abs(this.car.forwardSpeed) / c.steering.speedForMin, 0, 1);
    const maxAng = THREE.MathUtils.degToRad(c.steering.maxAngle + (c.steering.minAngle - c.steering.maxAngle) * sF * sF * (3 - 2 * sF));
    const ff = Math.atan((2 * wb * Math.sin(al)) / L) / maxAng;
    this.yawI = clamp(this.yawI + (rDes - last.yawRate) * DT * 2.5, -0.6, 0.6);
    return clamp(ff + (rDes - last.yawRate) * 0.6 + this.yawI, -1, 1);
  }
  yawI = 0;

  maxAbs(key: keyof Sample, from = 0): number {
    let m = 0;
    for (const s of this.log) if (s.t >= from) m = Math.max(m, Math.abs(s[key] as number));
    return m;
  }
}

/* ------------------------------------------------------------------ сценарии ------------------------------------------------------------------ */

export interface Result { [k: string]: number | string | boolean | null }

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Ступенчатый руль: удержание скорости, руль (клавиатура) в упор/половину на 4 с. */
export async function stepSteer(mods: Mods, kind: string, kmh: number, amount: number, grip = 1): Promise<Result> {
  mods.weatherGrip.value = grip;
  const sim = await Sim.create(mods, mods.makeConfig(kind));
  sim.setSpeed(kmh);
  for (let i = 0; i < 60; i++) sim.tick(sim.hold(kmh));
  const t0 = sim.t;
  for (let i = 0; i < 240; i++) sim.tick({ ...sim.hold(kmh), steer: sim.kbSteer(amount) });
  const tail = sim.log.filter((s) => s.t > t0 + 2 && s.t < t0 + 3.5);
  const ss = tail.reduce((a, s) => a + s.yawRate, 0) / Math.max(1, tail.length);
  let t63: number | null = null, peak = 0;
  for (const s of sim.log) {
    if (s.t < t0) continue;
    if (Math.abs(s.yawRate) > Math.abs(peak)) peak = s.yawRate;
    if (t63 === null && Math.abs(s.yawRate) >= 0.63 * Math.abs(ss) && Math.abs(ss) > 0.02) t63 = s.t - t0;
  }
  const spun = sim.log.some((s) => s.t > t0 && Math.abs(s.slip) > 50);
  const minLoad = Math.min(...sim.log.filter((s) => s.t > t0).map((s) => Math.min(...(s.loads.length ? s.loads : [0]))));
  const res: Result = {
    rollover: sim.rolled, spun, maxRoll: r1(sim.maxAbs('roll', t0)), maxLatG: r2(sim.maxAbs('latG', t0)),
    ssYaw: r2(Math.abs(ss)), yawT63: t63 === null ? null : r2(t63), overshoot: Math.abs(ss) > 0.02 ? r2(Math.abs(peak) / Math.abs(ss)) : null,
    maxSlip: r1(sim.maxAbs('slip', t0)), wheelLift: sim.log.some((s) => s.t > t0 && s.grounded < 4), minLoad: Math.round(minLoad),
    endKmh: Math.round(sim.log[sim.log.length - 1].v * 3.6),
  };
  sim.dispose();
  mods.weatherGrip.value = 1;
  return res;
}

/** Слалом: конусы через 18 м по оси курса, проезд с чередованием сторон. Возвращает «прошёл/нет» и максимумы. */
export async function slalomRun(mods: Mods, kind: string, kmh: number, look: number, grip: number): Promise<{ pass: boolean; rolled: boolean; maxRoll: number }> {
  mods.weatherGrip.value = grip;
  const cfg = mods.makeConfig(kind);
  const sim = await Sim.create(mods, cfg);
  const S0 = 60, N = 8, P = 18, A = cfg.chassis.width / 2 + 0.55; // линия водителя: 0.55 м от конуса до борта (проверка — 0.15 м)
  const path = (s: number) => (s < S0 - P ? 0 : s < S0 ? A * 0.5 * (1 - Math.cos((Math.PI * (s - S0 + P)) / P)) : s < S0 + N * P ? A * Math.cos((Math.PI * (s - S0)) / P) : 0);
  sim.setSpeed(kmh);
  let pass = true, next = 0, prevS = sim.sample().s;
  while (sim.t < 30) {
    const st = sim.tick({ ...sim.hold(kmh), steer: sim.follow(path, look) });
    while (next < N && prevS < S0 + next * P && st.s >= S0 + next * P) {
      const want = next % 2 ? -1 : 1; // первый конус — машина справа (+x)
      if (st.x * want < cfg.chassis.width / 2 + 0.15) pass = false;
      next++;
    }
    prevS = st.s;
    if (sim.rolled || Math.abs(st.slip) > 40) pass = false;
    if (!pass || next >= N) break;
  }
  const out = { pass: pass && next >= N, rolled: sim.rolled, maxRoll: sim.maxAbs('roll') };
  sim.dispose();
  mods.weatherGrip.value = 1;
  return out;
}

/** ISO 3888-1 «переставка»: коридоры по ширине машины b, смещение 3.5 м. Проверяются все 4 угла кузова. */
export async function laneChangeRun(mods: Mods, kind: string, kmh: number, look: number, grip: number): Promise<{ pass: boolean; rolled: boolean; maxRoll: number; maxLatG: number }> {
  mods.weatherGrip.value = grip;
  const cfg = mods.makeConfig(kind);
  const sim = await Sim.create(mods, cfg);
  const b = cfg.chassis.width, Lc = cfg.chassis.length, O = 60, off = 3.5;
  const lanes = [
    { a: O, b: O + 15, c: 0, w: 1.1 * b + 0.25 },
    { a: O + 45, b: O + 70, c: off, w: b + 1 },
    { a: O + 95, b: O + 125, c: 0, w: 1.3 * b + 0.25 },
  ];
  const ramp = (s: number, s0: number, s1: number, x0: number, x1: number) => x0 + (x1 - x0) * 0.5 * (1 - Math.cos((Math.PI * clamp((s - s0) / (s1 - s0), 0, 1))));
  const path = (s: number) => (s < O + 15 ? 0 : s < O + 45 ? ramp(s, O + 13, O + 47, 0, off) : s < O + 70 ? off : ramp(s, O + 68, O + 97, off, 0));
  sim.setSpeed(kmh);
  let pass = true;
  const q = new THREE.Quaternion(), c = new THREE.Vector3();
  while (sim.t < 30) {
    const st = sim.tick({ ...sim.hold(kmh), steer: sim.follow(path, look) });
    const r = sim.car.body.rotation(), tr = sim.car.body.translation();
    q.set(r.x, r.y, r.z, r.w);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      c.set((sx * b) / 2, 0, (sz * Lc) / 2).applyQuaternion(q).add(tr as THREE.Vector3);
      const cs = -c.z;
      for (const ln of lanes) if (cs >= ln.a && cs <= ln.b && Math.abs(c.x - ln.c) > ln.w / 2) pass = false;
    }
    if (sim.rolled || Math.abs(st.slip) > 40) pass = false;
    if (!pass || st.s > O + 130) break;
  }
  const out = { pass, rolled: sim.rolled, maxRoll: sim.maxAbs('roll'), maxLatG: sim.maxAbs('latG') };
  sim.dispose();
  mods.weatherGrip.value = 1;
  return out;
}

const LOOKS = [0.12, 0.2, 0.3, 0.45];

/** Максимальная скорость (км/ч), на которой проходит упражнение (лучший из нескольких водителей), шаг 5 км/ч. */
async function maxPass(run: (kmh: number, look: number) => Promise<{ pass: boolean; rolled: boolean }>, from: number, to: number): Promise<{ max: number; rolls: number }> {
  let max = 0, rolls = 0;
  for (let v = from; v <= to; v += 5) {
    let ok = false;
    for (const L of LOOKS) {
      const r = await run(v, L);
      if (r.rolled) rolls++;
      if (r.pass) { ok = true; break; }
    }
    if (!ok) break;
    max = v;
  }
  return { max, rolls };
}

export async function slalom(mods: Mods, kind = 'largus', grip = 1): Promise<Result> {
  const m = await maxPass((v, L) => slalomRun(mods, kind, v, L, grip), 40, 200);
  const at80 = await slalomRun(mods, kind, 80, 0.35, grip), at120 = await slalomRun(mods, kind, 120, 0.35, grip);
  return { maxKmh: m.max, rollovers: m.rolls + (at80.rolled ? 1 : 0) + (at120.rolled ? 1 : 0), pass80: at80.pass, pass120: at120.pass, maxRoll80: r1(at80.maxRoll), maxRoll120: r1(at120.maxRoll) };
}

export async function laneChange(mods: Mods, kind = 'largus', grip = 1): Promise<Result> {
  const m = await maxPass((v, L) => laneChangeRun(mods, kind, v, L, grip), 50, 220);
  const a = await laneChangeRun(mods, kind, 90, 0.35, grip), b = await laneChangeRun(mods, kind, 130, 0.35, grip);
  return { maxKmh: m.max, rollovers: m.rolls + (a.rolled ? 1 : 0) + (b.rolled ? 1 : 0), pass90: a.pass, pass130: b.pass, maxRoll130: r1(b.maxRoll), maxLatG130: r2(b.maxLatG) };
}

/** Круг R: скорость растёт на 1.5 км/ч в секунду, пока водитель держит траекторию (ошибка радиуса < 2.5 м). */
export async function circle(mods: Mods, kind = 'largus', R = 40): Promise<Result> {
  const cfg = mods.makeConfig(kind);
  // старт касательно к окружности с центром справа (x = R)
  const sim = await Sim.create(mods, cfg);
  let kmh = 30, lastOk = 0, maxLat = 0;
  sim.setSpeed(kmh);
  const rollPerG: number[] = [];
  while (sim.t < 90) {
    const last = sim.log[sim.log.length - 1] ?? sim.sample();
    // цель: точка на окружности впереди на дуге look
    const ang = Math.atan2(last.s, last.x - R); // угол позиции относительно центра (R,0) в плоскости (x,s)
    const L = clamp(0.35 * last.v + 3, 5, 30);
    const tAng = ang - L / R; // движение по часовой (поворот вправо)
    const tx = R + R * Math.cos(tAng), ts = R * Math.sin(tAng);
    const al0 = Math.atan2(tx - last.x, ts - last.s) - last.heading;
    const al = Math.atan2(Math.sin(al0), Math.cos(al0));
    const rDes = (2 * last.v * Math.sin(al)) / L;
    const sF = clamp(Math.abs(sim.car.forwardSpeed) / cfg.steering.speedForMin, 0, 1);
    const maxAng = THREE.MathUtils.degToRad(cfg.steering.maxAngle + (cfg.steering.minAngle - cfg.steering.maxAngle) * sF * sF * (3 - 2 * sF));
    sim.yawI = clamp(sim.yawI + (rDes - last.yawRate) * DT * 2.5, -0.6, 0.6);
    const steer = clamp(Math.atan((2 * cfg.chassis.wheelbase * Math.sin(al)) / L) / maxAng + (rDes - last.yawRate) * 0.6 + sim.yawI, -1, 1);
    kmh += 1.5 * DT;
    const st = sim.tick({ ...sim.hold(kmh), steer });
    const rad = Math.hypot(st.x - R, st.s);
    if (sim.t > 6) {
      if (Math.abs(rad - R) > 2.5 || sim.rolled || Math.abs(st.slip) > 30) break;
      lastOk = st.v;
      maxLat = Math.max(maxLat, (st.v * st.v) / R / G);
      if ((st.v * st.v) / R / G < 0.6 && (st.v * st.v) / R / G > 0.2) rollPerG.push(Math.abs(st.roll) / ((st.v * st.v) / R / G));
    }
  }
  const res: Result = {
    maxKmh: Math.round(lastOk * 3.6), maxLatG: r2(maxLat), rollGradient: rollPerG.length ? r2(rollPerG.reduce((a, b) => a + b, 0) / rollPerG.length) : null,
    rollover: sim.rolled, maxRoll: r1(sim.maxAbs('roll')),
  };
  sim.dispose();
  return res;
}

/** 0–100 с места (полный газ) и 0–60. */
export async function launch(mods: Mods, kind = 'largus'): Promise<Result> {
  const sim = await Sim.create(mods, mods.makeConfig(kind));
  let t60: number | null = null, t100: number | null = null;
  while (sim.t < 30 && t100 === null) {
    const st = sim.tick({ throttle: 1 });
    if (t60 === null && st.vF >= 60 * KMH) t60 = st.t;
    if (st.vF >= 100 * KMH) t100 = st.t;
  }
  const res = { t0_60: t60 === null ? null : r2(t60), t0_100: t100 === null ? null : r2(t100), maxPitch: r1(sim.maxAbs('pitch')) };
  sim.dispose();
  return res;
}

/** Торможение 100–0 по прямой; в повороте — то же на дуге R=150 (руль держится). */
export async function braking(mods: Mods, kind = 'largus', turning = false, grip = 1): Promise<Result> {
  mods.weatherGrip.value = grip;
  const sim = await Sim.create(mods, mods.makeConfig(kind));
  sim.setSpeed(100);
  let steer = 0;
  if (turning) {
    // выйти на дугу ~0.5 g (R≈150 м): клавиатурный руль, затем удержание
    const R = 150;
    for (let i = 0; i < 150; i++) {
      const last = sim.log[sim.log.length - 1] ?? sim.sample();
      const rDes = last.v / R;
      sim.yawI = clamp(sim.yawI + (rDes - last.yawRate) * DT * 2.5, -0.6, 0.6);
      steer = clamp((rDes - last.yawRate) * 0.6 + sim.yawI, -1, 1);
      sim.tick({ ...sim.hold(100), steer });
    }
  } else {
    for (let i = 0; i < 30; i++) sim.tick(sim.hold(100));
  }
  const t0 = sim.t, p0 = sim.car.body.translation(), h0 = sim.log[sim.log.length - 1].heading;
  const x0 = p0.x, z0 = p0.z;
  let dist = 0, tStop = 0;
  const startV = sim.log[sim.log.length - 1].v;
  while (sim.t - t0 < 10) {
    const st = sim.tick({ brake: 1, steer });
    if (st.v < 0.5) { const p = sim.car.body.translation(); dist = Math.hypot(p.x - x0, p.z - z0); tStop = sim.t - t0; break; }
  }
  const hs = sim.log.filter((s) => s.t >= t0);
  const res: Result = {
    fromKmh: Math.round(startV * 3.6), dist: r1(dist), time: r2(tStop), maxDecelG: r2(Math.max(...hs.map((s) => -s.longG))),
    maxSlip: r1(sim.maxAbs('slip', t0)), headingChange: r1(Math.abs(deg(hs[hs.length - 1].heading - h0))), maxPitch: r1(sim.maxAbs('pitch', t0)), rollover: sim.rolled,
  };
  sim.dispose();
  mods.weatherGrip.value = 1;
  return res;
}

/** Бордюр 0.15 м: наезд под 30° (60/100 км/ч), и боковой «занос» в бордюр (трип-опрокидывание). */
export async function curb(mods: Mods, kmh: number, mode: 'angle' | 'slide', kind = 'largus'): Promise<Result> {
  const H = 0.15;
  // бордюр — длинный брус вдоль курса справа, верх тротуара на H
  const feats: Feature[] = [(w) => box(w, 3 + 10, H / 2, -150, 10, H / 2, 400)];
  const sim = await Sim.create(mods, mods.makeConfig(kind), feats, { x: 0, z: 0, yaw: mode === 'angle' ? -Math.PI / 6 : 0 });
  if (mode === 'angle') sim.setSpeed(kmh);
  else {
    // скольжение боком: курс вдоль бордюра, скорость: вперёд kmh·cos30, вправо kmh·sin(35°)
    sim.setSpeed(kmh * 0.8, kmh * 0.55);
  }
  const t0 = sim.t;
  let air = 0, maxVy = 0;
  while (sim.t - t0 < 4) {
    const st = sim.tick(mode === 'angle' ? sim.hold(kmh) : { steer: -0.6 });
    if (st.grounded === 0) air += DT;
    maxVy = Math.max(maxVy, sim.car.body.linvel().y);
  }
  const end = sim.log[sim.log.length - 1];
  const res: Result = { rollover: sim.rolled, maxRoll: r1(sim.maxAbs('roll')), maxPitch: r1(sim.maxAbs('pitch')), airTime: r2(air), maxVy: r2(maxVy), uprightEnd: end.upY > 0.9 };
  sim.dispose();
  return res;
}

/** Лежачие полицейские 0.08 м ×3 и трамплин 0.5 м (симметричный и под одну сторону) на скорости. */
export async function bumps(mods: Mods, kmh: number, kind: 'bumps' | 'kicker' | 'kickerSide', car = 'largus'): Promise<Result> {
  const feats: Feature[] = [];
  if (kind === 'bumps') {
    // поперечные «лежачие полицейские»: цилиндр R=0.5 м, утоплен — выступ 0.08 м, ширина ~0.55 м
    for (let i = 0; i < 3; i++) feats.push((w) => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      w.createCollider(RAPIER.ColliderDesc.cylinder(4, 0.5).setTranslation(0, -0.42, -(60 + i * 12)).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(1));
    });
  } else {
    // клин 6 м, подъём 0.5 м
    const len = 6, rise = 0.5, ang = Math.atan2(rise, len), hyp = Math.hypot(len, rise);
    const x = kind === 'kickerSide' ? -0.75 : 0, hw = kind === 'kickerSide' ? 0.6 : 3;
    feats.push((w) => box(w, x, rise / 2 - 0.2 * Math.cos(ang), -63, hw, 0.2, hyp / 2, 0, ang));
  }
  const sim = await Sim.create(mods, mods.makeConfig(car), feats);
  sim.setSpeed(kmh);
  let air = 0, airMax = 0, cur = 0, maxVy = 0, landRoll = 0, landPitch = 0, wasAir = false;
  while (sim.t < 6) {
    const st = sim.tick(sim.hold(kmh));
    if (st.grounded === 0) { cur += DT; air += DT; wasAir = true; } else {
      if (wasAir && cur > 0.1) { landRoll = Math.max(landRoll, Math.abs(st.roll)); landPitch = Math.max(landPitch, Math.abs(st.pitch)); }
      airMax = Math.max(airMax, cur); cur = 0; wasAir = false;
    }
    maxVy = Math.max(maxVy, sim.car.body.linvel().y);
  }
  const end = sim.log[sim.log.length - 1];
  const res: Result = {
    rollover: sim.rolled, maxRoll: r1(sim.maxAbs('roll')), maxPitch: r1(sim.maxAbs('pitch')), airTime: r2(air), longestAir: r2(airMax), maxVy: r2(maxVy),
    landRoll: r1(landRoll), landPitch: r1(landPitch), uprightEnd: end.upY > 0.9, endKmh: Math.round(end.v * 3.6),
  };
  sim.dispose();
  return res;
}

/** Разворот ручником: 60 км/ч, руль в упор + ручник 0.7 с, затем газ 0.6. */
export async function handbrakeTurn(mods: Mods, kind = 'largus', kmh = 60): Promise<Result> {
  const sim = await Sim.create(mods, mods.makeConfig(kind));
  sim.setSpeed(kmh);
  for (let i = 0; i < 20; i++) sim.tick(sim.hold(kmh));
  const t0 = sim.t, h0 = sim.log[sim.log.length - 1].heading;
  let headAt15 = 0, rot = 0, prevH = h0;
  while (sim.t - t0 < 3) {
    const dtp = sim.t - t0;
    const st = sim.tick(dtp < 0.7 ? { steer: sim.kbSteer(-1), handbrake: true, throttle: 0.3 } : { steer: sim.kbSteer(-1), throttle: 0.6 });
    let d = st.heading - prevH; d = Math.atan2(Math.sin(d), Math.cos(d)); rot += d; prevH = st.heading;
    if (dtp <= 1.5) headAt15 = Math.abs(deg(rot));
  }
  const res: Result = { rotAt1_5s: r1(headAt15), rotAt3s: r1(Math.abs(deg(rot))), maxSlip: r1(sim.maxAbs('slip', t0)), maxRoll: r1(sim.maxAbs('roll', t0)), rollover: sim.rolled };
  sim.dispose();
  return res;
}

/**
 * Дрифт: 90 км/ч, вход тормоз+руль (0.35 с) или ручник, далее газ и робот держит угол заноса 30° рулём (P по углу);
 * выход — руль 0, газ 0.3. Метрики: время в окне 15…50°, разворот, время выхода до |slip| < 6°.
 */
export async function drift(mods: Mods, kind = 'largus', entry: 'brake' | 'handbrake' = 'handbrake'): Promise<Result> {
  const sim = await Sim.create(mods, mods.makeConfig(kind), [], { x: 0, z: 0, yaw: 0 });
  sim.setSpeed(90);
  for (let i = 0; i < 30; i++) sim.tick(sim.hold(90));
  const t0 = sim.t;
  let inWin = 0, spun = false, exitT: number | null = null;
  const target = 30;
  while (sim.t - t0 < 7) {
    const d = sim.t - t0;
    const last = sim.log[sim.log.length - 1];
    let inp: Partial<DriveInput>;
    if (d < 0.4) inp = entry === 'brake' ? { brake: 0.8, steer: sim.kbSteer(1) } : { handbrake: true, steer: sim.kbSteer(1), throttle: 0.5 };
    else if (d < 4.5) {
      // slip > 0 — занос вправо… робот: руль = P по ошибке угла (контрруль при перерасходе)
      const e = Math.abs(last.slip) - target;
      inp = { throttle: clamp(0.8 - e * 0.03, 0.2, 1), steer: clamp(sim.kbSteer(clamp(0.5 - e * 0.05, -1, 1)), -1, 1) };
      if (Math.abs(last.slip) > 15 && Math.abs(last.slip) < 50) inWin += 1 / 60;
    } else {
      inp = { throttle: 0, steer: sim.kbSteer(0) }; // выход: отпустить газ и руль
      if (exitT === null && Math.abs(last.slip) < 6) exitT = d - 4.5;
    }
    const st = sim.tick(inp);
    if (Math.abs(st.slip) > 100) spun = true;
  }
  const res: Result = { timeInDrift: r2(inWin), maxSlip: r1(sim.maxAbs('slip', t0)), spun, exitTime: exitT === null ? null : r2(exitT), rollover: sim.rolled, endKmh: Math.round(sim.log[sim.log.length - 1].v * 3.6) };
  sim.dispose();
  return res;
}

/* ------------------------------------------------------------------ набор ------------------------------------------------------------------ */

export type Suite = Record<string, Result>;

export async function runSuite(mods: Mods, opts: { quick?: boolean; only?: string } = {}, log: (s: string) => void = () => {}): Promise<Suite> {
  const out: Suite = {};
  const run = async (name: string, f: () => Promise<Result>) => {
    if (opts.only && !name.includes(opts.only)) return;
    const t = performance.now();
    out[name] = await f();
    log(`${mods.label} ${name} (${((performance.now() - t) / 1000).toFixed(1)}s): ${JSON.stringify(out[name])}`);
  };
  for (const v of [60, 100, 140]) {
    await run(`stepFull${v}`, () => stepSteer(mods, 'largus', v, 1));
    await run(`stepHalf${v}`, () => stepSteer(mods, 'largus', v, 0.5));
  }
  await run('stepFull180', () => stepSteer(mods, 'largus', 180, 1));
  await run('slalom', () => slalom(mods));
  await run('laneChange', () => laneChange(mods));
  await run('circle40', () => circle(mods, 'largus', 40));
  await run('launch', () => launch(mods));
  await run('brake100', () => braking(mods));
  await run('brakeTurn100', () => braking(mods, 'largus', true));
  await run('curbAngle60', () => curb(mods, 60, 'angle'));
  await run('curbAngle100', () => curb(mods, 100, 'angle'));
  await run('curbSlide40', () => curb(mods, 40, 'slide'));
  await run('curbSlide70', () => curb(mods, 70, 'slide'));
  await run('bumps100', () => bumps(mods, 100, 'bumps'));
  await run('kicker100', () => bumps(mods, 100, 'kicker'));
  await run('kickerSide100', () => bumps(mods, 100, 'kickerSide'));
  await run('kickerSide140', () => bumps(mods, 140, 'kickerSide'));
  await run('handbrake60', () => handbrakeTurn(mods));
  await run('driftHB', () => drift(mods, 'largus', 'handbrake'));
  await run('driftBrake', () => drift(mods, 'largus', 'brake'));
  await run('wetStepFull100', () => stepSteer(mods, 'largus', 100, 1, 0.75));
  await run('snowStepFull100', () => stepSteer(mods, 'largus', 100, 1, 0.45));
  await run('snowBrake100', () => braking(mods, 'largus', false, 0.45));
  if (!opts.quick) {
    await run('wetSlalom', () => slalom(mods, 'largus', 0.75));
    await run('snowLaneChange', () => laneChange(mods, 'largus', 0.45));
  }
  for (const k of ['sedan', 'police', 'suv', 'gazelle', 'paz', 'liaz', 'trolleybus']) {
    const v = k === 'paz' || k === 'liaz' || k === 'trolleybus' ? 60 : k === 'gazelle' ? 90 : 120;
    await run(`cls_${k}_stepFull${v}`, () => stepSteer(mods, k, v, 1));
    if (!opts.quick) await run(`cls_${k}_laneChange`, () => laneChange(mods, k));
  }
  return out;
}
