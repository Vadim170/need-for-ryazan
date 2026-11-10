import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { FixedTimestep } from '../core/time';

export { RAPIER };

/** Фильтр лучей «только земля/здания»: коллайдеры с membership без бита 1 (пропсы, PROP_GROUPS) пропускаются. */
const GROUND_ONLY = (0xffff << 16) | 0x0001;

interface ForceEv { c1: number; c2: number; f: number; dir: { x: number; y: number; z: number } }
interface CollEv { h1: number; h2: number; started: boolean }

/** EventQueue Rapier + повторяемая выдача: каждый колбэк onPostStep получает все события шага. */
class ReplayQueue extends RAPIER.EventQueue {
  private forces: ForceEv[] = [];
  private colls: CollEv[] = [];
  private shim: RAPIER.EventQueue;
  constructor() {
    super(true);
    const self = this;
    this.shim = {
      drainContactForceEvents(cb: (e: RAPIER.TempContactForceEvent) => void) {
        for (const e of self.forces) cb({ collider1: () => e.c1, collider2: () => e.c2, totalForceMagnitude: () => e.f, maxForceDirection: () => e.dir } as unknown as RAPIER.TempContactForceEvent);
      },
      drainCollisionEvents(cb: (h1: number, h2: number, started: boolean) => void) { for (const e of self.colls) cb(e.h1, e.h2, e.started); },
      clear() { /* очищает PhysicsWorld после всех колбэков */ },
    } as unknown as RAPIER.EventQueue;
  }
  /** Забрать события шага из Rapier и вернуть очередь-«повторитель» для колбэков. */
  replayable(): RAPIER.EventQueue {
    this.forces.length = 0; this.colls.length = 0;
    super.drainContactForceEvents((e) => {
      const d = e.maxForceDirection();
      this.forces.push({ c1: e.collider1(), c2: e.collider2(), f: e.totalForceMagnitude(), dir: { x: d.x, y: d.y, z: d.z } });
    });
    super.drainCollisionEvents((h1, h2, started) => this.colls.push({ h1, h2, started }));
    return this.shim;
  }
}

interface Tracked {
  body: RAPIER.RigidBody;
  object: THREE.Object3D;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  curPos: THREE.Vector3;
  curQuat: THREE.Quaternion;
}

/**
 * Rapier world wrapper: fixed 60 Hz stepping + render interpolation for tracked bodies.
 * Units: metres / kilograms / seconds. Coordinates: three.js (Y up, -Z north, +X east).
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  readonly timestep = new FixedTimestep(1 / 60);
  private tracked: Tracked[] = [];
  private preStep: ((dt: number) => void)[] = [];
  private postStep: ((dt: number, events: RAPIER.EventQueue) => void)[] = [];
  /** События контактов (коллайдеры с ActiveEvents) — разбираются колбэками onPostStep после каждого шага. */
  readonly events = new ReplayQueue();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.timestep.step;
  }

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    return new PhysicsWorld();
  }

  /** Register a callback executed before every fixed step (vehicle forces etc). */
  onPreStep(cb: (dt: number) => void): void {
    this.preStep.push(cb);
  }

  /** Колбэк после каждого фиксированного шага: разбор событий контактов (ломаемые пропсы и т.п.). */
  onPostStep(cb: (dt: number, events: RAPIER.EventQueue) => void): void {
    this.postStep.push(cb);
  }

  /** Снять колбэк onPreStep (удалённая машина, персонаж). */
  offPreStep(cb: (dt: number) => void): void {
    const i = this.preStep.indexOf(cb);
    if (i >= 0) this.preStep.splice(i, 1);
  }

  /** Перестать интерполировать тело (перед removeRigidBody). */
  untrack(body: RAPIER.RigidBody): void {
    const i = this.tracked.findIndex((x) => x.body === body);
    if (i >= 0) this.tracked.splice(i, 1);
  }

  /** Interpolate `object` to follow `body` between physics steps. */
  track(body: RAPIER.RigidBody, object: THREE.Object3D): void {
    const t = body.translation(), r = body.rotation();
    const pos = new THREE.Vector3(t.x, t.y, t.z), q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    this.tracked.push({ body, object, prevPos: pos.clone(), prevQuat: q.clone(), curPos: pos, curQuat: q });
    object.position.copy(pos);
    object.quaternion.copy(q);
  }

  /** Snap interpolation state (after teleport). */
  resetTracking(body: RAPIER.RigidBody): void {
    const tr = this.tracked.find((x) => x.body === body);
    if (!tr) return;
    const t = body.translation(), r = body.rotation();
    tr.curPos.set(t.x, t.y, t.z); tr.prevPos.copy(tr.curPos);
    tr.curQuat.set(r.x, r.y, r.z, r.w); tr.prevQuat.copy(tr.curQuat);
  }

  /** Advance simulation by a frame's worth of time, then interpolate visuals. */
  update(frameDt: number): void {
    this.timestep.advance(frameDt, (dt) => {
      for (const tr of this.tracked) {
        tr.prevPos.copy(tr.curPos);
        tr.prevQuat.copy(tr.curQuat);
      }
      for (const cb of this.preStep) cb(dt);
      this.world.step(this.events);
      // события копируются один раз и раздаются всем подписчикам (drain в Rapier опустошает очередь: иначе их получил бы
      // только первый колбэк — пропсы съедали удары по трафику)
      const ev = this.events.replayable();
      for (const cb of this.postStep) cb(dt, ev);
      this.events.clear();
      for (const tr of this.tracked) {
        const t = tr.body.translation(), r = tr.body.rotation();
        tr.curPos.set(t.x, t.y, t.z);
        tr.curQuat.set(r.x, r.y, r.z, r.w);
      }
    });
    const a = this.timestep.alpha;
    for (const tr of this.tracked) {
      tr.object.position.lerpVectors(tr.prevPos, tr.curPos, a);
      tr.object.quaternion.slerpQuaternions(tr.prevQuat, tr.curQuat, a);
      tr.object.updateMatrixWorld();
    }
  }

  /** Height of the first collider hit below y=500 at (x,z); 0 if none. Пропсы (группа 2: деревья, фонари…) не учитываются. */
  groundHeightAt(x: number, z: number): number {
    this.ray.origin.x = x; this.ray.origin.y = 500; this.ray.origin.z = z;
    const hit = this.world.castRay(this.ray, 1000, true, undefined, GROUND_ONLY);
    return hit ? 500 - hit.timeOfImpact : 0;
  }
}
