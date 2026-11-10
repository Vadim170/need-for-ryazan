import * as THREE from 'three';
import { surfHistogram, SURF, type TileSurface } from './surface-mask';

/**
 * Ограды и ограждения из `segments` (fence, wall, lawn_fence, ped_fence, guardrail, jersey_barrier).
 *
 * Рендер — 3 инстанс-пула на весь мир:
 *  - `fence_panel`: единичная панель (z ∈ ±0.5 вдоль сегмента, y ∈ 0..1, x — толщина), растянута матрицей по сегменту
 *    со сдвигом по высоте (идёт по рельефу). Части: заполнение (узор шейдером, alpha-test) + верхняя/нижняя перекладины.
 *    Узор по стилю (aExt.x): сварная секция из профтрубы, кованая с пиками, рабица, профнастил, бетонный забор ПО-2,
 *    штакетник, кирпич, штукатурка (Кремль), низкий заборчик с дугами, пешеходное ограждение (красно-белое и др.),
 *    жерди, разноцветный штакетник, отбойник W-профиля.
 *  - `fence_post`: столбы (профтруба/труба/бетон/кирпичный столб) в узлах и через ~2.5–3 м.
 *  - `jersey`: блоки «Нью-Джерси» (трапеция).
 * Стиль: поле `style`, иначе по окружению (surface-mask: архетипы зданий v2 — школа, гаражи, промзона, частный сектор,
 * сталинки/храмы, газоны/детплощадки; Кремль — по расстоянию до начала координат); одна OSM-линия (цепочка сегментов с общими
 * концами) — один стиль.
 */

export const FP = {
  welded: 0, pikes: 1, chain: 2, profnastil: 3, concrete: 4, picket: 5, brick: 6, plaster: 7, arcs: 8, ped: 9, rail: 10,
  multicolor: 11, guardrail: 12,
} as const;

interface Style { p: number; color: number; th: number; post: number; postW: number; postKind: 'post' | 'pillar' | null; variant?: number; railTh?: number }

const PROF_COLORS = [0x6b3a2a, 0x2f5e46, 0x3a5a8a, 0x8a8f94, 0x7b2c26, 0x8c7a5b];

export interface SegJson { type: string; x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; height?: number; style?: string }

export interface SegOut {
  /** вид → (матрицы 16, цвета 3, ext 4, xz 2) */
  groups: Map<string, { m: number[]; c: number[]; e: number[]; xz: number[] }>;
  /** коллайдеры: шаг 8, как в props.ts */
  shapes: number[];
  /** на каждую фигуру: класс разрушения (breakables.ts BREAK, 'static' — не ломается), вид и индекс инстанса, столбы сегмента */
  shapeMeta: { cls: string; kind: string; idx: number; posts: number[] }[];
  /** отрезки (x1,z1,x2,z2) — трава рисует сорняки вдоль них */
  lines: number[];
}

const frac = (x: number) => x - Math.floor(x);
const hash = (a: number, b: number) => frac(Math.sin(a * 12.9898 + b * 78.233) * 43758.5453);

/** Стиль цепочки по типу/style и окружению. */
function pickStyle(seg: SegJson, surf: TileSurface | null, mx: number, mz: number, h: number): Style {
  const r = hash(Math.round(mx / 7), Math.round(mz / 7));
  const st = seg.style ?? '';
  const welded = (green: boolean): Style => ({ p: FP.welded, color: green ? 0x2e5a3c : 0x1c1e20, th: 0.02, post: 2.6, postW: 0.06, postKind: 'post' });
  const pikes = (): Style => ({ p: FP.pikes, color: 0x161616, th: 0.022, post: 2.6, postW: 0.08, postKind: 'post' });
  const chain = (): Style => ({ p: FP.chain, color: 0x9aa0a4, th: 0.01, post: 2.8, postW: 0.05, postKind: 'post', railTh: 2 });
  const prof = (): Style => ({ p: FP.profnastil, color: PROF_COLORS[Math.floor(r * PROF_COLORS.length)], th: 0.02, post: 2.8, postW: 0.06, postKind: 'post' });
  const concrete = (): Style => ({ p: FP.concrete, color: 0xa9a69c, th: 0.14, post: 4, postW: 0.2, postKind: 'post' });
  const picket = (): Style => ({ p: FP.picket, color: r < 0.6 ? 0x7a5a3a : 0x5f7a4a, th: 0.025, post: 2.5, postW: 0.08, postKind: 'post' });
  const brick = (): Style => ({ p: FP.brick, color: 0x8e4b36, th: 0.38, post: 3.5, postW: 0.5, postKind: 'pillar', railTh: 1.2 });
  const plaster = (white: boolean, thick = 0.4): Style => ({ p: FP.plaster, color: white ? 0xe8e3d8 : 0xb8b2a6, th: thick, post: 0, postW: 0, postKind: null, railTh: 1.12 });

  switch (seg.type) {
    case 'ped_fence': {
      const v = ({ red_white: 0, grey: 1, green: 2, decorative_black: 3 } as Record<string, number>)[st] ?? 1;
      return { p: FP.ped, color: [0xf2f2f0, 0x8a9096, 0x2e6a40, 0x18191a][v], th: 0.03, post: 2.0, postW: 0.05, postKind: 'post', variant: v };
    }
    case 'lawn_fence':
      if (st === 'metal_arc') return { p: FP.arcs, color: r < 0.5 ? 0x1c1e20 : 0x2e6a40, th: 0.016, post: 2.0, postW: 0.03, postKind: 'post' };
      if (st === 'painted_multicolor') return { p: FP.multicolor, color: 0xffffff, th: 0.02, post: 2.0, postW: 0.04, postKind: 'post' };
      if (st === 'wood_picket') return { ...picket(), color: 0xdcd6c6, post: 2.0 };
      return { p: FP.welded, color: 0x3d8a4a, th: 0.016, post: 2.0, postW: 0.035, postKind: 'post' };
    case 'guardrail':
      return { p: FP.guardrail, color: 0xb4b9bd, th: 0.1, post: 2.0, postW: 0.1, postKind: 'post' };
    case 'wall': {
      if (st === 'brick') return brick();
      if (st === 'concrete') return concrete();
      if (h >= 3 || Math.hypot(mx, mz) < 600) return plaster(true, h >= 3 ? 1.4 : 0.5);
      if (h <= 1.5) return plaster(false, 0.3); // подпорная
      const H = surf ? surfHistogram(surf, mx, mz, 25) : null;
      if (H && H[SURF.building + 11] + H[SURF.building + 10] > 4) return concrete();
      return r < 0.5 ? brick() : plaster(r < 0.7, 0.35);
    }
    default: break; // fence
  }
  if (st === 'metal') return welded(r < 0.6);
  if (st === 'bars') return r < 0.5 ? pikes() : welded(r < 0.75);
  if (st === 'chain' || st === 'chain_link') return chain();
  if (st === 'wood') return r < 0.5 ? picket() : prof();
  if (st === 'concrete') return concrete();
  if (st === 'brick') return brick();
  if (st === 'split_rail' || st === 'pole') return { p: FP.rail, color: st === 'pole' ? 0x6a6e72 : 0x6b5236, th: 0.08, post: 2.5, postW: 0.08, postKind: 'post' };
  // нет style: по окружению
  if (Math.hypot(mx, mz) < 500) return pikes(); // Кремль, центр
  if (!surf) return welded(true);
  const H = surfHistogram(surf, mx, mz, 25);
  const b = (a: number) => H[SURF.building + a];
  const apart = b(1) + b(2) + b(3) + b(4);
  const best = Math.max(b(13) + b(14), b(10) + b(15), b(11), b(7), b(5) + b(6) + b(12), b(9) + b(8), apart);
  if (best > 3) {
    if (best === b(13) + b(14)) return r < 0.7 ? welded(true) : pikes(); // школа/детсад/поликлиника
    if (best === b(10) + b(15)) return r < 0.5 ? chain() : prof(); // гаражи, сараи
    if (best === b(11)) return r < 0.7 ? concrete() : chain(); // промзона
    if (best === b(7)) return r < 0.55 ? prof() : r < 0.85 ? picket() : chain(); // частный сектор
    if (best === b(5) + b(6) + b(12)) return pikes(); // сталинки, купеческие, храмы
    if (best === b(9) + b(8)) return r < 0.4 ? pikes() : welded(false); // торговля, новострой
    return r < 0.6 ? welded(true) : r < 0.85 ? welded(false) : chain(); // многоэтажки
  }
  if (H[SURF.playground] > 10) return welded(true);
  if (H[SURF.grass] > 60) return r < 0.5 ? pikes() : welded(true); // парк/сквер
  return r < 0.4 ? chain() : r < 0.7 ? welded(true) : prof();
}

/** Сегменты тайла → инстансы панелей/столбов/блоков + коллайдеры. */
export function buildSegments(segs: SegJson[], surf: TileSurface | null): SegOut {
  const out: SegOut = { groups: new Map(), shapes: [], shapeMeta: [], lines: [] };
  const grp = (k: string) => { let g = out.groups.get(k); if (!g) out.groups.set(k, (g = { m: [], c: [], e: [], xz: [] })); return g; };
  // цепочки по общим концам (union-find) — один стиль на линию
  const key = (x: number, z: number) => Math.round(x * 10) + ':' + Math.round(z * 10);
  const parent = segs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const ends = new Map<string, number>();
  const starts = new Set<string>();
  segs.forEach((s, i) => {
    starts.add(s.type + key(s.x1, s.z1));
    for (const k of [s.type + key(s.x1, s.z1), s.type + key(s.x2, s.z2)]) {
      const j = ends.get(k);
      if (j === undefined) ends.set(k, i); else parent[find(i)] = find(j);
    }
  });
  const styles = new Map<number, Style>();
  const col = new THREE.Color();
  segs.forEach((s, i) => {
    const root = find(i);
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1, dz = s.z2 - s.z1;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    const h = s.height ?? ({ fence: 1.8, wall: 2.2, lawn_fence: 0.6, ped_fence: 1.0, guardrail: 0.75, jersey_barrier: 0.8 } as Record<string, number>)[s.type] ?? 1.5;
    const mx = (s.x1 + s.x2) / 2, mz = (s.z1 + s.z2) / 2, my = (s.y1 + s.y2) / 2;
    let st = styles.get(root);
    if (!st) { const r0 = segs[root]; st = pickStyle(r0, surf, (r0.x1 + r0.x2) / 2, (r0.z1 + r0.z2) / 2, h); styles.set(root, st); }
    const ux = dx / len, uz = dz / len;
    if (s.type === 'fence' || s.type === 'wall') out.lines.push(s.x1, s.z1, s.x2, s.z2); // сорняки вдоль (не у низких заборчиков)
    if (s.type === 'jersey_barrier') {
      const G = grp('jersey');
      // ширина блока 0.6 м (геометрия единичной ширины), длина = отрезок
      G.m.push(uz * 0.6, 0, -ux * 0.6, 0, 0, h, 0, 0, dx, dy, dz, 0, mx, my - 0.02, mz, 1);
      const red = s.style === 'red_white_plastic';
      col.set(red ? (i % 2 ? 0xd8261c : 0xf0f0ee) : 0xa8a59c);
      G.c.push(col.r, col.g, col.b); G.e.push(0, len, h, 0); G.xz.push(mx, mz);
      out.shapes.push(1, mx, my + h / 2, mz, 0.3, h / 2, len / 2, Math.atan2(dx, dz));
      out.shapeMeta.push({ cls: s.style === 'red_white_plastic' ? 'jersey_plastic' : 'jersey', kind: 'jersey', idx: G.c.length / 3 - 1, posts: [] });
      return;
    }
    // панель
    const th = st.th;
    const P = grp('fence_panel');
    P.m.push(uz * th, 0, -ux * th, 0, 0, h, 0, 0, dx, dy, dz, 0, mx, my - 0.03, mz, 1);
    col.set(st.color);
    P.c.push(col.r, col.g, col.b);
    P.e.push(st.p, len, h, (st.variant ?? 0) + Math.round((st.railTh ?? 1.6) * 10) * 10);
    P.xz.push(mx, mz);
    // столбы: в начале, в конце (если там не начинается другой сегмент того же типа) и промежуточные
    const segPosts: number[] = [];
    if (st.postKind) {
      const pts: number[] = [0];
      const nMid = st.post > 0 ? Math.floor(len / st.post) : 0;
      for (let k = 1; k <= nMid; k++) { const t = k / (nMid + 1); if (len * t > 0.8 && len * (1 - t) > 0.8) pts.push(t); }
      if (!starts.has(s.type + key(s.x2, s.z2))) pts.push(1);
      const K = grp('fence_post');
      const w = st.postW, ph = h + (st.postKind === 'pillar' ? 0.15 : st.p === FP.pikes ? 0.12 : 0.04);
      for (const t of pts) {
        const px = s.x1 + dx * t, pz = s.z1 + dz * t, py = s.y1 + dy * t;
        K.m.push(uz * w, 0, -ux * w, 0, 0, ph, 0, 0, ux * w, 0, uz * w, 0, px, py - 0.1, pz, 1);
        K.c.push(col.r, col.g, col.b); K.e.push(st.p, 0, ph, 0); K.xz.push(px, pz);
        segPosts.push(K.c.length / 3 - 1);
      }
    }
    out.shapes.push(1, mx, my + h / 2, mz, Math.max(th, 0.1) / 2, h / 2, len / 2, Math.atan2(dx, dz));
    const solid = st.p === FP.concrete || st.p === FP.brick || st.p === FP.plaster;
    const cls = s.type === 'guardrail' ? 'guardrail' : s.type === 'ped_fence' ? 'ped_fence' : s.type === 'lawn_fence' ? 'lawn_fence'
      : solid ? 'static' : 'fence';
    out.shapeMeta.push({ cls, kind: 'fence_panel', idx: P.c.length / 3 - 1, posts: segPosts });
  });
  return out;
}

// ---------------- геометрия и материал ----------------

/** Панель: заполнение (aFlag 0) + перекладины (aFlag 6) у верха и низа. x ∈ ±0.5 (× толщина), y 0..1, z ±0.5. */
export function buildFencePanel(): THREE.BufferGeometry {
  const parts: [THREE.BufferGeometry, number][] = [];
  const inf = new THREE.BoxGeometry(1, 0.96, 1); inf.translate(0, 0.5, 0); parts.push([inf, 0]);
  for (const y of [0.1, 0.885]) { const r = new THREE.BoxGeometry(1, 0.035, 1); r.translate(0, y, 0); parts.push([r, 6]); }
  return mergeFlagged(parts);
}

/** Столб: ящик x,z ±0.5, y 0..1 + шапка. */
export function buildFencePost(): THREE.BufferGeometry {
  const b = new THREE.BoxGeometry(1, 1, 1); b.translate(0, 0.5, 0);
  const cap = new THREE.BoxGeometry(1.3, 0.02, 1.3); cap.translate(0, 1.0, 0);
  return mergeFlagged([[b, 7], [cap, 7]]);
}

/** Блок «Нью-Джерси»: профиль-трапеция (низ 1, верх 0.25 ширины), длина z ±0.5, высота 0..1. */
export function buildJersey(): THREE.BufferGeometry {
  const sh = new THREE.Shape([new THREE.Vector2(-0.5, 0), new THREE.Vector2(0.5, 0), new THREE.Vector2(0.38, 0.12), new THREE.Vector2(0.14, 0.4), new THREE.Vector2(0.125, 1), new THREE.Vector2(-0.125, 1), new THREE.Vector2(-0.14, 0.4), new THREE.Vector2(-0.38, 0.12)]);
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.96, bevelEnabled: false });
  g.translate(0, 0, -0.48);
  g.deleteAttribute('uv');
  return mergeFlagged([[g, 8]]);
}

function mergeFlagged(parts: [THREE.BufferGeometry, number][]): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], flag: number[] = [], col: number[] = [];
  for (const [g0, f] of parts) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const P = g.getAttribute('position'), N = g.getAttribute('normal');
    for (let i = 0; i < P.count; i++) { pos.push(P.getX(i), P.getY(i), P.getZ(i)); nrm.push(N.getX(i), N.getY(i), N.getZ(i)); flag.push(f); col.push(1, 1, 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aFlag', new THREE.Float32BufferAttribute(flag, 1));
  return g;
}

/**
 * Материал оград: цвет инстанса, узор заполнения по aExt.x (стиль), aExt.y — длина сегмента, aExt.z — высота,
 * aExt.w — вариант + 10·round(10·толщина перекладины в долях толщины заполнения). Узоры — discard (alpha-test) с
 * дизерингом вдали (рабица/прутья не мерцают, а «сереют»).
 */
export function fenceMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.15, vertexColors: true, side: THREE.DoubleSide });
  m.customProgramCacheKey = () => 'nfr-fence2';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFlag; attribute vec4 aExt; varying vec4 vExt; varying vec2 vF; varying float vFl; varying vec3 vFLocal;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vExt = aExt; vFl = aFlag; vFLocal = position;
        // перекладины толще заполнения: раздуваем x локально (до матрицы инстанса)
        if (aFlag > 5.5 && aFlag < 6.5) transformed.x *= floor(aExt.w / 10.0) / 10.0;
        vF = vec2((position.z + 0.5) * aExt.y, position.y * aExt.z);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vExt; varying vec2 vF; varying float vFl; varying vec3 vFLocal;
        float fh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float fn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(fh(i), fh(i + vec2(1, 0)), f.x), mix(fh(i + vec2(0, 1)), fh(i + vec2(1, 1)), f.x), f.y); }
        // полоса шириной w (м) с шагом step: 1 внутри; вдали (fwidth > w) — вероятностно по покрытию
        float barsC(float x, float step_, float w, float minCov) {
          float fw = fwidth(x);
          float d = abs(fract(x / step_ + 0.5) - 0.5) * step_;
          float hard = step(d, w * 0.5);
          float cov = max(w / step_ * 1.3, minCov);
          return fw > w * 0.7 ? step(fh(gl_FragCoord.xy), cov) : hard;
        }
        float bars(float x, float step_, float w) { return barsC(x, step_, w, 0.0); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float p = vExt.x, L = vExt.y, H = vExt.z, var_ = mod(vExt.w, 10.0);
          float x = vF.x, y = vF.y, yn = vFLocal.y;
          if (vFl < 0.5) {               // заполнение
            float keep = 1.0;
            if (p < 0.5) {                 // сварная: прутья профтрубы 13 см
              keep = bars(x, 0.13, 0.025) * step(0.06, yn);
            } else if (p < 1.5) {          // кованая: прутья с пиками выше верхней перекладины
              float b = bars(x, 0.12, 0.022);
              float top = 0.9 * H;
              float d = abs(fract(x / 0.12 + 0.5) - 0.5) * 0.12;
              float tip = step(d, 0.03 * clamp((H - y) / (H - top), 0.0, 1.0));
              keep = y > top ? tip : b;
              keep = max(keep, step(abs(y - 0.55 * H), 0.03) * step(abs(fract(x / 0.24) - 0.5), 0.25)); // поясок
            } else if (p < 2.5) {          // рабица: ромбы 6 см, проволока 4 мм
              float a = barsC(x + y, 0.085, 0.01, 0.17), b = barsC(x - y, 0.085, 0.01, 0.17);
              keep = max(a, b);
              diffuseColor.rgb *= 0.9;
            } else if (p < 3.5) {          // профнастил: трапеции 11.5 см
              float t = fract(x / 0.115);
              float s = smoothstep(0.1, 0.2, t) - smoothstep(0.55, 0.65, t);
              diffuseColor.rgb *= 0.78 + 0.25 * s;
              diffuseColor.rgb *= 0.9 + 0.1 * fn(vec2(x * 0.5, y * 2.0));
            } else if (p < 4.5) {          // бетонный забор ПО-2: плиты 4 м, ромбовидный рельеф
              vec2 q = vec2(x / 0.33, y / 0.33);
              vec2 f = abs(fract(q) - 0.5);
              float rh = smoothstep(0.42, 0.5, f.x + f.y);
              float seam = step(fract(x / 4.0), 0.01);
              diffuseColor.rgb *= (0.86 + 0.18 * fn(vec2(x, y) * 1.3)) * (1.0 - 0.25 * rh) * (1.0 - 0.4 * seam);
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.35, 0.33, 0.3), smoothstep(0.3, 0.0, y) * 0.5);
            } else if (p < 5.5) {          // штакетник: доски 10 см, зазор 4 см, острые верхушки
              float d = fract(x / 0.14);
              keep = step(d, 0.71);
              float c = abs(d / 0.71 - 0.5);
              keep *= step(y, H - 0.08 + 0.08 * (1.0 - c * 2.0) - 0.0) + step(y, H - 0.08);
              keep = min(keep, 1.0);
              diffuseColor.rgb *= 0.85 + 0.25 * fh(vec2(floor(x / 0.14), 3.0));
            } else if (p < 6.5) {          // кирпич 25×6.5 см, перевязка
              vec2 q = vec2(x / 0.26, y / 0.075);
              q.x += step(1.0, mod(floor(q.y), 2.0)) * 0.5;
              vec2 f = abs(fract(q) - 0.5);
              float mortar = step(0.45, max(f.x * 1.0, f.y * 0.95));
              diffuseColor.rgb *= (0.8 + 0.35 * fh(floor(q))) ;
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.6, 0.55), mortar * 0.8);
            } else if (p < 7.5) {          // штукатурка/побелка
              diffuseColor.rgb *= 0.88 + 0.14 * fn(vec2(x, y) * 0.9) - 0.12 * smoothstep(0.6, 0.0, y) * fn(vec2(x * 3.0, 1.0));
            } else if (p < 8.5) {          // низкий заборчик с дугами (дуги через 0.5 м, внахлёст)
              float c1 = abs(length(vec2(fract(x / 0.5) - 0.5, (y / H) * 1.1)) - 0.45) * 0.5;
              float c2 = abs(length(vec2(fract(x / 0.5) , (y / H) * 1.1)) - 0.45) * 0.5;
              keep = max(step(min(c1, c2), 0.012), bars(x, 0.5, 0.02));
            } else if (p < 9.5) {          // пешеходное ограждение: рамы ~2 м, прутья; красно-белое — чередование секций
              float sec = floor(x / 2.0);
              float fx = fract(x / 2.0) * 2.0;
              float frame = step(fx, 0.04) + step(1.96, fx) + step(abs(y - 0.12), 0.025) + step(abs(y - (H - 0.08)), 0.025);
              float inner = var_ > 2.5 ? max(bars(x, 0.15, 0.016), step(abs(length(vec2(fract(x / 0.3) - 0.5, (y - 0.55 * H) / 0.3)) - 0.3), 0.04))
                                       : bars(x, 0.16, 0.02);
              keep = min(1.0, frame + inner) * step(0.1, y);
              if (var_ < 0.5) diffuseColor.rgb = mod(sec, 2.0) < 0.5 ? vec3(0.8, 0.06, 0.04) : vec3(0.9);
            } else if (p < 10.5) {         // жерди: только перекладины
              keep = step(abs(y - 0.45 * H), 0.05) + step(abs(y - 0.9 * H), 0.05);
            } else if (p < 11.5) {         // разноцветный штакетник
              float d = fract(x / 0.12);
              keep = step(d, 0.6) * step(y, H - 0.05 * abs(d / 0.6 - 0.5) * 2.0);
              float k = floor(x / 0.12);
              vec3 pal[4] = vec3[4](vec3(0.85, 0.15, 0.1), vec3(0.95, 0.75, 0.1), vec3(0.15, 0.45, 0.8), vec3(0.2, 0.65, 0.25));
              diffuseColor.rgb = pal[int(mod(k, 4.0))];
            } else {                       // отбойник W: лента 0.31 м у верха, гофр
              float band = step(H - 0.35, y) * step(y, H - 0.03);
              keep = band;
              float w = sin((y - H) * 31.4);
              diffuseColor.rgb *= 0.85 + 0.2 * w;
            }
            if (keep < 0.5) discard;
          } else if (vFl > 5.5 && vFl < 6.5) {    // перекладины: у сплошных — карниз/цоколь, у жердей/рабицы/отбойника — скрыты
            if (p > 9.5 && p < 10.5 || p > 11.5 || (p > 1.5 && p < 2.5 && yn < 0.5)) discard;
            if (p > 2.5 && p < 7.5) diffuseColor.rgb *= 0.8;
            if (p > 8.5 && p < 9.5 && var_ < 0.5) diffuseColor.rgb = vec3(0.8, 0.06, 0.04);
          } else if (vFl > 6.5 && vFl < 7.5) {    // столбы
            if (p > 5.5 && p < 6.5) {               // кирпичный столб
              vec2 q = vec2((vFLocal.x + vFLocal.z) * 2.0, vFLocal.y * vExt.z / 0.075);
              q.x += step(1.0, mod(floor(q.y), 2.0)) * 0.5;
              vec2 f = abs(fract(q) - 0.5);
              diffuseColor.rgb = mix(diffuseColor.rgb * (0.8 + 0.3 * fh(floor(q))), vec3(0.62, 0.6, 0.55), step(0.45, max(f.x, f.y)) * 0.8);
            }
            if (p > 8.5 && p < 9.5 && var_ < 0.5) diffuseColor.rgb = vec3(0.85);
          }
        }`);
  };
  return m;
}
