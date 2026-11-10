import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PART, vehicleMaterial, type VehicleKind, type VehicleModel } from './models';
import { applySurfaceWeather, encodeCap, vehicleSnowCap } from '../render/weather';

/**
 * glTF-модели машин (docs/stage2/models.md): манифест game/public/assets/vehicles/vehicles.json, сборка —
 * assets/scripts/vehicles/. Модели заменяют процедурные постепенно: вид машины (VehicleKind), для которого в манифесте
 * есть хотя бы одна модель с ролью 'traffic', рисуется glTF-слоем, остальные — как раньше (render.ts).
 *
 * Контракт файла: +Y вверх, перёд −Z, метры, начало — на земле между осями. Узел body (материалы по ролям: paint, glass,
 * headlight, taillight, brakelight, indicator, beacon, sign, прочее), узел wheel — правое колесо в начале координат
 * (ось X, наружу +X; левые — поворот на π вокруг Y). LOD1 — один узел body (колёса вмурованы). Текстура — один атлас.
 */

export interface VehicleEntry {
  id: string; name: string; kind: VehicleKind | string; roles: string[];
  /** Вес среди моделей вида в трафике; parkedWeight — множитель доли на парковке. */
  weight?: number; parkedWeight?: number;
  file: string; lod1: string;
  dims: { length: number; width: number; height: number };
  bodyCenterZ: number; wheelbase: number | null; track: number | null;
  wheelRadius: number | null; wheelWidth: number | null; wheels: [number, number, number][] | null;
  tris: { lod0: number; lod1: number; body: number; wheel: number };
  paint: { fixed?: string; variants?: string[] | null };
  license: string; author: string; authorUrl?: string; url: string;
}

export interface GltfVehicleModel {
  entry: VehicleEntry;
  /** Кузов LOD0: position, normal, uv, color (белый), aPart. Начало — на земле между осями. */
  body: THREE.BufferGeometry;
  /** Колесо-шаблон (правое), null — колёса вмурованы в кузов. */
  wheel: THREE.BufferGeometry | null;
  /** LOD1 (колёса вмурованы). */
  far: THREE.BufferGeometry;
  map: THREE.Texture | null;
  farMap: THREE.Texture | null;
  wheels: [number, number, number][];
  wheelRadius: number;
}

const ROLE_PART: Record<string, number> = {
  paint: PART.paint, glass: PART.glass, headlight: PART.head, taillight: PART.tail, brakelight: PART.tail,
  beacon: PART.beacon, sign: PART.sign,
};

let _loader: GLTFLoader | null = null;
function loader(): GLTFLoader {
  if (!_loader) { _loader = new GLTFLoader(); _loader.setMeshoptDecoder(MeshoptDecoder); }
  return _loader;
}

/** Атрибут → Float32 (снимает квантование/нормализацию/интерливинг meshopt). */
function toFloat(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number): THREE.Float32BufferAttribute {
  const out = new Float32Array(a.count * size);
  for (let i = 0; i < a.count; i++) {
    out[i * size] = a.getX(i);
    if (size > 1) out[i * size + 1] = a.getY(i);
    if (size > 2) out[i * size + 2] = a.getZ(i);
  }
  return new THREE.Float32BufferAttribute(out, size);
}

const roleOf = (name: string) => name.replace(/(\.\d+|_\d+)$/, '').toLowerCase();

/**
 * Узлы glb → геометрии по именам узлов верхнего уровня ('body', 'wheel'): мировые матрицы и трансформ UV (KHR_texture_transform)
 * запекаются в вершины, примитивы сливаются, aPart — по имени материала.
 */
function extract(scene: THREE.Object3D): { geos: Map<string, THREE.BufferGeometry>; map: THREE.Texture | null } {
  scene.updateMatrixWorld(true);
  const parts = new Map<string, THREE.BufferGeometry[]>();
  let map: THREE.Texture | null = null;
  const uvm = new THREE.Matrix3();
  const nm = new THREE.Matrix3();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    let n: THREE.Object3D | null = mesh;
    let node = '';
    while (n) { if (n.name === 'body' || n.name === 'wheel') { node = n.name; break; } n = n.parent; }
    if (!node) node = 'body';
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const src = mesh.geometry;
    const g = new THREE.BufferGeometry();
    const P = toFloat(src.getAttribute('position'), 3);
    P.applyMatrix4(mesh.matrixWorld);
    g.setAttribute('position', P);
    const srcN = src.getAttribute('normal');
    if (srcN) {
      const N = toFloat(srcN, 3);
      nm.getNormalMatrix(mesh.matrixWorld);
      N.applyNormalMatrix(nm);
      g.setAttribute('normal', N);
    }
    const srcUv = src.getAttribute('uv');
    const uv = srcUv ? toFloat(srcUv, 2) : new THREE.Float32BufferAttribute(new Float32Array(P.count * 2), 2);
    if (mat.map) {
      map ??= mat.map;
      mat.map.updateMatrix();
      uvm.copy(mat.map.matrix);
      const v = new THREE.Vector3();
      for (let i = 0; i < uv.count; i++) {
        v.set(uv.getX(i), uv.getY(i), 1).applyMatrix3(uvm);
        uv.setXY(i, v.x, v.y);
      }
    }
    g.setAttribute('uv', uv);
    if (src.index) g.setIndex(Array.from(src.index.array as ArrayLike<number>));
    else g.setIndex(Array.from({ length: P.count }, (_, i) => i));
    if (!srcN) g.computeVertexNormals();
    const role = roleOf(mat.name || '');
    const part = new Float32Array(P.count);
    const col = new Float32Array(P.count * 3).fill(1);
    for (let i = 0; i < P.count; i++) {
      part[i] = role === 'indicator' ? (P.getX(i) < 0 ? PART.indL : PART.indR) : ROLE_PART[role] ?? PART.fixed;
    }
    // без текстуры — цвет материала в вершинах
    if (!mat.map && mat.color) for (let i = 0; i < P.count; i++) { col[i * 3] = mat.color.r; col[i * 3 + 1] = mat.color.g; col[i * 3 + 2] = mat.color.b; }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
    let l = parts.get(node);
    if (!l) parts.set(node, (l = []));
    l.push(g);
  });
  const geos = new Map<string, THREE.BufferGeometry>();
  for (const [k, l] of parts) {
    const g = l.length === 1 ? l[0] : mergeGeometries(l, false);
    if (!g) continue;
    g.computeBoundingSphere();
    geos.set(k, g);
  }
  return { geos, map };
}

/** Библиотека glTF-машин: манифест + геометрии. load() → null, если манифеста нет. */
export class VehicleLibrary {
  readonly models: GltfVehicleModel[] = [];

  static async load(base = `${import.meta.env.BASE_URL}assets/vehicles/`): Promise<VehicleLibrary | null> {
    const params = new URLSearchParams(location.search);
    if (params.get('vehicles') === 'proc') return null;
    let man: { models: VehicleEntry[] };
    try {
      const r = await fetch(base + 'vehicles.json');
      if (!r.ok) return null;
      man = await r.json();
    } catch { return null; }
    const only = params.get('vehicles')?.split(',').filter(Boolean);
    const lib = new VehicleLibrary();
    await Promise.all(man.models.filter((e) => !only || only.includes(e.id)).map(async (e) => {
      try {
        const [a, b] = await Promise.all([loader().loadAsync(base + e.file), loader().loadAsync(base + e.lod1)]);
        const A = extract(a.scene), B = extract(b.scene);
        const body = A.geos.get('body'), far = B.geos.get('body');
        if (!body || !far) throw new Error('нет узла body');
        lib.models.push({
          entry: e, body, wheel: A.geos.get('wheel') ?? null, far, map: A.map, farMap: B.map,
          wheels: e.wheels ?? [], wheelRadius: e.wheelRadius ?? 0.3,
        });
      } catch (err) {
        console.warn(`[vehicles] ${e.id}: не загрузилась, остаётся процедурная`, err);
      }
    }));
    lib.models.sort((x, y) => x.entry.id.localeCompare(y.entry.id));
    console.info(`[vehicles] glTF: ${lib.models.map((m) => `${m.entry.id}(${m.entry.kind})`).join(', ') || 'нет'}`);
    return lib;
  }

  withRole(role: string): GltfVehicleModel[] { return this.models.filter((m) => m.entry.roles.includes(role)); }
}

// ---------------------------------------------------------------- трафик

interface Variant {
  md: GltfVehicleModel;
  near: THREE.InstancedMesh; nearLamp: THREE.InstancedBufferAttribute;
  shadow: THREE.InstancedMesh; shadowLamp: THREE.InstancedBufferAttribute;
  far: THREE.InstancedMesh; farLamp: THREE.InstancedBufferAttribute;
  wheels: THREE.InstancedMesh | null;
  /** Сдвиг модели вдоль её оси Z, чтобы задняя ось совпала с задней осью процедурной модели вида (кинематика sim). */
  dz: number;
  /** Колёса со сдвигом dz. */
  wpos: [number, number, number][];
}

/** Что нужно слою от машины симуляции (SimVehicle). */
export interface TrafficVehicleLike {
  id: number; kind: VehicleKind; color: number; brake: boolean; ind: number; beacon: boolean;
  spin: number; steer: number; crashed: boolean;
}

/**
 * Слой glTF-машин трафика: на модель — InstancedMesh ближний / ближний с тенью / дальний (LOD1) + колёса.
 * Вызовы: begin() → push() на каждую машину вида, для которого has(kind) → end(). Матрицы считает render.ts.
 */
export class GltfTrafficLayer {
  readonly root = new THREE.Group();
  private byKind = new Map<VehicleKind, { list: Variant[]; total: number; cum: number[] }>();
  private variants: Variant[] = [];
  private col = new THREE.Color();

  constructor(lib: VehicleLibrary, procModels: Record<VehicleKind, VehicleModel>, cap: number, envMap?: THREE.Texture | null) {
    this.root.name = 'traffic_gltf';
    const mats = new Map<THREE.Texture | null, THREE.Material>();
    const matFor = (map: THREE.Texture | null) => {
      let m = mats.get(map);
      if (!m) {
        const mm = applySurfaceWeather(vehicleMaterial(envMap), 'car_paint'); // погода (render/weather.ts)
        if (map) { mm.map = map; map.colorSpace = THREE.SRGBColorSpace; }
        mats.set(map, (m = mm));
      }
      return m;
    };
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number, shadow: boolean) => {
      const g = new THREE.BufferGeometry();
      for (const [k, a] of Object.entries(geo.attributes)) g.setAttribute(k, a);
      g.index = geo.index;
      const lamp = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      lamp.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aLamp', lamp);
      const im = new THREE.InstancedMesh(g, mat, n);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.castShadow = shadow; im.receiveShadow = shadow;
      im.count = 0;
      this.root.add(im);
      return { im, lamp };
    };
    for (const md of lib.withRole('traffic')) {
      const kind = md.entry.kind as VehicleKind;
      const proc = procModels[kind];
      if (!proc) continue;
      const big = kind === 'liaz' || kind === 'trolleybus' || kind === 'paz';
      const n = big ? 64 : cap;
      const pzr = Math.max(...proc.wheels.map((w) => w[2]));
      const gzr = md.wheels.length ? Math.max(...md.wheels.map((w) => w[2])) : (md.entry.wheelbase ?? 2.6) / 2;
      const dz = pzr - gzr;
      const body = md.body.clone().translate(0, 0, dz), far = md.far.clone().translate(0, 0, dz);
      const a = mk(body, matFor(md.map), n, false), s = mk(body, matFor(md.map), Math.min(n, 48), true), f = mk(far, matFor(md.farMap), n, false);
      const w = md.wheel && md.wheels.length ? mk(md.wheel, matFor(md.map), n * md.wheels.length, true).im : null;
      const v: Variant = {
        md, near: a.im, nearLamp: a.lamp, shadow: s.im, shadowLamp: s.lamp, far: f.im, farLamp: f.lamp, wheels: w, dz,
        wpos: md.wheels.map(([x, y, z]) => [x, y, z + dz] as [number, number, number]),
      };
      this.variants.push(v);
      let k = this.byKind.get(kind);
      if (!k) this.byKind.set(kind, (k = { list: [], total: 0, cum: [] }));
      k.list.push(v); k.total += md.entry.weight ?? 1; k.cum.push(k.total);
    }
  }

  get kinds(): VehicleKind[] { return [...this.byKind.keys()]; }
  has(kind: VehicleKind): boolean { return this.byKind.has(kind); }
  /** Какой glTF-моделью нарисована машина (GTA-режим: угнанная машина трафика выглядит так же); null — процедурная. */
  modelFor(v: { id: number; kind: VehicleKind }): GltfVehicleModel | null {
    return this.pick(v as TrafficVehicleLike)?.md ?? null;
  }

  begin(): void {
    for (const v of this.variants) { v.near.count = 0; v.shadow.count = 0; v.far.count = 0; if (v.wheels) v.wheels.count = 0; }
  }

  private pick(v: TrafficVehicleLike): Variant | null {
    const k = this.byKind.get(v.kind);
    if (!k) return null;
    if (k.list.length === 1) return k.list[0];
    const h = ((Math.imul(v.id, 2654435761) >>> 0) / 4294967296) * k.total;
    for (let i = 0; i < k.cum.length; i++) if (h < k.cum[i]) return k.list[i];
    return k.list[k.list.length - 1];
  }

  /**
   * m — матрица по дороге (колёса), B — кузов с тангажом/креном (оба column-major, 16). procWheelR — радиус колеса
   * процедурной модели (по нему накоплен v.spin). Возвращает false, если нет места (машина не рисуется).
   */
  push(v: TrafficVehicleLike, m: Float32Array, B: Float32Array, isNear: boolean, shadowOk: boolean, headlights: number, procWheelR: number): boolean {
    const V = this.pick(v);
    if (!V) return false;
    const withShadow = isNear && shadowOk && V.shadow.count < V.shadow.instanceMatrix.count;
    const im = withShadow ? V.shadow : isNear ? V.near : V.far;
    const lamp = withShadow ? V.shadowLamp : isNear ? V.nearLamp : V.farLamp;
    const i = im.count;
    if (i >= im.instanceMatrix.count) return false;
    im.instanceMatrix.array.set(B, i * 16);
    const fixed = V.md.entry.paint.fixed;
    this.col.set(fixed ?? v.color);
    im.instanceColor!.setXYZ(i, this.col.r, this.col.g, this.col.b);
    lamp.setXYZ(i, headlights, v.brake ? 1 : 0, (v.beacon ? 3 : v.ind) + encodeCap(vehicleSnowCap(v))); // + снежная шапка
    im.count = i + 1;
    const W = V.wheels;
    if (!isNear || !W) return true;
    const spin = (v.spin * procWheelR) / V.md.wheelRadius;
    const c = Math.cos(spin), s = Math.sin(spin);
    const sc = Math.cos(v.steer), ss = Math.sin(v.steer);
    const A = W.instanceMatrix.array as Float32Array;
    const front = Math.min(...V.wpos.map((w) => w[2])) + 0.5;
    for (const [wx, wy, wz] of V.wpos) {
      const wi = W.count;
      if (wi >= W.instanceMatrix.count) break;
      let X0 = m[0], X1 = m[1], X2 = m[2], Z0 = m[8], Z1 = m[9], Z2 = m[10];
      if (wz < front && !v.crashed) {
        const nX0 = X0 * sc - Z0 * ss, nX1 = X1 * sc - Z1 * ss, nX2 = X2 * sc - Z2 * ss;
        Z0 = X0 * ss + Z0 * sc; Z1 = X1 * ss + Z1 * sc; Z2 = X2 * ss + Z2 * sc;
        X0 = nX0; X1 = nX1; X2 = nX2;
      }
      let sx = s;
      if (wx < 0) { X0 = -X0; X1 = -X1; X2 = -X2; Z0 = -Z0; Z1 = -Z1; Z2 = -Z2; sx = -s; } // левое: Ry(π), вращение в другую сторону
      const o = wi * 16;
      A[o] = X0; A[o + 1] = X1; A[o + 2] = X2; A[o + 3] = 0;
      A[o + 4] = m[4] * c + Z0 * sx; A[o + 5] = m[5] * c + Z1 * sx; A[o + 6] = m[6] * c + Z2 * sx; A[o + 7] = 0;
      A[o + 8] = -m[4] * sx + Z0 * c; A[o + 9] = -m[5] * sx + Z1 * c; A[o + 10] = -m[6] * sx + Z2 * c; A[o + 11] = 0;
      A[o + 12] = m[0] * wx + m[4] * wy + m[8] * wz + m[12];
      A[o + 13] = m[1] * wx + m[5] * wy + m[9] * wz + m[13];
      A[o + 14] = m[2] * wx + m[6] * wy + m[10] * wz + m[14];
      A[o + 15] = 1;
      W.count = wi + 1;
    }
    return true;
  }

  end(): void {
    for (const v of this.variants) {
      if (v.wheels) v.wheels.visible = v.wheels.count > 0;
      for (const [im, lamp] of [[v.near, v.nearLamp], [v.shadow, v.shadowLamp], [v.far, v.farLamp]] as const) {
        im.visible = im.count > 0;
        if (!im.count) continue;
        im.instanceMatrix.clearUpdateRanges(); im.instanceMatrix.addUpdateRange(0, im.count * 16); im.instanceMatrix.needsUpdate = true;
        im.instanceColor!.clearUpdateRanges(); im.instanceColor!.addUpdateRange(0, im.count * 3); im.instanceColor!.needsUpdate = true;
        lamp.clearUpdateRanges(); lamp.addUpdateRange(0, im.count * 3); lamp.needsUpdate = true;
      }
      const W = v.wheels;
      if (W && W.count) {
        W.instanceMatrix.clearUpdateRanges(); W.instanceMatrix.addUpdateRange(0, W.count * 16); W.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Статистика для отладки: модель → (ближние, дальние). */
  stats(): Record<string, [number, number]> {
    const r: Record<string, [number, number]> = {};
    for (const v of this.variants) r[v.md.entry.id] = [v.near.count + v.shadow.count, v.far.count];
    return r;
  }
}
