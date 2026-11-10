import * as THREE from 'three';
import { buildWheel, vehicleMaterial, type VehicleModel, type VehicleVariant } from '../traffic/models';
import { wheelGeometry } from '../vehicles/procedural';
import type { GltfVehicleModel } from '../traffic/gltf-models';
import type { WheelVisual } from './car-visual';
import type { VehicleLights, VehicleModelVisual } from './vehicle';
import type { ModelGeom } from './classes';

/**
 * Модель для машины игрока любого вида (GTA-режим): та же геометрия и материал, что у трафика (src/traffic/models.ts —
 * процедурные, gltf-models.ts — glTF), но одним InstancedMesh на 1 экземпляр (атрибуты aLamp/instanceColor шейдера
 * трафика: фары, стоп-сигналы, поворотники, маячок ДПС работают как у трафика). Колёса — отдельные меши в пивотах
 * подвески Vehicle. Начало координат — на земле посередине между осями (как ждёт Vehicle.setModel).
 */

export interface BuiltVehicleVisual extends VehicleModelVisual {
  geom: ModelGeom;
  lamps: InstanceLamps;
  setColor(hex: number): void;
  /** Тёмный «обгоревший» вид (взрыв). */
  char(): void;
}

/** Фонари одного экземпляра: aLamp = (фары, стоп, поворотник/аварийка/маячок 3). */
export class InstanceLamps implements VehicleLights {
  headlights = false;
  beacon = false;
  hazard = false;
  private brake = false;
  constructor(private attrs: THREE.InstancedBufferAttribute[]) { this.apply(); }
  update(braking: boolean): void { if (braking !== this.brake) { this.brake = braking; this.apply(); } }
  setHeadlights(on: boolean): void { if (on !== this.headlights) { this.headlights = on; this.apply(); } }
  setBeacon(on: boolean): void { if (on !== this.beacon) { this.beacon = on; this.apply(); } }
  setHazard(on: boolean): void { if (on !== this.hazard) { this.hazard = on; this.apply(); } }
  private apply(): void {
    for (const a of this.attrs) { a.setXYZ(0, this.headlights ? 1 : 0, this.brake ? 1 : 0, this.beacon ? 3 : this.hazard ? 2 : 0); a.needsUpdate = true; }
  }
}

const mats = new Map<THREE.Texture | null, THREE.MeshStandardMaterial>();
function matFor(map: THREE.Texture | null, envMap?: THREE.Texture | null): THREE.MeshStandardMaterial {
  let m = mats.get(map);
  if (!m) {
    m = vehicleMaterial(envMap);
    if (map) { m.map = map; map.colorSpace = THREE.SRGBColorSpace; }
    mats.set(map, m);
  }
  return m;
}

function single(geo: THREE.BufferGeometry, mat: THREE.Material, color: THREE.Color, lamps: THREE.InstancedBufferAttribute[]): THREE.InstancedMesh {
  const g = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(geo.attributes)) g.setAttribute(k, a);
  g.index = geo.index;
  const lamp = new THREE.InstancedBufferAttribute(new Float32Array(3), 3);
  g.setAttribute('aLamp', lamp);
  lamps.push(lamp);
  const im = new THREE.InstancedMesh(g, mat, 1);
  im.setMatrixAt(0, new THREE.Matrix4());
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([color.r, color.g, color.b]), 3);
  im.castShadow = true; im.receiveShadow = true;
  im.frustumCulled = false;
  return im;
}

function geomOf(wheels: [number, number, number][], dims: { length: number; width: number; height: number }, r: number): ModelGeom & { z0: number } {
  const zs = wheels.map((w) => w[2]);
  const zf = Math.min(...zs), zr = Math.max(...zs);
  return {
    length: dims.length, width: dims.width, height: dims.height, wheelbase: Math.max(zr - zf, 1), track: 2 * Math.max(...wheels.map((w) => Math.abs(w[0]))),
    wheelRadius: r, z0: (zf + zr) / 2,
  };
}

function assemble(body: THREE.InstancedMesh[], wheelMeshes: THREE.Object3D[], geom: ModelGeom & { z0: number }, lamps: THREE.InstancedBufferAttribute[], meshes: THREE.InstancedMesh[], fixedPaint?: number): BuiltVehicleVisual {
  const root = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.z = -geom.z0;
  for (const b of body) inner.add(b);
  root.add(inner);
  const wheels: WheelVisual[] = wheelMeshes.map((w) => {
    const spin = new THREE.Group();
    spin.add(w);
    const pivot = new THREE.Group();
    pivot.add(spin);
    return { pivot, spin };
  });
  const L = new InstanceLamps(lamps);
  const col = new THREE.Color();
  return {
    root, wheels, lights: L, lamps: L, geom,
    setColor(hex: number) {
      col.set(fixedPaint ?? hex);
      for (const b of body) { b.instanceColor!.setXYZ(0, col.r, col.g, col.b); b.instanceColor!.needsUpdate = true; }
    },
    char() {
      for (const mm of meshes) { mm.instanceColor?.setXYZ(0, 0.08, 0.075, 0.07); if (mm.instanceColor) mm.instanceColor.needsUpdate = true; }
      for (const b of body) {
        const m = (b.material as THREE.MeshStandardMaterial).clone();
        m.color.setRGB(0.12, 0.11, 0.1);
        b.material = m;
      }
    },
  };
}

/** Процедурная модель вида трафика (sim.models[kind]). */
export function visualFromProcModel(md: VehicleModel, color: number, envMap?: THREE.Texture | null): BuiltVehicleVisual {
  const lamps: THREE.InstancedBufferAttribute[] = [];
  const mat = matFor(null, envMap);
  const c = new THREE.Color(md.fixedPaint ?? color);
  const body = single(md.near, mat, c, lamps);
  const unit = wheelGeo();
  const meshes: THREE.InstancedMesh[] = [body];
  const geom = geomOf(md.wheels, md, md.wheelRadius);
  const order = sortWheels(md.wheels);
  const wheelMeshes = order.map(([x]) => {
    const w = single(unit, mat, new THREE.Color(1, 1, 1), []);
    w.scale.set(md.wheelWidth, md.wheelRadius, md.wheelRadius);
    if (x < 0) w.rotation.y = Math.PI;
    meshes.push(w);
    return w;
  });
  return assemble([body], wheelMeshes, geom, lamps, meshes, md.fixedPaint);
}

/** Процедурный вариант (src/vehicles/procedural: пресет кузова, диски) — тот же, что у машины трафика/парковки. */
export function visualFromVariant(vr: VehicleVariant, color: number, envMap?: THREE.Texture | null): BuiltVehicleVisual {
  const lamps: THREE.InstancedBufferAttribute[] = [];
  const mat = matFor(null, envMap);
  const body = single(vr.near, mat, new THREE.Color(vr.fixedPaint ?? color), lamps);
  const unit = wheelGeometry(vr.rim);
  const meshes: THREE.InstancedMesh[] = [body];
  const geom = geomOf(vr.wheels, vr, vr.wheelRadius);
  const wheelMeshes = sortWheels(vr.wheels).map(([x]) => {
    const w = single(unit, mat, new THREE.Color(1, 1, 1), []);
    w.scale.set(vr.wheelWidth, vr.wheelRadius, vr.wheelRadius);
    if (x < 0) w.rotation.y = Math.PI;
    meshes.push(w);
    return w;
  });
  return assemble([body], wheelMeshes, geom, lamps, meshes, vr.fixedPaint);
}

/** glTF-модель (VehicleLibrary): кузов + колесо-шаблон (правое; левые — поворот на π). */
export function visualFromGltf(md: GltfVehicleModel, color: number, envMap?: THREE.Texture | null): BuiltVehicleVisual {
  const lamps: THREE.InstancedBufferAttribute[] = [];
  const mat = matFor(md.map, envMap);
  const fixed = md.entry.paint.fixed ? new THREE.Color(md.entry.paint.fixed).getHex() : undefined;
  const c = new THREE.Color(fixed ?? color);
  const body = single(md.body, mat, c, lamps);
  const meshes: THREE.InstancedMesh[] = [body];
  const wheels = md.wheels.length ? md.wheels : defaultWheels(md.entry.dims, md.wheelRadius);
  const geom = geomOf(wheels, md.entry.dims, md.wheelRadius);
  const order = sortWheels(wheels);
  const wheelMeshes = order.map(([x]) => {
    if (!md.wheel) return new THREE.Group();
    const w = single(md.wheel, mat, new THREE.Color(1, 1, 1), []);
    if (x < 0) w.rotation.y = Math.PI;
    meshes.push(w);
    return w;
  });
  return assemble([body], wheelMeshes, geom, lamps, meshes, fixed);
}

let _wheel: THREE.BufferGeometry | null = null;
function wheelGeo(): THREE.BufferGeometry { return (_wheel ??= buildWheel()); }

/** Порядок Vehicle: FL, FR, RL, RR (перёд −Z, лево −X); у автобусов с 6 колёсами — крайние оси. */
function sortWheels(w: [number, number, number][]): [number, number, number][] {
  const zf = Math.min(...w.map((p) => p[2])), zr = Math.max(...w.map((p) => p[2]));
  const pick = (front: boolean, left: boolean) => w.find((p) => (front ? p[2] === zf : p[2] === zr) && (left ? p[0] < 0 : p[0] > 0)) ?? w[0];
  return [pick(true, true), pick(true, false), pick(false, true), pick(false, false)];
}

function defaultWheels(d: { length: number; width: number }, r: number): [number, number, number][] {
  const hz = d.length * 0.32, hx = d.width * 0.42;
  return [[-hx, r, -hz], [hx, r, -hz], [-hx, r, hz], [hx, r, hz]];
}
