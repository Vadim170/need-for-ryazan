import * as THREE from 'three';

/**
 * Карта покрова по спутнику (пайплайн: pipeline/build_landcover.py, docs/stage3/landcover.md):
 * public/world-veg/landcover.png — 2 м/пикс., серый 8 бит = код класса, строка 0 = север (min z), столбец 0 = min x.
 *
 * Используют: рельеф (materials.ts — цвет земли: луг, газон, огород, грунт, песок, щебень, подстилка под кронами),
 * трава (grass.ts — плотность/высота/вид), погода берёт сезон из weatherUniforms. Карты нет — всё как раньше.
 */

export const LC = {
  none: 0, canopy: 1, conifer: 2, thicket: 3, meadow: 4, lawn: 5, garden: 6, bare: 7, sand: 8, gravel: 9, water: 10, paved: 11, building: 12,
} as const;

export interface LandcoverMap { cell: number; cols: number; rows: number; minX: number; minZ: number; data: Uint8Array }

/** Текстура классов (R8, nearest) + окно: (minX, minZ, cell, 1 — карта загружена). */
const empty = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
empty.needsUpdate = true;
export const landcoverUniforms = {
  uLc: { value: empty as THREE.Texture },
  uLcInfo: { value: new THREE.Vector4(0, 0, 2, 0) },
  uLcSize: { value: new THREE.Vector2(1, 1) },
};

let pending: Promise<LandcoverMap | null> | null = null;

/** Один раз на страницу: карта (или null, если файла нет). */
export function loadLandcover(): Promise<LandcoverMap | null> {
  pending ??= (async () => {
    try {
      const r = await fetch('/world-veg/landcover.json');
      if (!r.ok) return null;
      const meta = await r.json();
      const img = new Image();
      img.src = '/world-veg/landcover.png';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = meta.cols; c.height = meta.rows;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const rgba = ctx.getImageData(0, 0, meta.cols, meta.rows).data;
      const data = new Uint8Array(meta.cols * meta.rows);
      for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
      const tex = new THREE.DataTexture(data, meta.cols, meta.rows, THREE.RedFormat, THREE.UnsignedByteType);
      tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.flipY = false;
      tex.needsUpdate = true;
      landcoverUniforms.uLc.value = tex;
      landcoverUniforms.uLcInfo.value.set(meta.minX, meta.minZ, meta.cell, 1);
      landcoverUniforms.uLcSize.value.set(meta.cols, meta.rows);
      return { cell: meta.cell, cols: meta.cols, rows: meta.rows, minX: meta.minX, minZ: meta.minZ, data };
    } catch {
      return null;
    }
  })();
  return pending;
}

/** Класс в мировой точке (x, z игры); вне карты — LC.none. */
export function lcAt(m: LandcoverMap, x: number, z: number): number {
  const i = Math.floor((x - m.minX) / m.cell), j = Math.floor((z - m.minZ) / m.cell);
  if (i < 0 || j < 0 || i >= m.cols || j >= m.rows) return LC.none;
  return m.data[j * m.cols + i];
}

/**
 * GLSL: веса классов земли в точке p (мир xz) — билинейно по 4 соседним ячейкам (с дрожанием по шуму, чтобы не было
 * «лесенки» 2 м). wA = (луг, газон, огород, грунт), wB = (песок, щебень/асфальт вне OSM, подстилка под кронами, заросли).
 * Сумма wA + wB ≤ 1; остаток — «как раньше» (класс неизвестен / вода / здание).
 */
export const LANDCOVER_GLSL = /* glsl */ `
uniform highp sampler2D uLc; uniform vec4 uLcInfo; uniform vec2 uLcSize;
void nfrLcOne(float c, float w, inout vec4 wA, inout vec4 wB) {
  if (c < 0.5) return;
  if (c < 2.5) wB.z += w;            // кроны (лиственные/хвойные) → подстилка
  else if (c < 3.5) wB.w += w;       // заросли
  else if (c < 4.5) wA.x += w;       // луг
  else if (c < 5.5) wA.y += w;       // газон
  else if (c < 6.5) wA.z += w;       // огород
  else if (c < 7.5) wA.w += w;       // грунт
  else if (c < 8.5) wB.x += w;       // песок
  else if (c < 9.5 || (c > 10.5 && c < 11.5)) wB.y += w;   // щебень / асфальт вне OSM (дворовые проезды, промплощадки)
}
void nfrLandcover(vec2 p, float jit, out vec4 wA, out vec4 wB) {
  wA = vec4(0.0); wB = vec4(0.0);
  if (uLcInfo.w < 0.5) return;
  vec2 f = (p - uLcInfo.xy) / uLcInfo.z - 0.5 + (jit - 0.5) * 0.9;
  vec2 i = floor(f), t = f - i;
  t = smoothstep(0.15, 0.85, t);
  ivec2 mx = ivec2(uLcSize) - 1;
  float c00 = texelFetch(uLc, clamp(ivec2(i), ivec2(0), mx), 0).r * 255.0;
  float c10 = texelFetch(uLc, clamp(ivec2(i) + ivec2(1, 0), ivec2(0), mx), 0).r * 255.0;
  float c01 = texelFetch(uLc, clamp(ivec2(i) + ivec2(0, 1), ivec2(0), mx), 0).r * 255.0;
  float c11 = texelFetch(uLc, clamp(ivec2(i) + ivec2(1, 1), ivec2(0), mx), 0).r * 255.0;
  nfrLcOne(c00, (1.0 - t.x) * (1.0 - t.y), wA, wB);
  nfrLcOne(c10, t.x * (1.0 - t.y), wA, wB);
  nfrLcOne(c01, (1.0 - t.x) * t.y, wA, wB);
  nfrLcOne(c11, t.x * t.y, wA, wB);
}
`;
