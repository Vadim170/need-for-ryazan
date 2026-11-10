import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Процедурные low-poly модели пропсов (без файлов ассетов). Все модели — одна BufferGeometry на модель (non-indexed),
 * атрибуты: position, normal, color (вершинный цвет, линейный), aFlag:
 *   0 — обычная поверхность, 1 — тонируется цветом инстанса (кроны, кузов, цветные детали),
 *   2 — светится ночью (плафон фонаря, uNight), 3/4/5 — секция светофора красная/жёлтая/зелёная (фаза в instanceColor.r).
 * «Вперёд» модели — локальная −Z, начало координат — точка основания (как в docs/world-format.md).
 */

export const FLAG = { plain: 0, tint: 1, lamp: 2, red: 3, yellow: 4, green: 5, paint: 7 } as const; // 6 — стекло витрины, 7 — лак кузова (тонировка + глянец)

class Builder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private flag: number[] = [];
  private m = new THREE.Matrix4();
  private nm = new THREE.Matrix3();

  /** Добавить геометрию с цветом (sRGB hex) и флагом, со сдвигом/поворотом. */
  add(geo: THREE.BufferGeometry, color: number, flag: number = FLAG.plain, at?: { p?: [number, number, number]; r?: [number, number, number]; s?: [number, number, number] }): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const p = at?.p ?? [0, 0, 0], r = at?.r ?? [0, 0, 0], s = at?.s ?? [1, 1, 1];
    this.m.compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)), new THREE.Vector3(...s));
    this.nm.getNormalMatrix(this.m);
    const P = g.getAttribute('position'), N = g.getAttribute('normal');
    const c = new THREE.Color(color); // → линейный
    const v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(this.m);
      this.pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(N, i).applyMatrix3(this.nm).normalize();
      this.nrm.push(v.x, v.y, v.z);
      this.col.push(c.r, c.g, c.b);
      this.flag.push(flag);
    }
    if (g !== geo) g.dispose();
    geo.dispose();
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aFlag', new THREE.Float32BufferAttribute(this.flag, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const hash = (x: number, y: number, z: number, s: number) => {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + s * 19.3) * 43758.5453;
  return h - Math.floor(h);
};

/** Неровная «шапка» кроны: икосаэдр с шумом по радиусу, сглаженные нормали. */
function blob(r: number, detail: number, seed: number, sy = 1, jitter = 0.22): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const P = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    const k = 1 + jitter * (hash(x * 3, y * 3, z * 3, seed) - 0.5) * 2;
    P.setXYZ(i, x * r * k, y * r * sy * k * (y < 0 ? 0.7 : 1), z * r * k); // низ кроны приплюснут
  }
  g.computeVertexNormals();
  return g;
}

const cyl = (rt: number, rb: number, h: number, seg: number) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, false);
const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);

// ---------------- деревья (номинальные высоты — docs/world-format.md) ----------------

export interface TreeModel { near: THREE.BufferGeometry; far: THREE.BufferGeometry; trunkR: number }

export function buildTrees(): Record<string, TreeModel> {
  const out: Record<string, TreeModel> = {};
  // берёза ~15 м: белый ствол, светлая рыхлая крона
  out.tree_birch = {
    trunkR: 0.2,
    near: new Builder()
      .add(cyl(0.1, 0.2, 11, 6), 0xd9d6cc, 0, { p: [0, 5.5, 0] })
      .add(cyl(0.183, 0.183, 0.07, 6), 0x55504a, 0, { p: [0, 2.2, 0] }) // тёмные «чечевички» берёзы
      .add(cyl(0.155, 0.155, 0.06, 6), 0x55504a, 0, { p: [0, 4.6, 0] })
      .add(blob(2.5, 1, 1, 1.5), 0x7aa543, FLAG.tint, { p: [0, 9.6, 0] })
      .add(blob(2.0, 1, 2, 1.4), 0x86ad4b, FLAG.tint, { p: [0.9, 12.6, 0.3] })
      .add(blob(1.9, 1, 3, 1.2), 0x6f9a3d, FLAG.tint, { p: [-1.0, 7.8, -0.5] })
      .build(),
    far: new Builder()
      .add(cyl(0.12, 0.2, 8, 3), 0xd9d6cc, 0, { p: [0, 4, 0] })
      .add(blob(2.9, 0, 1, 1.75, 0.1), 0x7aa543, FLAG.tint, { p: [0, 10.6, 0] })
      .build(),
  };
  // тополь ~20 м: высокая узкая крона
  out.tree_poplar = {
    trunkR: 0.35,
    near: new Builder()
      .add(cyl(0.2, 0.36, 9, 6), 0x6b6458, 0, { p: [0, 4.5, 0] })
      .add(blob(2.4, 1, 4, 3.0), 0x4f7d30, FLAG.tint, { p: [0, 11.5, 0] })
      .add(blob(1.8, 1, 5, 2.4), 0x5a8836, FLAG.tint, { p: [0.2, 16.0, 0.3] })
      .build(),
    far: new Builder()
      .add(cyl(0.2, 0.35, 6, 3), 0x6b6458, 0, { p: [0, 3, 0] })
      .add(blob(2.4, 0, 4, 3.4, 0.1), 0x4f7d30, FLAG.tint, { p: [0, 12.5, 0] })
      .build(),
  };
  // клён ~12 м: круглая широкая крона
  out.tree_maple = {
    trunkR: 0.3,
    near: new Builder()
      .add(cyl(0.18, 0.3, 6, 6), 0x5a4a3a, 0, { p: [0, 3, 0] })
      .add(blob(3.6, 1, 6, 0.95), 0x5e8f2f, FLAG.tint, { p: [0, 7.9, 0] })
      .add(blob(2.5, 1, 7, 1.0), 0x67993a, FLAG.tint, { p: [1.5, 9.4, 0.8] })
      .add(blob(2.5, 1, 8, 1.0), 0x54842b, FLAG.tint, { p: [-1.6, 8.8, -0.9] })
      .build(),
    far: new Builder()
      .add(cyl(0.18, 0.3, 5, 3), 0x5a4a3a, 0, { p: [0, 2.5, 0] })
      .add(blob(3.9, 0, 6, 0.95, 0.1), 0x5e8f2f, FLAG.tint, { p: [0, 8.2, 0] })
      .build(),
  };
  // липа ~15 м: овальная плотная крона, темнее
  out.tree_lime = {
    trunkR: 0.32,
    near: new Builder()
      .add(cyl(0.2, 0.32, 7, 6), 0x4e4236, 0, { p: [0, 3.5, 0] })
      .add(blob(3.9, 1, 9, 1.25), 0x4b7b2b, FLAG.tint, { p: [0, 9.0, 0] })
      .add(blob(2.6, 1, 10, 1.1), 0x527f30, FLAG.tint, { p: [0.3, 12.3, -0.2] })
      .build(),
    far: new Builder()
      .add(cyl(0.2, 0.32, 6, 3), 0x4e4236, 0, { p: [0, 3, 0] })
      .add(blob(3.9, 0, 9, 1.5, 0.1), 0x4b7b2b, FLAG.tint, { p: [0, 9.8, 0] })
      .build(),
  };
  // сосна/ель ~18 м: тёмный конус ярусами, рыжий ствол
  out.tree_pine = {
    trunkR: 0.28,
    near: new Builder()
      .add(cyl(0.12, 0.28, 15, 6), 0x7a5236, 0, { p: [0, 7.5, 0] })
      .add(new THREE.ConeGeometry(3.1, 6, 8), 0x2b4a26, FLAG.tint, { p: [0, 7.5, 0] })
      .add(new THREE.ConeGeometry(2.5, 5.5, 8), 0x2f5229, FLAG.tint, { p: [0, 11.0, 0], r: [0, 0.4, 0] })
      .add(new THREE.ConeGeometry(1.8, 4.5, 7), 0x325a2c, FLAG.tint, { p: [0, 14.3, 0], r: [0, 0.8, 0] })
      .add(new THREE.ConeGeometry(1.0, 3.2, 6), 0x36602f, FLAG.tint, { p: [0, 16.8, 0] })
      .build(),
    far: new Builder()
      .add(cyl(0.12, 0.28, 5, 3), 0x7a5236, 0, { p: [0, 2.5, 0] })
      .add(new THREE.ConeGeometry(3.0, 14, 5, 1, true), 0x2d4e28, FLAG.tint, { p: [0, 11.2, 0] })
      .build(),
  };
  // куст ~1.5 м, Ø 2 м
  out.shrub = {
    trunkR: 0,
    near: new Builder()
      .add(blob(1.0, 1, 11, 0.75), 0x4d7330, FLAG.tint, { p: [0, 0.7, 0] })
      .add(blob(0.7, 1, 12, 0.8), 0x567d36, FLAG.tint, { p: [0.45, 0.9, 0.2] })
      .build(),
    far: new Builder().add(blob(1.0, 0, 11, 0.8, 0.05), 0x4d7330, FLAG.tint, { p: [0, 0.75, 0] }).build(),
  };
  return out;
}

// ---------------- уличная мебель ----------------

const GREY = 0x7d8285, DARK = 0x2c2e30, WOOD = 0x8a6a45, CONCRETE = 0x9a9890;

/** Фонарь ~9 м: серая конусная опора, консоль к дороге (−Z), плафон светится ночью. */
export function buildStreetLamp(): THREE.BufferGeometry {
  return new Builder()
    .add(cyl(0.2, 0.22, 0.7, 6), GREY, 0, { p: [0, 0.35, 0] })
    .add(cyl(0.065, 0.13, 8.6, 6), GREY, 0, { p: [0, 4.6, 0] })
    .add(box(0.07, 0.07, 1.8), GREY, 0, { p: [0, 9.05, -0.88], r: [0.17, 0, 0] }) // консоль поднимается к плафону (над дорогой, −Z)
    .add(box(0.32, 0.13, 0.62), 0x5c6064, 0, { p: [0, 9.25, -1.9] })
    .add(box(0.26, 0.03, 0.5), 0xfff1d0, FLAG.lamp, { p: [0, 9.175, -1.9] })
    .build();
}

function trafficHead(b: Builder, x: number, y: number): Builder {
  b.add(box(0.34, 0.98, 0.26), 0x26292b, 0, { p: [x, y, 0] });
  const lens = (dy: number, col: number, flag: number) => b.add(cyl(0.11, 0.11, 0.04, 10), col, flag, { p: [x, y + dy, -0.14], r: [Math.PI / 2, 0, 0] });
  lens(0.3, 0xff2a1a, FLAG.red); lens(0, 0xffaa00, FLAG.yellow); lens(-0.3, 0x22ff66, FLAG.green);
  b.add(box(0.3, 0.02, 0.16), 0x1d1f20, 0, { p: [x, y + 0.43, -0.2] }); // козырёк
  return b;
}

/** Светофор ~3.5 м на опоре, лицом к машинам (−Z). */
export function buildTrafficLight(): THREE.BufferGeometry {
  const b = new Builder().add(cyl(0.065, 0.075, 3.2, 6), 0x6a6d70, 0, { p: [0, 1.6, 0] });
  return trafficHead(b, 0, 2.85).build();
}

/** Светофор с Г-образной консолью над полосами (подходы ≥ 3 полос): консоль вдоль +X (над проезжей частью). */
export function buildTrafficLightArm(): THREE.BufferGeometry {
  const b = new Builder()
    .add(cyl(0.11, 0.16, 6.4, 6), 0x6a6d70, 0, { p: [0, 3.2, 0] })
    .add(cyl(0.06, 0.08, 6.5, 5), 0x6a6d70, 0, { p: [3.2, 6.15, 0], r: [0, 0, Math.PI / 2] });
  trafficHead(b, 0, 2.85);
  trafficHead(b, 5.6, 5.45);
  return b.build();
}

/** Павильон остановки 4×1.6×2.5, открыт к дороге (−Z). */
export function buildBusStop(): THREE.BufferGeometry {
  const b = new Builder()
    .add(box(4, 1.9, 0.04), 0x8fa6b2, 0, { p: [0, 1.3, 0.75] })
    .add(box(0.04, 1.9, 1.4), 0x8fa6b2, 0, { p: [1.97, 1.3, 0.05] })
    .add(box(0.04, 1.9, 1.4), 0xd8d2c0, 0, { p: [-1.97, 1.3, 0.05] }) // рекламный щит
    .add(box(4.3, 0.12, 1.9), 0x2f5d8c, 0, { p: [0, 2.5, 0] })
    .add(box(2.4, 0.05, 0.38), WOOD, 0, { p: [0, 0.46, 0.5] })
    .add(box(0.06, 0.44, 0.3), DARK, 0, { p: [-1.0, 0.22, 0.5] })
    .add(box(0.06, 0.44, 0.3), DARK, 0, { p: [1.0, 0.22, 0.5] });
  for (const x of [-1.98, 1.98]) for (const z of [-0.75, 0.77]) b.add(cyl(0.04, 0.04, 2.45, 5), GREY, 0, { p: [x, 1.22, z] });
  return b.build();
}

/** Лавочка 1.8 м: сидящий смотрит на −Z. */
export function buildBench(): THREE.BufferGeometry {
  const b = new Builder()
    .add(box(1.8, 0.05, 0.42), WOOD, 0, { p: [0, 0.45, 0] })
    .add(box(1.8, 0.36, 0.04), WOOD, 0, { p: [0, 0.75, 0.2], r: [-0.15, 0, 0] });
  for (const x of [-0.75, 0.75]) b.add(box(0.06, 0.45, 0.44), DARK, 0, { p: [x, 0.225, 0] }).add(box(0.06, 0.4, 0.05), DARK, 0, { p: [x, 0.7, 0.21] });
  return b.build();
}

export function buildTrashBin(): THREE.BufferGeometry {
  return new Builder()
    .add(cyl(0.21, 0.17, 0.66, 8), 0x3b4d3c, 0, { p: [0, 0.33, 0] })
    .add(cyl(0.23, 0.23, 0.05, 8), 0x2a302b, 0, { p: [0, 0.68, 0] })
    .build();
}

/** Детские комплексы (габарит ~4×4 м): 4 модели; цветные части тонируются цветом инстанса (variant → цвет). */
export function buildPlaygrounds(): THREE.BufferGeometry[] {
  const W = 0xffffff, POST = 0x6a6f74;
  // 0: горка с башенкой
  const slide = new Builder();
  for (const x of [-1.4, -0.2]) for (const z of [-0.6, 0.6]) slide.add(cyl(0.05, 0.05, 2.3, 5), POST, 0, { p: [x, 1.15, z] });
  slide.add(box(1.3, 0.1, 1.3), W, FLAG.tint, { p: [-0.8, 1.3, 0] })
    .add(new THREE.ConeGeometry(1.05, 0.8, 4), 0xe0b020, 0, { p: [-0.8, 2.7, 0], r: [0, Math.PI / 4, 0] })
    .add(box(2.8, 0.05, 0.62), 0x2f74c0, 0, { p: [0.65, 0.7, 0], r: [0, 0, -0.52] }) // лоток по уклону
    .add(box(1.3, 0.5, 0.04), W, FLAG.tint, { p: [-0.8, 1.6, 0.64] })
    .add(box(0.5, 1.3, 0.06), POST, 0, { p: [-0.8, 0.65, -0.95], r: [0.35, 0, 0] });
  // 1: качели
  const swing = new Builder();
  for (const x of [-1.6, 1.6]) for (const z of [-1, 1]) swing.add(cyl(0.05, 0.05, 2.5, 5), POST, 0, { p: [x, 1.2, z * 0.42], r: [z * 0.33, 0, 0] });
  swing.add(cyl(0.06, 0.06, 3.4, 6), W, FLAG.tint, { p: [0, 2.35, 0], r: [0, 0, Math.PI / 2] });
  for (const x of [-0.65, 0.65]) {
    swing.add(box(0.5, 0.05, 0.22), 0xd23a2a, 0, { p: [x, 0.5, 0] });
    for (const dx of [-0.22, 0.22]) swing.add(box(0.02, 1.8, 0.02), 0x444444, 0, { p: [x + dx, 1.43, 0] });
  }
  // 2: домик + песочница
  const house = new Builder()
    .add(box(1.6, 1.3, 1.6), W, FLAG.tint, { p: [-0.8, 0.65, 0] })
    .add(new THREE.ConeGeometry(1.3, 0.9, 4), 0xc0392b, 0, { p: [-0.8, 1.75, 0], r: [0, Math.PI / 4, 0] })
    .add(box(2.0, 0.25, 2.0), WOOD, 0, { p: [1.2, 0.12, 0] })
    .add(box(1.8, 0.05, 1.8), 0xd8c08a, 0, { p: [1.2, 0.2, 0] });
  // 3: карусель + пружинная качалка
  const carousel = new Builder()
    .add(cyl(1.2, 1.2, 0.12, 12), W, FLAG.tint, { p: [-0.6, 0.35, 0] })
    .add(cyl(0.06, 0.06, 1.1, 6), POST, 0, { p: [-0.6, 0.85, 0] })
    .add(cyl(0.5, 0.5, 0.05, 10), 0xe0b020, 0, { p: [-0.6, 1.4, 0] })
    .add(cyl(0.05, 0.05, 0.5, 5), 0x333333, 0, { p: [1.3, 0.25, 0.4] })
    .add(box(0.3, 0.45, 0.8), 0x2f9a48, 0, { p: [1.3, 0.7, 0.4] });
  return [slide.build(), swing.build(), house.build(), carousel.build()];
}

/** Контейнерная площадка ~4×2 м: бетонное основание, навес, ограда с трёх сторон, 4 бака (открыта к −Z). */
export function buildContainerSite(): THREE.BufferGeometry {
  const b = new Builder()
    .add(box(4.4, 0.12, 2.4), CONCRETE, 0, { p: [0, 0.06, 0] })
    .add(box(4.4, 1.7, 0.06), 0x6f8c74, 0, { p: [0, 0.95, 1.17] })
    .add(box(0.06, 1.7, 2.3), 0x6f8c74, 0, { p: [2.18, 0.95, 0.05] })
    .add(box(0.06, 1.7, 2.3), 0x6f8c74, 0, { p: [-2.18, 0.95, 0.05] })
    .add(box(4.6, 0.06, 2.6), 0x5a6a5f, 0, { p: [0, 2.15, 0.05], r: [-0.06, 0, 0] });
  for (const x of [-2.18, 2.18]) b.add(cyl(0.04, 0.04, 2.1, 4), GREY, 0, { p: [x, 1.05, -1.1] });
  const cols = [0x2e6a3a, 0x2b4f8a, 0x2e6a3a, 0x8a8f94];
  for (let i = 0; i < 4; i++) {
    const x = -1.55 + i * 1.03;
    b.add(box(0.95, 1.1, 0.95), cols[i], 0, { p: [x, 0.67, 0.4] }).add(box(1.0, 0.07, 1.0), 0x2a2e2b, 0, { p: [x, 1.25, 0.4] });
  }
  return b.build();
}

// ---------------- припаркованные машины ----------------

/** Профиль сбоку (s — вдоль, нос в −s; y — высота) → ExtrudeGeometry по ширине; результат: длина вдоль Z (нос −Z), ширина по X. */
function extrudeProfile(pts: [number, number][], width: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(pts.map(([s, y]) => new THREE.Vector2(s, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, steps: 1 });
  g.deleteAttribute('uv');
  g.translate(0, 0, -width / 2);
  g.rotateY(-Math.PI / 2); // shape.x (s) → z (нос s<0 → −Z), глубина → x
  return g;
}

/**
 * Простая «Лада»: кузов (тонируется цветом инстанса), стеклянный пояс, крыша, колёса, фары/фонари. ~300 треугольников.
 * wagon — универсал (Ларгус), sedan — седан (Гранта/Приора). Габарит ~4.4×1.75×1.5 м.
 */
export function buildParkedCar(kind: 'wagon' | 'sedan'): { near: THREE.BufferGeometry; far: THREE.BufferGeometry } {
  const W = 1.74, L2 = 2.2;
  const PAINT = 0xffffff, GLASS = 0x1c232b, TYRE = 0x161616, TRIM = 0x2a2a2a;
  const lower: [number, number][] = [[-L2, 0.32], [-L2 + 0.02, 0.62], [-L2 + 0.12, 0.84], [-1.25, 0.96], [L2 - 0.1, 0.98], [L2, 0.75], [L2 - 0.02, 0.32]];
  const cabin: [number, number][] = kind === 'wagon'
    ? [[-1.25, 0.95], [-0.5, 1.38], [L2 - 0.2, 1.42], [L2 - 0.08, 0.97]]
    : [[-1.15, 0.95], [-0.35, 1.36], [0.85, 1.38], [1.6, 0.98]];
  const roof: [number, number][] = kind === 'wagon'
    ? [[-0.52, 1.37], [-0.45, 1.5], [L2 - 0.22, 1.52], [L2 - 0.2, 1.41]]
    : [[-0.37, 1.35], [-0.3, 1.47], [0.82, 1.48], [0.87, 1.37]];
  const b = new Builder()
    .add(extrudeProfile(lower, W), PAINT, FLAG.paint)
    .add(extrudeProfile(cabin, W * 0.88), GLASS)
    .add(extrudeProfile(roof, W * 0.9), PAINT, FLAG.paint)
    .add(box(0.08, 0.42, 0.05), TRIM, 0, { p: [W * 0.44, 1.16, kind === 'wagon' ? 0.05 : 0.15], s: [0.3, 1, 1] })
    .add(box(W + 0.02, 0.2, 0.14), TRIM, 0, { p: [0, 0.4, -L2 - 0.02] })
    .add(box(W + 0.02, 0.2, 0.14), TRIM, 0, { p: [0, 0.4, L2 + 0.02] });
  for (const x of [-0.58, 0.58]) {
    b.add(box(0.36, 0.13, 0.04), 0xe8e6dc, 0, { p: [x, 0.72, -L2 - 0.01] });
    b.add(box(0.3, 0.16, 0.04), 0x9a1010, 0, { p: [x * 1.1, 0.78, L2 + 0.005] });
  }
  for (const x of [-0.76, 0.76]) for (const z of [-1.35, 1.38]) b.add(cyl(0.31, 0.31, 0.2, 10), TYRE, 0, { p: [x, 0.31, z], r: [0, 0, Math.PI / 2] });
  const near = b.build();
  const far = new Builder()
    .add(box(W, 0.66, 2 * L2), PAINT, FLAG.paint, { p: [0, 0.65, 0] })
    .add(box(W * 0.88, 0.45, kind === 'wagon' ? 2.9 : 2.2), GLASS, 0, { p: [0, 1.18, kind === 'wagon' ? 0.55 : 0.2] })
    .add(box(W * 0.9, 0.1, kind === 'wagon' ? 2.6 : 1.3), PAINT, FLAG.paint, { p: [0, 1.45, kind === 'wagon' ? 0.7 : 0.25] })
    .add(box(W + 0.04, 0.34, 2 * L2 - 0.6), TYRE, 0, { p: [0, 0.2, 0] })
    .build();
  return { near, far };
}

/** Единичный ящик для оград/стен: x ∈ [−0.5, 0.5] (толщина), y ∈ [0, 1] (высота), z ∈ [−0.5, 0.5] (вдоль сегмента). */
export function buildUnitBox(): THREE.BufferGeometry {
  return new Builder().add(box(1, 1, 1), 0xffffff, FLAG.tint, { p: [0, 0.5, 0] }).build();
}

// ---------------- улица (streetlife): клумбы, боллards, шлагбаумы, фонари, подъезды, витрины ----------------

/** Кусты-разновидности: сирень (с соцветиями), можжевельник (конус), стриженый бирючина/самшит (низкий ящик). */
export function buildShrubVariants(): THREE.BufferGeometry[] {
  const lilac = new Builder()
    .add(blob(1.2, 1, 21, 1.1), 0x4a6e2c, FLAG.tint, { p: [0, 1.3, 0] })
    .add(blob(0.9, 1, 22, 1.2), 0x52782f, FLAG.tint, { p: [0.6, 1.7, 0.3] });
  const rnd = (k: number) => hash(k, 2, 3, 4);
  for (let i = 0; i < 9; i++) {
    const a = rnd(i) * 6.28, r = 0.8 + 0.4 * rnd(i + 9);
    lilac.add(new THREE.ConeGeometry(0.16, 0.38, 5), i % 3 ? 0xa77bc8 : 0xf1eef5, 0, { p: [Math.cos(a) * r, 1.6 + rnd(i + 3) * 0.9, Math.sin(a) * r], r: [Math.PI, 0, 0] });
  }
  const juniper = new Builder()
    .add(new THREE.ConeGeometry(0.55, 2.2, 7), 0x2e4a2c, FLAG.tint, { p: [0, 1.1, 0] })
    .add(new THREE.ConeGeometry(0.42, 1.4, 7), 0x35552f, FLAG.tint, { p: [0.15, 1.6, 0.05] });
  const hedge = new Builder()
    .add(new THREE.BoxGeometry(1.4, 0.8, 0.8, 2, 1, 1), 0x3f6a2a, FLAG.tint, { p: [0, 0.4, 0] })
    .add(blob(0.45, 0, 23, 0.6, 0.1), 0x467231, FLAG.tint, { p: [0.3, 0.8, 0] });
  return [lilac.build(), juniper.build(), hedge.build()];
}

/** Клумба: бортик (тонируется цветом инстанса), земля, цветы. round — радиус 1; rect — квадрат ±0.5. Высота бортика 1. */
export function buildFlowerbed(shape: 'round' | 'rect'): THREE.BufferGeometry {
  const b = new Builder();
  const FLOW = [0xe0302a, 0xf2c014, 0xb04fc8, 0xf4f0f0, 0xf07a1a, 0xe85a9a];
  if (shape === 'round') {
    b.add(new THREE.CylinderGeometry(1, 1, 1, 24, 1, true), 0xffffff, FLAG.tint, { p: [0, 0.5, 0] })
      .add(new THREE.RingGeometry(0.92, 1, 24, 1), 0xffffff, FLAG.tint, { p: [0, 1, 0], r: [-Math.PI / 2, 0, 0] })
      .add(new THREE.CircleGeometry(0.93, 24), 0x3a2a1c, 0, { p: [0, 0.8, 0], r: [-Math.PI / 2, 0, 0] });
  } else {
    b.add(new THREE.BoxGeometry(1, 1, 0.04), 0xffffff, FLAG.tint, { p: [0, 0.5, 0.48] })
      .add(new THREE.BoxGeometry(1, 1, 0.04), 0xffffff, FLAG.tint, { p: [0, 0.5, -0.48] })
      .add(new THREE.BoxGeometry(0.04, 1, 1), 0xffffff, FLAG.tint, { p: [0.48, 0.5, 0] })
      .add(new THREE.BoxGeometry(0.04, 1, 1), 0xffffff, FLAG.tint, { p: [-0.48, 0.5, 0] })
      .add(new THREE.PlaneGeometry(0.94, 0.94), 0x3a2a1c, 0, { p: [0, 0.8, 0], r: [-Math.PI / 2, 0, 0] });
  }
  for (let i = 0; i < 34; i++) {
    const a = hash(i, 1, 2, 3) * 6.28, r = Math.sqrt(hash(i, 4, 5, 6)) * 0.82;
    const x = shape === 'round' ? Math.cos(a) * r : (hash(i, 7, 8, 9) - 0.5) * 0.85, z = shape === 'round' ? Math.sin(a) * r : (hash(i, 9, 8, 7) - 0.5) * 0.85;
    b.add(blob(0.06, 0, i, 0.8, 0.2), 0x3d6a28, 0, { p: [x, 0.95, z], s: [1, 2.5, 1] });
    b.add(blob(0.05, 0, i + 50, 0.7, 0.1), FLOW[i % FLOW.length], 0, { p: [x, 1.12, z] });
  }
  return b.build();
}

export function buildBollard(): THREE.BufferGeometry {
  return new Builder()
    .add(cyl(0.09, 0.1, 0.85, 8), 0x2e3134, 0, { p: [0, 0.425, 0] })
    .add(cyl(0.095, 0.095, 0.08, 8), 0xe8e8e0, 0, { p: [0, 0.72, 0] })
    .add(new THREE.SphereGeometry(0.09, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), 0x2e3134, 0, { p: [0, 0.85, 0] })
    .build();
}

/** Тумба шлагбаума (стрела — отдельно: buildBarrierArm). */
export function buildBarrierPost(): THREE.BufferGeometry {
  return new Builder()
    .add(box(0.32, 1.0, 0.32), 0xd8d4c8, 0, { p: [0, 0.5, 0] })
    .add(box(0.36, 0.08, 0.36), 0x8a8f94, 0, { p: [0, 1.02, 0] })
    .add(box(0.1, 0.1, 0.06), 0xff3010, FLAG.lamp, { p: [0, 1.1, 0] })
    .build();
}

/** Стрела шлагбаума: z 0..1 (масштаб = длина), красно-белые полосы. */
export function buildBarrierArm(): THREE.BufferGeometry {
  const b = new Builder();
  for (let i = 0; i < 10; i++) b.add(box(0.07, 0.07, 0.1), i % 2 ? 0xd02018 : 0xf0f0ec, 0, { p: [0, 0, (i + 0.5) / 10] });
  return b.build();
}

/** Парковый фонарь ~4.5 м: тонкая опора, шар-плафон. */
export function buildParkLamp(): THREE.BufferGeometry {
  return new Builder()
    .add(cyl(0.09, 0.12, 0.5, 8), 0x232527, 0, { p: [0, 0.25, 0] })
    .add(cyl(0.045, 0.06, 3.9, 6), 0x232527, 0, { p: [0, 2.4, 0] })
    .add(cyl(0.08, 0.05, 0.12, 8), 0x232527, 0, { p: [0, 4.38, 0] })
    .add(new THREE.SphereGeometry(0.22, 10, 6), 0xfff4dc, FLAG.lamp, { p: [0, 4.62, 0] })
    .build();
}

/** Фонарь на разделительной полосе ~10 м: две консоли вдоль ±Z. */
export function buildDoubleLamp(): THREE.BufferGeometry {
  const b = new Builder()
    .add(cyl(0.22, 0.24, 0.7, 6), GREY, 0, { p: [0, 0.35, 0] })
    .add(cyl(0.07, 0.14, 9.6, 6), GREY, 0, { p: [0, 5.1, 0] });
  for (const s of [-1, 1]) {
    b.add(box(0.07, 0.07, 2.0), GREY, 0, { p: [0, 9.97, s * 0.98], r: [-s * 0.13, 0, 0] }) // поднимается к плафону
      .add(box(0.32, 0.13, 0.62), 0x5c6064, 0, { p: [0, 10.15, s * 2.0] })
      .add(box(0.26, 0.03, 0.5), 0xfff1d0, FLAG.lamp, { p: [0, 10.075, s * 2.0] });
  }
  return b.build();
}

/**
 * Подъезд: дверь (низ на высоте 0.6 — макс. крыльцо), крыльцо из 4 ступеней (уходят в землю до −1 м: модель
 * опускается на 0.6 − stepsHeight), козырёк, светильник над дверью (ночью), домофон. «Вперёд» −Z = наружу.
 */
export function buildEntrance(): THREE.BufferGeometry {
  const CONC = 0x9e9a90;
  const b = new Builder()
    .add(box(2.4, 1.6, 1.2), CONC, 0, { p: [0, -0.2, -0.6] }); // площадка крыльца (верх 0.6)
  for (let k = 1; k <= 4; k++) {
    const top = 0.6 - 0.15 * k, z0 = 1.2 + 0.3 * (k - 1);
    b.add(box(2.0, top + 1.0, 0.3), CONC, 0, { p: [0, (top - 1.0) / 2, -(z0 + 0.15)] });
  }
  b.add(box(1.5, 2.2, 0.06), 0x6f6a62, 0, { p: [0, 0.6 + 1.1, -0.02] }) // коробка
    .add(box(1.2, 2.05, 0.08), 0x3b2e26, 0, { p: [0, 0.6 + 1.04, -0.05] }) // металлическая дверь
    .add(box(0.12, 0.2, 0.03), 0x1a1a1a, 0, { p: [0.75, 0.6 + 1.3, -0.08] }) // домофон
    .add(box(2.6, 0.12, 1.6), CONC, 0, { p: [0, 0.6 + 2.6, -0.8] }) // козырёк
    .add(box(2.6, 0.14, 0.04), 0x7a756c, 0, { p: [0, 0.6 + 2.6, -1.6] })
    .add(box(0.22, 0.12, 0.16), 0xfff0c8, FLAG.lamp, { p: [0, 0.6 + 2.38, -0.1] });
  return b.build();
}

/**
 * Витрина (без вывески): единичная по ширине x ∈ ±0.5 и высоте этажа y ∈ 0..1; −Z — наружу от стены.
 * Стекло витрины (ночью светится), рама, дверь по центру, цоколь, козырёк вывески.
 */
export function buildStorefront(): THREE.BufferGeometry {
  return new Builder()
    .add(box(0.98, 0.12, 0.08), 0x5a5650, 0, { p: [0, 0.06, -0.04] }) // цоколь
    .add(box(0.94, 0.6, 0.03), 0x262d33, 6, { p: [0, 0.43, -0.05] }) // стекло (aFlag 6: тёмное днём, тёплый свет ночью)
    .add(box(0.98, 0.03, 0.1), 0x3a3c3e, 0, { p: [0, 0.745, -0.05] }) // рама сверху
    .add(box(0.98, 0.02, 0.1), 0x3a3c3e, 0, { p: [0, 0.125, -0.05] })
    .add(box(0.16, 0.6, 0.06), 0x24282c, 0, { p: [0, 0.43, -0.075] }) // дверь
    .add(box(1.0, 0.25, 0.16), 0x2a2c2e, 0, { p: [0, 0.875, -0.08] }) // короб вывески
    .build();
}

/** Лицевая плоскость вывески (UV для атласа): x ±0.5, y 0.765..0.985, z −0.165 (перед коробом). */
export function buildSignPlane(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(0.98, 0.21);
  g.rotateY(Math.PI); // лицом к −Z
  g.translate(0, 0.875, -0.162);
  return g;
}

/** Плоский квадрат-декаль x,z ∈ ±0.5 на y = 0, лицом вверх; uv 0..1. */
export function buildDecalQuad(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

// ---------------- пешеходная улица (Почтовая): docs/stage2/pochtovaya.md ----------------

const IRON = 0x1b1d1e, BRONZE = 0x6e4c2c, GRANITE = 0x6f6a66;

/**
 * Классический фонарь ~4.3 м (`lamp_classic`): чугунная опора с цоколем и кольцами, перекладина вдоль локальной Z
 * (вдоль ряда), два шестигранных фонаря-«лампы» (светятся ночью). Начало — основание.
 */
export function buildClassicLamp(): THREE.BufferGeometry {
  const b = new Builder()
    .add(cyl(0.2, 0.25, 0.55, 8), IRON, 0, { p: [0, 0.275, 0] })
    .add(cyl(0.12, 0.17, 0.25, 8), IRON, 0, { p: [0, 0.67, 0] })
    .add(cyl(0.06, 0.1, 2.8, 8), IRON, 0, { p: [0, 2.2, 0] })
    .add(cyl(0.1, 0.1, 0.07, 8), IRON, 0, { p: [0, 1.15, 0] })
    .add(cyl(0.09, 0.07, 0.12, 8), IRON, 0, { p: [0, 3.62, 0] })
    .add(box(0.05, 0.05, 1.0), IRON, 0, { p: [0, 3.68, 0] })
    .add(new THREE.ConeGeometry(0.06, 0.32, 6), IRON, 0, { p: [0, 3.9, 0] })
    .add(new THREE.SphereGeometry(0.045, 6, 4), IRON, 0, { p: [0, 4.08, 0] });
  for (const s of [-1, 1]) {
    b.add(box(0.035, 0.035, 0.42), IRON, 0, { p: [0, 3.5, s * 0.2], r: [s * 0.75, 0, 0] }) // кронштейн-завиток
      .add(cyl(0.045, 0.03, 0.08, 6), IRON, 0, { p: [0, 3.74, s * 0.48] })
      .add(cyl(0.13, 0.09, 0.36, 6), 0xfff1c8, FLAG.lamp, { p: [0, 3.96, s * 0.48] })
      .add(new THREE.ConeGeometry(0.18, 0.15, 6), IRON, 0, { p: [0, 4.215, s * 0.48] })
      .add(new THREE.SphereGeometry(0.03, 5, 3), IRON, 0, { p: [0, 4.31, s * 0.48] });
  }
  return b.build();
}

/** Чугунная приствольная решётка 1.4×1.4 м (`tree_grate`), верх +0.035 над основанием; дерево ставится отдельно. */
export function buildTreeGrate(): THREE.BufferGeometry {
  const b = new Builder().add(new THREE.PlaneGeometry(1.36, 1.36), 0x2a2219, 0, { p: [0, 0.012, 0], r: [-Math.PI / 2, 0, 0] });
  for (const s of [-1, 1]) {
    b.add(box(1.4, 0.03, 0.07), IRON, 0, { p: [0, 0.02, s * 0.665] }).add(box(0.07, 0.03, 1.4), IRON, 0, { p: [s * 0.665, 0.02, 0] })
      .add(box(0.9, 0.025, 0.04), IRON, 0, { p: [0, 0.022, s * 0.43] }).add(box(0.04, 0.025, 0.9), IRON, 0, { p: [s * 0.43, 0.022, 0] });
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2, r = 0.55;
    b.add(box(0.035, 0.022, 0.42), IRON, 0, { p: [Math.cos(a) * r * 0.75, 0.021, Math.sin(a) * r * 0.75], r: [0, -a + Math.PI / 2, 0] });
  }
  return b.build();
}

/** Киоск 2.6×2.0 м, высота ~2.5 м (`kiosk`): окно выдачи на −Z (светится ночью), козырёк; корпус тонируется цветом инстанса. */
export function buildKiosk(): THREE.BufferGeometry {
  return new Builder()
    .add(box(2.7, 0.12, 2.1), 0x5d5a55, 0, { p: [0, 0.06, 0] })
    .add(box(2.6, 2.25, 2.0), 0xffffff, FLAG.tint, { p: [0, 1.245, 0] })
    .add(box(2.9, 0.14, 2.35), 0x34383b, 0, { p: [0, 2.44, -0.05] })
    .add(box(2.0, 1.05, 0.04), 0x262d33, 6, { p: [0, 1.45, -1.01] })
    .add(box(2.2, 0.05, 0.3), 0x8a8f94, 0, { p: [0, 0.95, -1.13] })
    .add(box(2.4, 0.32, 0.05), 0xf2efe6, 0, { p: [0, 2.12, -1.03] })
    .add(box(2.7, 0.04, 0.75), 0xc8402e, 0, { p: [0, 2.05, -1.32], r: [-0.35, 0, 0] })
    .add(box(0.7, 1.9, 0.04), 0x4a4e52, 0, { p: [0.9, 1.07, 1.01] })
    .build();
}

/**
 * Модуль кафе-террасы 4×3 м (`cafe_terrace`): настил, ограждение-кашпо с трёх сторон (открыта к стене, локальная +Z),
 * два столика по 4 стула, два зонта (купол тонируется цветом инстанса). «Вперёд» −Z — от стены на улицу.
 */
export function buildCafeTerrace(): THREE.BufferGeometry {
  const DECK = 0x7a5a3e, RAIL = 0x2f3133, CHAIR = 0x3c3f42, TOP = 0xd8d4cc;
  const b = new Builder()
    .add(box(4.0, 0.1, 3.0), DECK, 0, { p: [0, 0.05, 0] })
    .add(box(4.0, 0.55, 0.3), RAIL, 0, { p: [0, 0.37, -1.35] })
    .add(box(0.3, 0.55, 2.4), RAIL, 0, { p: [-1.85, 0.37, 0.15] })
    .add(box(0.3, 0.55, 2.4), RAIL, 0, { p: [1.85, 0.37, 0.15] });
  // зелень в кашпо по переднему краю
  for (let i = 0; i < 7; i++) b.add(blob(0.24, 0, 40 + i, 0.8, 0.15), 0x3f6e2c, 0, { p: [-1.65 + i * 0.55, 0.72, -1.35] });
  for (const tx of [-0.95, 0.95]) {
    const tz = -0.15;
    b.add(cyl(0.035, 0.05, 0.72, 6), RAIL, 0, { p: [tx, 0.46, tz] })
      .add(cyl(0.42, 0.42, 0.035, 12), TOP, 0, { p: [tx, 0.83, tz] })
      .add(cyl(0.025, 0.025, 1.6, 5), 0xd0ccc4, 0, { p: [tx, 1.65, tz] })
      .add(new THREE.ConeGeometry(1.25, 0.45, 8, 1, true), 0xffffff, FLAG.tint, { p: [tx, 2.48, tz] })
      .add(new THREE.CircleGeometry(1.25, 8), 0xffffff, FLAG.tint, { p: [tx, 2.255, tz], r: [Math.PI / 2, 0, 0] });
    for (const [dx, dz, ry] of [[0, -0.62, 0], [0, 0.62, Math.PI], [-0.62, 0, Math.PI / 2], [0.62, 0, -Math.PI / 2]] as const) {
      b.add(box(0.42, 0.05, 0.42), CHAIR, 0, { p: [tx + dx, 0.55, tz + dz], r: [0, ry, 0] })
        .add(box(0.42, 0.42, 0.04), CHAIR, 0, { p: [tx + dx * 1.33, 0.78, tz + dz * 1.33], r: [0, ry, 0] })
        .add(box(0.36, 0.45, 0.36), 0x2a2c2e, 0, { p: [tx + dx, 0.32, tz + dz], r: [0, ry, 0], s: [1, 1, 1] });
    }
  }
  return b.build();
}

/**
 * Городские скульптуры-заглушки (`street_sculpture`), бронза на граните: 0 figure — фигура человека (~1.8 м),
 * 1 mushroom — гриб-боровичок, 2 marker — памятный знак (стела + бронзовый диск в мостовой). «Вперёд» −Z — к оси улицы.
 */
export function buildStreetSculptures(): THREE.BufferGeometry[] {
  const fig = new Builder()
    .add(box(0.9, 0.35, 0.9), GRANITE, 0, { p: [0, 0.175, 0] })
    .add(cyl(0.09, 0.11, 0.85, 7), BRONZE, 0, { p: [-0.12, 0.775, 0] })
    .add(cyl(0.09, 0.11, 0.85, 7), BRONZE, 0, { p: [0.12, 0.775, 0.05] })
    .add(cyl(0.2, 0.24, 0.7, 8), BRONZE, 0, { p: [0, 1.5, 0] })
    .add(new THREE.SphereGeometry(0.14, 10, 8), BRONZE, 0, { p: [0, 2.0, -0.02] })
    .add(cyl(0.16, 0.16, 0.06, 10), BRONZE, 0, { p: [0, 2.12, -0.02] }) // картуз
    .add(cyl(0.05, 0.06, 0.62, 6), BRONZE, 0, { p: [-0.3, 1.55, -0.12], r: [0.5, 0, 0.25] })
    .add(cyl(0.05, 0.06, 0.62, 6), BRONZE, 0, { p: [0.3, 1.5, -0.1], r: [0.35, 0, -0.3] })
    .add(box(0.5, 0.06, 0.3), BRONZE, 0, { p: [0.42, 1.25, -0.35] }); // атрибут в руке (весы, книга…)
  const mush = new Builder()
    .add(cyl(0.6, 0.65, 0.2, 10), GRANITE, 0, { p: [0, 0.1, 0] })
    .add(cyl(0.22, 0.3, 0.75, 10), BRONZE, 0, { p: [0, 0.57, 0] })
    .add(new THREE.SphereGeometry(0.62, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), BRONZE, 0, { p: [0, 0.9, 0], s: [1, 0.6, 1] })
    .add(new THREE.SphereGeometry(0.09, 8, 6), BRONZE, 0, { p: [0.08, 0.62, -0.26] }) // «лицо» боровичка
    .add(new THREE.SphereGeometry(0.06, 6, 4), BRONZE, 0, { p: [0.24, 0.45, -0.18] });
  const mark = new Builder()
    .add(cyl(0.65, 0.65, 0.02, 20), BRONZE, 0, { p: [0, 0.012, 0] })
    .add(box(0.45, 1.25, 0.25), GRANITE, 0, { p: [0, 0.625, 0.9] })
    .add(box(0.3, 0.3, 0.02), BRONZE, 0, { p: [0, 0.85, 0.77] });
  return [fig.build(), mush.build(), mark.build()];
}
