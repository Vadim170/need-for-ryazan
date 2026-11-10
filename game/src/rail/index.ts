import * as THREE from 'three';
import type { PhysicsWorld, RAPIER } from '../physics/world';
import type { CityMaterials } from '../world/materials';
import { timeUniforms } from '../render/time-of-day';
import { RailNet } from './net';
import { buildCarModels } from './models';
import { RailSim, type CrossingState, type RailEvent, type TrainKind } from './sim';
import { TrainRenderer } from './render';
import { RailEquipment } from './equipment';
import { TrainPhysics } from './physics';
import { createTrackMaterials } from './track-materials';

export type { RailEvent, TrainKind } from './sim';

/** Препятствие для трафика (тот же формат, что Obstacle в traffic/sim.ts). */
export interface RailObstacle { x: number; z: number; vx: number; vz: number; fx: number; fz: number; halfLen: number; halfW: number }

export interface RailDeps {
  physics: PhysicsWorld;
  scene: THREE.Scene;
  envMap?: THREE.Texture | null;
  player: { body: RAPIER.RigidBody; length: number; width: number; mass: number };
}

/** Материалы путей — до загрузки тайлов (CityWorld.mats). */
export function installTrackMaterials(mats: CityMaterials): void {
  for (const [name, m] of Object.entries(createTrackMaterials())) mats.override(name, m);
}

/**
 * Железная дорога в игре (docs/stage2/rail.md): поезда по графу rail/net.json, переезды, контактная сеть, сигналы.
 * - fixedStep (onPreStep физики): симуляция поездов и переездов, кинематические тела вагонов у игрока;
 * - update(dt, camera): отрисовка (интерполяция), мигание огней, события звука;
 * - crossingObstacles: закрытые переезды для трафика (src/traffic: Traffic.extraObstacles);
 * - onEvent(cb): гудки, переезды, появление/уход поездов, удары (звук — заглушка, только события).
 */
export class Rail {
  readonly sim: RailSim;
  readonly renderer: TrainRenderer;
  readonly equipment: RailEquipment;
  readonly physics: TrainPhysics;
  /** Обновляется каждый шаг: «стоп-коробки» у закрытых переездов (по всей ширине дороги, за 3–9 м до рельсов). */
  readonly crossingObstacles: RailObstacle[] = [];
  private listeners: ((e: RailEvent) => void)[] = [];
  private camera: THREE.Camera | null = null;
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private v3 = new THREE.Vector3();
  /** Громкость грохота ближайшего поезда 0..1 (для будущего звука). */
  rumble = 0;
  enabled = true;
  private obsPool: RailObstacle[] = [];

  private constructor(readonly net: RailNet, private deps: RailDeps) {
    const { cars, bogies } = buildCarModels();
    this.sim = new RailSim(net, {
      models: cars,
      visible: (x, y, z) => this.visible(x, y, z),
      player: () => { const t = deps.player.body.translation(); return { x: t.x, y: t.y, z: t.z }; },
    });
    this.renderer = new TrainRenderer(deps.scene, cars, bogies, deps.envMap);
    this.equipment = new RailEquipment(deps.scene, net);
    this.physics = new TrainPhysics(deps.physics, this.sim, cars, this.renderer, deps.player.body, deps.player);
    deps.physics.onPreStep((dt) => this.fixedStep(dt));
  }

  /** GTA-режим: игрок пересел в другую машину или идёт пешком. */
  setPlayer(body: RAPIER.RigidBody, length: number, width: number, mass: number): void {
    this.deps.player = { body, length, width, mass };
    this.physics.setPlayer(body, this.deps.player);
  }

  static async create(baseUrl: string, deps: RailDeps): Promise<Rail | null> {
    const net = await RailNet.load(baseUrl);
    return net ? new Rail(net, deps) : null;
  }

  onEvent(cb: (e: RailEvent) => void): void { this.listeners.push(cb); }

  private visible(x: number, y: number, z: number): boolean {
    const cam = this.camera;
    if (!cam) return false;
    const d = Math.hypot(x - cam.position.x, z - cam.position.z);
    if (d > 750) return false;            // туман
    if (d < 60) return true;
    return this.frustum.containsPoint(this.v3.set(x, y, z));
  }

  private fixedStep(dt: number): void {
    if (!this.enabled) return;
    this.sim.step(dt);
    this.physics.preStep(dt);
    // стоп-коробки закрытых переездов
    const out = this.crossingObstacles;
    out.length = 0;
    let k = 0;
    for (const c of this.sim.crossings) {
      if (!this.sim.flashing(c) || !c.def.carRoad && !c.def.barrier) continue;
      const d = c.def;
      let o = this.obsPool[k++];
      if (!o) this.obsPool.push((o = { x: 0, z: 0, vx: 0, vz: 0, fx: 1, fz: 0, halfLen: 1, halfW: 1 }));
      // вдоль дороги — «толщина» (рельсы + 3 м с каждой стороны), поперёк — ширина дороги
      o.x = d.x; o.z = d.z;
      o.fx = -d.roadDir[1]; o.fz = d.roadDir[0];   // ось коробки поперёк дороги
      o.halfLen = d.roadWidth / 2 + 1.5;
      o.halfW = d.spread / 2 + 4.5;
      out.push(o);
    }
  }

  /** Каждый кадр после physics.update. */
  update(dt: number, camera: THREE.Camera): void {
    this.camera = camera;
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const night = timeUniforms.nightFactor.value;
    this.renderer.update(this.sim.trains, this.deps.physics.timestep.alpha, camera, night);
    this.equipment.update(dt, this.sim.crossings, this.sim.trains, (c) => this.sim.flashing(c));
    // события (накопленные за шаги физики)
    if (this.sim.events.length) {
      const ev = this.sim.events.splice(0);
      for (const e of ev) for (const l of this.listeners) l(e);
    }
    // грохот ближайшего поезда (по расстоянию и скорости)
    const p = this.deps.player.body.translation();
    let r = 0;
    const P = new Float32Array(6);
    for (const t of this.sim.trains) {
      for (const sv of [t.s, t.tailS, (t.s + t.tailS) / 2]) {
        t.path.at(Math.max(sv, 0), P);
        const d = Math.hypot(P[0] - p.x, P[2] - p.z);
        r = Math.max(r, Math.min(1, t.v / 20) * Math.max(0, 1 - d / 250));
      }
    }
    this.rumble += (r - this.rumble) * Math.min(1, dt * 3);
  }

  /** Состояния переездов (для HUD/отладки/трафика). */
  get crossings(): readonly CrossingState[] { return this.sim.crossings; }

  /** Для миникарты: ломаные путей (x, z) и поезда (голова → хвост). */
  trackLines(): Float32Array[] {
    return this.net.segs.map((s) => {
      const n = s.cum.length, out = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { out[i * 2] = s.pts[i * 3]; out[i * 2 + 1] = s.pts[i * 3 + 2]; }
      return out;
    });
  }
  forEachTrain(cb: (xz: number[]) => void): void {
    const P = new Float32Array(6);
    for (const t of this.sim.trains) {
      const xz: number[] = [];
      const step = Math.max(t.length / 16, 10);
      for (let sv = t.s; sv > t.tailS - step + 0.1; sv -= step) { t.path.at(Math.max(Math.max(sv, t.tailS), 0), P); xz.push(P[0], P[2]); }
      cb(xz);
    }
  }

  /** Отладка (window.__game.rail). */
  debug() {
    const sim = this.sim, net = this.net;
    const pos = (t: (typeof sim.trains)[number]) => { const P = new Float32Array(6); t.path.at(t.s, P); return { x: +P[0].toFixed(1), y: +P[1].toFixed(1), z: +P[2].toFixed(1) }; };
    return {
      sim, net, renderer: this.renderer, physics: this.physics, equipment: this.equipment, rail: this,
      stats: () => ({ ...sim.stats, trains: sim.trains.length, cars: this.renderer.stats.cars, drawn: this.renderer.stats.drawn, bodies: this.physics.stats.bodies, hits: this.physics.stats.hits, rumble: +this.rumble.toFixed(2) }),
      lines: () => [...sim.lines.map((l) => ({ name: l.name, km: +(l.path.length - 2 * l.path.ext).toFixed(0) / 1000, viaStops: !!l.stopsPath, next: +l.timer.toFixed(0) })),
        ...sim.shuttles.map((s) => ({ name: s.name, km: +(s.path.length / 1000).toFixed(2), next: +s.timer.toFixed(0) }))],
      trains: () => sim.trains.map((t) => ({ id: t.id, kind: t.kind, line: t.line, cars: t.cars.length, len: Math.round(t.length), kmh: +(t.v * 3.6).toFixed(1),
        s: Math.round(t.s), of: Math.round(t.path.length), dwell: +t.dwell.toFixed(1), nextStop: t.stops[t.nextStop]?.station ?? '', ...pos(t), obstacle: Number.isFinite(t.obstacleS) ? Math.round(t.obstacleS - t.s) : null })),
      crossings: () => sim.crossings.map((c) => ({ id: c.def.id, road: c.def.roadName || c.def.highway, x: c.def.x, z: c.def.z, barrier: c.def.barrier, active: c.active, boom: +c.barrier.toFixed(2), eta: Number.isFinite(c.eta) ? +c.eta.toFixed(1) : null })),
      /** Поезд по линии (индекс или подстрока имени); s — голова по пути (м), по умолчанию из-за портала. */
      spawn: (kind: TrainKind = 'suburban', line: number | string = 0, opts: { s?: number; v?: number; cars?: number } = {}) => {
        const L = typeof line === 'number' ? sim.lines[line] : sim.lines.find((l) => l.name.includes(line));
        if (!L) return null;
        return sim.spawnLine(L, kind, opts).id;
      },
      /** Поезд, который подойдёт к точке (x, z) через ~sec секунд (ставится на линию, проходящую ближе всего). */
      spawnNear: (x: number, z: number, kind: TrainKind = 'suburban', sec = 40) => {
        let best: { L: (typeof sim.lines)[number]; s: number; d: number } | null = null;
        const P = new Float32Array(6);
        for (const L of sim.lines) {
          const path = kind === 'suburban' && L.stopsPath ? L.stopsPath : L.path;
          for (let s = path.ext; s < path.length - path.ext; s += 10) { path.at(s, P); const d = Math.hypot(P[0] - x, P[2] - z); if (!best || d < best.d) best = { L, s, d }; }
        }
        if (!best) return null;
        const v = kind === 'freight' ? 18 : 22;
        const t = sim.spawnLine(best.L, kind, { s: Math.max(best.s - v * sec, 400), v });
        return { id: t.id, line: best.L.name, dist: +best.d.toFixed(1) };
      },
      /** Маневровый рейс через переезды (индекс в shuttles). */
      shuttle: (i = 0) => { const S = sim.shuttles[i]; if (!S) return null; const t = sim.spawnOnPath('shunter', S.path, S.name); t.shuttleLegs = 2; t.stops = [{ s: S.path.length - 12, dwell: 45, station: 'тупик' }]; return t.id; },
      clear: () => { for (const t of sim.trains) t.done = true; },
      /** Позиция для телепорта к станции/переезду. */
      where: (name: string) => {
        const st = net.json.stations.find((q) => q.name.includes(name));
        if (st) return { x: st.x, z: st.z };
        const c = net.json.crossings.find((q) => q.roadName.includes(name));
        return c ? { x: c.x, y: c.y, z: c.z } : null;
      },
      events: [] as RailEvent[],
    };
  }
}
