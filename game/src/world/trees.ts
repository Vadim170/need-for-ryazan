import * as THREE from 'three';
import { texUniforms, TEX_GLSL } from '../render/textures';
import { weatherUniforms } from '../render/weather';
import { quality } from '../render/quality';

/**
 * Деревья v2 (docs/stage3/realism.md).
 *
 * Модель: ствол и скелет ветвей (трубки 3–7 граней: ствол → главные ветви → вторичные, концы ветвей направлены
 * к точкам поверхности эллипсоидов кроны — упрощённая «колонизация пространства»), на концах — карточки тонких
 * веточек (alpha), вокруг них — карточки листвы (атлас листвы рисуется на canvas). Нормали листвы «раздуты» от
 * центра кроны — крона освещается как объём.
 *
 * Сезоны (weatherUniforms.season: 0 лето … 0.5 осень … 1 зима): листва желтеет/краснеет по карточкам (у клёна —
 * оранжево-красная, у берёзы/липы/тополя — жёлтая), опадает карточками (в вершинном шейдере карточка схлопывается
 * — дешевле discard; то же в материале теней), зимой остаются ветви и веточки; снег ложится на верх ветвей
 * (погода, render/weather.ts: вид 'vegetation', ветка «не крона» — снег по нормали). Хвоя сосны вечнозелёная.
 * Крупный изгиб ствола от ветра — погода (SWAY); здесь — дрожание листвы и веточек.
 *
 * Дальше quality.treeNear — импостеры: три скрещённые плоскости; атлас (canvas) в двух рядах: с листвой и голые
 * ветви (тот же скелет); переход по сезону — растворением по дереву.
 *
 * Клён ясенелистный (Acer negundo, `tree_negundo`) и клумпа зарослей (`thicket`, docs/stage3/landcover.md):
 * многоствольные — несколько кривых наклонных стволиков от земли (зеленовато-серая молодая кора), повислые боковые
 * ветви, сложные перистые светло-зелёные листья (ячейка атласа 6); осенью жёлтые, зимой — голые спутанные прутья.
 * Клумпа — 11 стволиков в круге ~2 м (масштаб по XZ — радиус, по Y — высота), импостер вдали — широкий.
 *
 * Атрибуты: position, normal, color, aFlag (0 кора, 2 веточки, 3 листва), aRnd (случайное на карточку), uv (атлас),
 * aBark (развёртка коры, м). vFlag в шейдере: 0/2/3 — погода считает их «не кроной» (без фальшивых прутьев).
 */

type Species = 'tree_birch' | 'tree_poplar' | 'tree_maple' | 'tree_lime' | 'tree_pine' | 'shrub' | 'tree_negundo' | 'thicket';
const ORDER: Species[] = ['tree_birch', 'tree_poplar', 'tree_maple', 'tree_lime', 'tree_pine', 'shrub', 'tree_negundo', 'thicket'];
/** Номинальный радиус клумпы `thicket` (м): инстанс масштабируется по XZ на radius / THICKET_R, по Y — на height / THICKET_H. */
export const THICKET_R = 2.2, THICKET_H = 5;

interface Spec {
  h: number; trunkTop: number; trunkR: number; barkTint: number;
  crowns: { c: [number, number, number]; r: [number, number, number] }[];
  /** главные ветви, вторичных на главную, листовых карточек на конец, размер карточки (м) */
  mains: number; subs: number; perTip: number; card: number;
  leafCell: number; twigCell: number; leaf: number; leaf2: number; autumn: [number, number];
  /** подъём главных ветвей (рад от горизонта) и провис концов (берёза) */
  rise: number; droop: number; pine?: boolean;
  /** многоствольные (клён ясенелистный, заросли): число стволиков от земли, разброс оснований (м), наклон наружу (рад) */
  stems?: number; spread?: number; lean?: number;
  /** полуширина импостера, м (по умолчанию 0.27 высоты) */
  farHW?: number;
}

const SPECS: Record<Species, Spec> = {
  // берёза ~15 м: белый ствол, повислые тонкие ветви, мелкий лист, жёлтая осенью
  tree_birch: { h: 15, trunkTop: 13.5, trunkR: 0.2, barkTint: 0xeae6dc, mains: 11, subs: 3, perTip: 2, card: 1.4, leafCell: 0, twigCell: 5, leaf: 0x7aa543, leaf2: 0x5c8a2e,
    autumn: [0xd8b020, 0xc89018], rise: 0.95, droop: 0.9, crowns: [{ c: [0, 10, 0], r: [2.8, 3.8, 2.8] }, { c: [0.5, 12.8, 0.2], r: [2.0, 2.2, 2.0] }] },
  // тополь ~20 м: колонна, крутые ветви
  tree_poplar: { h: 20, trunkTop: 17, trunkR: 0.36, barkTint: 0x9a948a, mains: 12, subs: 2, perTip: 2, card: 1.8, leafCell: 1, twigCell: 4, leaf: 0x4f7d30, leaf2: 0x3f6a26,
    autumn: [0xc8a828, 0x9a8a30], rise: 1.25, droop: 0, crowns: [{ c: [0, 12, 0], r: [2.6, 6.5, 2.6] }, { c: [0.2, 17, 0.2], r: [1.8, 3.0, 1.8] }] },
  // клён ~12 м: широкая круглая крона, крупный лист, оранжево-красный осенью
  tree_maple: { h: 12, trunkTop: 8.5, trunkR: 0.3, barkTint: 0x857565, mains: 10, subs: 3, perTip: 2, card: 2.0, leafCell: 2, twigCell: 4, leaf: 0x5e8f2f, leaf2: 0x4a7a25,
    autumn: [0xe07018, 0xc03010], rise: 0.6, droop: 0.15, crowns: [{ c: [0, 8.2, 0], r: [4.0, 3.4, 4.0] }, { c: [1.2, 9.6, 0.7], r: [2.6, 2.2, 2.6] }] },
  // липа ~15 м: овальная плотная крона, тёмная зелень, жёлтая осенью
  tree_lime: { h: 15, trunkTop: 11, trunkR: 0.32, barkTint: 0x7a6e62, mains: 11, subs: 3, perTip: 2, card: 1.9, leafCell: 1, twigCell: 4, leaf: 0x4b7b2b, leaf2: 0x3a6622,
    autumn: [0xc8a020, 0xb07818], rise: 0.75, droop: 0.1, crowns: [{ c: [0, 9.3, 0], r: [4.0, 4.6, 4.0] }, { c: [0.3, 12.4, -0.2], r: [2.6, 2.4, 2.6] }] },
  // сосна ~18 м: прямой ствол, мутовки горизонтальных ветвей с хвоей
  tree_pine: { h: 18, trunkTop: 17.5, trunkR: 0.3, barkTint: 0x8a6852, mains: 0, subs: 0, perTip: 6, card: 2.0, leafCell: 3, twigCell: 4, leaf: 0x3a5a2a, leaf2: 0x2c4a22,
    autumn: [0x3a5a2a, 0x2c4a22], rise: 0, droop: 0.2, pine: true,
    crowns: [{ c: [0, 11, 0], r: [3.0, 1.4, 3.0] }, { c: [0, 13.6, 0], r: [2.4, 1.3, 2.4] }, { c: [0, 15.8, 0], r: [1.6, 1.3, 1.6] }, { c: [0, 8.8, 0], r: [2.8, 1.1, 2.8] }] },
  // куст ~2 м: несколько стволиков от земли
  shrub: { h: 2, trunkTop: 0.3, trunkR: 0.04, barkTint: 0x5a4a3a, mains: 5, subs: 1, perTip: 3, card: 0.8, leafCell: 1, twigCell: 4, leaf: 0x557f2c, leaf2: 0x416a22,
    autumn: [0xb08820, 0xa04018], rise: 1.0, droop: 0, crowns: [{ c: [0, 1.0, 0], r: [1.1, 0.9, 1.1] }] },
  // клён ясенелистный ~7 м: 3–5 кривых наклонных стволиков, повислые ветви, светлая перистая листва
  tree_negundo: { h: 7, trunkTop: 6.2, trunkR: 0.11, barkTint: 0x8c9878, mains: 0, subs: 2, perTip: 3, card: 1.35, leafCell: 6, twigCell: 5, leaf: 0x93bb52, leaf2: 0x76a03e,
    autumn: [0xe0c838, 0xc8a828], rise: 0.3, droop: 0.8, stems: 4, spread: 0.45, lean: 0.38, crowns: [{ c: [0, 4.6, 0], r: [2.6, 2.1, 2.6] }] },
  // клумпа зарослей ~5 м, Ø ~4.4 м: 11 стволиков, сплошная масса листвы до земли
  thicket: { h: THICKET_H, trunkTop: 4.6, trunkR: 0.06, barkTint: 0x8a9676, mains: 0, subs: 3, perTip: 3, card: 1.25, leafCell: 6, twigCell: 5, leaf: 0x8db54e, leaf2: 0x6e983a,
    autumn: [0xe0c838, 0xc8a828], rise: 0.3, droop: 0.9, stems: 12, spread: THICKET_R * 0.7, lean: 0.3, farHW: THICKET_R * 1.25,
    crowns: [{ c: [0, 3.0, 0], r: [THICKET_R, 1.9, THICKET_R] }] },
};

const rng = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// ------------------------------------------------------------------ скелет

interface Limb { a: THREE.Vector3; b: THREE.Vector3; ra: number; rb: number; lvl: number }
interface Tip { p: THREE.Vector3; d: THREE.Vector3; c: THREE.Vector3 }
interface Skeleton { limbs: Limb[]; tips: Tip[] }

/** Точка на поверхности эллипсоида кроны (0.7–1 радиуса), не ниже его центра − 0.6 r (крона «сидит» на ветвях). */
function crownPoint(s: Spec, rnd: () => number, ci?: number): { p: THREE.Vector3; c: THREE.Vector3 } {
  const cr = s.crowns[ci ?? Math.floor(rnd() * s.crowns.length)];
  let x = 0, y = 0, z = 0;
  do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; } while (x * x + y * y + z * z > 1 || y < -0.6);
  const l = Math.hypot(x, y, z) || 1, k = (0.7 + 0.3 * rnd()) / l;
  const c = new THREE.Vector3(...cr.c);
  return { p: new THREE.Vector3(c.x + x * k * cr.r[0], c.y + y * k * cr.r[1], c.z + z * k * cr.r[2]), c };
}

function skeleton(k: Species, seed: number): Skeleton {
  const s = SPECS[k], rnd = rng(seed), V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const limbs: Limb[] = [], tips: Tip[] = [];
  // ствол: 3–4 сегмента с лёгким изгибом
  const trunk: THREE.Vector3[] = [V(0, -0.2, 0)];
  const segs = s.pine ? 4 : 3;
  for (let i = 1; i <= segs; i++) trunk.push(V((rnd() - 0.5) * 0.18 * i, s.trunkTop * i / segs, (rnd() - 0.5) * 0.18 * i));
  for (let i = 0; i < segs; i++) limbs.push({ a: trunk[i], b: trunk[i + 1], ra: s.trunkR * (1 - 0.8 * i / segs), rb: s.trunkR * (1 - 0.8 * (i + 1) / segs), lvl: 0 });
  const trunkAt = (y: number) => {
    const t = Math.min(Math.max(y / s.trunkTop, 0), 1) * segs, i = Math.min(Math.floor(t), segs - 1);
    return trunk[i].clone().lerp(trunk[i + 1], t - i);
  };
  if (s.stems) return multiStem(s, rnd);
  if (s.pine) {
    // мутовки: 7 ярусов по 4–5 горизонтальных ветвей, хвоя — на концах и вдоль
    for (let w = 0; w < 7; w++) {
      const y = s.trunkTop * (0.55 + 0.42 * w / 6), n = 4 + (w % 2), R = (2.9 - 2.2 * w / 6) * (0.9 + 0.2 * rnd());
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2 + w * 0.7 + rnd() * 0.4;
        const o = trunkAt(y), d = V(Math.cos(a), -0.12 - 0.1 * rnd(), Math.sin(a)).normalize();
        const e = o.clone().addScaledVector(d, R);
        limbs.push({ a: o, b: e, ra: 0.06, rb: 0.02, lvl: 1 });
        tips.push({ p: e, d, c: V(0, y, 0) });
        tips.push({ p: o.clone().lerp(e, 0.55), d, c: V(0, y, 0) });
      }
    }
    return { limbs, tips };
  }
  const base = s.crowns.reduce((m, c) => Math.min(m, c.c[1] - c.r[1] * 0.7), 1e9);
  for (let i = 0; i < s.mains; i++) {
    const tgt = crownPoint(s, rnd);
    const y0 = k === 'shrub' ? 0.05 : Math.max(base * (0.85 + 0.15 * rnd()), Math.min(tgt.p.y - 1.5, s.trunkTop * (0.55 + 0.4 * rnd())));
    const o = trunkAt(y0);
    // середина ветви: подъём по виду, конец к точке кроны (с провисом у берёзы)
    const dir = tgt.p.clone().sub(o);
    const mid = o.clone().addScaledVector(dir, 0.5); mid.y += dir.length() * 0.18 * s.rise;
    const end = tgt.p.clone(); end.y -= s.droop * 0.6;
    const r0 = Math.max(s.trunkR * 0.38, 0.02);
    limbs.push({ a: o, b: mid, ra: r0, rb: r0 * 0.6, lvl: 1 }, { a: mid, b: end, ra: r0 * 0.6, rb: r0 * 0.2, lvl: 1 });
    tips.push({ p: end, d: end.clone().sub(mid).normalize(), c: tgt.c });
    for (let j = 0; j < s.subs; j++) {
      const from = mid.clone().lerp(end, rnd() * 0.7);
      const t2 = tgt.p.clone().add(V((rnd() - 0.5) * 3, (rnd() - 0.3) * 2, (rnd() - 0.5) * 3));
      const sc = tgt.c, cr = s.crowns[0];
      // не вылезать из кроны слишком далеко
      t2.sub(sc).multiplyScalar(Math.min(1, (cr.r[0] + 0.5) / Math.max(t2.distanceTo(sc), 1e-3))).add(sc);
      t2.y -= s.droop * 0.8;
      limbs.push({ a: from, b: t2, ra: r0 * 0.3, rb: 0.015, lvl: 2 });
      tips.push({ p: t2, d: t2.clone().sub(from).normalize(), c: sc });
    }
  }
  return { limbs, tips };
}

/** Многоствольный куст-дерево (клён ясенелистный): кривые стволики от земли с наклоном наружу, повислые боковые ветви. */
function multiStem(s: Spec, rnd: () => number): Skeleton {
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const limbs: Limb[] = [], tips: Tip[] = [];
  const cen = V(...s.crowns[0].c);
  for (let i = 0; i < (s.stems ?? 1); i++) {
    const a = rnd() * Math.PI * 2, rr = (s.spread ?? 0) * Math.sqrt(rnd());
    let p = V(Math.cos(a) * rr, -0.15, Math.sin(a) * rr);
    const la = (rr > 0.15 ? a : rnd() * Math.PI * 2) + (rnd() - 0.5) * 0.8, lean = (s.lean ?? 0.3) * (0.4 + 0.9 * rnd());
    let dir = V(Math.sin(lean) * Math.cos(la), Math.cos(lean), Math.sin(lean) * Math.sin(la));
    const H = s.trunkTop * (0.72 + 0.28 * rnd()), segs = 4, r0 = s.trunkR * (0.6 + 0.7 * rnd());
    for (let j = 0; j < segs; j++) {
      // кривизна: направление сегмента «гуляет»
      dir = dir.clone().add(V((rnd() - 0.5) * 0.55, 0, (rnd() - 0.5) * 0.55)).normalize();
      if (dir.y < 0.4) { dir.y = 0.4; dir.normalize(); }
      const q = p.clone().addScaledVector(dir, H / segs);
      limbs.push({ a: p, b: q, ra: r0 * (1 - 0.7 * j / segs), rb: r0 * (1 - 0.7 * (j + 1) / segs), lvl: 1 });
      if (j >= 1) for (let b = 0; b < s.subs; b++) {
        const ba = rnd() * Math.PI * 2, bl = H * (0.12 + 0.14 * rnd());
        const o = p.clone().lerp(q, rnd());
        const e = o.clone().add(V(Math.cos(ba) * bl, bl * (0.25 - s.droop * 0.5 * rnd()), Math.sin(ba) * bl));
        // не уходить ниже 0.5 м и за пределы кроны (эллипсоид, +15 %)
        e.y = Math.max(e.y, 0.5);
        const cr = s.crowns[0], ex = (e.x - cen.x) / (cr.r[0] * 1.15), ez = (e.z - cen.z) / (cr.r[2] * 1.15);
        const ed = Math.hypot(ex, ez); if (ed > 1) { e.x = cen.x + (e.x - cen.x) / ed; e.z = cen.z + (e.z - cen.z) / ed; }
        const mid = o.clone().lerp(e, 0.5); mid.y += bl * 0.22;
        limbs.push({ a: o, b: mid, ra: r0 * 0.35, rb: r0 * 0.22, lvl: 2 }, { a: mid, b: e, ra: r0 * 0.22, rb: 0.012, lvl: 2 });
        tips.push({ p: e, d: e.clone().sub(mid).normalize(), c: cen });
      }
      p = q;
    }
    tips.push({ p, d: dir.clone(), c: cen });
  }
  return { limbs, tips };
}

// ------------------------------------------------------------------ атласы (canvas)

/** Атлас 4×2 (2048×1024): 0 берёза, 1 обычный лист, 2 клён, 3 хвоя, 4 веточки, 5 повислые веточки берёзы,
 *  6 — сложные перистые листья клёна ясенелистного, 7 — непрозрачный. */
function leafAtlas(): THREE.Texture {
  const C = 512, S = C * 4;
  const cv = document.createElement('canvas'); cv.width = S; cv.height = C * 2;
  const g = cv.getContext('2d')!;
  const rnd = rng(7);
  const cell = (i: number, draw: (ox: number, oy: number) => void) => {
    const ox = (i % 4) * C, oy = Math.floor(i / 4) * C;
    g.save(); g.beginPath(); g.rect(ox, oy, C, C); g.clip(); draw(ox, oy); g.restore();
  };
  const twigs = (ox: number, oy: number, hang: boolean, n: number) => {
    // ветвящиеся прутья от центра нижнего края к краям ячейки
    const br = (x: number, y: number, a: number, len: number, w: number, d: number) => {
      if (d > 4 || len < 6) return;
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len + (hang ? len * 0.35 * d : 0);
      g.strokeStyle = `rgb(${52 + d * 6},${44 + d * 5},${38 + d * 4})`; g.lineWidth = w;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
      const m = 2 + Math.floor(rnd() * 2);
      for (let i = 0; i < m; i++) br(x2, y2, a + (rnd() - 0.5) * 1.3, len * (0.55 + 0.2 * rnd()), Math.max(1, w * 0.62), d + 1);
    };
    for (let i = 0; i < n; i++) br(ox + C / 2 + (rnd() - 0.5) * 40, oy + C * 0.98, -Math.PI / 2 + (rnd() - 0.5) * 1.2, C * 0.26, 7, 0);
  };
  const leaves = (ox: number, oy: number, n: number, len: number, wid: number, maple: boolean) => {
    twigs(ox, oy, false, 2);
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(rnd()) * C * 0.46, a = rnd() * 6.28;
      const x = ox + C / 2 + Math.cos(a) * r, y = oy + C / 2 + Math.sin(a) * r;
      const l = 0.55 + 0.45 * rnd();
      const G2 = Math.round(130 + 110 * l);
      g.fillStyle = `rgb(${Math.round(G2 * 0.8)},${G2},${Math.round(G2 * 0.62)})`;
      g.save(); g.translate(x, y); g.rotate(rnd() * 6.28);
      const s = len * (0.7 + 0.6 * rnd());
      g.beginPath();
      if (maple) { for (let k = 0; k < 10; k++) { const aa = k / 10 * 6.28, rr = s * (k % 2 ? 0.45 : 1); g.lineTo(Math.cos(aa) * rr, Math.sin(aa) * rr); } }
      else g.ellipse(0, 0, s, s * wid, 0, 0, 6.28);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.ellipse(-s * 0.2, -s * wid * 0.2, s * 0.5, s * wid * 0.4, 0, 0, 6.28); g.fill();
      g.restore();
    }
  };
  cell(0, (x, y) => leaves(x, y, 700, 11, 0.62, false));
  cell(1, (x, y) => leaves(x, y, 520, 15, 0.6, false));
  cell(2, (x, y) => leaves(x, y, 330, 22, 1, true));
  cell(3, (ox, oy) => {
    for (let b = 0; b < 7; b++) {
      const a = (b / 7) * 6.28 + rnd() * 0.4, len = C * (0.3 + 0.15 * rnd());
      const x0 = ox + C / 2, y0 = oy + C / 2;
      g.strokeStyle = 'rgb(80,60,40)'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + Math.cos(a) * len, y0 + Math.sin(a) * len); g.stroke();
      for (let k = 0; k < 120; k++) {
        const t = rnd(), px = x0 + Math.cos(a) * len * t, py = y0 + Math.sin(a) * len * t;
        const na = a + (rnd() - 0.5) * 2.2, nl = 10 + 14 * rnd(), L = Math.round(110 + 90 * rnd());
        g.strokeStyle = `rgb(${Math.round(L * 0.6)},${L},${Math.round(L * 0.55)})`; g.lineWidth = 2;
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl); g.stroke();
      }
    }
  });
  cell(4, (x, y) => twigs(x, y, false, 3));
  cell(5, (x, y) => twigs(x, y, true, 3));
  // клён ясенелистный: черешок с 3–5 листочками (сложный лист), светлая зелень, на повислых прутьях
  cell(6, (ox, oy) => {
    twigs(ox, oy, true, 2);
    for (let i = 0; i < 95; i++) {
      const r = Math.sqrt(rnd()) * C * 0.42, a = rnd() * 6.28;
      const x = ox + C / 2 + Math.cos(a) * r, y = oy + C / 2 + Math.sin(a) * r;
      const L = 34 + 26 * rnd(), l = 0.6 + 0.4 * rnd(), G2 = Math.round(150 + 100 * l);
      g.save(); g.translate(x, y); g.rotate(rnd() * 6.28);
      g.strokeStyle = `rgb(${Math.round(G2 * 0.72)},${Math.round(G2 * 0.86)},${Math.round(G2 * 0.5)})`; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(L, 0); g.stroke();
      g.fillStyle = `rgb(${Math.round(G2 * 0.8)},${G2},${Math.round(G2 * 0.56)})`;
      const nl = rnd() < 0.5 ? 3 : 5;
      for (let q = 0; q < nl; q++) {
        const last = q === nl - 1, side = last ? 0 : (q % 2 ? 1 : -1);
        const t = last ? 1 : (Math.floor(q / 2) + 1) / ((nl + 1) / 2);
        g.save(); g.translate(L * t, 0); g.rotate(side * 0.75);
        g.beginPath(); g.ellipse(last ? 9 : 0, side * 8, 10, 5, 0, 0, 6.28); g.fill();
        g.restore();
      }
      g.restore();
    }
  });
  cell(7, (x, y) => { g.fillStyle = '#fff'; g.fillRect(x, y, C, C); });
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
/** uv ячейки атласа 4×2 (flipY: v = 1 — верх канваса). */
const cellUV = (i: number, u: number, v: number): [number, number] => [((i % 4) + u) * 0.25, 1 - (Math.floor(i / 4) + 1 - v) * 0.5];

/** Атлас импостеров: ряд с листвой (верх) и голые ветви (низ); ячейка 256×512 на вид. */
function impostorAtlas(skels: Record<string, Skeleton>): THREE.Texture {
  const W = 256, H = 512;
  const cv = document.createElement('canvas'); cv.width = W * ORDER.length; cv.height = H * 2;
  const g = cv.getContext('2d')!;
  const rnd = rng(3);
  ORDER.forEach((k, i) => {
    const s = SPECS[k], sk = skels[k];
    const sc = H / (s.h * 1.08);
    // по X — своя шкала, если импостер шире (заросли): полуширина farHW ↦ W/2
    const scx = s.farHW ? (W / 2) / s.farHW : sc;
    for (const row of [0, 1]) {
      const ox = i * W + W / 2, base = H * (row + 1) - 2;
      const X = (x: number) => ox + x * scx, Y = (y: number) => base - y * sc;
      const bark = new THREE.Color(s.barkTint).convertLinearToSRGB();
      g.strokeStyle = k === 'tree_birch' ? '#d8d4ca' : `rgb(${bark.r * 200},${bark.g * 200},${bark.b * 200})`;
      g.lineCap = 'round';
      for (const l of sk.limbs) {
        g.lineWidth = Math.max(l.lvl === 0 ? 2 : 1, (l.ra + l.rb) * sc);
        g.beginPath(); g.moveTo(X(l.a.x), Y(l.a.y)); g.lineTo(X(l.b.x), Y(l.b.y)); g.stroke();
      }
      // тонкие веточки на концах
      g.strokeStyle = 'rgba(60,50,42,0.9)'; g.lineWidth = 1;
      for (const t of sk.tips) for (let j = 0; j < 5; j++) {
        const a = Math.atan2(-t.d.y, t.d.x) + (rnd() - 0.5) * 1.6, L = (0.4 + 0.6 * rnd()) * s.card * sc;
        g.beginPath(); g.moveTo(X(t.p.x), Y(t.p.y)); g.lineTo(X(t.p.x) + Math.cos(a) * L, Y(t.p.y) + Math.sin(a) * L); g.stroke();
      }
      if (row === 0 || s.pine) {
        const lc = new THREE.Color(s.leaf).convertLinearToSRGB();
        for (const cr of s.crowns) {
          const n = Math.round(260 * cr.r[0] * cr.r[1] / 12) + 40;
          for (let j = 0; j < n; j++) {
            const a = rnd() * 6.28, r = Math.sqrt(rnd());
            const x = cr.c[0] + Math.cos(a) * r * cr.r[0], y = cr.c[1] + Math.sin(a) * r * cr.r[1];
            const top = (Math.sin(a) * r + 1) * 0.5;
            const L = (0.45 + 0.55 * top * (0.7 + 0.3 * rnd())) * 1.05;
            g.fillStyle = `rgb(${Math.min(255, Math.round(255 * lc.r * L))},${Math.min(255, Math.round(255 * lc.g * L))},${Math.min(255, Math.round(255 * lc.b * L))})`;
            const rr = (0.25 + 0.35 * rnd()) * (s.card / 1.6);
            g.beginPath(); g.ellipse(X(x), Y(y), rr * scx, rr * sc, 0, 0, 6.28); g.fill();
          }
        }
      }
    }
  });
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------ геометрия

class TB {
  P: number[] = []; N: number[] = []; C: number[] = []; F: number[] = []; R: number[] = []; UV: number[] = []; BK: number[] = [];
  private c = new THREE.Color();
  vert(p: THREE.Vector3, n: THREE.Vector3, col: number | THREE.Color, flag: number, rnd: number, uv: [number, number], bu: number, bv: number) {
    this.P.push(p.x, p.y, p.z); this.N.push(n.x, n.y, n.z);
    const c = typeof col === 'number' ? this.c.set(col) : col; this.C.push(c.r, c.g, c.b);
    this.F.push(flag); this.R.push(rnd); this.UV.push(uv[0], uv[1]); this.BK.push(bu, bv);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aFlag', new THREE.Float32BufferAttribute(this.F, 1));
    g.setAttribute('aRnd', new THREE.Float32BufferAttribute(this.R, 1));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.UV, 2));
    g.setAttribute('aBark', new THREE.Float32BufferAttribute(this.BK, 2));
    g.computeBoundingSphere();
    return g;
  }
}

const OPAQUE = cellUV(7, 0.5, 0.5);

function tube(t: TB, l: Limb, seg: number, col: number) {
  const d = new THREE.Vector3().subVectors(l.b, l.a); const len = d.length(); d.normalize();
  const side = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(d, side).normalize(), w = new THREE.Vector3().crossVectors(d, u);
  const ring = (c: THREE.Vector3, r: number, i: number) => {
    const ang = (i / seg) * Math.PI * 2;
    const n = new THREE.Vector3().addScaledVector(u, Math.cos(ang)).addScaledVector(w, Math.sin(ang));
    return { p: c.clone().addScaledVector(n, r), n };
  };
  const circ = 2 * Math.PI * Math.max(l.ra, 0.05), v0 = l.a.y;
  for (let i = 0; i < seg; i++) {
    const a0 = ring(l.a, l.ra, i), a1 = ring(l.a, l.ra, i + 1), b0 = ring(l.b, l.rb, i), b1 = ring(l.b, l.rb, i + 1);
    const u0 = (i / seg) * circ, u1 = ((i + 1) / seg) * circ;
    const q: [typeof a0, number, number][] = [[a0, u0, v0], [b0, u0, v0 + len], [b1, u1, v0 + len], [a0, u0, v0], [b1, u1, v0 + len], [a1, u1, v0]];
    for (const [r, bu, bv] of q) t.vert(r.p, r.n, col, 0, 0, OPAQUE, bu, bv);
  }
}

const CORNERS = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];

/** Карточка: основание в p, «вверх» по up, «вбок» по side, размер size; uv — ячейка атласа. */
function card(t: TB, p: THREE.Vector3, up: THREE.Vector3, side: THREE.Vector3, size: number, cellI: number, nrm: THREE.Vector3, col: THREE.Color, flag: number, rnd: number, centered: boolean) {
  const vs = CORNERS.map(([x, y]) => p.clone().addScaledVector(side, x * size).addScaledVector(up, (y - (centered ? 0.5 : 0)) * size));
  const uvs = CORNERS.map(([x, y]) => cellUV(cellI, x + 0.5, y));
  for (const j of [0, 1, 2, 0, 2, 3]) t.vert(vs[j], nrm, col, flag, rnd, uvs[j], 0, 0);
}

function buildNear(k: Species, sk: Skeleton, seed: number): THREE.BufferGeometry {
  const s = SPECS[k], t = new TB(), rnd = rng(seed + 11);
  for (const l of sk.limbs) tube(t, l, l.lvl === 0 ? (k === 'shrub' ? 4 : 7) : l.lvl === 1 ? 4 : 3, s.barkTint);
  const c1 = new THREE.Color(s.leaf), c2 = new THREE.Color(s.leaf2), cc = new THREE.Color(), white = new THREE.Color(1, 1, 1);
  const tmp = new THREE.Vector3(), up = new THREE.Vector3(), side = new THREE.Vector3();
  // листва вдоль ветвей (заполняет крону изнутри; концы ветвей — ниже, гуще)
  const fill: Tip[] = [];
  if (!s.pine) for (const l of sk.limbs) {
    if (l.lvl === 0) continue;
    const len = l.a.distanceTo(l.b), n = Math.round(len / (s.card * 0.9));
    const d = l.b.clone().sub(l.a).normalize();
    const cen = sk.tips.length ? sk.tips[0].c : new THREE.Vector3(0, s.h * 0.6, 0);
    for (let j = 0; j < n; j++) fill.push({ p: l.a.clone().lerp(l.b, 0.35 + 0.65 * rnd()), d, c: cen.clone().setX(0).setZ(0) });
  }
  for (const tip of [...sk.tips, ...fill]) {
    const isFill = fill.includes(tip);
    // веточки: 1–2 карточки вдоль конца ветви (плоскость содержит направление ветви)
    if (!s.pine && !isFill) {
      for (let j = 0; j < 2; j++) {
        up.copy(tip.d).add(tmp.set((rnd() - 0.5) * 0.6, s.droop > 0.5 ? -0.6 : 0.1, (rnd() - 0.5) * 0.6)).normalize();
        side.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).cross(up).normalize();
        const nrm = new THREE.Vector3().crossVectors(side, up).normalize();
        if (nrm.y < 0) nrm.negate();
        const base = tip.p.clone().addScaledVector(tip.d, -s.card * 0.35);
        card(t, base, up, side, s.card * 1.7, s.twigCell, nrm, white, 2, rnd(), false);
      }
    }
    // листва вокруг конца ветви
    for (let j = 0, nj = isFill ? 1 : s.perTip; j < nj; j++) {
      const p = tip.p.clone().add(tmp.set((rnd() - 0.5), (rnd() - 0.5) * 0.8, (rnd() - 0.5)).multiplyScalar(s.card * 1.1));
      if (s.pine) p.lerp(tip.p, 0.4).y -= 0.15;
      up.set(rnd() - 0.5, s.pine ? 0.1 : rnd() - 0.3, rnd() - 0.5).normalize();
      side.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).cross(up).normalize();
      if (s.pine) { up.copy(tip.d).setY(0).normalize(); side.set(-up.z, 0, up.x).add(tmp.set(0, (rnd() - 0.5) * 0.5, 0)).normalize(); }
      const radial = p.clone().sub(tip.c); radial.y = radial.y * 0.8 + 0.6; radial.normalize();
      const out = Math.min(1, p.distanceTo(tip.c) / 3);
      const shade = 0.6 + 0.4 * Math.min(1, out * (0.7 + 0.3 * radial.y) * 1.2);
      cc.copy(c1).lerp(c2, rnd()).multiplyScalar(shade);
      card(t, p, up, side, s.card * (0.75 + 0.5 * rnd()), s.leafCell, radial, cc, 3, rnd(), true);
    }
  }
  return t.build();
}

/** Импостер: 3 скрещённые плоскости (через 60°), uv — ряд с листвой; aBark.x = 1 у вечнозелёных. */
function buildFar(k: Species, idx: number): THREE.BufferGeometry {
  const s = SPECS[k], t = new TB();
  const H = s.h * 1.08, hw = s.farHW ?? H * 0.25;
  const u0 = idx / ORDER.length, u1 = (idx + 1) / ORDER.length;
  const white = new THREE.Color(1, 1, 1);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI, dx = Math.cos(a), dz = Math.sin(a);
    const v = [[-hw, 0, u0, 0.5], [hw, 0, u1, 0.5], [hw, H, u1, 1], [-hw, H, u0, 1]];
    const P = v.map(([x, y]) => new THREE.Vector3(dx * x, y, dz * x));
    const N = v.map(([x, y]) => new THREE.Vector3(dx * Math.sign(x) * 0.6, 0.5 + 0.5 * (y / H), dz * Math.sign(x) * 0.6).normalize());
    for (const j of [0, 1, 2, 0, 2, 3]) t.vert(P[j], N[j], white, 3, 0.5, [v[j][2], v[j][3]], s.pine ? 1 : 0, 0);
  }
  return t.build();
}

// ------------------------------------------------------------------ материал

/** Общий код сезона (вершинный): доля опавшего и желтизна. */
const SEASON_VERT = /* glsl */ `
float nfrDrop(float season) { return smoothstep(0.42, 0.82, season); }
`;

function treeMaterial(map: THREE.Texture, uTime: { value: number }, far: boolean, pine: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, vertexColors: true, map, side: THREE.DoubleSide, alphaTest: 0.5 });
  m.alphaToCoverage = quality.msaa > 0;
  m.customProgramCacheKey = () => 'nfr-tree3:' + (far ? 'far' : 'near') + (pine ? 'pine' : '');
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, texUniforms);
    sh.uniforms.uTime = uTime;
    sh.uniforms.uWind = weatherUniforms.windStrength;
    sh.uniforms.uWindDir = weatherUniforms.windDir;
    sh.uniforms.uSeason = weatherUniforms.season;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aFlag; attribute float aRnd; attribute vec2 aBark;
        varying float vFlag; varying vec2 vBark; varying float vAut; varying float vTreeH; varying float vEver;
        uniform float uTime, uWind, uSeason; uniform vec2 uWindDir;
        ${SEASON_VERT}`)
      .replace('#include <color_vertex>', /* glsl */ `
        vFlag = aFlag; vBark = aBark; vEver = ${pine ? '1.0' : 'aBark.x'};
        vColor = vec4(color.rgb, 1.0);
        float ih = 0.5;
        #ifdef USE_INSTANCING
          ih = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
          #ifdef USE_INSTANCING_COLOR
            if (aFlag > 2.5) vColor.rgb *= instanceColor.rgb;
          #endif
        #endif
        vTreeH = ih;
        // осень: карточка желтеет со своей задержкой (aRnd), деревья — со своей (ih)
        vAut = smoothstep(0.18, 0.48, uSeason + (aRnd - 0.5) * 0.12 + (ih - 0.5) * 0.1);`)
      .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
        ${far ? '' : `
        if (aFlag > 1.5) {
          vec3 ip = vec3(0.0);
          #ifdef USE_INSTANCING
            ip = instanceMatrix[3].xyz;
          #endif
          float ph = dot(position, vec3(1.7, 0.9, 1.3)) + dot(ip.xz, vec2(0.21, 0.37));
          float a = (0.03 + 0.1 * uWind) * smoothstep(0.0, 8.0, position.y) * (aFlag > 2.5 ? 1.0 : 0.5);
          transformed += vec3(sin(uTime * 2.3 + ph), sin(uTime * 3.1 + ph * 1.3) * 0.5, cos(uTime * 1.9 + ph)) * a;
          transformed.xz += uWindDir * a * 0.6 * (0.5 + 0.5 * sin(uTime * 0.9 + ph * 0.2));
        }`}`)
      .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
        ${far || pine ? '' : `
        // листопад: опавшая карточка схлопывается в точку (вырожденные треугольники, без discard; погода SWAY
        // пересчитывает gl_Position из transformed — поэтому не через gl_Position)
        if (aFlag > 2.5 && aRnd < nfrDrop(uSeason + (vTreeH - 0.5) * 0.12)) transformed = vec3(0.0, -10.0, 0.0);`}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFlag; varying vec2 vBark; varying float vAut; varying float vTreeH; varying float vEver; uniform float uSeason;\n' + TEX_GLSL)
      .replace('#include <map_fragment>', /* glsl */ `
        ${far ? `
        // импостер: листва → голые ветви по сезону (растворение по дереву), осенний тон
        vec4 leafy = texture2D(map, vMapUv);
        vec4 bare = texture2D(map, vMapUv - vec2(0.0, 0.5));
        float keep = vEver > 0.5 ? 1.0 : 1.0 - smoothstep(0.42, 0.82, uSeason + (vTreeH - 0.5) * 0.15);
        vec4 sampledDiffuseColor = keep > 0.5 ? leafy : bare;
        if (vEver < 0.5 && keep > 0.5) {
          float green = smoothstep(0.0, 0.1, sampledDiffuseColor.g - sampledDiffuseColor.r);
          float l = dot(sampledDiffuseColor.rgb, vec3(0.3, 0.6, 0.1));
          vec3 aut = mix(vec3(1.0, 0.75, 0.15), vec3(1.0, 0.45, 0.1), vTreeH) * l * 1.3;
          sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb, aut, green * vAut);
        }
        diffuseColor *= sampledDiffuseColor;` : '#include <map_fragment>'}
        `)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        // (после color_fragment: вершинный цвет уже умножен)
        float nfrTreeRough = 0.8; vec3 nfrTreeN = vec3(0.0, 0.0, 1.0);
        ${far ? '' : `
        if (vFlag < 0.5) {
          // кора: текстура из массива; берёза — белая с тёмными «чечевичками» и пятнами у комля
          NfrT B = nfrTexUV(vBark / vec2(1.0, ${pine ? '2.0' : '1.0'}), ${pine ? 'L_BARK_PINE' : 'L_BARK'});
          float lum = dot(B.alb, vec3(0.33));
          diffuseColor.rgb *= mix(vec3(lum), B.alb, 0.6);
          if (vColor.r > 0.6) {
            float st = step(0.8, fract(sin(floor(vBark.y * 9.0) * 91.7 + floor(vBark.x * 4.0) * 13.1) * 43758.5));
            float butt = 1.0 - smoothstep(0.3, 1.6, vBark.y);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06), max(st * 0.85, butt * 0.7 * step(0.4, B.h)));
          }
          nfrTreeRough = 0.9; nfrTreeN = B.nrm;
        } else if (vFlag > 2.5 && vEver < 0.5) {
          // осенняя листва
          float l = dot(diffuseColor.rgb, vec3(0.3, 0.6, 0.1));
          vec3 aut = mix(AUT_A, AUT_B, fract(vTreeH * 7.3 + vBark.y));
          diffuseColor.rgb = mix(diffuseColor.rgb, aut * clamp(l * 7.0, 0.25, 1.6), vAut);
        }`}
        `)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = nfrTreeRough;')
      .replace('#include <normal_fragment_maps>', /* glsl */ `#include <normal_fragment_maps>
        if (vFlag > 0.5) normal = normalize(vNormal);
        ${far ? '' : 'else { mat3 tbn = nfrTBN(-vViewPosition, normalize(vNormal), vBark); normal = normalize(tbn * nfrTreeN); }'}`);
  };
  return m;
}

/** Материал теней: те же схлопывание опавших карточек и alpha-test по атласу. */
function treeDepthMaterial(map: THREE.Texture, pine: boolean, far: boolean): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide });
  m.customProgramCacheKey = () => 'nfr-tree-depth3' + (pine ? 'p' : '') + (far ? 'f' : '');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSeason = weatherUniforms.season;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFlag; attribute float aRnd; attribute vec2 aBark; uniform float uSeason; varying float vEverD; varying float vTreeHD;\n' + SEASON_VERT)
      .replace('#include <project_vertex>', /* glsl */ `#include <project_vertex>
        float ihd = 0.5;
        #ifdef USE_INSTANCING
          ihd = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
        #endif
        vTreeHD = ihd; vEverD = ${pine ? '1.0' : 'aBark.x'};
        ${far || pine ? '' : 'if (aFlag > 2.5 && aRnd < nfrDrop(uSeason + (ihd - 0.5) * 0.12)) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);'}`);
    if (far) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uSeason; varying float vEverD; varying float vTreeHD;')
        .replace('#include <map_fragment>', /* glsl */ `
          float keepD = vEverD > 0.5 ? 1.0 : 1.0 - smoothstep(0.42, 0.82, uSeason + (vTreeHD - 0.5) * 0.15);
          diffuseColor *= texture2D(map, keepD > 0.5 ? vMapUv : vMapUv - vec2(0.0, 0.5));`);
    }
  };
  return m;
}

export interface TreeSet {
  near: Record<string, THREE.BufferGeometry>;
  far: Record<string, THREE.BufferGeometry>;
  material: { near: THREE.MeshStandardMaterial; nearPine: THREE.MeshStandardMaterial; far: THREE.MeshStandardMaterial };
  /** Дальность полноценных моделей (дальше — импостеры). */
  nearDist: number;
}

/** Модели и материалы деревьев v2 (один раз). Погода (applySurfaceWeather) — снаружи, в props.ts. */
export function buildTreeSet(uTime: { value: number }): TreeSet {
  const leaves = leafAtlas();
  const skels: Record<string, Skeleton> = {};
  const near: Record<string, THREE.BufferGeometry> = {}, far: Record<string, THREE.BufferGeometry> = {};
  ORDER.forEach((k, i) => { skels[k] = skeleton(k, 1000 + i * 77); near[k] = buildNear(k, skels[k], 500 + i * 31); far[k] = buildFar(k, i); });
  const imp = impostorAtlas(skels);
  const autumn = (a: number, b: number) => [new THREE.Color(a), new THREE.Color(b)].map((c) => `vec3(${c.r.toFixed(3)}, ${c.g.toFixed(3)}, ${c.b.toFixed(3)})`);
  // осенние цвета — общие для лиственных (по атласу): жёлто-оранжевые; у клёна краснее — через инстанс-тон не выразить, берём смесь
  const [A, B] = autumn(SPECS.tree_lime.autumn[0], SPECS.tree_maple.autumn[1]);
  const mk = (mapT: THREE.Texture, far_: boolean, pine: boolean) => {
    const mm = treeMaterial(mapT, uTime, far_, pine);
    const prev = mm.onBeforeCompile;
    mm.onBeforeCompile = (sh, r) => { prev.call(mm, sh, r); sh.fragmentShader = sh.fragmentShader.replace(/AUT_A/g, A).replace(/AUT_B/g, B); };
    mm.userData.nfrDepth = treeDepthMaterial(mapT, pine, far_);
    return mm;
  };
  return {
    near, far,
    material: { near: mk(leaves, false, false), nearPine: mk(leaves, false, true), far: mk(imp, true, false) },
    nearDist: quality.treeNear,
  };
}
