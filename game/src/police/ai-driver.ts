import * as THREE from 'three';
import type { Vehicle } from '../vehicle/vehicle';

/**
 * Водитель-бот для физической машины (Vehicle): едет по ломаной (pure pursuit, скорость от кривизны) или прямо на цель
 * (погоня/таран), выкручивается задним ходом, если застрял. Ставит vehicle.input — физика та же, что у игрока.
 */
export class AIDriver {
  path: THREE.Vector3[] = [];
  private idx = 0;
  /** Прямая цель (погоня); null — по ломаной. */
  target: THREE.Vector3 | null = null;
  /** Скорость цели (упреждение). */
  readonly targetVel = new THREE.Vector3();
  /** Таранить (не тормозить у цели). */
  ram = false;
  /** Остановиться у цели на расстоянии stopDist. */
  stopDist = 8;
  maxSpeed = 24;
  stuck = 0;
  private reverseT = 0;
  private reverseSteer = 0;
  private fwd = new THREE.Vector3();
  private aim = new THREE.Vector3();

  setPath(p: THREE.Vector3[]): void { this.path = p; this.idx = 0; }

  /** Осталось пути (м) — грубо. */
  get remaining(): number {
    let s = 0;
    for (let i = Math.max(this.idx, 1); i < this.path.length; i++) s += this.path[i].distanceTo(this.path[i - 1]);
    return s;
  }

  drive(v: Vehicle, dt: number): void {
    const inp = v.input;
    const p = v.position;
    this.fwd.set(0, 0, -1).applyQuaternion(v.visual.quaternion);
    const fx = this.fwd.x, fz = this.fwd.z, fl = Math.hypot(fx, fz) || 1;
    const speed = v.forwardSpeed;
    // --- задний ход (застрял)
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      inp.throttle = 0; inp.brake = 1; inp.steer = this.reverseSteer; inp.handbrake = false; inp.nitro = false;
      return;
    }
    // --- куда
    let dist = 0, stop = false;
    if (this.target) {
      this.aim.copy(this.target).addScaledVector(this.targetVel, Math.min(1.2, p.distanceTo(this.target) / 25));
      dist = Math.hypot(this.aim.x - p.x, this.aim.z - p.z);
      stop = !this.ram && dist < this.stopDist;
    } else if (this.path.length) {
      // ближайшая точка впереди
      let best = this.idx, bd = 1e9;
      for (let i = this.idx; i < Math.min(this.path.length, this.idx + 12); i++) {
        const d = this.path[i].distanceToSquared(p);
        if (d < bd) { bd = d; best = i; }
      }
      this.idx = best;
      const look = 7 + Math.abs(speed) * 0.55;
      let acc = 0, k = this.idx;
      while (k < this.path.length - 1 && acc < look) { acc += this.path[k].distanceTo(this.path[k + 1]); k++; }
      this.aim.copy(this.path[k]);
      dist = this.remaining + p.distanceTo(this.path[this.idx]);
      stop = k >= this.path.length - 1 && dist < this.stopDist;
    } else stop = true;
    const dx = this.aim.x - p.x, dz = this.aim.z - p.z;
    const lat = (dx * -fz + dz * fx) / fl, lon = (dx * fx + dz * fz) / fl;
    const ang = Math.atan2(lat, lon);
    inp.steer = Math.max(-1, Math.min(1, ang * 2.2));
    inp.nitro = false;
    // --- скорость
    let vDes = this.maxSpeed * (1 - Math.min(0.75, Math.abs(ang) * 1.1));
    if (!this.ram) vDes = Math.min(vDes, Math.max(0, (dist - this.stopDist) * 0.7) + 1);
    if (stop) vDes = 0;
    if (Math.abs(ang) > 2.2 && dist < 25) {
      // цель позади и близко — разворот задним ходом
      vDes = 0;
    }
    const e = vDes - speed;
    inp.throttle = vDes > 0.5 ? Math.max(0, Math.min(1, e * 0.4 + 0.3)) : 0;
    // тормоз только на ходу: на малой скорости «тормоз» включил бы задний ход (Vehicle) — там ручник
    inp.brake = speed > 1.6 ? (e < -1 ? Math.min(1, -e * 0.25) : stop ? 0.7 : 0) : 0;
    inp.handbrake = stop && speed <= 1.6;
    if (inp.throttle > 0.4) inp.brake = 0;
    // --- застрял: газ есть, скорости нет
    if (inp.throttle > 0.3 && Math.abs(speed) < 0.8) this.stuck += dt; else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (this.stuck > 1.6) {
      this.stuck = 0;
      this.reverseT = 1.3;
      this.reverseSteer = -Math.sign(inp.steer || 1);
    }
  }
}
