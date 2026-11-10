import * as THREE from 'three';
import type { PhysicsWorld } from '../physics/world';
import type { RagdollPool, RagdollLook } from '../people/ragdoll';
import type { PeopleSystem } from '../people/people-system';
import type { Combat, Fighter } from '../combat/combat';
import type { Effects } from '../combat/effects';
import { Pickups, type Pickup } from '../combat/pickups';
import { Inventory, WEAPONS, WEAPON_ORDER, type WeaponId } from '../combat/weapons';
import { buildWeaponMesh, type WeaponMesh } from '../combat/weapon-meshes';
import { gameEvents } from '../combat/events';
import type { Wanted, Crime } from '../police/wanted';
import type { Police } from '../police/police';
import type { OrbitCamera } from '../camera/orbit-camera';
import type { GtaHud } from '../hud/gta-hud';
import { CharacterBody } from './character-body';
import { climbPose, probeClimb, type ClimbPlan } from './climb';
import { HumanRig, type RigRagdollSkin } from './human-rig';
import type { RigAssets } from './rig-assets';
import { kindName, type EnterCandidate, type Fleet, type FleetCar } from './fleet';
import type { FootControls } from './controls';

/**
 * Игрок в GTA-режиме (docs/stage3/gta-mode.md): за рулём любой машины или пешком (HumanRig + капсула KCC).
 * Состояния: driving → exiting → foot → entering (подойти к двери, «сесть») → driving; down (рэгдолл, встаёт),
 * dead / busted (надпись, респаун у больницы / отдела полиции с потерей оружия и части денег).
 */
export type PlayerState = 'foot' | 'entering' | 'driving' | 'exiting' | 'down' | 'dead' | 'busted';

export interface Place { type: string; name: string; x: number; y: number; z: number }

export interface PlayerDeps {
  physics: PhysicsWorld;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orbit: OrbitCamera;
  fleet: Fleet;
  combat: Combat;
  effects: Effects;
  pickups: Pickups;
  wanted: Wanted;
  police: Police;
  hud: GtaHud;
  ragdolls: RagdollPool;
  skin: RigRagdollSkin;
  people: () => PeopleSystem | null;
  heightAt: (x: number, z: number) => number;
  surfaceAt: (x: number, z: number) => number;
  /** Сменилось тело, которое считается «игроком» (трафик, поезда, пропсы). */
  onBodyChange: (body: import('../physics/world').RAPIER.RigidBody, length: number, width: number, mass: number, vehicle: boolean) => void;
  /** Телепорт для респауна (подгрузка тайлов вокруг). */
  preload: (p: THREE.Vector3) => Promise<void>;
  places: () => Place[];
  /** Ближайший узел пешеходного/дорожного графа к точке (респаун снаружи здания). */
  snapToWalkable: (p: THREE.Vector3) => THREE.Vector3;
}

const PLAYER_LOOK = { top: 0x232323, bottom: 0x2b3f63, hat: 0x222222, hair: 0x2a1d14 };
/**
 * Наряды персонажа игрока (assets/scripts/people/characters.json, body 'player'): параметрическое сходство с автором,
 * цвета — тон регионов (верх/низ/шапка/волосы). default — джинсы + тёмно-бирюзовая куртка; robe — пасхалка «халат»
 * (?outfit=robe, GUI «player»); winter — пальто, шапка, шарф, перчатки (по сезону, GtaMode.setWinter).
 */
export const PLAYER_OUTFITS = {
  default: { id: 'player_me', look: { top: 0x1d4d4f, bottom: 0x2b3f63, hat: 0x222222, hair: 0xa07e58 } },
  robe: { id: 'player_me_robe', look: { top: 0x1b4a4d, bottom: 0x1b4a4d, hat: 0x222222, hair: 0xa07e58 } },
  winter: { id: 'player_me_winter', look: { top: 0x24282d, bottom: 0x2a2d33, hat: 0x6b2230, hair: 0xa07e58 } },
} as const;
export type PlayerOutfit = keyof typeof PLAYER_OUTFITS;
const WATER = 14;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _fwd = new THREE.Vector3();

export class Player implements Fighter {
  readonly isPlayer = true;
  readonly isCop = false;
  state: PlayerState = 'driving';
  car: FleetCar;
  readonly body: CharacterBody;
  rig: HumanRig | null = null;
  hp = 100;
  armor = 0;
  money = 250;
  readonly inv = new Inventory();
  /** Ноги (интерполированные) или позиция машины. */
  readonly pos = new THREE.Vector3();
  yaw = 0;
  private enter: { cand: EnterCandidate; t: number; phase: 'walk' | 'climb'; fc: FleetCar | null; from: THREE.Vector3; timeout: number;
    /** Лучшее расстояние до двери и сколько с без приближения к ней (дверь заперта соседями/стеной). */
    best: number; stall: number } | null = null;
  private exitT = 0;
  private exitFrom = new THREE.Vector3();
  private exitTo = new THREE.Vector3();
  private stateT = 0;
  private ragId = -1;
  private weaponMesh: WeaponMesh | null = null;
  private weaponMeshId: WeaponId | null = null;
  private stepPhase = 0;
  /** Перелезает: план (player/climb.ts) и время. */
  private climb: { plan: ClimbPlan; t: number } | null = null;
  private climbPlan: ClimbPlan | null = null;
  private probeT = 0;
  private lastPlan: ClimbPlan | null = null;
  private lastPlanAge = 9;
  /** Подсказка HUD («Пробел — перелезть»). */
  climbHint = '';
  /** Высота модели (сглаженная по ступеням). */
  private visY = 0;
  private waterT = 0;
  private aimT = 0;
  private wheelX = 0; private wheelY = 0; private wheelOpen = false;
  private lastHurt = 0;
  private fightBack: { i: number; t: number; hitCd: number } | null = null;
  private seat = new THREE.Vector3();
  prompt = '';
  /** Режим бога (отладка). */
  god = false;

  constructor(private d: PlayerDeps, car: FleetCar) {
    this.car = car;
    car.driver = 'player';
    this.body = new CharacterBody(d.physics, car.vehicle.position.clone().setY(car.vehicle.position.y + 30));
    this.body.setActive(false);
    this.body.onLand = (fs) => this.landed(fs);
    this.pos.copy(car.vehicle.position);
    d.combat.fighters.push(this);
  }

  private look: { top: number; bottom: number; hat: number; hair: number } = PLAYER_LOOK;
  /** Id персонажа текущего меша. */
  rigId = '';

  async loadRig(assets: RigAssets, id: string, look: { top: number; bottom: number; hat: number; hair: number } = PLAYER_LOOK): Promise<void> {
    const ch = await assets.character(id);
    this.look = look;
    this.rigId = id;
    this.rig = new HumanRig(assets, ch, look, this.d.scene);
    this.rig.visible = this.state === 'foot';
    this.ragId = this.d.skin.register(this.rig);
  }

  /** Можно ли сейчас переодеть (смена меша): не во время рэгдолла/падения/посадки. */
  canSwapRig(): boolean { return !!this.rig && !this.rig.ragdolled && (this.state === 'foot' || this.state === 'driving'); }

  /** Переодеть игрока: новый меш персонажа с теми же позой и положением (старый убирается). */
  async swapRig(assets: RigAssets, id: string, look: { top: number; bottom: number; hat: number; hair: number }): Promise<void> {
    const old = this.rig, oldId = this.ragId;
    const ch = await assets.character(id);
    if (!this.canSwapRig() || this.rig !== old) return;
    const rig = new HumanRig(assets, ch, look, this.d.scene);
    if (old) {
      rig.pos.copy(old.pos); rig.yaw = old.yaw;
      rig.visible = old.visible;
      this.d.skin.unregister(oldId);
      old.dispose();
    }
    this.look = look;
    this.rigId = id;
    this.rig = rig;
    this.ragId = this.d.skin.register(rig);
  }

  get driving(): boolean { return this.state === 'driving'; }
  get onFoot(): boolean { return this.state === 'foot' || this.state === 'entering' || this.state === 'exiting' || this.state === 'down'; }
  get down(): boolean { return this.state === 'down' || this.state === 'dead'; }
  get alive(): boolean { return this.state !== 'dead' && this.state !== 'busted'; }
  hittable(): boolean { return (this.state === 'foot' || (this.state === 'entering' && this.enter?.phase === 'walk') || this.state === 'down') && !this.god; }

  /** Позиция «фокуса» (стриминг, камера, звук): машина или ноги. */
  get focus(): THREE.Vector3 { return this.state === 'driving' ? this.car.vehicle.position : this.pos; }

  // ------------------------------------------------------------------ урон
  takeHit(dmg: number, dir: THREE.Vector3, push: number, byPlayer: boolean, melee: boolean): void {
    if (!this.hittable()) return;
    // аркада: пули полиции по игроку слабее (ПМ ≈ 12)
    this.hurt(!byPlayer && !melee && push < 9 ? dmg * 0.35 : dmg);
    if (this.rig) this.rig.hitFlash = 1;
    if (this.state === 'dead') return;
    if ((melee && push > 6) || push > 9) this.knockDown(_v.copy(dir).multiplyScalar(push).setY(2));
    void byPlayer;
  }

  hurt(dmg: number): void {
    if (this.god || !this.alive) return;
    this.lastHurt = 0;
    if (this.armor > 0) {
      const a = Math.min(this.armor, dmg * 0.65);
      this.armor -= a; dmg -= a;
    }
    this.hp -= dmg;
    if (this.hp <= 0) { this.hp = 0; this.die(); }
  }

  private die(): void {
    if (this.state === 'dead') return;
    const p = this.focus.clone();
    if (this.state === 'driving' || this.state === 'exiting' || this.state === 'entering') this.ejectFromCar(false);
    if (this.state !== 'down' && this.rig && !this.rig.ragdolled) this.launchRagdoll(_v.set(0, 0.5, 0));
    this.state = 'dead';
    this.stateT = 0;
    this.d.hud.setBig('ПОТРАЧЕНО');
    gameEvents.emit('wasted', { x: p.x, y: p.y, z: p.z });
  }

  busted(): void {
    if (!this.alive) return;
    const p = this.focus.clone();
    if (this.state === 'driving') this.ejectFromCar(false);
    this.state = 'busted';
    this.stateT = 0;
    this.body.wish.set(0, 0);
    if (this.rig) { this.rig.aim = 'none'; this.rig.speed = 0; }
    this.d.hud.setBig('АРЕСТОВАН', '#4a7cff');
    gameEvents.emit('busted', { x: p.x, y: p.y, z: p.z });
  }

  private landed(fallSpeed: number): void {
    const p = this.pos;
    gameEvents.emit('land', { x: p.x, y: p.y, z: p.z, speed: fallSpeed });
    if (fallSpeed > 8) this.d.effects.dust(p, 8);
    if (fallSpeed > 13) {
      this.hurt((fallSpeed - 13) * 9);
      if (this.alive && fallSpeed > 16) this.knockDown(_v.set(this.body.vel.x, 1, this.body.vel.z));
    }
  }

  /** Сбить с ног (рэгдолл), потом встаёт. */
  knockDown(vel: THREE.Vector3): void {
    if (this.state === 'down' || this.state === 'dead' || !this.rig) return;
    if (this.state === 'entering') this.enter = null;
    this.state = 'down';
    this.stateT = 0;
    this.launchRagdoll(vel);
  }

  private launchRagdoll(vel: THREE.Vector3): void {
    const rig = this.rig;
    if (!rig) return;
    this.climb = null; rig.reach = 'none';
    this.body.setActive(false);
    rig.visible = true;
    rig.aim = 'none';
    // поза и матрица модели — здесь и сейчас: рэгдолл запоминает скин относительно текущей матрицы меша (RigRagdollSkin).
    // В машине модель не обновлялась (невидима), и при «выпрыгнуть на ходу» тело рисовалось там, где игрок садился в машину
    // (за сотни метров) — «после выхода меня не видно», пока рэгдолл не встанет
    const p0 = this.state === 'driving' ? this.car.vehicle.position : this.pos;
    rig.pos.copy(p0); rig.yaw = this.yaw; rig.sit = 0; rig.lying = 0; rig.tumble = 0; rig.speed = 0; rig.airborne = false;
    rig.update(0);
    const look: RagdollLook = { jacket: new THREE.Color(this.look.top), pants: new THREE.Color(this.look.bottom), head: new THREE.Color(this.look.hair), skin: new THREE.Color(0xd8b090) };
    const spin = new THREE.Vector3(vel.z * 0.6, (Math.random() - 0.5) * 2, -vel.x * 0.6);
    const p = this.state === 'driving' ? this.car.vehicle.position : this.pos;
    if (!this.d.ragdolls.launch(this.ragId, p.x, p.y + 0.05, p.z, this.yaw, 1, look, vel, spin)) {
      rig.lying = 1; rig.tumble = Math.PI / 2;
    }
  }

  /** Рэгдолл улёгся (PoliceForce передаёт сюда). */
  ragdollDone(agent: number, r: { x: number; y: number; z: number; headX: number; headZ: number; faceUp: boolean }): void {
    if (agent !== this.ragId || !this.rig) return;
    const g = this.d.heightAt(r.x, r.z);
    const gy = Math.max(g, r.y - 0.3);
    this.rig.pos.set(r.x, gy + 0.02, r.z);
    this.pos.copy(this.rig.pos);
    if (r.faceUp) { this.rig.tumble = Math.PI / 2; this.yaw = Math.atan2(r.headX, r.headZ); }
    else { this.rig.tumble = -Math.PI / 2; this.yaw = Math.atan2(-r.headX, -r.headZ); }
    this.rig.yaw = this.yaw;
    this.rig.lying = 1;
    this.stateT = Math.max(this.stateT, 0.01);
  }

  // ------------------------------------------------------------------ машина
  private takeControl(fc: FleetCar): void {
    this.car = fc;
    fc.driver = 'player';
    this.state = 'driving';
    this.body.setActive(false);
    if (this.rig) { this.rig.visible = false; this.rig.sit = 0; }
    const v = fc.vehicle;
    this.d.onBodyChange(v.body, v.cfg.chassis.length, v.cfg.chassis.width, v.cfg.chassis.mass, true);
  }

  /** Выйти из машины (обычный выход или «выпрыгнуть» на скорости). */
  private startExit(): void {
    const fc = this.car, v = fc.vehicle;
    const speed = v.speed;
    fc.driver = 'none';
    if (speed > 7) { this.ejectFromCar(true); return; }
    // точка выхода: дверь водителя, если не в стене — иначе справа
    const q = v.visual.quaternion;
    const door = this.d.fleet.door(fc, v.position, q, new THREE.Vector3());
    const ground = (p: THREE.Vector3) => this.d.physics.groundHeightAt(p.x, p.z);
    const terr = (p: THREE.Vector3) => this.d.heightAt(p.x, p.z);
    if (ground(door) - terr(door) > 1.2) {
      const alt = _v.set(fc.halfW + 0.55, 0, -0.35).applyQuaternion(q).add(v.position);
      if (ground(alt) - terr(alt) < 1.2) door.copy(alt);
    }
    door.y = Math.max(terr(door), Math.min(ground(door), terr(door) + 1.0)) + 0.02;
    this.exitTo.copy(door);
    this.exitFrom.copy(this.seatPos(fc, this.seat));
    this.exitT = 0;
    this.state = 'exiting';
    this.yaw = Math.atan2(-(door.x - v.position.x), -(door.z - v.position.z)) + Math.PI;
    gameEvents.emit('carDoor', { x: door.x, y: door.y, z: door.z, open: true });
  }

  /** Сиденье водителя (мир): слева спереди, ниже крыши. */
  private seatPos(fc: FleetCar, out: THREE.Vector3): THREE.Vector3 {
    const v = fc.vehicle;
    const bus = fc.cls === 'bus' || fc.cls === 'trolleybus';
    return out.set(bus ? -fc.halfW * 0.5 : -0.38, -0.55, bus ? -fc.halfLen + 1.3 : -0.25).applyQuaternion(v.visual.quaternion).add(v.position);
  }

  /** Мгновенно оказаться снаружи (смерть в машине / прыжок на ходу — рэгдолл со скоростью машины). */
  private ejectFromCar(ragdoll: boolean): void {
    const fc = this.car, v = fc.vehicle;
    fc.driver = 'none';
    const door = this.d.fleet.door(fc, v.position, v.visual.quaternion, new THREE.Vector3());
    door.y = Math.max(this.d.heightAt(door.x, door.z), v.position.y - 0.6);
    this.body.teleport(door);
    this.pos.copy(door);
    if (this.rig) { this.rig.pos.copy(door); this.rig.sit = 0; }
    this.d.onBodyChange(this.body.body, 0.6, 0.6, 80, false);
    if (ragdoll && this.rig) {
      this.state = 'foot';
      const lv = v.body.linvel();
      this.knockDown(_v.set(lv.x * 0.8, 2, lv.z * 0.8));
    } else {
      this.state = 'foot';
      this.body.setActive(true);
    }
  }

  // ------------------------------------------------------------------ кадр (до физики)
  preUpdate(dt: number, c: FootControls, drive: { throttle: number; brake: number; steer: number; handbrake: boolean; nitro: boolean }): void {
    this.stateT += dt;
    this.lastHurt += dt;
    const orbit = this.d.orbit;
    if (this.state === 'driving') {
      const v = this.car.vehicle;
      const wreck = this.d.combat.damage.wrecked(v.body);
      Object.assign(v.input, drive);
      if (wreck) { v.input.throttle = 0; v.input.nitro = false; }
      if (c.siren && this.car.police) { this.car.siren = !this.car.siren; gameEvents.emit('siren', { id: this.car.id, on: this.car.siren, x: v.position.x, y: v.position.y, z: v.position.z }); }
      if (c.enter) this.startExit();
      this.prompt = wreck ? '<b>F</b> — выйти' : '';
      return;
    }
    if (this.state === 'dead' || this.state === 'busted') { this.body.wish.set(0, 0); return; }
    // --- пешком
    orbit.look(c.lookX, c.lookY);
    if (this.state === 'down') {
      this.body.wish.set(0, 0);
      // встать: рэгдолл улёгся (lying), полежать 0.6 с, подъём 0.9 с
      const rig = this.rig;
      if (rig && !rig.ragdolled && rig.lying > 0) {
        if (this.stateT > 1.2) {
          const t = Math.min(1, (this.stateT - 1.2) / 0.9);
          rig.tumble *= 1 - Math.min(1, dt * 5 * t);
          rig.lying = 1 - t;
          if (t >= 1) {
            rig.tumble = 0; rig.lying = 0;
            this.body.teleport(rig.pos);
            this.body.setActive(true);
            this.state = 'foot';
          }
        }
      } else if (!rig) { this.state = 'foot'; this.body.setActive(true); }
      return;
    }
    if (this.state === 'exiting') { this.body.wish.set(0, 0); return; }
    if (this.climb) { this.body.wish.set(0, 0); return; } // перелезает: траектория в postUpdate
    this.resolveMelee(dt);
    // оружие
    this.weaponInput(c, dt);
    // ввод движения относительно камеры
    const camYaw = orbit.yaw;
    const sx = Math.sin(camYaw), cx = Math.cos(camYaw);
    let wx = c.mx * cx + c.my * -sx, wz = c.mx * -sx + c.my * -cx;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    const aiming = c.aim && this.inv.current !== 'fists';
    const speed = aiming ? 2.2 : c.walk ? 1.5 : c.sprint ? 7.2 : 4.6;
    let wishX = wx * speed, wishZ = wz * speed;
    // посадка: автопилот к двери
    if (this.state === 'entering' && this.enter) {
      const e = this.enter;
      if (e.phase === 'walk') {
        e.timeout -= dt;
        // дверь движущейся машины — пересчитать
        this.refreshDoor(e);
        const dx = e.cand.door.x - this.pos.x, dz = e.cand.door.z - this.pos.z, dd = Math.hypot(dx, dz);
        if (dd < e.best - 0.05) { e.best = dd; e.stall = 0; } else e.stall += dt;
        // дверь недостижима (соседняя машина вплотную, столб, стена, сама машина на пути): не «висеть» у борта 5 с, а сесть
        // сразу — упёрся (0.4 с без приближения) или 2 с на подход; далеко от двери (> 4 м) — отмена
        const stuck = e.stall > 0.4 || e.timeout < 3;
        if (wl > 0.3 || c.jump || (stuck && dd > 4)) { this.enter = null; this.state = 'foot'; }
        else if (dd < 0.75 || stuck) { this.beginClimb(e); wishX = 0; wishZ = 0; }
        else { const sp = Math.min(5.2, dd * 4 + 1); wishX = (dx / dd) * sp; wishZ = (dz / dd) * sp; }
      } else { wishX = 0; wishZ = 0; }
    }
    // перелезть / забраться (player/climb.ts): Пробел у препятствия, на спринте низкое — само
    this.climbHint = '';
    if (this.state === 'foot' && this.body.grounded && !aiming) {
      const fx = wl > 0.1 ? wx : -Math.sin(this.yaw), fz = wl > 0.1 ? wz : -Math.cos(this.yaw);
      this.probeT -= dt;
      if (c.jump || wl > 0.1 || this.probeT <= 0) {
        this.probeT = 0.2;
        const pl = probeClimb(this.d.physics, this.body.feet, fx, fz);
        if (pl) { this.lastPlan = pl; this.lastPlanAge = 0; }
        this.climbPlan = pl;
      }
      this.lastPlanAge += dt;
      let plan = this.climbPlan;
      // Пробел кадром позже, чем разбор нашёл препятствие (пограничная точка — столб/куст у места приземления): берём
      // недавний план, сдвинув начало к текущим ногам
      if (!plan && c.jump && this.lastPlan && this.lastPlanAge < 0.25) {
        const lp = this.lastPlan, f = this.body.feet;
        const moved = (f.x - lp.start.x) * lp.dx + (f.z - lp.start.z) * lp.dz;
        if (lp.near - moved > 0.25) plan = { ...lp, start: f.clone(), near: lp.near - moved };
      }
      if (plan) {
        this.climbHint = plan.kind === 'ledge' ? '<b>Пробел</b> — забраться' : '<b>Пробел</b> — перелезть';
        const auto = c.sprint && plan.kind === 'vault' && this.body.groundSpeed > 4 && plan.near < 0.75;
        if (c.jump || auto) { this.startClimb(plan); return; }
      }
    } else this.climbPlan = null;
    if (c.jump && this.body.grounded && this.state === 'foot') {
      this.body.jumpRequest = true;
      gameEvents.emit('jump', { x: this.pos.x, y: this.pos.y, z: this.pos.z });
    }
    // лицом: в прицеле/при стрельбе — по камере, иначе — по движению
    const moving = Math.hypot(this.body.vel.x, this.body.vel.z) > 0.4;
    const faceCam = aiming || this.aimT > 0;
    let targetYaw = this.yaw;
    if (faceCam) targetYaw = camYaw;
    else if (wl > 0.1 || (this.state === 'entering' && moving)) targetYaw = Math.atan2(-wishX, -wishZ);
    let dy = targetYaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * Math.min(1, dt * (aiming ? 20 : 12));
    // резкий разворот без прицела: сначала повернуться, потом разгоняться — иначе ноги бегут «вперёд», а тело
    // скользит вбок/назад (лунная походка) все ~0.2 с, пока курс догоняет скорость
    if (!faceCam && this.body.grounded && (wishX !== 0 || wishZ !== 0)) {
      const rest = Math.atan2(Math.sin(targetYaw - this.yaw), Math.cos(targetYaw - this.yaw));
      const k = Math.min(1, Math.max(0.15, (Math.cos(rest) + 0.25) / 1.25));
      wishX *= k; wishZ *= k;
    }
    this.body.wish.set(wishX, wishZ);
    // F — сесть / угнать
    if (this.state === 'foot' && c.enter) {
      const cand = this.d.fleet.findEnterable(this.pos, 7);
      if (cand && !(cand.traffic && cand.traffic.v > 6)) {
        this.enter = { cand, t: 0, phase: 'walk', fc: cand.car, from: this.pos.clone(), timeout: 5, best: Infinity, stall: 0 };
        this.state = 'entering';
      }
    }
    // E — ограбить / багажник
    if (this.state === 'foot' && c.interact) this.interact();
  }

  private startClimb(plan: ClimbPlan): void {
    this.climb = { plan, t: 0 };
    this.climbPlan = null; this.climbHint = '';
    this.body.setActive(false); // капсула выключена: без столкновений с забором, тело ведёт траектория
    this.body.vel.set(0, 0, 0);
    this.yaw = Math.atan2(-plan.dx, -plan.dz);
    gameEvents.emit('jump', { x: this.pos.x, y: this.pos.y, z: this.pos.z });
  }

  /** Кадр перелезания: ноги по траектории, в конце — капсула на месте приземления. */
  private updateClimb(dt: number, time: number): void {
    const cl = this.climb!, rig = this.rig;
    cl.t += dt;
    const u = Math.min(1, cl.t / cl.plan.dur);
    const r = climbPose(cl.plan, u, this.pos);
    this.visY = this.pos.y;
    if (rig) {
      rig.visible = true; rig.sit = 0; rig.aim = 'none';
      rig.pos.copy(this.pos); rig.yaw = this.yaw;
      rig.speed = 0; rig.airborne = r.air; rig.reach = r.reach;
      rig.update(dt);
      this.updateWeaponMesh(true);
    }
    if (u >= 1) {
      this.climb = null;
      if (rig) rig.reach = 'none';
      this.body.teleport(cl.plan.land);
      this.body.setActive(true);
      this.body.grounded = true;
      gameEvents.emit('land', { x: this.pos.x, y: this.pos.y, z: this.pos.z, speed: 2 });
    }
    this.updateCamera(dt, time);
  }

  private refreshDoor(e: NonNullable<Player['enter']>): void {
    const cand = e.cand;
    if (cand.car) {
      const v = cand.car.vehicle;
      this.d.fleet.door(cand.car, v.position, v.visual.quaternion, cand.door, cand.side);
    } else if (cand.traffic) {
      const v = cand.traffic;
      if (!v.alive) { this.enter = null; this.state = 'foot'; return; }
      const yaw = Math.atan2(-v.fx, -v.fz);
      _q.setFromAxisAngle(_v3.set(0, 1, 0), yaw);
      this.d.fleet.door({ halfLen: v.len / 2, halfW: v.halfW, cls: v.kind === 'paz' || v.kind === 'liaz' || v.kind === 'trolleybus' ? 'bus' : 'car' }, _v2.set(v.x, v.y, v.z), _q, cand.door, cand.side);
    }
  }

  private beginClimb(e: NonNullable<Player['enter']>): void {
    const cand = e.cand;
    let fc = cand.car;
    let crime: Crime | null = null;
    let driverOut = false;
    if (!fc && cand.traffic) {
      if (!cand.traffic.alive) { this.enter = null; this.state = 'foot'; return; }
      fc = this.d.fleet.fromTraffic(cand.traffic);
      crime = 'carjack'; driverOut = true;
    } else if (!fc && cand.parked) {
      fc = this.d.fleet.fromParked(cand.parked);
      crime = 'steal';
    } else if (fc && fc.driver === 'ai') {
      fc.driver = 'none';
      crime = 'carjack'; driverOut = !fc.police;
    }
    if (!fc) { this.enter = null; this.state = 'foot'; return; }
    e.fc = fc;
    fc.driver = 'player'; // занята: полиция/флот не трогают, ручник
    const v = fc.vehicle;
    v.input.throttle = 0; v.input.handbrake = true;
    e.phase = 'climb';
    e.t = 0;
    e.from.copy(this.pos);
    this.body.setActive(false);
    gameEvents.emit('carDoor', { x: this.pos.x, y: this.pos.y, z: this.pos.z, open: true });
    // водитель вылетает из машины и убегает (или злится и лезет в драку)
    if (driverOut) {
      const ppl = this.d.people();
      if (ppl) {
        const door = cand.door;
        const away = _v.subVectors(door, v.position).setY(0).normalize();
        const i = ppl.spawnAt(door.x + away.x * 0.3, this.d.heightAt(door.x, door.z), door.z + away.z * 0.3, Math.atan2(away.x, away.z));
        if (i >= 0) {
          ppl.strike(i, away.x * 4.5, 1.5, away.z * 4.5);
          if (Math.random() < 0.3) this.fightBack = { i, t: 10, hitCd: 2.5 };
        }
      }
    }
    if (crime) this.crime(crime, this.pos);
  }

  private weaponInput(c: FootControls, dt: number): void {
    const inv = this.inv;
    // колесо оружия
    if (c.wheel) {
      if (!this.wheelOpen) { this.wheelOpen = true; this.wheelX = 0; this.wheelY = 0; }
      this.wheelX += c.lookX; this.wheelY += c.lookY;
      this.d.hud.showWheel(true, this.wheelX, this.wheelY, (w) => inv.has(w), inv.current);
      c.lookX = 0; c.lookY = 0;
    } else if (this.wheelOpen) {
      this.wheelOpen = false;
      const sel = this.d.hud.wheelSel;
      this.d.hud.showWheel(false, 0, 0, () => true, inv.current);
      if (sel && inv.select(sel)) gameEvents.emit('weaponSwitch', { weapon: sel });
    }
    if (c.weaponDelta && inv.cycle(Math.sign(c.weaponDelta))) gameEvents.emit('weaponSwitch', { weapon: inv.current });
    if (c.weaponSelect >= 0 && inv.select(WEAPON_ORDER[c.weaponSelect])) gameEvents.emit('weaponSwitch', { weapon: inv.current });
    inv.cooldown -= dt;
    if (inv.reloadT > 0) { inv.reloadT -= dt; if (inv.reloadT <= 0) inv.finishReload(); }
    const w = inv.def;
    if (c.reload && !w.melee && inv.slot.clip < w.mag && inv.slot.reserve > 0 && inv.reloadT <= 0) { inv.reloadT = w.reload; gameEvents.emit('reload', { weapon: w.id }); }
    this.aimT = Math.max(0, this.aimT - dt);
    if (this.state !== 'foot') return;
    if (c.kick && inv.cooldown <= 0) { this.attackMelee(true); return; }
    if (w.melee) {
      if ((c.firePressed || c.punch) && inv.cooldown <= 0) this.attackMelee(false);
      return;
    }
    if (c.punch && inv.cooldown <= 0) { this.attackMelee(false); return; }
    const want = w.auto ? c.fire : c.firePressed;
    if (want && inv.cooldown <= 0 && inv.reloadT <= 0) {
      if (inv.slot.clip <= 0) {
        if (inv.slot.reserve > 0) { inv.reloadT = w.reload; gameEvents.emit('reload', { weapon: w.id }); }
        else { gameEvents.emit('dryFire', { weapon: w.id }); inv.cooldown = 0.3; }
        return;
      }
      this.shoot(c.aim);
    }
  }

  private attackMelee(kick: boolean): void {
    const rig = this.rig;
    const w = WEAPONS.fists;
    this.inv.cooldown = kick ? 0.9 : 1 / w.rate;
    rig?.play(kick ? 'kick' : 'punch', { upper: !kick, rate: kick ? 1.3 : 1.5 });
    // удар — с задержкой до «контакта» анимации (≈0.2 с); проще — сразу, но с поворотом к камере
    this.yaw = this.d.orbit.yaw;
    this.aimT = 0.3;
    this.pendingMelee = { t: kick ? 0.33 : 0.19, kick }; // контакт — по ходу анимации
  }
  private pendingMelee: { t: number; kick: boolean } | null = null;

  private resolveMelee(dt: number): void {
    const pm = this.pendingMelee;
    if (!pm) return;
    pm.t -= dt;
    if (pm.t > 0) return;
    this.pendingMelee = null;
    if (this.state !== 'foot') return;
    const h = this.d.combat.melee(WEAPONS.fists, this.pos, this.yaw, true, this, pm.kick);
    // удар по прохожему: часто выпадают деньги
    if (h?.kind === 'ped' && Math.random() < 0.6) this.d.pickups.drop('money', _v.copy(h.point), 10 + Math.floor(Math.random() * 90));
  }

  /** Выстрел: из камеры в точку прицела, из дула — в эту точку. */
  private shoot(aiming: boolean): void {
    const inv = this.inv, w = inv.def;
    inv.slot.clip--;
    inv.cooldown = 1 / w.rate;
    this.aimT = 0.6;
    this.yaw = this.d.orbit.yaw;
    const cam = this.d.camera;
    const dir = this.d.orbit.forward(_fwd);
    const origin = _v.copy(cam.position).addScaledVector(dir, 0.5);
    const probe = this.d.combat.raycast(origin, dir, w.range, null, this, { kind: 'none', t: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), ped: -1, fighter: null, body: null, trafficId: -1 });
    const aimPoint = probe.point.clone();
    const muzzle = this.muzzleWorld(_v2);
    const moving = Math.hypot(this.body.vel.x, this.body.vel.z) > 1;
    this.d.combat.fire(w, muzzle, aimPoint, true, null, this, moving || !aiming, aiming ? 0 : 0.02);
    this.d.orbit.pitch += 0.008 * (w.id === 'shotgun' ? 4 : w.id === 'rifle' ? 1 : 2);
    this.d.effects.shake = Math.max(this.d.effects.shake, w.id === 'shotgun' ? 0.25 : 0.08);
  }

  private muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    if (this.weaponMesh) {
      this.weaponMesh.root.updateMatrixWorld();
      return out.copy(this.weaponMesh.muzzle).applyMatrix4(this.weaponMesh.root.matrixWorld);
    }
    return out.copy(this.pos).setY(this.pos.y + 1.4);
  }

  private interact(): void {
    const p = this.pos;
    // багажник машины ДПС: оружие
    for (const fc of this.d.fleet.cars) {
      if (!fc.police || fc.trunkLooted || fc.driver === 'ai' && fc.vehicle.speed > 1) continue;
      const v = fc.vehicle;
      const trunk = _v.set(0, 0, fc.halfLen + 0.5).applyQuaternion(v.visual.quaternion).add(v.position);
      if (Math.hypot(trunk.x - p.x, trunk.z - p.z) < 1.6) {
        fc.trunkLooted = true;
        const wid: WeaponId = this.d.wanted.level >= 4 || this.inv.has('shotgun') ? 'rifle' : 'shotgun';
        this.giveWeapon(wid, WEAPONS[wid].pickupAmmo);
        this.armor = Math.max(this.armor, 50);
        this.d.hud.toast(`Багажник ДПС: ${WEAPONS[wid].name}, бронежилет`);
        gameEvents.emit('pickup', { kind: 'weapon', amount: WEAPONS[wid].pickupAmmo, x: p.x, y: p.y, z: p.z });
        this.crime('steal', p);
        return;
      }
    }
    // ограбление пешехода
    const ppl = this.d.people();
    if (!ppl) return;
    let best = -1, bd = 2.2;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    ppl.forEachAgent(p.x, p.z, 2.5, (i, x, _y, z, _yaw, down) => {
      if (down || ppl.isKid(i)) return;
      const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
      if (d < bd && (dx * fx + dz * fz) / (d || 1) > 0.2) { bd = d; best = i; }
    });
    if (best < 0) return;
    const at = ppl.agentPos(best, new THREE.Vector3());
    const sum = 30 + Math.floor(Math.random() * 270);
    this.d.pickups.drop('money', at.clone().setY(at.y + 1), sum);
    ppl.flee(best, p.x, p.z);
    ppl.panic(at.x, at.z, 18, best);
    gameEvents.emit('scream', { x: at.x, y: at.y, z: at.z });
    this.d.hud.toast('Ограбление!');
    this.crime('rob', at);
  }

  giveWeapon(id: WeaponId, ammo: number): void {
    const had = this.inv.has(id);
    this.inv.add(id, ammo);
    if (!had) this.inv.select(id);
  }

  /** Подобрать предмет. */
  collect(pk: Pickup): boolean {
    if (!this.onFoot || this.state === 'down') return false;
    const p = pk.pos;
    if (pk.kind === 'money') { this.money += pk.amount; this.d.hud.toast(`<span style="color:#8fd88f">+₽ ${pk.amount}</span>`, 1.4); }
    else if (pk.kind === 'weapon') { this.giveWeapon(pk.weapon ?? 'pistol', pk.amount); this.d.hud.toast(Pickups.label(pk), 1.6); }
    else if (pk.kind === 'armor') { if (this.armor >= 100) return false; this.armor = 100; this.d.hud.toast('Бронежилет', 1.4); }
    else { if (this.hp >= 100) return false; this.hp = 100; this.d.hud.toast('Аптечка', 1.4); }
    gameEvents.emit('pickup', { kind: pk.kind, amount: pk.amount, x: p.x, y: p.y, z: p.z });
    return true;
  }

  /** Преступление: свидетели — полиция (сразу) и прохожие в 30 м (звонок). Паника вокруг. */
  crime(c: Crime, at: THREE.Vector3): void {
    const ppl = this.d.people();
    let wit = 0;
    ppl?.forEachAgent(at.x, at.z, 30, (_i, _x, _y, _z, _yaw, down) => { if (!down) wit++; });
    const cop = this.d.police.witness(at);
    this.d.wanted.report(c, at, cop, wit);
    if (c !== 'steal') ppl?.panic(at.x, at.z, c === 'shoot' || c === 'shootPed' ? 45 : 16);
  }

  // ------------------------------------------------------------------ кадр (после физики)
  postUpdate(dt: number, alpha: number, time: number): void {
    const rig = this.rig;
    const orbit = this.d.orbit;
    if (this.state === 'driving') {
      this.pos.copy(this.car.vehicle.position);
      // сидит внутри: позиция для звука/миникарты
      if (rig) { rig.visible = false; rig.mesh.visible = false; }
      this.updateWeaponMesh(false);
      return;
    }
    if (this.state === 'exiting') {
      this.exitT += dt;
      const T = 0.65, t = Math.min(1, this.exitT / T);
      const v = this.car.vehicle;
      this.seatPos(this.car, this.exitFrom);
      this.pos.lerpVectors(this.exitFrom, this.exitTo, t * t * (3 - 2 * t));
      if (rig) {
        rig.visible = true;
        rig.sit = 1 - t;
        rig.speed = t > 0.5 ? 1.2 : 0;
        rig.pos.copy(this.pos); rig.yaw = this.yaw;
        rig.update(dt);
      }
      if (t >= 1) {
        this.body.teleport(this.exitTo);
        this.body.ignore = v.body.collider(0);
        this.body.setActive(true);
        this.state = 'foot';
        orbit.snap(Math.atan2(-(this.exitTo.x - v.position.x), -(this.exitTo.z - v.position.z)) + Math.PI * 0.5);
        orbit.exclude = v.body;
        this.d.onBodyChange(this.body.body, 0.6, 0.6, 80, false);
        gameEvents.emit('carDoor', { x: this.pos.x, y: this.pos.y, z: this.pos.z, open: false });
      }
      this.updateCamera(dt, time);
      return;
    }
    if (this.state === 'entering' && this.enter?.phase === 'climb') {
      const e = this.enter;
      e.t += dt;
      const T = 0.8, t = Math.min(1, e.t / T);
      const fc = e.fc!;
      this.seatPos(fc, this.seat);
      this.pos.lerpVectors(e.from, this.seat, t * t * (3 - 2 * t));
      this.yaw = Math.atan2(-(fc.vehicle.position.x - e.from.x), -(fc.vehicle.position.z - e.from.z)) + Math.PI * 0.5;
      if (rig) { rig.sit = t; rig.speed = 0; rig.pos.copy(this.pos); rig.yaw = this.yaw; rig.update(dt); }
      if (t >= 1) {
        this.enter = null;
        this.takeControl(fc);
        gameEvents.emit('carDoor', { x: this.pos.x, y: this.pos.y, z: this.pos.z, open: false });
        this.d.hud.toast(kindName(fc.kind), 1.2);
      }
      this.updateCamera(dt, time);
      return;
    }
    if (this.climb && this.state === 'foot') { this.updateClimb(dt, time); return; }
    // пешком / лежит / мёртв
    if (rig?.ragdolled) this.pos.copy(rig.pos);
    else if (this.state === 'foot' || this.state === 'entering' || this.state === 'busted') this.body.renderPos(alpha, this.pos);
    else if (rig) this.pos.copy(rig.pos);
    if (this.body.ignore && this.car.vehicle.position.distanceTo(this.pos) > 4) { this.body.ignore = null; orbit.exclude = null; }
    if (rig) {
      // страж видимости: пешком меш всегда в сцене и видим (что бы ни делали посадка/рэгдолл/переодевание)
      rig.visible = true;
      if (!rig.mesh.parent) this.d.scene.add(rig.mesh);
      rig.sit = 0;
      const walking = this.state === 'foot' || this.state === 'entering';
      if (!rig.ragdolled && this.state !== 'down' && this.state !== 'dead') {
        rig.pos.copy(this.pos);
        rig.yaw = this.yaw;
        // ступени/бордюры: autostep поднимает капсулу рывком на 0.1–0.45 м — модель догоняет за ~0.1 с (без «щелчка»)
        if (walking && this.body.grounded && Math.abs(this.pos.y - this.visY) < 0.6) this.visY += (this.pos.y - this.visY) * Math.min(1, dt * 16);
        else this.visY = this.pos.y;
        rig.pos.y = this.visY;
      } else this.visY = this.pos.y;
      // темп ног — по фактическому перемещению капсулы (упёрся в стену/машину — ноги не бегут на месте)
      rig.speed = walking ? this.body.groundSpeed : 0;
      rig.airborne = !this.body.grounded && this.body.airTime > 0.12;
      const w = this.inv.def;
      const aimOn = (this.d.orbit.aim > 0.5 || this.aimT > 0) && !w.melee && this.state === 'foot';
      rig.aim = aimOn ? (w.hold === 'rifle' ? 'rifle' : 'pistol') : 'none';
      rig.aimPitch = orbit.pitch;
      rig.update(dt);
      this.updateWeaponMesh(true);
    }
    // шаги
    const sp = Math.hypot(this.body.vel.x, this.body.vel.z);
    if (this.state === 'foot' && this.body.grounded && sp > 0.8) {
      this.stepPhase += (sp * dt) / (sp > 5 ? 1.6 : sp > 3 ? 1.0 : 0.75);
      if (this.stepPhase >= 1) {
        this.stepPhase -= 1;
        gameEvents.emit('footstep', { x: this.pos.x, y: this.pos.y, z: this.pos.z, speed: sp, surface: this.d.surfaceAt(this.pos.x, this.pos.z), byPlayer: true });
      }
    }
    // вода — плавать нельзя: «утонул» → больница
    if (this.state === 'foot' && this.d.surfaceAt(this.pos.x, this.pos.z) === WATER && this.pos.y < this.d.heightAt(this.pos.x, this.pos.z) + 0.6) {
      this.waterT += dt;
      if (this.waterT > 1.2) { this.waterT = 0; this.hp = 0; this.die(); }
    } else this.waterT = 0;
    // провалился под мир
    if (this.state === 'foot' && this.pos.y < this.d.heightAt(this.pos.x, this.pos.z) - 25) {
      const p = new THREE.Vector3(this.pos.x, this.d.heightAt(this.pos.x, this.pos.z) + 1, this.pos.z);
      this.body.teleport(p);
    }
    // водитель, полезший в драку
    this.updateFightBack(dt);
    // респаун
    if ((this.state === 'dead' && this.stateT > 4.5) || (this.state === 'busted' && this.stateT > 3.5)) void this.respawn(this.state === 'dead' ? 'hospital' : 'police');
    // регенерация до 30 % (аркада)
    if (this.alive && this.hp < 30 && this.lastHurt > 6) this.hp = Math.min(30, this.hp + dt * 2);
    this.updateCamera(dt, time);
  }

  private updateFightBack(dt: number): void {
    const fb = this.fightBack;
    if (!fb) return;
    const ppl = this.d.people();
    fb.t -= dt;
    if (!ppl || fb.t <= 0 || !ppl.isActive(fb.i) || ppl.isDown(fb.i) || !this.onFoot) { if (fb.t <= 0 || !ppl?.isActive(fb.i)) this.fightBack = null; return; }
    const ap = ppl.agentPos(fb.i, _v3);
    const d = Math.hypot(ap.x - this.pos.x, ap.z - this.pos.z);
    if (d > 25) { this.fightBack = null; return; }
    ppl.stepToward(fb.i, this.pos.x, this.pos.z, dt, 3.4);
    fb.hitCd -= dt;
    if (d < 1.3 && fb.hitCd <= 0) {
      fb.hitCd = 1.4;
      gameEvents.emit('punch', { x: ap.x, y: ap.y + 1.3, z: ap.z, hit: true, kick: false, byPlayer: false });
      this.takeHit(7, _v2.set(this.pos.x - ap.x, 0, this.pos.z - ap.z).normalize(), 2, false, true);
    }
  }

  private updateWeaponMesh(show: boolean): void {
    const rig = this.rig;
    const id = this.inv.current;
    const want = show && rig && rig.visible && !rig.ragdolled && this.state !== 'dead' && id !== 'fists' ? id : null;
    if (want !== this.weaponMeshId) {
      if (this.weaponMesh) this.weaponMesh.root.removeFromParent();
      this.weaponMesh = want ? buildWeaponMesh(want) : null;
      this.weaponMeshId = want;
      if (this.weaponMesh) { this.weaponMesh.root.matrixAutoUpdate = false; this.d.scene.add(this.weaponMesh.root); }
    }
    if (!this.weaponMesh || !rig) return;
    // кисть + ориентация: в прицеле — по направлению камеры, иначе — вниз-вперёд вдоль руки
    const hand = rig.joint('RightHand', _v3);
    const aiming = rig.aim !== 'none';
    if (aiming) {
      const f = this.d.orbit.forward(_fwd);
      _q.setFromUnitVectors(_v.set(0, 0, -1), f);
      const off = _v2.set(0.02, -0.03, -0.06).applyQuaternion(_q);
      hand.add(off);
    } else {
      _q.setFromAxisAngle(_v.set(0, 1, 0), rig.yaw).multiply(new THREE.Quaternion().setFromAxisAngle(_v2.set(1, 0, 0), -1.2));
    }
    _m.compose(hand, _q, _v.set(1, 1, 1));
    this.weaponMesh.root.matrix.copy(_m);
    this.weaponMesh.root.matrixWorldNeedsUpdate = true;
  }

  private updateCamera(dt: number, time: number): void {
    if (this.state === 'driving') return;
    const aiming = this.state === 'foot' && this.inv.current !== 'fists' && this.aimHeld;
    this.d.orbit.update(dt, this.pos, aiming, this.d.effects.shake, time);
  }
  /** Прицел зажат (ставит GtaMode из controls). */
  aimHeld = false;

  // ------------------------------------------------------------------ респаун
  private respawning = false;
  async respawn(at: 'hospital' | 'police'): Promise<void> {
    if (this.respawning) return;
    this.respawning = true;
    const places = this.d.places().filter((p) => p.type === at);
    const from = this.focus.clone();
    let best: Place | null = null, bd = Infinity;
    for (const p of places) { const d = Math.hypot(p.x - from.x, p.z - from.z); if (d < bd) { bd = d; best = p; } }
    const target = best ? new THREE.Vector3(best.x, 0, best.z) : from.clone();
    target.y = this.d.heightAt(target.x, target.z);
    await this.d.preload(target);
    const spot = this.d.snapToWalkable(target);
    spot.y = Math.max(this.d.heightAt(spot.x, spot.z), this.d.physics.groundHeightAt(spot.x, spot.z) > spot.y + 2 ? spot.y : this.d.physics.groundHeightAt(spot.x, spot.z)) + 0.05;
    // потери
    const lost = at === 'hospital' ? Math.min(this.money, 100 + Math.floor(this.money * 0.1)) : Math.min(this.money, 50 + Math.floor(this.money * 0.2));
    this.money -= lost;
    this.inv.clear();
    this.armor = 0;
    this.hp = 100;
    this.d.wanted.clear();
    this.d.police.clear();
    this.d.ragdolls.cancel(this.ragId);
    if (this.rig) { this.rig.detachRagdoll(); this.rig.tumble = 0; this.rig.lying = 0; this.rig.sit = 0; }
    this.body.teleport(spot);
    this.body.setActive(true);
    this.pos.copy(spot);
    this.state = 'foot';
    this.stateT = 0;
    this.d.onBodyChange(this.body.body, 0.6, 0.6, 80, false);
    this.d.orbit.snap();
    this.d.hud.setBig(null);
    this.d.hud.toast(`${at === 'hospital' ? 'Больница' : 'Отдел полиции'}${best?.name ? ': ' + best.name : ''} · −₽ ${lost}`, 4);
    gameEvents.emit('respawn', { x: spot.x, y: spot.y, z: spot.z, at });
    this.respawning = false;
  }

  /** Отладка: телепорт пешком. */
  teleport(p: THREE.Vector3): void {
    if (this.state === 'driving') return;
    this.body.teleport(p);
    this.pos.copy(p);
  }

  hudBattery(): number | null { return this.state === 'driving' && this.car.trolley ? this.car.trolley.battery : null; }
}
