import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import { CAPSULE_CENTER, CHAR_QUERY_GROUPS } from './character-body';

/**
 * Перелезть / запрыгнуть (игрок пешком, docs/stage3/gta-mode.md): разбор препятствия впереди лучами Rapier и сценарная
 * траектория капсулы. Не зависит от меша персонажа — анимация задаётся флагами HumanRig (reach, airborne).
 *
 * Профиль: горизонтальные лучи на высотах 0.35…2.45 м до 1.3 м вперёд → ближняя грань и первая свободная высота; луч
 * сверху вниз за гранью → верх препятствия (H над ногами); лучи вниз дальше через 0.15 м → толщина (где верх кончился).
 * - тонкое (≤ 0.75 м) и H 0.45…1.1 м — перемахнуть (vault, ~0.6 с), H 1.1…2.2 м — перелезть (climb, 1.3–1.8 с);
 *   за ним — земля не ниже 2.5 м под ногами и свободное место для капсулы;
 * - толстое (крыльцо, контейнер, капот/крыша машины) и H ≤ 1.6 м — забраться наверх (ledge), если там помещается капсула;
 * - выше 2.2 м, нет земли/места — нельзя.
 * Лёгкие динамические тела (≤ 300 кг: урны, обломки) не считаются препятствием — их просто толкают.
 */
export type ClimbKind = 'vault' | 'climb' | 'ledge';

export interface ClimbPlan {
  kind: ClimbKind;
  /** Ноги в начале. */
  start: THREE.Vector3;
  /** Направление (единичное, по земле). */
  dx: number; dz: number;
  /** Расстояние по направлению до ближней грани и толщина. */
  near: number; thick: number;
  /** Высота верха (мир). */
  topY: number;
  /** Ноги в конце. */
  land: THREE.Vector3;
  /** Длительность, с. */
  dur: number;
}

const HEIGHTS = [0.35, 0.6, 0.85, 1.1, 1.35, 1.6, 1.85, 2.1, 2.45];
const REACH = 1.3;
let _ray: RAPIER.Ray | null = null;
let _cap: RAPIER.Capsule | null = null;
let _ball: RAPIER.Ball | null = null;

function solid(c: RAPIER.Collider): boolean {
  const b = c.parent();
  return !b || !b.isDynamic() || b.mass() > 300;
}

function cast(w: RAPIER.World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, len: number): number {
  const r = _ray ??= new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  r.origin.x = ox; r.origin.y = oy; r.origin.z = oz;
  r.dir.x = dx; r.dir.y = dy; r.dir.z = dz;
  const h = w.castRay(r, len, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, CHAR_QUERY_GROUPS, undefined, undefined, solid);
  return h ? h.timeOfImpact : Infinity;
}

/** Капсула игрока с ногами в p свободна (с запасом 3 см над землёй). */
function capsuleFree(w: RAPIER.World, p: THREE.Vector3): boolean {
  const cap = _cap ??= new RAPIER.Capsule(0.55, 0.28);
  return !w.intersectionWithShape({ x: p.x, y: p.y + CAPSULE_CENTER + 0.03, z: p.z }, { x: 0, y: 0, z: 0, w: 1 }, cap,
    RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, CHAR_QUERY_GROUPS, undefined, undefined, solid);
}

function ballFree(w: RAPIER.World, x: number, y: number, z: number, r: number): boolean {
  const b = _ball ??= new RAPIER.Ball(0.25);
  b.radius = r;
  return !w.intersectionWithShape({ x, y, z }, { x: 0, y: 0, z: 0, w: 1 }, b, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, CHAR_QUERY_GROUPS, undefined, undefined, solid);
}

/** Препятствие впереди ног feet по направлению (dx, dz) — план или null. maxNear — насколько далеко может быть грань. */
export function probeClimb(physics: PhysicsWorld, feet: THREE.Vector3, dx: number, dz: number, maxNear = 0.95): ClimbPlan | null {
  const w = physics.world;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) return null;
  dx /= l; dz /= l;
  // профиль ближней грани
  let near = Infinity, free = -1;
  for (let i = 0; i < HEIGHTS.length; i++) {
    const d = cast(w, feet.x, feet.y + HEIGHTS[i], feet.z, dx, 0, dz, REACH);
    if (i < 2) { near = Math.min(near, d); continue; }
    if (near === Infinity) return null; // внизу свободно — это не забор (ветка, козырёк)
    if (d > near + 0.45) { free = i; break; }
  }
  if (near === Infinity || near > 0.3 + maxNear || free < 0) return null;
  // верх: луч вниз чуть за гранью
  const probeY = feet.y + HEIGHTS[free] + 0.25;
  const fx = feet.x + dx * (near + 0.1), fz = feet.z + dz * (near + 0.1);
  const td = cast(w, fx, probeY, fz, 0, -1, 0, HEIGHTS[free] + 0.25);
  if (td === Infinity) return null;
  const topY = probeY - td, H = topY - feet.y;
  if (H < 0.45 || H > 2.2) return null;
  // толщина: где верх кончается
  let thick = -1;
  for (let k = 1; k <= 6; k++) {
    const s = near + 0.1 + k * 0.15;
    const d = cast(w, feet.x + dx * s, topY + 0.3, feet.z + dz * s, 0, -1, 0, 0.7);
    if (d === Infinity || topY + 0.3 - d < topY - 0.25) { thick = s - near - 0.075; break; }
  }
  // над препятствием — место для тела
  if (!ballFree(w, fx, topY + 0.55, fz, 0.25)) return null;
  const start = feet.clone();
  if (thick < 0) {
    // толстое: забраться наверх
    if (H > 1.6) return null;
    const land = new THREE.Vector3(feet.x + dx * (near + 0.45), topY + 0.02, feet.z + dz * (near + 0.45));
    if (!capsuleFree(w, land)) return null;
    return { kind: 'ledge', start, dx, dz, near, thick: 0.9, topY, land, dur: 0.75 + H * 0.45 };
  }
  // тонкое: земля за ним (место для капсулы — в 0.45…1.2 м за дальней гранью: рядом может стоять столб/куст)
  let land: THREE.Vector3 | null = null;
  for (const off of [0.45, 0.7, 0.95, 1.2]) {
    const s = near + thick + off;
    const lx = feet.x + dx * s, lz = feet.z + dz * s;
    const gd = cast(w, lx, topY + 0.4, lz, 0, -1, 0, H + 3.0);
    if (gd === Infinity) continue;
    const p = new THREE.Vector3(lx, topY + 0.4 - gd + 0.02, lz);
    if (p.y < feet.y - 2.5 || p.y > topY - 0.3) continue;
    if (capsuleFree(w, p)) { land = p; break; }
  }
  if (!land) return null;
  const vault = H <= 1.1;
  return { kind: vault ? 'vault' : 'climb', start, dx, dz, near, thick, topY, land, dur: vault ? 0.5 + near * 0.15 : 0.95 + H * 0.4 };
}

const ss = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
const seg = (u: number, a: number, b: number) => Math.min(1, Math.max(0, (u - a) / (b - a)));

/**
 * Ноги на траектории в момент u ∈ [0, 1]. Пока ноги ниже верха, центр капсулы не заходит за ближнюю грань
 * (минус радиус): тело не проходит сквозь препятствие. reach — поза рук ('plant' — опора руками, 'up' — подтягивание).
 */
export function climbPose(p: ClimbPlan, u: number, out: THREE.Vector3): { reach: 'none' | 'plant' | 'up'; air: boolean } {
  const y0 = p.start.y, top = p.topY + 0.06;
  const face = Math.max(0, p.near - 0.32), over = p.near + p.thick * 0.5, far = Math.hypot(p.land.x - p.start.x, p.land.z - p.start.z);
  let s: number, y: number, reach: 'none' | 'plant' | 'up' = 'none', air = false;
  if (p.kind === 'vault') {
    // подбег-толчок (0–0.3), над препятствием боком с опорой руками (0.3–0.6), соскок (0.6–1)
    if (u < 0.3) { const t = seg(u, 0, 0.3); s = face * ss(t); y = y0 + (top + 0.05 - y0) * Math.sin(t * Math.PI / 2); reach = 'plant'; }
    else if (u < 0.6) { const t = seg(u, 0.3, 0.6); s = face + (p.near + p.thick + 0.15 - face) * t; y = top + 0.05 + Math.sin(t * Math.PI) * 0.1; reach = 'plant'; air = true; }
    else { const t = seg(u, 0.6, 1); s = p.near + p.thick + 0.15 + (far - p.near - p.thick - 0.15) * ss(t); y = top + 0.05 + (p.land.y - top - 0.05) * t * t; air = t < 0.85; }
  } else {
    // к стене (0–0.12), подтянуться (0.12–0.55), закинуть ноги (0.55–0.75), спрыгнуть / встать наверху (0.75–1)
    const ledge = p.kind === 'ledge';
    if (u < 0.12) { s = face * ss(seg(u, 0, 0.12)); y = y0; reach = 'up'; }
    else if (u < 0.55) { const t = seg(u, 0.12, 0.55); s = face; y = y0 + (top - y0) * ss(t); reach = 'up'; air = t > 0.3; }
    else if (u < 0.75) { const t = seg(u, 0.55, 0.75); s = face + ((ledge ? far : over + 0.2) - face) * ss(t); y = top + (ledge ? 0 : Math.sin(t * Math.PI) * 0.08); reach = ledge ? 'none' : 'plant'; air = !ledge; }
    else { const t = seg(u, 0.75, 1); s = ledge ? far : over + 0.2 + (far - over - 0.2) * ss(t); y = ledge ? top + (p.land.y - top) * t : top + (p.land.y - top) * t * t; air = !ledge && t < 0.85; }
  }
  out.set(p.start.x + p.dx * s, y, p.start.z + p.dz * s);
  return { reach, air };
}
