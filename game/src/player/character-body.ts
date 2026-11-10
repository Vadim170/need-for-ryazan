import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../physics/world';

/**
 * Капсула персонажа (игрок, полицейские) на кинематическом контроллере Rapier (KinematicCharacterController).
 *
 * Коллайдер: membership бит 6 (0x0020), filter 0 — контактов с телами нет вовсе (машины не упираются в человека как в стену,
 * удары машин по людям считаются вручную). Движение — запросом контроллера по миру с группами CHAR_QUERY_GROUPS:
 * земля/здания/пропсы/машины/поезда — препятствия, рэгдоллы и другие персонажи — нет. Ступени (OSM steps, крыльца,
 * бордюры) — autostep до 0.45 м, склоны до 50°, прилипание к земле 0.35 м.
 * Толкает только лёгкие динамические тела (обломки, урны, лавки ≤ PUSH_MAX_MASS) — своим импульсом, не импульсами KCC:
 * встроенный setApplyImpulsesToDynamicBodies толкал и машины (стоящая машина отъезжала от бегущего в неё человека на
 * 0.2 м со скоростью ~1 м/с, и её «наезд» затем валил игрока). Машины для человека — неподвижная стена.
 */
export const CHAR_GROUPS = (0x0020 << 16) | 0x0000;
export const CHAR_QUERY_GROUPS = (0x0020 << 16) | (0xffff & ~0x0010 & ~0x0020);

const RADIUS = 0.3, HALF = 0.55;
/** Центр капсулы над ногами. */
export const CAPSULE_CENTER = RADIUS + HALF;
export const GRAVITY = 20;

let shared: RAPIER.KinematicCharacterController | null = null;
/** Тяжелее — не толкается человеком (машины, сдвинутые машины парковки, бетонные блоки). */
const PUSH_MAX_MASS = 300;

export class CharacterBody {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  /** Ноги: текущий и предыдущий шаг физики (для интерполяции). */
  readonly feet = new THREE.Vector3();
  readonly prevFeet = new THREE.Vector3();
  /** Скорость (м/с), y — вертикальная. */
  readonly vel = new THREE.Vector3();
  grounded = false;
  /** Фактическая горизонтальная скорость капсулы (м/с, сглажено): темп шагов модели. */
  groundSpeed = 0;
  /** Желаемая горизонтальная скорость (ставит владелец каждый кадр). */
  readonly wish = new THREE.Vector2();
  /** Ускорение к желаемой скорости, м/с² (на земле / в воздухе). */
  accel = 40; airAccel = 8;
  jumpRequest = false;
  jumpSpeed = 6.2;
  /** Выключен — не двигается (сидит в машине, рэгдолл). */
  enabled = true;
  /** Сколько с в воздухе (для анимации/урона от падения). */
  airTime = 0;
  /** Самая большая скорость падения за полёт (для урона). */
  fallSpeed = 0;
  onLand: ((fallSpeed: number) => void) | null = null;
  /** Исключить коллайдер (машина, из которой выходим). */
  ignore: RAPIER.Collider | null = null;
  private kcc: RAPIER.KinematicCharacterController;
  private cb = (dt: number) => this.step(dt);
  private desired = { x: 0, y: 0, z: 0 };
  private hit: RAPIER.CharacterCollision | undefined;

  constructor(private physics: PhysicsWorld, at: THREE.Vector3) {
    const w = physics.world;
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y + CAPSULE_CENTER, at.z));
    this.collider = w.createCollider(RAPIER.ColliderDesc.capsule(HALF, RADIUS).setCollisionGroups(CHAR_GROUPS).setFriction(0), this.body);
    if (!shared) {
      shared = w.createCharacterController(0.02);
      shared.setUp({ x: 0, y: 1, z: 0 });
      shared.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
      shared.setMinSlopeSlideAngle((55 * Math.PI) / 180);
      shared.enableAutostep(0.45, 0.15, false);
      shared.enableSnapToGround(0.35);
      shared.setSlideEnabled(true);
      shared.setApplyImpulsesToDynamicBodies(false);
      shared.setCharacterMass(80);
    }
    this.kcc = shared;
    this.feet.copy(at); this.prevFeet.copy(at);
    physics.onPreStep(this.cb);
  }

  teleport(p: THREE.Vector3): void {
    this.feet.copy(p); this.prevFeet.copy(p);
    this.vel.set(0, 0, 0);
    this.groundSpeed = 0;
    this.body.setTranslation({ x: p.x, y: p.y + CAPSULE_CENTER, z: p.z }, true);
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y + CAPSULE_CENTER, z: p.z });
    // коллайдер догоняет тело только в world.step: без этого первый запрос KCC считался от старой позы (сиденье машины,
    // точка в 30 м над ней, место падения рэгдолла) — прилипание к земле там давало mv.y до −0.35 м, и эту поправку
    // прибавляли к новой позе: после выхода из машины капсула уходила на ~0.15 м в землю и застревала (дёргалась/не шла)
    this.physics.world.propagateModifiedBodyPositionsToColliders();
  }

  /** Убрать с дороги (сидит в машине): коллайдер выключен. */
  setActive(on: boolean): void {
    this.enabled = on;
    this.collider.setEnabled(on);
  }

  /** Интерполированная позиция ног. */
  renderPos(alpha: number, out: THREE.Vector3): THREE.Vector3 {
    return out.lerpVectors(this.prevFeet, this.feet, alpha);
  }

  private step(dt: number): void {
    this.prevFeet.copy(this.feet);
    if (!this.enabled) return;
    const v = this.vel;
    const a = (this.grounded ? this.accel : this.airAccel) * dt;
    const dx = this.wish.x - v.x, dz = this.wish.y - v.z, dl = Math.hypot(dx, dz);
    if (dl > a) { v.x += (dx / dl) * a; v.z += (dz / dl) * a; } else { v.x = this.wish.x; v.z = this.wish.y; }
    if (this.grounded && this.jumpRequest) { v.y = this.jumpSpeed; this.grounded = false; }
    this.jumpRequest = false;
    v.y -= GRAVITY * dt;
    if (v.y < -55) v.y = -55;
    const d = this.desired;
    d.x = v.x * dt; d.y = v.y * dt; d.z = v.z * dt;
    const ign = this.ignore;
    this.kcc.computeColliderMovement(this.collider, d, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, CHAR_QUERY_GROUPS,
      ign ? (c) => c.handle !== ign.handle : undefined);
    const mv = this.kcc.computedMovement();
    this.pushLight(d.x / dt, d.z / dt);
    const wasGrounded = this.grounded;
    this.grounded = this.kcc.computedGrounded();
    // упёрся в стену/потолок — гасим скорость по фактическому перемещению
    if (dt > 0) {
      if (Math.abs(mv.x) < Math.abs(d.x) * 0.5) v.x = mv.x / dt;
      if (Math.abs(mv.z) < Math.abs(d.z) * 0.5) v.z = mv.z / dt;
      if (v.y > 0 && mv.y < d.y * 0.5) v.y = 0;
    }
    if (this.grounded) {
      if (!wasGrounded && this.airTime > 0.05) this.onLand?.(this.fallSpeed);
      if (v.y < 0) v.y = -1;
      this.airTime = 0; this.fallSpeed = 0;
    } else {
      this.airTime += dt;
      this.fallSpeed = Math.max(this.fallSpeed, -v.y);
    }
    if (dt > 0) this.groundSpeed += (Math.hypot(mv.x, mv.z) / dt - this.groundSpeed) * Math.min(1, dt * 20);
    const t = this.body.translation();
    const nx = t.x + mv.x, ny = t.y + mv.y, nz = t.z + mv.z;
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    this.feet.set(nx, ny - CAPSULE_CENTER, nz);
  }

  /** Лёгкие обломки на пути: импульс до ~80 % скорости сближения человека (масса «удара» — не больше 80 кг). */
  private pushLight(vx: number, vz: number): void {
    const n = this.kcc.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const c = this.kcc.computedCollision(i, this.hit);
      if (!c) continue;
      this.hit = c;
      const b = c.collider?.parent();
      if (!b || !b.isDynamic()) continue;
      const m = b.mass();
      if (m <= 0 || m > PUSH_MAX_MASS) continue;
      let nx = -c.normal1.x, nz = -c.normal1.z;
      const nl = Math.hypot(nx, nz);
      if (nl < 0.3) continue;
      nx /= nl; nz /= nl;
      const closing = vx * nx + vz * nz;
      if (closing <= 0.1) continue;
      const bv = b.linvel();
      const dv = closing * 0.8 - (bv.x * nx + bv.z * nz);
      if (dv <= 0) continue;
      const J = Math.min(m, 80) * dv;
      b.applyImpulseAtPoint({ x: nx * J, y: 0, z: nz * J }, c.witness1, true);
    }
  }

  dispose(): void {
    this.physics.offPreStep(this.cb);
    this.physics.world.removeRigidBody(this.body);
  }
}
