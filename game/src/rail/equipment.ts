import * as THREE from 'three';
import type { RailNet } from './net';
import type { CrossingState, Train } from './sim';
import { timeUniforms } from '../render/time-of-day';

/**
 * Путевое хозяйство (глобальные InstancedMesh, данные — rail/net.json): опоры и консоли контактной сети, жёсткие
 * поперечины, провода (LineSegments: контактный + несущий трос с провесом + струны), переезды (стойки с
 * Андреевским крестом и двумя красными огнями, шлагбаумы — отдельные меши со стрелой на шарнире), светофоры
 * (огонь по свободности пути впереди), упоры.
 */

const WIRE_H = 6.0, MESSENGER_H = 7.3, SAG = 0.9;

function merge(parts: { g: THREE.BufferGeometry; c: number }[]): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], col: number[] = [];
  const c = new THREE.Color();
  for (const { g, c: hex } of parts) {
    const q = g.index ? g.toNonIndexed() : g;
    q.computeVertexNormals();
    const P = q.getAttribute('position'), N = q.getAttribute('normal');
    c.set(hex);
    for (let i = 0; i < P.count; i++) { pos.push(P.getX(i), P.getY(i), P.getZ(i)); nrm.push(N.getX(i), N.getY(i), N.getZ(i)); col.push(c.r, c.g, c.b); }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}
const B = (sx: number, sy: number, sz: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));
  return g;
};
const C = (r0: number, r1: number, h: number, x = 0, y = 0, z = 0, seg = 8, rx = 0, rz = 0) => {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg);
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, rz)), new THREE.Vector3(1, 1, 1)));
  return g;
};

export class RailEquipment {
  readonly root = new THREE.Group();
  private mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.2 });
  private lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  private signalLamps!: THREE.InstancedMesh;
  private crossingLamps!: THREE.InstancedMesh;
  private booms: { pivot: THREE.Object3D; crossing: number }[] = [];
  private lampOf: { crossing: number; side: number }[] = [];
  private col = new THREE.Color();
  private time = 0;
  private sigAcc = 1;

  constructor(scene: THREE.Scene, private net: RailNet) {
    const J = net.json;
    this.buildCatenary();
    // ---------- светофоры
    const sigPole = merge([{ g: C(0.12, 0.1, 4.6, 0, 2.3, 0), c: 0x8a8d8f }, { g: B(0.5, 1.25, 0.32, 0, 4.4, -0.05), c: 0x1a1b1c }, { g: B(0.75, 0.9, 0.04, 0, 4.4, 0.13), c: 0x101010 },
      { g: B(0.3, 0.3, 0.3, 0, 0.15, 0), c: 0x6e7072 }]);
    const poles = this.inst(sigPole, J.signals.length);
    J.signals.forEach((s, i) => poles.setMatrixAt(i, this.trs(s.x, s.y, s.z, s.rotY)));
    this.signalLamps = this.inst(new THREE.SphereGeometry(0.11, 8, 6), J.signals.length, this.lampMat);
    J.signals.forEach((s, i) => this.signalLamps.setMatrixAt(i, this.trs(s.x, s.y + 4.62, s.z, s.rotY, [0, 0, -0.22])));
    this.signalLamps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(J.signals.length * 3), 3);
    // ---------- упоры
    const buf = merge([{ g: B(2.6, 0.25, 0.3, 0, 1.0, 0), c: 0x2b2b2b }, { g: B(0.25, 1.1, 2.2, 0.9, 0.55, 0.6, -0.5), c: 0x3a3a3a }, { g: B(0.25, 1.1, 2.2, -0.9, 0.55, 0.6, -0.5), c: 0x3a3a3a },
      { g: B(1.4, 0.5, 0.06, 0, 1.2, -0.17), c: 0xc8141e }, { g: B(0.4, 0.5, 0.07, 0, 1.2, -0.17), c: 0xf0f0f0 }]);
    const bi = this.inst(buf, J.buffers.length);
    J.buffers.forEach((b, i) => bi.setMatrixAt(i, this.trs(b.x, b.y - 0.2, b.z, b.rotY)));
    // ---------- переезды
    const lightPost = merge([{ g: C(0.09, 0.08, 3.4, 0, 1.7, 0), c: 0xe8e8e8 }, { g: B(0.25, 0.25, 0.25, 0, 0.1, 0), c: 0x777777 },
      { g: B(1.4, 0.22, 0.05, 0, 3.1, 0.02, 0, 0, Math.PI / 4), c: 0xf2f2f2 }, { g: B(1.4, 0.22, 0.05, 0, 3.1, 0.02, 0, 0, -Math.PI / 4), c: 0xf2f2f2 },
      { g: B(1.0, 0.36, 0.08, 0, 2.35, -0.02), c: 0x151515 }, { g: C(0.2, 0.2, 0.25, -0.32, 2.35, -0.14, 10, Math.PI / 2), c: 0x111111 }, { g: C(0.2, 0.2, 0.25, 0.32, 2.35, -0.14, 10, Math.PI / 2), c: 0x111111 }]);
    const barrierPost = merge([{ g: B(0.45, 1.15, 0.45, 0, 0.58, 0), c: 0xd8d8d8 }, { g: B(0.5, 0.18, 0.5, 0, 1.2, 0), c: 0xb71c1c }]);
    const lights = J.crossings.flatMap((c) => c.equipment.filter((e) => e.type === 'light').map((e) => ({ c, e })));
    const barriers = J.crossings.flatMap((c) => c.equipment.filter((e) => e.type === 'barrier').map((e) => ({ c, e })));
    const lp = this.inst(lightPost, lights.length);
    lights.forEach(({ e }, i) => lp.setMatrixAt(i, this.trs(e.x, e.y, e.z, e.rotY)));
    this.crossingLamps = this.inst(new THREE.CircleGeometry(0.13, 12), lights.length * 2, this.lampMat);
    this.crossingLamps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(lights.length * 6), 3);
    lights.forEach(({ c, e }, i) => {
      for (const k of [0, 1]) {
        const m = this.trs(e.x, e.y + 2.35, e.z, e.rotY, [k ? 0.32 : -0.32, 0, -0.27]);
        m.multiply(new THREE.Matrix4().makeRotationY(Math.PI));   // круг лицом к −Z (к машине)
        this.crossingLamps.setMatrixAt(i * 2 + k, m);
        this.lampOf.push({ crossing: c.id, side: k });
      }
    });
    const bp = this.inst(barrierPost, barriers.length);
    barriers.forEach(({ e }, i) => bp.setMatrixAt(i, this.trs(e.x, e.y, e.z, e.rotY)));
    // стрелы: красно-белые полосы по 0.5 м, шарнир на тумбе
    const boomMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
    for (const { c, e } of barriers) {
      const L = e.armLength ?? 4;
      const parts: { g: THREE.BufferGeometry; c: number }[] = [];
      for (let x = 0, k = 0; x < L; x += 0.5, k++) parts.push({ g: B(Math.min(0.5, L - x), 0.1, 0.08, 0.25 + x + Math.min(0.5, L - x) / 2, 0, 0), c: k % 2 ? 0xf2f2f2 : 0xc8141e });
      parts.push({ g: B(0.5, 0.25, 0.25, -0.15, 0, 0), c: 0x333333 });   // противовес
      const mesh = new THREE.Mesh(merge(parts), boomMat);
      mesh.castShadow = true;
      const pivot = new THREE.Object3D();
      pivot.position.set(e.x, e.y + 1.15, e.z);
      // локальная +X стрелы → armDir; поворот вокруг Y
      const ad = e.armDir ?? [1, 0];
      pivot.rotation.order = 'YZX';
      pivot.rotation.y = Math.atan2(-ad[1], ad[0]);
      pivot.add(mesh);
      this.root.add(pivot);
      this.booms.push({ pivot, crossing: c.id });
    }
    for (const im of [poles, this.signalLamps, bi, lp, this.crossingLamps, bp]) { im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); }
    scene.add(this.root);
  }

  private inst(g: THREE.BufferGeometry, n: number, mat: THREE.Material = this.mat): THREE.InstancedMesh {
    const im = new THREE.InstancedMesh(g, mat, Math.max(n, 1));
    im.count = n;
    im.castShadow = mat === this.mat;
    im.receiveShadow = mat === this.mat;
    this.root.add(im);
    return im;
  }

  private trs(x: number, y: number, z: number, rotY: number, local: [number, number, number] = [0, 0, 0], sy = 1): THREE.Matrix4 {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    const off = new THREE.Vector3(...local).applyQuaternion(q);
    return new THREE.Matrix4().compose(new THREE.Vector3(x + off.x, y + off.y, z + off.z), q, new THREE.Vector3(1, sy, 1));
  }

  /** Опоры, консоли, поперечины и провода. */
  private buildCatenary(): void {
    const J = this.net.json;
    const pole = merge([{ g: C(0.2, 0.15, 1, 0, 0.5, 0, 8), c: 0x9b9d9a }]);
    const nP = J.masts.length + J.portals.length * 2;
    const poles = this.inst(pole, nP);
    let k = 0;
    for (const m of J.masts) poles.setMatrixAt(k++, this.trs(m.x, m.y - 0.3, m.z, m.rotY, [0, 0, 0], m.top + 0.3));
    for (const p of J.portals) {
      poles.setMatrixAt(k++, this.trs(p.x1, p.y1 - 0.3, p.z1, 0, [0, 0, 0], p.beam - p.y1 + 0.8));
      poles.setMatrixAt(k++, this.trs(p.x2, p.y2 - 0.3, p.z2, 0, [0, 0, 0], p.beam - p.y2 + 0.8));
    }
    // консоль: горизонтальная тяга к оси пути (−Z) на уровне несущего троса, подкос, фиксатор
    const arm = merge([{ g: C(0.05, 0.05, 3.6, 0, 0, -1.8, 6, Math.PI / 2), c: 0x6b6e70 }, { g: C(0.04, 0.04, 2.6, 0, -0.75, -1.1, 6, Math.PI / 2 - 0.62), c: 0x6b6e70 },
      { g: C(0.03, 0.03, 1.5, 0, -0.75, -3.1, 6), c: 0x6b6e70 }, { g: C(0.07, 0.07, 0.35, 0, -0.25, -3.1, 6), c: 0xc9c2a8 }]);
    const arms = this.inst(arm, J.masts.length);
    J.masts.forEach((m, i) => arms.setMatrixAt(i, this.trs(m.x, m.wire + MESSENGER_H - WIRE_H, m.z, m.rotY)));
    const beam = merge([{ g: B(1, 0.35, 0.35, 0.5, 0, 0), c: 0x7a7d80 }]);
    const beams = this.inst(beam, J.portals.length);
    J.portals.forEach((p, i) => {
      const dx = p.x2 - p.x1, dz = p.z2 - p.z1, L = Math.hypot(dx, dz);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x1, p.beam, p.z1), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-dz, dx)), new THREE.Vector3(L, 1, 1));
      beams.setMatrixAt(i, m);
    });
    for (const im of [poles, arms, beams]) { im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); }
    // провода
    const pos: number[] = [];
    const P = new Float32Array(6);
    for (const S of this.net.segs) {
      if (!S.elec || S.len < 5) continue;
      const sup = [0, ...S.supports.filter((v) => v > 1 && v < S.len - 1), S.len].sort((a, b) => a - b);
      for (let i = 0; i + 1 < sup.length; i++) {
        const a = sup[i], b = sup[i + 1], L = b - a;
        const n = Math.max(1, Math.ceil(L / 8));
        let px = 0, py = 0, pz = 0, mx = 0, my = 0, mz = 0;
        for (let j = 0; j <= n; j++) {
          const s = a + (L * j) / n;
          this.net.pointAt(S.id, s, P);
          const t = j / n, sag = 4 * t * (1 - t) * SAG;
          const cy = P[1] + WIRE_H, my2 = P[1] + MESSENGER_H - sag;
          if (j) {
            pos.push(px, py, pz, P[0], cy, P[2]);
            pos.push(mx, my, mz, P[0], my2, P[2]);
          }
          if (j > 0 && j < n) pos.push(P[0], cy, P[2], P[0], my2, P[2]);   // струна
          px = P[0]; py = cy; pz = P[2]; mx = P[0]; my = my2; mz = P[2];
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2c2f31 }));
    lines.frustumCulled = false;
    this.root.add(lines);
  }

  /** Каждый кадр: мигание огней переездов, стрелы шлагбаумов, светофоры (4 Гц). */
  update(dt: number, crossings: readonly CrossingState[], trains: readonly Train[], flashing: (c: CrossingState) => boolean): void {
    this.time += dt;
    const night = timeUniforms.nightFactor.value;
    const gain = 1.2 + night * 3.0;
    const ph = Math.floor(this.time * 1.8) % 2;   // попеременное мигание ~1 Гц на огонь
    const byId = new Map(crossings.map((c) => [c.def.id, c]));
    this.lampOf.forEach((l, i) => {
      const c = byId.get(l.crossing);
      const on = c && flashing(c) && ph === l.side;
      this.col.setRGB(on ? 1.0 * gain : 0.08, on ? 0.05 * gain : 0.02, on ? 0.03 * gain : 0.02);
      this.crossingLamps.setColorAt(i, this.col);
    });
    if (this.crossingLamps.instanceColor) this.crossingLamps.instanceColor.needsUpdate = true;
    for (const b of this.booms) {
      const c = byId.get(b.crossing);
      const k = c ? c.barrier : 0;
      b.pivot.rotation.z = (1 - k) * (Math.PI / 2 - 0.08);
    }
    this.sigAcc += dt;
    if (this.sigAcc < 0.25) return;
    this.sigAcc = 0;
    // светофоры: красный — поезд в пределах 700 м за сигналом (по направлению) или только что прошёл, жёлтый — до 1500 м
    const J = this.net.json;
    const P = new Float32Array(6);
    J.signals.forEach((s, i) => {
      this.net.pointAt(s.segment, s.s, P);
      const dx = P[3] * s.dir, dz = P[5] * s.dir;
      let best = Infinity;
      for (const t of trains) {
        for (const sv of [t.s, t.tailS]) {
          t.path.at(Math.max(sv, 0), P);
          const ex = P[0] - J.signals[i].x, ez = P[2] - J.signals[i].z;
          const along = ex * dx + ez * dz, lat = Math.abs(-ex * dz + ez * dx);
          if (lat < 25 && along > -5 && along < best) best = along;
        }
      }
      const hex = best < 700 ? [1.6, 0.06, 0.04] : best < 1500 ? [1.5, 1.0, 0.1] : [0.1, 1.3, 0.45];
      this.col.setRGB(hex[0] * (0.7 + night), hex[1] * (0.7 + night), hex[2] * (0.7 + night));
      this.signalLamps.setColorAt(i, this.col);
    });
    if (this.signalLamps.instanceColor) this.signalLamps.instanceColor.needsUpdate = true;
  }
}
