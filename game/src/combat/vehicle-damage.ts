import * as THREE from 'three';
import type { RAPIER } from '../physics/world';
import type { Effects } from './effects';
import { gameEvents } from './events';

/**
 * Повреждения машин (аркада, «deformation-lite»): здоровье 100; < 60 — светлый дым из-под капота, < 30 — чёрный,
 * ≤ 10 — огонь, через 5 с горения — взрыв (огненный шар, импульс вверх, обгоревший кузов, урон вокруг).
 * Источники урона: пули, удары (резкое изменение скорости > 7 м/с), взрывы. Машины трафика — по id симуляции:
 * при «смерти» становятся физическими телами (TrafficPhysics.crashVehicle) и горят как обычные.
 */

export interface DamageTarget {
  body: RAPIER.RigidBody;
  /** Полудлина (дым — из передней части). */
  halfLen: number;
  /** Обгоревший вид (BuiltVehicleVisual.char) и т.п. */
  onExplode?: () => void;
  /** Множитель урона (автобусы крепче). */
  armor?: number;
}

interface State { t: DamageTarget; hp: number; burn: number; exploded: boolean; acc: number; pv: THREE.Vector3; init: boolean; age: number }

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _f = new THREE.Vector3();

export class VehicleDamage {
  private states = new Map<number, State>();
  /** Здоровье машин трафика (по id SimVehicle). */
  private trafficHp = new Map<number, number>();
  /** Взрыв: (точка, радиус, сила) — урон людям/машинам вокруг (подписывается GTA-слой). */
  onExplosion: ((p: THREE.Vector3, r: number, power: number, body: RAPIER.RigidBody) => void) | null = null;
  /** Машина трафика «умерла» от пуль: вернуть её тело (TrafficPhysics.crashVehicle) или null. */
  trafficWreck: ((id: number) => RAPIER.RigidBody | null) | null = null;

  constructor(private effects: Effects) {}

  register(t: DamageTarget, hp = 100): void {
    this.states.set(t.body.handle, { t, hp, burn: 0, exploded: false, acc: 0, pv: new THREE.Vector3(), init: false, age: 0 });
  }
  unregister(body: RAPIER.RigidBody): void { this.states.delete(body.handle); }
  has(body: RAPIER.RigidBody): boolean { return this.states.has(body.handle); }
  health(body: RAPIER.RigidBody): number { return this.states.get(body.handle)?.hp ?? 100; }
  wrecked(body: RAPIER.RigidBody): boolean { return this.states.get(body.handle)?.exploded ?? false; }
  /** Починка (перекраска в гараже). */
  repair(body: RAPIER.RigidBody): void { const s = this.states.get(body.handle); if (s && !s.exploded) { s.hp = 100; s.burn = 0; } }

  /** Урон машине по телу; true — тело известно. */
  damage(body: RAPIER.RigidBody, dmg: number): boolean {
    const s = this.states.get(body.handle);
    if (!s) return false;
    if (s.exploded) return true;
    s.hp = Math.max(0, s.hp - dmg * (s.t.armor ?? 1));
    return true;
  }

  /** Урон машине трафика (id симуляции). Возвращает true, если она «умерла» (стала обломком). */
  damageTraffic(id: number, dmg: number): boolean {
    const hp = (this.trafficHp.get(id) ?? 100) - dmg;
    this.trafficHp.set(id, hp);
    if (hp > 10) return false;
    this.trafficHp.delete(id);
    const body = this.trafficWreck?.(id);
    if (body && !this.states.has(body.handle)) this.register({ body, halfLen: 2.2 }, 9);
    return true;
  }

  explode(s: State): void {
    s.exploded = true; s.hp = 0;
    const b = s.t.body;
    const t = b.translation();
    _p.set(t.x, t.y, t.z);
    this.effects.explosion(_p, 1);
    const m = b.mass();
    b.applyImpulse({ x: (Math.random() - 0.5) * m * 2, y: m * 5.5, z: (Math.random() - 0.5) * m * 2 }, true);
    b.applyTorqueImpulse({ x: (Math.random() - 0.5) * m * 3, y: (Math.random() - 0.5) * m, z: (Math.random() - 0.5) * m * 3 }, true);
    s.t.onExplode?.();
    gameEvents.emit('explosion', { x: t.x, y: t.y, z: t.z, power: 1 });
    this.onExplosion?.(_p.clone(), 7, 1, b);
  }

  /** Урон от взрыва рядом (другие машины): цепная реакция. */
  blast(p: THREE.Vector3, r: number, except: RAPIER.RigidBody | null): void {
    for (const s of this.states.values()) {
      if (s.exploded || s.t.body === except) continue;
      const t = s.t.body.translation();
      const d = Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z);
      if (d < r) s.hp = Math.max(0, s.hp - (1 - d / r) * 70);
    }
  }

  update(dt: number, cam: THREE.Vector3): void {
    for (const [h, s] of this.states) {
      const b = s.t.body;
      if (!b.isValid()) { this.states.delete(h); continue; }
      const lv = b.linvel();
      // удары: резкое изменение скорости
      s.age += dt;
      // (первые 3 с после появления — без урона: машина «садится» на подвеску; скорость ровно 0 — сброс R, не удар)
      if (s.init && dt > 0 && s.age > 3 && Math.hypot(lv.x, lv.y, lv.z) > 0.05) {
        const dv = Math.hypot(lv.x - s.pv.x, lv.y - s.pv.y, lv.z - s.pv.z);
        if (dv > 7 && !s.exploded) s.hp = Math.max(0, s.hp - (dv - 7) * 3.5 * (s.t.armor ?? 1));
      }
      s.pv.set(lv.x, lv.y, lv.z); s.init = true;
      if (s.exploded) {
        // обломок дымит ещё ~20 с
        s.burn += dt;
        if (s.burn < 25) this.emit(s, dt, 1, s.burn < 10, cam);
        continue;
      }
      if (s.hp <= 10) {
        s.burn += dt;
        if (s.burn > 5) { this.explode(s); continue; }
      }
      if (s.hp < 60) this.emit(s, dt, s.hp < 30 ? 1 : 0.2, s.hp <= 10, cam);
    }
  }

  private emit(s: State, dt: number, k: number, fire: boolean, cam: THREE.Vector3): void {
    const b = s.t.body, t = b.translation();
    if (Math.hypot(t.x - cam.x, t.z - cam.z) > 160) return;
    s.acc += dt * (fire ? 30 : 12);
    if (s.acc < 1) return;
    const r = b.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _f.set(0, 0.55, -s.t.halfLen + 0.7).applyQuaternion(_q);
    _p.set(t.x + _f.x, t.y + _f.y, t.z + _f.z);
    const lv = b.linvel();
    while (s.acc >= 1) { s.acc -= 1; this.effects.smoke(_p, k, fire, lv.x, lv.z); }
  }

  /** Отладка. */
  list(): { handle: number; hp: number; burn: number; exploded: boolean }[] {
    return [...this.states.entries()].map(([handle, s]) => ({ handle, hp: Math.round(s.hp), burn: +s.burn.toFixed(1), exploded: s.exploded }));
  }
}
