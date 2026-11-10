import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { quality } from './quality';

/**
 * PBR-текстуры мира (CC0, Poly Haven; сборка — scripts/build-textures.mjs, docs/stage3/realism.md).
 *
 * Три KTX2-массива (2D array, UASTC → ASTC/BC7 на GPU, мипмапы): альбедо (sRGB), нормали (GL), ORM (R — AO,
 * G — шероховатость, B — высота). Слои — `LAYER` (тот же порядок, что LAYERS в скрипте сборки).
 *
 * Принцип «цвет из реальности»: альбедо нормируется на средний цвет слоя (`uNfrTexAvg`) — текстура даёт только
 * фактуру/вариацию (≈1 в среднем), а базовый тон задаёт материал (цвета фасадов из панорам, тон асфальта, плитки…).
 * Так же нормируется шероховатость. Пока массивы не загрузились — нейтральные заглушки 1×1 (шейдеры не
 * перекомпилируются при подмене: тип sampler2DArray тот же).
 */

export const LAYER_NAMES = [
  'asphalt', 'asphalt_fresh', 'asphalt_patch', 'concrete', 'concrete_stained', 'grass', 'meadow', 'dirt', 'gravel',
  'brick_red', 'brick_white', 'plaster', 'stucco', 'roof_galv', 'roof_slate', 'roof_profile', 'metal_painted',
  'metal_rust', 'shutter', 'wood', 'bark', 'bark_pine',
] as const;
export type LayerName = typeof LAYER_NAMES[number];
export const LAYER = Object.fromEntries(LAYER_NAMES.map((n, i) => [n, i])) as Record<LayerName, number>;
const NL = LAYER_NAMES.length;

function placeholder(r: number, g: number, b: number, srgb: boolean): THREE.DataArrayTexture {
  const d = new Uint8Array(NL * 4);
  for (let i = 0; i < NL; i++) d.set([r, g, b, 255], i * 4);
  const t = new THREE.DataArrayTexture(d, 1, 1, NL);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const PH_AVG = 0.2158; // sRGB 128 → linear

/** Общие uniform-ы текстур (кладутся в shader.uniforms всех материалов мира). */
export const texUniforms = {
  tNfrAlb: { value: placeholder(128, 128, 128, true) as THREE.Texture },
  tNfrNrm: { value: placeholder(128, 128, 255, false) as THREE.Texture },
  tNfrOrm: { value: placeholder(255, 128, 128, false) as THREE.Texture },
  /** (средний цвет альбедо linear rgb, средняя шероховатость). */
  uNfrTexAvg: { value: Array.from({ length: NL }, () => new THREE.Vector4(PH_AVG, PH_AVG, PH_AVG, 0.5)) },
  /** (1/ширина м, 1/высота м, 0, 0) — повтор текстуры в метрах. */
  uNfrTexScale: { value: Array.from({ length: NL }, () => new THREE.Vector4(0.5, 0.5, 0, 0)) },
  /** 0..1: анти-тайлинг вторым сэмплом и детальные нормали (пресет качества). */
  uNfrTexDetail: { value: quality.textureDetail },
  /** 1, когда текстуры загружены. */
  uNfrTexReady: { value: 0 },
};

interface Manifest { layers: { name: string; size: [number, number]; avg: [number, number, number]; rough: number }[]; files: Record<'albedo' | 'normal' | 'orm', string> }

let started: Promise<void> | null = null;

/** Загрузить массивы текстур (один раз). Ошибка — остаются заглушки (процедурный вид). */
export function loadWorldTextures(renderer: THREE.WebGLRenderer, base = '/assets/textures/'): Promise<void> {
  if (started) return started;
  if (new URLSearchParams(location.search).get('textures') === '0') return (started = Promise.resolve());
  started = (async () => {
    const t0 = performance.now();
    const man = (await (await fetch(base + 'manifest.json')).json()) as Manifest;
    const loader = new KTX2Loader().setTranscoderPath('/assets/basis/').detectSupport(renderer);
    const [alb, nrm, orm] = await Promise.all([
      loader.loadAsync(base + man.files.albedo), loader.loadAsync(base + man.files.normal), loader.loadAsync(base + man.files.orm),
    ]);
    loader.dispose();
    const aniso = Math.min(quality.anisotropy, renderer.capabilities.getMaxAnisotropy());
    for (const t of [alb, nrm, orm]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = aniso;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
    }
    alb.colorSpace = THREE.SRGBColorSpace;
    nrm.colorSpace = orm.colorSpace = THREE.NoColorSpace;
    for (const l of man.layers) {
      const i = LAYER[l.name as LayerName];
      if (i === undefined) continue;
      texUniforms.uNfrTexAvg.value[i].set(Math.max(l.avg[0], 0.01), Math.max(l.avg[1], 0.01), Math.max(l.avg[2], 0.01), Math.max(l.rough, 0.05));
      texUniforms.uNfrTexScale.value[i].set(1 / l.size[0], 1 / l.size[1], 0, 0);
    }
    if (man.layers.length !== NL || man.layers.some((l, i) => l.name !== LAYER_NAMES[i])) {
      console.warn('[textures] порядок слоёв в manifest.json не совпадает с LAYER_NAMES — пересоберите scripts/build-textures.mjs');
    }
    texUniforms.tNfrAlb.value = alb; texUniforms.tNfrNrm.value = nrm; texUniforms.tNfrOrm.value = orm;
    texUniforms.uNfrTexReady.value = 1;
    console.info(`[textures] ${man.layers.length} слоёв, ${(performance.now() - t0).toFixed(0)} мс`);
  })().catch((e) => console.warn('[textures] не загрузились, остаётся процедурный вид:', e));
  return started;
}

/** GLSL-определения слоёв: `#define L_ASPHALT 0` … */
export const LAYER_DEFINES = LAYER_NAMES.map((n, i) => `#define L_${n.toUpperCase()} ${i}`).join('\n');

/**
 * Общая GLSL-библиотека выборки (вставлять после `#include <common>` во фрагментный шейдер).
 *  nfrTex(p, L)      — сэмпл слоя L в точке p (метры в плоскости текстуры): .alb (≈1 в среднем), .nrm (касательное
 *                      пространство, z вверх), .ao, .rough (≈1 в среднем), .h (высота 0..1)
 *  nfrTexAT(p, L, n) — то же с анти-тайлингом: второй сэмпл повёрнутой/сдвинутой сетки, смешанный по шуму n
 *  nfrBlendN(a, b)   — смешивание нормалей (whiteout)
 *  nfrTBN(p, n, uv)  — касательный базис по производным (для произвольной развёртки)
 */
export const TEX_GLSL = /* glsl */ `
${LAYER_DEFINES}
#define NFR_NL ${NL}
uniform highp sampler2DArray tNfrAlb;
uniform highp sampler2DArray tNfrNrm;
uniform highp sampler2DArray tNfrOrm;
uniform vec4 uNfrTexAvg[NFR_NL];
uniform vec4 uNfrTexScale[NFR_NL];
uniform float uNfrTexDetail;
uniform float uNfrTexReady;
struct NfrT { vec3 alb; vec3 nrm; float ao; float rough; float h; };
NfrT nfrTexUV(vec2 uv, int L) {
  NfrT t;
  vec4 avg = uNfrTexAvg[L];
  t.alb = texture(tNfrAlb, vec3(uv, float(L))).rgb / avg.rgb;
  vec3 n = texture(tNfrNrm, vec3(uv, float(L))).xyz * 2.0 - 1.0;
  t.nrm = normalize(vec3(n.xy, max(n.z, 0.05)));
  vec3 o = texture(tNfrOrm, vec3(uv, float(L))).rgb;
  t.ao = o.r; t.rough = o.g / avg.a; t.h = o.b;
  return t;
}
NfrT nfrTex(vec2 p, int L) { return nfrTexUV(p * uNfrTexScale[L].xy, L); }
NfrT nfrMixT(NfrT a, NfrT b, float k) {
  NfrT t; t.alb = mix(a.alb, b.alb, k); t.nrm = normalize(mix(a.nrm, b.nrm, k)); t.ao = mix(a.ao, b.ao, k);
  t.rough = mix(a.rough, b.rough, k); t.h = mix(a.h, b.h, k); return t;
}
// анти-тайлинг: вторая выборка в повёрнутой (≈37°) и сдвинутой сетке, переход по шуму с учётом высоты (резче по рельефу)
NfrT nfrTexAT(vec2 p, int L, float n) {
  NfrT a = nfrTex(p, L);
  if (uNfrTexDetail < 0.75) return a;
  vec2 q = mat2(0.799, 0.602, -0.602, 0.799) * p + vec2(13.7, 41.3);
  NfrT b = nfrTex(q, L);
  float k = smoothstep(0.35, 0.65, n + (b.h - a.h) * 0.35);
  // нормаль второй выборки повёрнута вместе с сеткой — вернуть в базис первой
  b.nrm.xy = mat2(0.799, -0.602, 0.602, 0.799) * b.nrm.xy;
  return nfrMixT(a, b, k);
}
vec3 nfrBlendN(vec3 a, vec3 b) { return normalize(vec3(a.xy + b.xy, a.z * b.z)); }
vec3 nfrScaleN(vec3 n, float k) { return normalize(vec3(n.xy * k, n.z)); }
mat3 nfrTBN(vec3 p, vec3 n, vec2 uv) {
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 du1 = dFdx(uv), du2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, n), dp1perp = cross(n, dp1);
  vec3 T = dp2perp * du1.x + dp1perp * du2.x;
  vec3 B = dp2perp * du1.y + dp1perp * du2.y;
  float m = max(dot(T, T), dot(B, B));
  if (m < 1e-20) return mat3(vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), n);
  float inv = inversesqrt(m);
  return mat3(T * inv, B * inv, n);
}
`;
