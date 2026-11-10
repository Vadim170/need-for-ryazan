import * as THREE from 'three';
import { KINDS, vehicleMaterial, type VehicleKind, type VehicleModel, type VehicleVariant } from './models';
import { RIM_STYLES, wheelGeometry, type RimStyle } from '../vehicles/procedural';
import { SlotBatch, InstanceData } from '../vehicles/procedural/batch';
import type { SimVehicle } from './sim';
import type { GltfTrafficLayer } from './gltf-models';

const NEAR_LOD = 55;   // м: ближе — полная модель (LOD0) с отдельными колёсами и тенью, дальше — LOD1 (~0.6k треугольников, колёса вмурованы)
const FAR_CULL = 760;

const DIRT = new THREE.Color(0x7a7262);
const MAX_NEAR = 4200, MAX_FAR = 1500;

/**
 * Отрисовка трафика на двух THREE.BatchedMesh (по одной мульти-отрисовке): «ближний» (LOD0 всех вариантов + колёса по стилям диска,
 * отбрасывает тени) и «дальний» (LOD1, по геометрии на группу дальнего LOD; масштаб по габариту варианта). Экземпляры — слоты геометрии
 * (src/vehicles/procedural/batch.ts), пер-экземплярные данные (фары, стоп, поворотник/маячок, ячейка таблички маршрута) — в DataTexture по instanceId.
 * Матрицы считаются вручную из позы (интерполяция между шагами симуляции), отсечение по фрустуму поштучно.
 */
export class TrafficRenderer {
  readonly root = new THREE.Group();
  readonly stats = { drawn: 0, near: 0 };
  headlights = 0;
  /** Дальность ближнего LOD (м); отладка: `__game.trafficSystem.renderer.nearLod = 500`. */
  nearLod = NEAR_LOD;
  /** glTF-модели (gltf-models.ts): виды, для которых есть модели, рисует этот слой; остальные — процедурные. */
  gltf: GltfTrafficLayer | null = null;
  /** Ячейка атласа таблички маршрута для машины ОТ (routeBoards.cell); по умолчанию — пустая. */
  routeCell: (v: SimVehicle) => number = () => 0;
  /** Для маршруток вне маршрута (случайная ГАЗель): набор ячеек по хэшу. */
  fakeCells: number[] = [];
  private nearB: SlotBatch; private farB: SlotBatch;
  private nearD: InstanceData; private farD: InstanceData;
  private nearGeo = new Map<VehicleVariant, number>();
  private wheelGeo = new Map<RimStyle, number>();
  private farGeo = new Map<string, { g: number; ref: VehicleVariant }>();
  private kindVariants = new Map<VehicleKind, { list: VehicleVariant[]; cum: number[]; total: number }>();
  private used: { near: number[]; wheels: number[]; far: number[] };
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private col = new THREE.Color();
  private m = new Float32Array(16);
  private mb = new Float32Array(16);
  private bf = new Float32Array(16);

  constructor(scene: THREE.Scene, private models: Record<VehicleKind, VehicleModel>, _cap: number, envMap?: THREE.Texture | null) {
    this.nearD = new InstanceData(MAX_NEAR + 64); this.farD = new InstanceData(MAX_FAR + 64);
    const nearGeos: THREE.BufferGeometry[] = [], farGeos: THREE.BufferGeometry[] = [];
    for (const k of KINDS) {
      const md = models[k];
      const list = md.variants;
      const cum: number[] = [];
      let total = 0;
      for (const v of list) { total += v.weight; cum.push(total); }
      this.kindVariants.set(k, { list, cum, total });
      for (const vr of list) {
        this.nearGeo.set(vr, nearGeos.length); nearGeos.push(vr.near);
        if (!this.farGeo.has(vr.farGroup)) { this.farGeo.set(vr.farGroup, { g: farGeos.length, ref: vr }); farGeos.push(vr.far); }
      }
    }
    for (const style of RIM_STYLES) {
      if (![...this.nearGeo.keys()].some((v) => v.rim === style)) continue;
      this.wheelGeo.set(style, nearGeos.length); nearGeos.push(wheelGeometry(style));
    }
    this.nearB = new SlotBatch(vehicleMaterial(envMap, this.nearD.tex), nearGeos, MAX_NEAR);
    this.farB = new SlotBatch(vehicleMaterial(envMap, this.farD.tex), farGeos, MAX_FAR);
    this.nearB.mesh.castShadow = true; this.nearB.mesh.receiveShadow = true;
    this.farB.mesh.receiveShadow = true;
    this.root.add(this.nearB.mesh, this.farB.mesh);
    this.used = { near: new Array(nearGeos.length).fill(0), wheels: [], far: new Array(farGeos.length).fill(0) };
    scene.add(this.root);
  }

  /** Каким вариантом нарисована машина (GTA-режим: угнанная машина трафика выглядит так же). */
  variantFor(v: SimVehicle): VehicleVariant { return this.pick(v); }

  private pick(v: SimVehicle): VehicleVariant {
    const k = this.kindVariants.get(v.kind)!;
    if (k.list.length === 1) return k.list[0];
    let list = k.list, cum = k.cum, total = k.total;
    if (v.kind === 'gazelle') {
      // на маршруте — маршрутка; вне маршрута — чаще фургон, иногда скорая и маршрутка
      const wt = v.route >= 0 ? [1, 0, 0] : [0.35, 0.5, 0.15];
      cum = []; total = 0;
      for (let i = 0; i < list.length; i++) { total += wt[i] ?? 0; cum.push(total); }
    }
    const h = ((Math.imul(v.id, 2654435761) >>> 0) / 4294967296) * total;
    for (let i = 0; i < cum.length; i++) if (h < cum[i]) return list[i];
    return list[list.length - 1];
  }

  update(vehicles: readonly SimVehicle[], alpha: number, camera: THREE.Camera, dt: number): void {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const cp = camera.position;
    this.used.near.fill(0); this.used.far.fill(0);
    this.gltf?.begin();
    let drawn = 0, near = 0, nearInst = 0, farInst = 0;
    const m = this.m;
    const nu = this.used.near, fu = this.used.far;
    for (const v of vehicles) {
      const md = this.models[v.kind];
      v.spin += (v.v * dt) / md.wheelRadius;
      // поза: интерполяция
      const x = v.ox + (v.x - v.ox) * alpha, y = v.oy + (v.y - v.oy) * alpha, z = v.oz + (v.z - v.oz) * alpha;
      const d = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
      if (d > FAR_CULL) continue;
      this.sphere.center.set(x, y + md.height / 2, z); this.sphere.radius = md.length / 2 + 0.5;
      if (!this.frustum.intersectsSphere(this.sphere)) {
        // вне кадра, но может отбрасывать тень в кадр: ближние оставляем
        if (d > 30) continue;
      }
      if (v.crashed) {
        const { qx, qy, qz, qw } = v;
        const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
        const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2;
        m[0] = 1 - (yy + zz); m[1] = xy + wz; m[2] = xz - wy; m[3] = 0;
        m[4] = xy - wz; m[5] = 1 - (xx + zz); m[6] = yz + wx; m[7] = 0;
        m[8] = xz + wy; m[9] = yz - wx; m[10] = 1 - (xx + yy); m[11] = 0;
      } else {
        let fx = v.ofx + (v.fx - v.ofx) * alpha, fy = v.ofy + (v.fy - v.ofy) * alpha, fz = v.ofz + (v.fz - v.ofz) * alpha;
        const l = Math.hypot(fx, fy, fz) || 1;
        fx /= l; fy /= l; fz /= l;
        // right = f × up
        let rx = -fz, ry = 0, rz = fx;
        const rl = Math.hypot(rx, rz) || 1;
        rx /= rl; rz /= rl;
        // up' = right × f
        let ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
        // крен дороги (поперечный уклон) вокруг оси вперёд: + правый борт вниз
        const q = v.rollRoad;
        if (q !== 0) {
          const c = Math.cos(q), s = Math.sin(q);
          const nrx = rx * c - ux * s, nry = ry * c - uy * s, nrz = rz * c - uz * s;
          ux = ux * c + rx * s; uy = uy * c + ry * s; uz = uz * c + rz * s;
          rx = nrx; ry = nry; rz = nrz;
        }
        m[0] = rx; m[1] = ry; m[2] = rz; m[3] = 0;
        m[4] = ux; m[5] = uy; m[6] = uz; m[7] = 0;
        m[8] = -fx; m[9] = -fy; m[10] = -fz; m[11] = 0;
      }
      m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
      // кузов: динамические тангаж/крен (пружина подвески) вокруг точки на высоте осей; колёса остаются по дороге
      const B = this.mb;
      B.set(m);
      if (!v.crashed && (v.pitchDyn !== 0 || v.rollDyn !== 0)) {
        const p = v.pitchDyn, r = v.rollDyn, hp = md.wheelRadius;
        let Rx = m[0], Ry = m[1], Rz = m[2], Ux = m[4], Uy = m[5], Uz = m[6], Fx = -m[8], Fy = -m[9], Fz = -m[10];
        // тангаж вокруг right: + нос вверх
        let c = Math.cos(p), s = Math.sin(p);
        const nFx = Fx * c + Ux * s, nFy = Fy * c + Uy * s, nFz = Fz * c + Uz * s;
        Ux = Ux * c - Fx * s; Uy = Uy * c - Fy * s; Uz = Uz * c - Fz * s;
        Fx = nFx; Fy = nFy; Fz = nFz;
        // крен вокруг forward: + правый борт вниз
        c = Math.cos(r); s = Math.sin(r);
        const nRx = Rx * c - Ux * s, nRy = Ry * c - Uy * s, nRz = Rz * c - Uz * s;
        Ux = Ux * c + Rx * s; Uy = Uy * c + Ry * s; Uz = Uz * c + Rz * s;
        Rx = nRx; Ry = nRy; Rz = nRz;
        B[0] = Rx; B[1] = Ry; B[2] = Rz; B[4] = Ux; B[5] = Uy; B[6] = Uz; B[8] = -Fx; B[9] = -Fy; B[10] = -Fz;
        // поворот вокруг точки (0, hp, 0): t = p0 + U0·hp − U1·hp
        B[12] = m[12] + (m[4] - Ux) * hp; B[13] = m[13] + (m[5] - Uy) * hp; B[14] = m[14] + (m[6] - Uz) * hp;
      }
      if (this.gltf?.has(v.kind)) {
        const nr = d < this.nearLod;
        if (this.gltf.push(v, m, B, nr, nr, this.headlights, md.wheelRadius)) { drawn++; if (nr) near++; }
        continue;
      }
      const vr = this.pick(v);
      const isNear = d < this.nearLod;
      // цвет: фиксированный у варианта (скорая) или от симуляции; грязные — к серо-коричневому
      this.col.setHex(vr.fixedPaint ?? v.color);
      const hh = ((Math.imul(v.id ^ 0x5bd1e995, 2246822519) >>> 0) / 4294967296);
      if (hh < 0.24 && vr.fixedPaint === undefined) this.col.lerp(DIRT, 0.14 + hh * 0.5);
      const lampZ = v.beacon || (vr.id === 'gazelle_ambulance' && v.id % 3 === 0) ? 3 : v.ind;
      const cell = vr.route ? (v.route >= 0 ? this.routeCell(v) : this.fakeCells.length ? this.fakeCells[v.id % this.fakeCells.length] : 0) : 0;
      const lampX = this.headlights, lampY = v.brake ? 1 : 0;
      if (isNear) {
        const g = this.nearGeo.get(vr)!;
        const i = nu[g];
        if (nearInst > MAX_NEAR - 10) continue;
        nearInst += 5;
        const id = this.nearB.set(g, i, B, 0, this.col.r, this.col.g, this.col.b);
        nu[g] = i + 1;
        this.nearD.set(id, lampX, lampY, lampZ, cell);
        drawn++; near++;
        // колёса: на вариант свой радиус/ширина/позиции, стиль диска — своя геометрия батча; левые — Ry(π)
        const wg = this.wheelGeo.get(vr.rim)!;
        const r = vr.wheelRadius, w = vr.wheelWidth;
        const sp = v.spin * (md.wheelRadius / r);
        const c = Math.cos(sp), s = Math.sin(sp);
        const sc = Math.cos(v.steer), ss = Math.sin(v.steer);
        const zmid = (vr.wheels[0][2] + vr.wheels[2][2]) / 2;
        const A = this.bf;
        for (const [wx, wy, wz] of vr.wheels) {
          let X0 = m[0], X1 = m[1], X2 = m[2], Z0 = m[8], Z1 = m[9], Z2 = m[10];
          if (wz < zmid && !v.crashed) {
            const nX0 = X0 * sc - Z0 * ss, nX1 = X1 * sc - Z1 * ss, nX2 = X2 * sc - Z2 * ss;
            Z0 = X0 * ss + Z0 * sc; Z1 = X1 * ss + Z1 * sc; Z2 = X2 * ss + Z2 * sc;
            X0 = nX0; X1 = nX1; X2 = nX2;
          }
          let sx = s;
          if (wx < 0) { X0 = -X0; X1 = -X1; X2 = -X2; Z0 = -Z0; Z1 = -Z1; Z2 = -Z2; sx = -s; }
          A[0] = X0 * w; A[1] = X1 * w; A[2] = X2 * w; A[3] = 0;
          A[4] = (m[4] * c + Z0 * sx) * r; A[5] = (m[5] * c + Z1 * sx) * r; A[6] = (m[6] * c + Z2 * sx) * r; A[7] = 0;
          A[8] = (-m[4] * sx + Z0 * c) * r; A[9] = (-m[5] * sx + Z1 * c) * r; A[10] = (-m[6] * sx + Z2 * c) * r; A[11] = 0;
          A[12] = m[0] * wx + m[4] * wy + m[8] * wz + m[12];
          A[13] = m[1] * wx + m[5] * wy + m[9] * wz + m[13];
          A[14] = m[2] * wx + m[6] * wy + m[10] * wz + m[14];
          A[15] = 1;
          const wi = nu[wg];
          const wid = this.nearB.set(wg, wi, A, 0, 1, 1, 1);
          nu[wg] = wi + 1;
          this.nearD.set(wid, 0, 0, 0, 0);
        }
      } else {
        if (farInst > MAX_FAR - 4) continue;
        farInst++;
        const fg = this.farGeo.get(vr.farGroup)!;
        let M = B;
        if (fg.ref !== vr) {
          // общий дальний меш группы: масштаб по габариту варианта
          const sx = vr.width / fg.ref.width, sy = vr.height / fg.ref.height, sz = vr.length / fg.ref.length;
          M = this.bf; M.set(B);
          M[0] *= sx; M[1] *= sx; M[2] *= sx; M[4] *= sy; M[5] *= sy; M[6] *= sy; M[8] *= sz; M[9] *= sz; M[10] *= sz;
        }
        const i = fu[fg.g];
        const id = this.farB.set(fg.g, i, M, 0, this.col.r, this.col.g, this.col.b);
        fu[fg.g] = i + 1;
        this.farD.set(id, lampX, lampY, lampZ, cell);
        drawn++;
      }
    }
    for (let g = 0; g < nu.length; g++) this.nearB.commit(g, nu[g]);
    for (let g = 0; g < fu.length; g++) this.farB.commit(g, fu[g]);
    this.nearD.tex.needsUpdate = true; this.farD.tex.needsUpdate = true;
    this.gltf?.end();
    this.stats.drawn = drawn; this.stats.near = near;
  }
}
