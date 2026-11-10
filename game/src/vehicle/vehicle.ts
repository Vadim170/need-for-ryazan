import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import { clamp, damp, lerp } from '../core/time';
import type { DriveInput } from '../core/input';
import { ATTACH_Y, restGroundOffset, type VehicleConfig } from './config';
import { buildCarVisual, type LargusModel, type WheelVisual } from './car-visual';
import { weatherGrip } from '../render/weather';

/** Светотехника машины: CarLights (Largus) или фонари процедурной модели (vehicle-visuals.ts). */
export interface VehicleLights {
  headlights: boolean;
  update(braking: boolean): void;
  setHeadlights(on: boolean): void;
}

/** Модель для setModel: кузов (начало — на земле между осями) и 4 колеса FL, FR, RL, RR. */
export interface VehicleModelVisual {
  root: THREE.Group;
  wheels: WheelVisual[];
  lights?: VehicleLights | null;
}

interface Wheel {
  front: boolean;
  left: boolean;
  attach: THREE.Vector3; // chassis-local suspension top
  suspLen: number; // current suspension length (attach -> wheel centre)
  comp: number; // m, сжатие относительно свободной длины
  grounded: boolean;
  load: number; // N
  yaw: number; // steer yaw about Y (three convention)
  spin: number; // visual rolling angle
  slip: number; // 0..1+ skid amount
  normal: THREE.Vector3; // world ground normal under the wheel
  visual: WheelVisual;
}

const G = 9.81;
const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();
const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _o = new THREE.Vector3();
const _f = new THREE.Vector3(), _s = new THREE.Vector3(), _n = new THREE.Vector3(), _force = new THREE.Vector3();
const _lin = new THREE.Vector3(), _ang = new THREE.Vector3(), _pos = new THREE.Vector3(), _tmp = new THREE.Vector3();
const _com = new THREE.Vector3(), _ax = new THREE.Vector3(), _tq = new THREE.Vector3(), _wy = new THREE.Vector3(0, 1, 0);

const sign = (x: number) => (x < 0 ? -1 : 1);
const smooth = (x: number) => x * x * (3 - 2 * x);
const DEG = Math.PI / 180;

/** Лучи подвески не видят рэгдоллы пешеходов (membership 0x0010, см. people/ragdoll.ts): иначе машина «наезжает» на лежащего как на кочку. */
const SUSPENSION_RAY_GROUPS = (0xffff << 16) | (0xffff & ~0x0010);

/**
 * Arcade car on a Rapier rigid body with own raycast suspension + tire model (docs/stage3/handling.md).
 * Car local frame: forward -Z, right +X, up +Y.
 *
 * Слои: подвеска (3 луча на колесо, ограничение силы) → шины (Pacejka-подобная боковая, эллипс трения, ABS/TC; силы
 * приложены на высоте между ЦМ и пятном — `tires.forceLever`) → регулятор рыскания (цель из руля и скорости, предел по
 * сцеплению) ↔ дрифт (угол держится газом/рулём, плавный выход) → стабилизация (крен, воздух, самовыравнивание).
 */
export class Vehicle {
  readonly body: RAPIER.RigidBody;
  readonly visual: THREE.Group;
  /** Светотехника (есть после загрузки модели): `car.lights?.setHeadlights(true)`. */
  lights: VehicleLights | null = null;
  /** Тормозные огни горят (тормоз или ручник). */
  braking = false;
  /** Модель (после setModel): Largus или процедурная/glTF-модель вида трафика (GTA-режим). */
  model: LargusModel | VehicleModelVisual | null = null;
  readonly input: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };

  // telemetry (read by HUD / audio / camera)
  speed = 0; // m/s, |v|
  forwardSpeed = 0; // m/s signed along car forward
  rpm = 900;
  gear = 1; // -1 = R, 1..N
  nitroFuel = 1;
  nitroActive = false;
  private nitroLock = false;
  slipAngle = 0; // rad, body slip (+ = sliding right)
  drifting = false;
  /** 0..1: доля режима дрифта (сцепление зада, регулятор угла). */
  driftAmount = 0;
  skid = 0; // 0..1
  engineLoad = 0; // 0..1
  throttleOut = 0;
  groundedWheels = 0;
  /** Отладка/стенд: крен относительно дороги (рад), время в воздухе (с), цель рыскания (рад/с, вправо +). */
  readonly telemetry = { roll: 0, airTime: 0, yawTarget: 0, yawRate: 0, latCut: 0, steerAngle: 0 };

  private wheels: Wheel[] = [];
  private collider: RAPIER.Collider;
  /** Главные моменты инерции (локальные X — тангаж, Y — рыскание, Z — крен). */
  private inertia = new THREE.Vector3();
  /** ЦМ в системе шасси. */
  private comLocal = new THREE.Vector3();
  private steerState = 0; // -1..1 smoothed (+ right)
  private steerAngle = 0; // rad
  private shiftTimer = 0;
  /** Pedal smoothed for gearbox decisions (short taps do not kick down). */
  private thrGear = 0;
  private driftActive = false;
  private driftDir = 1; // +1 — поворот вправо
  private driftArm = 0; // s: окно «тормоз + руль → газ»
  private driftLow = 0; // s: угол ниже порога выхода
  private driftPrevAngle = 0;
  private upsideTimer = 0;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(
    private readonly physics: PhysicsWorld,
    readonly cfg: VehicleConfig,
    spawn: THREE.Vector3,
    yaw = 0,
  ) {
    const w = physics.world;
    const c = cfg.chassis;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body = w.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setCanSleep(false)
        .setCcdEnabled(true)
        .setLinearDamping(0.02)
        .setAngularDamping(0.25),
    );
    // Кузов: скруглённая коробка (бордюры/обломки не цепляют острой кромкой). Низ — на 0.25 м над землёй в покое.
    const r = 0.12;
    const hy = c.height / 2 - 0.1;
    this.collider = w.createCollider(
      RAPIER.ColliderDesc.roundCuboid(c.width / 2 - r, hy - r, c.length / 2 - r, r)
        .setTranslation(0, restGroundOffset(cfg) + 0.25 + hy, 0)
        .setFriction(0.3)
        .setRestitution(0.1),
      this.body,
    );
    this.applyMassProperties();

    const vis = buildCarVisual(cfg);
    this.visual = vis.root;
    const hx = c.track / 2, hz = c.wheelbase / 2;
    const defs: [boolean, boolean, number, number][] = [
      [true, true, -hx, -hz], [true, false, hx, -hz], [false, true, -hx, hz], [false, false, hx, hz],
    ];
    defs.forEach(([front, left, x, z], i) => {
      this.wheels.push({
        front, left, attach: new THREE.Vector3(x, ATTACH_Y, z),
        suspLen: cfg.suspension.restLength, comp: 0, grounded: false, load: 0, yaw: 0, spin: 0, slip: 0,
        normal: new THREE.Vector3(0, 1, 0), visual: vis.wheels[i],
      });
    });
    physics.track(this.body, this.visual);
    physics.onPreStep(this.stepCb);
  }

  /**
   * Масса, ЦМ и инерция из конфига. ЦМ задаётся явно (chassis.comHeight над землёй), а не центром коробки-коллайдера:
   * раньше Rapier ставил ЦМ в центр коллайдера — 0.8 м над землёй (SSF ≈ 0.94 — машина опрокидывалась от 1 g).
   */
  private applyMassProperties(): void {
    const c = this.cfg.chassis, m = c.mass;
    const ix = (m / 12) * (1 + c.length * c.length), iy = (m / 12) * (c.width * c.width + c.length * c.length);
    const iz = (m / 12) * (c.width * c.width + 1) * c.rollInertiaScale;
    this.inertia.set(ix, iy, iz);
    this.comLocal.set(0, restGroundOffset(this.cfg) + c.comHeight, c.comOffsetZ);
    // центр коллайдера в системе тела (мировой translation() коллайдера после телепорта тела обновится только на шаге)
    const t = this.collider.translationWrtParent() ?? { x: 0, y: 0, z: 0 };
    _tmp.set(t.x, t.y, t.z);
    this.collider.setMassProperties(m, { x: this.comLocal.x - _tmp.x, y: this.comLocal.y - _tmp.y, z: this.comLocal.z - _tmp.z }, { x: ix, y: iy, z: iz }, { x: 0, y: 0, z: 0, w: 1 });
  }

  private stepCb = (dt: number) => this.step(dt);

  /** Убрать машину из мира (физика, интерполяция, сцена). Общие геометрии/материалы моделей не освобождаются. */
  dispose(): void {
    this.physics.offPreStep(this.stepCb);
    this.physics.untrack(this.body);
    this.physics.world.removeRigidBody(this.body);
    this.visual.removeFromParent();
  }

  /**
   * Заменить заглушку на загруженную модель Largus: кузов ставится на землю под шасси, колёса — в пивоты подвески.
   * Вызывать после loadLargusModel(); при ошибке загрузки просто не вызывать — останутся коробки.
   */
  setModel(m: LargusModel | VehicleModelVisual): void {
    for (const ch of [...this.visual.children]) {
      this.visual.remove(ch);
      ch.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((mt) => mt.dispose());
        }
      });
    }
    m.root.position.y = restGroundOffset(this.cfg);
    this.visual.add(m.root);
    this.wheels.forEach((wh, i) => {
      wh.visual = m.wheels[i];
      this.visual.add(m.wheels[i].pivot);
    });
    this.model = m;
    this.lights = m.lights ?? null;
    this.updateVisual();
  }

  /** Put the car upright at its current location (or at `pos`), keep heading, zero velocity. Применяет массу/ЦМ из конфига. */
  reset(pos?: THREE.Vector3, yaw?: number): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    const heading = yaw ?? Math.atan2(-_fwd.x, -_fwd.z);
    const p = pos ?? _pos.set(t.x, t.y + 1.2, t.z);
    const nq = new THREE.Quaternion().setFromAxisAngle(_up.set(0, 1, 0), heading);
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.body.setRotation({ x: nq.x, y: nq.y, z: nq.z, w: nq.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.applyMassProperties();
    this.steerState = 0;
    this.gear = 1;
    this.driftActive = false;
    this.driftAmount = 0;
    this.upsideTimer = 0;
    this.physics.resetTracking(this.body);
  }

  get position(): THREE.Vector3 {
    return this.visual.position;
  }

  private torqueAt(rpm: number): number {
    const c = this.cfg.engine.torqueCurve;
    if (rpm <= c[0][0]) return c[0][1];
    for (let i = 1; i < c.length; i++) {
      if (rpm <= c[i][0]) {
        const t = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
        return lerp(c[i - 1][1], c[i][1], t);
      }
    }
    return c[c.length - 1][1];
  }

  /** Момент из углового ускорения в локальных осях шасси (x — тангаж, y — рыскание, z — крен), в мировой вектор (накапливается в _tq). */
  private addLocalAccel(ax: number, ay: number, az: number): void {
    _tmp.set(ax * this.inertia.x, ay * this.inertia.y, az * this.inertia.z).applyQuaternion(_q);
    _tq.add(_tmp);
  }

  /** One fixed physics step: suspension, tires, drivetrain, assists. */
  private step(dt: number): void {
    const cfg = this.cfg, body = this.body, inp = this.input;
    const sus = cfg.suspension, tir = cfg.tires, eng = cfg.engine, st = cfg.steering, as = cfg.assist, dr = cfg.drift, stab = cfg.stability;
    body.resetForces(true);
    body.resetTorques(true);
    _tq.set(0, 0, 0);

    const t = body.translation(), r = body.rotation(), lv = body.linvel(), av = body.angvel(), wc = body.worldCom();
    _pos.set(t.x, t.y, t.z);
    _com.set(wc.x, wc.y, wc.z);
    _q.set(r.x, r.y, r.z, r.w);
    _lin.set(lv.x, lv.y, lv.z);
    _ang.set(av.x, av.y, av.z);
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);

    const vF = _lin.dot(_fwd), vS = _lin.dot(_right);
    this.forwardSpeed = vF;
    this.speed = _lin.length();
    const absF = Math.abs(vF);
    this.slipAngle = this.speed > 3 ? Math.atan2(vS, Math.max(absF, 0.5)) * (vF >= 0 ? 1 : -1) : 0;
    const mass = cfg.chassis.mass;
    const mWheel = mass / 4;
    const staticLoad = (mass * G) / 4;
    const gripW = weatherGrip.value;
    const comH = cfg.chassis.comHeight;
    const L = cfg.chassis.wheelbase;
    const yawRate = -_ang.dot(_up); // вправо +

    // ---------- direction logic (forward / reverse) ----------
    if (this.gear > 0 && vF < 1.5 && inp.brake > 0.1 && inp.throttle < 0.1) this.gear = -1;
    else if (this.gear < 0 && vF > -1.5 && inp.throttle > 0.1 && inp.brake < 0.1) this.gear = 1;
    const reverse = this.gear < 0;
    const driveIn = reverse ? inp.brake : inp.throttle;
    const brakeIn = reverse ? inp.throttle : inp.brake;
    this.braking = brakeIn > 0.05 || inp.handbrake;
    this.throttleOut = driveIn;
    const handbrake = inp.handbrake;

    // ---------- suspension probes (3 rays along the tyre circumference) ----------
    const R = sus.wheelRadius;
    let grounded = 0;
    _n.set(0, 0, 0);
    const probes = sus.probes >= 3 ? [-0.6, 0, 0.6] : [0];
    for (const wh of this.wheels) {
      _p.copy(wh.attach).applyQuaternion(_q).add(_pos);
      this.ray.dir.x = -_up.x; this.ray.dir.y = -_up.y; this.ray.dir.z = -_up.z;
      let best = Infinity, bnx = 0, bny = 1, bnz = 0;
      for (const k of probes) {
        const d = k * R, h = Math.sqrt(R * R - d * d);
        // probe origin: along the wheel heading (steered front wheels probe along their own direction)
        const yawW = wh.front ? -this.steerAngle : 0;
        _o.set(-Math.sin(yawW) * -d, 0, -Math.cos(yawW) * -d).applyQuaternion(_q).add(_p);
        this.ray.origin.x = _o.x; this.ray.origin.y = _o.y; this.ray.origin.z = _o.z;
        const hit = this.physics.world.castRayAndGetNormal(this.ray, sus.restLength + h, true, undefined, SUSPENSION_RAY_GROUPS, undefined, body);
        if (hit) {
          const c = hit.timeOfImpact - h; // допустимое положение центра колеса (от крепления)
          if (c < best) { best = c; bnx = hit.normal.x; bny = hit.normal.y; bnz = hit.normal.z; }
        }
      }
      if (best < Infinity) {
        wh.grounded = true;
        grounded++;
        wh.comp = sus.restLength - best;
        wh.suspLen = clamp(best, sus.restLength - sus.travel * 1.3, sus.restLength);
        wh.normal.set(bnx, bny, bnz);
        if (wh.normal.dot(_up) < 0.7) wh.normal.copy(_up); // кромки и стены — не опора
        _n.add(wh.normal);
      } else {
        wh.grounded = false;
        wh.comp = 0;
        wh.suspLen = Math.min(sus.restLength, wh.suspLen + 2.5 * dt); // droop
      }
    }
    this.groundedWheels = grounded;
    if (grounded) _n.normalize(); else _n.copy(_wy);
    const groundN = _n.clone();
    const tel = this.telemetry;
    tel.airTime = grounded ? 0 : tel.airTime + dt;

    // ---------- roll relative to the road ----------
    _ax.crossVectors(_up, groundN); // ось поворота up → нормаль дороги
    const rollSin = _ax.dot(_fwd); // > 0: нужно вращение вокруг fwd (+), чтобы выпрямиться
    const roll = Math.asin(clamp(rollSin, -1, 1));
    tel.roll = roll;
    const latCut = clamp((Math.abs(roll) / DEG - stab.latCutStart) / Math.max(1, stab.latCutRange), 0, 1);
    tel.latCut = latCut;

    // ---------- suspension forces + anti-roll ----------
    const susForce: number[] = [0, 0, 0, 0];
    const fMax = sus.maxForce * staticLoad;
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i];
      if (!wh.grounded) continue;
      _p.copy(wh.attach).applyQuaternion(_q).add(_pos);
      pointVelocity(_v, _lin, _ang, _p, _com);
      const vUp = _v.dot(_up);
      const x = Math.max(0, wh.comp);
      let F = sus.stiffness * x - sus.damping * vUp;
      if (x > sus.travel) F += sus.stiffness * sus.bumpStop * (x - sus.travel); // bump stop
      susForce[i] = clamp(F, 0, fMax);
    }
    for (const [a, b] of [[0, 1], [2, 3]]) {
      const A = this.wheels[a], B = this.wheels[b];
      if (A.grounded && B.grounded) {
        const d = (A.comp - B.comp) * sus.antiRoll;
        susForce[a] = clamp(susForce[a] + d, 0, fMax);
        susForce[b] = clamp(susForce[b] - d, 0, fMax);
      }
    }

    // ---------- drivetrain ----------
    const frontShare = eng.driveFrontShare;
    const wheelOmega = absF / R;
    const nG = eng.gearRatios.length;
    const ratio = (reverse ? eng.reverseRatio : eng.gearRatios[clamp(this.gear, 1, nG) - 1]) * eng.finalDrive;
    const wheelRpm = (wheelOmega * ratio * 60) / (2 * Math.PI);
    const launchRpm = Math.abs(this.gear) === 1 ? driveIn * 3600 : 0;
    const targetRpm = Math.max(eng.idleRpm + driveIn * 250, wheelRpm, launchRpm);
    this.rpm += (targetRpm - this.rpm) * damp(eng.inertiaRpmRate, dt);
    this.rpm = clamp(this.rpm, eng.idleRpm * 0.8, eng.redlineRpm + 400);

    // automatic gearbox. Shift points follow the smoothed pedal: light throttle -> early upshifts / late downshifts
    // (calm low-rpm city driving), held full throttle -> shiftUpRpm / shiftDownRpm. Decisions use the road-speed rpm
    // (launch flare does not upshift), with hysteresis so the box never hunts between two gears.
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.thrGear += (driveIn - this.thrGear) * damp(driveIn > this.thrGear ? 2.5 : 4, dt);
    if (this.gear > 0 && this.shiftTimer === 0) {
      const k = this.thrGear;
      const upRpm = lerp(eng.shiftUpEcoRpm, eng.shiftUpRpm, k * k);
      const downRpm = lerp(eng.shiftDownEcoRpm, eng.shiftDownRpm, k * k);
      const g = this.gear, gr = eng.gearRatios;
      const rpmUp = g < nG ? (wheelRpm * gr[g]) / gr[g - 1] : 0; // rpm right after an upshift
      const rpmDown = g > 1 ? (wheelRpm * gr[g - 2]) / gr[g - 1] : 1e9; // rpm right after a downshift
      if (wheelRpm > upRpm && g < nG && rpmUp > downRpm + 250 && inp.brake < 0.5) {
        this.gear++;
        this.shiftTimer = eng.shiftTime;
      } else if (wheelRpm < downRpm && g > 1 && rpmDown < upRpm - 300) {
        this.gear--;
        this.shiftTimer = eng.shiftTime * 0.5;
      }
    }

    // nitro
    const nit = cfg.nitro;
    // empty tank -> locked out until the key is released (or 30 % refilled); without this the held key toggled nitro
    // on/off every couple of frames (drain vs refill around the 0.02 threshold): stutter in thrust and a sound "crackle"
    if (this.nitroFuel <= 0.02) this.nitroLock = true;
    else if (this.nitroLock && (!inp.nitro || this.nitroFuel >= 0.3)) this.nitroLock = false;
    this.nitroActive = inp.nitro && !this.nitroLock && driveIn > 0.1 && !reverse && this.speed >= nit.minSpeed;
    this.nitroFuel = clamp(this.nitroFuel + (this.nitroActive ? -nit.drainRate : nit.refillRate) * dt, 0, 1);

    let torque = eng.peakTorque * this.torqueAt(this.rpm) * driveIn;
    if (this.rpm >= eng.redlineRpm || this.shiftTimer > 0) torque = 0; // limiter / shift cut
    this.engineLoad = clamp(torque / eng.peakTorque, 0, 1);
    let driveForce = (torque * ratio * eng.drivetrainEfficiency * eng.powerScale) / R; // total at wheels
    if (this.nitroActive) driveForce = driveForce * nit.forceMul;
    driveForce *= reverse ? -0.8 : 1;

    // ---------- drift state ----------
    // угол дрифта в сторону поворота (+): для правого дрифта нос правее вектора скорости → slip < 0
    const steerIn = clamp(inp.steer, -1, 1);
    const canDrift = dr.enabled > 0 && !reverse && vF > dr.minSpeed && grounded >= 2;
    if (inp.brake > 0.3 && Math.abs(steerIn) > 0.4 && vF > 12) this.driftArm = dr.brakeArmTime;
    else this.driftArm = Math.max(0, this.driftArm - dt);
    if (!this.driftActive && canDrift) {
      const sd = sign(steerIn);
      const natural = -this.slipAngle * sd / DEG;
      if ((handbrake && Math.abs(steerIn) > 0.25) ||
        (this.driftArm > 0 && inp.throttle > 0.5 && Math.abs(steerIn) > 0.4) ||
        (inp.throttle > 0.8 && Math.abs(steerIn) > 0.6 && natural > dr.powerOverSlip)) {
        this.driftActive = true;
        this.driftDir = sd;
        this.driftLow = 0;
        this.driftPrevAngle = natural * DEG;
      }
    }
    const driftAngle = -this.slipAngle * this.driftDir; // rad, > 0 — правильный занос
    if (this.driftActive) {
      if (driftAngle < dr.exitAngle * DEG && !handbrake) this.driftLow += dt; else this.driftLow = 0;
      if (!canDrift && vF < dr.minSpeed * 0.7 || reverse || this.driftLow > 0.3 || driftAngle < -10 * DEG) this.driftActive = false;
    }
    this.driftAmount += ((this.driftActive ? 1 : 0) - this.driftAmount) * damp(this.driftActive ? dr.blendIn : dr.blendOut, dt);
    if (this.driftAmount < 1e-3) this.driftAmount = 0;
    const dA = this.driftAmount;

    // ---------- steering ----------
    const sFactor = clamp(absF / st.speedForMin, 0, 1);
    const lock = lerp(st.maxAngle, st.minAngle, smooth(sFactor)) * DEG;
    let steerCmd = steerIn;
    // counter-steer assist (вне дрифта): руль в сторону заноса сверх мёртвой зоны
    if (this.speed > 4 && vF > 0 && dA < 0.5) {
      const dead = 0.1;
      const ex = Math.max(0, Math.abs(this.slipAngle) - dead) * sign(this.slipAngle);
      steerCmd += clamp(ex * as.counterSteer, -as.counterSteerMax, as.counterSteerMax) * (1 - dA);
    }
    steerCmd = clamp(steerCmd, -1, 1);
    const growing = Math.abs(steerCmd) > Math.abs(this.steerState) && sign(steerCmd) === sign(this.steerState || steerCmd);
    const rate = growing ? lerp(st.response, st.responseHighSpeed, sFactor) : st.returnResponse;
    this.steerState += (steerCmd - this.steerState) * damp(rate, dt);
    // предел по сцеплению: кинематический угол для поворота на пределе + угол увода на пике шины
    const muLat = Math.min(tir.gripFront, tir.gripRear) * gripW;
    const aMax = as.latGripUse * muLat * G;
    const rCap = aMax / Math.max(absF, 1);
    const peakSlip = Math.tan(Math.PI / (2 * tir.lateralPeak)) / tir.lateralStiffness;
    const gripAngle = Math.atan((rCap * L) / Math.max(absF, 1)) + peakSlip;
    const maxAng = st.gripLimit > 0 ? Math.min(lock, lerp(lock, gripAngle, st.gripLimit)) : lock;
    let steerAngle = this.steerState * maxAng; // + = right
    if (dA > 0) {
      // в дрифте передние колёса смотрят по вектору скорости (автоконтрруль) + руль игрока
      const along = clamp(-this.driftDir * driftAngle + this.steerState * lock * 0.5, -st.maxAngle * DEG, st.maxAngle * DEG);
      steerAngle = lerp(steerAngle, along, dA);
    }
    this.steerAngle = steerAngle;
    tel.steerAngle = steerAngle;
    const yawFront = -steerAngle; // three.js Y rotation (right turn = negative)

    // ---------- tires ----------
    let skidMax = 0;
    const latScale = 1 - 0.85 * latCut;
    const rearDriftGrip = lerp(1, dr.rearGrip, dA);
    const tcOn = tir.tractionControl * (1 - dA);
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i];
      wh.yaw = wh.front ? yawFront : 0;
      if (!wh.grounded) { wh.slip = 0; wh.load = 0; continue; }
      const Fn = susForce[i];
      wh.load = Fn;
      // направления шины — в плоскости шасси (силы не «поддомкрачивают» кузов на кромках и склонах)
      _f.set(-Math.sin(wh.yaw), 0, -Math.cos(wh.yaw)).applyQuaternion(_q);
      _s.crossVectors(_f, _up).normalize();
      // скорость пятна контакта
      _p.set(wh.attach.x, wh.attach.y - wh.suspLen - R, wh.attach.z).applyQuaternion(_q).add(_pos);
      pointVelocity(_v, _lin, _ang, _p, _com);
      const vl = _v.dot(_f), vs = _v.dot(_s);

      const loadK = clamp(1 - tir.loadSensitivity * (Fn / staticLoad - 1), 0.6, 1.15);
      const mu = (wh.front ? tir.gripFront : tir.gripRear) * gripW * loadK;
      let latMul = 1;
      if (!wh.front) {
        latMul = rearDriftGrip;
        if (handbrake && this.speed > 2) latMul = Math.min(latMul, tir.handbrakeRearGrip);
      }
      const muN = mu * Fn * latMul;
      const muL = mu * tir.longGrip * Fn;

      // lateral: simplified Pacejka on slip angle
      const alpha = Math.atan2(vs, Math.abs(vl) + 1.0);
      let Fy = -muN * Math.sin(tir.lateralPeak * Math.atan(tir.lateralStiffness * alpha)) * latScale;
      const FyStop = (mWheel * Math.abs(vs)) / dt; // never overshoot zero lateral speed
      Fy = clamp(Fy, -FyStop, FyStop);

      // longitudinal: drive (+TC), brakes (+ABS)
      const share = wh.front ? frontShare / 2 : (1 - frontShare) / 2;
      let Fx = driveForce * share;
      if (tcOn > 0 && share > 0) {
        const lim = muL * 0.95 * Math.sqrt(Math.max(0.1, 1 - (Fy / Math.max(muN, 1)) ** 2));
        if (Math.abs(Fx) > lim) Fx = sign(Fx) * lerp(Math.abs(Fx), lim, tcOn);
      }
      const brakeShare = wh.front ? tir.brakeBias / 2 : (1 - tir.brakeBias) / 2;
      let brakeF = brakeIn * tir.brakeForce * brakeShare;
      if (tir.abs > 0) brakeF = lerp(brakeF, Math.min(brakeF, muL * 0.97), tir.abs);
      if (handbrake && !wh.front) brakeF += tir.handbrakeForce / 2;
      brakeF += tir.rollingResistance * Fn;
      const stopF = (mWheel * Math.abs(vl)) / dt;
      Fx -= Math.tanh(vl * 3) * Math.min(brakeF, stopF);

      // friction ellipse: с ABS/TC — приоритет боковой силы (машина рулится), иначе общий срез (занос)
      const ux = Fx / Math.max(muL, 1), uy = Fy / Math.max(muN, 1);
      const util = Math.hypot(ux, uy);
      if (util > 1) {
        const lateralFirst = (brakeIn > 0.05 && tir.abs > 0 && !handbrake) || (tcOn > 0.3 && Math.abs(Fx) > 0 && driveIn > 0);
        if (lateralFirst && Math.abs(uy) < 1) Fx *= Math.sqrt(1 - uy * uy) / Math.abs(ux);
        else { Fx /= util; Fy /= util; }
      }
      wh.slip = clamp(util - 0.9, 0, 1) + (handbrake && !wh.front && this.speed > 2 ? 0.5 : 0) + clamp(Math.abs(alpha) * 3 - 0.4, 0, 1);
      skidMax = Math.max(skidMax, wh.slip);

      // suspension: along chassis up at the mount
      _force.copy(_up).multiplyScalar(Fn);
      _p.copy(wh.attach).applyQuaternion(_q).add(_pos);
      body.addForceAtPoint(_force as unknown as RAPIER.Vector, _p as unknown as RAPIER.Vector, true);
      // tyre forces: между ЦМ и пятном (forceLever) — кренящий момент ограничен, машина скользит раньше, чем опрокидывается
      const yLat = this.comLocal.y - tir.forceLever * comH, yLong = this.comLocal.y - tir.forceLeverLong * comH;
      _p.set(wh.attach.x, yLat, wh.attach.z).applyQuaternion(_q).add(_pos);
      _force.copy(_s).multiplyScalar(Fy);
      body.addForceAtPoint(_force as unknown as RAPIER.Vector, _p as unknown as RAPIER.Vector, true);
      _p.set(wh.attach.x, yLong, wh.attach.z).applyQuaternion(_q).add(_pos);
      _force.copy(_f).multiplyScalar(Fx);
      body.addForceAtPoint(_force as unknown as RAPIER.Vector, _p as unknown as RAPIER.Vector, true);
      wh.spin += (vl / R) * dt * (handbrake && !wh.front ? 0 : 1);
    }
    this.skid = clamp(skidMax, 0, 1);
    for (const wh of this.wheels) if (!wh.grounded) wh.spin += (vF / R) * dt;

    // ---------- global forces ----------
    // aerodynamic drag + downforce (в ЦМ — без моментов)
    const v2 = this.speed * this.speed;
    if (this.speed > 0.1) {
      _tmp.copy(_lin).multiplyScalar(-0.5 * cfg.aero.airDensity * cfg.aero.dragCdA * this.speed);
      body.addForce(_tmp as unknown as RAPIER.Vector, true);
    }
    _tmp.copy(_up).multiplyScalar(-cfg.aero.downforce * v2 * (grounded > 0 ? 1 : 0.3));
    body.addForce(_tmp as unknown as RAPIER.Vector, true);
    if (this.nitroActive) {
      _tmp.copy(_fwd).multiplyScalar(nit.extraForce);
      body.addForce(_tmp as unknown as RAPIER.Vector, true);
    }
    // дрифт не «съедает» скорость: тяга вдоль скорости пропорционально углу и газу
    if (dA > 0 && driveIn > 0.1 && this.speed > 3) {
      _tmp.copy(_lin).normalize().multiplyScalar(dr.speedKeep * mass * G * dA * driveIn * Math.min(1, Math.abs(Math.sin(driftAngle)) * 2.5));
      body.addForce(_tmp as unknown as RAPIER.Vector, true);
    }

    // ---------- yaw: regulator (grip) ↔ drift angle controller ----------
    let yawAcc = 0; // рад/с², вправо +
    tel.yawRate = yawRate;
    if (grounded >= 2 && absF > 2) {
      const gF = grounded / 4;
      // цель: руль × min(кинематика при полном угле, предел сцепления)
      const rKin = (absF * Math.tan(lock)) / L;
      const rT = this.steerState * Math.min(rKin, rCap) * sign(vF);
      tel.yawTarget = rT;
      let aGrip = clamp(as.yawGain * (rT - yawRate), -as.yawAccelMax, as.yawAccelMax);
      // мягкий предел увода кузова вне дрифта
      const lim = as.slipLimit * DEG;
      if (vF > 4 && Math.abs(this.slipAngle) > lim) aGrip += (Math.abs(this.slipAngle) - lim) * sign(this.slipAngle) * as.slipLimitGain;
      aGrip *= gF * Math.min(1, 0.4 + 0.6 * gripW);
      let aDrift = 0;
      if (dA > 0) {
        const sd = this.steerState * this.driftDir; // + в поворот, − контрруль
        let target = dr.baseAngle + dr.throttleAngle * driveIn + dr.steerAngle * sd + (handbrake ? dr.handbrakeAngle : 0);
        if (driveIn < 0.15 && sd < 0.3 && !handbrake) target = 0; // газ отпущен, руль не в поворот — выход
        target = clamp(target, 0, dr.maxAngle) * DEG;
        const aDot = (driftAngle - this.driftPrevAngle) / dt;
        aDrift = this.driftDir * clamp(dr.angleGain * (target - driftAngle) - dr.angleDamping * aDot, -dr.accelMax, dr.accelMax) * gF;
      }
      yawAcc = lerp(aGrip, aDrift, dA);
    } else tel.yawTarget = 0;
    this.driftPrevAngle = driftAngle;
    this.addLocalAccel(0, -yawAcc, 0); // локальная +Y — влево

    // ---------- stability: roll (ground), air attitude, self-righting ----------
    const angLocal = _tmp.copy(_ang).applyQuaternion(_q.clone().invert());
    if (grounded > 0) {
      // выпрямление сверх rollStart + демпфер крена/тангажа
      const ex = Math.max(0, Math.abs(roll) - stab.rollStart * DEG) * sign(roll);
      const accRoll = stab.rollStiffness * ex * (grounded >= 2 ? 1 : 1.5);
      // локальная ось крена Z = −fwd; поворот вокруг +fwd на угол ⇒ вокруг Z на −угол
      this.addLocalAccel(-stab.pitchDamping * angLocal.x, 0, -accRoll - stab.rollDamping * angLocal.z);
    }
    if (tel.airTime > 0.06) {
      // в воздухе: выровнять крен (и частично тангаж) к горизонту, погасить вращение
      _ax.crossVectors(_up, _wy);
      const axL = _ax.applyQuaternion(_q.clone().invert()); // x — тангаж, z — крен
      const k = stab.airUpright;
      this.addLocalAccel(k * axL.x * stab.airPitch - stab.airDamping * angLocal.x, -stab.airYawDamping * angLocal.y, k * axL.z - stab.airDamping * angLocal.z);
    }
    // на боку / крыше и почти стоит — встать на колёса
    if (stab.selfRight > 0 && _up.y < 0.4 && this.speed < 4) this.upsideTimer += dt; else if (_up.y > 0.85) this.upsideTimer = 0;
    if (this.upsideTimer > 1.2) {
      _ax.crossVectors(_up, _wy);
      if (_ax.lengthSq() < 1e-4) _ax.copy(_fwd); // точно вверх колёсами — через крен
      const axL = _ax.normalize().applyQuaternion(_q.clone().invert());
      this.addLocalAccel(8 * axL.x - 3 * angLocal.x, 0, 8 * axL.z - 3 * angLocal.z);
      if (_up.y < 0.6) body.addForce({ x: 0, y: mass * G * 0.7, z: 0 }, true);
    }
    body.addTorque(_tq as unknown as RAPIER.Vector, true);
    this.drifting = (this.driftActive || (this.speed > 6 && Math.abs(this.slipAngle) > 0.22)) && grounded > 1;
  }

  /** Per-frame visual update: wheel positions / steer / spin. Call after physics.update(). */
  updateVisual(): void {
    for (const wh of this.wheels) {
      wh.visual.pivot.position.set(wh.attach.x, wh.attach.y - wh.suspLen, wh.attach.z);
      wh.visual.pivot.rotation.y = wh.yaw;
      wh.visual.spin.rotation.x = -wh.spin;
    }
    this.lights?.update(this.braking);
  }
}

/** v = lin + ang x (p - com) */
function pointVelocity(out: THREE.Vector3, lin: THREE.Vector3, ang: THREE.Vector3, p: THREE.Vector3, com: THREE.Vector3) {
  const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z;
  out.set(
    lin.x + ang.y * rz - ang.z * ry,
    lin.y + ang.z * rx - ang.x * rz,
    lin.z + ang.x * ry - ang.y * rx,
  );
}
