import * as THREE from 'three';
import { CAR_KINDS, trainMaterial, type BogieKind, type CarKind, type CarModel } from './models';
import type { Train } from './sim';

const DRAW_DIST = 900;      // м: дальше вагоны не рисуются (туман 720 м)
const SHADOW_DIST = 160;

/** Поза вагона: центр, базис (right, up, fwd), точки тележек. */
export interface CarPose { x: number; y: number; z: number; fx: number; fy: number; fz: number; b: [number, number, number, number, number, number] }

interface Pool { im: THREE.InstancedMesh; lamp: THREE.InstancedBufferAttribute }

/**
 * Отрисовка поездов: InstancedMesh на тип вагона и на тип тележки (растут удвоением), поза — из двух точек
 * тележек на пути (интерполяция s между шагами физики). aLamp — огни (см. trainMaterial).
 */
export class TrainRenderer {
  readonly root = new THREE.Group();
  readonly stats = { cars: 0, drawn: 0 };
  private pools = new Map<string, Pool>();
  private mat: THREE.MeshStandardMaterial;
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private col = new THREE.Color();
  private P = new Float32Array(6);
  private Q = new Float32Array(6);
  private m = new Float32Array(16);

  constructor(scene: THREE.Scene, cars: Record<CarKind, CarModel>, bogies: Record<BogieKind, THREE.BufferGeometry>, envMap?: THREE.Texture | null) {
    this.mat = trainMaterial(envMap);
    for (const k of CAR_KINDS) this.pool(k, cars[k].geo, 16);
    for (const b of ['b2', 'b3'] as BogieKind[]) this.pool(b, bogies[b], 64);
    scene.add(this.root);
  }

  private pool(key: string, geo: THREE.BufferGeometry, n: number): Pool {
    const old = this.pools.get(key);
    const g = old ? old.im.geometry : geo.clone();
    const lamp = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    lamp.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aLamp', lamp);
    const im = new THREE.InstancedMesh(g, this.mat, n);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.setColorAt(0, new THREE.Color(1, 1, 1));
    im.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.castShadow = true; im.receiveShadow = true;
    im.count = 0;
    im.name = 'rail_' + key;
    if (old) { this.root.remove(old.im); old.im.dispose(); }
    this.root.add(im);
    const p = { im, lamp };
    this.pools.set(key, p);
    return p;
  }

  private slot(key: string): { p: Pool; i: number } {
    let p = this.pools.get(key)!;
    if (p.im.count >= p.im.instanceMatrix.count) {
      const n = p.im.instanceMatrix.count, cnt = p.im.count;
      const mats = (p.im.instanceMatrix.array as Float32Array).slice(0, cnt * 16);
      const cols = (p.im.instanceColor!.array as Float32Array).slice(0, cnt * 3);
      const lamps = (p.lamp.array as Float32Array).slice(0, cnt * 3);
      p = this.pool(key, p.im.geometry, n * 2);
      (p.im.instanceMatrix.array as Float32Array).set(mats);
      (p.im.instanceColor!.array as Float32Array).set(cols);
      (p.lamp.array as Float32Array).set(lamps);
      p.im.count = cnt;
    }
    return { p, i: p.im.count++ };
  }

  /** Поза вагона по s центра (точки тележек на пути). */
  pose(t: Train, sCenter: number, half: number, out: CarPose): void {
    const P = this.P, Q = this.Q;
    t.path.at(sCenter + half, P);
    t.path.at(sCenter - half, Q);
    let fx = P[0] - Q[0], fy = P[1] - Q[1], fz = P[2] - Q[2];
    const l = Math.hypot(fx, fy, fz) || 1;
    fx /= l; fy /= l; fz /= l;
    out.x = (P[0] + Q[0]) / 2; out.y = (P[1] + Q[1]) / 2; out.z = (P[2] + Q[2]) / 2;
    out.fx = fx; out.fy = fy; out.fz = fz;
    out.b[0] = P[0]; out.b[1] = P[1]; out.b[2] = P[2]; out.b[3] = Q[0]; out.b[4] = Q[1]; out.b[5] = Q[2];
  }

  /** Матрица: вперёд модели (−Z) = f (или −f, если flip), без крена. */
  private matrix(x: number, y: number, z: number, fx: number, fy: number, fz: number, flip: boolean): Float32Array {
    const m = this.m;
    if (flip) { fx = -fx; fy = -fy; fz = -fz; }
    let rx = -fz, rz = fx;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
    m[0] = rx; m[1] = 0; m[2] = rz; m[3] = 0;
    m[4] = ux; m[5] = uy; m[6] = uz; m[7] = 0;
    m[8] = -fx; m[9] = -fy; m[10] = -fz; m[11] = 0;
    m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
    return m;
  }

  update(trains: readonly Train[], alpha: number, camera: THREE.Camera, night: number): void {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    for (const p of this.pools.values()) p.im.count = 0;
    const cp = camera.position;
    const pose: CarPose = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, b: [0, 0, 0, 0, 0, 0] };
    let cars = 0, drawn = 0;
    for (const t of trains) {
      const sHead = t.sPrev + (t.s - t.sPrev) * alpha;
      for (const c of t.cars) {
        cars++;
        const sc = sHead - c.off;
        if (sc < 0) continue;
        this.pose(t, sc, c.model.bogieHalf, pose);
        const d = Math.hypot(pose.x - cp.x, pose.z - cp.z);
        if (d > DRAW_DIST) continue;
        this.sphere.center.set(pose.x, pose.y + 2, pose.z); this.sphere.radius = c.model.length / 2 + 2;
        const inView = this.frustum.intersectsSphere(this.sphere);
        if (!inView && d > SHADOW_DIST) continue;
        drawn++;
        const { p, i } = this.slot(c.model.kind);
        p.im.instanceMatrix.array.set(this.matrix(pose.x, pose.y, pose.z, pose.fx, pose.fy, pose.fz, c.flip), i * 16);
        this.col.setHex(c.tint);
        p.im.instanceColor!.setXYZ(i, this.col.r, this.col.g, this.col.b);
        p.lamp.setXYZ(i, c.lamp === 1 ? 1 : 0, c.lamp === 2 ? 1 : 0, c.model.lit ? night : 0);
        // тележки: на своих точках, по касательной пути
        if (d < 400) {
          const bk = c.model.bogie;
          for (let k = 0; k < 2; k++) {
            const ss = sc + (k === 0 ? c.model.bogieHalf : -c.model.bogieHalf);
            t.path.at(ss, this.P);
            const P = this.P;
            const b = this.slot(bk);
            b.p.im.instanceMatrix.array.set(this.matrix(P[0], P[1], P[2], P[3], P[4], P[5], false), b.i * 16);
            b.p.im.instanceColor!.setXYZ(b.i, 1, 1, 1);
            b.p.lamp.setXYZ(b.i, 0, 0, 0);
          }
        }
      }
    }
    for (const p of this.pools.values()) {
      p.im.instanceMatrix.needsUpdate = true;
      p.im.instanceColor!.needsUpdate = true;
      p.lamp.needsUpdate = true;
    }
    this.stats.cars = cars; this.stats.drawn = drawn;
  }
}
