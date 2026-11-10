import * as THREE from 'three';
import { timeUniforms } from '../render/time-of-day';

/**
 * Процедурные low-poly модели подвижного состава (одна геометрия на тип вагона, инстансинг).
 * Система координат модели: вперёд −Z, вверх +Y, начало — центр вагона на уровне головки рельса (y = 0).
 * Атрибуты: position, normal, color (линейный RGB), aPart (см. PART). PART.paint тонируется цветом инстанса
 * (ливрея/цвет вагона). Пер-инстансный aLamp = (прожектор и буферные фонари спереди, красные хвостовые сигналы,
 * свет в салоне) — материал trainMaterial(), ночь — timeUniforms.nightFactor.
 */
export const PART = { paint: 0, fixed: 1, head: 2, marker: 3, glass: 4, cab: 5, metal: 6 } as const;

export type CarKind = 'emu_head' | 'emu_motor' | 'emu_trailer' | 'loco_pass' | 'coach' | 'loco_freight' | 'tank' | 'gondola' | 'boxcar';
export const CAR_KINDS: CarKind[] = ['emu_head', 'emu_motor', 'emu_trailer', 'loco_pass', 'coach', 'loco_freight', 'tank', 'gondola', 'boxcar'];
export type BogieKind = 'b2' | 'b3';

export interface CarModel {
  kind: CarKind;
  geo: THREE.BufferGeometry;
  /** Длина по сцепкам, ширина, высота кузова, м. */
  length: number; width: number; height: number;
  /** Половина базы (расстояние от центра до шкворня тележки). */
  bogieHalf: number;
  bogie: BogieKind;
  mass: number;
  /** Пассажирский салон (окна светятся ночью). */
  lit: boolean;
}

class Builder {
  private pos: number[] = []; private nrm: number[] = []; private col: number[] = []; private part: number[] = [];
  private m = new THREE.Matrix4(); private nm = new THREE.Matrix3();
  private q = new THREE.Quaternion(); private e = new THREE.Euler(); private v = new THREE.Vector3(); private c = new THREE.Color();
  add(geo: THREE.BufferGeometry, color: number, part: number = PART.fixed, p: [number, number, number] = [0, 0, 0], r: [number, number, number] = [0, 0, 0]): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.computeVertexNormals();
    this.m.compose(this.v.set(...p), this.q.setFromEuler(this.e.set(...r)), new THREE.Vector3(1, 1, 1));
    this.nm.getNormalMatrix(this.m);
    const P = g.getAttribute('position'), N = g.getAttribute('normal');
    this.c.set(color);
    const v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(this.m); this.pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(N, i).applyMatrix3(this.nm).normalize(); this.nrm.push(v.x, v.y, v.z);
      this.col.push(this.c.r, this.c.g, this.c.b); this.part.push(part);
    }
    if (g !== geo) g.dispose();
    geo.dispose();
    return this;
  }
  box(sx: number, sy: number, sz: number, color: number, part: number, p: [number, number, number], r?: [number, number, number]): this {
    return this.add(new THREE.BoxGeometry(sx, sy, sz), color, part, p, r);
  }
  cyl(rad: number, len: number, color: number, part: number, p: [number, number, number], axis: 'x' | 'y' | 'z' = 'y', seg = 10): this {
    const r: [number, number, number] = axis === 'x' ? [0, 0, Math.PI / 2] : axis === 'z' ? [Math.PI / 2, 0, 0] : [0, 0, 0];
    return this.add(new THREE.CylinderGeometry(rad, rad, len, seg, 1, false), color, part, p, r);
  }
  /** Готовая геометрия Builder (со своими color/aPart). */
  raw(g: THREE.BufferGeometry): this {
    const P = g.getAttribute('position'), N = g.getAttribute('normal'), C = g.getAttribute('color'), A = g.getAttribute('aPart');
    for (let i = 0; i < P.count; i++) {
      this.pos.push(P.getX(i), P.getY(i), P.getZ(i)); this.nrm.push(N.getX(i), N.getY(i), N.getZ(i));
      this.col.push(C.getX(i), C.getY(i), C.getZ(i)); this.part.push(A.getX(i));
    }
    g.dispose();
    return this;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Боковой профиль [z, y] (z < 0 — нос, к −Z), выдавленный на ширину w по X. */
function side(pts: [number, number][], w: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(pts.map(([s, y]) => new THREE.Vector2(s, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false, steps: 1 });
  g.deleteAttribute('uv');
  g.translate(0, 0, -w / 2);
  g.rotateY(-Math.PI / 2);
  return g;
}

const DARK = 0x222426, UNDER = 0x2b2c2d, GLASS = 0x1b232b, ROOF = 0x7d8285, LAMP = 0xf5f0de, RED = 0x9a0e0e, METAL = 0x55595c, BUFFER = 0x303235;

/** Рама, ящики оборудования, буфера и автосцепки по концам. */
function underframe(b: Builder, L: number, W: number, y0: number, boxes = true): void {
  b.box(W * 0.9, 0.35, L - 0.6, UNDER, PART.fixed, [0, y0 + 0.17, 0]);
  if (boxes) for (const z of [-L * 0.18, L * 0.02, L * 0.2]) b.box(W * 0.7, 0.55, L * 0.14, DARK, PART.fixed, [0, y0 - 0.25, z]);
  for (const sz of [-1, 1]) {
    b.box(0.32, 0.22, 0.5, BUFFER, PART.fixed, [0, y0 - 0.02, sz * (L / 2 - 0.15)]);          // автосцепка СА-3
    b.box(W * 0.9, 0.3, 0.12, UNDER, PART.fixed, [0, y0 + 0.05, sz * (L / 2 - 0.35)]);       // буферный брус
  }
}

/** Полупантограф (асимметричный): основание, нижнее и верхнее колено, полоз на высоте контактного провода. */
function pantograph(b: Builder, z: number, roofY: number, raised = true): void {
  const top = raised ? 5.95 : roofY + 0.45;
  b.box(1.4, 0.12, 1.6, METAL, PART.metal, [0, roofY + 0.06, z]);
  for (const sx of [-0.45, 0.45]) b.cyl(0.08, 0.35, 0xd8d8d0, PART.fixed, [sx, roofY + 0.18, z - 0.6]);   // изоляторы
  const knee = [0, (roofY + top) / 2 + 0.25, z + 0.9] as [number, number, number];
  const a0 = [0, roofY + 0.15, z - 0.4], a1 = knee;
  const seg = (p: number[], q: number[], t = 0.07) => {
    const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2], L = Math.hypot(dx, dy, dz);
    const g = new THREE.BoxGeometry(t, L, t);
    const mid: [number, number, number] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    const ang = Math.atan2(dz, dy); // наклон в плоскости YZ
    b.add(g, METAL, PART.metal, mid, [ang, 0, 0]);
  };
  seg(a0, a1, 0.09);
  seg(a1, [0, top - 0.08, z - 0.2], 0.06);
  b.box(1.9, 0.06, 0.12, 0x3a3c3e, PART.metal, [0, top, z - 0.2]);   // полоз
}

/** Окна сбоку: ряд «стекол» вровень с бортом. */
function windows(b: Builder, W: number, z0: number, z1: number, y: number, h: number, w: number, gap: number): void {
  for (let z = z0; z + w <= z1 + 1e-3; z += w + gap)
    for (const sx of [-1, 1]) b.box(0.03, h, w, GLASS, PART.glass, [sx * (W / 2 + 0.005), y, z + w / 2]);
}

function doors(b: Builder, W: number, zs: number[], y0: number, color: number, part: number): void {
  for (const z of zs) for (const sx of [-1, 1]) {
    b.box(0.04, 2.0, 1.3, color, part, [sx * (W / 2 + 0.01), y0 + 1.0, z]);
    b.box(0.045, 0.75, 0.5, GLASS, PART.glass, [sx * (W / 2 + 0.012), y0 + 1.45, z - 0.33]);
    b.box(0.045, 0.75, 0.5, GLASS, PART.glass, [sx * (W / 2 + 0.012), y0 + 1.45, z + 0.33]);
  }
}

/** Кабина: лобовая часть длиной depth (профиль: вертикальный низ, наклонное лобовое стекло), прожектор, буферные фонари, красные огни. */
function cabNose(b: Builder, L: number, W: number, y0: number, roofY: number, paint: number, paintPart: number, slope = 0.9, depth = 2.6): void {
  const zf = -L / 2, yb = y0 + 1.6;
  b.add(side([[zf, y0], [zf + depth, y0], [zf + depth, roofY], [zf + slope, roofY], [zf, yb]], W - 0.02), paint, paintPart);
  b.box(W * 0.84, 0.18, depth - slope + 0.2, ROOF, PART.fixed, [0, roofY + 0.09, zf + slope + (depth - slope) / 2]);
  // лобовое стекло вдоль наклона (немного наружу)
  const gy0 = yb + 0.2, gy1 = roofY - 0.25;
  const zAt = (y: number) => zf + slope * (y - yb) / (roofY - yb);
  const ang = Math.atan2(zAt(gy1) - zAt(gy0), gy1 - gy0);
  const nz = -Math.cos(ang) * 0.03, ny = Math.sin(ang) * 0.03;
  b.add(new THREE.BoxGeometry(W * 0.8, Math.hypot(gy1 - gy0, zAt(gy1) - zAt(gy0)), 0.03), GLASS, PART.cab, [0, (gy0 + gy1) / 2 + ny, (zAt(gy0) + zAt(gy1)) / 2 + nz], [-ang, 0, 0]);
  // фонари: прожектор над стеклом, два буферных внизу, красные рядом
  b.box(0.42, 0.2, 0.1, LAMP, PART.head, [0, roofY - 0.13, zAt(roofY - 0.13) - 0.03]);
  for (const sx of [-1, 1]) {
    b.box(0.26, 0.2, 0.06, LAMP, PART.head, [sx * W * 0.3, y0 + 1.05, zf - 0.02]);
    b.box(0.16, 0.16, 0.06, RED, PART.marker, [sx * W * 0.41, y0 + 1.05, zf - 0.02]);
  }
  b.box(W * 0.95, 0.35, 0.12, DARK, PART.fixed, [0, y0 + 0.2, zf + 0.05]);   // юбка/путеочиститель
}

function emu(kind: 'emu_head' | 'emu_motor' | 'emu_trailer'): CarModel {
  const L = kind === 'emu_head' ? 22.0 : 21.5, W = 3.48, y0 = 1.15, roofY = 4.2;
  const BODY = 0xd4d6d8;
  const b = new Builder();
  const zb = kind === 'emu_head' ? -L / 2 + 2.6 : -L / 2 + 0.3;
  // кузов
  b.box(W, roofY - y0, L / 2 - 0.3 - zb, BODY, PART.fixed, [0, (y0 + roofY) / 2, (zb + L / 2 - 0.3) / 2]);
  b.box(W * 0.86, 0.22, L - 0.8, ROOF, PART.fixed, [0, roofY + 0.1, 0.1]);
  // ливрея: полоса под окнами и над ними (цвет инстанса)
  for (const sx of [-1, 1]) {
    b.box(0.02, 0.32, L - 0.8, 0xffffff, PART.paint, [sx * (W / 2 + 0.008), y0 + 0.75, 0.1]);
    b.box(0.02, 0.12, L - 0.8, 0xffffff, PART.paint, [sx * (W / 2 + 0.008), roofY - 0.35, 0.1]);
  }
  const dz = [-L / 2 + 2.4 + (kind === 'emu_head' ? 2.2 : 0), L / 2 - 2.4];
  doors(b, W, dz, y0, 0xffffff, PART.paint);
  windows(b, W, dz[0] + 1.2, dz[1] - 1.2, y0 + 1.6, 0.95, 1.2, 0.35);
  if (kind === 'emu_head') {
    cabNose(b, L, W, y0, roofY, BODY, PART.fixed, 1.4);
    for (const sx of [-1, 1]) b.box(0.025, 0.42, 2.0, 0xffffff, PART.paint, [sx * (W / 2 + 0.01), y0 + 0.75, -L / 2 + 1.9]);
  } else {
    for (const sz of [-1, 1]) b.box(W * 0.75, 2.6, 0.25, 0x1b1d1f, PART.fixed, [0, y0 + 1.4, sz * (L / 2 - 0.12)]);   // переходы
  }
  if (kind === 'emu_motor') {
    pantograph(b, -L / 2 + 5.0, roofY + 0.2, true);
    b.box(1.4, 0.4, 3.0, METAL, PART.metal, [0, roofY + 0.4, 2]);
  }
  underframe(b, L, W, y0 - 0.25, kind !== 'emu_trailer');
  return { kind, geo: b.build(), length: L, width: W, height: roofY + 0.3, bogieHalf: 7.5, bogie: 'b2', mass: 60000, lit: true };
}

function locoPass(): CarModel {
  // ЭП2К-подобный: двухкабинный, красный с серой полосой
  const L = 20.6, W = 3.2, y0 = 1.25, roofY = 4.35, BODY = 0xb5141b;
  const b = new Builder();
  b.box(W, roofY - y0, L - 5.2, BODY, PART.fixed, [0, (y0 + roofY) / 2, 0]);
  b.box(W * 0.84, 0.25, L - 4.6, ROOF, PART.fixed, [0, roofY + 0.12, 0]);
  for (const sx of [-1, 1]) {
    b.box(0.02, 0.38, L - 5.2, 0x9aa1a6, PART.fixed, [sx * (W / 2 + 0.008), y0 + 0.9, 0]);
    b.box(0.02, 0.08, L - 5.2, 0xe8e8e8, PART.fixed, [sx * (W / 2 + 0.008), y0 + 1.2, 0]);
    for (const z of [-5, -2, 1, 4]) b.box(0.03, 0.7, 1.6, 0x3b3f42, PART.fixed, [sx * (W / 2 + 0.01), y0 + 2.1, z]);   // жалюзи
  }
  for (const flip of [1, -1]) {
    const g = new Builder();
    cabNose(g, L, W, y0, roofY, BODY, PART.fixed, 1.0);
    for (const sx of [-1, 1]) g.box(0.03, 0.8, 0.9, GLASS, PART.cab, [sx * (W / 2 + 0.01), y0 + 2.2, -L / 2 + 2.6]);
    const geo = g.build();
    if (flip < 0) {
      // разворот кабины: зад — фонари сзади тоже «кабинные» (включаются по aLamp как хвост/голова — в шейдере по знаку z)
      geo.rotateY(Math.PI);
    }
    mergeInto(b, geo);
  }
  pantograph(b, -4.2, roofY + 0.25, true);
  pantograph(b, 4.2, roofY + 0.25, false);
  underframe(b, L, W, y0 - 0.25);
  return { kind: 'loco_pass', geo: b.build(), length: L, width: W, height: roofY + 0.3, bogieHalf: 5.6, bogie: 'b3', mass: 135000, lit: false };
}

function coach(): CarModel {
  // пассажирский вагон РЖД: серый с красной полосой (цвет инстанса), окна, тамбуры
  const L = 24.5, W = 3.12, y0 = 1.25, roofY = 4.2, BODY = 0x8e959b;
  const b = new Builder();
  b.box(W, roofY - y0, L - 0.5, BODY, PART.fixed, [0, (y0 + roofY) / 2, 0]);
  b.add(side([[-L / 2 + 0.3, roofY], [L / 2 - 0.3, roofY], [L / 2 - 0.3, roofY + 0.25], [-L / 2 + 0.3, roofY + 0.25]], W * 0.9), 0x6c7175, PART.fixed);
  for (const sx of [-1, 1]) {
    b.box(0.02, 0.55, L - 0.6, 0xffffff, PART.paint, [sx * (W / 2 + 0.008), y0 + 0.45, 0]);
    b.box(0.02, 0.1, L - 0.6, 0xffffff, PART.paint, [sx * (W / 2 + 0.008), roofY - 0.3, 0]);
  }
  windows(b, W, -L / 2 + 3.2, L / 2 - 3.2, y0 + 1.55, 0.85, 1.05, 0.95);
  doors(b, W, [-L / 2 + 1.3, L / 2 - 1.3], y0, 0x5e6468, PART.fixed);
  for (const sz of [-1, 1]) b.box(W * 0.7, 2.5, 0.3, 0x1b1d1f, PART.fixed, [0, y0 + 1.3, sz * (L / 2 - 0.12)]);
  underframe(b, L, W, y0 - 0.25);
  // хвостовые сигналы последнего вагона (включаются aLamp.y)
  for (const sx of [-1, 1]) b.box(0.16, 0.16, 0.06, RED, PART.marker, [sx * W * 0.38, y0 + 0.9, L / 2 + 0.04]);
  return { kind: 'coach', geo: b.build(), length: L, width: W, height: roofY + 0.3, bogieHalf: 8.5, bogie: 'b2', mass: 56000, lit: true };
}

function locoFreight(): CarModel {
  // секция 2ЭС5К: одна кабина спереди, капот, пантограф; две секции — вторая развёрнута
  const L = 17.5, W = 3.2, y0 = 1.25, roofY = 4.35, BODY = 0xb3171d;
  const b = new Builder();
  cabNose(b, L, W, y0, roofY, BODY, PART.fixed, 0.8);
  b.box(W, roofY - y0, L - 2.6, BODY, PART.fixed, [0, (y0 + roofY) / 2, 1.3]);
  b.box(W * 0.84, 0.25, L - 3.0, ROOF, PART.fixed, [0, roofY + 0.12, 1.0]);
  for (const sx of [-1, 1]) {
    b.box(0.02, 0.32, L - 2.0, 0x9aa1a6, PART.fixed, [sx * (W / 2 + 0.008), y0 + 0.85, 0.6]);
    b.box(0.03, 0.8, 0.9, GLASS, PART.cab, [sx * (W / 2 + 0.01), y0 + 2.2, -L / 2 + 2.3]);
    for (const z of [-3, 0, 3, 6]) b.box(0.03, 0.75, 1.8, 0x3b3f42, PART.fixed, [sx * (W / 2 + 0.01), y0 + 2.1, z]);
  }
  b.box(W * 0.75, 2.6, 0.25, 0x1b1d1f, PART.fixed, [0, y0 + 1.4, L / 2 - 0.12]);   // межсекционный переход
  pantograph(b, 2.0, roofY + 0.25, true);
  underframe(b, L, W, y0 - 0.25);
  return { kind: 'loco_freight', geo: b.build(), length: L, width: W, height: roofY + 0.3, bogieHalf: 4.6, bogie: 'b2', mass: 96000, lit: false };
}

function tank(): CarModel {
  const L = 12.0, W = 3.0, y0 = 1.05;
  const b = new Builder();
  b.box(2.2, 0.3, L - 0.5, UNDER, PART.fixed, [0, y0 + 0.1, 0]);
  b.cyl(1.45, L - 1.6, 0xffffff, PART.paint, [0, y0 + 1.75, 0], 'z', 14);
  for (const sz of [-1, 1]) b.add(new THREE.SphereGeometry(1.45, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0xffffff, PART.paint, [0, y0 + 1.75, sz * (L / 2 - 0.8)], [sz * Math.PI / 2, 0, 0]);
  b.cyl(0.45, 0.5, 0xffffff, PART.paint, [0, y0 + 3.35, 0], 'y', 10);   // колпак
  b.box(1.2, 0.06, 2.0, METAL, PART.metal, [0, y0 + 3.2, 0]);           // площадка
  for (const sz of [-1, 1]) b.box(W * 0.85, 0.3, 0.2, UNDER, PART.fixed, [0, y0 + 0.1, sz * (L / 2 - 0.3)]);
  underframe(b, L, W * 0.8, y0 - 0.15, false);
  return { kind: 'tank', geo: b.build(), length: L, width: W, height: y0 + 3.6, bogieHalf: 3.9, bogie: 'b2', mass: 80000, lit: false };
}

function gondola(): CarModel {
  const L = 13.9, W = 3.2, y0 = 1.1, h = 2.06;
  const b = new Builder();
  b.box(W - 0.1, 0.15, L - 0.6, 0x2a2826, PART.fixed, [0, y0 + 0.3, 0]);   // пол
  for (const sx of [-1, 1]) {
    b.box(0.08, h, L - 0.4, 0xffffff, PART.paint, [sx * (W / 2 - 0.04), y0 + h / 2 + 0.2, 0]);
    for (let z = -L / 2 + 0.8; z <= L / 2 - 0.7; z += 1.55) b.box(0.08, h, 0.12, 0xffffff, PART.paint, [sx * (W / 2 + 0.03), y0 + h / 2 + 0.2, z]);   // стойки
  }
  for (const sz of [-1, 1]) b.box(W, h, 0.08, 0xffffff, PART.paint, [0, y0 + h / 2 + 0.2, sz * (L / 2 - 0.24)]);
  b.box(W - 0.25, 0.12, L - 0.7, 0x2c2420, PART.fixed, [0, y0 + h - 0.05, 0]);   // груз (уголь/щебень), чуть ниже борта
  underframe(b, L, W * 0.85, y0 - 0.15, false);
  return { kind: 'gondola', geo: b.build(), length: L, width: W, height: y0 + h + 0.2, bogieHalf: 4.3, bogie: 'b2', mass: 90000, lit: false };
}

function boxcar(): CarModel {
  const L = 15.7, W = 3.25, y0 = 1.15, roofY = 4.65;
  const b = new Builder();
  b.box(W, roofY - y0, L - 0.4, 0xffffff, PART.paint, [0, (y0 + roofY) / 2, 0]);
  b.add(side([[-L / 2 + 0.2, roofY], [L / 2 - 0.2, roofY], [L / 2 - 0.2, roofY + 0.18], [-L / 2 + 0.2, roofY + 0.18]], W * 0.92), 0x6b6e70, PART.fixed);
  for (const sx of [-1, 1]) {
    b.box(0.05, 2.4, 3.8, 0xffffff, PART.paint, [sx * (W / 2 + 0.03), y0 + 1.35, 0]);       // раздвижная дверь
    b.box(0.06, 0.12, 4.4, METAL, PART.metal, [sx * (W / 2 + 0.06), y0 + 2.6, 0]);       // направляющая
    for (let z = -L / 2 + 1.0; z <= L / 2 - 0.9; z += 1.4) if (Math.abs(z) > 2.2) b.box(0.05, roofY - y0 - 0.2, 0.1, 0xffffff, PART.paint, [sx * (W / 2 + 0.02), (y0 + roofY) / 2, z]);
  }
  underframe(b, L, W * 0.85, y0 - 0.15, false);
  return { kind: 'boxcar', geo: b.build(), length: L, width: W, height: roofY + 0.2, bogieHalf: 5.3, bogie: 'b2', mass: 70000, lit: false };
}

function mergeInto(b: Builder, geo: THREE.BufferGeometry): void {
  b.raw(geo);
}

/** Тележка: рама и колёсные пары (центр — шкворень на уровне головки рельса). */
function bogie(axles: number): THREE.BufferGeometry {
  const b = new Builder();
  const base = axles === 3 ? 2.0 : 2.4;
  const half = (base * (axles - 1)) / 2;
  b.box(2.3, 0.45, half * 2 + 1.0, 0x262728, PART.fixed, [0, 0.75, 0]);
  for (const sx of [-1, 1]) b.box(0.25, 0.55, half * 2 + 1.4, 0x2f3032, PART.fixed, [sx * 1.0, 0.7, 0]);
  for (let k = 0; k < axles; k++) {
    const z = -half + k * base;
    b.cyl(0.08, 1.7, METAL, PART.metal, [0, 0.475, z], 'x', 6);
    for (const sx of [-1, 1]) {
      b.cyl(0.475, 0.13, 0x3a3836, PART.metal, [sx * 0.77, 0.475, z], 'x', 12);
      b.box(0.3, 0.35, 0.4, 0x1e1f20, PART.fixed, [sx * 1.15, 0.5, z]);   // букса
    }
  }
  for (const sx of [-1, 1]) b.box(0.3, 0.4, 0.5, 0x1e1f20, PART.fixed, [sx * 1.0, 1.0, 0]);  // пружины
  return b.build();
}

export function buildCarModels(): { cars: Record<CarKind, CarModel>; bogies: Record<BogieKind, THREE.BufferGeometry> } {
  const cars = {
    emu_head: emu('emu_head'), emu_motor: emu('emu_motor'), emu_trailer: emu('emu_trailer'), loco_pass: locoPass(), coach: coach(),
    loco_freight: locoFreight(), tank: tank(), gondola: gondola(), boxcar: boxcar(),
  } as Record<CarKind, CarModel>;
  return { cars, bogies: { b2: bogie(2), b3: bogie(3) } };
}

/** Общий материал составов: ливрея по instanceColor, фары/огни/салон по aLamp и ночи. */
export function trainMaterial(envMap?: THREE.Texture | null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.55, metalness: 0.15, envMap: envMap ?? null, envMapIntensity: 0.5 });
  m.customProgramCacheKey = () => 'nfr-rail-car';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = timeUniforms.nightFactor;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aPart;
        #ifdef USE_INSTANCING
          attribute vec3 aLamp;
        #endif
        uniform float uNight;
        varying vec3 vEmis; varying float vRough; varying float vMetal;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        vColor.rgb = color.rgb;
        #ifdef USE_INSTANCING_COLOR
          if (aPart < 0.5) vColor.rgb *= instanceColor.rgb;
        #endif
        vec3 lamp = vec3(0.0);
        #ifdef USE_INSTANCING
          lamp = aLamp;
        #endif
        // кабина спереди (z < 0) — прожектор/буферные фонари по lamp.x; у двухкабинного локомотива задняя кабина
        // (z > 0) показывает красные огни, если lamp.y (хвост) — иначе тоже тёмная
        float front = position.z < 0.0 ? 1.0 : 0.0;
        vEmis = vec3(0.0);
        if (aPart > 1.5 && aPart < 2.5) vEmis = vec3(1.0, 0.95, 0.82) * lamp.x * front * (0.8 + 4.0 * uNight);
        else if (aPart > 2.5 && aPart < 3.5) vEmis = vec3(1.0, 0.05, 0.03) * lamp.y * (front > 0.5 ? 1.0 - lamp.x : 1.0) * (0.6 + 3.0 * uNight);
        else if (aPart > 3.5 && aPart < 4.5) vEmis = vec3(1.0, 0.86, 0.62) * lamp.z * uNight * 0.9;
        vRough = aPart > 3.5 && aPart < 5.5 ? 0.08 : (aPart > 5.5 ? 0.45 : 0.6);
        vMetal = aPart > 5.5 ? 0.7 : (aPart < 0.5 ? 0.25 : 0.1);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEmis; varying float vRough; varying float vMetal;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmis;');
  };
  return m;
}
