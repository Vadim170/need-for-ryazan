import * as THREE from 'three';
import { createBuildingMaterial } from './building-material';
import { texUniforms, TEX_GLSL } from '../render/textures';
import { applySurfaceWeather, weatherKindFor, weatherUniforms } from '../render/weather';
import { landcoverUniforms, LANDCOVER_GLSL } from './landcover';

/**
 * Материалы города по имени материала из glTF (контракт: docs/world-format.md). Общие на все тайлы, не dispose-ятся при выгрузке тайла.
 *
 * Многоматериальные ноды тайла (roads, sidewalks, areas, buildings) склеиваются при загрузке в ОДИН меш на ноду
 * (меньше draw calls): номер исходного материала лежит в атрибуте `aKind` (см. NODE_KINDS), шейдер ветвится по нему.
 * Здания дополнительно получают вершинный цвет `color` (базовый тон по типу) — сюда же позже лягут цвета фасадов
 * (building_facades.json): достаточно перезаписать атрибут `color` у вершин нужного здания.
 *
 * Z-fighting: все «наложенные» поверхности (площадки +0.03, дороги +0.05, площадки перекрёстков +0.06, разметка +0.07)
 * получают сдвиг глубины в вершинном шейдере: gl_Position.z -= bias·w (постоянный сдвиг NDC ≈ polygonOffset units,
 * масштабируется с дальностью так же, как точность depth-буфера). Значения — DEPTH_BIAS.
 *
 * Хук под CC0-текстуры: `CityMaterials.override(name, material)` — подменить материал по имени glTF. Если для какой-то
 * части многоматериальной ноды есть подмена, нода не склеивается и каждая часть получает свой материал (byName).
 */

/**
 * Общие uniform-ы города (день/ночь): uNfrNight 0 — день, 1 — ночь. Светятся: часть окон зданий (nfrEmissive в шейдере
 * здания), плафоны фонарей (props.ts использует этот же объект). Модуль времени суток просто пишет value.
 */
export const cityUniforms = {
  uNfrNight: { value: 0 },
  /** доля горящих окон 0..1 (render/day-night.ts: по часу суток) */ uNfrWin: { value: 0.35 },
  /** рассеянный свет неба, linear (render/day-night.ts) — интерьеры за окнами днём */ uNfrAmb: { value: new THREE.Color(1.2, 1.3, 1.5) },
};

/** Номер материала внутри склеенной ноды → атрибут aKind. */
export const NODE_KINDS: Record<string, string[]> = {
  roads: ['road_asphalt', 'road_junction'],
  sidewalks: ['sidewalk', 'curb'],
  areas: ['area_parking', 'area_paving', 'area_path', 'area_playground', 'area_grass', 'area_dirt', 'area_paving_pedestrian'],
  buildings: ['building_apartments', 'building_house', 'building_commercial', 'building_garage', 'building_other', 'building'],
};

/** Базовые тона зданий по типу (вершинный цвет; фасады позже перезапишут). */
export const BUILDING_BASE: Record<string, number> = {
  building_apartments: 0xb4aa98,
  building_house: 0xc99a7a,
  building_commercial: 0x8e9aa6,
  building_garage: 0x8a8782,
  building_other: 0xa89f93,
};

/** NDC-сдвиг глубины (1 unit 24-битного буфера ≈ 1.2e-7). */
const DEPTH_BIAS = {
  areas: 3e-7, // + kind·0 (площадки не перекрываются)
  roads: 7e-7, // junction: +4e-7
  sidewalks: 5e-7,
  markings: 1.6e-6,
};

const HASH_GLSL = /* glsl */ `
float nfrHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float nfrNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(nfrHash(i), nfrHash(i + vec2(1, 0)), f.x), mix(nfrHash(i + vec2(0, 1)), nfrHash(i + vec2(1, 1)), f.x), f.y);
}
float nfrFbm(vec2 p) { return nfrNoise(p) * 0.5 + nfrNoise(p * 2.03) * 0.3 + nfrNoise(p * 4.1) * 0.2; }
// касательная нормаль горизонтальной развёртки (u = +X, v = север = −Z) → мир
vec3 nfrGroundN(vec3 ts, vec3 N) {
  vec3 T = normalize(vec3(1.0, 0.0, 0.0) - N * N.x);
  vec3 B = cross(N, T);
  return normalize(T * ts.x + B * ts.y + N * ts.z);
}
// детальные нормали вблизи: тот же слой ×3.7 (пресет качества: uNfrTexDetail)
vec3 nfrDetail(vec3 n, vec2 tp, int L, float k) {
  if (uNfrTexDetail < 0.25) return n;
  float f = (1.0 - smoothstep(5.0, 16.0, length(cameraPosition - vNfrPos))) * k;
  if (f < 0.01) return n;
  vec3 dn = texture(tNfrNrm, vec3(tp * uNfrTexScale[L].xy * 3.7 + 0.37, float(L))).xyz * 2.0 - 1.0;
  return nfrBlendN(n, vec3(dn.xy * f, 1.0));
}
// плитка: g — координаты в плитках, sz — размер плитки (м), bevel — ширина фаски (м).
// .x — шов 0..1 (с затуханием вдали), .yz — наклон фаски (касательное пространство)
vec3 nfrPaver(vec2 g, vec2 sz, float bevel) {
  vec2 f = fract(g) - 0.5;
  vec2 e = (0.5 - abs(f)) * sz;
  float px = max(length(fwidth(g) * sz), 1e-4);
  float seam = (1.0 - smoothstep(0.0025, 0.0025 + px, min(e.x, e.y))) * (1.0 - smoothstep(0.01, 0.04, px));
  vec2 tilt = sign(f) * (1.0 - smoothstep(0.0, bevel, e)) * (1.0 - smoothstep(0.02, 0.06, px));
  return vec3(seam, tilt);
}
// исторический центр (Кремль → Почтовая → Первомайский → пл. Победы): по панорамам там красно-бурая брусчатка
// вперемешку с серой (часто «ёлочкой»), гранитные светлые бордюры; дальше от оси — серая плитка и асфальт
float nfrWarm(vec2 p) {
  vec2 ab = vec2(-2500.0, 850.0);
  float t = clamp(dot(p, ab) / dot(ab, ab), 0.0, 1.0);
  return 1.0 - smoothstep(450.0, 900.0, length(p - ab * t));
}
// брусчатка 0.2×0.1 м: lay 0 — вперевязку вдоль X, 1 — плетёнка под 45° (на панорамах — «ёлочка»).
// Возвращает цвет; T — фактура (бетон, своя на каждый камень), ts — наклон фаски (касательное пространство), seam — шов.
vec3 nfrBrick(vec2 p, float warm, float lay, out NfrT T, out vec2 ts, out float seam) {
  vec2 gl, id; vec2 sz = vec2(0.2, 0.1); bool sw = false;
  if (lay > 0.5) {
    vec2 q = mat2(0.7071, -0.7071, 0.7071, 0.7071) * p;
    vec2 c = floor(q / 0.2);
    float chk = mod(c.x + c.y, 2.0);
    vec2 f = q - c * 0.2;
    sw = chk > 0.5;
    if (sw) f = f.yx;
    float j = floor(f.y / 0.1);
    gl = vec2(f.x / 0.2, f.y / 0.1 - j);
    id = c * 2.0 + vec2(chk, j);
  } else {
    vec2 g = p / sz; g.x += step(1.0, mod(floor(g.y), 2.0)) * 0.5;
    gl = fract(g); id = floor(g);
  }
  vec3 pv = nfrPaver(gl + 7.0, sz, 0.006);
  seam = pv.x;
  vec2 t = sw ? pv.zy : pv.yz;
  if (lay > 0.5) t = mat2(0.7071, 0.7071, -0.7071, 0.7071) * t;
  ts = vec2(t.x, -t.y);                                  // p.y — это z (юг), касательная v — север
  float h = nfrHash(id), h2 = nfrHash(id + 5.3);
  float far_ = smoothstep(0.015, 0.05, length(fwidth(p)));   // разнотон камней гаснет вдали (без муара)
  T = nfrTex(vec2(p.x, -p.y) + vec2(nfrHash(id + 3.1), nfrHash(id + 7.7)) * 7.0, L_CONCRETE);
  vec3 grey = vec3(0.27, 0.262, 0.25), red = vec3(0.24, 0.10, 0.07), brown = vec3(0.17, 0.11, 0.08), dark = vec3(0.12, 0.11, 0.10);
  vec3 cw = h < 0.38 ? red : h < 0.72 ? brown : h < 0.9 ? grey : dark;        // центр: тёплая смесь
  vec3 cg = h < 0.9 ? grey : red;                                             // окраины: серая с редкими красными
  vec3 avgW = red * 0.38 + brown * 0.34 + grey * 0.18 + dark * 0.1, avgG = grey * 0.9 + red * 0.1;
  vec3 col = mix(mix(cg, avgG, far_), mix(cw, avgW, far_), warm) * (0.9 + 0.18 * h2 * (1.0 - far_));
  col *= mix(vec3(1.0), T.alb, 0.7);
  col = mix(col, vec3(0.10, 0.095, 0.085), seam * 0.75);
  T.ao *= 1.0 - 0.6 * seam;
  return col;
}
// асфальт: два слоя (старый с трещинами / свежий), заплаты; base — тон, возвращает фактуру в A
vec3 nfrAsphaltT(vec2 p, vec3 base, out NfrT A) {
  vec2 tp = vec2(p.x, -p.y);
  float fresh = smoothstep(0.6, 0.7, nfrNoise(p * 0.004 + 3.0));
  A = nfrTexAT(tp, L_ASPHALT, nfrNoise(p * 0.13));
  if (fresh > 0.001) A = nfrMixT(A, nfrTex(tp, L_ASPHALT_FRESH), fresh);
  float patchy = smoothstep(0.62, 0.68, nfrNoise(p * 0.08 + 13.0)) * (1.0 - fresh);
  if (patchy > 0.001) A = nfrMixT(A, nfrTex(tp + 3.0, L_ASPHALT_PATCH), patchy);
  vec3 b = mix(base, base * vec3(0.7, 0.71, 0.74), fresh);              // свежий — темнее и холоднее
  b = mix(b, base * 0.62, patchy);                                       // заплаты — тёмные
  return b * mix(vec3(1.0), A.alb, 0.9) * (0.9 + 0.2 * nfrNoise(p * 0.05));
}`;

/** desatIndirect: доля обесцвечивания рассеянного света неба (голубой hemisphere в тени красит асфальт в синий). */
interface PatchOpts { depthBias?: number; kindBias?: number; kinds?: boolean; desatIndirect?: number }

/**
 * Добавляет varying vNfrPos (мировая позиция; тайлы запечены в мировых координатах), vNfrN (нормаль), vNfrUv,
 * vNfrKind (атрибут aKind склеенных нод) + свой код цвета. depthBias/kindBias — сдвиг глубины (см. шапку).
 *
 * Код цвета (GLSL, в точке color_fragment) может выставить: diffuseColor.rgb, nfrNW (мировая нормаль с картой
 * нормалей; по умолчанию — геометрическая), nfrRough (≥ 0 — шероховатость), nfrAO (затенение рассеянного света),
 * nfrEmissive (свечение × uNfrNight). Текстуры — render/textures.ts (TEX_GLSL). Точка вставки погоды
 * (render/weather.ts) — перед emissivemap_fragment: к ней цвет, шероховатость и нормаль уже посчитаны.
 */
function patch(mat: THREE.MeshStandardMaterial, colorCode: string, o: PatchOpts = {}): THREE.MeshStandardMaterial {
  const bias = o.depthBias ?? 0, kb = o.kindBias ?? 0;
  mat.customProgramCacheKey = () => 'nfr2:' + bias + ':' + kb + ':' + (o.desatIndirect ?? 0) + ':' + colorCode;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNfrNight = cityUniforms.uNfrNight;
    sh.uniforms.uNfrWin = cityUniforms.uNfrWin;
    Object.assign(sh.uniforms, texUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vNfrPos; varying vec3 vNfrN; varying vec2 vNfrUv; varying float vNfrKind;\n${o.kinds ? 'attribute float aKind;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvNfrPos = position; vNfrN = normal; vNfrUv = uv; vNfrKind = ${o.kinds ? 'aKind' : '0.0'};`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${bias || kb ? `gl_Position.z -= (${bias.toExponential()} + vNfrKind * ${kb.toExponential()}) * gl_Position.w;` : ''}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNfrPos; varying vec3 vNfrN; varying vec2 vNfrUv; varying float vNfrKind; uniform float uNfrNight; uniform float uNfrWin;\n' + TEX_GLSL + HASH_GLSL)
      // nfrEmissive: цвет свечения (умножается на uNfrNight) — код цвета может его выставить (окна)
      .replace('#include <color_fragment>', '#include <color_fragment>\nvec3 nfrEmissive = vec3(0.0);\nvec3 nfrNW = normalize(vNfrN); float nfrRough = -1.0, nfrAO = 1.0;\n' + colorCode)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (nfrRough >= 0.0) roughnessFactor = nfrRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(mat3(viewMatrix) * nfrNW);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += nfrEmissive * uNfrNight;')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse *= nfrAO; reflectedLight.indirectSpecular *= mix(1.0, nfrAO, 0.6);\n' + (o.desatIndirect ? `reflectedLight.indirectDiffuse = mix(reflectedLight.indirectDiffuse, vec3(dot(reflectedLight.indirectDiffuse, vec3(0.299, 0.587, 0.114))), ${o.desatIndirect.toFixed(2)});` : ''));
  };
  return mat;
}

/**
 * Рельеф: трава/грунт по шуму и уклону; поверх — карта покрова со спутника (world/landcover.ts, docs/stage3/landcover.md):
 * луг (осенью — солома), газон, огород (гряды ~1.1 м, часть засажена летом), вытоптанный грунт, песок, щебень/промплощадка,
 * подстилка под кронами и в зарослях (осенью — опавшая листва). Крутые склоны остаются грунтом.
 */
function terrainMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97 });
  patch(m, /* glsl */ `
    {
      vec2 p = vNfrPos.xz, tp = vec2(p.x, -p.y);
      vec3 grass = vec3(0.20, 0.30, 0.085), grass2 = vec3(0.27, 0.34, 0.10), dirt = vec3(0.30, 0.22, 0.13);
      float n = nfrNoise(p * 0.15) * 0.6 + nfrNoise(p * 0.9) * 0.4;
      vec3 c = mix(grass, grass2, n);
      c = mix(c, vec3(0.36, 0.33, 0.15), smoothstep(0.6, 0.85, nfrNoise(p * 0.03 + 4.0)) * 0.5);   // сухая трава
      c = mix(c, vec3(0.13, 0.22, 0.06), smoothstep(0.55, 0.8, nfrNoise(p * 0.11 + 9.0)) * 0.45);  // сочные куртины
      float bare = smoothstep(0.8, 0.95, nfrNoise(p * 0.25 + 17.0)) * 0.6;                        // проплешины
      vec3 N0 = normalize(vNfrN);
      float slope = 1.0 - clamp(N0.y, 0.0, 1.0);          // 0 плоско .. 1 вертикально
      float d = max(smoothstep(0.08, 0.22, slope + (n - 0.5) * 0.06), bare);
      NfrT G = nfrTexAT(tp, L_MEADOW, nfrNoise(p * 0.11));
      NfrT D = nfrTex(tp, L_DIRT);
      vec3 cg = c * mix(vec3(1.0), G.alb, 0.85), cd = dirt * (0.85 + 0.3 * n) * mix(vec3(1.0), D.alb, 0.85);
      float k = clamp(d + (D.h - G.h) * 0.3 * d * (1.0 - d) * 4.0, 0.0, 1.0);
      diffuseColor.rgb = mix(cg, cd, k);
      NfrT T = nfrMixT(G, D, k);
      // ---- покров со спутника
      vec4 wA, wB;
      nfrLandcover(p, nfrNoise(p * 0.6 + 3.3), wA, wB);
      float wsum = dot(wA, vec4(1.0)) + dot(wB, vec4(1.0));
      if (wsum > 0.01) {
        float aut = smoothstep(0.22, 0.55, uLcSeason);
        vec3 lc = vec3(0.0); float soilW = 0.0, gravW = 0.0;
        if (wA.x > 0.0) {      // луг: пёстрый, соломистые пятна; осенью — солома
          vec3 cm = mix(vec3(0.25, 0.31, 0.09), vec3(0.42, 0.39, 0.18), smoothstep(0.45, 0.8, nfrNoise(p * 0.07 + 2.0)) * 0.55);
          cm = mix(cm, vec3(0.47, 0.41, 0.21), aut * 0.85);
          lc += cm * mix(vec3(1.0), G.alb, 0.85) * wA.x;
        }
        if (wA.y > 0.0) {      // газон: ровный, сочный, полосы покоса
          vec3 cl = mix(vec3(0.14, 0.27, 0.06), vec3(0.20, 0.32, 0.08), nfrNoise(p * 0.3));
          cl *= 0.95 + 0.06 * sin(dot(p, vec2(0.7, 0.71)) * 1.6);
          cl = mix(cl, vec3(0.31, 0.30, 0.13), aut * 0.5);
          lc += cl * mix(vec3(1.0), G.alb, 0.7) * wA.y;
        }
        if (wA.z > 0.0) {      // огород: гряды ~1.1 м, направление — своё на участок 24 м; часть грядок засажена летом
          float ang = nfrHash(floor(p / 24.0) + 0.37) * 3.1416;
          float row = sin(dot(p, vec2(cos(ang), sin(ang))) * 5.712);
          float ridge = smoothstep(-0.3, 0.7, row);
          float grow = (1.0 - aut) * step(0.4, nfrHash(floor(p / 6.0) + 1.7));
          vec3 soil = vec3(0.24, 0.17, 0.11) * (0.78 + 0.32 * ridge) * mix(vec3(1.0), D.alb, 0.85);
          vec3 crop = mix(vec3(0.15, 0.25, 0.07), vec3(0.22, 0.30, 0.10), nfrNoise(p * 0.9)) * G.alb;   // ботва — пятнами
          lc += mix(soil, crop, ridge * grow * (0.45 + 0.4 * nfrNoise(p * 0.7 + 2.0))) * wA.z;
          soilW += wA.z;
        }
        if (wA.w > 0.0) {      // вытоптанный грунт, редкая трава
          vec3 cb = vec3(0.34, 0.27, 0.18) * (0.85 + 0.3 * n) * mix(vec3(1.0), D.alb, 0.9);
          cb = mix(cb, vec3(0.24, 0.29, 0.10) * G.alb, smoothstep(0.62, 0.85, nfrNoise(p * 0.4 + 8.0)) * 0.5);
          lc += cb * wA.w; soilW += wA.w;
        }
        if (wB.x > 0.0) {      // песок
          lc += vec3(0.60, 0.54, 0.40) * (0.9 + 0.15 * n) * mix(vec3(1.0), D.alb, 0.35) * wB.x; soilW += wB.x;
        }
        if (wB.y > 0.0) {      // щебень, промплощадка, асфальт вне OSM
          NfrT R = nfrTex(tp, L_GRAVEL);
          lc += vec3(0.34, 0.33, 0.31) * (0.85 + 0.25 * n) * mix(vec3(1.0), R.alb, 0.9) * wB.y;
          gravW = wB.y;
          T = nfrMixT(T, R, clamp(gravW / max(wsum, 1e-3), 0.0, 1.0));
        }
        if (wB.z + wB.w > 0.0) { // подстилка под кронами / в зарослях: тёмная земля, пятна травы; осенью — листва
          vec3 lt = mix(vec3(0.15, 0.12, 0.08) * D.alb, vec3(0.13, 0.21, 0.06) * G.alb, smoothstep(0.4, 0.7, nfrNoise(p * 0.5 + 5.0)) * 0.6);
          lt = mix(lt, vec3(0.40, 0.24, 0.08) * D.alb, smoothstep(0.35, 0.7, uLcSeason) * 0.7);
          lc += lt * (wB.z + wB.w * 0.85); soilW += (wB.z + wB.w) * 0.6;
        }
        float wl = clamp(wsum, 0.0, 1.0) * (1.0 - smoothstep(0.12, 0.3, slope) * 0.6);
        diffuseColor.rgb = mix(diffuseColor.rgb, lc / max(wsum, 1e-3), wl);
        T = nfrMixT(T, D, clamp(soilW / max(wsum, 1e-3), 0.0, 1.0) * wl * (1.0 - k));
      }
      nfrRough = clamp(0.95 * T.rough, 0.6, 1.0);
      nfrAO = mix(1.0, T.ao, 0.8);
      nfrNW = nfrGroundN(nfrScaleN(T.nrm, 0.9), N0);
    }`);
  // карта покрова и сезон (world/landcover.ts): объявления uniform-ов поверх patch()
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    Object.assign(sh.uniforms, landcoverUniforms);
    sh.uniforms.uLcSeason = weatherUniforms.season;
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uLcSeason;\n' + LANDCOVER_GLSL);
  };
  m.customProgramCacheKey = () => prevKey.call(m) + '|lc1';
  return m;
}

/** roads: road_asphalt (kind 0) + road_junction (kind 1, +0.01 м → чуть больше сдвиг глубины). Осевую теперь рисует нода markings. */
function roadMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const code = /* glsl */ `
    {
      vec2 p = vNfrPos.xz, tp = vec2(p.x, -p.y);
      NfrT A;
      // тон — по панорамам Рязани (Первомайский, Соборная): серый, почти нейтральный, светлее «нового» асфальта
      vec3 c = nfrAsphaltT(p, vec3(0.168, 0.166, 0.16), A);
      if (vNfrKind < 0.5) {
        // колея и масляная полоса по полосам: ширина ленты W из градиента u в мировых координатах
        vec3 dpx = dFdx(vNfrPos), dpy = dFdy(vNfrPos);
        vec2 du = vec2(dFdx(vNfrUv.x), dFdy(vNfrUv.x));
        mat2 J = mat2(dpx.x, dpy.x, dpx.z, dpy.z);
        float det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
        float far_ = clamp(length(dpx) * 6.0, 0.0, 1.0);
        if (abs(det) > 1e-8 && far_ < 1.0) {
          vec2 g = inverse(J) * du;
          float W = clamp(1.0 / max(length(g), 1e-3), 2.5, 16.0);
          float lanes = max(1.0, floor(W / 3.2 + 0.4));
          float lw = W / lanes, m = vNfrUv.x * W, f = fract(m / lw) * lw - lw * 0.5;
          float track = exp(-pow((abs(f) - 0.8) / 0.32, 2.0));
          float oil = exp(-pow(f / 0.35, 2.0)) * (0.6 + 0.4 * nfrNoise(p * 0.7));
          float edge = smoothstep(0.7, 0.0, m);
          float k = 1.0 - far_;
          c *= 1.0 - k * (0.08 * track + 0.14 * oil);
          // полированные колеи — чуть глаже; пыль и песок у бордюра
          A.rough *= 1.0 - 0.12 * track * k;
          c = mix(c, vec3(0.20, 0.19, 0.17) * A.alb, edge * 0.45 * k);
        }
      } else {
        // перекрёсток: тёмные следы шин (вытянутые по шуму полосы) и пятна масла
        float sk = smoothstep(0.75, 0.9, nfrNoise(vec2(p.x * 0.35 + p.y * 0.12, p.y * 2.2 - p.x * 0.8)));
        float blot = smoothstep(0.7, 0.9, nfrNoise(p * 0.5 + 9.0));
        c *= 1.0 - 0.25 * sk - 0.12 * blot;
        A.rough *= 1.0 - 0.15 * blot;
      }
      diffuseColor.rgb = c;
      nfrRough = clamp(0.86 * A.rough, 0.45, 1.0);
      nfrAO = mix(1.0, A.ao, 0.85);
      nfrNW = nfrGroundN(nfrDetail(A.nrm, tp, L_ASPHALT, 0.8), normalize(vNfrN));
    }`;
  return patch(m, code, { depthBias: DEPTH_BIAS.roads, kindBias: 4e-7, kinds: true, desatIndirect: 0.6 });
}

/** Разметка: белая краска, износ по UV (v — метры вдоль линии) + мировой шум; сдвиг глубины над дорогой. */
function markingMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  return patch(m, /* glsl */ `
    {
      vec2 p = vNfrPos.xz;
      NfrT A;
      vec3 asph = nfrAsphaltT(p, vec3(0.168, 0.166, 0.16), A);
      float wear = nfrNoise(vec2(vNfrUv.x * 4.0, vNfrUv.y * 1.3)) * 0.55 + nfrNoise(p * 3.0) * 0.3 + nfrNoise(p * 0.05) * 0.4;
      // краска лежит в порах асфальта: износ сначала на выступах (высота текстуры)
      float worn = smoothstep(0.55, 0.85, wear + (A.h - 0.5) * 0.25);
      vec3 paint = vec3(0.78, 0.78, 0.75) * (0.92 + 0.08 * nfrNoise(p * 20.0));
      diffuseColor.rgb = mix(paint * mix(vec3(1.0), A.alb, 0.25), asph, worn * 0.8);
      nfrRough = mix(0.55, 0.86 * A.rough, worn);
      nfrAO = mix(1.0, A.ao, 0.5);
      nfrNW = nfrGroundN(nfrScaleN(A.nrm, mix(0.45, 1.0, worn)), normalize(vNfrN));
    }`, { depthBias: DEPTH_BIAS.markings, desatIndirect: 0.5 });
}

/**
 * sidewalks: sidewalk (kind 0) — по кварталам: серая плитка «кирпичик» 0.2×0.1 (самая частая в Рязани), квадратная
 * 0.4 м и асфальт (дворы, старые тротуары); curb (kind 1) — бетонный бордюр БР 100.30.15, окрашен «два белых, один чёрный» (u — метры вдоль).
 */
function sidewalkMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  return patch(m, /* glsl */ `
    {
      vec3 N0 = normalize(vNfrN);
      if (vNfrKind < 0.5) {
        vec2 p = vNfrPos.xz, tp = vec2(p.x, -p.y);
        float reg = nfrNoise(p * 0.02 + 7.0);                 // кварталы: асфальт / кирпичик / квадрат
        float isAsph = 1.0 - smoothstep(0.36, 0.42, reg);
        float isSq = smoothstep(0.7, 0.74, reg);
        vec3 c; NfrT T; vec2 tilt = vec2(0.0); float seam = 0.0;
        float warm = nfrWarm(p);
        isAsph *= 1.0 - warm;                                    // в центре тротуары мощёные
        if (isAsph > 0.5) {
          c = nfrAsphaltT(p, vec3(0.17, 0.165, 0.157), T);
        } else if (isSq > 0.5 && warm < 0.5) {
          vec2 sz = vec2(0.4, 0.4), g = p / sz;
          vec3 pv = nfrPaver(g, sz, 0.006);
          seam = pv.x; tilt = vec2(pv.y, -pv.z);
          vec2 id = floor(g);
          float h = nfrHash(id);
          T = nfrTex(tp + vec2(nfrHash(id + 3.1), nfrHash(id + 7.7)) * 7.0, L_CONCRETE);
          vec3 grey = vec3(0.30, 0.295, 0.285) * (0.9 + 0.18 * h * (1.0 - smoothstep(0.015, 0.05, length(fwidth(p)))));
          c = grey * mix(vec3(1.0), T.alb, 0.7);
          c = mix(c, vec3(0.13, 0.12, 0.11), seam * 0.75);
          T.ao *= 1.0 - 0.6 * seam;
        } else {
          c = nfrBrick(p, warm, step(0.55, nfrNoise(p * 0.03 + 3.0)) * step(0.5, warm), T, tilt, seam);
        }
        c *= 0.9 + 0.2 * nfrNoise(p * 0.4);
        // листья, окурки, грязь: редкие пятна по ячейкам 0.25 м, гуще по шуму
        vec2 lc = floor(p / 0.25);
        float lh = nfrHash(lc), lden = smoothstep(0.5, 0.9, nfrNoise(p * 0.08 + 2.0));
        vec2 lf = fract(p / 0.25) - 0.5 + (vec2(nfrHash(lc + 3.1), nfrHash(lc + 7.7)) - 0.5) * 0.4;
        float ang = lh * 6.28; vec2 lr = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * lf;
        float leaf = step(lh, 0.12 * lden) * (1.0 - smoothstep(0.08, 0.11, length(lr * vec2(1.0, 1.9))));
        vec3 leafC = mix(vec3(0.40, 0.18, 0.03), vec3(0.45, 0.33, 0.05), nfrHash(lc + 1.3));
        c = mix(c, leafC, leaf);
        float butt = step(0.995, nfrHash(floor(p / 0.07))) * step(0.4, lden);
        c = mix(c, vec3(0.7, 0.62, 0.5), butt * 0.8);
        diffuseColor.rgb = c;
        nfrRough = clamp(0.9 * T.rough, 0.55, 1.0);
        nfrAO = mix(1.0, T.ao, 0.8);
        vec3 ts = nfrBlendN(nfrScaleN(T.nrm, 0.8), vec3(tilt * 0.8, 1.0));
        nfrNW = nfrGroundN(ts, N0);
      } else {
        // бордюр: камни по 1 м (швы), покраска по камням — два белых, один чёрный; краска местами облуплена, низ в грязи
        vec2 uv = vNfrUv;
        NfrT T = nfrTex(uv * vec2(1.0, 1.0) + vec2(floor(uv.x) * 0.37, 0.0), L_CONCRETE);
        float seam = smoothstep(0.985, 1.0, fract(uv.x)) + smoothstep(0.015, 0.0, fract(uv.x));
        float black = step(1.5, mod(floor(uv.x), 3.0));           // каждый третий камень — чёрный
        vec3 paint = black > 0.5 ? vec3(0.055, 0.055, 0.058) : vec3(0.74, 0.74, 0.72);
        vec3 c = paint * mix(vec3(1.0), T.alb, 0.3) * (0.92 + 0.12 * nfrNoise(vNfrPos.xz * 0.5));
        // облупившаяся краска: пятна бетона
        c = mix(c, vec3(0.36, 0.355, 0.34) * T.alb, smoothstep(0.62, 0.8, nfrFbm(uv * vec2(2.0, 6.0))) * 0.7);
        float dirt = smoothstep(0.08, 0.0, uv.y);
        c = mix(c * (1.0 - 0.45 * seam), vec3(0.16, 0.15, 0.13), dirt * 0.55);
        diffuseColor.rgb = c;
        nfrRough = clamp(0.92 * T.rough, 0.6, 1.0);
        nfrAO = mix(1.0, T.ao, 0.7) * (1.0 - 0.4 * seam);
        nfrNW = normalize(nfrTBN(vNfrPos, N0, uv) * nfrScaleN(T.nrm, 0.8));
      }
    }`, { depthBias: DEPTH_BIAS.sidewalks, kinds: true, desatIndirect: 0.5 });
}

/** areas: parking0 paving1 path2 playground3 grass4 dirt5 paving_pedestrian6. Всё в мировых координатах (UV = x, z). */
function areasMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
  return patch(m, /* glsl */ `
    {
      vec2 p = vNfrPos.xz, tp = vec2(p.x, -p.y);
      vec3 N0 = normalize(vNfrN);
      float k = vNfrKind;
      vec3 c; NfrT T; vec2 tilt = vec2(0.0); float rough = 0.9, nk = 1.0;
      if (k < 0.5) {                      // парковка: асфальт светлее и пятнистее дороги
        c = nfrAsphaltT(p, vec3(0.165, 0.158, 0.148), T);
        c *= 0.85 + 0.25 * nfrNoise(p * 0.3 + 3.0);
      } else if (k < 1.5 || k > 5.5) {
        vec2 sz; vec2 g; vec3 col; float h;
        float pv0 = 1.0 - smoothstep(0.015, 0.05, length(fwidth(p)));   // разнотон плиток гаснет вдали (без муара)
        if (k < 1.5) {                    // брусчатка 0.2×0.1: в центре красно-бурая «ёлочкой», дальше — серая вперевязку
          float warm = nfrWarm(p);
          float seam;
          c = nfrBrick(p, warm, step(0.4, warm), T, tilt, seam);
        } else {                          // пешеходная улица (Почтовая): декоративная плитка 0.3×0.15 вперевязку,
                                          // рамка-сетка 6 м из терракотовой плитки и тёмный ромб в каждой ячейке
          sz = vec2(0.3, 0.15);
          g = p / sz; g.x += step(1.0, mod(floor(g.y), 2.0)) * 0.5;
          h = nfrHash(floor(g));
          vec2 pc = (floor(g) + 0.5) * sz;                // центр плитки: орнамент «по плиткам», без разрезанных кирпичиков
          vec2 cell = mod(pc, 6.0) - 3.0;
          float band = step(2.6, max(abs(cell.x), abs(cell.y)));
          float dm = abs(cell.x) + abs(cell.y);
          float diamond = step(dm, 1.25) * step(0.8, dm);
          vec3 grey = mix(vec3(0.36, 0.34, 0.31), vec3(0.29, 0.28, 0.26), step(0.62, h * pv0)) * (0.9 + 0.16 * h * pv0);
          vec3 terra = vec3(0.32, 0.14, 0.09) * (0.86 + 0.22 * h);
          vec3 dark = vec3(0.12, 0.115, 0.11) * (0.9 + 0.2 * h);
          col = mix(mix(grey, terra, band), dark, diamond);
          vec3 pv = nfrPaver(g, sz, 0.006);
          tilt = vec2(pv.y, -pv.z);
          vec2 id = floor(g);
          T = nfrTex(tp + vec2(nfrHash(id + 3.1), nfrHash(id + 7.7)) * 7.0, L_CONCRETE);
          c = col * mix(vec3(1.0), T.alb, 0.7);
          c = mix(c, vec3(0.11, 0.10, 0.09), pv.x * 0.75);
          T.ao *= 1.0 - 0.6 * pv.x;
        }
        c *= 0.9 + 0.14 * nfrNoise(p * 0.12 + 5.0);       // пятна износа
      } else if (k < 2.5) {               // дорожка: светлый асфальт
        c = nfrAsphaltT(p, vec3(0.19, 0.18, 0.17), T);
      } else if (k < 3.5) {               // детплощадка: резиновая крошка
        T = nfrTex(tp * 2.0, L_ASPHALT_PATCH);
        vec3 a = vec3(0.36, 0.07, 0.04), b = vec3(0.07, 0.22, 0.07);
        c = mix(a, b, step(0.5, nfrNoise(p * 0.12))) * mix(vec3(1.0), vec3(dot(T.alb, vec3(0.33))), 0.8);
        rough = 0.95;
      } else if (k < 4.5) {               // газон: сочнее рельефа, полосы покоса
        float n = nfrNoise(p * 0.2) * 0.5 + nfrNoise(p * 1.5) * 0.3 + nfrNoise(p * 8.0) * 0.2;
        c = mix(vec3(0.15, 0.28, 0.06), vec3(0.22, 0.33, 0.08), n);
        c *= 0.95 + 0.06 * sin(dot(p, vec2(0.7, 0.71)) * 1.6);
        c = mix(c, vec3(0.38, 0.33, 0.14), smoothstep(0.62, 0.85, nfrNoise(p * 0.045 + 4.0)) * 0.55);  // выгоревшие пятна
        c = mix(c, vec3(0.11, 0.24, 0.07), smoothstep(0.66, 0.8, nfrNoise(p * 0.3 + 11.0)) * 0.5);    // клевер
        float trod = smoothstep(0.78, 0.9, nfrNoise(p * 0.18 + 21.0)) * 0.7;                         // вытоптанная земля
        NfrT G = nfrTexAT(tp, L_GRASS, nfrNoise(p * 0.11)), D = nfrTex(tp, L_DIRT);
        c = mix(c * mix(vec3(1.0), G.alb, 0.85), vec3(0.26, 0.19, 0.12) * D.alb, trod);
        T = nfrMixT(G, D, trod);
        rough = 0.95;
      } else {                            // грунт
        float n = nfrFbm(p * 0.8);
        T = nfrTexAT(tp, L_DIRT, nfrNoise(p * 0.2));
        c = vec3(0.30, 0.23, 0.15) * (0.8 + 0.35 * n) * mix(vec3(1.0), T.alb, 0.9);
        float gr = smoothstep(0.6, 0.8, nfrNoise(p * 0.3)) * 0.6;
        if (gr > 0.01) { NfrT G = nfrTex(tp, L_MEADOW); c = mix(c, vec3(0.2, 0.27, 0.09) * G.alb, gr); T = nfrMixT(T, G, gr); }
        rough = 0.97;
      }
      diffuseColor.rgb = c;
      nfrRough = clamp(rough * T.rough, 0.5, 1.0);
      nfrAO = mix(1.0, T.ao, 0.8);
      nfrNW = nfrGroundN(nfrBlendN(nfrScaleN(T.nrm, nk), vec3(tilt * 0.8, 1.0)), N0);
    }`, { depthBias: DEPTH_BIAS.areas, kinds: true, desatIndirect: 0.5 });
}

/** Бетон мостов/подпорных стенок: трипланарно (произвольная ориентация), подтёки по высоте. */
function bridgeMaterial(r = 0.36, g = 0.355, b = 0.34): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  return patch(m, /* glsl */ `
    {
      vec3 p = vNfrPos, N0 = normalize(vNfrN);
      vec3 w = pow(abs(N0), vec3(4.0)); w /= w.x + w.y + w.z;
      NfrT X = nfrTex(vec2(-p.z * sign(N0.x), p.y), L_CONCRETE_STAINED);
      NfrT Y = nfrTex(vec2(p.x, -p.z), L_CONCRETE);
      NfrT Z = nfrTex(vec2(p.x * sign(N0.z), p.y), L_CONCRETE_STAINED);
      vec3 alb = X.alb * w.x + Y.alb * w.y + Z.alb * w.z;
      // нормали: whiteout в мир по осям трипланара
      vec3 nX = vec3(X.nrm.z * sign(N0.x), X.nrm.y, -X.nrm.x * sign(N0.x));
      vec3 nY = vec3(Y.nrm.x, Y.nrm.z, -Y.nrm.y);
      vec3 nZ = vec3(Z.nrm.x * sign(N0.z), Z.nrm.y, Z.nrm.z * sign(N0.z));
      vec3 nw = normalize(nX * w.x + nY * w.y + nZ * w.z);
      float n = nfrFbm(p.xz * 0.7 + p.y * 0.9);
      float streak = nfrNoise(vec2(p.x * 0.2 + p.z * 0.2, p.y * 3.0));
      diffuseColor.rgb = vec3(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)}) * alb * (0.85 + 0.2 * n) * (1.0 - 0.18 * smoothstep(0.6, 0.9, streak));
      nfrRough = clamp(0.9 * (X.rough * w.x + Y.rough * w.y + Z.rough * w.z), 0.6, 1.0);
      nfrAO = mix(1.0, X.ao * w.x + Y.ao * w.y + Z.ao * w.z, 0.8);
      nfrNW = normalize(mix(N0, nw, 0.85));
    }`);
}

/** Здания: материал v2 (архетипы, окна, ночь) — world/building-material.ts. */

export interface CityMaterials {
  /** Материал по имени glTF-материала (для несклеенных частей). */
  byName(name: string): THREE.Material;
  /** Материал склеенной ноды (roads/sidewalks/areas/buildings/markings/…); undefined — ноду не склеивать. */
  forNode(node: string): THREE.Material | undefined;
  /** Хук для CC0-текстур: подменить материал по имени glTF (до загрузки тайлов). */
  override(name: string, mat: THREE.Material): void;
  isOverridden(name: string): boolean;
  terrain: THREE.Material;
  collider: THREE.Material;
  dispose(): void;
}

export function createCityMaterials(envMap: THREE.Texture | null): CityMaterials {
  const water = new THREE.MeshStandardMaterial({
    color: 0x1d4a66, roughness: 0.04, metalness: 0.1, envMap, envMapIntensity: 1.2, transparent: true, opacity: 0.88,
  });
  const fallback = new THREE.MeshStandardMaterial({ color: 0x9a9a96, roughness: 0.9 });
  const road = roadMaterial(), sidewalk = sidewalkMaterial(), areas = areasMaterial(), building = createBuildingMaterial(cityUniforms);
  const marking = markingMaterial(), bridge = bridgeMaterial();
  // bridges не склеиваем: в ноде бетон, перила (bridge_railing) и подпорные стенки (retaining_wall) — разные материалы
  const nodeMats: Record<string, THREE.Material> = { roads: road, sidewalks: sidewalk, areas, buildings: building, markings: marking, water };
  const railing = new THREE.MeshStandardMaterial({ color: 0x3e4a46, roughness: 0.45, metalness: 0.6, envMap, envMapIntensity: 0.6 });
  const retaining = bridgeMaterial(0.47, 0.45, 0.42);
  const map: Record<string, THREE.Material> = {
    terrain: terrainMaterial(),
    road_asphalt: road,
    road_junction: road,
    road_marking: marking,
    bridge_concrete: bridge,
    bridge_railing: railing,
    retaining_wall: retaining,
    sidewalk, curb: sidewalk,
    water,
  };
  for (const k of NODE_KINDS.areas) map[k] = areas;
  for (const k of NODE_KINDS.buildings) map[k] = building;
  // погода/сезоны (render/weather.ts): мокрый асфальт, лужи, снег, каша, колеи — слой поверх любых базовых шейдеров
  applySurfaceWeather(road, 'road'); applySurfaceWeather(marking, 'road'); applySurfaceWeather(sidewalk, 'sidewalk');
  applySurfaceWeather(areas, 'area'); applySurfaceWeather(building, 'roof'); applySurfaceWeather(map.terrain, 'terrain');
  applySurfaceWeather(bridge, 'prop'); applySurfaceWeather(retaining, 'prop'); applySurfaceWeather(railing, 'prop');
  const overrides: Record<string, THREE.Material> = {};
  return {
    byName(name) {
      if (overrides[name]) return overrides[name];
      if (map[name]) return map[name];
      if (name.startsWith('building')) return map.building_other;
      return fallback;
    },
    forNode(node) { return nodeMats[node]; },
    override(name, mat) { overrides[name] = applySurfaceWeather(mat, weatherKindFor(name)); },
    isOverridden(name) { return !!overrides[name]; },
    terrain: map.terrain,
    collider: fallback,
    dispose() {
      new Set([...Object.values(map), ...Object.values(nodeMats), ...Object.values(overrides), fallback]).forEach((m) => m.dispose());
    },
  };
}
