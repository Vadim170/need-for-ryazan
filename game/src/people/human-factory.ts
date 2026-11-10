import * as THREE from 'three';

/**
 * Процедурный низкополигональный человек (~350 треугольников) + шейдерная анимация (инстансинг).
 *
 * Модель: ноги в начале координат, рост 1.75 м, вперёд = −Z (как у пропсов). Каждая вершина знает свою часть тела
 * (`aPart`) и «слот» цвета (`aSlot`): куртка/штаны/кожа/волосы-шапка/обувь/сумка. Позу считает вершинный шейдер из
 * атрибутов инстанса (см. INSTANCE_ATTRS): фаза и амплитуда шага, номер позы, силуэт (длина пальто, полнота,
 * размер головы, сутулость), цвета. Так одна геометрия даёт мужчин/женщин/детей/пожилых и все позы за 1 draw call.
 *
 * Фабрика заменяемая: всё, что знает остальной код, — интерфейс HumanFactory (геометрия + материалы + атрибуты).
 * Для glTF/Mixamo позже — другая реализация PeopleView (people-view.ts), агентам всё равно.
 */
export interface HumanFactory {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  depthMaterial: THREE.Material;
  uniforms: { uTime: { value: number } };
}

/** Атрибуты инстанса (имя → размерность). */
export const INSTANCE_ATTRS = {
  iJacket: 3, // цвет верха
  iPants: 3, // цвет низа
  iHead: 4, // цвет волос/шапки, тип сумки (0 нет, 1 сумка, 2 пакет)
  iShape: 4, // длина пальто 0..1, полнота 0.85..1.25, масштаб головы, сутулость (рад)
  iAnim: 4, // фаза шага (рад), амплитуда шага 0..1.4, поза, параметр позы
} as const;

/** Позы (iAnim.z). */
export const enum Pose { Walk = 0, Sit = 1, Dodge = 2, Fallen = 3, Angry = 4, Talk = 5, Phone = 6 }

// части тела
const TORSO = 0, HEAD = 1, THIGH_L = 2, THIGH_R = 3, SHIN_L = 4, SHIN_R = 5, UARM_L = 6, UARM_R = 7, FARM_L = 8, FARM_R = 9,
  COAT = 10, BAG = 11;
// слоты цвета
const S_JACKET = 0, S_PANTS = 1, S_SKIN = 2, S_HAIR = 3, S_SHOES = 4, S_BAG = 5;

class Builder {
  pos: number[] = []; nrm: number[] = []; part: number[] = []; slot: number[] = []; coat: number[] = [];
  private tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, p: number, s: number, ca = 0, cb = 0, cc = 0, n?: THREE.Vector3[]) {
    const fn = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    for (const [v, k, cf] of [[a, 0, ca], [b, 1, cb], [c, 2, cc]] as [THREE.Vector3, number, number][]) {
      this.pos.push(v.x, v.y, v.z);
      const nn = n ? n[k] : fn;
      this.nrm.push(nn.x, nn.y, nn.z);
      this.part.push(p); this.slot.push(s); this.coat.push(cf);
    }
  }
  /** Призма/цилиндр по оси Y: n сторон, радиусы (rx, rz) внизу и вверху, со смещением центра. */
  prism(cx: number, cz: number, y0: number, y1: number, rx0: number, rz0: number, rx1: number, rz1: number, n: number, p: number, s: number,
    caps = true, phase = Math.PI / n, coatBottom = false) {
    const ring = (y: number, rx: number, rz: number) => Array.from({ length: n }, (_, i) => {
      const a = phase + (i / n) * Math.PI * 2;
      return new THREE.Vector3(cx + Math.cos(a) * rx, y, cz + Math.sin(a) * rz);
    });
    const B = ring(y0, rx0, rz0), T = ring(y1, rx1, rz1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = (i + 0.5) / n * Math.PI * 2 + phase;
      const sn = new THREE.Vector3(Math.cos(a) / Math.max(rx0, 0.01), 0, Math.sin(a) / Math.max(rz0, 0.01)).normalize();
      const N = [sn, sn, sn];
      const cb = coatBottom ? 1 : 0;
      this.tri(B[i], T[j], B[j], p, s, cb, 0, cb, N);
      this.tri(B[i], T[i], T[j], p, s, cb, 0, 0, N);
    }
    if (caps) {
      const ct = new THREE.Vector3(cx, y1, cz), cbv = new THREE.Vector3(cx, y0, cz);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        this.tri(ct, T[j], T[i], p, s);
        this.tri(cbv, B[i], B[j], p, s);
      }
    }
  }
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, p: number, s: number, topScale = 1) {
    this.prism(cx, cz, cy - sy / 2, cy + sy / 2, sx / Math.SQRT2, sz / Math.SQRT2, sx / Math.SQRT2 * topScale, sz / Math.SQRT2, 4, p, s, true, Math.PI / 4);
  }
  /** Низкая сфера (широта × долгота), опционально только верхняя часть (шапка/волосы). */
  sphere(cx: number, cy: number, cz: number, r: number, lat: number, lon: number, p: number, s: number, fromLat = 0, sy = 1, sz = 1) {
    const v = (i: number, j: number) => {
      const th = (i / lat) * Math.PI, ph = (j / lon) * Math.PI * 2;
      return new THREE.Vector3(cx + r * Math.sin(th) * Math.cos(ph), cy + r * sy * Math.cos(th), cz + r * sz * Math.sin(th) * Math.sin(ph));
    };
    const nv = (q: THREE.Vector3) => new THREE.Vector3(q.x - cx, (q.y - cy) / sy, (q.z - cz) / sz).normalize();
    for (let i = fromLat; i < lat; i++) for (let j = 0; j < lon; j++) {
      const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1);
      if (i > 0) this.tri(a, c, b, p, s, 0, 0, 0, [nv(a), nv(c), nv(b)]);
      if (i < lat - 1) this.tri(a, d, c, p, s, 0, 0, 0, [nv(a), nv(d), nv(c)]);
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    const ps = new Float32Array(this.part.length * 3);
    for (let i = 0; i < this.part.length; i++) { ps[3 * i] = this.part[i]; ps[3 * i + 1] = this.slot[i]; ps[3 * i + 2] = this.coat[i]; }
    g.setAttribute('aPSC', new THREE.BufferAttribute(ps, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Геометрия человека (~350 треугольников). */
export function buildHumanGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  for (const sx of [-1, 1]) {
    const L = sx < 0;
    // ботинки + голень (часть голени: крутится вокруг колена)
    b.box(sx * 0.1, 0.045, -0.035, 0.1, 0.09, 0.26, L ? SHIN_L : SHIN_R, S_SHOES);
    b.prism(sx * 0.1, 0, 0.08, 0.52, 0.055, 0.06, 0.068, 0.072, 5, L ? SHIN_L : SHIN_R, S_PANTS, false);
    // бедро
    b.prism(sx * 0.1, 0, 0.5, 0.95, 0.07, 0.075, 0.09, 0.095, 5, L ? THIGH_L : THIGH_R, S_PANTS, false);
    // плечо, предплечье, кисть
    b.prism(sx * 0.225, 0, 1.13, 1.43, 0.05, 0.055, 0.058, 0.062, 5, L ? UARM_L : UARM_R, S_JACKET, false);
    b.prism(sx * 0.225, 0, 0.87, 1.15, 0.042, 0.045, 0.05, 0.052, 5, L ? FARM_L : FARM_R, S_JACKET, false);
    b.box(sx * 0.225, 0.82, 0, 0.06, 0.1, 0.08, L ? FARM_L : FARM_R, S_SKIN);
  }
  // таз, торс (сужение к талии, шире в плечах), шея, голова, волосы/шапка
  b.box(0, 0.98, 0, 0.34, 0.16, 0.2, TORSO, S_PANTS);
  b.prism(0, 0, 1.02, 1.3, 0.2, 0.125, 0.24, 0.135, 6, TORSO, S_JACKET, false, Math.PI / 6);
  b.prism(0, 0, 1.3, 1.46, 0.24, 0.135, 0.17, 0.11, 6, TORSO, S_JACKET, true, Math.PI / 6);
  b.prism(0, 0, 1.45, 1.53, 0.05, 0.05, 0.05, 0.05, 5, HEAD, S_SKIN, false);
  b.sphere(0, 1.635, -0.005, 0.105, 5, 7, HEAD, S_SKIN, 0, 1.15, 1.05);
  b.sphere(0, 1.655, 0.008, 0.115, 5, 7, HEAD, S_HAIR, 0, 0.95, 1.05); // верх (шапка/волосы), нижняя часть уходит в голову
  // подол пальто/куртки: нижнее кольцо двигается в шейдере (длина пальто)
  b.prism(0, 0, 0.6, 1.04, 0.2, 0.14, 0.19, 0.125, 7, COAT, S_JACKET, false, Math.PI / 7, true);
  // сумка через плечо (у левого бедра)
  b.box(-0.27, 0.95, 0.02, 0.07, 0.24, 0.3, BAG, S_BAG);
  b.prism(-0.1, 0, 1.15, 1.47, 0.02, 0.02, 0.02, 0.02, 3, BAG, S_BAG, false); // ремень
  return b.build();
}

const POSE_GLSL = /* glsl */ `
attribute vec3 aPSC;
attribute vec3 iJacket;
attribute vec3 iPants;
attribute vec4 iHead;
attribute vec4 iShape;
attribute vec4 iAnim;
uniform float uTime;
varying vec3 vNfrCol;

void nfrRotX(inout vec3 p, inout vec3 n, vec3 c, float a) {
  float s = sin(a), co = cos(a);
  p -= c;
  p = vec3(p.x, p.y * co - p.z * s, p.y * s + p.z * co) + c;
  n = vec3(n.x, n.y * co - n.z * s, n.y * s + n.z * co);
}
void nfrRotZ(inout vec3 p, inout vec3 n, vec3 c, float a) {
  float s = sin(a), co = cos(a);
  p -= c;
  p = vec3(p.x * co - p.y * s, p.x * s + p.y * co, p.z) + c;
  n = vec3(n.x * co - n.y * s, n.x * s + n.y * co, n.z);
}

void nfrPose(inout vec3 p, inout vec3 n) {
  float part = aPSC.x;
  float ph = iAnim.x, amp = iAnim.y, pose = iAnim.z, pp = iAnim.w;
  float coatLen = iShape.x, girth = iShape.y, headS = iShape.z, stoop = iShape.w;
  bool isL = part == 2.0 || part == 4.0 || part == 6.0 || part == 8.0;
  float side = isL ? 1.0 : -1.0;
  float idle = sin(uTime * 1.7 + ph * 3.1);
  // --- углы суставов: ходьба
  float sw = sin(ph) * side;                           // фаза ноги (левая/правая в противофазе)
  float hip = sw * 0.42 * amp;
  float knee = -max(0.0, sin(ph * side + (isL ? -1.3 : 1.3 + 3.14159))) * 0.85 * amp - 0.04;
  knee = -max(0.0, sin(ph + (isL ? -1.3 : 1.84))) * 0.85 * amp - 0.04;
  float sh = -sw * 0.33 * amp + 0.02 * idle;
  float elb = 0.18 + 0.25 * amp + (amp > 1.05 ? 0.9 : 0.0);
  float shZ = 0.0;
  float torsoTilt = stoop + 0.05 * amp;
  if (pose > 0.5 && pose < 1.5) {          // сидит
    hip = 1.45; knee = -1.4; sh = 0.35; elb = 0.95; torsoTilt = stoop * 0.5 - 0.05;
  } else if (pose > 1.5 && pose < 2.5) {   // отпрыгивает: руки вверх, ноги врозь
    hip = isL ? 0.7 : -0.35; knee = -0.7; sh = -2.5 + 0.2 * sin(uTime * 25.0); elb = 0.4; shZ = 0.35; torsoTilt = -0.15;
  } else if (pose > 2.5 && pose < 3.5) {   // лежит/кувыркается: руки-ноги в стороны
    hip = isL ? 0.35 : -0.15; knee = -0.5; sh = -0.6; elb = 0.5; shZ = 1.25 + 0.15 * sin(uTime * 9.0 + pp); torsoTilt = 0.0;
  } else if (pose > 3.5 && pose < 4.5) {   // сердится: правой рукой грозит кулаком
    if (!isL && (part == 7.0 || part == 9.0)) { sh = -2.7 + 0.28 * sin(uTime * 17.0); elb = 0.7; shZ = 0.0; }
  } else if (pose > 4.5 && pose < 5.5) {   // разговаривает: жесты
    sh = 0.25 + 0.22 * sin(uTime * 2.3 + ph + side); elb = 1.0 + 0.35 * sin(uTime * 3.1 + ph * 2.0 + side);
  } else if (pose > 5.5) {                 // телефон у уха (правая рука)
    if (!isL && (part == 7.0 || part == 9.0)) { sh = -0.35; elb = 2.3; shZ = -0.1; }
  }
  // --- пальто: нижнее кольцо по длине пальто, расклёшивается при шаге
  if (part == 10.0) {
    if (aPSC.z > 0.5) {
      float yb = mix(1.03, 0.42, coatLen);
      float fl = 1.0 + 0.25 * coatLen + 0.12 * amp * coatLen;
      p.x *= fl; p.z = p.z * fl;
      p.y = yb;
      if (pose > 0.5 && pose < 1.5) { p.z -= coatLen * 0.35; p.y = mix(p.y, 0.95, 0.6); } // сидя подол на коленях
    }
    if (coatLen < 0.04) p = vec3(0.0, 1.0, 0.0);
  }
  // --- полнота и голова
  if (part == 0.0 || part == 10.0 || part == 11.0) { p.x *= girth; p.z *= mix(1.0, girth, 0.8); }
  if (part == 11.0 && iHead.w < 0.5) p = vec3(0.0, 1.0, 0.0);
  if (part == 1.0) p = (p - vec3(0.0, 1.5, 0.0)) * headS + vec3(0.0, 1.5, 0.0);
  float shx = 0.225 * mix(1.0, girth, 0.6);
  if (part >= 6.0 && part <= 9.0) p.x += sign(p.x) * (shx - 0.225);
  // --- конечности
  if (part >= 2.0 && part <= 5.0) {
    float hx = isL ? -0.1 : 0.1;
    if (part >= 4.0) nfrRotX(p, n, vec3(hx, 0.51, 0.0), knee);
    nfrRotX(p, n, vec3(hx, 0.95, 0.0), hip);
  } else if (part >= 6.0 && part <= 9.0) {
    float sx = isL ? -shx : shx;
    if (part >= 8.0) nfrRotX(p, n, vec3(sx, 1.14, 0.0), elb);
    nfrRotX(p, n, vec3(sx, 1.42, 0.0), sh);
    if (shZ != 0.0) nfrRotZ(p, n, vec3(sx, 1.42, 0.0), shZ * (isL ? -1.0 : 1.0));
  }
  // --- корпус (всё выше пояса) наклоняется: сутулость пожилых, наклон при ходьбе
  bool upper = part == 1.0 || (part >= 6.0 && part <= 9.0) || part == 11.0 || (part == 0.0 && p.y > 1.04);
  if (upper) nfrRotX(p, n, vec3(0.0, 1.02, 0.0), torsoTilt * -1.0);
  // вертикальное покачивание при ходьбе
  p.y += abs(cos(ph)) * 0.025 * amp;
  // --- цвет
  float slot = aPSC.y;
  vec3 skin = mix(vec3(0.78, 0.58, 0.47), vec3(0.93, 0.76, 0.65), fract(girth * 37.0));
  vec3 c = slot < 0.5 ? iJacket : slot < 1.5 ? iPants : slot < 2.5 ? skin : slot < 3.5 ? iHead.rgb : slot < 4.5 ? vec3(0.06, 0.055, 0.05) :
    (iHead.w > 1.5 ? vec3(0.85, 0.85, 0.82) : vec3(0.16, 0.1, 0.07));
  vNfrCol = c;
}
`;

export function createHumanFactory(): HumanFactory {
  const uniforms = { uTime: { value: 0 } };
  const geometry = buildHumanGeometry();
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0 });
  material.customProgramCacheKey = () => 'nfr-human';
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + POSE_GLSL)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(normal);\nvec3 nfrP = vec3(position);\nnfrPose(nfrP, objectNormal);')
      .replace('#include <begin_vertex>', 'vec3 transformed = nfrP;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNfrCol;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vNfrCol;');
  };
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.customProgramCacheKey = () => 'nfr-human-depth';
  depthMaterial.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + POSE_GLSL)
      .replace('#include <begin_vertex>', 'vec3 nfrN = vec3(0.0, 1.0, 0.0);\nvec3 transformed = vec3(position);\nnfrPose(transformed, nfrN);');
  };
  return { geometry, material, depthMaterial, uniforms };
}

// ---------------------------------------------------------------- внешность
export const enum Body { Man = 0, Woman = 1, Kid = 2, Elder = 3 }

export interface Look {
  body: Body;
  scale: number; // общий масштаб (рост / 1.75)
  jacket: THREE.Color; pants: THREE.Color; head: THREE.Color;
  bag: number; coat: number; girth: number; headScale: number; stoop: number;
  /** Скорость ходьбы, м/с. */
  speed: number;
}

const hex = (h: number) => new THREE.Color(h);
// осенняя Рязань: тёмные куртки и пальто, немного ярких пятен
const JACKETS_M = [0x1d222b, 0x24282c, 0x2f3a2c, 0x3a3128, 0x1b2638, 0x44464a, 0x5a4a36, 0x272727, 0x3c2a22, 0x4b5560, 0x6b5b3a, 0x2c3d4f];
const JACKETS_F = [0x2a2430, 0x5b1f2a, 0x8a7a62, 0x1f2a3a, 0x6c4a3a, 0x3b3f46, 0x9c8b70, 0x7a2e2e, 0x23262b, 0x4d3c5c, 0xa86b3c, 0x355a5a, 0xb8a990];
const JACKETS_KID = [0xc23b2b, 0x2d6cc0, 0xe0a42a, 0x3a9a5a, 0xd85a8a, 0x5a3ab0, 0x1f7f8f, 0xe06a20];
const PANTS = [0x1f2a44, 0x2a3550, 0x18191c, 0x2b2b2e, 0x3a3a3d, 0x3b3026, 0x23314d, 0x4a4a4a];
const HAIR = [0x2a1d14, 0x3b2a1e, 0x16110e, 0x6a4a2e, 0x9a7a4e, 0x4a3a2c];
const HATS = [0x1b1b1d, 0x3a3a3c, 0x7a1f22, 0x2b3a55, 0x5a5a5a, 0x6b4a2a, 0xa0a0a0, 0x1f3a2a];
const ELDER_HAIR = [0x9a9a96, 0xb8b6b0, 0x7a7874];

export function randomLook(rnd: () => number, body?: Body): Look {
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length) % a.length];
  const r = rnd();
  const b: Body = body ?? (r < 0.41 ? Body.Man : r < 0.83 ? Body.Woman : r < 0.9 ? Body.Kid : Body.Elder);
  const elderF = b === Body.Elder && rnd() < 0.6;
  const hat = rnd() < (b === Body.Kid ? 0.7 : b === Body.Elder ? 0.75 : 0.35);
  const L: Look = {
    body: b,
    scale: b === Body.Man ? 0.98 + rnd() * 0.1 : b === Body.Woman ? 0.92 + rnd() * 0.08 : b === Body.Kid ? 0.55 + rnd() * 0.17 : 0.9 + rnd() * 0.08,
    jacket: hex(b === Body.Kid ? pick(JACKETS_KID) : b === Body.Woman || elderF ? pick(JACKETS_F) : pick(JACKETS_M)),
    pants: hex(pick(PANTS)),
    head: hex(hat ? pick(HATS) : b === Body.Elder ? pick(ELDER_HAIR) : pick(HAIR)),
    bag: b === Body.Kid ? 0 : rnd() < (b === Body.Woman ? 0.55 : 0.18) ? 1 : rnd() < 0.12 ? 2 : 0,
    coat: b === Body.Woman || elderF ? 0.35 + rnd() * 0.65 : b === Body.Kid ? rnd() * 0.15 : rnd() < 0.35 ? 0.4 + rnd() * 0.5 : 0.05 + rnd() * 0.12,
    girth: b === Body.Woman ? 0.86 + rnd() * 0.18 : b === Body.Kid ? 0.92 : 0.95 + rnd() * 0.3,
    headScale: b === Body.Kid ? 1.25 : 1.0,
    stoop: b === Body.Elder ? 0.18 + rnd() * 0.15 : rnd() * 0.04,
    speed: b === Body.Kid ? 1.25 + rnd() * 0.35 : b === Body.Elder ? 0.8 + rnd() * 0.25 : 1.15 + rnd() * 0.35,
  };
  // тусклее и разнообразнее: лёгкий разброс яркости
  const k = 0.85 + rnd() * 0.3;
  L.jacket.multiplyScalar(k);
  if (b === Body.Woman && rnd() < 0.3) L.pants.copy(L.jacket).multiplyScalar(0.6); // тёмные колготки/юбка в тон
  return L;
}
