import * as THREE from 'three';

/**
 * Погода и времена года — ОБЩИЙ КОНТРАКТ для материалов (docs/stage3/weather-seasons.md).
 *
 * 1) `weatherUniforms` — глобальные uniform-ы `{value}` (можно класть прямо в `shader.uniforms`). Пишет их только
 *    `WeatherSystem` (render/weather-system.ts), все остальные читают.
 * 2) `applySurfaceWeather(material, kind)` — подмешивает в ЛЮБОЙ MeshStandard/Physical-материал (в т.ч. уже с
 *    собственным onBeforeCompile) слой погоды: мокрый асфальт, лужи с рябью, отражение неба, снег на обращённых вверх
 *    поверхностях, каша/колеи/сугробы на дорогах, голые деревья зимой, снежные шапки на машинах.
 *    Цепляется ПОСЛЕ существующего onBeforeCompile и дописывает customProgramCacheKey — материал может переписываться
 *    другими модулями как угодно, главное — вызвать хелпер после создания материала (один раз).
 *    Точки вставки: вершинный — перед `#include <fog_vertex>` (мировая позиция/нормаль считаются сами, с учётом
 *    instancing/batching), фрагментный — перед `#include <emissivemap_fragment>` (к этому моменту уже посчитаны
 *    diffuseColor, roughnessFactor, metalnessFactor, normal). Материал должен содержать эти чанки (Standard/Physical).
 *
 * Хуки, которые материал МОЖЕТ (не обязан) выставить в своём коде до точки вставки — глобальные переменные GLSL:
 *    `wxEdgeHint` — 0..1 близость к бордюру (по умолчанию берётся из маски покрытий у камеры, см. wxSurf).
 */

export type SurfaceKind =
  | 'road'       // проезжая часть, перекрёстки, разметка: мокрый асфальт, лужи, колеи/каша/сугробы у бордюра зимой
  | 'sidewalk'   // тротуар/бордюр: мокрая плитка; зимой утоптанный снег, каша, песок
  | 'area'       // площадки: газоны (по зелёному цвету) — как рельеф, мощёные — как тротуар
  | 'terrain'    // рельеф: снег целиной, сухая трава поздней осенью/зимой без снега
  | 'roof'       // здания: крыши (нормаль вверх) — снег, стены — потёки при дожде
  | 'wall'       // синоним roof (один материал на здание; крыша/стена по нормали)
  | 'vegetation' // кроны деревьев/кусты (листопад, голые ветки зимой, осенние цвета)
  | 'pine'       // хвойные: всегда зелёные, снег на лапах
  | 'car_paint'  // машины трафика (instancing): мокрый лак, снежные шапки (сдувает на скорости, см. vehicleSnowCap)
  | 'player_car' // машина игрока: шапка по uniform-у wxCap, координаты кузова — wxCarInv
  | 'prop';      // пропсы, ограды, парковка: снег сверху, мокрые поверхности

/** Глобальные uniform-ы погоды (значения 0..1, если не сказано иное). */
export const weatherUniforms = {
  /** Мокрость поверхностей (растёт в дождь, сохнет после). */
  wetness: { value: 0 },
  /** Лужи в низинах (маска по шуму), накапливаются медленнее мокрости. */
  puddles: { value: 0 },
  /** Сила дождя (частицы, рябь в лужах, звук). */
  rainIntensity: { value: 0 },
  /** Сила снегопада (частицы). */
  snowIntensity: { value: 0 },
  /** Снежный покров (0 — нет, 0.3 — «присыпка» пятнами, 0.7 — зима, 1 — сугробы). */
  snowCover: { value: 0 },
  /** Каша/слякоть на дорогах и тротуарах (зима, оттепель). */
  slush: { value: 0 },
  /** Плотность тумана/дымки (0 — обычная дальность, 1 — видимость ~120 м). */
  fog: { value: 0 },
  /** Направление ветра (мировые x, z; единичный) и сила 0..1 (≈ 0–15 м/с). */
  windDir: { value: new THREE.Vector2(0.8, 0.6) },
  windStrength: { value: 0.2 },
  /** Сезон: 0 лето … 0.5 осень (жёлтая листва) … 1 зима (голые деревья). */
  season: { value: 0 },
  /** Облачность 0..1 (небо, свет). */
  cloudCover: { value: 0.35 },
  /** Вспышка молнии 0..1 (короткий импульс). */
  lightning: { value: 0 },
  /** Секунды (анимация ряби). */
  time: { value: 0 },
  /** Карта следов шин (render/trail-map.ts): R — свежие следы, G — накатанные колеи по полосам. Тороидальная адресация. */
  trail: { value: null as THREE.Texture | null },
  /** Окно карты следов: originX, originZ, размер (м), 1 — карта активна. */
  trailWin: { value: new THREE.Vector4(0, 0, 256, 0) },
  /** Маска покрытий у камеры (grass.ts, RGBA 0.5 м): R — трава, A — близость к бордюру (граница дороги). */
  surf: { value: null as THREE.Texture | null },
  /** Окно маски: originX, originZ, размер (м), 1 — активна. */
  surfWin: { value: new THREE.Vector4(0, 0, 192, 0) },
  /** Цвета неба для отражений в мокром асфальте (линейные). */
  skyHorizon: { value: new THREE.Color(0.6, 0.65, 0.7) },
  skyZenith: { value: new THREE.Color(0.3, 0.4, 0.6) },
};

/** Множитель сцепления шин с дорогой (vehicle.ts: mu × weatherGrip.value). 1 — сухо, ~0.75 мокро, ~0.45 снег. */
export const weatherGrip = { value: 1 };

// ------------------------------------------------------------------ снежные шапки машин трафика

const capMap = new WeakMap<object, number>();
/** Снежная шапка машины трафика 0..1 (пишет WeatherSystem; render.ts/gltf-models.ts кодируют её в aLamp.z). */
export function vehicleSnowCap(v: object): number { return capMap.get(v) ?? 0; }
export function setVehicleSnowCap(v: object, cap: number): void { capMap.set(v, cap); }
/** Кодирование шапки в дробную часть aLamp.z (код поворотника −1..3 целый; < 0.4 не ломает его проверки). */
export const encodeCap = (cap: number) => Math.min(0.39, Math.max(0, cap) * 0.39);

// ------------------------------------------------------------------ GLSL

const U_DECL = /* glsl */ `
uniform float wxWet, wxPuddles, wxRain, wxSnowCover, wxSlush, wxSeason, wxTime, wxLightning;
uniform sampler2D wxTrail; uniform vec4 wxTrailWin;
uniform sampler2D wxSurf; uniform vec4 wxSurfWin;
uniform vec3 wxSkyH, wxSkyZ;
`;

const COMMON_FRAG = /* glsl */ `
varying vec3 vWxPos; varying vec3 vWxN; varying vec3 vWxLoc; varying vec3 vWxRel; varying float vWxCapI;
${U_DECL}
uniform float wxCap; uniform mat4 wxCarInv;
float wxEdgeHint = -1.0;
float wxHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wxNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wxHash(i), wxHash(i + vec2(1, 0)), f.x), mix(wxHash(i + vec2(0, 1)), wxHash(i + vec2(1, 1)), f.x), f.y);
}
float wxFbm(vec2 p) { return wxNoise(p) * 0.5 + wxNoise(p * 2.07 + 5.3) * 0.3 + wxNoise(p * 4.3 + 9.1) * 0.2; }
// снежный покров с пятнами: cover 0..1 → доля площади; n — шум 0..1
float wxCoverMask(float cover, float n) {
  float m = cover * 1.35 - 0.2 + (n - 0.5) * 1.1;
  return smoothstep(0.25, 0.55, m) * step(0.001, cover);
}
// карта следов: (R свежие, G колеи полос), гаснет к краю окна
vec2 wxTrailAt(vec2 xz) {
  if (wxTrailWin.w < 0.5) return vec2(0.0);
  vec2 q = (xz - wxTrailWin.xy) / wxTrailWin.z;
  float e = min(min(q.x, q.y), min(1.0 - q.x, 1.0 - q.y));
  if (e <= 0.0) return vec2(0.0);
  return texture(wxTrail, fract(xz / wxTrailWin.z)).rg * smoothstep(0.0, 0.06, e);
}
// маска покрытий у камеры: x — трава, w — близость к границе дороги; -1 вне окна
vec4 wxSurfAt(vec2 xz) {
  if (wxSurfWin.w < 0.5) return vec4(-1.0);
  vec2 q = (xz - wxSurfWin.xy) / wxSurfWin.z;
  if (q.x <= 0.0 || q.y <= 0.0 || q.x >= 1.0 || q.y >= 1.0) return vec4(-1.0);
  return texture(wxSurf, q);
}
// рябь дождя в лужах: кольца по ячейкам (2 слоя), возвращает наклон (dx, dz)
vec2 wxRipple(vec2 p, float t) {
  vec2 acc = vec2(0.0);
  for (int k = 0; k < 2; k++) {
    vec2 q = p * (k == 0 ? 2.3 : 3.1) + float(k) * 7.3;
    vec2 id = floor(q), f = fract(q) - 0.5;
    float h = wxHash(id + float(k) * 3.7);
    vec2 c = (vec2(wxHash(id + 1.3), wxHash(id + 5.1)) - 0.5) * 0.5;
    float ph = fract(t * (0.9 + 0.4 * h) + h);
    vec2 d = f - c; float r = length(d);
    float ring = sin((r - ph * 0.5) * 40.0) * (1.0 - ph) * smoothstep(0.5 * ph + 0.05, 0.5 * ph - 0.05, r - 0.02) * smoothstep(0.0, 0.08, r);
    acc += d / max(r, 1e-3) * ring;
  }
  return acc;
}
`;

const COMMON_VERT = /* glsl */ `
varying vec3 vWxPos; varying vec3 vWxN; varying vec3 vWxLoc; varying vec3 vWxRel; varying float vWxCapI;
uniform float wxTime, wxWind; uniform vec2 wxWindDir;
`;

const VERT_CODE = /* glsl */ `
{
  vec4 wxp = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    wxp = batchingMatrix * wxp;
  #endif
  vWxRel = transformed;
  #ifdef USE_INSTANCING
    wxp = instanceMatrix * wxp;
    vWxRel = wxp.xyz - instanceMatrix[3].xyz;
  #endif
  wxp = modelMatrix * wxp;
  vWxPos = wxp.xyz;
  vWxN = normalize((vec4(transformedNormal, 0.0) * viewMatrix).xyz);
  vWxLoc = transformed;
  vWxCapI = 0.0;
  WX_CAP_VERT
  WX_SWAY
}
`;

/** Общий «хвост»: применяет мокрость/лужи/снег к diffuseColor, roughnessFactor, normal; отражение неба — в emissive. */
const APPLY = /* glsl */ `
  // мокрость: тёмнее (пористые поверхности), глаже; лужи — почти зеркало, рябь от дождя
  float wxUpW = smoothstep(0.2, 0.9, wN.y);
  float wetK = clamp(wet, 0.0, 1.0) * (1.0 - snow);
  diffuseColor.rgb *= mix(1.0, porosity, wetK);
  float puddle = clamp(puddleK, 0.0, 1.0) * (1.0 - snow) * wxUpW;
  diffuseColor.rgb *= mix(1.0, 0.3, puddle);
  #ifdef STANDARD
    roughnessFactor = mix(roughnessFactor, wetRough, wetK * wxUpW * 0.85);
    roughnessFactor = mix(roughnessFactor, 0.03, puddle);
  #endif
  vec3 wxV = normalize(cameraPosition - wP);
  if (puddle > 0.01 && wxRain > 0.01) {
    vec2 rp = wxRipple(wP.xz, wxTime) * wxRain * puddle * 0.35;
    normal = normalize(normal + (viewMatrix * vec4(rp.x, 0.0, rp.y, 0.0)).xyz);
  }
  // снег
  diffuseColor.rgb = mix(diffuseColor.rgb, snowCol, snow);
  #ifdef STANDARD
    roughnessFactor = mix(roughnessFactor, snowRough, snow);
    metalnessFactor *= 1.0 - snow;
  #endif
  normal = normalize(mix(normal, normalize((viewMatrix * vec4(wN, 0.0)).xyz), max(snow * 0.7, puddle * 0.8)));
  // отражение неба в мокрой поверхности (дёшево вместо env-карты): Френель по геометрической нормали
  float refl = max(wetK * wxUpW * 0.55, puddle * 1.25) * reflK;
  if (refl > 0.001) {
    vec3 rd = reflect(-wxV, wN);
    vec3 sky = mix(wxSkyH, wxSkyZ, smoothstep(0.0, 0.6, rd.y));
    float fr = 0.03 + 0.97 * pow(1.0 - max(dot(wN, wxV), 0.0), 5.0);
    totalEmissiveRadiance += sky * fr * refl;
  }
`;

/** Код по виду поверхности: выставляет wet, puddleK, porosity, wetRough, reflK, snow, snowCol, snowRough. */
function kindCode(kind: SurfaceKind): string {
  switch (kind) {
    case 'road': return /* glsl */ `
      porosity = 0.62; wetRough = 0.12; reflK = 1.0;
      float pn = wxFbm(wP.xz * 0.11 + 3.7) * 0.75 + wxNoise(wP.xz * 0.9) * 0.25;
      puddleK = smoothstep(0.62 - wxPuddles * 0.16, 0.7 - wxPuddles * 0.16, pn) * wxPuddles;
      // зима: накатанный снег/каша между колеями, сугробы у бордюра, соль/песок
      vec4 sm = wxSurfAt(wP.xz);
      float edge = wxEdgeHint >= 0.0 ? wxEdgeHint : max(sm.w, 0.0);
      vec2 tr = wxTrailAt(wP.xz);
      float track = clamp(max(tr.r, tr.g * 0.9), 0.0, 1.0);
      float n1 = wxNoise(wP.xz * 0.6), n2 = wxNoise(wP.xz * 3.1 + 2.0);
      float winterK = max(wxSlush, wxSnowCover);
      if (winterK > 0.001) {
        // соль/реагенты: белёсые разводы на подсохшем асфальте
        float salt = smoothstep(0.45, 0.8, wxFbm(wP.xz * 0.35 + 11.0)) * winterK * (1.0 - wet * 0.8);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.29, 0.27), salt * 0.5);
        // каша: буро-серая, мокрая, между колеями и ближе к краю
        // колеи (накатанные полосы и свежие следы) — тёмный мокрый асфальт
        diffuseColor.rgb *= 1.0 - 0.18 * track * winterK;
        float slushA = clamp(wxSlush * (0.75 + 0.9 * edge) * (1.0 - track) * (0.55 + 0.7 * n1), 0.0, 1.0);
        vec3 slushC = mix(vec3(0.15, 0.135, 0.115), vec3(0.27, 0.25, 0.22), n2 * 0.7 + edge * 0.3);
        diffuseColor.rgb = mix(diffuseColor.rgb, slushC, smoothstep(0.08, 0.38, slushA));
        wet = max(wet, wxSlush * (0.55 + 0.45 * track));
        // накатанный снег (холодная зима): серо-бурый, кроме колей
        float packed = clamp(wxSnowCover * (0.25 + 0.75 * edge) * (1.0 - track) - 0.15 + (n1 - 0.5) * 0.4, 0.0, 1.0);
        snow = max(snow, smoothstep(0.1, 0.6, packed) * 0.85);
        snowCol = mix(vec3(0.42, 0.40, 0.37), vec3(0.62, 0.62, 0.62), n2 * 0.5);
        snowRough = 0.55;
        // сугроб (вал от снегоуборщика) у самого бордюра: белее, бугристый, грязная кромка
        float berm = smoothstep(0.62, 0.86, edge + (wxFbm(wP.xz * 0.5) - 0.5) * 0.35) * smoothstep(0.05, 0.4, wxSnowCover);
        vec3 bermC = mix(vec3(0.36, 0.34, 0.31), vec3(0.74, 0.75, 0.77), smoothstep(0.75, 0.95, edge + n2 * 0.1));
        snowCol = mix(snowCol, bermC, berm);
        snow = max(snow, berm);
      }`;
    case 'sidewalk': return /* glsl */ `
      porosity = 0.68; wetRough = 0.2; reflK = 0.7;
      float pn = wxFbm(wP.xz * 0.16 + 1.3);
      puddleK = smoothstep(0.68 - wxPuddles * 0.12, 0.74 - wxPuddles * 0.12, pn) * wxPuddles;
      vec4 sm = wxSurfAt(wP.xz);
      float edge = wxEdgeHint >= 0.0 ? wxEdgeHint : max(sm.w, 0.0);
      vec2 tr = wxTrailAt(wP.xz);
      float n1 = wxNoise(wP.xz * 0.45), n2 = wxNoise(wP.xz * 4.0);
      if (wxSnowCover > 0.001 || wxSlush > 0.001) {
        // утоптанный снег пятнами, каша по середине, песок; у бордюра — вал снега
        float cover = wxCoverMask(wxSnowCover * 0.85, wxFbm(wP.xz * 0.3));
        float trod = smoothstep(0.35, 0.7, n1);                    // тропинки, где ходят
        snow = cover * (1.0 - trod * 0.6);
        snowCol = mix(vec3(0.70, 0.71, 0.73), vec3(0.46, 0.44, 0.41), trod);
        snowRough = 0.7;
        float slushA = wxSlush * trod * (0.6 + 0.4 * n2);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.155, 0.135), smoothstep(0.15, 0.5, slushA));
        wet = max(wet, slushA * 0.8);
        float sand = step(0.82, wxHash(floor(wP.xz / 0.06))) * max(wxSlush, wxSnowCover) * 0.7;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.20, 0.11), sand);
        float berm = smoothstep(0.5, 0.85, edge + (wxFbm(wP.xz * 0.5) - 0.5) * 0.3) * smoothstep(0.05, 0.4, wxSnowCover);
        snow = max(snow * (1.0 - tr.r), berm);
        snowCol = mix(snowCol, mix(vec3(0.38, 0.36, 0.33), vec3(0.76, 0.77, 0.79), n1), berm);
      }`;
    case 'area': return /* glsl */ `
      porosity = 0.62; wetRough = 0.22; reflK = 0.6;
      // газон (по маске покрытий или по зелёному цвету) — как рельеф; мощёное — как тротуар
      vec4 sm = wxSurfAt(wP.xz);
      vec3 dc = diffuseColor.rgb;
      float green = smoothstep(0.01, 0.05, dc.g - max(dc.r, dc.b) * 0.92);
      float grassy = sm.x >= 0.0 ? max(step(0.05, sm.x), green) : green;
      float pn = wxFbm(wP.xz * 0.14 + 7.7);
      puddleK = smoothstep(0.66 - wxPuddles * 0.14, 0.73 - wxPuddles * 0.14, pn) * wxPuddles * (1.0 - grassy * 0.6);
      float dead = smoothstep(0.55, 0.85, wxSeason) * grassy;
      float lum = dot(dc, vec3(0.3, 0.55, 0.15));
      diffuseColor.rgb = mix(dc, vec3(lum * 1.15, lum * 0.98, lum * 0.62), dead * 0.75);
      vec2 tr = wxTrailAt(wP.xz);
      float n = wxFbm(wP.xz * 0.25) * 0.8 + wxNoise(wP.xz * 2.5) * 0.2;
      float cover = wxCoverMask(wxSnowCover * mix(0.85, 1.05, grassy), n);
      float trod = (1.0 - grassy) * smoothstep(0.4, 0.75, wxNoise(wP.xz * 0.4 + 3.0));
      snow = cover * (1.0 - trod * 0.5) * (1.0 - tr.r * 0.45);
      snowCol = mix(vec3(0.80, 0.82, 0.86), vec3(0.50, 0.48, 0.45), max(trod, tr.r * 0.6));
      snowRough = 0.75;
      float slushA = wxSlush * (1.0 - grassy) * trod;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.155, 0.135), smoothstep(0.15, 0.5, slushA));
      wet = max(wet, slushA * 0.7);`;
    case 'terrain': return /* glsl */ `
      porosity = 0.7; wetRough = 0.45; reflK = 0.25;
      puddleK = smoothstep(0.72 - wxPuddles * 0.1, 0.78 - wxPuddles * 0.1, wxFbm(wP.xz * 0.09 + 2.1)) * wxPuddles * 0.6;
      vec3 dc = diffuseColor.rgb;
      float dead = smoothstep(0.55, 0.85, wxSeason);
      float aut = smoothstep(0.25, 0.5, wxSeason) * (1.0 - dead);
      float lum = dot(dc, vec3(0.3, 0.55, 0.15));
      diffuseColor.rgb = mix(dc, vec3(lum * 1.15, lum * 0.98, lum * 0.62), dead * 0.75 + aut * 0.3);
      vec2 tr = wxTrailAt(wP.xz);
      float n = wxFbm(wP.xz * 0.2) * 0.8 + wxNoise(wP.xz * 2.2) * 0.2;
      snow = wxCoverMask(wxSnowCover * 1.05, n) * smoothstep(0.45, 0.8, wN.y);
      snow *= 1.0 - tr.r * 0.4;
      snowCol = mix(vec3(0.80, 0.82, 0.86), vec3(0.55, 0.56, 0.6), tr.r);
      snowRough = 0.8;`;
    case 'roof': case 'wall': return /* glsl */ `
      porosity = 0.78; wetRough = 0.35; reflK = 0.3;
      float roof = smoothstep(0.55, 0.8, wN.y);
      puddleK = 0.0;
      // стены: тёмные потёки при дожде (вертикальные полосы)
      float streak = wxNoise(vec2(wP.x * 0.9 + wP.z * 0.9, wP.y * 0.12));
      wet *= mix(0.55 + 0.45 * streak, 1.0, roof);
      float n = wxFbm(wP.xz * 0.3 + wP.y * 0.05);
      snow = roof * wxCoverMask(min(1.0, wxSnowCover * 1.6), n);
      snowCol = vec3(0.80, 0.82, 0.86); snowRough = 0.8;`;
    case 'vegetation': return /* glsl */ `
      porosity = 0.8; wetRough = 0.4; reflK = 0.0; puddleK = 0.0;
      #ifdef WX_HAS_FLAG
      if (vFlag > 0.5 && vFlag < 1.5) {
        // крона: осень — жёлто-рыжая, зима — голые ветки (сквозная «сетка» прутьев, остальное отбрасываем)
        float th = wxNoise(wP.xz * 0.11 + floor(wP.y * 0.05));
        float aut = smoothstep(0.22, 0.5, wxSeason);
        vec3 autC = mix(vec3(0.62, 0.40, 0.05), vec3(0.55, 0.16, 0.03), smoothstep(0.55, 0.85, th));
        autC = mix(autC, vec3(0.42, 0.45, 0.08), smoothstep(0.35, 0.0, th) * 0.8);
        float lum = dot(diffuseColor.rgb, vec3(0.3, 0.6, 0.1));
        diffuseColor.rgb = mix(diffuseColor.rgb, autC * (0.6 + 1.6 * lum), aut * (0.55 + 0.45 * th));
        float bare = smoothstep(0.62, 0.9, wxSeason);
        float drop = smoothstep(0.45, 0.75, wxSeason) * (1.0 - th * 0.5);  // листопад: крона редеет
        if (bare + drop > 0.001) {
          // ветки: две сетки «прутьев» разного масштаба (крупные — тоньше и реже) + редкая дымка мелких веточек
          vec3 q = wP * 1.25;
          float a = wxNoise(q.xy + q.z * 0.61), b = wxNoise(q.zy * 1.13 + q.x * 0.37 + 4.0);
          float c2 = wxNoise(wP.xy * 3.1 + wP.z * 1.7 + 9.0);
          float w = 0.022 + 0.5 * fwidth(a);
          float w2 = 0.016 + 0.5 * fwidth(c2);
          float twig = max(1.0 - smoothstep(w * 0.5, w, min(abs(a - 0.5), abs(b - 0.5))), 1.0 - smoothstep(w2 * 0.5, w2, abs(c2 - 0.5)));
          float leaf = step(drop * 0.9 + bare, wxHash(floor(wP.xz * 6.0) + floor(wP.y * 6.0)));
          // голая крона — полупрозрачная «дымка» мелких веток (alpha-to-coverage при MSAA) + прутья
          float camD = distance(wP, cameraPosition);
          float hz = mix(0.08, 0.34, smoothstep(15.0, 70.0, camD));   // вблизи — отдельные ветки, вдали — сплошная «дымка»
          float alpha = max(leaf, max(twig * 0.95, hz * (0.6 + 0.8 * wxNoise(wP.xy * 0.7 + wP.z * 0.5))));
          // прозрачность — упорядоченным дизерингом по экрану (MSAA в HDR-буфере на retina выключен, alpha-to-coverage не работает)
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          if (alpha < max(ign, 0.06)) discard;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.105, 0.09), (1.0 - leaf) * bare);
        }
        snow = wxSnowCover * smoothstep(0.55, 0.9, wN.y) * step(0.5, wxNoise(wP.xz * 3.0)) * bare;
      } else {
        snow = wxCoverMask(wxSnowCover, wxNoise(wP.xz * 2.0)) * smoothstep(0.6, 0.9, wN.y);
      }
      #endif
      snowCol = vec3(0.78, 0.8, 0.84); snowRough = 0.8;`;
    case 'pine': return /* glsl */ `
      porosity = 0.85; wetRough = 0.45; reflK = 0.0; puddleK = 0.0;
      float n = wxNoise(wP.xz * 1.7 + wP.y * 0.9);
      snow = wxSnowCover * smoothstep(0.3, 0.6, wN.y) * smoothstep(0.35, 0.6, n + wxSnowCover * 0.25);
      snowCol = vec3(0.76, 0.78, 0.82); snowRough = 0.8;`;
    case 'prop': return /* glsl */ `
      porosity = 0.8; wetRough = 0.25; reflK = 0.35; puddleK = 0.0;
      float n = wxNoise(wP.xz * 2.4 + wP.y * 1.3) * 0.7 + wxNoise(wP.xz * 9.0) * 0.3;
      snow = smoothstep(0.6, 0.85, wN.y) * wxCoverMask(min(1.0, wxSnowCover * 1.4), n);
      snowCol = vec3(0.80, 0.82, 0.86); snowRough = 0.8;`;
    case 'car_paint': case 'player_car': return /* glsl */ `
      porosity = 0.92; wetRough = 0.06; reflK = 0.5; puddleK = 0.0;
      ${kind === 'player_car'
        ? 'vec3 loc = (wxCarInv * vec4(wP, 1.0)).xyz; float hgt = loc.y + 0.62; float cap = wxCap;'
        : 'vec3 loc = vWxLoc; float hgt = vWxRel.y; float cap = vWxCapI;'}
      // шапка: верхние поверхности выше ~0.75 м; сдувается спереди назад рваными кусками
      float upk = smoothstep(0.5, 0.82, wN.y) * smoothstep(0.7, 0.85, hgt);
      float er = wxNoise(loc.xz * 3.5) * 0.45 + wxNoise(loc.xz * 11.0) * 0.15 + 0.4 * clamp(-loc.z / 4.4 + 0.5, 0.0, 1.0);
      snow = upk * smoothstep(er - 0.04, er + 0.04, cap * 1.02);
      // капли на лаке
      float drop = step(0.93, wxHash(floor(loc.xz * 28.0) + floor(loc.y * 28.0))) * wet * smoothstep(0.3, 0.7, wN.y);
      diffuseColor.rgb *= 1.0 - drop * 0.25;
      snowCol = vec3(0.84, 0.86, 0.9); snowRough = 0.75;`;
  }
}

/** Качание крон ветром (только вершинный шейдер основного прохода; тени не качаются — незаметно). */
const SWAY = /* glsl */ `
  {
    float hh = max(vWxRel.y, 0.0);
    float k = hh * hh / 160.0;
    vec3 base = vWxPos - vWxRel;
    float ph = dot(base.xz, vec2(0.13, 0.17));
    float s = wxWind * (0.3 + 0.7 * wxWind) * (0.55 + 0.45 * sin(wxTime * 0.8 + ph)) + 0.06 * wxWind * sin(wxTime * 2.7 + ph * 3.0 + hh);
    vWxPos.xz += wxWindDir * s * k * 0.7;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWxPos, 1.0);
  }`;

function capVert(kind: SurfaceKind): string {
  if (kind !== 'car_paint') return '';
  return /* glsl */ `
    #ifdef USE_INSTANCING
      vWxCapI = clamp(fract(aLamp.z + 4.0) / 0.39, 0.0, 1.0);
    #endif`;
}

function fragCode(kind: SurfaceKind): string {
  return /* glsl */ `
{
  vec3 wP = vWxPos; vec3 wN = normalize(vWxN);
  float wet = wxWet, puddleK = 0.0, porosity = 0.7, wetRough = 0.2, reflK = 0.5;
  float snow = 0.0, snowRough = 0.8; vec3 snowCol = vec3(0.8, 0.82, 0.86);
  ${kindCode(kind)}
  ${APPLY}
}
`;
}

/** Локальные uniform-ы для машины игрока (шапка и обратная матрица кузова). */
export interface PlayerCarWeather { wxCap: { value: number }; wxCarInv: { value: THREE.Matrix4 } }
export const playerCarWeather: PlayerCarWeather = { wxCap: { value: 0 }, wxCarInv: { value: new THREE.Matrix4() } };

const DUMMY_CAP = { value: 0 };
const DUMMY_INV = { value: new THREE.Matrix4() };

function shaderUniforms(kind: SurfaceKind): Record<string, { value: unknown }> {
  const w = weatherUniforms;
  return {
    wxWet: w.wetness, wxPuddles: w.puddles, wxRain: w.rainIntensity, wxSnowCover: w.snowCover, wxSlush: w.slush,
    wxSeason: w.season, wxTime: w.time, wxWind: w.windStrength, wxWindDir: w.windDir, wxLightning: w.lightning, wxTrail: w.trail, wxTrailWin: w.trailWin,
    wxSurf: w.surf, wxSurfWin: w.surfWin, wxSkyH: w.skyHorizon, wxSkyZ: w.skyZenith,
    wxCap: kind === 'player_car' ? playerCarWeather.wxCap : DUMMY_CAP,
    wxCarInv: kind === 'player_car' ? playerCarWeather.wxCarInv : DUMMY_INV,
  };
}

/** Чёрная 1×1 заглушка, пока нет карты следов / маски. */
const BLACK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
BLACK.needsUpdate = true;
weatherUniforms.trail.value = BLACK;
weatherUniforms.surf.value = BLACK;

/**
 * Подмешать погоду в материал (один раз после создания). Возвращает тот же материал.
 * Для 'vegetation' материал должен объявлять `varying float vFlag` (props.ts) — иначе кроны обрабатываются как прочее.
 */
export function applySurfaceWeather<M extends THREE.Material>(material: M, kind: SurfaceKind): M {
  const mat = material as M & { userData: { wxKind?: string } };
  if (mat.userData.wxKind) return material;
  mat.userData.wxKind = kind;
  const prevCompile = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (this: THREE.Material, sh, r) {
    prevCompile.call(this, sh, r);
    if (!sh.fragmentShader.includes('#include <emissivemap_fragment>') || !sh.vertexShader.includes('#include <fog_vertex>')) {
      console.warn('[weather] материал без нужных чанков, погода не применена:', kind, mat.name);
      return;
    }
    Object.assign(sh.uniforms, shaderUniforms(kind));
    const hasFlag = /varying\s+float\s+vFlag/.test(sh.fragmentShader);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + COMMON_VERT)
      .replace('#include <fog_vertex>', VERT_CODE.replace('WX_CAP_VERT', capVert(kind)).replace('WX_SWAY', kind === 'vegetation' || kind === 'pine' ? SWAY : '') + '\n#include <fog_vertex>');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + (hasFlag ? '#define WX_HAS_FLAG\n' : '') + COMMON_FRAG)
      .replace('#include <emissivemap_fragment>', fragCode(kind) + '\n#include <emissivemap_fragment>');
  };
  mat.customProgramCacheKey = function (this: THREE.Material) { return prevKey.call(this) + '|wx:' + kind; };
  mat.needsUpdate = true;
  return material;
}

/** Вид поверхности по имени glTF-материала мира (для подмен `CityMaterials.override` и сторонних материалов). */
export function weatherKindFor(name: string): SurfaceKind {
  if (name.startsWith('road')) return 'road';
  if (name === 'sidewalk' || name === 'curb') return 'sidewalk';
  if (name.startsWith('area_')) return 'area';
  if (name.startsWith('building')) return 'roof';
  if (name === 'terrain') return 'terrain';
  return 'prop';
}
