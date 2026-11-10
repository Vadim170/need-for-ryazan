import { RAPIER, type PhysicsWorld } from '../physics/world';
import type { CarKind, CarModel } from './models';
import type { RailSim, Train } from './sim';
import type { CarPose, TrainRenderer } from './render';

/** Группа коллизий поездов: membership бит 4 (groundHeightAt их не видит), фильтр — всё. */
export const TRAIN_GROUPS = (0x0008 << 16) | 0xffff;

const NEAR = 160;          // м: ближе — вагон получает кинематическое тело
const POOL = 40;
const HIT_COOLDOWN = 0.8;

interface Slot { body: RAPIER.RigidBody; kind: CarKind; key: string | null }

/**
 * Поезда в физике: кинематические «тяжёлые» тела вагонов у игрока (kinematicPositionBased — толкают машину,
 * сами не сдвигаются, не сходят с рельсов). При ударе машину дополнительно отбрасывает импульсом по скорости
 * поезда (вверх и в сторону), событие crash.
 */
export class TrainPhysics {
  private slots: Slot[] = [];
  private byKey = new Map<string, Slot>();
  private hitT = new Map<string, number>();
  private pose: CarPose = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, b: [0, 0, 0, 0, 0, 0] };
  private tick = 0;
  readonly stats = { bodies: 0, hits: 0 };

  constructor(private physics: PhysicsWorld, private sim: RailSim, private models: Record<CarKind, CarModel>, private renderer: TrainRenderer,
    private player: RAPIER.RigidBody, private playerSize: { length: number; width: number; mass: number }) {}

  /** GTA-режим: игрок пересел / пешком. */
  setPlayer(body: RAPIER.RigidBody, size: { length: number; width: number; mass: number }): void { this.player = body; this.playerSize = size; }

  private makeBody(kind: CarKind): RAPIER.RigidBody {
    const m = this.models[kind], w = this.physics.world;
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -600, 0).setCanSleep(false));
    const y0 = 0.35, hh = (m.height - y0) / 2;
    w.createCollider(RAPIER.ColliderDesc.cuboid(m.width / 2, hh, m.length / 2 - 0.25).setTranslation(0, y0 + hh, 0)
      .setFriction(0.5).setRestitution(0.1).setCollisionGroups(TRAIN_GROUPS), body);
    return body;
  }

  /** Перед шагом физики, после шага симуляции поездов. */
  preStep(dt: number): void {
    const pt = this.player.translation();
    const want = new Set<string>();
    const near: { t: Train; ci: number; d: number }[] = [];
    if (this.tick++ % 6 === 0 || this.byKey.size) {
      for (const t of this.sim.trains) {
        t.cars.forEach((c, ci) => {
          const sc = t.s - c.off;
          if (sc < 0) return;
          t.path.at(sc, this.tmp);
          const d = Math.hypot(this.tmp[0] - pt.x, this.tmp[2] - pt.z);
          if (d < NEAR) near.push({ t, ci, d });
        });
      }
    }
    near.sort((a, b) => a.d - b.d);
    const pv = this.player.linvel(), pr = this.player.rotation();
    const pfx = -(2 * (pr.x * pr.z + pr.w * pr.y)), pfz = -(1 - 2 * (pr.x * pr.x + pr.y * pr.y));
    for (const { t, ci, d } of near.slice(0, POOL)) {
      const c = t.cars[ci];
      const key = `${t.id}:${ci}`;
      want.add(key);
      this.renderer.pose(t, t.s - c.off, c.model.bogieHalf, this.pose);
      const P = this.pose;
      let sl = this.byKey.get(key);
      const q = quat(c.flip ? -P.fx : P.fx, c.flip ? -P.fy : P.fy, c.flip ? -P.fz : P.fz);
      if (!sl) {
        sl = this.slots.find((s) => !s.key && s.kind === c.model.kind);
        if (!sl) { sl = { body: this.makeBody(c.model.kind), kind: c.model.kind, key: null }; this.slots.push(sl); }
        sl.key = key; this.byKey.set(key, sl);
        sl.body.setEnabled(true);
        sl.body.setTranslation({ x: P.x, y: P.y, z: P.z }, true);
        sl.body.setRotation(q, true);
      }
      sl.body.setNextKinematicTranslation({ x: P.x, y: P.y, z: P.z });
      sl.body.setNextKinematicRotation(q);
      // удар: зазор между габаритами в плане и высота
      if (d > 40 || Math.abs(P.y + 2 - pt.y) > 4) continue;
      const gap = obbGap(pt.x, pt.z, pfx, pfz, this.playerSize.length / 2, this.playerSize.width / 2, P.x, P.z, P.fx, P.fz, c.model.length / 2, c.model.width / 2);
      if (gap > 0.35) continue;
      const tv = t.v;
      const vx = P.fx * tv, vz = P.fz * tv;
      const relv = Math.hypot(pv.x - vx, pv.z - vz);
      if (relv < 2 && tv < 2) continue;
      const last = this.hitT.get(key) ?? -1e9;
      if (this.sim.time - last < HIT_COOLDOWN) continue;
      this.hitT.set(key, this.sim.time);
      // нормаль: от оси вагона к машине (поперёк) или вперёд, если машина перед лбом поезда
      const ex = pt.x - P.x, ez = pt.z - P.z;
      const along = ex * P.fx + ez * P.fz;
      let nx: number, nz: number;
      if (Math.abs(along) > c.model.length / 2 - 0.5) {
        // в лоб: вперёд и в сторону (куда смещена машина), иначе её «толкает» перед поездом
        const sg = Math.sign(along) || 1, lat = -ex * P.fz + ez * P.fx, sd = Math.sign(lat) || (Math.random() < 0.5 ? -1 : 1);
        nx = P.fx * sg * 0.5 - P.fz * sd * 0.87; nz = P.fz * sg * 0.5 + P.fx * sd * 0.87;
      }
      else { const lat = -ex * P.fz + ez * P.fx, sg = Math.sign(lat) || 1; nx = -P.fz * sg; nz = P.fx * sg; }
      const kick = 3 + 0.45 * tv;
      const tx = vx * 0.9 + nx * kick, tz = vz * 0.9 + nz * kick, ty = 2 + 0.2 * tv;
      const m = this.playerSize.mass;
      this.player.applyImpulse({ x: (tx - pv.x) * m * 0.8, y: Math.max(ty - pv.y, 0) * m, z: (tz - pv.z) * m * 0.8 }, true);
      const spin = Math.min(tv * 0.12, 3);
      this.player.applyTorqueImpulse({ x: (Math.random() - 0.5) * spin * m * 0.6, y: (Math.random() - 0.5) * spin * m * 1.5, z: (Math.random() - 0.5) * spin * m * 0.6 }, true);
      this.stats.hits++;
      this.sim.events.push({ type: 'crash', train: t.id, speed: Math.max(relv, tv) });
    }
    for (const sl of this.slots) {
      if (sl.key && !want.has(sl.key)) {
        this.byKey.delete(sl.key); sl.key = null;
        sl.body.setTranslation({ x: 0, y: -600, z: 0 }, false);
        sl.body.setEnabled(false);
      }
    }
    this.stats.bodies = this.byKey.size;
    void dt;
  }

  private tmp = new Float32Array(6);
}

function quat(fx: number, fy: number, fz: number): { x: number; y: number; z: number; w: number } {
  const yaw = Math.atan2(-fx, -fz);
  const pitch = Math.atan2(fy, Math.hypot(fx, fz));
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp };
}

/** Зазор между двумя прямоугольниками в плане (SAT; < 0 — пересекаются). */
function obbGap(ax: number, az: number, afx: number, afz: number, al: number, aw: number,
  bx: number, bz: number, bfx: number, bfz: number, bl: number, bw: number): number {
  const la = Math.hypot(afx, afz) || 1, lb = Math.hypot(bfx, bfz) || 1;
  afx /= la; afz /= la; bfx /= lb; bfz /= lb;
  const axes = [[afx, afz], [-afz, afx], [bfx, bfz], [-bfz, bfx]];
  const dx = bx - ax, dz = bz - az;
  let gap = -Infinity;
  for (const [ux, uz] of axes) {
    const ra = al * Math.abs(afx * ux + afz * uz) + aw * Math.abs(-afz * ux + afx * uz);
    const rb = bl * Math.abs(bfx * ux + bfz * uz) + bw * Math.abs(-bfz * ux + bfx * uz);
    gap = Math.max(gap, Math.abs(dx * ux + dz * uz) - ra - rb);
  }
  return gap;
}
