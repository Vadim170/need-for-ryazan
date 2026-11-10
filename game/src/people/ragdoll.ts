import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../physics/world';

/**
 * Рэгдоллы для сбитых пешеходов: 11 тел Rapier (таз, торс, голова, плечи, предплечья+кисти, бёдра, голени+стопы).
 *
 * Пропорции — по костям конкретного персонажа (glTF-вид отдаёт суставы его позы «стоит», см. RagdollSkin.shape),
 * без скина — эталонный человек 1.75 м. Тела создаются при ударе и удаляются, когда человек улёгся (пул — 8 слотов).
 * Все тела в покое ориентированы одинаково (поворот человека по yaw), капсулы развёрнуты вдоль сегментов внутри тел —
 * поэтому оси шарниров и «нулевые» относительные повороты совпадают у всех пар.
 *
 * Шарниры:
 *  - локти и колени — revolute (ось X человека) с пределами Rapier: локоть 0…140° (сгиб вперёд), колено −140…0° (назад);
 *  - позвоночник (таз–торс), шея (торс–голова), плечи, бёдра — сферические. У сферических шарниров в JS-API Rapier нет
 *    пределов, поэтому конус и скручивание ограничиваются своим проходом перед каждым шагом физики (onPreStep):
 *    относительный поворот раскладывается на swing (отклонение оси кости) и twist (вращение вокруг неё), выход за предел
 *    гасится поправкой угловых скоростей обоих тел (как импульс ограничения, с учётом масс) и добивается до границы
 *    (Баумгарте, β = 0.25). Пределы: позвоночник 25°/±20°, шея 40°/±50°, плечо 95°/±60°, бедро 70°/±35°.
 *  - лёгкое демпфирование относительного вращения в каждом шарнире + общее угловое/линейное демпфирование тел.
 * Массы: 73 кг × (рост/1.75)³ по долям (таз 16%, торс 30%, голова 7%, плечо 3.5%, предплечье 2.7%, бедро 11%, голень 6.2%);
 * инерция — от формы коллайдера.
 *
 * Коллизии: земля/здания/пропсы/машины — да; части одного рэгдолла между собой — да, кроме соединённых шарниром
 * (contactsEnabled = false); руки с ногами — без сил (solver groups: тесный контакт кисти с бедром в позе «стоит»).
 * Membership всех тел — бит 5 (как раньше: лучи подвески/выстрелы его исключают). Быстрые удары — CCD.
 * Отрисовка: простые меши (без скина) или чужой скин (glTF-персонаж). debug = true — меши тел поверх скина (каркас).
 */

/** membership: бит 5; filter: всё (части рэгдоллов сталкиваются, кроме пар с шарниром). */
const RAGDOLL_GROUPS = (0x0010 << 16) | 0xffff;
// solver groups: ядро (таз/торс/голова) 1, руки 2, ноги 4; остальной мир — все биты
const SOLVER_CORE = (0x0001 << 16) | 0xffff;
const SOLVER_ARMS = (0x0002 << 16) | (0xffff & ~0x0004);
const SOLVER_LEGS = (0x0004 << 16) | (0xffff & ~0x0002);

export interface RagdollLook { jacket: THREE.Color; pants: THREE.Color; head: THREE.Color; skin: THREE.Color }

/** Суставы человека в позе «стоит» в координатах модели (ноги в 0, вперёд −Z, масштаб агента 1). */
export interface RagdollJoints {
  hips: THREE.Vector3; spine: THREE.Vector3; neck: THREE.Vector3; head: THREE.Vector3; headTop: THREE.Vector3;
  shoulderL: THREE.Vector3; elbowL: THREE.Vector3; wristL: THREE.Vector3; handL: THREE.Vector3;
  shoulderR: THREE.Vector3; elbowR: THREE.Vector3; wristR: THREE.Vector3; handR: THREE.Vector3;
  hipL: THREE.Vector3; kneeL: THREE.Vector3; ankleL: THREE.Vector3; toeL: THREE.Vector3;
  hipR: THREE.Vector3; kneeR: THREE.Vector3; ankleR: THREE.Vector3; toeR: THREE.Vector3;
}

/**
 * Внешний «скин» рэгдолла (glTF-персонаж в gltf-people-view.ts): даёт пропорции и рисует человека по телам Rapier.
 * attach вернул true — простые меши скрываются. detach(slot, result): result != null — рэгдолл улёгся (скин может
 * поправить результат: позицию и направление, где человек встанет); null — отмена (агент удалён).
 */
export interface RagdollSkin {
  shape?(agent: number): RagdollJoints | null;
  attach(slot: number, agent: number, x: number, y: number, z: number, yaw: number,
    bodies: readonly RAPIER.RigidBody[], parts: readonly string[], s?: number): boolean;
  update(slot: number, bodies: readonly RAPIER.RigidBody[]): void;
  detach(slot: number, result: RagdollResult | null): void;
}

export const RAGDOLL_PARTS: readonly string[] = ['pelvis', 'torso', 'head', 'uarmL', 'uarmR', 'farmL', 'farmR', 'thighL', 'thighR', 'shinL', 'shinR'];
const MASS_FRAC = [0.16, 0.30, 0.07, 0.035, 0.035, 0.027, 0.027, 0.11, 0.11, 0.062, 0.062];
const SLOT: ('jacket' | 'pants' | 'skin')[] = ['pants', 'jacket', 'skin', 'jacket', 'jacket', 'jacket', 'jacket', 'pants', 'pants', 'pants', 'pants'];

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** Эталонный человек 1.75 м (без скина). */
export function defaultJoints(): RagdollJoints {
  return {
    hips: V(0, 0.97, 0), spine: V(0, 1.07, 0), neck: V(0, 1.47, 0), head: V(0, 1.52, 0), headTop: V(0, 1.75, 0),
    shoulderL: V(-0.2, 1.42, 0), elbowL: V(-0.22, 1.13, 0), wristL: V(-0.23, 0.87, 0), handL: V(-0.235, 0.78, 0),
    shoulderR: V(0.2, 1.42, 0), elbowR: V(0.22, 1.13, 0), wristR: V(0.23, 0.87, 0), handR: V(0.235, 0.78, 0),
    hipL: V(-0.1, 0.92, 0), kneeL: V(-0.1, 0.51, 0), ankleL: V(-0.1, 0.08, 0), toeL: V(-0.1, 0.02, -0.15),
    hipR: V(0.1, 0.92, 0), kneeR: V(0.1, 0.51, 0), ankleR: V(0.1, 0.08, 0), toeR: V(0.1, 0.02, -0.15),
  };
}

interface PartGeo { center: THREE.Vector3; shape: 'box' | 'capsule' | 'ball'; size: number[]; colRot: THREE.Quaternion; colOff: THREE.Vector3 }

/** Сферический шарнир с эмулированными пределами. */
interface Limit { p: number; c: number; axis: THREE.Vector3; cone: number; twist: number }

const UP = V(0, 1, 0);
/** Части по суставам (в мире): центры тел, формы, поворот/смещение коллайдера внутри тела (тело ориентировано по yaw). */
function partsFromJoints(J: RagdollJoints, sc: number, qYaw: THREE.Quaternion): PartGeo[] {
  const qi = qYaw.clone().invert();
  const seg = (a: THREE.Vector3, b: THREE.Vector3, r: number): PartGeo => {
    const center = a.clone().add(b).multiplyScalar(0.5);
    const d = b.clone().sub(a);
    const len = d.length();
    const local = d.clone().applyQuaternion(qi).normalize();
    return { center, shape: 'capsule', size: [Math.max(0.01, len / 2 - r * 0.6), r], colRot: new THREE.Quaternion().setFromUnitVectors(UP, local), colOff: V(0, 0, 0) };
  };
  const shoulderSpan = J.shoulderL.distanceTo(J.shoulderR) / 2;
  const armR = 0.048 * sc, farmR = 0.042 * sc, thighR = 0.075 * sc, shinR = 0.055 * sc;
  const torsoH = J.neck.distanceTo(J.spine);
  const torsoHalfX = Math.max(0.1 * sc, shoulderSpan - armR - 0.015 * sc);
  const hipSpan = J.hipL.distanceTo(J.hipR) / 2;
  const pelvis: PartGeo = { center: J.hips.clone(), shape: 'box', size: [Math.min(hipSpan + 0.045 * sc, torsoHalfX), 0.085 * sc, 0.1 * sc], colRot: new THREE.Quaternion(), colOff: V(0, 0, 0) };
  const torso: PartGeo = {
    center: J.spine.clone().add(J.neck).multiplyScalar(0.5), shape: 'box', size: [torsoHalfX, torsoH / 2 * 0.98, 0.11 * sc],
    colRot: new THREE.Quaternion(), colOff: V(0, 0, 0),
  };
  const headR = J.headTop.distanceTo(J.head) / 2 * 0.95;
  const head: PartGeo = { center: J.head.clone().add(J.headTop).multiplyScalar(0.5), shape: 'ball', size: [headR], colRot: new THREE.Quaternion(), colOff: V(0, 0, 0) };
  // стопа — продолжение голени: сегмент колено → середина стопы
  const footL = J.ankleL.clone().lerp(J.toeL, 0.4), footR = J.ankleR.clone().lerp(J.toeR, 0.4);
  return [pelvis, torso, head,
    seg(J.shoulderL, J.elbowL, armR), seg(J.shoulderR, J.elbowR, armR),
    seg(J.elbowL, J.handL, farmR), seg(J.elbowR, J.handR, farmR),
    seg(J.hipL, J.kneeL, thighR), seg(J.hipR, J.kneeR, thighR),
    seg(J.kneeL, footL, shinR), seg(J.kneeR, footR, shinR)];
}

class Ragdoll {
  bodies: RAPIER.RigidBody[] = [];
  readonly group = new THREE.Group();
  readonly mats: Record<'jacket' | 'pants' | 'skin' | 'hat', THREE.MeshStandardMaterial>;
  private meshes: THREE.Mesh[] = [];
  limits: Limit[] = [];
  mass: number[] = [];
  active = false;
  skinned = false;
  agent = -1;
  time = 0;
  calm = 0;

  constructor(private physics: PhysicsWorld, scene: THREE.Scene) {
    this.mats = {
      jacket: new THREE.MeshStandardMaterial({ roughness: 0.88 }), pants: new THREE.MeshStandardMaterial({ roughness: 0.88 }),
      skin: new THREE.MeshStandardMaterial({ roughness: 0.8 }), hat: new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    };
    this.group.visible = false;
    this.group.name = 'ragdoll';
    scene.add(this.group);
  }

  /** Создать тела в позе «стоит» по суставам J (модель), в точке (x, y, z), поворот yaw, масштаб s; задать скорость. */
  launch(agent: number, J0: RagdollJoints, x: number, y: number, z: number, yaw: number, s: number, look: RagdollLook,
    vx: number, vy: number, vz: number, spin: THREE.Vector3): void {
    this.destroy();
    this.agent = agent; this.active = true; this.time = 0; this.calm = 0;
    this.mats.jacket.color.copy(look.jacket); this.mats.pants.color.copy(look.pants);
    this.mats.skin.color.copy(look.skin); this.mats.hat.color.copy(look.head);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    const M = new THREE.Matrix4().compose(V(x, y, z), qYaw, V(s, s, s));
    const J = {} as RagdollJoints;
    for (const k of Object.keys(J0) as (keyof RagdollJoints)[]) J[k] = J0[k].clone().applyMatrix4(M);
    const height = (J0.headTop.y) * s;
    const sc = height / 1.75;
    const total = 73 * sc * sc * sc;
    const parts = partsFromJoints(J, sc, qYaw);
    const w = this.physics.world;
    this.mass = MASS_FRAC.map((f) => f * total);
    parts.forEach((p, i) => {
      const rb = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.center.x, p.center.y, p.center.z)
        .setRotation({ x: qYaw.x, y: qYaw.y, z: qYaw.z, w: qYaw.w }).setCcdEnabled(true)
        .setLinearDamping(0.12).setAngularDamping(1.2).setCanSleep(true));
      const cd = p.shape === 'box' ? RAPIER.ColliderDesc.cuboid(p.size[0], p.size[1], p.size[2])
        : p.shape === 'capsule' ? RAPIER.ColliderDesc.capsule(p.size[0], p.size[1]) : RAPIER.ColliderDesc.ball(p.size[0]);
      cd.setRotation({ x: p.colRot.x, y: p.colRot.y, z: p.colRot.z, w: p.colRot.w });
      const solver = i < 3 ? SOLVER_CORE : i < 7 ? SOLVER_ARMS : SOLVER_LEGS;
      w.createCollider(cd.setMass(this.mass[i]).setFriction(0.9).setRestitution(0.05).setCollisionGroups(RAGDOLL_GROUPS).setSolverGroups(solver), rb);
      // верх тела получает чуть больше скорости (удар бампером по ногам -> кувырок)
      const k = p.center.y - y > 1.0 * sc ? 1.0 : 0.85;
      rb.setLinvel({ x: vx * k, y: vy, z: vz * k }, true);
      rb.setAngvel({ x: spin.x, y: spin.y, z: spin.z }, true);
      this.bodies.push(rb);
      // меш (простая отрисовка / отладка)
      const geo = p.shape === 'box' ? new THREE.BoxGeometry(p.size[0] * 2, p.size[1] * 2, p.size[2] * 2)
        : p.shape === 'capsule' ? new THREE.CapsuleGeometry(p.size[1], p.size[0] * 2, 2, 6) : new THREE.SphereGeometry(p.size[0], 8, 6);
      geo.applyQuaternion(p.colRot);
      const m = new THREE.Mesh(geo, this.mats[SLOT[i]]);
      m.castShadow = true;
      m.matrixAutoUpdate = false;
      this.meshes.push(m);
      this.group.add(m);
      if (i === 2) {
        const hat = new THREE.Mesh(new THREE.SphereGeometry(p.size[0] * 1.08, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), this.mats.hat);
        hat.position.y = 0.02 * sc; hat.updateMatrix(); hat.matrixAutoUpdate = false;
        m.add(hat);
      }
    });
    // шарниры: [родитель, ребёнок, точка (мир), тип, ...]
    const B = (n: string) => RAGDOLL_PARTS.indexOf(n);
    const qi = qYaw.clone().invert();
    const anchor = (bi: number, pw: THREE.Vector3) => {
      const t = this.bodies[bi].translation();
      const l = pw.clone().sub(V(t.x, t.y, t.z)).applyQuaternion(qi);
      return { x: l.x, y: l.y, z: l.z };
    };
    const axisDown = (a: THREE.Vector3, b: THREE.Vector3) => b.clone().sub(a).applyQuaternion(qi).normalize();
    const ball = (pa: string, ch: string, at: THREE.Vector3, axis: THREE.Vector3, cone: number, twist: number) => {
      const a = B(pa), c = B(ch);
      const j = w.createImpulseJoint(RAPIER.JointData.spherical(anchor(a, at), anchor(c, at)), this.bodies[a], this.bodies[c], true);
      j.setContactsEnabled(false);
      this.limits.push({ p: a, c, axis, cone: THREE.MathUtils.degToRad(cone), twist: THREE.MathUtils.degToRad(twist) });
    };
    const hinge = (pa: string, ch: string, at: THREE.Vector3, min: number, max: number) => {
      const a = B(pa), c = B(ch);
      const j = w.createImpulseJoint(RAPIER.JointData.revolute(anchor(a, at), anchor(c, at), { x: 1, y: 0, z: 0 }), this.bodies[a], this.bodies[c], true) as RAPIER.RevoluteImpulseJoint;
      j.setContactsEnabled(false);
      // JointData.limits в этой версии игнорируется — только setLimits после создания (проверено)
      j.setLimits(THREE.MathUtils.degToRad(min), THREE.MathUtils.degToRad(max));
    };
    ball('pelvis', 'torso', J.spine, V(0, 1, 0), 25, 20);
    ball('torso', 'head', J.head, V(0, 1, 0), 40, 50);
    ball('torso', 'uarmL', J.shoulderL, axisDown(J.shoulderL, J.elbowL), 95, 60);
    ball('torso', 'uarmR', J.shoulderR, axisDown(J.shoulderR, J.elbowR), 95, 60);
    ball('pelvis', 'thighL', J.hipL, axisDown(J.hipL, J.kneeL), 70, 35);
    ball('pelvis', 'thighR', J.hipR, axisDown(J.hipR, J.kneeR), 70, 35);
    // локоть: + вокруг X — предплечье вперёд; колено: − вокруг X — голень назад
    hinge('uarmL', 'farmL', J.elbowL, 0, 140);
    hinge('uarmR', 'farmR', J.elbowR, 0, 140);
    hinge('thighL', 'shinL', J.kneeL, -140, 0);
    hinge('thighR', 'shinR', J.kneeR, -140, 0);
    this.group.visible = true;
    this.sync();
  }

  sync(): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const t = this.bodies[i].translation(), r = this.bodies[i].rotation();
      const m = this.meshes[i];
      m.position.set(t.x, t.y, t.z); m.quaternion.set(r.x, r.y, r.z, r.w);
      m.updateMatrix();
    }
  }

  setDebug(on: boolean): void {
    for (const m of Object.values(this.mats)) { m.wireframe = on; m.depthTest = !on; m.transparent = on; m.opacity = on ? 0.8 : 1; }
  }

  /** Средняя скорость тел. */
  speed(): number {
    let s = 0;
    for (const b of this.bodies) { const v = b.linvel(); s += Math.hypot(v.x, v.y, v.z); }
    return s / Math.max(1, this.bodies.length);
  }

  private destroy(): void {
    const w = this.physics.world;
    for (const b of this.bodies) w.removeRigidBody(b);
    this.bodies = [];
    this.limits = [];
    for (const m of this.meshes) {
      m.geometry.dispose();
      for (const c of m.children) (c as THREE.Mesh).geometry?.dispose();
    }
    this.group.clear();
    this.meshes = [];
  }

  release(): void {
    this.destroy();
    this.group.visible = false;
    this.active = false; this.agent = -1;
  }
}

export interface RagdollResult {
  /** Итоговое положение таза. */
  x: number; y: number; z: number;
  /** Направление «к голове» по горизонтали и лицом вверх ли. */
  headX: number; headZ: number; faceUp: boolean;
}

// временные объекты для пределов
const _qp = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _q = new THREE.Quaternion(), _tw = new THREE.Quaternion();
const _sw = new THREE.Quaternion(), _qt = new THREE.Quaternion(), _e = new THREE.Quaternion();
const _a = new THREE.Vector3(), _n = new THREE.Vector3(), _wp = new THREE.Vector3(), _wc = new THREE.Vector3();

/**
 * Пределы сферических шарниров (конус + скручивание): перед шагом физики. q = qp⁻¹·qc (в покое — единица),
 * twist — проекция на ось кости, swing = q·twist⁻¹; цель — те же swing/twist, обрезанные по пределам.
 * Ошибка e = цель·q⁻¹ (в осях родителя) -> мир; относительная скорость «наружу» гасится, плюс β·угол/dt к цели.
 */
function enforceLimits(r: Ragdoll, dt: number): void {
  const B = r.bodies;
  for (const L of r.limits) {
    const bp = B[L.p], bc = B[L.c];
    const rp = bp.rotation(), rc = bc.rotation();
    _qp.set(rp.x, rp.y, rp.z, rp.w); _qc.set(rc.x, rc.y, rc.z, rc.w);
    _q.copy(_qp).invert().multiply(_qc);
    if (_q.w < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
    // twist вокруг оси
    const d = _q.x * L.axis.x + _q.y * L.axis.y + _q.z * L.axis.z;
    _tw.set(L.axis.x * d, L.axis.y * d, L.axis.z * d, _q.w);
    const tl = Math.hypot(_tw.x, _tw.y, _tw.z, _tw.w);
    if (tl < 1e-6) _tw.identity(); else _tw.set(_tw.x / tl, _tw.y / tl, _tw.z / tl, _tw.w / tl);
    _sw.copy(_q).multiply(_qt.copy(_tw).invert());
    let twistA = 2 * Math.atan2(_tw.x * L.axis.x + _tw.y * L.axis.y + _tw.z * L.axis.z, _tw.w);
    if (twistA > Math.PI) twistA -= 2 * Math.PI;
    if (twistA < -Math.PI) twistA += 2 * Math.PI;
    const swingA = 2 * Math.acos(Math.min(1, Math.abs(_sw.w)));
    const overS = swingA - L.cone, overT = Math.abs(twistA) - L.twist;
    // относительная скорость (мир) и лёгкое демпфирование шарнира
    const wp = bp.angvel(), wc = bc.angvel();
    _wp.set(wp.x, wp.y, wp.z); _wc.set(wc.x, wc.y, wc.z);
    const mp = r.mass[L.p], mc = r.mass[L.c], kp = mc / (mp + mc), kc = mp / (mp + mc);
    const rel = _a.copy(_wc).sub(_wp);
    _wc.addScaledVector(rel, -0.04 * kc); _wp.addScaledVector(rel, 0.04 * kp);
    if (overS > 0 || overT > 0) {
      // цель: обрезанные swing и twist
      if (overS > 0) {
        const s = Math.sin(swingA / 2);
        const ax = s > 1e-6 ? _n.set(_sw.x / s, _sw.y / s, _sw.z / s) : _n.set(1, 0, 0);
        if (_sw.w < 0) ax.negate();
        _sw.setFromAxisAngle(ax, L.cone);
      }
      if (overT > 0) _tw.setFromAxisAngle(L.axis, Math.sign(twistA) * L.twist);
      _qt.copy(_sw).multiply(_tw); // цель (в осях родителя)
      _e.copy(_q).invert().premultiply(_qt); // e = цель · q⁻¹
      if (_e.w < 0) _e.set(-_e.x, -_e.y, -_e.z, -_e.w);
      const ang = 2 * Math.acos(Math.min(1, _e.w));
      const sn = Math.sin(ang / 2);
      if (sn > 1e-6) {
        _n.set(_e.x / sn, _e.y / sn, _e.z / sn).applyQuaternion(_qp); // ось ошибки в мире
        // скорость «наружу» (против n) — убрать, затем подтолкнуть к границе
        const relN = _a.copy(_wc).sub(_wp).dot(_n);
        const want = (0.25 * ang) / dt;
        const dv = want - relN;
        if (dv > 0) { _wc.addScaledVector(_n, dv * kc); _wp.addScaledVector(_n, -dv * kp); }
      }
    }
    bp.setAngvel({ x: _wp.x, y: _wp.y, z: _wp.z }, true);
    bc.setAngvel({ x: _wc.x, y: _wc.y, z: _wc.z }, true);
  }
}

export class RagdollPool {
  private pool: Ragdoll[] = [];
  readonly stats = { active: 0, launched: 0 };
  /** Отрисовка рэгдолла чужим скином (glTF); null — простые меши. */
  skin: RagdollSkin | null = null;
  private dbg = false;
  private hooked = false;

  constructor(private physics: PhysicsWorld, private scene: THREE.Scene, private size = 8) {}

  /** Отладка: тела рэгдолла каркасом поверх скина (?ragdoll_debug=1). */
  get debug(): boolean { return this.dbg; }
  set debug(on: boolean) {
    this.dbg = on;
    for (const r of this.pool) { r.setDebug(on); if (r.active) r.group.visible = on || !r.skinned; }
  }

  private ensure(): void {
    if (!this.hooked) {
      this.hooked = true;
      this.physics.onPreStep((dt) => { for (const r of this.pool) if (r.active) enforceLimits(r, dt); });
    }
    if (this.pool.length) return;
    for (let i = 0; i < this.size; i++) { const r = new Ragdoll(this.physics, this.scene); r.setDebug(this.dbg); this.pool.push(r); }
  }

  /** Есть ли свободный рэгдолл. */
  launch(agent: number, x: number, y: number, z: number, yaw: number, s: number, look: RagdollLook,
    vel: THREE.Vector3, spin: THREE.Vector3): boolean {
    this.ensure();
    const r = this.pool.find((p) => !p.active);
    if (!r) return false;
    const J = this.skin?.shape?.(agent) ?? defaultJoints();
    r.launch(agent, J, x, y, z, yaw, s, look, vel.x, vel.y, vel.z, spin);
    const slot = this.pool.indexOf(r);
    r.skinned = this.skin?.attach(slot, agent, x, y, z, yaw, r.bodies, RAGDOLL_PARTS, s) ?? false;
    r.group.visible = this.dbg || !r.skinned;
    this.stats.launched++;
    return true;
  }

  /**
   * Кадр: синхронизация; улёгшиеся (скорость < 0.35 м/с дольше 0.7 с, или старше 6 с) отдаются обратно агенту.
   * done(agent, result) вызывается для каждого отпущенного.
   */
  update(dt: number, done: (agent: number, r: RagdollResult) => void): void {
    let n = 0;
    for (let ri = 0; ri < this.pool.length; ri++) {
      const r = this.pool[ri];
      if (!r.active) continue;
      n++;
      r.time += dt;
      r.sync();
      if (r.skinned) this.skin?.update(ri, r.bodies);
      const sp = r.speed();
      r.calm = sp < 0.35 ? r.calm + dt : 0;
      if ((r.calm > 0.7 && r.time > 1.2) || r.time > 6) {
        const pel = r.bodies[0].translation();
        const tq = r.bodies[1].rotation();
        const q = new THREE.Quaternion(tq.x, tq.y, tq.z, tq.w);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        const front = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
        const l = Math.hypot(up.x, up.z) || 1;
        const res: RagdollResult = { x: pel.x, y: pel.y, z: pel.z, headX: up.x / l, headZ: up.z / l, faceUp: front.y >= 0 };
        const a = r.agent;
        if (r.skinned) { this.skin?.detach(ri, res); r.skinned = false; }
        r.release();
        done(a, res);
      }
    }
    this.stats.active = n;
  }

  /** Отпустить рэгдолл агента принудительно (агент удалён). */
  cancel(agent: number): void {
    this.pool.forEach((r, i) => {
      if (!r.active || r.agent !== agent) return;
      if (r.skinned) { this.skin?.detach(i, null); r.skinned = false; }
      r.release();
    });
  }

  isActive(agent: number): boolean { return this.pool.some((r) => r.active && r.agent === agent); }

  /** Позиция таза рэгдолла агента (для деспавна по расстоянию). */
  position(agent: number): { x: number; y: number; z: number } | null {
    const r = this.pool.find((p) => p.active && p.agent === agent);
    return r ? r.bodies[0].translation() : null;
  }
}
