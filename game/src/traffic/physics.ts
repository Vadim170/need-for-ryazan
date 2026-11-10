import { RAPIER, type PhysicsWorld } from '../physics/world';
import type { VehicleModel, VehicleKind } from './models';
import type { SimVehicle, TrafficSim } from './sim';

/** Группа коллизий трафика: membership бит 3, filter — всё (groundHeightAt их не видит). */
export const TRAFFIC_GROUPS = (0x0004 << 16) | 0xffff;

const NEAR = 70;          // м: ближе к игроку — машина получает кинематическое тело
const POOL = 48;
const CRASH_LIFE = 35;    // с: разбитая/заглохшая машина живёт, потом исчезает (если игрок дальше 35 м)
const RESTITUTION = 0.25; // упругость удара кузовов
const SHOVE_DV = 0.6;     // м/с: машина трафика получает от удара больше — становится физической
const PUSH_TIME = 0.35;   // с непрерывного контакта (медленное «подталкивание») — тоже становится физической
const RECOVER_DIST = 1.2, RECOVER_YAW = 0.26; // сдвинули чуть-чуть — вернётся в поток

/** Массы по видам, кг — те же, что у машин игрока в GTA-режиме (src/vehicle/classes.ts). */
export const TRAFFIC_MASS: Record<VehicleKind, number> = {
  sedan: 1250, hatch: 1150, wagon: 1300, suv: 1800, taxi: 1250, police: 1350, gazelle: 2700, paz: 6500, liaz: 10500, trolleybus: 11000,
};

interface Slot { body: RAPIER.RigidBody; v: SimVehicle | null; kind: VehicleKind; push: number; pushStep: number }
interface Loose {
  v: SimVehicle; body: RAPIER.RigidBody; kind: VehicleKind;
  /** Поза в момент перехода в физику (для «вернуться в поток»). */
  x0: number; z0: number; yaw0: number;
  /** false — авария/заглохла (аварийка, объезжают); true — пока решается, вернётся ли в поток. */
  maybeRecover: boolean;
  /** Шаг последнего контакта с другим динамическим телом (пока толкают — в поток не возвращается). */
  lastTouch: number;
}

/**
 * Физика трафика (реальные контакты).
 * - У ближних к игроку машин (≤ 70 м, пул 48) — кинематические тела Rapier: едут по симуляции, коллайдер с событиями сил контакта.
 * - Удар любого динамического тела (машина игрока любого класса, угнанные, обломки, сдвинутые машины парковки, другие
 *   разбитые машины трафика) разбирается после шага физики: из импульса контакта восстанавливается скорость сближения до
 *   удара, считается обмен импульсом с реальными массами (упругость 0.25). Ударившему возвращается его скорость за вычетом
 *   обмена (кинематическое тело для Rapier бесконечно тяжёлое — без этого была бы «стена»). Если машине трафика достаётся
 *   больше 0.6 м/с (тяжёлый автобус на 15 км/ч толкает легковую, легковая в автобус — почти нет) или её непрерывно толкают
 *   дольше 0.35 с, она становится динамическим телом с этой скоростью: стоявшая на светофоре — «на ручнике»
 *   (колёса частично заблокированы, скользит юзом, трение 0.4), ехавшая — катится (трение 0.2).
 * - Через 1.5–3 с: сдвинули меньше чем на 1.2 м и 15° и машина стоит — возвращается в поток (кинематика, плавно съезжает в
 *   полосу по S-кривой); иначе — авария/заглохла: аварийка, симуляция объезжает, исчезает через 35 с вне видимости.
 */
export class TrafficPhysics {
  private slots: Slot[] = [];
  private byCollider = new Map<number, Slot>();
  private loose: Loose[] = [];
  private looseByCollider = new Map<number, Loose>();
  private tick = 0;
  private step = 0;
  /** Отладка: последний разобранный удар. */
  lastHit: Record<string, number> | null = null;
  readonly stats = { kinematic: 0, crashed: 0, crashes: 0, shoves: 0, pushes: 0, recovered: 0, contacts: 0 };

  constructor(private physics: PhysicsWorld, private sim: TrafficSim, private models: Record<VehicleKind, VehicleModel>,
    private player: RAPIER.RigidBody, public playerSize: { length: number; width: number }) {
    physics.onPostStep((dt, ev) => this.onContacts(dt, ev));
  }

  private makeBody(kind: VehicleKind): RAPIER.RigidBody {
    const m = this.models[kind], w = this.physics.world;
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -500, 0).setCanSleep(false));
    const clear = 0.05; // низ коллайдера почти у земли: машина в физике ложится «на колёса», а не проваливается
    const hh = (m.height - clear) / 2;
    const c = w.createCollider(RAPIER.ColliderDesc.cuboid(m.width / 2, hh, m.length / 2).setTranslation(0, clear + hh, 0)
      .setMass(TRAFFIC_MASS[kind]).setFriction(0.5).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setRestitution(0.05).setCollisionGroups(TRAFFIC_GROUPS)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(50), body);
    void c;
    return body;
  }

  /** Перед шагом физики (после шага симуляции): раздать тела ближним машинам, выставить позы. */
  preStep(dt: number): void {
    this.step++;
    const pt = this.player.translation();
    if (this.tick++ % 10 === 0) this.assign(pt.x, pt.z);
    let kin = 0;
    for (const sl of this.slots) {
      const v = sl.v;
      if (!v) continue;
      if (!v.alive || v.crashed) { this.release(sl); continue; }
      kin++;
      sl.body.setNextKinematicTranslation({ x: v.x, y: v.y, z: v.z });
      sl.body.setNextKinematicRotation(quatFromForward(v.fx, v.fy, v.fz));
      if (this.step - sl.pushStep > 3) sl.push = 0;
    }
    this.stats.kinematic = kin;
    // машины в физике: поза из тела, возврат в поток / удаление
    for (let i = this.loose.length - 1; i >= 0; i--) {
      const L = this.loose[i], v = L.v, b = L.body;
      v.crashT += dt;
      const t = b.translation(), r = b.rotation();
      v.ox = v.x; v.oy = v.y; v.oz = v.z;
      v.x = t.x; v.y = t.y; v.z = t.z;
      v.qx = r.x; v.qy = r.y; v.qz = r.z; v.qw = r.w;
      v.fx = -(2 * (r.x * r.z + r.w * r.y)); v.fy = 2 * (r.w * r.x - r.y * r.z); v.fz = -(1 - 2 * (r.x * r.x + r.y * r.y));
      const lv = b.linvel();
      v.v = Math.hypot(lv.x, lv.z);
      if (L.maybeRecover && v.crashT > 1.5) {
        const moved = Math.hypot(t.x - L.x0, t.z - L.z0);
        let dy = Math.atan2(v.fx, v.fz) - L.yaw0;
        dy = Math.abs(Math.atan2(Math.sin(dy), Math.cos(dy)));
        const upright = 1 - 2 * (r.x * r.x + r.z * r.z) > 0.95;
        if (moved < RECOVER_DIST && dy < RECOVER_YAW && upright && v.v < 0.3 && !v.dead) {
          if (this.step - L.lastTouch < 40) continue; // ещё толкают
          if (this.recover(L)) { this.loose.splice(i, 1); continue; }
        } else if (v.crashT > 3 || moved >= RECOVER_DIST || dy >= RECOVER_YAW || !upright) {
          L.maybeRecover = false; // авария / заглохла: аварийка
          v.ind = 2; v.brake = true;
          this.stats.crashes++;
        }
      }
      const far = Math.hypot(t.x - pt.x, t.z - pt.z);
      if ((v.crashT > CRASH_LIFE && far > 35) || v.crashT > CRASH_LIFE * 3 || far > 400 || t.y < -200) {
        this.looseByCollider.delete(b.collider(0).handle);
        this.physics.world.removeRigidBody(b);
        this.loose.splice(i, 1);
        this.sim.remove(v);
      }
    }
    this.stats.crashed = this.loose.length;
  }

  /**
   * После шага: реальные контакты динамических тел с машинами трафика. F·dt — импульс, который Rapier приложил к ударившему
   * (о кинематику — как о стену); closing = vn_после + F·dt/m — скорость сближения до удара.
   */
  private onContacts(dt: number, ev: RAPIER.EventQueue): void {
    const w = this.physics.world;
    const hits = new Map<Slot, { body: RAPIER.RigidBody; F: number; nx: number; nz: number }>();
    ev.drainContactForceEvents((e) => {
      const h1 = e.collider1(), h2 = e.collider2();
      const s1 = this.byCollider.get(h1), s2 = this.byCollider.get(h2);
      const l1 = this.looseByCollider.get(h1), l2 = this.looseByCollider.get(h2);
      if (l1 || l2) {
        const ob = w.getCollider(l1 ? h2 : h1)?.parent();
        if (ob && !ob.isFixed()) { if (l1) l1.lastTouch = this.step; if (l2) l2.lastTouch = this.step; }
      }
      const sl = s1 ?? s2;
      if (!sl || !sl.v || (s1 && s2)) return;
      const other = w.getCollider(s1 ? h2 : h1);
      const body = other?.parent();
      if (!body || !body.isDynamic()) return;
      if (body === this.player && !this.playerCrash) return;
      const F = e.totalForceMagnitude();
      const d = e.maxForceDirection();
      const prev = hits.get(sl);
      if (!prev || prev.F < F) hits.set(sl, { body, F, nx: d.x, nz: d.z });
    });
    for (const [sl, h] of hits) {
      const v = sl.v;
      if (!v || v.crashed) continue;
      this.stats.contacts++;
      // нормаль: от ударившего к машине трафика (в плане)
      const hb = h.body, hp = hb.translation();
      let nx = h.nx, nz = h.nz;
      const nl = Math.hypot(nx, nz);
      if (nl < 0.3) continue; // контакт сверху (наехал/упал на крышу)
      nx /= nl; nz /= nl;
      if ((v.x - hp.x) * nx + (v.z - hp.z) * nz < 0) { nx = -nx; nz = -nz; }
      const m = hb.mass() || 1000, M = TRAFFIC_MASS[sl.kind];
      const hv = hb.linvel();
      const vnAfter = hv.x * nx + hv.z * nz;
      const closingAbs = vnAfter + (h.F * dt) / m;          // скорость ударившего вдоль n до удара
      const vt = (v.fx * nx + v.fz * nz) * v.v;              // своя скорость трафика вдоль n
      const u = closingAbs - vt;                              // скорость сближения
      if (u <= 0.05) continue;
      const dvT = ((1 + RESTITUTION) * m / (m + M)) * u;     // машине трафика
      const vhTarget = closingAbs - ((1 + RESTITUTION) * M / (m + M)) * u; // ударившему вдоль n после обмена
      // медленное подталкивание: копим время непрерывного контакта
      if (this.step - sl.pushStep <= 2) sl.push += dt * (this.step - sl.pushStep); else sl.push = 0;
      sl.pushStep = this.step;
      this.lastHit = { m, M, vnAfter: +vnAfter.toFixed(2), closing: +closingAbs.toFixed(2), u: +u.toFixed(2), dvT: +dvT.toFixed(2), vh: +vhTarget.toFixed(2), step: this.step };
      const shove = dvT > SHOVE_DV;
      const pushed = !shove && sl.push > PUSH_TIME && m > 0.25 * M;
      // вернуть ударившему его скорость за вычетом обмена (не «стена»)
      if (shove || pushed || vhTarget > vnAfter + 0.05) {
        const dv = shove || pushed ? vhTarget - vnAfter : Math.max(0, vhTarget - vnAfter) * 0.5;
        hb.applyImpulse({ x: nx * dv * m, y: 0, z: nz * dv * m }, true);
      }
      if (shove || pushed) {
        if (pushed) this.stats.pushes++; else this.stats.shoves++;
        // косой удар закручивает: плечо — поперечное смещение точки удара от центра
        const lat = (hp.x - v.x) * -nz + (hp.z - v.z) * nx;
        this.toDynamic(sl, v, nx * dvT, nz * dvT, -lat * dvT * 0.08 * Math.min(1, m / M));
      }
    }
  }

  private assign(px: number, pz: number): void {
    const near = this.sim.vehicles.filter((v) => !v.crashed && Math.hypot(v.x - px, v.z - pz) < NEAR)
      .sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz)).slice(0, POOL);
    const want = new Set(near);
    for (const sl of this.slots) if (sl.v && !want.has(sl.v)) this.release(sl);
    for (const v of near) {
      if (v.body) continue;
      let sl = this.slots.find((s) => !s.v && s.kind === v.kind);
      if (!sl) {
        if (this.slots.length >= POOL * 2) {
          sl = this.slots.find((s) => !s.v);
          if (!sl) break;
          this.byCollider.delete(sl.body.collider(0).handle);
          this.physics.world.removeRigidBody(sl.body);
          sl.body = this.makeBody(v.kind); sl.kind = v.kind;
          this.byCollider.set(sl.body.collider(0).handle, sl);
        } else {
          sl = { body: this.makeBody(v.kind), v: null, kind: v.kind, push: 0, pushStep: -10 };
          this.slots.push(sl);
          this.byCollider.set(sl.body.collider(0).handle, sl);
        }
      }
      sl.v = v; v.body = sl;
      sl.body.setEnabled(true);
      sl.body.setTranslation({ x: v.x, y: v.y, z: v.z }, true);
      sl.body.setRotation(quatFromForward(v.fx, v.fy, v.fz), true);
    }
  }

  private release(sl: Slot): void {
    if (sl.v) sl.v.body = null;
    sl.v = null;
    sl.body.setTranslation({ x: 0, y: -500, z: 0 }, false);
    sl.body.setEnabled(false);
  }

  /** Кинематика → динамика: тело уходит из пула (в пул — новое при следующей раздаче). */
  private toDynamic(sl: Slot, v: SimVehicle, dvx: number, dvz: number, wy: number, crash = false): RAPIER.RigidBody {
    const body = sl.body;
    const stationary = v.v < 0.5;
    sl.v = null; v.body = null;
    this.slots.splice(this.slots.indexOf(sl), 1);
    this.byCollider.delete(body.collider(0).handle);
    const vx = v.fx * v.v, vz = v.fz * v.v;
    this.sim.detach(v);
    const q = quatFromForward(v.fx, v.fy, v.fz);
    v.qx = q.x; v.qy = q.y; v.qz = q.z; v.qw = q.w;
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    body.setTranslation({ x: v.x, y: v.y + 0.02, z: v.z }, true);
    body.setLinvel({ x: vx + dvx, y: 0, z: vz + dvz }, true);
    body.setAngvel({ x: 0, y: wy, z: 0 }, true);
    // стоял на светофоре — «на ручнике»: колёса частично заблокированы, скользит юзом; ехал — катится и тормозит
    body.collider(0).setFriction(stationary ? 0.4 : 0.2);
    body.setLinearDamping(stationary ? 0.4 : 0.15);
    body.setAngularDamping(1.2);
    body.enableCcd(true);
    v.brake = true;
    const L: Loose = { v, body, kind: sl.kind, x0: v.x, z0: v.z, yaw0: Math.atan2(v.fx, v.fz), maybeRecover: !crash, lastTouch: this.step };
    if (crash) { v.ind = 2; this.stats.crashes++; }
    this.loose.push(L);
    this.looseByCollider.set(body.collider(0).handle, L);
    return body;
  }

  /** Сдвинули чуть-чуть — обратно в поток: тело снова кинематическое, симуляция продолжает с текущего места. */
  private recover(L: Loose): boolean {
    const v = L.v, b = L.body;
    if (!this.sim.reattach(v)) return false;
    this.looseByCollider.delete(b.collider(0).handle);
    b.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.collider(0).setFriction(0.5);
    const sl: Slot = { body: b, v, kind: L.kind, push: 0, pushStep: -10 };
    this.slots.push(sl);
    this.byCollider.set(b.collider(0).handle, sl);
    v.body = sl;
    this.stats.recovered++;
    return true;
  }

  /** Разбитые/сдвинутые машины как препятствия для трафика. */
  crashedVehicles(): readonly { v: SimVehicle; body: RAPIER.RigidBody }[] { return this.loose; }

  /** Удар игрока сдвигает машины (false — игрок пешком). */
  playerCrash = true;
  /** Сменить тело игрока (GTA-режим: пересел в другую машину / пешком). */
  setPlayer(body: RAPIER.RigidBody, size: { length: number; width: number }, crash = true): void { this.player = body; this.playerSize = size; this.playerCrash = crash; }

  /**
   * GTA-режим, угон: машина уходит из трафика и становится Vehicle игрока на том же месте. Её кинематическое тело
   * удаляется из мира сразу (слот получает новое тело). Просто выключить/увести его нельзя: запросы сцены Rapier
   * (лучи подвески) видят старую позу коллайдера до следующего world.step — лучи нового Vehicle на первом шаге попадали
   * в крышу «призрака», подвеска сжималась до упора, и машину подбрасывало вверх.
   */
  takeOver(v: SimVehicle): void {
    // заглохшая/сдвинутая (динамическое тело вне пула) — тело тоже убрать: машину игрока создаёт Fleet на его месте
    const li = this.loose.findIndex((L) => L.v === v);
    if (li >= 0) {
      const b = this.loose[li].body;
      this.looseByCollider.delete(b.collider(0).handle);
      this.physics.world.removeRigidBody(b);
      this.loose.splice(li, 1);
      v.body = null;
      return;
    }
    const sl = this.slots.find((s) => s.v === v);
    if (!sl) return;
    v.body = null;
    sl.v = null;
    this.byCollider.delete(sl.body.collider(0).handle);
    this.physics.world.removeRigidBody(sl.body);
    sl.body = this.makeBody(sl.kind);
    sl.body.setEnabled(false);
    this.byCollider.set(sl.body.collider(0).handle, sl);
  }

  /** Сделать машину динамической (взрыв/обстрел, GTA-режим): тело или null, если у машины нет кинематического тела. */
  crashVehicle(v: SimVehicle): RAPIER.RigidBody | null {
    const sl = this.slots.find((s) => s.v === v);
    if (!sl) {
      const L = this.loose.find((c) => c.v === v);
      if (L) { L.maybeRecover = false; v.dead = true; }
      return L?.body ?? null;
    }
    v.dead = true;
    return this.toDynamic(sl, v, 0, 0, 0, true);
  }
}

/** Кватернион поворота модели (вперёд −Z) на направление (fx, fy, fz), без крена. */
export function quatFromForward(fx: number, fy: number, fz: number): { x: number; y: number; z: number; w: number } {
  const yaw = Math.atan2(-fx, -fz);
  const pitch = Math.atan2(fy, Math.hypot(fx, fz));
  // q = qYaw * qPitch (pitch вокруг локальной X)
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp };
}
