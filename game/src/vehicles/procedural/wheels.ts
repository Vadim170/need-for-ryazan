import * as THREE from 'three';
import { MeshBuilder, PART, lin, type V3 } from './mesh';

/**
 * Колёса: единичное колесо вдоль оси X (радиус 1, ширина 1, наружу +X; левые колёса — поворот на π вокруг Y).
 * Шина с боковиной и протектором + диск одного из стилей (спицы геометрией — видно вращение).
 */
export type RimStyle = 'steel' | 'steelcap' | 'alloy5' | 'alloy10' | 'turbine' | 'bus';
export const RIM_STYLES: RimStyle[] = ['steel', 'steelcap', 'alloy5', 'alloy10', 'turbine', 'bus'];

const TIRE = 0x151515, BARREL = 0x4a4d52, BRAKE = 0x1b1c1f;

function lathe(b: MeshBuilder, prof: [number, number][], segs: number, color: number): void {
  const nrm: [number, number][] = prof.map(() => [0, 0]);
  for (let i = 0; i < prof.length - 1; i++) {
    const dx = prof[i + 1][0] - prof[i][0], dr = prof[i + 1][1] - prof[i][1];
    // нормаль наружу для обхода «от −X к +X» вокруг оси: (−dr, dx) нормирован
    const l = Math.hypot(dx, dr) || 1;
    const n: [number, number] = [-dr / l, dx / l];
    for (const j of [i, i + 1]) { nrm[j][0] += n[0]; nrm[j][1] += n[1]; }
  }
  for (const n of nrm) { const l = Math.hypot(n[0], n[1]) || 1; n[0] /= l; n[1] /= l; }
  for (let i = 0; i < prof.length - 1; i++) {
    b.patch(segs, 1, (u, v) => {
      const a = u * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const x = prof[i][0] + (prof[i + 1][0] - prof[i][0]) * v, r = prof[i][1] + (prof[i + 1][1] - prof[i][1]) * v;
      const nx = nrm[i][0] + (nrm[i + 1][0] - nrm[i][0]) * v, nr = nrm[i][1] + (nrm[i + 1][1] - nrm[i][1]) * v;
      return { p: [x, r * ca, r * sa], n: [nx, nr * ca, nr * sa] };
    }, color, PART.fixed);
  }
}

/** Диск (кольцо r0..r1) в плоскости x = const, лицом +X. */
function disc(b: MeshBuilder, x: number, r0: number, r1: number, color: number, segs: number, part: number = PART.fixed): void {
  b.patch(segs, 1, (u, v) => {
    const a = u * Math.PI * 2, r = r0 + (r1 - r0) * v;
    return { p: [x, r * Math.cos(a), r * Math.sin(a)], n: [1, 0, 0] };
  }, color, part);
}

/** Спица: трапеция от радиуса r0 (ширина w0) до r1 (ширина w1) под углом a. */
function spoke(b: MeshBuilder, x: number, a: number, r0: number, r1: number, w0: number, w1: number, color: number, part: number = PART.fixed): void {
  const dy = Math.cos(a), dz = Math.sin(a), py = -dz, pz = dy;
  const P = (r: number, w: number): V3 => [x, dy * r + py * w, dz * r + pz * w];
  const p00 = P(r0, -w0 / 2), p01 = P(r0, w0 / 2), p10 = P(r1, -w1 / 2), p11 = P(r1, w1 / 2);
  b.patch(1, 1, (u, v) => {
    const lo = [p00[0] + (p01[0] - p00[0]) * u, p00[1] + (p01[1] - p00[1]) * u, p00[2] + (p01[2] - p00[2]) * u];
    const hi = [p10[0] + (p11[0] - p10[0]) * u, p10[1] + (p11[1] - p10[1]) * u, p10[2] + (p11[2] - p10[2]) * u];
    return { p: [lo[0] + (hi[0] - lo[0]) * v, lo[1] + (hi[1] - lo[1]) * v, lo[2] + (hi[2] - lo[2]) * v], n: [1, 0, 0] };
  }, color, part);
}

export function buildWheelGeometry(style: RimStyle, lod: 0 | 1 | 2 = 0): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const segs = lod === 0 ? 18 : lod === 2 ? 12 : 7;
  const prof: [number, number][] = lod !== 1
    ? [[-0.46, 0.68], [-0.5, 0.78], [-0.48, 0.92], [-0.38, 1.0], [0.38, 1.0], [0.48, 0.92], [0.5, 0.78], [0.46, 0.68]]
    : [[-0.5, 0.7], [-0.4, 1.0], [0.4, 1.0], [0.5, 0.7]];
  lathe(b, prof, segs, TIRE);
  if (lod === 1) { disc(b, 0.46, 0, 0.7, 0x8c9096, segs); return b.build(); }
  if (lod === 2) {
    const face = style === 'steel' || style === 'steelcap' ? 0x6b6f75 : style === 'bus' ? 0xcfcfc8 : 0xa9adb3;
    disc(b, 0.42, 0, 0.62, face, segs);
    disc(b, 0.428, 0.3, 0.52, 0x24262a, segs);
    disc(b, 0.436, 0, 0.16, 0x8f939a, segs);
    return b.build();
  }
  // бочка диска и тормозной щит
  lathe(b, [[0.46, 0.68], [0.40, 0.62], [0.28, 0.6]], segs, BARREL);
  disc(b, 0.28, 0, 0.6, BRAKE, segs);
  const X = 0.42;
  const sil = 0xb9bdc3;
  switch (style) {
    case 'steel': {
      disc(b, X, 0, 0.62, 0x8b8f95, segs);
      for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.4; b.patch(6, 1, (u, v) => { const t = u * Math.PI * 2, r = 0.12 * v; return { p: [X + 0.004, 0.42 * Math.cos(a) + r * Math.cos(t), 0.42 * Math.sin(a) + r * Math.sin(t)], n: [1, 0, 0] }; }, 0x101113, PART.fixed); }
      disc(b, X + 0.006, 0, 0.14, 0xaeb2b8, 10);
      break;
    }
    case 'steelcap': {
      disc(b, X, 0, 0.62, 0x2d3034, segs);
      for (let i = 0; i < 5; i++) spoke(b, X + 0.004, (i / 5) * Math.PI * 2, 0.1, 0.56, 0.12, 0.1, 0x6b7077);
      disc(b, X + 0.008, 0, 0.14, 0x8d9197, 10);
      break;
    }
    case 'alloy5': {
      disc(b, X - 0.02, 0.5, 0.64, sil, segs);
      for (let i = 0; i < 5; i++) spoke(b, X, (i / 5) * Math.PI * 2, 0.1, 0.56, 0.24, 0.17, sil);
      disc(b, X + 0.004, 0, 0.16, 0x9a9ea5, 10);
      break;
    }
    case 'alloy10': {
      disc(b, X - 0.02, 0.52, 0.64, sil, segs);
      for (let i = 0; i < 10; i++) spoke(b, X, (i / 10) * Math.PI * 2, 0.1, 0.56, 0.11, 0.075, sil);
      disc(b, X + 0.004, 0, 0.16, 0x8f939a, 10);
      break;
    }
    case 'turbine': {
      disc(b, X - 0.02, 0.5, 0.64, 0x8e9299, segs);
      for (let i = 0; i < 5; i++) for (const d of [-0.14, 0.14]) spoke(b, X, (i / 5) * Math.PI * 2 + d, 0.12, 0.56, 0.1, 0.1, 0x8e9299);
      disc(b, X + 0.004, 0, 0.15, 0x6f737a, 10);
      break;
    }
    case 'bus': {
      disc(b, X, 0, 0.64, 0xcfcfc8, segs);
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; b.patch(6, 1, (u, v) => { const t = u * Math.PI * 2, r = 0.1 * v; return { p: [X + 0.004, 0.4 * Math.cos(a) + r * Math.cos(t), 0.4 * Math.sin(a) + r * Math.sin(t)], n: [1, 0, 0] }; }, 0x202226, PART.fixed); }
      disc(b, X + 0.006, 0, 0.2, 0x8a8c90, 10);
      break;
    }
  }
  void lin;
  return b.build();
}

/** Колесо трафика по умолчанию (совместимость: buildWheel() из traffic/models.ts). */
export function buildWheel(): THREE.BufferGeometry { return buildWheelGeometry('alloy5', 0); }
