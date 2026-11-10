import * as THREE from 'three';

/**
 * Растр покрытий тайла 0.5 м (500×500): что лежит в точке — дорога, тротуар, площадка `areas` какого типа, здание
 * (с архетипом), вода или «голый» рельеф. Строится на CPU из сырой glTF-сцены тайла до её переработки (city-world).
 * Нужен траве (где расти), оградам (стиль по окружению) и мелким деталям.
 */

export const SURF = {
  terrain: 0, road: 1, sidewalk: 2, parking: 3, paving: 4, path: 5, playground: 6, grass: 7, dirt: 8, water: 14,
  /** здания: BUILDING + архетип (ARCH_IDS в building-material.ts, 0..15) */
  building: 16,
} as const;

const AREA_CODE: Record<string, number> = {
  area_parking: SURF.parking, area_paving: SURF.paving, area_path: SURF.path,
  area_playground: SURF.playground, area_grass: SURF.grass, area_dirt: SURF.dirt,
  area_paving_pedestrian: SURF.paving, // пешеходная улица — для травы/оград это та же плитка
};
const LEGACY_ARCH: Record<string, number> = { building_apartments: 1, building_house: 7, building_commercial: 9, building_garage: 10, building_other: 0 };

export const SURF_RES = 0.5;
export const SURF_N = 500;

export interface TileSurface {
  minX: number; minZ: number;
  /** коды SURF, строка = z, столбец = x */
  code: Uint8Array;
}

/** Порядок важен: позже — главнее. */
const NODE_ORDER = ['areas', 'water', 'roads', 'sidewalks', 'buildings'];

export function captureSurface(scene: THREE.Object3D, def: { minX: number; minZ: number }): TileSurface {
  const code = new Uint8Array(SURF_N * SURF_N);
  scene.updateMatrixWorld(true);
  const byNode = new Map<string, THREE.Mesh[]>();
  for (const node of scene.children) {
    const list: THREE.Mesh[] = [];
    node.traverse((o) => { if ((o as THREE.Mesh).isMesh) list.push(o as THREE.Mesh); });
    byNode.set(node.name, list);
  }
  const v = new THREE.Vector3();
  for (const name of NODE_ORDER) {
    for (const mesh of byNode.get(name) ?? []) {
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material).name;
      let fixed = -1;
      if (name === 'areas') fixed = AREA_CODE[mat] ?? -1;
      else if (name === 'water') fixed = SURF.water;
      else if (name === 'roads') fixed = SURF.road;
      else if (name === 'sidewalks') fixed = mat === 'curb' ? -1 : SURF.sidewalk;
      else if (name === 'buildings') fixed = SURF.building + (LEGACY_ARCH[mat] ?? 0);
      if (fixed < 0) continue;
      const g = mesh.geometry;
      const P = g.getAttribute('position');
      const arch = name === 'buildings' ? g.getAttribute('_arch') : null;
      const n = P.count;
      const xs = new Float32Array(n), zs = new Float32Array(n);
      const ident = mesh.matrixWorld.equals(new THREE.Matrix4());
      for (let i = 0; i < n; i++) {
        if (ident) { xs[i] = P.getX(i); zs[i] = P.getZ(i); } else { v.fromBufferAttribute(P, i).applyMatrix4(mesh.matrixWorld); xs[i] = v.x; zs[i] = v.z; }
      }
      const idx = g.index;
      const tri = idx ? idx.count / 3 : n / 3;
      for (let t = 0; t < tri; t++) {
        const a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        const c0 = arch ? SURF.building + Math.min(15, Math.max(0, Math.round(arch.getX(a)))) : fixed;
        rasterTri(code, def.minX, def.minZ, xs[a], zs[a], xs[b], zs[b], xs[c], zs[c], c0);
      }
    }
  }
  return { minX: def.minX, minZ: def.minZ, code };
}

/** Заливка треугольника по центрам ячеек (вырожденные — стены зданий — пропускаются). */
function rasterTri(code: Uint8Array, ox: number, oz: number, ax: number, az: number, bx: number, bz: number, cx: number, cz: number, val: number): void {
  const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  if (Math.abs(area) < 1e-4) return;
  const k = 1 / SURF_RES;
  const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - ox) * k)), i1 = Math.min(SURF_N - 1, Math.floor((Math.max(ax, bx, cx) - ox) * k));
  const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - oz) * k)), j1 = Math.min(SURF_N - 1, Math.floor((Math.max(az, bz, cz) - oz) * k));
  if (i0 > i1 || j0 > j1) return;
  const s = area > 0 ? 1 : -1;
  for (let j = j0; j <= j1; j++) {
    const pz = oz + (j + 0.5) * SURF_RES;
    for (let i = i0; i <= i1; i++) {
      const px = ox + (i + 0.5) * SURF_RES;
      const w0 = ((bx - px) * (cz - pz) - (bz - pz) * (cx - px)) * s;
      const w1 = ((cx - px) * (az - pz) - (cz - pz) * (ax - px)) * s;
      const w2 = ((ax - px) * (bz - pz) - (az - pz) * (bx - px)) * s;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) code[j * SURF_N + i] = val;
    }
  }
}

/** Код в мировой точке (вне тайла — −1). */
export function surfAt(s: TileSurface, x: number, z: number): number {
  const i = Math.floor((x - s.minX) / SURF_RES), j = Math.floor((z - s.minZ) / SURF_RES);
  if (i < 0 || j < 0 || i >= SURF_N || j >= SURF_N) return -1;
  return s.code[j * SURF_N + i];
}

/** Гистограмма кодов в круге радиуса r (шаг 2 м) — для выбора стиля ограды по окружению. */
export function surfHistogram(s: TileSurface, x: number, z: number, r: number): Uint16Array {
  const h = new Uint16Array(32);
  for (let dz = -r; dz <= r; dz += 2) for (let dx = -r; dx <= r; dx += 2) {
    if (dx * dx + dz * dz > r * r) continue;
    const c = surfAt(s, x + dx, z + dz);
    if (c >= 0) h[c]++;
  }
  return h;
}
