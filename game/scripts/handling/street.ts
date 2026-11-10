/**
 * Стенд управляемости на реальных улицах (браузер, реальный мир /world/): робот-водитель едет по дороге из roads/graph.json
 * (цепочка рёбер с одним названием) на высокой скорости и пишет крен, перегрузку, отрывы колёс, опрокидывания, уход с линии.
 *
 *   const m = await import('/scripts/handling/street.ts');
 *   await m.runStreet(window.__game, 'Солотчинское шоссе', { kmh: 140 });
 *   await m.runStreet(window.__game, 'Северная окружная дорога', { kmh: 160, latG: 1.3 });
 *
 * Физика шагается напрямую (physics.update) без рендера; тайлы мира подгружаются по ходу (city.preload).
 */
import * as THREE from 'three';
import type { Vehicle } from '../../src/vehicle/vehicle';
import type { CityWorld } from '../../src/world/city-world';
import type { PhysicsWorld } from '../../src/physics/world';

interface Game { car: Vehicle; physics: PhysicsWorld; city: CityWorld | null; gta?: { player?: { car?: { vehicle: Vehicle } } } | null }

const DT = 1 / 60, G = 9.81;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Самая длинная цепочка рёбер с названием name (жадно от конечного узла). Точки — в координатах three.js. */
export function roadPolyline(city: CityWorld, name: string): THREE.Vector3[] {
  const edges = city.graph.edges.filter((e) => e.name === name);
  if (!edges.length) throw new Error(`дорога «${name}» не найдена`);
  const adj = new Map<number, typeof edges>();
  for (const e of edges) for (const n of [e.from, e.to]) { if (!adj.has(n)) adj.set(n, []); adj.get(n)!.push(e); }
  let best: THREE.Vector3[] = [];
  const starts = [...adj.entries()].filter(([, es]) => es.length === 1).map(([n]) => n);
  for (const s of starts.length ? starts : [edges[0].from]) {
    const used = new Set<number>(); const pts: THREE.Vector3[] = []; let node = s;
    for (;;) {
      const e = (adj.get(node) ?? []).find((x) => !used.has(x.id));
      if (!e) break;
      used.add(e.id);
      const p = e.from === node ? e.points : [...e.points].reverse();
      for (const q of p) pts.push(new THREE.Vector3(q[0], q[1], q[2]));
      node = e.from === node ? e.to : e.from;
    }
    let len = 0; for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
    let bl = 0; for (let i = 1; i < best.length; i++) bl += best[i].distanceTo(best[i - 1]);
    if (len > bl) best = pts;
  }
  // равномерно через 2 м
  const out: THREE.Vector3[] = [best[0].clone()];
  let acc = 0;
  for (let i = 1; i < best.length; i++) {
    const a = best[i - 1], b = best[i], d = a.distanceTo(b);
    let t = 2 - acc;
    while (t <= d) { out.push(a.clone().lerp(b, t / d)); t += 2; }
    acc = (acc + d) % 2;
  }
  return out;
}

export interface StreetResult {
  road: string; length: number; driven: number; avgKmh: number; maxKmh: number;
  rollovers: number; maxRollDeg: number; maxLatG: number; airFrames: number; wheelLiftFrames: number; maxLineDev: number; resets: number; maxLatGAt: number; maxRollAt: number;
}

export async function runStreet(game: Game, road: string, opts: { kmh?: number; latG?: number; maxMeters?: number; reverse?: boolean } = {}): Promise<StreetResult> {
  const city = game.city;
  if (!city) throw new Error('нужен реальный мир (без ?world=test)');
  const car = game.gta?.player?.car?.vehicle ?? game.car;
  let path = roadPolyline(city, road);
  if (opts.reverse) path = path.reverse();
  const kmh = opts.kmh ?? 140, latG = opts.latG ?? 1.25, maxM = opts.maxMeters ?? 4000;
  const n = path.length;
  // кривизна по трём точкам через ±10 м
  const curv = path.map((_, i) => {
    const a = path[Math.max(0, i - 5)], b = path[i], c = path[Math.min(n - 1, i + 5)];
    const ab = a.distanceTo(b), bc = b.distanceTo(c), ca = c.distanceTo(a);
    const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    return ab * bc * ca > 1e-6 ? (2 * area2) / (ab * bc * ca) : 0;
  });
  // допустимая скорость: по кривизне впереди (до 120 м) с торможением 0.8 g
  const vMax = path.map((_, i) => {
    let v = kmh / 3.6;
    for (let k = i; k < Math.min(n, i + 60); k++) {
      const vc = Math.sqrt((latG * G) / Math.max(curv[k], 1e-4));
      const d = (k - i) * 2;
      v = Math.min(v, Math.sqrt(vc * vc + 2 * 0.8 * G * d));
    }
    return v;
  });
  // высота старта: точка графа (на мостах — настил), не ниже рельефа
  const groundY = (p: THREE.Vector3) => Math.max(p.y, city.heightAt(p.x, p.z));
  const p0 = path[0], p1 = path[3];
  const yaw = Math.atan2(-(p1.x - p0.x), -(p1.z - p0.z));
  await city.preload(p0, 250);
  car.reset(new THREE.Vector3(p0.x, groundY(p0) + 0.9, p0.z), yaw);
  const step = (inp: Partial<typeof car.input>) => { Object.assign(car.input, { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false }, inp); game.physics.update(DT + 1e-9); };
  for (let i = 0; i < 40; i++) step({});
  const q = new THREE.Quaternion(), fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), prevV = new THREE.Vector3();
  const r0 = car.body.rotation(); q.set(r0.x, r0.y, r0.z, r0.w); fwd.set(0, 0, -1).applyQuaternion(q);
  const v0 = Math.min(kmh / 3.6, vMax[0]);
  car.body.setLinvel({ x: fwd.x * v0, y: 0, z: fwd.z * v0 }, true);
  prevV.set(fwd.x * v0, 0, fwd.z * v0);
  let idx = 0, yawI = 0, lat = 0, steps = 0, sumV = 0;
  const res: StreetResult = { road, length: n * 2, driven: 0, avgKmh: 0, maxKmh: 0, rollovers: 0, maxRollDeg: 0, maxLatG: 0, airFrames: 0, wheelLiftFrames: 0, maxLineDev: 0, resets: 0, maxLatGAt: 0, maxRollAt: 0 };
  let lastPre = car.body.translation();
  while (idx < n - 15 && idx * 2 < maxM && steps < 60 * 240) {
    const t = car.body.translation(), r = car.body.rotation(), lv = car.body.linvel(), av = car.body.angvel();
    q.set(r.x, r.y, r.z, r.w);
    fwd.set(0, 0, -1).applyQuaternion(q); right.set(1, 0, 0).applyQuaternion(q); up.set(0, 1, 0).applyQuaternion(q);
    // ближайшая точка пути (вперёд)
    let bd = Infinity;
    for (let k = idx; k < Math.min(n, idx + 40); k++) { const d = (path[k].x - t.x) ** 2 + (path[k].z - t.z) ** 2; if (d < bd) { bd = d; idx = k; } }
    res.maxLineDev = Math.max(res.maxLineDev, Math.sqrt(bd));
    const v = Math.hypot(lv.x, lv.z);
    const L = clamp(0.3 * v + 4, 6, 35);
    const tp = path[Math.min(n - 1, idx + Math.round(L / 2))];
    const heading = Math.atan2(fwd.x, -fwd.z);
    let al = Math.atan2(tp.x - t.x, -(tp.z - t.z)) - heading; al = Math.atan2(Math.sin(al), Math.cos(al));
    const yr = -(av.x * up.x + av.y * up.y + av.z * up.z);
    const rDes = (2 * Math.max(v, 3) * Math.sin(al)) / L;
    yawI = clamp(yawI + (rDes - yr) * DT * 2.5, -0.6, 0.6);
    const steer = clamp(Math.sin(al) * 2 + (rDes - yr) * 0.6 + yawI, -1, 1);
    const vF = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z, e = vMax[idx] - vF;
    step({ steer, throttle: clamp(0.35 + e * 0.5, 0, 1), brake: e < -1.5 ? clamp(-e * 0.25, 0, 1) : 0 });
    steps++;
    sumV += v;
    res.maxKmh = Math.max(res.maxKmh, v * 3.6);
    const a = new THREE.Vector3(lv.x, lv.y, lv.z).sub(prevV).divideScalar(DT); prevV.set(lv.x, lv.y, lv.z);
    lat += ((a.dot(right) / G) - lat) * (1 - Math.exp(-DT / 0.08));
    if (Math.abs(lat) > res.maxLatG) { res.maxLatG = Math.abs(lat); res.maxLatGAt = idx * 2; }
    const rollD = Math.abs((car.telemetry?.roll ?? Math.asin(clamp(right.y, -1, 1))) * 180 / Math.PI);
    if (rollD > res.maxRollDeg) { res.maxRollDeg = rollD; res.maxRollAt = idx * 2; }
    if (car.groundedWheels === 0) res.airFrames++;
    if (car.groundedWheels > 0 && car.groundedWheels < 4) res.wheelLiftFrames++;
    if (up.y < 0.3) {
      res.rollovers++;
      // поставить обратно на дорогу и продолжить
      const p = path[Math.min(n - 1, idx + 5)], pn = path[Math.min(n - 1, idx + 8)];
      car.reset(new THREE.Vector3(p.x, groundY(p) + 0.9, p.z), Math.atan2(-(pn.x - p.x), -(pn.z - p.z)));
      res.resets++;
    }
    // подгрузка тайлов каждые ~120 м
    if ((t.x - lastPre.x) ** 2 + (t.z - lastPre.z) ** 2 > 120 * 120) { lastPre = t; city.update(new THREE.Vector3(t.x, t.y, t.z), 0.016); await city.preload(new THREE.Vector3(t.x, t.y, t.z), 200); }
  }
  res.driven = idx * 2;
  res.avgKmh = Math.round((sumV / Math.max(1, steps)) * 3.6);
  res.maxKmh = Math.round(res.maxKmh);
  res.maxRollDeg = Math.round(res.maxRollDeg * 10) / 10;
  res.maxLatG = Math.round(res.maxLatG * 100) / 100;
  res.maxLineDev = Math.round(res.maxLineDev * 10) / 10;
  for (const k of ['throttle', 'brake', 'steer'] as const) car.input[k] = 0;
  return res;
}
