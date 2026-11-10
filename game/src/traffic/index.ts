import * as THREE from 'three';
import type { PhysicsWorld, RAPIER } from '../physics/world';
import { TrafficNet } from './net';
import { SignalController } from './signals';
import { TrafficSim, type Obstacle, type SimOptions } from './sim';
import { TrafficRenderer } from './render';
import { TrafficPhysics } from './physics';
import { buildVehicleModels, trafficUniforms, routeBoards } from './models';

export interface TrafficDeps {
  physics: PhysicsWorld;
  scene: THREE.Scene;
  envMap?: THREE.Texture | null;
  /** Тело машины игрока и её габарит (для торможения перед игроком и аварий). */
  player: { body: RAPIER.RigidBody; length: number; width: number };
  /** Высота рельефа (крен кузова по поперечному уклону дороги). */
  heightAt?: (x: number, z: number) => number;
}

/**
 * Трафик и общественный транспорт (docs/stage2/traffic.md).
 * Симуляция идёт фиксированным шагом физики (60 Гц, в onPreStep), отрисовка интерполирует позы.
 */
export class Traffic {
  readonly renderer: TrafficRenderer;
  readonly physics: TrafficPhysics;
  private obstacles: Obstacle[] = [];
  private lightsOn = false;
  private playerObs: Obstacle = { x: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: -1, halfLen: 2.3, halfW: 0.9 };
  enabled = true;
  private peds: PedestrianSource | null = null;
  private pedPool: Obstacle[] = [];
  /** Внешние неподвижные препятствия (закрытые ж/д переезды, src/rail: Rail.crossingObstacles) — добавляются каждый шаг. */
  extraObstacles: readonly Obstacle[] = [];
  private ghostPool: Obstacle[] = [];

  private constructor(readonly net: TrafficNet, readonly signals: SignalController, readonly sim: TrafficSim, private deps: TrafficDeps) {
    this.renderer = new TrafficRenderer(deps.scene, sim.models, sim.opts.maxVehicles + 50, deps.envMap);
    // таблички маршрутов (реальные номера OSM-маршрутов Рязани) на маршрутках/автобусах/троллейбусах
    this.renderer.routeCell = (v) => { const r = net.routes[v.route]; return r ? routeBoards.cell(r.type, r.ref) : 0; };
    this.renderer.fakeCells = [...new Set(net.routes.filter((r) => r.type === 'share_taxi').map((r) => r.ref))].map((ref) => routeBoards.cell('share_taxi', ref));
    this.physics = new TrafficPhysics(deps.physics, sim, sim.models, deps.player.body, deps.player);
    this.playerObs.halfLen = deps.player.length / 2; this.playerObs.halfW = deps.player.width / 2;
    deps.physics.onPreStep((dt) => this.fixedStep(dt));
  }

  static async create(baseUrl: string, deps: TrafficDeps, opts: Partial<SimOptions> = {}): Promise<Traffic | null> {
    const net = await TrafficNet.load(baseUrl);
    if (!net) return null;
    const signals = new SignalController(net);
    const sim = new TrafficSim(net, signals, buildVehicleModels(), { heightAt: deps.heightAt, ...opts });
    return new Traffic(net, signals, sim, deps);
  }

  /** Множитель плотности (время суток): 1 — расчётная, ночь ~0.1, час пик ~1.15. */
  setDensityFactor(f: number): void { this.sim.densityFactor = Math.max(0, f); }
  /** Потолок числа машин (без автобусов). */
  setMaxVehicles(n: number): void { this.sim.opts.maxVehicles = n; }
  /** Пешеходы (src/people: forEachNear) — машины тормозят перед людьми на полосе и на переходах. */
  setPedestrianSource(fn: PedestrianSource | null): void { this.peds = fn; }
  /** GTA-режим: игрок пересел (другая машина) или идёт пешком (капсула ~0.6 м) — трафик тормозит и бьётся о новое тело. */
  setPlayer(body: RAPIER.RigidBody, length: number, width: number, vehicle = true): void {
    this.deps.player = { body, length, width };
    this.playerObs.halfLen = length / 2; this.playerObs.halfW = width / 2;
    this.physics.setPlayer(body, { length, width }, vehicle);
  }
  /** Фары и габариты (ночь). */
  setHeadlights(on: boolean): void { this.lightsOn = on; this.renderer.headlights = on ? 1 : 0; }
  get headlights(): boolean { return this.lightsOn; }

  private fixedStep(dt: number): void {
    if (!this.enabled) return;
    const b = this.deps.player.body;
    const t = b.translation(), lv = b.linvel(), r = b.rotation();
    const po = this.playerObs;
    po.x = t.x; po.z = t.z; po.vx = lv.x; po.vz = lv.z;
    po.fx = -(2 * (r.x * r.z + r.w * r.y)); po.fz = -(1 - 2 * (r.x * r.x + r.y * r.y));
    this.obstacles.length = 0;
    this.obstacles.push(po);
    for (const c of this.physics.crashedVehicles()) {
      const v = c.v;
      this.obstacles.push({ x: v.x, z: v.z, vx: 0, vz: 0, fx: v.fx, fz: v.fz, halfLen: v.len / 2, halfW: v.halfW });
    }
    if (this.peds) {
      let n = 0;
      this.peds(t.x, t.z, PED_RADIUS, (x, z, vx, vz) => {
        let o = this.pedPool[n];
        if (!o) this.pedPool.push((o = { x: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: -1, halfLen: 0.3, halfW: 0.3, ped: true }));
        o.x = x; o.z = z; o.vx = vx; o.vz = vz;
        this.obstacles.push(o);
        n++;
      });
    }
    // машины посреди смены полосы: кузов ещё частично в старом ряду — препятствие и для старого ряда
    let ng = 0;
    for (const v of this.sim.vehicles) {
      if (v.crashed || v.lcFrom === 0 || Math.abs(v.lcOff) < 0.6) continue;
      let o = this.ghostPool[ng++];
      if (!o) this.ghostPool.push((o = { x: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: -1, halfLen: 2, halfW: 0.9 }));
      o.x = v.x; o.z = v.z; o.vx = v.fx * v.v; o.vz = v.fz * v.v; o.fx = v.fx; o.fz = v.fz;
      o.halfLen = v.len / 2; o.halfW = v.halfW; o.self = v.id;
      this.obstacles.push(o);
    }
    for (const o of this.extraObstacles) this.obstacles.push(o);
    this.sim.setObstacles(this.obstacles);
    this.sim.setPlayer(t.x, t.z);
    this.sim.step(dt);
    this.physics.preStep(dt);
  }

  /** Каждый кадр после physics.update: камера (для спавна вне кадра) и отрисовка. */
  update(dt: number, camera: THREE.Camera): void {
    trafficUniforms.uTime.value += dt;
    const d = camera.getWorldDirection(_dir);
    const l = Math.hypot(d.x, d.z) || 1;
    this.sim.setCamera(camera.position.x, camera.position.y, camera.position.z, d.x / l, 0, d.z / l);
    this.renderer.update(this.sim.vehicles, this.deps.physics.timestep.alpha, camera, dt);
  }

  /** Для миникарты: обход машин (x, z, крупная ли). */
  forEachDot(cb: (x: number, z: number, big: boolean) => void): void {
    for (const v of this.sim.vehicles) cb(v.x, v.z, v.len > 5.5);
  }

  /** Отладка (window.__game.traffic). */
  debug() {
    const sim = this.sim, net = this.net;
    return {
      sim, net, signals: this.signals, physics: this.physics, renderer: this.renderer,
      stats: () => ({ ...sim.stats, vehicles: sim.vehicles.length, ...this.physics.stats, drawn: this.renderer.stats.drawn,
        avgSpeedKmh: +(sim.vehicles.reduce((a, v) => a + v.v, 0) / Math.max(sim.vehicles.length, 1) * 3.6).toFixed(1) }),
      overlaps: () => sim.overlaps(),
      /** Машины в радиусе r от (x, z): скорость, полоса, сигнал впереди. */
      near: (x: number, z: number, r = 60) => sim.vehicles.filter((v) => Math.hypot(v.x - x, v.z - z) < r).map((v) => {
        const c = v.path[0] !== undefined && v.path[0] >= net.nLanes ? v.path[0] - net.nLanes : -1;
        return {
          id: v.id, kind: v.kind, kmh: +(v.v * 3.6).toFixed(1), seg: v.seg, edge: net.edges[v.edge]?.id, toEnd: +(net.segLen[v.seg] - v.s).toFixed(1),
          next: c >= 0 ? `${net.connDir[c]}:${String.fromCharCode(this.signals.connCode(c))}` : '', bus: v.route >= 0 ? net.routes[v.route].ref : '',
          dwell: +v.dwell.toFixed(1), crashed: v.crashed, x: +v.x.toFixed(1), z: +v.z.toFixed(1),
        };
      }),
      /** Светофоры около точки: узел, подходы, цвета. */
      lights: (x: number, z: number, r = 150) => {
        const out: { junction: string; approaches: { edge: string; color: number; walk: boolean | null }[] }[] = [];
        for (let j = 0; j < net.junctionId.length; j++) {
          if (net.junctionTl[j] < 0) continue;
          if (Math.hypot(net.junctionXYZ[j * 3] - x, net.junctionXYZ[j * 3 + 2] - z) > r) continue;
          out.push({ junction: net.junctionId[j], approaches: this.signals.approaches(j).map((a) => ({
            edge: net.edges[a.edge].id, color: this.signals.approachColor(a), walk: this.signals.pedestrianWalk(j, a.edge) })) });
        }
        return out;
      },
      /** Автобусы: маршрут, остановка, скорость. */
      buses: () => sim.vehicles.filter((v) => v.route >= 0).map((v) => {
        const R = net.routes[v.route];
        return { id: v.id, type: R.type, ref: R.ref, kind: v.kind, nextStop: v.nextStop, stops: R.pieces[v.piece].stops.length,
          dwell: +v.dwell.toFixed(1), kmh: +(v.v * 3.6).toFixed(1), x: +v.x.toFixed(0), z: +v.z.toFixed(0) };
      }),
    };
  }
}

const _dir = new THREE.Vector3();
const PED_RADIUS = 250;
/** Обход пешеходов в радиусе: fn(x, z, vx, vz). */
export type PedestrianSource = (x: number, z: number, r: number, fn: (x: number, z: number, vx: number, vz: number) => void) => void;
