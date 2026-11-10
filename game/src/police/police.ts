import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import type { RagdollPool, RagdollLook } from '../people/ragdoll';
import type { RigAssets, RigCharacter } from '../player/rig-assets';
import type { RigRagdollSkin } from '../player/human-rig';
import type { Fleet, FleetCar } from '../player/fleet';
import type { Combat, Fighter } from '../combat/combat';
import type { Pickups } from '../combat/pickups';
import { WEAPONS, type WeaponId } from '../combat/weapons';
import { gameEvents } from '../combat/events';
import type { Traffic } from '../traffic';
import { AIDriver } from './ai-driver';
import { Cop, COP_LOOK } from './cop';
import type { RoadRouter } from './road-router';
import type { Wanted } from './wanted';

/**
 * Полиция (docs/stage3/gta-mode.md): по уровню розыска — машины ДПС (физические Vehicle с ботом AIDriver; сначала
 * «перехватываются» машины ДПС из трафика поблизости, остальные появляются на дорогах вне кадра в 110–190 м) и
 * полицейские пешком (по двое из машины). 1★ — пытаются задержать (подойти и «скрутить»), 2★+ — стреляют из ПМ,
 * 3★+ — таранят, 4★+ — автоматы. Видят игрока лучом по зданиям (4 Гц на полицейского). Всё дёшево: ≤ 4 машины, ≤ 10 человек.
 */

export interface PlayerView {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  inCar: FleetCar | null;
  onFoot: boolean;
  fighter: Fighter;
  alive: boolean;
}

interface Unit {
  car: FleetCar;
  driver: AIDriver;
  crew: Cop[];
  replanT: number;
  mode: 'chase' | 'deploy' | 'leave';
  lifeT: number;
  sirenOn: boolean;
}

const CARS_BY_LEVEL = [0, 1, 2, 3, 4, 4];
const MAX_COPS = 10;
/** Луч видимости — только здания/рельеф. */
const GROUND_ONLY = (0xffff << 16) | 0x0001;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _d = new THREE.Vector3(), _aim = new THREE.Vector3();
const _q = new THREE.Quaternion();

export interface PoliceDeps {
  physics: PhysicsWorld;
  scene: THREE.Scene;
  fleet: Fleet;
  router: RoadRouter | null;
  combat: Combat;
  wanted: Wanted;
  pickups: Pickups;
  ragdolls: RagdollPool;
  skin: RigRagdollSkin;
  traffic: () => Traffic | null;
  heightAt: (x: number, z: number) => number;
}

export class Police {
  readonly units: Unit[] = [];
  readonly cops: Cop[] = [];
  /** Полиция видит игрока (в этом кадре). */
  seen = false;
  /** Игрок задержан (вызывает PoliceForce; обрабатывает Player). */
  onBusted: (() => void) | null = null;
  /** Полицейского «уронили» (для розыска). */
  onCopDown: ((byPlayer: boolean) => void) | null = null;
  onCopHit: ((byPlayer: boolean) => void) | null = null;
  enabled = true;
  private assets: RigAssets | null = null;
  private chars: RigCharacter[] = [];
  private spawnT = 0;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private bustT = 0;
  private ringBuf: number[] = [];
  readonly stats = { cars: 0, cops: 0, spawned: 0, shots: 0 };

  constructor(private d: PoliceDeps) {}

  async loadAssets(assets: RigAssets): Promise<void> {
    this.assets = assets;
    const ids = assets.ids((c) => !c.female && (c.body === 'man'));
    const want = ['man_jacket', 'man_sweater', 'man_shirt'].filter((i) => ids.includes(i));
    this.chars = await Promise.all((want.length ? want : ids.slice(0, 2)).map((i) => assets.character(i)));
  }

  /** Есть ли полицейский/машина ДПС с прямой видимостью до точки в радиусе r (свидетель преступления). */
  witness(p: THREE.Vector3, r = 45): boolean {
    for (const c of this.cops) {
      if (c.state === 'ride' || c.state === 'down') continue;
      if (c.pos.distanceTo(p) < r && this.los(_v.copy(c.pos).setY(c.pos.y + 1.6), p)) return true;
    }
    for (const u of this.units) {
      const cp = u.car.vehicle.position;
      if (cp.distanceTo(p) < r && this.los(_v.copy(cp).setY(cp.y + 1.2), p)) return true;
    }
    // машины ДПС в трафике — тоже свидетели
    const t = this.d.traffic();
    if (t) for (const v of t.sim.vehicles) if (v.kind === 'police' && Math.hypot(v.x - p.x, v.z - p.z) < r * 0.8 && this.los(_v.set(v.x, v.y + 1.3, v.z), p)) return true;
    return false;
  }

  private los(a: THREE.Vector3, b: THREE.Vector3): boolean {
    _d.subVectors(b, a);
    const len = _d.length();
    if (len < 0.5) return true;
    _d.divideScalar(len);
    const r = this.ray;
    r.origin.x = a.x; r.origin.y = a.y; r.origin.z = a.z;
    r.dir.x = _d.x; r.dir.y = _d.y; r.dir.z = _d.z;
    const h = this.d.physics.world.castRay(r, len - 0.3, true, undefined, GROUND_ONLY);
    return !h;
  }

  /** Убрать всех (респаун игрока). */
  clear(): void {
    for (const u of [...this.units]) this.removeUnit(u, true);
    for (const c of [...this.cops]) this.removeCop(c);
    this.bustT = 0;
  }

  private removeCop(c: Cop): void {
    const i = this.cops.indexOf(c);
    if (i >= 0) this.cops.splice(i, 1);
    const fi = this.d.combat.fighters.indexOf(c);
    if (fi >= 0) this.d.combat.fighters.splice(fi, 1);
    if (c.ragId >= 0) { this.d.ragdolls.cancel(c.ragId); this.d.skin.unregister(c.ragId); }
    c.dispose();
  }

  private removeUnit(u: Unit, withCar: boolean): void {
    const i = this.units.indexOf(u);
    if (i >= 0) this.units.splice(i, 1);
    for (const c of u.crew) if (c.state === 'ride') this.removeCop(c); else c.car = null;
    if (u.sirenOn) gameEvents.emit('siren', { id: u.car.id, on: false, x: u.car.vehicle.position.x, y: u.car.vehicle.position.y, z: u.car.vehicle.position.z });
    u.car.siren = false;
    if (withCar && u.car.driver === 'ai') this.d.fleet.remove(u.car);
    else if (u.car.driver === 'ai') u.car.driver = 'none';
  }

  /** Непрерывные сирены (для звука): позиция и скорость каждой включённой. */
  sirens(): { id: number; x: number; y: number; z: number; vx: number; vz: number }[] {
    const out: { id: number; x: number; y: number; z: number; vx: number; vz: number }[] = [];
    for (const u of this.units) {
      if (!u.sirenOn) continue;
      const p = u.car.vehicle.position, v = u.car.vehicle.body.linvel();
      out.push({ id: u.car.id, x: p.x, y: p.y, z: p.z, vx: v.x, vz: v.z });
    }
    return out;
  }

  /** Метки для миникарты. */
  forEachBlip(cb: (x: number, z: number, kind: 'car' | 'cop') => void): void {
    for (const u of this.units) cb(u.car.vehicle.position.x, u.car.vehicle.position.z, 'car');
    for (const c of this.cops) if (c.state !== 'ride' && c.state !== 'down') cb(c.pos.x, c.pos.z, 'cop');
  }

  // ------------------------------------------------------------------ кадр
  update(dt: number, pv: PlayerView, camera: THREE.Camera, alpha: number): void {
    const level = this.enabled ? this.d.wanted.level : 0;
    this.seen = false;
    // --- состав по уровню
    const want = CARS_BY_LEVEL[level];
    const active = this.units.filter((u) => u.mode !== 'leave');
    if (level === 0) for (const u of active) this.leave(u);
    else if (active.length < want && this.chars.length) {
      this.spawnT -= dt;
      if (this.spawnT <= 0) { this.spawnT = active.length === 0 ? 0.5 : 4; this.spawnUnit(pv, camera); }
    }
    // --- машины
    for (const u of [...this.units]) this.updateUnit(u, dt, pv, level, camera);
    // --- полицейские пешком
    let arresting = false;
    for (const c of [...this.cops]) {
      if (this.updateCop(c, dt, pv, level, alpha)) arresting = true;
    }
    // --- задержание
    if (arresting && pv.alive) {
      this.bustT += dt;
      if (this.bustT > 1.6) { this.bustT = 0; this.onBusted?.(); }
    } else this.bustT = Math.max(0, this.bustT - dt * 2);
    this.d.ragdolls.update(dt, (agent, r) => this.ragdollDone(agent, r));
    this.stats.cars = this.units.length; this.stats.cops = this.cops.length;
  }

  /** 0..1 — прогресс задержания (HUD). */
  get bustProgress(): number { return Math.min(1, this.bustT / 1.6); }

  private leave(u: Unit): void {
    if (u.mode === 'leave') return;
    u.mode = 'leave';
    u.lifeT = 0;
    for (const c of u.crew) if (c.state !== 'ride' && c.state !== 'down') c.state = 'return';
    u.driver.target = null;
    const r = this.d.router;
    if (r) {
      const p = u.car.vehicle.position;
      const ring = r.nodesInRing(p.x, p.z, 250, 400, this.ringBuf);
      if (ring.length) {
        const path = r.route(r.nearestNode(p.x, p.z), ring[Math.floor(Math.random() * ring.length)]);
        if (path) u.driver.setPath(path);
      }
    }
  }

  private spawnUnit(pv: PlayerView, camera: THREE.Camera): void {
    const fleet = this.d.fleet;
    let car: FleetCar | null = null;
    // 1) машина ДПС из трафика поблизости
    const t = this.d.traffic();
    if (t) {
      let best = null as (typeof t.sim.vehicles)[number] | null, bd = 220;
      for (const v of t.sim.vehicles) {
        if (v.kind !== 'police' || v.crashed) continue;
        const d = Math.hypot(v.x - pv.pos.x, v.z - pv.pos.z);
        if (d < bd && d > 25) { bd = d; best = v; }
      }
      if (best) car = fleet.fromTraffic(best);
    }
    // 2) новая на дороге вне кадра
    if (!car) {
      const r = this.d.router;
      if (!r) return;
      const nodes = r.nodesInRing(pv.pos.x, pv.pos.z, 110, 190, this.ringBuf);
      const cf = camera.getWorldDirection(_v2);
      const target = r.nearestNode(pv.pos.x, pv.pos.z);
      for (let k = 0; k < 12 && nodes.length; k++) {
        const n = nodes[Math.floor(Math.random() * nodes.length)];
        const np = r.nodePos(n, new THREE.Vector3());
        _d.subVectors(np, camera.position).setY(0).normalize();
        if (_d.dot(_v.set(cf.x, 0, cf.z).normalize()) > 0.35 && np.distanceTo(camera.position) < 170) continue; // в кадре
        const path = r.route(n, target);
        if (!path || path.length < 2) continue;
        const yaw = Math.atan2(-(path[1].x - path[0].x), -(path[1].z - path[0].z));
        _q.setFromAxisAngle(_v.set(0, 1, 0), yaw);
        car = fleet.spawn('police', 0xffffff, np.clone(), _q.clone());
        break;
      }
    }
    if (!car) return;
    car.driver = 'ai';
    car.police = true;
    const u: Unit = { car, driver: new AIDriver(), crew: [], replanT: 0, mode: 'chase', lifeT: 0, sirenOn: false };
    u.driver.maxSpeed = 26;
    this.units.push(u);
    this.stats.spawned++;
    // экипаж
    const lvl = this.d.wanted.level;
    for (let k = 0; k < 2 && this.cops.length < MAX_COPS; k++) {
      const w: WeaponId = lvl >= 4 && k === 0 ? (Math.random() < 0.7 ? 'rifle' : 'shotgun') : 'pistol';
      const ch = this.chars[(this.stats.spawned + k) % this.chars.length];
      const cop = new Cop(this.assets!, ch, this.d.scene, this.d.physics, car.vehicle.position.clone(), car, w);
      cop.ragId = this.d.skin.register(cop.rig);
      cop.onHit = (c, dmg, byPlayer, melee, dir, push) => this.copHit(c, dmg, byPlayer, melee, dir, push);
      this.cops.push(cop);
      this.d.combat.fighters.push(cop);
      u.crew.push(cop);
    }
  }

  private updateUnit(u: Unit, dt: number, pv: PlayerView, level: number, camera: THREE.Camera): void {
    const car = u.car, veh = car.vehicle;
    u.lifeT += dt;
    // угнали / взорвали / пропала
    if (car.driver !== 'ai' || !this.d.fleet.cars.includes(car)) { this.removeUnit(u, false); return; }
    if (this.d.combat.damage.wrecked(veh.body)) {
      for (const c of u.crew) if (c.state === 'ride') this.deploy(c, u);
      car.driver = 'none';
      this.removeUnit(u, false);
      return;
    }
    const p = veh.position;
    const dist = Math.hypot(p.x - pv.pos.x, p.z - pv.pos.z);
    // сирена
    const siren = u.mode !== 'leave';
    if (siren !== u.sirenOn) { u.sirenOn = siren; gameEvents.emit('siren', { id: car.id, on: siren, x: p.x, y: p.y, z: p.z }); }
    car.siren = siren;
    if (u.mode === 'leave') {
      const crewIn = u.crew.every((c) => c.state === 'ride' || c.state === 'down' || !this.cops.includes(c));
      if (crewIn) u.driver.drive(veh, dt); else { veh.input.throttle = 0; veh.input.brake = 0; veh.input.handbrake = true; }
      const vis = this.visible(camera, p);
      if ((dist > 160 && !vis) || u.lifeT > 60) this.removeUnit(u, true);
      return;
    }
    // видит?
    const sees = dist < 70 && this.los(_v.copy(p).setY(p.y + 1.3), _v2.copy(pv.pos).setY(pv.pos.y + 1.0));
    if (sees) this.seen = true;
    const target = pv.pos;
    const crewOut = u.crew.some((c) => c.state !== 'ride');
    if (u.mode === 'deploy' || crewOut) {
      // экипаж вышел: стоим; если игрок уехал далеко — экипаж возвращается и снова погоня
      veh.input.throttle = 0; veh.input.brake = veh.forwardSpeed > 1.6 ? 0.8 : 0; veh.input.handbrake = veh.forwardSpeed <= 1.6;
      if (dist > 55 && !pv.onFoot) for (const c of u.crew) if (c.state !== 'ride' && c.state !== 'down') c.state = 'return';
      if (u.crew.every((c) => c.state === 'ride' || c.state === 'down' || !this.cops.includes(c))) u.mode = 'chase';
      return;
    }
    // погоня
    if (sees && dist < 55) {
      u.driver.target = target;
      u.driver.targetVel.copy(pv.vel);
      const inCar = !!pv.inCar;
      u.driver.ram = inCar && level >= 3;
      u.driver.stopDist = inCar ? 6 : 9;
    } else {
      u.driver.target = null;
      u.replanT -= dt;
      if (u.replanT <= 0 && this.d.router) {
        u.replanT = 2.5;
        const r = this.d.router;
        const goal = sees ? target : this.d.wanted.lastKnown;
        const path = r.route(r.nearestNode(p.x, p.z), r.nearestNode(goal.x, goal.z));
        if (path) { path.push(goal.clone()); u.driver.setPath(path); }
      }
    }
    u.driver.maxSpeed = level >= 3 ? 30 : 24;
    u.driver.drive(veh, dt);
    // высадка: игрок пешком рядом (или его машина стоит), машина почти стоит
    const playerStopped = pv.onFoot || pv.vel.length() < 2;
    if (playerStopped && dist < 24 && Math.abs(veh.forwardSpeed) < 2 && sees) {
      u.mode = 'deploy';
      for (const c of u.crew) if (c.state === 'ride') this.deploy(c, u);
    }
  }

  private deploy(c: Cop, u: Unit): void {
    const car = u.car, veh = car.vehicle;
    const side = u.crew.indexOf(c) === 0 ? -1 : 1;
    const at = _v.set(side * (car.halfW + 0.6), 0, -0.3).applyQuaternion(veh.visual.quaternion).add(veh.position);
    at.y = this.d.heightAt(at.x, at.z) + 0.05;
    const ground = this.d.physics.groundHeightAt(at.x, at.z);
    if (ground > at.y - 0.5 && ground < at.y + 2) at.y = ground + 0.05;
    c.body.teleport(at);
    c.body.ignore = veh.body.collider(0);
    c.pos.copy(at);
    c.setRiding(false);
    c.state = 'deploy';
    c.downT = 0.4;
    gameEvents.emit('carDoor', { x: at.x, y: at.y, z: at.z, open: true });
  }

  /** Возвращает true, если этот полицейский сейчас «скручивает» игрока. */
  private updateCop(c: Cop, dt: number, pv: PlayerView, level: number, alpha: number): boolean {
    const rig = c.rig;
    if (c.state === 'ride') {
      if (!c.car || !this.d.fleet.cars.includes(c.car)) { this.removeCop(c); }
      return false;
    }
    if (c.state === 'down') {
      c.downT += dt;
      rig.speed = 0; rig.aim = 'none';
      rig.update(dt);
      if (c.downT > 45 && c.pos.distanceTo(pv.pos) > 60) this.removeCop(c);
      return false;
    }
    c.body.renderPos(alpha, c.pos);
    rig.pos.copy(c.pos);
    const toP = _d.subVectors(pv.pos, c.pos);
    toP.y = 0;
    const dist = toP.length();
    c.losT -= dt;
    if (c.losT <= 0) {
      c.losT = 0.25;
      c.los = pv.alive && dist < 80 && this.los(_v.copy(c.pos).setY(c.pos.y + 1.6), _v2.copy(pv.pos).setY(pv.pos.y + 1.1));
    }
    if (c.los && c.state !== 'return') this.seen = true;
    let wish = 0, faceYaw = rig.yaw, arresting = false;
    const w = WEAPONS[c.weapon];
    c.cooldown -= dt;
    if (c.downT > 0) c.downT -= dt; // короткая пауза после высадки
    const shootLevel = level >= 2;
    switch (c.state) {
      case 'deploy': case 'chase': case 'shoot': case 'arrest': {
        if (!pv.alive || level === 0) { c.state = 'return'; break; }
        faceYaw = Math.atan2(-toP.x, -toP.z);
        const engage = shootLevel ? (c.weapon === 'shotgun' ? 10 : 22) : 1.1;
        if (shootLevel && c.los && dist < engage + 4) {
          c.state = 'shoot';
          c.aimT += dt;
          wish = dist < 5 ? -1.5 : 0; // слишком близко — шаг назад
          if (c.cooldown <= 0 && c.downT <= 0) this.copFire(c, pv, w);
        } else if (!shootLevel && dist < 1.8 && pv.onFoot) {
          c.state = 'arrest';
          arresting = true;
          wish = 0;
        } else if (!shootLevel && pv.inCar && dist < 4 && pv.vel.length() < 1) {
          c.state = 'arrest'; arresting = true; wish = 0;
        } else {
          c.state = 'chase'; c.aimT = Math.max(0, c.aimT - dt);
          wish = dist > 30 ? 6 : 4.6;
          if (!shootLevel && dist < 3) wish = 2;
        }
        break;
      }
      case 'return': {
        const car = c.car;
        if (!car || !this.d.fleet.cars.includes(car) || car.driver !== 'ai') {
          // машины нет — уйти и исчезнуть, когда не видно
          faceYaw = Math.atan2(toP.x, toP.z);
          wish = 1.5;
          if (dist > 70) { this.removeCop(c); return false; }
          break;
        }
        const door = _v.set(-(car.halfW + 0.6), 0, -0.3).applyQuaternion(car.vehicle.visual.quaternion).add(car.vehicle.position);
        const dd = Math.hypot(door.x - c.pos.x, door.z - c.pos.z);
        faceYaw = Math.atan2(-(door.x - c.pos.x), -(door.z - c.pos.z));
        wish = Math.min(3.2, dd * 2);
        if (dd < 1.2) { c.setRiding(true); c.state = 'ride'; c.hp = Math.max(c.hp, 60); gameEvents.emit('carDoor', { x: door.x, y: door.y, z: door.z, open: false }); }
        break;
      }
    }
    // поворот и движение
    let dy = faceYaw - rig.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    rig.yaw += dy * Math.min(1, dt * 8);
    const fx = -Math.sin(faceYaw), fz = -Math.cos(faceYaw);
    let mx = fx * wish, mz = fz * wish;
    // обход: упёрся — шаг вбок на 1 с
    const actual = Math.hypot(c.body.vel.x, c.body.vel.z);
    if (wish > 1 && actual < 0.5) c.stuckT += dt; else c.stuckT = 0;
    if (c.stuckT > 0.6) { c.sideT = 1.0; c.side = Math.random() < 0.5 ? -1 : 1; c.stuckT = 0; }
    if (c.sideT > 0) { c.sideT -= dt; mx = (fx * 0.3 + -fz * c.side) * 3.5; mz = (fz * 0.3 + fx * c.side) * 3.5; }
    c.body.wish.set(mx, mz);
    rig.speed = Math.hypot(c.body.vel.x, c.body.vel.z);
    rig.airborne = !c.body.grounded && c.body.airTime > 0.2;
    const aiming = c.state === 'shoot' || c.state === 'arrest';
    rig.aim = aiming && c.weapon !== 'fists' ? (w.hold === 'rifle' ? 'rifle' : 'pistol') : 'none';
    rig.aimPitch = Math.atan2(pv.pos.y + 1.0 - (c.pos.y + 1.45), Math.max(dist, 0.5));
    rig.update(dt);
    // шаги (звук) — только ближние
    if (rig.speed > 1 && c.pos.distanceTo(pv.pos) < 40) {
      c.stepPhase += (rig.speed * dt) / 0.8;
      if (c.stepPhase > 1) { c.stepPhase -= 1; gameEvents.emit('footstep', { x: c.pos.x, y: c.pos.y, z: c.pos.z, speed: rig.speed, surface: -1, byPlayer: false }); }
    }
    // упал в воду / под мир
    if (c.pos.y < this.d.heightAt(c.pos.x, c.pos.z) - 20) this.removeCop(c);
    return arresting;
  }

  private copFire(c: Cop, pv: PlayerView, w: (typeof WEAPONS)[WeaponId]): void {
    if (c.clip <= 0) { c.clip = w.mag; c.cooldown = w.reload; return; }
    c.clip--;
    c.cooldown = (1 / w.rate) * (w.auto ? 1.6 : 2.2) + Math.random() * 0.4;
    // точка дула: правая кисть
    const muzzle = c.rig.joint('RightHand', new THREE.Vector3());
    _v.set(-Math.sin(c.rig.yaw), 0, -Math.cos(c.rig.yaw));
    muzzle.addScaledVector(_v, w.hold === 'rifle' ? 0.45 : 0.18);
    // целится в корпус; промах тем меньше, чем дольше целится и чем медленнее цель
    _aim.copy(pv.pos).setY(pv.pos.y + (pv.onFoot ? 1.1 : 0.9));
    const miss = Math.max(0.025, 0.11 - c.aimT * 0.03) + Math.min(0.06, pv.vel.length() * 0.008);
    const exclude = c.car ? c.car.vehicle.body : null;
    this.d.combat.fire(w, muzzle, _aim, false, exclude, c, true, miss);
    this.stats.shots++;
  }

  private copHit(c: Cop, _dmg: number, byPlayer: boolean, _melee: boolean, dir: THREE.Vector3, push: number): void {
    if (byPlayer) this.onCopHit?.(true);
    if (c.state === 'ride') return;
    if (c.hp > 0) {
      // пошатнулся; сразу в бой
      if (c.state === 'arrest' || c.state === 'deploy') c.state = 'chase';
      return;
    }
    // нокаут: рэгдолл, оружие выпадает
    c.state = 'down';
    c.downT = 0;
    c.rig.aim = 'none';
    c.body.setActive(false);
    const look: RagdollLook = { jacket: new THREE.Color(COP_LOOK.top), pants: new THREE.Color(COP_LOOK.bottom), head: new THREE.Color(COP_LOOK.hat), skin: new THREE.Color(0xd8b090) };
    const vel = new THREE.Vector3(dir.x * push * 1.2, 1.5, dir.z * push * 1.2);
    const spin = new THREE.Vector3(dir.z * 4, (Math.random() - 0.5) * 2, -dir.x * 4);
    if (!this.d.ragdolls.launch(c.ragId, c.pos.x, c.pos.y + 0.02, c.pos.z, c.rig.yaw, 1, look, vel, spin)) {
      c.rig.lying = 1; c.rig.tumble = Math.PI / 2;
    }
    const drop = c.pos.clone().setY(c.pos.y + 1);
    this.d.pickups.drop('weapon', drop, WEAPONS[c.weapon].pickupAmmo, c.weapon);
    if (Math.random() < 0.35) this.d.pickups.drop('money', drop, 50 + Math.floor(Math.random() * 150));
    if (this.d.wanted.level >= 3 && Math.random() < 0.3) this.d.pickups.drop('armor', drop, 50);
    this.onCopDown?.(byPlayer);
  }

  private ragdollDone(agent: number, r: { x: number; y: number; z: number; headX: number; headZ: number; faceUp: boolean }): void {
    const c = this.cops.find((k) => k.ragId === agent);
    if (!c) { this.onRagdollDone?.(agent, r); return; }
    c.rig.pos.set(r.x, this.d.heightAt(r.x, r.z) + 0.02, r.z);
    c.pos.copy(c.rig.pos);
    if (r.faceUp) { c.rig.tumble = Math.PI / 2; c.rig.yaw = Math.atan2(r.headX, r.headZ); }
    else { c.rig.tumble = -Math.PI / 2; c.rig.yaw = Math.atan2(-r.headX, -r.headZ); }
    c.rig.lying = 1;
  }
  /** Рэгдоллы не полицейских (игрок) — передаются сюда (пул общий). */
  onRagdollDone: ((agent: number, r: { x: number; y: number; z: number; headX: number; headZ: number; faceUp: boolean }) => void) | null = null;

  private visible(camera: THREE.Camera, p: THREE.Vector3): boolean {
    const f = camera.getWorldDirection(_v2);
    _d.subVectors(p, camera.position);
    const l = _d.length();
    return l < 220 && _d.dot(f) / (l || 1) > 0.5;
  }

  /** Движущиеся машины полиции — для пешеходов (уклонение/удар) и трафика (препятствия). */
  forEachCar(fn: (id: number, x: number, y: number, z: number, vx: number, vz: number, fx: number, fz: number, hl: number, hw: number) => void): void {
    for (const u of this.units) {
      const v = u.car.vehicle, p = v.position, lv = v.body.linvel();
      _v.set(0, 0, -1).applyQuaternion(v.visual.quaternion);
      const l = Math.hypot(_v.x, _v.z) || 1;
      fn(2_000_000 + u.car.id, p.x, p.y, p.z, lv.x, lv.z, _v.x / l, _v.z / l, u.car.halfLen, u.car.halfW);
    }
  }

  /** Отладка. */
  debug() {
    return {
      units: this.units.map((u) => ({ id: u.car.id, mode: u.mode, kmh: Math.round(u.car.vehicle.speed * 3.6), crew: u.crew.map((c) => c.state), x: Math.round(u.car.vehicle.position.x), z: Math.round(u.car.vehicle.position.z) })),
      cops: this.cops.map((c) => ({ state: c.state, hp: c.hp, weapon: c.weapon, los: c.los, x: +c.pos.x.toFixed(1), z: +c.pos.z.toFixed(1) })),
      stats: this.stats,
    };
  }
}
