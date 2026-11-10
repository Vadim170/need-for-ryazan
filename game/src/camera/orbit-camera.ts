import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import { damp } from '../core/time';

/**
 * Камера от третьего лица для игрока пешком (GTA-режим): орбита вокруг головы (мышь с pointer lock / правый стик),
 * прицеливание — ближе и через правое плечо, меньше FOV. Столкновение с домами/рельефом/пропсами/машинами — луч от
 * головы к камере, камера встаёт перед препятствием (быстро приближается, медленно отдаляется).
 */
export const orbitConfig = {
  distance: 3.6,
  aimDistance: 1.7,
  height: 1.62,
  shoulder: 0.45,
  aimShoulder: 0.62,
  fov: 62,
  aimFov: 48,
  sensitivity: 0.0022,
  padSensitivity: 3.2,
  minPitch: -1.2,
  maxPitch: 1.05,
};

/** Луч камеры: рельеф/здания (1), пропсы (2), машины трафика (4), поезда (8); не люди/рэгдоллы. */
const CAM_GROUPS = (0xffff << 16) | 0x000f;

export class OrbitCamera {
  yaw = 0;
  pitch = -0.12;
  aim = 0; // 0..1
  private dist = orbitConfig.distance;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private head = new THREE.Vector3();
  private headSmooth = new THREE.Vector3();
  private inited = false;
  /** Исключить тело (машина, из которой выходим). */
  exclude: RAPIER.RigidBody | null = null;

  constructor(readonly camera: THREE.PerspectiveCamera, private physics: PhysicsWorld) {}

  snap(yaw?: number): void { this.inited = false; if (yaw !== undefined) this.yaw = yaw; }

  look(dx: number, dy: number): void {
    const k = orbitConfig.sensitivity * (1 - this.aim * 0.45);
    this.yaw -= dx * k;
    this.pitch = Math.max(orbitConfig.minPitch, Math.min(orbitConfig.maxPitch, this.pitch - dy * k));
  }

  /** Направление взгляда (единичный вектор). */
  forward(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  update(dt: number, feet: THREE.Vector3, aiming: boolean, shake: number, time: number): void {
    const c = orbitConfig;
    this.aim += ((aiming ? 1 : 0) - this.aim) * damp(12, dt);
    this.head.set(feet.x, feet.y + c.height, feet.z);
    if (!this.inited) { this.headSmooth.copy(this.head); this.inited = true; this.dist = c.distance; }
    this.headSmooth.lerp(this.head, damp(18, dt));
    this.headSmooth.y += (this.head.y - this.headSmooth.y) * damp(10, dt);
    const want = c.distance + (c.aimDistance - c.distance) * this.aim;
    const shoulder = c.shoulder + (c.aimShoulder - c.shoulder) * this.aim;
    const fwd = this.forward(new THREE.Vector3());
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    // точка «через плечо»
    const pivot = this.headSmooth.clone().addScaledVector(right, shoulder);
    // столкновения: луч от головы к плечу, потом от плеча назад
    const free1 = this.cast(this.headSmooth, right, shoulder);
    pivot.copy(this.headSmooth).addScaledVector(right, Math.max(0, free1 - 0.15));
    const back = fwd.clone().negate();
    const free = this.cast(pivot, back, want + 0.3) - 0.3;
    const target = Math.max(0.35, Math.min(want, free));
    this.dist += (target - this.dist) * (target < this.dist ? damp(30, dt) : damp(4, dt));
    const pos = pivot.clone().addScaledVector(back, this.dist);
    if (shake > 0) {
      pos.x += Math.sin(time * 61) * shake * 0.15; pos.y += Math.sin(time * 47 + 1) * shake * 0.12; pos.z += Math.sin(time * 53 + 2) * shake * 0.15;
    }
    this.camera.position.copy(pos);
    this.camera.lookAt(pos.clone().add(fwd));
    const fov = c.fov + (c.aimFov - c.fov) * this.aim;
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  }

  private cast(from: THREE.Vector3, dir: THREE.Vector3, len: number): number {
    const r = this.ray;
    r.origin.x = from.x; r.origin.y = from.y; r.origin.z = from.z;
    r.dir.x = dir.x; r.dir.y = dir.y; r.dir.z = dir.z;
    const h = this.physics.world.castRay(r, len, true, undefined, CAM_GROUPS, undefined, this.exclude ?? undefined);
    return h ? h.timeOfImpact : len;
  }
}
