import * as THREE from 'three';
import { clamp, damp, lerp } from '../core/time';
import type { Vehicle } from '../vehicle/vehicle';

export interface CameraConfig {
  distance: number;
  height: number;
  lookAhead: number;
  lookHeight: number;
  followRate: number; // position smoothing 1/s
  yawRate: number; // heading smoothing 1/s
  velocityYawBlend: number; // how much of the velocity direction is used while drifting
  baseFov: number;
  fovPerSpeed: number; // deg per (m/s)
  maxFovAdd: number;
  shakeStart: number; // m/s
  shakeAmount: number; // m at full speed
  nitroFovAdd: number;
  lookIntoTurn: number; // m бокового смещения точки взгляда на 1 рад/с рыскания (взгляд «в поворот»)
}

export const cameraConfig: CameraConfig = {
  distance: 7.2,
  height: 2.5,
  lookAhead: 4,
  lookHeight: 1.1,
  followRate: 9,
  yawRate: 4.5,
  velocityYawBlend: 0.6,
  baseFov: 62,
  fovPerSpeed: 0.5,
  maxFovAdd: 28,
  shakeStart: 35,
  shakeAmount: 0.05,
  nitroFovAdd: 8,
  lookIntoTurn: 2.2,
};

export class ChaseCamera {
  private yaw = 0;
  private pos = new THREE.Vector3();
  private fovAdd = 0;
  private inited = false;
  private tmp = new THREE.Vector3();
  private look = new THREE.Vector3();
  private lookSmooth = new THREE.Vector3();
  private back = 0; // 0..1 look-back blend
  private turn = 0; // сглаженное смещение взгляда в поворот, м

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly cfg: CameraConfig = cameraConfig,
    private readonly groundHeight: (x: number, z: number) => number = () => 0,
  ) {}

  snap(): void {
    this.inited = false;
  }

  update(dt: number, car: Vehicle, lookBack: boolean, time: number): void {
    const c = this.cfg;
    const carPos = car.position;
    const q = car.visual.quaternion;
    const fwd = this.tmp.set(0, 0, -1).applyQuaternion(q);
    let carYaw = Math.atan2(-fwd.x, -fwd.z);
    // blend toward the velocity direction when sliding so the camera shows the drift
    if (car.speed > 5 && car.forwardSpeed > 0) {
      const vel = car.body.linvel();
      const velYaw = Math.atan2(-vel.x, -vel.z);
      carYaw += wrapAngle(velYaw - carYaw) * c.velocityYawBlend;
    }
    if (!this.inited) {
      this.yaw = carYaw;
      this.inited = true;
      this.pos.copy(carPos);
      this.lookSmooth.copy(carPos);
      this.back = lookBack ? 1 : 0;
    }
    this.yaw += wrapAngle(carYaw - this.yaw) * damp(c.yawRate, dt);
    this.back += ((lookBack ? 1 : 0) - this.back) * damp(10, dt);
    const yaw = this.yaw + this.back * Math.PI;
    // camera sits behind the heading
    const dir = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)); // forward
    const speedStretch = clamp(car.speed / 60, 0, 1);
    const dist = c.distance + speedStretch * 1.2;
    const desired = new THREE.Vector3(
      carPos.x - dir.x * dist,
      carPos.y + c.height,
      carPos.z - dir.z * dist,
    );
    const k = damp(c.followRate, dt);
    this.pos.lerp(desired, k);
    // keep above terrain
    const g = this.groundHeight(this.pos.x, this.pos.z);
    this.pos.y = Math.max(this.pos.y, g + 0.6);

    const camPos = this.camera.position.copy(this.pos);
    // shake grows with speed
    const sh = clamp((car.speed - c.shakeStart) / 40, 0, 1) * c.shakeAmount + (car.nitroActive ? 0.03 : 0);
    if (sh > 0) {
      camPos.x += (Math.sin(time * 47.1) + Math.sin(time * 31.7 + 1)) * 0.5 * sh;
      camPos.y += (Math.sin(time * 53.3 + 2) + Math.sin(time * 37.9)) * 0.5 * sh;
      camPos.z += Math.sin(time * 41.3 + 4) * sh * 0.5;
    }
    // взгляд в поворот: точка взгляда смещается вбок по угловой скорости машины (вправо +), плавно
    const yr = car.telemetry?.yawRate ?? 0;
    this.turn += (clamp(yr * c.lookIntoTurn, -2.5, 2.5) * (1 - this.back) - this.turn) * damp(3, dt);
    this.look.set(carPos.x + dir.x * c.lookAhead - dir.z * this.turn, carPos.y + c.lookHeight, carPos.z + dir.z * c.lookAhead + dir.x * this.turn);
    this.lookSmooth.lerp(this.look, damp(18, dt));
    this.camera.lookAt(this.lookSmooth);

    const targetFov = c.baseFov + Math.min(c.maxFovAdd, car.speed * c.fovPerSpeed) + (car.nitroActive ? c.nitroFovAdd : 0);
    this.fovAdd = lerp(this.fovAdd, targetFov, damp(4, dt));
    if (Math.abs(this.camera.fov - this.fovAdd) > 0.01) {
      this.camera.fov = this.fovAdd;
      this.camera.updateProjectionMatrix();
    }
  }
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
