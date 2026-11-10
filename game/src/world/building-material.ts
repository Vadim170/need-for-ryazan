import * as THREE from 'three';
import { texUniforms, TEX_GLSL } from '../render/textures';
import { quality } from '../render/quality';

/**
 * Здания v2 (docs/world-format.md «Здания v2», docs/stage2/buildings.md): один материал на все дома тайла.
 *
 * Атрибуты (готовит prepBuildingGeometry из glTF):
 *   position, normal, uv (стены: u — м от начала стены, v — м от пола 1-го этажа; крыши — свои),
 *   aWall = TEXCOORD_1 (длина стены, высота этажа), color = COLOR_0 (цвет фасада/крыши, linear),
 *   aArch = _ARCH (архетип, seed 0..255, часть, этажность).
 * Тайлы старого формата (без _ARCH) рисуются в «наследном» режиме: сплошная сетка окон по u периметра.
 *
 * Шейдер: сетки окон по архетипу (шаг = STYLE.win_step в pipeline/world/archetypes.py), швы панелей, кирпич,
 * штукатурка с пилястрами/рустом, наличники, кондиционеры, шторы, рамы; псевдо-глубина откоса окна (сдвиг стекла по
 * направлению взгляда); ночью — окна светятся (uNfrNight × доля горящих uNfrWin; render/day-night.ts пишет оба).
 */

export interface BuildingUniforms { uNfrNight: { value: number }; uNfrWin: { value: number }; /** рассеянный свет неба (linear) — освещённость интерьеров днём */ uNfrAmb: { value: THREE.Color } }

/** id архетипов — как ARCH в pipeline/world/archetypes.py. */
export const ARCH_IDS = {
  other: 0, panel5: 1, brick5: 2, panel9: 3, tower: 4, stalinka: 5, merchant: 6, house: 7, modern: 8,
  commercial: 9, garage: 10, industrial: 11, church: 12, school: 13, public: 14, shed: 15,
} as const;

/** Наследные материалы (до v2) → архетип и цвет. */
const LEGACY: Record<string, [number, number]> = {
  building_apartments: [ARCH_IDS.panel5, 0xb4aa98],
  building_house: [ARCH_IDS.house, 0xc99a7a],
  building_commercial: [ARCH_IDS.commercial, 0x8e9aa6],
  building_garage: [ARCH_IDS.garage, 0x8a8782],
  building_other: [ARCH_IDS.other, 0xa89f93],
};

function toFloat(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number): Float32Array {
  const out = new Float32Array(a.count * size);
  for (let i = 0; i < a.count; i++) for (let j = 0; j < size; j++) out[i * size + j] = j < a.itemSize ? a.getComponent(i, j) : 0;
  return out;
}

/**
 * Копия геометрии примитива здания в мировых координатах с атрибутами position, normal, uv, aWall, color, aArch.
 * Работает и для v2 (с _ARCH), и для старых тайлов (по имени материала).
 */
export function prepBuildingGeometry(m: THREE.Mesh, matName: string): THREE.BufferGeometry {
  const src = m.geometry;
  const n = src.getAttribute('position').count;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(toFloat(src.getAttribute('position'), 3), 3));
  if (src.getAttribute('normal')) g.setAttribute('normal', new THREE.BufferAttribute(toFloat(src.getAttribute('normal'), 3), 3));
  else { g.setIndex(src.index); g.computeVertexNormals(); }
  const uv = src.getAttribute('uv');
  g.setAttribute('uv', new THREE.BufferAttribute(uv ? toFloat(uv, 2) : new Float32Array(n * 2), 2));
  const arch = src.getAttribute('_arch');
  const wall = src.getAttribute('uv1');
  const col = src.getAttribute('color');
  if (arch && wall && col) {
    g.setAttribute('aWall', new THREE.BufferAttribute(toFloat(wall, 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(toFloat(col, 3), 3));
    g.setAttribute('aArch', new THREE.BufferAttribute(toFloat(arch, 4), 4));
  } else {
    const [a, hex] = LEGACY[matName] ?? LEGACY.building_other;
    const c = new THREE.Color(hex);
    const nrm = g.getAttribute('normal');
    const cc = new Float32Array(n * 3), aa = new Float32Array(n * 4), ww = new Float32Array(n * 2);
    const seed = Math.floor(Math.random() * 256);
    for (let i = 0; i < n; i++) {
      cc[i * 3] = c.r; cc[i * 3 + 1] = c.g; cc[i * 3 + 2] = c.b;
      aa[i * 4] = a; aa[i * 4 + 1] = seed; aa[i * 4 + 2] = nrm.getY(i) > 0.6 ? 3 : 0; aa[i * 4 + 3] = 0;
      ww[i * 2 + 1] = 3.0; // длина стены 0 → наследная сплошная сетка
    }
    g.setAttribute('aWall', new THREE.BufferAttribute(ww, 2));
    g.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    g.setAttribute('aArch', new THREE.BufferAttribute(aa, 4));
  }
  if (src.index) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(src.index.array), 1));
  if (!m.matrixWorld.equals(new THREE.Matrix4())) g.applyMatrix4(m.matrixWorld);
  return g;
}

const GLSL_COMMON = /* glsl */ `
varying vec4 vBArch; varying vec2 vBWall; varying vec3 vBPos; varying vec3 vBN; varying vec2 vBUv;
uniform float uNfrNight; uniform float uNfrWin; uniform vec3 uNfrAmb;
float bHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bHash1(float x) { return fract(sin(x * 91.3458) * 47453.5453); }
float bNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bHash(i), bHash(i + vec2(1, 0)), f.x), mix(bHash(i + vec2(0, 1)), bHash(i + vec2(1, 1)), f.x), f.y);
}
// сглаженная ступенька с антиалиасингом по экранной производной
float bBox(vec2 p, vec2 h) { vec2 d = abs(p) - h; vec2 w = max(fwidth(p), vec2(1e-4)); vec2 s = clamp(0.5 - d / w, 0.0, 1.0); return s.x * s.y; }
float bLine(float x, float period, float width) {
  float f = abs(fract(x / period + 0.5) - 0.5) * period; float w = max(fwidth(x), 1e-4);
  return 1.0 - smoothstep(width * 0.5, width * 0.5 + w, f);
}
// затухание мелкой детали с расстоянием (fw — размер пикселя в метрах)
float bFade(float fw, float size) { return 1.0 - smoothstep(size * 0.25, size * 0.7, fw); }
vec3 bBrick(vec2 p, vec3 base, float fw, float seed) {
  float row = floor(p.y / 0.077);
  float x = p.x / 0.26 + 0.5 * mod(row, 2.0);
  vec2 id = vec2(floor(x), row);
  float h = bHash(id + seed);
  vec3 c = base * (0.86 + 0.24 * h);
  float mortar = max(bLine(p.y, 0.077, 0.012), bLine(x * 0.26, 0.26, 0.012));
  float f = bFade(fw, 0.06);
  return mix(base, mix(c, vec3(0.62, 0.6, 0.56) * (0.6 + 0.4 * dot(base, vec3(0.33))), mortar * 0.75), f);
}
`;

/** Параметры окон по архетипу: (шаг, ширина, высота, подоконник). Шаг — как STYLE.win_step в пайплайне. */
const GLSL_PARAMS = /* glsl */ `
vec4 bWinParams(float a) {
  if (a < 0.5) return vec4(3.2, 1.4, 1.5, 0.9);
  if (a < 1.5) return vec4(3.2, 1.45, 1.42, 0.85);   // panel5 (1-464)
  if (a < 2.5) return vec4(3.0, 1.3, 1.45, 0.85);    // brick5 (1-447)
  if (a < 3.5) return vec4(3.0, 1.5, 1.42, 0.85);    // panel9
  if (a < 4.5) return vec4(3.0, 1.4, 1.45, 0.85);    // tower
  if (a < 5.5) return vec4(3.4, 1.3, 1.95, 0.85);    // stalinka
  if (a < 6.5) return vec4(3.0, 1.1, 1.95, 1.0);     // merchant
  if (a < 7.5) return vec4(3.4, 1.0, 1.25, 0.95);    // house
  if (a < 8.5) return vec4(3.3, 1.8, 1.65, 0.6);     // modern
  if (a < 9.5) return vec4(4.0, 3.5, 1.8, 0.9);      // commercial (верхние этажи — ленточные)
  if (a < 10.5) return vec4(3.5, 2.6, 2.3, 0.0);     // garage: ворота
  if (a < 11.5) return vec4(6.0, 5.4, 1.4, 2.6);     // industrial: ленточное остекление
  if (a < 12.5) return vec4(4.0, 1.2, 2.7, 1.4);     // church
  if (a < 13.5) return vec4(3.0, 2.2, 1.9, 0.85);    // school
  if (a < 14.5) return vec4(3.2, 1.8, 1.6, 0.9);     // public
  return vec4(4.0, 0.0, 0.0, 0.0);                   // shed
}
`;

/**
 * Интерьер за стеклом (interior mapping): луч из точки стекла внутрь комнаты-коробки (ширина — шаг окон, высота —
 * этаж, глубина 3.5–6 м), цвет стен/пола/потолка/мебели по хешу комнаты. Возвращает альбедо точки попадания и (в .w)
 * освещённость от окна (днём) — яркость лампы ночью считается отдельно.
 */
const GLSL_INTERIOR = /* glsl */ `
vec4 bInterior(vec3 o, vec3 d, float S, float FH, float hr, float shop) {
  float Dr = shop > 0.5 ? 7.0 : 3.6 + 2.4 * fract(hr * 7.13);
  d.z = max(d.z, 0.05);
  float tx = (d.x > 0.0 ? (S * 0.5 - o.x) : (-S * 0.5 - o.x)) / (abs(d.x) > 1e-4 ? d.x : 1e-4);
  float ty = (d.y > 0.0 ? (FH - 0.25 - o.y) : (0.0 - o.y)) / (abs(d.y) > 1e-4 ? d.y : 1e-4);
  float tz = Dr / d.z;
  tx = tx < 0.0 ? 1e4 : tx; ty = ty < 0.0 ? 1e4 : ty;
  float t = min(min(tx, ty), tz);
  vec3 h = o + d * t;
  // палитра комнаты: обои/краска, пол (паркет/линолеум), потолок
  float h1 = fract(hr * 13.7), h2 = fract(hr * 31.3), h3 = fract(hr * 5.91);
  vec3 wallC = h1 < 0.3 ? vec3(0.62, 0.55, 0.42) : h1 < 0.5 ? vec3(0.55, 0.6, 0.5) : h1 < 0.65 ? vec3(0.5, 0.56, 0.62) : h1 < 0.85 ? vec3(0.7, 0.68, 0.63) : vec3(0.6, 0.42, 0.36);
  vec3 floorC = h2 < 0.6 ? vec3(0.32, 0.2, 0.11) : vec3(0.42, 0.34, 0.26);
  if (shop > 0.5) { wallC = vec3(0.75); floorC = vec3(0.5, 0.5, 0.48); }
  vec3 c; float lit;
  if (t == tz) {
    c = wallC * (0.9 + 0.1 * sin(h.x * 40.0 * step(0.5, h3)));        // обои в полоску у части комнат
    // мебель у задней стены: шкаф/стенка; у магазинов — стеллажи
    float fx = (h.x / S + 0.5);
    if (shop > 0.5) {
      float shelf = step(0.15, h.y) * step(h.y, 2.1) * step(0.5, fract(h.y / 0.45));
      c = mix(c, vec3(0.35 + 0.4 * fract(floor(h.x * 3.0) * 0.37 + hr), 0.3, 0.25), shelf);
    } else if (fx > 0.1 + 0.4 * h3 && fx < 0.55 + 0.4 * h3 && h.y < 1.9 + 0.3 * h2) {
      c = h2 < 0.5 ? vec3(0.28, 0.17, 0.09) : vec3(0.6, 0.58, 0.55);
    }
    // картина/ковёр на стене
    if (h3 > 0.6 && abs(h.x + S * 0.2) < 0.45 && abs(h.y - 1.5) < 0.35) c = vec3(0.45, 0.12, 0.1) * (0.8 + 0.4 * h1);
    lit = 0.45;
  } else if (t == ty) {
    if (d.y > 0.0) { c = vec3(0.82, 0.8, 0.76); lit = 0.7; }            // потолок: светлее у окна
    else {
      c = floorC * (0.85 + 0.15 * step(0.5, fract(h.x * 5.0 + floor(h.z * 1.2) * 0.5)) * step(h2, 0.6));
      if (abs(h.x) < S * 0.3 && abs(h.z - Dr * 0.5) < Dr * 0.25) c = vec3(0.4, 0.12, 0.1) * (0.8 + 0.3 * h3); // ковёр
      lit = 0.9;
    }
  } else {
    c = wallC * 0.92; lit = 0.6;
    // стол/диван у боковой стены
    if (h.y < 0.75 && h.z > 0.8 && h.z < 2.4) c = h1 < 0.5 ? vec3(0.3, 0.22, 0.15) : vec3(0.3, 0.35, 0.45);
  }
  // свет из окна гаснет вглубь комнаты
  lit *= 0.25 + 0.75 * exp(-h.z * 0.55);
  return vec4(c, lit);
}
`;

const GLSL_MAIN = /* glsl */ `
{
  float A = floor(vBArch.x + 0.5), SEED = vBArch.y, PART = floor(vBArch.z + 0.5), LEV = vBArch.w;
  vec3 N = normalize(vBN);
  vec3 base = diffuseColor.rgb;          // вершинный цвет (фасад/крыша), linear — «настоящий» цвет из панорам/реестра
  vec3 c = base;
  float rough = 0.88, metal = 0.0;
  vec3 V = normalize(cameraPosition - vBPos);
  float fwM = length(fwidth(vBPos));     // ~ размер пикселя в метрах
  float bseed = SEED * 0.137 + 3.0;
  vec3 tsN = vec3(0.0, 0.0, 1.0); float nK = 1.0, aoT = 1.0;
  mat3 TBN = nfrTBN(vBPos, N, vBUv);
  float sat = max(max(base.r, base.g), base.b) - min(min(base.r, base.g), base.b);
  float lum = dot(base, vec3(0.3, 0.59, 0.11));
  if (PART > 2.5 && PART < 3.5) {
    // плоская крыша: рубероид/битум (фактура щебня в битуме), заплаты, лужи-пятна
    vec2 p = vBPos.xz;
    NfrT T = nfrTex(vec2(p.x, -p.y) * 0.8, L_ASPHALT_PATCH);
    TBN = mat3(vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, -1.0), N);
    float n = bNoise(p * 2.1) * 0.6 + bNoise(p * 9.0) * 0.4 * bFade(fwM, 0.2);
    c = base * (0.92 + 0.14 * n) * mix(vec3(1.0), vec3(dot(T.alb, vec3(0.33))), 0.8);
    c = mix(c, base * 1.15, smoothstep(0.7, 0.74, bNoise(p * 0.15 + bseed * 2.0)) * 0.35);   // редкие заплаты
    rough = 0.95 * T.rough; tsN = T.nrm; nK = 0.7; aoT = T.ao;
  } else if (PART > 3.5 && PART < 4.5) {
    // скатная: шифер (серый), оцинковка (светлый серый), крашеный профлист/металл (цвет из пайплайна)
    // один чистый цвет на крышу + фактура; ржавчина — лишь у частных домов/гаражей/сараев
    if (sat < 0.04 && lum > 0.12) {
      bool galv = lum > 0.42;
      NfrT T = nfrTexUV(vBUv * (galv ? vec2(1.0 / 1.12) : vec2(1.0 / 1.8)), galv ? L_ROOF_GALV : L_ROOF_SLATE);
      float rowl = galv ? 0.0 : bLine(vBUv.y, 1.1, 0.05) * bFade(fwM, 0.1);          // нахлёст листов шифера
      c = base * mix(vec3(1.0), T.alb, galv ? 0.6 : 0.85) * (1.0 - 0.2 * rowl);
      if (!galv) c = mix(c, c * vec3(0.75, 0.8, 0.6), smoothstep(0.6, 0.8, bNoise(vBUv * 0.7 + bseed)) * 0.5); // мох/лишайник
      rough = galv ? 0.45 * T.rough : 0.9; metal = galv ? 0.7 : 0.0;
      tsN = T.nrm; aoT = T.ao;
    } else {
      NfrT T = nfrTexUV(vBUv * 0.5, L_ROOF_PROFILE);
      c = base * mix(vec3(1.0), vec3(dot(T.alb, vec3(0.33))), 0.6);
      bool rusty = (A == 7.0 || A == 10.0 || A == 15.0) && fract(SEED * 0.0131) < 0.35;
      if (rusty) {
        NfrT R = nfrTexUV(vBUv, L_METAL_RUST);
        float rust = smoothstep(0.62, 0.86, bNoise(vBUv * vec2(1.6, 0.9) + bseed * 1.7) + (R.h - 0.5) * 0.3);
        c = mix(c, vec3(0.22, 0.09, 0.03) * R.alb, rust * 0.6);
        T = nfrMixT(T, R, rust * 0.6);
      }
      rough = 0.5 * T.rough; metal = 0.35;
      tsN = T.nrm; aoT = T.ao;
    }
  } else if (PART > 4.5 && PART < 6.5) {
    // карниз/парапет/коробки на крыше
    NfrT T = nfrTex(vBUv, L_CONCRETE);
    c = base * (0.92 + 0.12 * bNoise(vBPos.xz * 0.7 + vBPos.y)) * mix(vec3(1.0), T.alb, 0.5);
    rough = 0.9; tsN = T.nrm; nK = 0.6; aoT = T.ao;
  } else if (PART > 7.5 && PART < 8.5) {
    // купол: золото — металл, иначе крашеный металл; рёбра
    float gold = step(0.18, base.r - base.b) * step(0.25, base.r);
    float rib = bLine(vBUv.x, 1.2, 0.06) * bFade(fwM, 0.1);
    c = base * (1.0 - 0.25 * rib);
    // окружение (PMREM неба) есть — золото полноценным металлом
    rough = mix(0.4, 0.22, gold); metal = mix(0.35, 1.0, gold);
    if (gold > 0.5) c = vec3(0.95, 0.68, 0.28) * (0.85 + 0.3 * pow(max(N.y, 0.0), 2.0));
  } else {
    // ---------------- стены (0 стена, 1 с витринами, 2 глухая, 7 фронтон, 9 барабан/колокольня)
    vec2 P = vBUv;                       // u — м вдоль стены, v — м от пола 1-го этажа
    float L = vBWall.x, FH = max(vBWall.y, 2.4);
    vec4 wp = bWinParams(A);
    float S = wp.x, WW = wp.y, WH = wp.z, SILL = wp.w;
    bool legacy = L < 0.01;
    if (PART > 8.5) { S = 1.7; WW = 0.55; WH = 1.9; SILL = 1.2; }
    // колонки окон: по центру стены, поле 0.6 м с краёв
    float ncol = legacy ? 1e4 : floor(max(L - 1.2, 0.0) / S);
    float start = legacy ? 0.0 : (L - ncol * S) * 0.5;
    float cx = P.x - start;
    float col = floor(cx / S);
    float lx = cx - (col + 0.5) * S;               // от центра колонки
    float fl = floor(P.y / FH);
    float ly = P.y - fl * FH;                     // от пола этажа
    float levels = LEV > 0.5 ? LEV : 1e4;
    bool inGrid = col >= 0.0 && col < ncol && fl >= 0.0 && fl < levels && PART < 1.5 && WW > 0.0;
    vec2 wid = vec2(col, fl) + SEED * 1.37;
    float hw = bHash(wid), hw2 = bHash(wid + 17.3), hb = bHash1(SEED + 1.0);
    // ---- материал стены
    bool brick = A == 2.0 || (A == 4.0 && hb < 0.5) || (A == 6.0 && base.r > base.g * 1.25) || A == 10.0 && hb < 0.6
                 || (A == 7.0 && base.r > base.g * 1.2 && base.r > 0.2) || (A == 13.0 && hb < 0.5) || (A == 11.0 && hb < 0.35);
    bool wood = A == 7.0 && dot(base, vec3(0.33)) < 0.22 && base.r > base.b * 1.25 || A == 15.0 && hb < 0.5;
    bool panel = A == 1.0 || A == 3.0 || (A == 4.0 && hb >= 0.5) || (A == 11.0 && hb >= 0.35) || A == 9.0;
    float stain = bNoise(vec2(P.x * 0.15, P.y * 0.6) + bseed);
    if (brick) {
      // красный или белый силикатный — по цвету фасада; масштаб текстуры — реальный (ряд ≈ 77 мм)
      bool whiteB = sat < 0.08 && lum > 0.3;
      NfrT T = nfrTexUV(P / (whiteB ? 1.5 : 1.0) + vec2(bseed * 0.37, 0.0), whiteB ? L_BRICK_WHITE : L_BRICK_RED);
      c = base * mix(vec3(1.0), T.alb, 0.95);
      tsN = T.nrm; nK = 1.0; aoT = T.ao; rough = 0.9 * T.rough;
    } else if (wood) {
      NfrT T = nfrTexUV(P + vec2(bseed, 0.0), L_WOOD);
      c = base * mix(vec3(1.0), T.alb, 0.9);
      tsN = T.nrm; aoT = T.ao; rough = 0.85 * T.rough;
    } else if (panel) {
      // швы панелей: по этажам и по колонкам (1-464 — панель на шаг окна), лёгкая разнотонность панелей
      float pw = A == 9.0 ? 1.2 : (A == 11.0 ? 6.0 : S);
      float ph = A == 9.0 ? 0.6 : (A == 11.0 ? 1.2 : FH);
      vec2 pid = floor(vec2(cx / pw, (P.y + 0.3) / ph));
      NfrT T = nfrTexUV((P + bHash(pid) * 3.7) / 2.0, A == 9.0 ? L_PLASTER : L_CONCRETE_STAINED);
      c = base * (0.94 + 0.1 * bHash(pid + bseed)) * mix(vec3(1.0), T.alb, A == 9.0 ? 0.2 : 0.55);
      float seam = max(bLine(P.y + 0.3, ph, 0.035), bLine(cx, pw, 0.035)) * bFade(fwM, 0.05);
      c *= 1.0 - 0.35 * seam;
      // герметик швов темнеет и течёт вниз
      c *= 1.0 - 0.12 * smoothstep(0.6, 1.0, bNoise(vec2(cx * 3.0, P.y * 0.3))) * bLine(cx, pw, 0.3);
      tsN = T.nrm; nK = 0.5; aoT = mix(1.0, T.ao, 0.6) * (1.0 - 0.4 * seam); rough = 0.85;
      if (A == 9.0) { rough = 0.4; metal = 0.3; }
    } else {
      // штукатурка: гладкая окрашенная (сталинки, купеческие) или «шуба» (частный сектор, школы, общественные)
      bool rough_ = A == 7.0 || A == 13.0 || A == 14.0 || A == 0.0 || A == 15.0;
      NfrT T = nfrTexUV(P / 2.0 + vec2(bseed, 0.0), rough_ ? L_STUCCO : L_PLASTER);
      c = base * (0.92 + 0.1 * stain + 0.04 * bNoise(P * 3.0) * bFade(fwM, 0.3)) * mix(vec3(1.0), T.alb, rough_ ? 0.6 : 0.45);
      tsN = T.nrm; nK = rough_ ? 0.9 : 0.55; aoT = T.ao; rough = 0.9;
    }
    // ---- грязь и потёки (декали в шейдере): брызги у земли, потёки под окнами и со свеса крыши
    float gN = bNoise(vec2(P.x * 1.3, P.y * 4.0) + bseed);
    float ground = 1.0 - smoothstep(0.1, 0.9 + 0.5 * gN, P.y);
    c *= 1.0 - 0.28 * ground;
    c = mix(c, c * vec3(0.95, 0.88, 0.8), ground * 0.5);
    if (!legacy) {
      // со свеса/парапета: вертикальные полосы с рваным краем
      float top = levels < 1e3 ? levels * FH : 1e4;
      float dTop = top - P.y;
      float streakTop = (1.0 - smoothstep(0.0, 1.2 + 2.5 * bNoise(vec2(P.x * 0.7, 0.0) + bseed), dTop)) * smoothstep(0.3, 0.8, bNoise(vec2(P.x * 2.3, P.y * 0.15) + bseed));
      c *= 1.0 - 0.22 * streakTop * step(0.0, dTop);
    }
    c *= 0.94 + 0.06 * smoothstep(-1.0, 3.0, P.y);
    // ---- архитектурный декор
    if (A == 5.0 && !legacy) {
      // сталинка: руст 1-го этажа, межэтажный пояс, пилястры между парами окон, аттиковый пояс
      if (fl < 0.5 && P.y > 0.0) c *= 1.0 - 0.28 * bLine(P.y, 0.55, 0.05) * bFade(fwM, 0.05);
      float belt = 1.0 - step(0.3, abs(P.y - FH + 0.1));
      c = mix(c, base * 1.12, belt * 0.8);
      float pil = (mod(col, 2.0) < 0.5 && abs(lx + S * 0.5) < 0.3 && fl > 0.5 && fl < levels - 0.5) ? 1.0 : 0.0;
      c = mix(c, base * 1.1, pil * 0.7);
      c = mix(c, base * 1.1, smoothstep(0.2, 0.0, abs(P.y - levels * FH + 0.4)) * 0.8);
    } else if (A == 6.0 && !legacy) {
      // купеческий: межэтажные карнизы, пояс под карнизом
      float band = 1.0 - smoothstep(0.0, 0.05, abs(ly - FH + 0.25) - 0.12);
      c = mix(c, brick ? base * 0.75 : base * 1.15, band * 0.85 * step(0.5, fl + 1.0));
    } else if (A == 8.0 && !legacy) {
      // современный: акцентные вертикали и тёмный 1-й этаж
      vec3 acc = hb < 0.33 ? vec3(0.45, 0.12, 0.07) : hb < 0.66 ? vec3(0.55, 0.28, 0.06) : vec3(0.1, 0.18, 0.38);
      c = mix(c, acc, step(mod(col + floor(hb * 3.0), 4.0), 0.5) * step(0.5, fl) * 0.8);
      if (fl < 0.5) c = vec3(0.12, 0.12, 0.13);
    }
    // цоколь
    if (P.y < 0.0) {
      NfrT T = nfrTexUV(P / 1.23, L_CONCRETE);
      c = (A == 7.0 ? vec3(0.22, 0.2, 0.18) : vec3(0.25, 0.245, 0.235)) * (0.85 + 0.25 * bNoise(P * vec2(0.8, 3.0) + bseed)) * mix(vec3(1.0), T.alb, 0.8);
      tsN = T.nrm; nK = 0.8; aoT = T.ao;
      // окна/продухи подвала под каждой колонкой окон; на склоне (высокий цоколь) — ещё ряд окон цокольного этажа
      if (!legacy && (A <= 5.0 || A == 8.0 || A == 13.0 || A == 14.0) && col >= 0.0 && col < ncol) {
        float bw = bBox(vec2(lx, P.y + 0.42), vec2(0.4, 0.17));
        if (P.y < -1.6) bw = max(bw, bBox(vec2(lx, P.y + 2.1), vec2(WW * 0.45, 0.55)));
        c = mix(c, vec3(0.03, 0.03, 0.035), bw);
      }
      inGrid = false;
    }
    // ---- витрины 1-го этажа
    bool shop = (PART > 0.5 && PART < 1.5 && fl < 0.5) || (A == 9.0 && fl < 0.5 && PART < 1.5);
    float win = 0.0;
    vec2 q = vec2(lx, ly);
    float ww = WW, wh = WH, sill = SILL;
    if (shop && inGrid) { ww = S * 0.86; sill = 0.35; wh = min(FH - 0.6, 2.6); }
    if (A == 9.0 && fl > 0.5) { ww = S - 0.25; }
    if (A == 11.0) { inGrid = inGrid && fl < 0.5; }
    // ворота гаражей
    if (A == 10.0) {
      if (!legacy && L > 5.0 && col >= 0.0 && col < ncol && P.y < 2.6) {
        float g = bBox(vec2(lx, P.y - 1.15), vec2(1.3, 1.15));
        float hc = bHash(vec2(col, SEED));
        vec3 gc = hc < 0.3 ? vec3(0.22, 0.12, 0.06) : hc < 0.55 ? vec3(0.1, 0.18, 0.11) : hc < 0.75 ? vec3(0.25, 0.26, 0.27) : hc < 0.9 ? vec3(0.08, 0.13, 0.25) : vec3(0.32, 0.1, 0.04);
        NfrT G = nfrTexUV(vec2(lx, P.y) * 0.5 + hc * 3.0, L_METAL_PAINTED);
        NfrT R = nfrTexUV(vec2(lx, P.y) * 0.7 + hc * 5.0, L_METAL_RUST);
        float rust = smoothstep(0.5, 0.8, bNoise(P * 2.0 + hc * 10.0) + (R.h - 0.5) * 0.4) * 0.7;
        gc = mix(gc * mix(vec3(1.0), vec3(dot(G.alb, vec3(0.33))), 0.6), vec3(0.2, 0.08, 0.03) * R.alb, rust);
        gc *= 0.85 + 0.25 * bLine(P.y, 0.12, 0.05) * bFade(fwM, 0.04);
        c = mix(c, gc, g);
        rough = mix(rough, 0.55, g); metal = mix(metal, 0.5 * (1.0 - rust), g);
        tsN = normalize(mix(tsN, nfrMixT(G, R, rust).nrm, g));
      }
      inGrid = false;
    }
    if (A == 15.0) inGrid = false;
    float aboveWin = 0.0;
    if (inGrid) {
      // арочный верх у купеческих/церквей
      float arch = (A == 6.0 || A == 12.0 || PART > 8.5) ? 1.0 : 0.0;
      vec2 wc = vec2(0.0, sill + wh * 0.5);
      win = bBox(q - wc, vec2(ww, wh) * 0.5);
      if (arch > 0.5) {
        float rTop = ww * 0.5;
        vec2 ac = vec2(0.0, sill + wh - rTop);
        float rect = bBox(q - vec2(0.0, (sill + ac.y) * 0.5), vec2(ww * 0.5, (ac.y - sill) * 0.5));
        float circ = clamp((rTop - length(q - ac)) / max(fwidth(q.y), 1e-4) + 0.5, 0.0, 1.0) * step(ac.y, q.y);
        win = max(rect, circ);
      }
      // потёки из-под подоконного слива: два ручья от краёв окна вниз (старые дома сильнее)
      if (!shop && fl > 0.5) {
        float below = sill - q.y;
        float age = A == 8.0 || A == 9.0 ? 0.3 : 1.0;
        float run = exp(-pow((abs(q.x) - ww * 0.42) / 0.09, 2.0)) * (1.0 - smoothstep(0.0, 0.9 + 1.4 * hw, below)) * step(0.0, below);
        c *= 1.0 - 0.22 * run * age * smoothstep(0.3, 0.6, bNoise(vec2(q.x * 9.0, P.y * 0.8) + wid));
      }
      // наличники/обрамление
      float trimW = A == 5.0 ? 0.14 : (A == 7.0 ? 0.13 : (A == 6.0 ? 0.12 : 0.0));
      if (trimW > 0.0 && !shop) {
        float outer = bBox(q - wc, vec2(ww, wh) * 0.5 + trimW);
        vec3 tc = A == 7.0 ? (hw2 < 0.5 ? vec3(0.8) : (hw2 < 0.75 ? vec3(0.12, 0.25, 0.5) : vec3(0.15, 0.32, 0.18))) : (brick ? base * 0.7 : min(base * 1.35, vec3(0.85)));
        c = mix(c, tc, (outer - win) * (1.0 - step(0.5, arch) * 0.3));
        // сандрик (карниз над окном) у сталинок, «гребень» наличника у изб
        if (A == 5.0 || A == 7.0) {
          float cap = bBox(q - vec2(0.0, sill + wh + trimW + 0.12), vec2(ww * 0.5 + trimW + 0.08, 0.1));
          c = mix(c, tc, cap);
        }
      }
      // кондиционер (часть окон жилых/офисов)
      if ((A <= 5.0 || A == 8.0 || A == 14.0) && hw2 < 0.1 && fl > 0.5) {
        float ac = bBox(q - vec2(ww * 0.5 + 0.55, sill - 0.35), vec2(0.42, 0.27));
        c = mix(c, vec3(0.72, 0.72, 0.7) * (0.9 - 0.25 * smoothstep(-0.1, -0.27, q.y - sill + 0.35)), ac);
        // ржавый потёк под кондиционером
        c *= 1.0 - 0.25 * bBox(q - vec2(ww * 0.5 + 0.55, sill - 1.2), vec2(0.04, 0.6)) * (1.0 - ac);
      }
      // подоконный слив (светлая полоска) у панелек
      c = mix(c, vec3(0.62), bBox(q - vec2(0.0, sill - 0.04), vec2(ww * 0.5 + 0.05, 0.035)) * step(A, 4.5) * (1.0 - win));
    }
    if (win > 0.001) {
      // ---- окно: псевдо-глубина откоса (сдвиг стекла по взгляду в касательном базисе стены)
      vec3 Vt = vec3(dot(V, TBN[0]), dot(V, TBN[1]), max(dot(V, N), 0.08));
      float depth = shop ? 0.08 : (A == 5.0 || A == 6.0 || A == 12.0 ? 0.32 : (A == 8.0 || A == 9.0 ? 0.06 : 0.18));
      vec2 g = q - Vt.xy / Vt.z * depth;            // точка стекла в координатах окна
      vec2 wc2 = vec2(0.0, sill + wh * 0.5);
      float inGlass = bBox(g - wc2, vec2(ww, wh) * 0.5);
      // рама: ПВХ (белая) или старое дерево; переплёты
      float pvc = step(0.28, hw);
      vec3 frameC = pvc > 0.5 ? vec3(0.8, 0.8, 0.78) : (hw < 0.14 ? vec3(0.22, 0.14, 0.08) : vec3(0.62, 0.6, 0.55));
      if (A == 8.0 || A == 9.0) frameC = vec3(0.12, 0.13, 0.14);
      vec2 gl = g - vec2(-ww * 0.5, sill);           // от нижнего левого угла
      float fw = 0.06;
      float mull = shop ? bLine(gl.x, ww / 3.0, fw) : (ww > 1.2 ? bLine(gl.x - ww * (hw2 < 0.5 ? 0.5 : 0.36), 1e3, fw) : 0.0);
      float transom = (wh > 1.5 && !shop) ? bLine(gl.y - wh * 0.72, 1e3, fw) : 0.0;
      float edge = 1.0 - bBox(g - wc2, vec2(ww, wh) * 0.5 - fw);
      float frame = clamp(max(max(mull, transom), edge), 0.0, 1.0) * bFade(fwM, 0.04);
      // интерьер: interior mapping (комната за стеклом) или тёмная заглушка (low)
      float roomH = bHash(wid + 9.1);
      vec3 inside; float roomLit = 0.0;
      #ifdef NFR_INTERIORS
        vec4 ir = bInterior(vec3(g.x, g.y, 0.0), normalize(vec3(-Vt.x, -Vt.y, Vt.z)), S, FH, roomH, shop ? 1.0 : 0.0);
        inside = ir.rgb; roomLit = ir.w;
      #else
        inside = vec3(0.3, 0.28, 0.25) * (0.7 + 0.6 * hw2); roomLit = 0.3;
      #endif
      // шторы/тюль (у стекла, перед комнатой)
      float cur = hw2 < 0.55 ? 1.0 : 0.0, curA = 0.0;
      vec3 cc = vec3(0.0);
      if (cur > 0.5 && !shop) {
        cc = hw < 0.3 ? vec3(0.75, 0.7, 0.6) : hw < 0.5 ? vec3(0.8, 0.8, 0.78) : hw < 0.65 ? vec3(0.55, 0.35, 0.25) : vec3(0.45, 0.5, 0.55);
        float folds = 0.75 + 0.25 * sin(gl.x * 30.0) * bFade(fwM, 0.03);
        cc *= folds;
        float side = step(gl.x, ww * (0.18 + 0.25 * hw)) + step(ww * (0.82 - 0.25 * hw2), gl.x);
        curA = clamp(side + 0.45 * step(0.3, hw), 0.0, 1.0);
      }
      // стекло: диффуз почти чёрный (отражение даёт окружение по Френелю), интерьер — свечение (не освещается солнцем)
      float glassK = inGlass * (1.0 - frame) * win;
      vec3 reveal = c * 0.55;                         // откос: стена в тени
      vec3 wcol = mix(reveal, mix(vec3(0.015), frameC, frame), inGlass);
      c = mix(c, wcol, win);
      rough = mix(rough, mix(0.9, 0.04, inGlass * (1.0 - frame)), win);
      metal = mix(metal, 0.0, win);
      tsN = normalize(mix(tsN, vec3(0.0, 0.0, 1.0), win));
      // днём: комната в рассеянном свете с улицы (uNfrAmb — небо), шторы просвечивают
      vec3 dayIn = mix(inside * roomLit, cc * 0.55, curA) * uNfrAmb * 0.5;
      bInteriorRad = dayIn * glassK;
      // ночь: горят окна (доля uNfrWin), тёплый/холодный свет, витрины ярче
      float on = step(1.0 - uNfrWin, bHash(wid + 5.3));
      float wc = bHash(wid + 3.1), wb = 0.55 + 0.9 * bHash(wid + 7.7);
      vec3 lc = wc < 0.62 ? vec3(1.0, 0.72, 0.38) : wc < 0.86 ? vec3(1.0, 0.86, 0.6) : vec3(0.62, 0.78, 1.0);
      if (shop) { on = step(0.25, hw2); lc = vec3(1.0, 0.9, 0.75) * 1.1; }
      #ifdef NFR_INTERIORS
        vec3 nightIn = mix(inside * (0.35 + 0.9 * roomLit), cc * 0.8, curA) * 1.6;
      #else
        float grad = 0.7 + 0.45 * smoothstep(0.0, wh, gl.y);
        vec3 nightIn = vec3(grad) * (cur > 0.5 && !shop ? 0.7 : 1.0);
      #endif
      nfrEmissive = lc * nightIn * wb * on * glassK * 0.55;
    }
    // фронтон: слуховое окошко
    if (PART > 6.5 && PART < 7.5 && !legacy) {
      float aw = bBox(vec2(P.x - L * 0.5, P.y - (levels * FH + 0.9)), vec2(0.35, 0.4));
      c = mix(c, vec3(0.03), aw);
    }
  }
  diffuseColor.rgb = c;
  bRough = clamp(rough, 0.03, 1.0); bMetal = metal; bAO = mix(1.0, aoT, 0.85);
  bNW = normalize(TBN * nfrScaleN(tsN, nK));
}
`;

export function createBuildingMaterial(u: BuildingUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, vertexColors: true });
  const interiors = quality.interiors;
  m.customProgramCacheKey = () => 'nfr-building-v3' + (interiors ? ':int' : '');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNfrNight = u.uNfrNight;
    sh.uniforms.uNfrWin = u.uNfrWin;
    sh.uniforms.uNfrAmb = u.uNfrAmb;
    Object.assign(sh.uniforms, texUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aArch; attribute vec2 aWall;\nvarying vec4 vBArch; varying vec2 vBWall; varying vec3 vBPos; varying vec3 vBN; varying vec2 vBUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBArch = aArch; vBWall = aWall; vBPos = position; vBN = normal; vBUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + (interiors ? '#define NFR_INTERIORS\n' : '') + TEX_GLSL + GLSL_COMMON + GLSL_PARAMS + GLSL_INTERIOR)
      .replace('#include <color_fragment>', '#include <color_fragment>\nvec3 nfrEmissive = vec3(0.0), bInteriorRad = vec3(0.0), bNW = normalize(vBN); float bRough = 0.88, bMetal = 0.0, bAO = 1.0;\n' + GLSL_MAIN)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = bRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = bMetal;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(mat3(viewMatrix) * bNW);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += nfrEmissive * uNfrNight + bInteriorRad;')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse *= bAO;');
  };
  return m;
}
