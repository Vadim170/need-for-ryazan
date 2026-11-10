import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import type { PeopleSystem } from '../people/people-system';
import type { Effects } from './effects';
import type { VehicleDamage } from './vehicle-damage';
import type { WeaponDef } from './weapons';
import { gameEvents } from './events';

/**
 * Стрельба и рукопашная (src/combat): хитскан — луч Rapier по миру (здания, рельеф, пропсы, машины; без рэгдоллов и
 * капсул персонажей) + аналитические капсулы людей (пешеходы PeopleSystem, полицейские и игрок — Fighter).
 * Ближайшее попадание получает урон, эффекты и события (gameEvents). Решения о розыске — через колбэки onPedHit/onFighterHit.
 */

export interface Fighter {
  readonly isPlayer: boolean;
  readonly isCop: boolean;
  /** Ноги (мир). */
  readonly pos: THREE.Vector3;
  /** Лежит (меньше капсула). */
  readonly down: boolean;
  /** Можно ли попасть (жив, не в машине). */
  hittable(): boolean;
  takeHit(dmg: number, dir: THREE.Vector3, push: number, byPlayer: boolean, melee: boolean): void;
}

export interface TrafficLike {
  sim: { vehicles: readonly { id: number; x: number; y: number; z: number; fx: number; fz: number; len: number; halfW: number; crashed: boolean }[] };
}

export interface ShotHit {
  kind: 'none' | 'world' | 'vehicle' | 'traffic' | 'ped' | 'fighter';
  t: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  ped: number;
  fighter: Fighter | null;
  body: RAPIER.RigidBody | null;
  trafficId: number;
}

/** Луч пули: всё, кроме рэгдоллов (0x10) и капсул персонажей (0x20). */
const SHOT_GROUPS = (0xffff << 16) | (0xffff & ~0x0010 & ~0x0020);
const CAP_R = 0.32, CAP_LO = 0.25, CAP_HI = 1.62;

const _d = new THREE.Vector3(), _o = new THREE.Vector3(), _a = new THREE.Vector3(), _end = new THREE.Vector3();

export class Combat {
  readonly fighters: Fighter[] = [];
  /** Пешеход получил удар/пулю: (агент, от игрока, рукопашная). */
  onPedHit: ((i: number, byPlayer: boolean, melee: boolean) => void) | null = null;
  /** Выстрел рядом (для паники и розыска): точка, от игрока. */
  onShot: ((p: THREE.Vector3, byPlayer: boolean) => void) | null = null;
  /** Попадание по машине (тело или машина трафика): от игрока. */
  onVehicleHit: ((body: RAPIER.RigidBody | null, trafficId: number, byPlayer: boolean) => void) | null = null;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  constructor(private physics: PhysicsWorld, readonly effects: Effects, readonly damage: VehicleDamage,
    private people: () => PeopleSystem | null, private traffic: () => TrafficLike | null) {}

  /** Луч: ближайшее попадание до range. exclude — тело стрелка (его машина), self — сам стрелок. */
  raycast(o: THREE.Vector3, dir: THREE.Vector3, range: number, exclude: RAPIER.RigidBody | null, self: Fighter | null, out: ShotHit): ShotHit {
    out.kind = 'none'; out.t = range; out.ped = -1; out.fighter = null; out.body = null; out.trafficId = -1;
    out.point.copy(o).addScaledVector(dir, range); out.normal.set(0, 1, 0);
    const r = this.ray;
    r.origin.x = o.x; r.origin.y = o.y; r.origin.z = o.z;
    r.dir.x = dir.x; r.dir.y = dir.y; r.dir.z = dir.z;
    const hit = this.physics.world.castRayAndGetNormal(r, range, true, undefined, SHOT_GROUPS, undefined, exclude ?? undefined);
    if (hit) {
      out.t = hit.timeOfImpact;
      out.point.copy(o).addScaledVector(dir, out.t);
      out.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
      const body = hit.collider.parent();
      const groups = hit.collider.collisionGroups() >>> 16;
      if (body && body.isDynamic() && this.damage.has(body)) { out.kind = 'vehicle'; out.body = body; }
      else if (body && (groups & 0x0004) && (body.isKinematic() || body.isDynamic())) {
        out.kind = 'traffic'; out.body = body; out.trafficId = this.trafficAt(out.point);
        if (out.trafficId < 0 && body.isDynamic()) out.kind = 'vehicle';
      } else if (body && body.isDynamic() && body.mass() > 500) { out.kind = 'vehicle'; out.body = body; }
      else out.kind = 'world';
    }
    // люди
    const T = out.t;
    const ppl = this.people();
    if (ppl) {
      const mx = o.x + dir.x * T * 0.5, mz = o.z + dir.z * T * 0.5;
      ppl.forEachAgent(mx, mz, T * 0.5 + 2, (i, x, y, z, _yaw, down) => {
        const t = capsuleHit(o, dir, x, y, z, down);
        if (t >= 0 && t < out.t) { out.t = t; out.kind = 'ped'; out.ped = i; out.fighter = null; out.body = null; }
      });
    }
    for (const f of this.fighters) {
      if (f === self || !f.hittable() || (self?.isCop && f.isCop)) continue; // полицейские не попадают друг в друга
      const t = capsuleHit(o, dir, f.pos.x, f.pos.y, f.pos.z, f.down);
      if (t >= 0 && t < out.t) { out.t = t; out.kind = 'fighter'; out.fighter = f; out.ped = -1; out.body = null; }
    }
    const k = out.kind as ShotHit['kind'];
    if (k === 'ped' || k === 'fighter') { out.point.copy(o).addScaledVector(dir, out.t); out.normal.copy(dir).negate(); }
    return out;
  }

  private trafficAt(p: THREE.Vector3): number {
    const t = this.traffic();
    if (!t) return -1;
    let best = -1, bd = 1e9;
    for (const v of t.sim.vehicles) {
      const dx = p.x - v.x, dz = p.z - v.z;
      if (Math.abs(dx) > 9 || Math.abs(dz) > 9) continue;
      const lo = Math.abs(dx * v.fx + dz * v.fz), la = Math.abs(-dx * v.fz + dz * v.fx);
      const d = Math.max(lo - v.len / 2, la - v.halfW, 0);
      if (d < 0.6 && d < bd) { bd = d; best = v.id; }
    }
    return best;
  }

  /**
   * Выстрел из оружия: muzzle — точка дула, aim — куда целимся (точка). moving — разброс в движении.
   * Возвращает попадания (по дробинкам).
   */
  fire(w: WeaponDef, muzzle: THREE.Vector3, aim: THREE.Vector3, byPlayer: boolean, exclude: RAPIER.RigidBody | null, self: Fighter | null,
    moving: boolean, extraSpread = 0): ShotHit[] {
    const res: ShotHit[] = [];
    _a.subVectors(aim, muzzle).normalize();
    this.effects.muzzle(muzzle, _a, w.id === 'pistol' ? 0.14 : 0.22);
    gameEvents.emit('gunshot', { weapon: w.id, x: muzzle.x, y: muzzle.y, z: muzzle.z, byPlayer });
    this.onShot?.(muzzle, byPlayer);
    const spread = (moving ? w.spreadMove : w.spread) + extraSpread;
    for (let k = 0; k < Math.max(1, w.pellets); k++) {
      _d.copy(_a);
      if (spread > 0) {
        _d.x += gauss() * spread; _d.y += gauss() * spread; _d.z += gauss() * spread;
        _d.normalize();
      }
      const h = this.raycast(muzzle, _d, w.range, exclude, self, mkHit());
      _end.copy(h.point);
      if (k < 3 || Math.random() < 0.3) this.effects.tracer(_o.copy(muzzle).addScaledVector(_d, 0.4), _end, w.pellets > 1 ? 0.012 : 0.02);
      this.apply(w, h, _d, byPlayer, false);
      res.push(h);
    }
    return res;
  }

  /** Урон и эффекты по результату луча. */
  apply(w: WeaponDef, h: ShotHit, dir: THREE.Vector3, byPlayer: boolean, melee: boolean): void {
    switch (h.kind) {
      case 'world':
        this.effects.impact(h.point, h.normal, 'world');
        gameEvents.emit('impact', { surface: 'world', x: h.point.x, y: h.point.y, z: h.point.z });
        break;
      case 'vehicle': case 'traffic': {
        this.effects.impact(h.point, h.normal, 'vehicle');
        gameEvents.emit('impact', { surface: 'vehicle', x: h.point.x, y: h.point.y, z: h.point.z });
        if (h.kind === 'traffic' && h.trafficId >= 0) this.damage.damageTraffic(h.trafficId, w.vehDamage);
        else if (h.body) {
          this.damage.damage(h.body, w.vehDamage);
          if (h.body.isDynamic()) h.body.applyImpulseAtPoint({ x: dir.x * w.push * 30, y: 0, z: dir.z * w.push * 30 }, h.point, true);
        }
        this.onVehicleHit?.(h.body, h.trafficId, byPlayer);
        break;
      }
      case 'ped': {
        const ppl = this.people();
        if (!ppl) break;
        this.effects.impact(h.point, h.normal, 'soft');
        gameEvents.emit('impact', { surface: 'ped', x: h.point.x, y: h.point.y, z: h.point.z });
        ppl.strike(h.ped, dir.x * w.push * 1.4, 1.5, dir.z * w.push * 1.4);
        this.onPedHit?.(h.ped, byPlayer, melee);
        break;
      }
      case 'fighter':
        this.effects.impact(h.point, h.normal, 'soft');
        gameEvents.emit('impact', { surface: h.fighter!.isPlayer ? 'player' : 'cop', x: h.point.x, y: h.point.y, z: h.point.z });
        h.fighter!.takeHit(w.damage, dir, w.push, byPlayer, melee);
        break;
    }
  }

  /**
   * Удар рукой/ногой: цель — ближайший человек в секторе ±50° перед атакующим на дистанции range.
   * Возвращает попадание или null.
   */
  melee(w: WeaponDef, from: THREE.Vector3, yaw: number, byPlayer: boolean, self: Fighter | null, kick: boolean): ShotHit | null {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const range = w.range + (kick ? 0.35 : 0);
    let best: ShotHit | null = null, bd = range;
    const consider = (x: number, y: number, z: number, set: (h: ShotHit) => void) => {
      const dx = x - from.x, dz = z - from.z, d = Math.hypot(dx, dz);
      if (d > bd || Math.abs(y - from.y) > 1.2) return;
      if (d > 0.3 && (dx * fx + dz * fz) / d < 0.64) return;
      bd = d;
      const h = mkHit();
      h.point.set(x, y + (kick ? 0.9 : 1.35), z);
      h.normal.set(-fx, 0, -fz);
      h.t = d;
      set(h);
      best = h;
    };
    const ppl = this.people();
    ppl?.forEachAgent(from.x, from.z, range + 0.5, (i, x, y, z, _yw, down) => {
      if (down || ppl.isKid(i)) return;
      consider(x, y, z, (h) => { h.kind = 'ped'; h.ped = i; });
    });
    for (const f of this.fighters) {
      if (f === self || !f.hittable() || f.down) continue;
      consider(f.pos.x, f.pos.y, f.pos.z, (h) => { h.kind = 'fighter'; h.fighter = f; });
    }
    const hb = best as ShotHit | null;
    gameEvents.emit('punch', { x: from.x, y: from.y + 1.3, z: from.z, hit: !!hb, kick, byPlayer });
    if (!hb) return null;
    _d.set(fx, 0, fz);
    const push = kick ? w.push * 1.6 : w.push;
    if (hb.kind === 'ped') {
      const ppl2 = this.people()!;
      this.effects.dust(hb.point, 3);
      ppl2.strike(hb.ped, fx * push, 1.2, fz * push);
      this.onPedHit?.(hb.ped, byPlayer, true);
    } else if (hb.fighter) {
      this.effects.dust(hb.point, 3);
      hb.fighter.takeHit(w.damage * (kick ? 1.4 : 1), _d, push, byPlayer, true);
    }
    return hb;
  }
}

function mkHit(): ShotHit {
  return { kind: 'none', t: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), ped: -1, fighter: null, body: null, trafficId: -1 };
}

/** Луч против вертикальной капсулы человека (лежащий — сфера у земли); −1 — мимо. */
function capsuleHit(o: THREE.Vector3, d: THREE.Vector3, x: number, y: number, z: number, down: boolean): number {
  if (down) {
    const cx = x - o.x, cy = y + 0.25 - o.y, cz = z - o.z;
    const t = cx * d.x + cy * d.y + cz * d.z;
    if (t < 0) return -1;
    const px = cx - d.x * t, py = cy - d.y * t, pz = cz - d.z * t;
    const r2 = 0.55 * 0.55, q = px * px + py * py + pz * pz;
    return q < r2 ? t - Math.sqrt(r2 - q) : -1;
  }
  const wx = o.x - x, wz = o.z - z;
  const dd = d.x * d.x + d.z * d.z;
  if (dd < 1e-6) return -1;
  const t0 = -(wx * d.x + wz * d.z) / dd;
  if (t0 < 0) return -1;
  const hx = wx + d.x * t0, hz = wz + d.z * t0, h2 = hx * hx + hz * hz;
  if (h2 > CAP_R * CAP_R) return -1;
  const t = t0 - Math.sqrt((CAP_R * CAP_R - h2) / dd);
  const yy = o.y + d.y * t - y;
  if (yy < CAP_LO - CAP_R || yy > CAP_HI + 0.15) return -1;
  return Math.max(t, 0);
}

function gauss(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) * 0.8;
}
