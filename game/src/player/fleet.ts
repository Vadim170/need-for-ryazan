import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import { Vehicle } from '../vehicle/vehicle';
import { restGroundOffset } from '../vehicle/config';
import { CHAR_QUERY_GROUPS } from './character-body';
import { classOfKind, vehicleConfigFor, type VehicleClass } from '../vehicle/classes';
import { visualFromGltf, visualFromProcModel, visualFromVariant, type BuiltVehicleVisual } from '../vehicle/vehicle-visuals';
import { allVariants, type VehicleVariant } from '../vehicles/procedural';
import type { VehicleKind, VehicleModel } from '../traffic/models';
import type { GltfTrafficLayer, GltfVehicleModel, VehicleLibrary } from '../traffic/gltf-models';
import type { SimVehicle } from '../traffic/sim';
import type { Traffic } from '../traffic';
import { quatFromForward } from '../traffic/physics';
import type { Props } from '../world/props';
import type { VehicleDamage } from '../combat/vehicle-damage';
import type { LargusModel } from '../vehicle/car-visual';

/**
 * Машины, которыми может управлять игрок (GTA-режим): Largus со старта, угнанные из трафика, взятые с парковки,
 * полицейские (их водит PoliceForce). Каждая — полноценный Vehicle (та же физика, конфиг по классу, src/vehicle/classes.ts).
 * Брошенная машина остаётся стоять (ручник), её можно снова взять; далёкие (> 320 м) исчезают, кроме Largus.
 */

export interface FleetCar {
  id: number;
  vehicle: Vehicle;
  kind: string;
  cls: VehicleClass;
  visual: BuiltVehicleVisual | null;
  police: boolean;
  siren: boolean;
  trunkLooted: boolean;
  /** Троллейбус: заряд аккумулятора автономного хода 0..1. */
  trolley: { battery: number; wired: boolean } | null;
  driver: 'player' | 'ai' | 'none';
  keep: boolean;
  /** Полуразмеры (для дверей и препятствий). */
  halfLen: number; halfW: number;
}

export interface EnterCandidate {
  car: FleetCar | null;
  traffic: SimVehicle | null;
  parked: { tile: string; si: number; matrix: THREE.Matrix4; kind: string; color: THREE.Color } | null;
  /** Точка у двери водителя (мир). */
  door: THREE.Vector3;
  /** Сторона двери (0 — водительская / передняя у автобуса, 1 — противоположная: у обычной было тесно). */
  side: number;
  /** Курс (рад), куда смотреть у двери (на машину). */
  yaw: number;
  dist: number;
  /** Подпись для подсказки. */
  label: string;
  /** Занята водителем (угон). */
  occupied: boolean;
}

export interface FleetDeps {
  physics: PhysicsWorld;
  scene: THREE.Scene;
  envMap?: THREE.Texture | null;
  models: () => Record<VehicleKind, VehicleModel>;
  gltf: () => GltfTrafficLayer | null;
  lib: VehicleLibrary | null;
  damage: VehicleDamage;
  traffic: () => Traffic | null;
  props: () => Props | null;
}

const KIND_NAME: Record<string, string> = {
  sedan: 'седан', hatch: 'хэтчбек', wagon: 'универсал', suv: 'внедорожник', taxi: 'такси', police: 'машина ДПС', gazelle: 'ГАЗель',
  paz: 'ПАЗ', liaz: 'ЛиАЗ', trolleybus: 'троллейбус', largus: 'Largus',
};
export const kindName = (k: string) => KIND_NAME[k] ?? 'машина';

const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _s = new THREE.Vector3();
/** Лучи «только земля/здания» (как PhysicsWorld.groundHeightAt): пропсы, трафик, рэгдоллы, персонажи — мимо. */
const GROUND_GROUPS = (0xffff << 16) | 0x0001;
let _ray: RAPIER.Ray | null = null;
let _ball: RAPIER.Ball | null = null;
const _d2 = new THREE.Vector3(), _f = new THREE.Vector3();
let nextId = 1;

export class Fleet {
  readonly cars: FleetCar[] = [];
  private trolleyGrid: Set<number> | null = null;

  constructor(private d: FleetDeps) {}

  /** Уже существующая машина (Largus игрока). */
  addExisting(vehicle: Vehicle, kind = 'largus', keep = true): FleetCar {
    const c = vehicle.cfg.chassis;
    const fc: FleetCar = { id: nextId++, vehicle, kind, cls: classOfKind(kind), visual: null, police: false, siren: false, trunkLooted: false,
      trolley: null, driver: 'none', keep, halfLen: c.length / 2, halfW: c.width / 2 };
    this.cars.push(fc);
    this.d.damage.register({ body: vehicle.body, halfLen: fc.halfLen, onExplode: () => charLargus(vehicle) });
    return fc;
  }

  /**
   * Новая машина вида kind: модель — glTF (если дана) или процедурная из трафика; pose — начало модели на земле
   * (как у трафика: центр габарита) + поворот; vel — начальная скорость.
   */
  spawn(kind: string, color: number, ground: THREE.Vector3, quat: THREE.Quaternion, vel?: THREE.Vector3, gltf?: GltfVehicleModel | null, variant?: VehicleVariant | null): FleetCar {
    const models = this.d.models();
    const md = models[kind as VehicleKind] ?? models.sedan;
    const vis = gltf ? visualFromGltf(gltf, color, this.d.envMap) : variant ? visualFromVariant(variant, color, this.d.envMap) : visualFromProcModel(md, color, this.d.envMap);
    const geom = vis.geom as typeof vis.geom & { z0?: number };
    const cfg = vehicleConfigFor(kind, geom);
    // начало тела: над осями (z0 модели), на высоте покоя подвески
    const z0 = geom.z0 ?? 0;
    const pos = _v.set(0, -restGroundOffset(cfg) + 0.02, z0).applyQuaternion(quat).add(ground);
    pos.y += this.groundSnap(pos, quat, cfg.chassis.track / 2, cfg.chassis.wheelbase / 2, ground.y + _v2.set(0, 0, z0).applyQuaternion(quat).y);
    const veh = new Vehicle(this.d.physics, cfg, pos.clone());
    veh.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    veh.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    veh.body.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true);
    this.d.physics.resetTracking(veh.body);
    if (vel) veh.body.setLinvel({ x: vel.x, y: 0, z: vel.z }, true); // без вертикальной скорости
    veh.setModel(vis);
    this.d.scene.add(veh.visual);
    const fc: FleetCar = {
      id: nextId++, vehicle: veh, kind, cls: classOfKind(kind), visual: vis, police: kind === 'police', siren: false, trunkLooted: false,
      trolley: kind === 'trolleybus' ? { battery: 1, wired: true } : null, driver: 'none', keep: false,
      halfLen: cfg.chassis.length / 2, halfW: cfg.chassis.width / 2,
    };
    this.cars.push(fc);
    this.d.damage.register({ body: veh.body, halfLen: fc.halfLen, onExplode: () => vis.char(), armor: fc.cls === 'bus' || fc.cls === 'trolleybus' ? 0.45 : fc.cls === 'van' ? 0.8 : 1 });
    return fc;
  }

  /**
   * Поправка высоты спавна (м) по реальной физической земле под 4 колёсами: поза трафика/парковки — по рельефу и
   * поверхностям, а коллайдер дороги/тротуара может отличаться на сантиметры–дециметры. Колёса ставятся на самую высокую
   * опору (ни одно не начинает внутри бордюра: подвеска не сжата до упора, кузов не прыгает). Лучи — только земля/здания
   * (пропсы, трафик, рэгдоллы не видят); ничего не нашлось или разброс подозрительный — 0.
   */
  private groundSnap(body: THREE.Vector3, quat: THREE.Quaternion, hx: number, hz: number, groundY: number): number {
    const w = this.d.physics.world;
    const ray = _ray ??= new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    let best = -Infinity;
    for (const [x, z] of [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]]) {
      const o = _s.set(x, 0, z).applyQuaternion(quat);
      const wx = body.x + o.x, wz = body.z + o.z, expect = groundY + o.y;
      ray.origin.x = wx; ray.origin.y = expect + 1.0; ray.origin.z = wz;
      const hit = w.castRay(ray, 2.0, true, undefined, GROUND_GROUPS);
      if (hit) best = Math.max(best, 1.0 - hit.timeOfImpact);
    }
    return best > -0.35 && best < 0.5 ? best : 0;
  }

  /** Машина трафика → физическая (поза и скорость сохраняются), из симуляции убирается. */
  fromTraffic(v: SimVehicle): FleetCar {
    const q = quatFromForward(v.fx, v.fy, v.fz);
    _q.set(q.x, q.y, q.z, q.w);
    const t = this.d.traffic();
    const gl = t?.renderer.gltf?.has(v.kind) ? this.d.gltf()?.modelFor(v) ?? null : null;
    const vr = gl ? null : t?.renderer.variantFor(v) ?? null;
    t?.physics.takeOver(v); // кинематическое тело трафика — из мира до создания Vehicle (иначе лучи подвески бьют в него)
    const fc = this.spawn(v.kind, v.color, _v2.set(v.x, v.y, v.z).clone(), _q.clone(), new THREE.Vector3(v.fx * v.v, 0, v.fz * v.v), gl, vr);
    this.d.traffic()?.sim.remove(v);
    return fc;
  }

  /** Машина парковки (пропс) → физическая. */
  fromParked(p: { tile: string; si: number; matrix: THREE.Matrix4; kind: string; color: THREE.Color }): FleetCar | null {
    const props = this.d.props();
    if (!props) return null;
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
    p.matrix.decompose(pos, quat, _s);
    let kind = 'sedan';
    let gl: GltfVehicleModel | null = null;
    let vr: VehicleVariant | null = null;
    if (p.kind.startsWith('car_p_')) {
      vr = allVariants().find((x) => x.id === p.kind.slice(6)) ?? null;
      kind = vr?.kind ?? p.kind.slice(6);
    }
    else if (p.kind === 'car_sedan' || p.kind === 'car_wagon') kind = p.kind.slice(4);
    else {
      gl = this.d.lib?.models.find((m) => 'car_' + m.entry.id === p.kind) ?? null;
      kind = (gl?.entry.kind as string) ?? 'sedan';
    }
    if (!props.takeParkedCar(p.tile, p.si)) return null;
    return this.spawn(kind, p.color.getHex(), pos, quat, undefined, gl, vr);
  }

  remove(c: FleetCar): void {
    const i = this.cars.indexOf(c);
    if (i >= 0) this.cars.splice(i, 1);
    this.d.damage.unregister(c.vehicle.body);
    c.vehicle.dispose();
  }

  byBody(handle: number): FleetCar | undefined { return this.cars.find((c) => c.vehicle.body.handle === handle); }

  /** Точка у двери водителя (слева; у автобусов — передняя дверь справа); side 1 — с другой стороны (пассажирская / задняя). */
  door(c: { halfLen: number; halfW: number; cls: VehicleClass }, pos: THREE.Vector3, quat: THREE.Quaternion, out: THREE.Vector3, side = 0): THREE.Vector3 {
    const bus = c.cls === 'bus' || c.cls === 'trolleybus';
    const sx = side ? -1 : 1;
    const lx = (bus ? c.halfW + 0.55 : -(c.halfW + 0.5)) * sx;
    const lz = bus ? -c.halfLen + 1.1 : -0.35;
    return out.set(lx, 0, lz).applyQuaternion(quat).add(pos);
  }

  /**
   * Дверь, к которой можно подойти: обычная, а если там тесно (соседняя машина вплотную, столб, стена — шар 0.3 м на высоте
   * груди задевает коллайдер) — с другой стороны. Возвращает сторону (0/1); out — точка.
   */
  doorFor(c: { halfLen: number; halfW: number; cls: VehicleClass }, pos: THREE.Vector3, quat: THREE.Quaternion, out: THREE.Vector3, chestY: number): number {
    this.door(c, pos, quat, out, 0);
    if (this.doorClear(out, chestY)) return 0;
    const alt = this.door(c, pos, quat, _d2, 1);
    if (this.doorClear(alt, chestY)) { out.copy(alt); return 1; }
    return 0;
  }

  private doorClear(p: THREE.Vector3, y: number): boolean {
    const ball = _ball ??= new RAPIER.Ball(0.3);
    return !this.d.physics.world.intersectionWithShape({ x: p.x, y, z: p.z }, { x: 0, y: 0, z: 0, w: 1 }, ball, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, CHAR_QUERY_GROUPS);
  }

  /** Расстояние (по земле) от точки до прямоугольника машины (центр, курс по кватерниону, полуразмеры). */
  private obbDist(p: THREE.Vector3, c: THREE.Vector3, quat: THREE.Quaternion, hl: number, hw: number): number {
    const f = _f.set(0, 0, -1).applyQuaternion(quat);
    const fl = Math.hypot(f.x, f.z) || 1, fx = f.x / fl, fz = f.z / fl;
    const dx = p.x - c.x, dz = p.z - c.z;
    const lo = Math.abs(dx * fx + dz * fz), la = Math.abs(-dx * fz + dz * fx);
    return Math.hypot(Math.max(0, lo - hl), Math.max(0, la - hw));
  }

  /**
   * Ближайшая машина, в которую можно сесть: свои/брошенные, ДПС, трафик (медленный, в т. ч. заглохшие/сдвинутые, кроме
   * сгоревших), парковка (в т. ч. сдвинутые ударом, пока катятся). Расстояние — до двери или до габарита (не до центра:
   * у автобуса дверь в 5 м от центра).
   */
  findEnterable(p: THREE.Vector3, r: number): EnterCandidate | null {
    let best: EnterCandidate | null = null;
    const consider = (c: EnterCandidate) => { if (!best || c.dist < best.dist) best = c; };
    for (const fc of this.cars) {
      if (fc.driver === 'player' || this.d.damage.wrecked(fc.vehicle.body)) continue;
      const vp = fc.vehicle.position, vq = fc.vehicle.visual.quaternion;
      if (vp.distanceTo(p) > r + fc.halfLen + 1) continue;
      const door = new THREE.Vector3();
      const side = this.doorFor(fc, vp, vq, door, vp.y + 0.5);
      const dist = Math.min(door.distanceTo(p), this.obbDist(p, vp, vq, fc.halfLen, fc.halfW));
      consider({ car: fc, traffic: null, parked: null, door, side, yaw: faceYaw(door, vp), dist, label: kindName(fc.kind), occupied: fc.driver === 'ai' });
    }
    const t = this.d.traffic();
    if (t) {
      for (const v of t.sim.vehicles) {
        if (v.dead || !v.alive || Math.abs(v.x - p.x) > r + 8 || Math.abs(v.z - p.z) > r + 8) continue;
        const q = quatFromForward(v.fx, v.fy, v.fz);
        _q.set(q.x, q.y, q.z, q.w);
        _v.set(v.x, v.y, v.z);
        const d0 = this.obbDist(p, _v, _q, v.len / 2, v.halfW);
        if (d0 > r) continue;
        const cls = classOfKind(v.kind);
        const door = new THREE.Vector3();
        const side = this.doorFor({ halfLen: v.len / 2, halfW: v.halfW, cls }, _v, _q, door, v.y + 0.9);
        consider({ car: null, traffic: v, parked: null, door, side, yaw: faceYaw(door, _v), dist: Math.min(door.distanceTo(p), d0), label: kindName(v.kind), occupied: true });
      }
    }
    const props = this.d.props();
    const pk = props?.findParkedCar(p.x, p.z, r + 2.5);
    if (pk) {
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
      pk.matrix.decompose(pos, quat, _s);
      const door = new THREE.Vector3();
      const side = this.doorFor({ halfLen: 2.2, halfW: 0.88, cls: 'car' }, pos, quat, door, pos.y + 0.9);
      consider({ car: null, traffic: null, parked: pk, door, side, yaw: faceYaw(door, pos), dist: Math.min(door.distanceTo(p), this.obbDist(p, pos, quat, 2.2, 0.88)), label: 'машина', occupied: false });
    }
    const b = best as EnterCandidate | null;
    return b && b.dist <= r ? b : null;
  }

  /** Троллейбусная сеть: маршруты трафика type=trolleybus, точки через 10 м → сетка 20 м. */
  buildTrolleyWires(t: Traffic): void {
    const g = new Set<number>();
    const net = t.net, tmp = new Float32Array(12);
    for (const r of net.routes) {
      if (r.type !== 'trolleybus') continue;
      for (const pc of r.pieces) for (const e of pc.edges) {
        const lane = net.edges[e]?.lanes[0];
        if (lane === undefined) continue;
        const L = net.segLen[lane];
        for (let s = 0; s <= L; s += 10) {
          net.pointAt(lane, Math.min(s, L), tmp);
          g.add(Math.floor(tmp[0] / 20) * 100003 + Math.floor(tmp[2] / 20));
        }
      }
    }
    this.trolleyGrid = g;
  }

  private wired(x: number, z: number): boolean {
    if (!this.trolleyGrid) return true;
    const cx = Math.floor(x / 20), cz = Math.floor(z / 20);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (this.trolleyGrid.has((cx + i) * 100003 + cz + j)) return true;
    return false;
  }

  /**
   * Кадр: брошенные стоят на ручнике, троллейбус без проводов — от аккумулятора, далёкие исчезают.
   * current — последняя машина игрока (Player.car): не удаляется, пока на неё ссылаются звук/погода/HUD (иначе — обращение
   * к удалённому телу Rapier и падение wasm «unreachable», если уйти пешком дальше 320 м).
   */
  update(dt: number, player: THREE.Vector3, current?: FleetCar): void {
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const veh = c.vehicle;
      veh.updateVisual(); // колёса (подвеска, руль, вращение) после шага физики
      const wreck = this.d.damage.wrecked(veh.body);
      if (c.driver === 'none' || wreck) {
        const inp = veh.input;
        inp.throttle = 0; inp.steer = 0; inp.nitro = false; inp.handbrake = true;
        inp.brake = veh.forwardSpeed > 1.6 ? 0.4 : 0;
      }
      if (c.trolley && c.driver !== 'none') {
        const tr = c.trolley;
        tr.wired = this.wired(veh.position.x, veh.position.z);
        tr.battery = Math.max(0, Math.min(1, tr.battery + (tr.wired ? 0.08 : -veh.input.throttle * 0.012 - 0.002) * dt));
        if (!tr.wired && tr.battery <= 0) veh.input.throttle = 0;
        else if (!tr.wired) veh.input.throttle *= 0.55; // автономный ход — слабее
      }
      if (c.visual) c.visual.lamps.setBeacon(c.police && c.siren);
      if (c === current) continue;
      if (!c.keep && c.driver === 'none' && veh.position.distanceTo(player) > 320) this.remove(c);
      else if (veh.position.y < -300) this.remove(c);
    }
  }
}

function faceYaw(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/** Largus после взрыва: все материалы темнеют. */
function charLargus(v: Vehicle): void {
  const m = v.model as LargusModel | null;
  v.visual.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mesh.material = mats.map((mt) => { const c = mt.clone() as THREE.MeshStandardMaterial; c.color?.multiplyScalar(0.12); if (c.emissive) c.emissiveIntensity = 0; return c; }) as never;
    if (!Array.isArray(mesh.material)) return;
    if ((mesh.material as THREE.Material[]).length === 1) mesh.material = (mesh.material as THREE.Material[])[0];
  });
  void m;
}
