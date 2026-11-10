import * as THREE from 'three';
import { MeshBuilder, PART, lin, pchip, type RGB, type V3 } from './mesh';
import { buildWheelGeometry, type RimStyle } from './wheels';

/**
 * Параметрический кузов: лофт колец-сечений вдоль длины (нижняя часть кузова + «остекление» с зонами стёкол/стоек),
 * капот/багажник/скаты крыши — ломаные по длине (PCHIP), скруглённый план носа/кормы, колёсные арки с «брызговиками»-
 * закрылками, фары/фонари/решётка/номера как вставки по поверхности, зеркала, ручки, швы дверей, дорожный «грязный» градиент.
 * Система координат: нос −Z, вверх +Y, начало — центр габарита по длине, на земле; x в спецификации — от носа вдоль длины.
 */

export type VehicleKind = 'sedan' | 'hatch' | 'wagon' | 'suv' | 'taxi' | 'police' | 'gazelle' | 'paz' | 'liaz' | 'trolleybus';

export interface Zone { x0: number; x1: number; t: 'ws' | 'win' | 'bl' | 'blsolid' | 'solid' | 'door' }

export interface LampStyle {
  /** Границы по ширине (доли полуширины) внутренний/внешний край. */
  ax0: number; ax1: number;
  /** Высота фары у внутреннего и внешнего края, верх относительно верха торца (dy < 0 — ниже). */
  h0: number; h1: number; dy: number;
}

export interface BodySpec {
  id: string; name: string; kind: VehicleKind;
  L: number; W: number; H: number; wb: number; fo: number; R: number; tw: number; clear: number;
  lowTop: [number, number][]; roof: [number, number][]; zones: Zone[];
  rn: number; rt: number; fN: number; fT: number;
  gw: [number, number, number, number];
  band: { side: number; nose: number; tail: number };
  crown: number; shoulder: number;
  rim: RimStyle;
  head: LampStyle; tail: LampStyle;
  grille?: { w: number; h: number; dy: number; color: number; frame?: number; lowerW?: number };
  /** Верх торца кормы: 'deck' (багажник) / 'gate' (дверь багажника). */
  rear: 'deck' | 'gate';
  /** Двери: передние кромки/ручки (позиции x, от носа). */
  seams: number[]; handles: number[];
  mirror?: { x: number; w: number };
  mudflaps?: boolean; chromeBumpers?: boolean; rails?: boolean; fogLamps?: boolean;
  dirt: number;
  /** Вес в выборе варианта вида: трафик / парковка (0 — не используется). */
  weight: number; parkedWeight: number;
  mass: number;
  fixedPaint?: number;
  /** Правый борт — двери автобуса (x0,x1). */
  doorsX?: [number, number][];
  /** Доп. детали (ливрея, маячки…): вызывается после основного кузова (LOD0 и LOD1 одинаково, lod — для упрощения). */
  extra?: (b: MeshBuilder, c: CarCtx) => void;
  /** Группа дальнего LOD (по умолчанию — вид). */
  farGroup?: string;
  tags?: string[];
}

export interface CarCtx {
  s: BodySpec; lod: 0 | 1;
  /** x от носа → z модели. */
  z(x: number): number;
  hw(x: number): number; lowTop(x: number): number; roof(x: number): number; yBot(x: number): number;
  /** x боковой стенки (>0, правая) на высоте y в точке x. */
  sideX(x: number, y: number): number;
  /** Точка на передней/задней поверхности: |x|, высота → z (с отступом наружу lift). */
  frontZ(ax: number, lift?: number): number; rearZ(ax: number, lift?: number): number;
  yFas: number; yTail: number;
  paint(y: number): RGB;
}

const GLASS = 0x1d2630, TRIM = 0x1a1b1d, LAMP_W = 0xf1eee2, LAMP_R = 0xa01212, LAMP_A = 0xd8860e, PLATE = 0xeeeeea, CHROME = 0xc4c7cb;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export interface BuiltCar {
  near: THREE.BufferGeometry; far: THREE.BufferGeometry;
  wheels: [number, number, number][];
  wheelRadius: number; wheelWidth: number;
  length: number; width: number; height: number;
}

function makeCtx(s: BodySpec, lod: 0 | 1): CarCtx {
  const lowTop = pchip(s.lowTop), roof = pchip(s.roof);
  const yBotPts: [number, number][] = [[0, s.clear + 0.13], [0.05 * s.L, s.clear + 0.07], [0.15 * s.L, s.clear + 0.012], [0.85 * s.L, s.clear + 0.012], [0.95 * s.L, s.clear + 0.08], [s.L, s.clear + 0.14]];
  const yBot = pchip(yBotPts);
  const hw0 = s.W / 2;
  const plan = (x: number): number => {
    let f = 1;
    if (x < s.rn) { const q = (s.rn - x) / s.rn; f = Math.min(f, s.fN + (1 - s.fN) * Math.sqrt(Math.max(0, 1 - q * q))); }
    const xt = s.L - x;
    if (xt < s.rt) { const q = (s.rt - xt) / s.rt; f = Math.min(f, s.fT + (1 - s.fT) * Math.sqrt(Math.max(0, 1 - q * q))); }
    return hw0 * f;
  };
  const tOf = (ax: number, r: number, f0: number) => {
    const sv = Math.min(1, Math.max(0, (ax / hw0 - f0) / (1 - f0)));
    return r * (1 - Math.sqrt(1 - sv * sv));
  };
  const zc = (x: number) => x - s.L / 2;
  const ctx: CarCtx = {
    s, lod, z: zc, hw: plan, lowTop, roof, yBot,
    sideX: (x, y) => {
      const r = lowerRing(ctx, x);
      // левая половина (x<0): точки id 2..6; ищем сегмент по y
      for (let i = 2; i < 6; i++) {
        const a = r[i], b = r[i + 1];
        if (y >= a[1] && y <= b[1]) { const t = (y - a[1]) / ((b[1] - a[1]) || 1); return a[0] + (b[0] - a[0]) * t; }
      }
      return plan(x);
    },
    frontZ: (ax, lift = 0) => zc(tOf(ax, s.rn, s.fN)) - lift,
    rearZ: (ax, lift = 0) => zc(s.L - tOf(ax, s.rt, s.fT)) + lift,
    yFas: lowTop(0), yTail: lowTop(s.L),
    paint: (y) => {
      const d = s.dirt * (1 - smooth(0.12, 0.62, y));
      return [1 - d * 0.62, 1 - d * 0.66, 1 - d * 0.74];
    },
  };
  return ctx;
}

/** Левая половина кольца нижней части (id 0..8): точки (|x|, y) — x положителен. */
function lowerRing(c: CarCtx, x: number): V3[] {
  const s = c.s, hw = c.hw(x), yb = c.yBot(x), yt = c.lowTop(x);
  const bandN = s.band.nose * (1 - smooth(0, 0.7, x)) + s.band.side * smooth(0, 0.7, x);
  const bandT = s.band.tail * (1 - smooth(0, 0.7, s.L - x)) + s.band.side * smooth(0, 0.7, s.L - x);
  let band = x < s.L / 2 ? Math.max(bandN, s.band.side) : Math.max(bandT, s.band.side);
  band = Math.min(band, (yt - yb) * 0.55);
  const sh = Math.min(s.shoulder, (yt - yb - band) * 0.55);
  return [
    [0, yb, 0], [hw * 0.8, yb, 0], [hw * 0.965, yb + 0.045, 0], [hw, yb + band, 0], [hw, yt - sh, 0],
    [hw * 0.975, yt - sh * 0.45, 0], [hw * 0.9, yt - 0.015, 0], [hw * 0.5, yt + s.crown * 0.75, 0], [0, yt + s.crown, 0],
  ];
}

function greenRing(c: CarCtx, x: number): V3[] {
  const s = c.s, hw = c.hw(x), belt = c.lowTop(x), top = Math.max(belt + 0.002, c.roof(x));
  const h = top - belt, g = s.gw;
  return [
    [hw * g[0], belt, 0], [hw * g[1], belt + 0.8 * h, 0], [hw * g[2], belt + 0.965 * h, 0], [hw * g[3], belt + 0.992 * h, 0],
    [hw * g[3] * 0.5, top, 0], [0, top + 0.004, 0],
  ];
}

function mirrorRing(half: V3[], z: number): { ring: V3[]; ids: number[] } {
  const M = half.length - 1;
  const ring: V3[] = [], ids: number[] = [];
  for (let i = 0; i <= M; i++) { ring.push([-half[i][0], half[i][1], z]); ids.push(i); }
  for (let i = M - 1; i >= 0; i--) { ring.push([half[i][0], half[i][1], z]); ids.push(i); }
  return { ring, ids };
}

function uniq(xs: number[], eps = 0.015): number[] {
  xs.sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of xs) if (!out.length || x - out[out.length - 1] > eps) out.push(x);
  return out;
}

function subdivide(xs: number[], step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    out.push(xs[i]);
    if (i < xs.length - 1) { const n = Math.floor((xs[i + 1] - xs[i]) / step); for (let j = 1; j <= n; j++) { const x = xs[i] + ((xs[i + 1] - xs[i]) * j) / (n + 1); out.push(x); } }
  }
  return out;
}

function zoneAt(s: BodySpec, x: number): Zone['t'] {
  for (const z of s.zones) if (x >= z.x0 && x <= z.x1) return z.t;
  return 'solid';
}

/** Выпуклая прямоугольная заплатка на поверхности носа/кормы: |x| ∈ [ax0, ax1], высота снизу/сверху у края 0 и 1. */
function endPatch(b: MeshBuilder, c: CarCtx, front: boolean, ax0: number, ax1: number, yb0: number, yt0: number, yb1: number, yt1: number,
  color: number | RGB, part: number, lift: number, nu = 4): void {
  for (const sx of [-1, 1]) {
    const part2 = part === PART.indL || part === PART.indR ? (sx < 0 ? PART.indL : PART.indR) : part;
    b.patch(nu, 1, (u, v) => {
      const ax = ax0 + (ax1 - ax0) * u;
      const yb = yb0 + (yb1 - yb0) * u, yt = yt0 + (yt1 - yt0) * u;
      const y = yb + (yt - yb) * v;
      const z = front ? c.frontZ(ax, lift) : c.rearZ(ax, lift);
      const e = 0.01;
      const f = front ? (c.frontZ(ax + e) - c.frontZ(ax)) / e : -(c.rearZ(ax + e) - c.rearZ(ax)) / e; // dz/dax (z растёт к корме для front)
      const nxs = sx * (front ? -f : f);
      const n: V3 = front ? [-nxs, 0, -1] : [nxs, 0, 1];
      const l = Math.hypot(n[0], n[2]);
      return { p: [sx * ax, y, z], n: [n[0] / l, 0, n[2] / l] };
    }, color, part2);
  }
}

function plate(b: MeshBuilder, c: CarCtx, front: boolean, y: number): void {
  const w = 0.52, h = 0.112;
  const z = front ? c.frontZ(0, 0.014) : c.rearZ(0, 0.014);
  const dir = front ? -1 : 1;
  const sg = front ? -1 : 1; // зритель: «вправо» на номере = −X у переда, +X у кормы
  const quad = (u0: number, u1: number, y0: number, y1: number, color: number, dz = 0) => {
    const x0 = u0 * sg, x1 = u1 * sg;
    b.patch(1, 1, (u, v) => ({ p: [x0 + (x1 - x0) * u, y0 + (y1 - y0) * v, z + dir * dz], n: [0, 0, dir] }), color, PART.fixed);
  };
  quad(-w / 2 - 0.006, w / 2 + 0.006, y - h / 2 - 0.006, y + h / 2 + 0.006, 0x16171a);
  quad(-w / 2, w / 2, y - h / 2, y + h / 2, PLATE, 0.002);
  if (c.lod > 0) return;
  // регион справа: триколор и «RUS»
  const fa = w / 2 - 0.062, fb = w / 2 - 0.016;
  quad(fa, fb, y - 0.049, y - 0.034, 0xf4f4f4, 0.004);
  quad(fa, fb, y - 0.034, y - 0.019, 0x1f4aa8, 0.004);
  quad(fa, fb, y - 0.019, y - 0.004, 0xc8202a, 0.004);
  quad(fa, fb, y + 0.004, y + 0.02, 0x2a2c30, 0.004);
  quad(w / 2 - 0.082, w / 2 - 0.079, y - h / 2 + 0.004, y + h / 2 - 0.004, 0x16171a, 0.004);
  // «А 123 ВС»: блоки-глифы
  const gw = 0.036, gap = 0.015;
  for (let i = 0; i < 6; i++) {
    const off = i === 0 ? 0 : i < 4 ? i + 0.4 : i + 0.8;
    const cu = -w / 2 + 0.034 + off * (gw + gap);
    quad(cu - gw / 2, cu + gw / 2, y - 0.032, y + 0.034, 0x1c1d20, 0.004);
    quad(cu - gw / 2 + 0.009, cu + gw / 2 - 0.009, y - 0.016 + ((i * 7) % 3) * 0.004, y + 0.016, PLATE, 0.0055);
  }
}

/** Эллиптическое колёсное отверстие + закрылок на боку: диск в плоскости стенки и дуга-накладка. */
function arches(b: MeshBuilder, c: CarCtx, wheelsX: number[]): void {
  const s = c.s;
  const Ra = s.R + 0.05;
  for (const wx of wheelsX) {
    for (const sx of [-1, 1]) {
      const yc = s.R;
      const segs = 16;
      const cz = c.z(wx);
      const sxAt = (xx: number, y: number) => c.sideX(xx, Math.min(Math.max(y, c.yBot(xx) + 0.06), c.lowTop(xx) - 0.1));
      // арка: плоский тёмный диск (вершины на стенке, чуть наружу)
      b.patch(segs, 1, (u, v) => {
        const a = u * Math.PI * 2, r = Ra * v;
        const xx = wx + Math.cos(a) * r, y0 = yc + Math.sin(a) * r;
        const y = Math.max(y0, c.yBot(xx) + 0.035);
        return { p: [sx * (sxAt(xx, y) + 0.002), y, c.z(xx)], n: [sx, 0, 0] };
      }, 0x0b0b0c, PART.fixed);
      // закрылок: дуга шириной 0.04 над колесом
      if (s.kind !== 'paz' && s.kind !== 'liaz' && s.kind !== 'trolleybus') {
        b.patch(10, 1, (u, v) => {
          const a = -0.25 + u * (Math.PI + 0.5), r = Ra + 0.01 + 0.04 * v;
          const xx = wx + Math.cos(a) * r, y = yc + Math.sin(a) * r;
          const out = 0.006 + 0.012 * (1 - v);
          const nz = Math.cos(a), ny = Math.sin(a);
          return { p: [sx * (sxAt(xx, y) + out), y, c.z(xx)], n: [sx * 0.6, ny * 0.8, nz * 0.8] };
        }, c.paint(0.5), PART.paint);
      }
      void cz;
    }
  }
}

export function buildBody(s: BodySpec, lod: 0 | 1): BuiltCar {
  const c = makeCtx(s, lod);
  const b = new MeshBuilder();
  const white: RGB = [1, 1, 1];
  const black = lin(TRIM);
  const L = s.L;
  const nose = (k: number[]) => k.map((q) => s.rn * q), tail = (k: number[]) => k.map((q) => L - s.rt * q);
  const fine = lod === 0;

  // ---- нижняя часть кузова ----
  let xs = [...(fine ? nose([0, 0.03, 0.1, 0.2, 0.36, 0.58, 0.82, 1]) : nose([0, 0.2, 0.58, 1])), ...(fine ? tail([0, 0.03, 0.1, 0.2, 0.36, 0.58, 0.82, 1]) : tail([0, 0.2, 0.58, 1]))];
  for (const p of s.lowTop) xs.push(p[0]);
  for (const z of s.zones) { xs.push(z.x0); xs.push(z.x1); }
  xs = subdivide(uniq(xs.filter((x) => x >= 0 && x <= L)), fine ? 0.55 : 3);
  xs = uniq(xs, 0.012);
  const lowerRings: V3[][] = [], lowerIds: number[][] = [];
  const pick = fine ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : [0, 3, 4, 8];
  for (const x of xs) {
    const half = lowerRing(c, x);
    const sel = pick.map((i) => ({ p: half[i], id: i }));
    const m = mirrorRing(sel.map((q) => q.p), c.z(x));
    lowerRings.push(m.ring); lowerIds.push(m.ids.map((i) => sel[i].id));
  }
  const NL = lowerRings[0].length;
  const paintAt = (y: number) => c.paint(y);
  b.loft(xs.map((x) => c.z(x)), lowerRings, (i, k) => {
    const id = Math.min(lowerIds[i][k], lowerIds[i][k + 1]);
    if (id < 3) return { color: black, part: PART.fixed };
    return { color: white, part: PART.paint, colorAt: paintAt };
  });
  void NL;
  // торцы: низ (чёрный) и верх (лак)
  const capSplit = (ring: V3[], ids: number[], dir: -1 | 1) => {
    const lo: V3[] = [], hi: V3[] = [];
    ring.forEach((p, i) => { if (ids[i] <= 3) lo.push(p); if (ids[i] >= 3) hi.push(p); });
    // lo: левая 0..3 и правая 3..0 — порядок в кольце уже такой; hi: 3..8..3
    const loS = [...ring.filter((_, i) => ids[i] <= 3 && i < ring.length / 2), ...ring.filter((_, i) => ids[i] <= 3 && i >= ring.length / 2)];
    b.cap(loS, black, PART.fixed, dir);
    b.cap(hi, white, PART.paint, dir, paintAt);
    void lo;
  };
  capSplit(lowerRings[0], lowerIds[0], -1);
  capSplit(lowerRings[lowerRings.length - 1], lowerIds[lowerIds.length - 1], 1);

  // ---- остекление ----
  const xA0 = s.roof[0][0], xC1 = s.roof[s.roof.length - 1][0];
  let gx = [...s.roof.map((p) => p[0]), ...s.zones.map((z) => z.x0), ...s.zones.map((z) => z.x1)].filter((x) => x >= xA0 - 1e-6 && x <= xC1 + 1e-6);
  gx = uniq(gx, 0.012);
  gx = subdivide(gx, fine ? 0.4 : 3);
  gx = uniq(gx, 0.012);
  const gpick = fine ? [0, 1, 2, 3, 4, 5] : [0, 1, 3, 5];
  const gr: V3[][] = [], gids: number[][] = [];
  for (const x of gx) {
    const half = greenRing(c, x);
    const sel = gpick.map((i) => ({ p: half[i], id: i }));
    const m = mirrorRing(sel.map((q) => q.p), c.z(x));
    gr.push(m.ring); gids.push(m.ids.map((i) => sel[i].id));
  }
  const glassCol = lin(GLASS);
  b.loft(gx.map((x) => c.z(x)), gr, (i, k) => {
    const ids = gids[i];
    const sid = Math.min(ids[k], ids[k + 1]);
    const xm = (gx[i] + gx[i + 1]) / 2;
    const zt = zoneAt(s, xm);
    const glass = { color: glassCol, part: PART.glass };
    const pnt = { color: white, part: PART.paint, colorAt: paintAt };
    const hgt = Math.max(gr[i][0][1], 0) + 0; void hgt;
    if (zt === 'ws') return sid === 0 ? glass : sid <= 2 ? pnt : glass;
    if (zt === 'bl') return sid === 0 ? glass : sid <= 2 ? pnt : glass;
    if (zt === 'blsolid') return sid >= 3 ? glass : pnt;
    if (zt === 'win') return sid === 0 ? glass : pnt;
    if (zt === 'door') return sid === 0 ? glass : pnt;
    return pnt;
  });

  // ---- детали ----
  const hw0 = s.W / 2;
  const yFas = c.yFas, yTail = c.yTail;
  const wheelX = [s.fo, s.fo + s.wb];
  const R = s.R;
  if (fine) arches(b, c, wheelX);
  if (fine && s.mudflaps) {
    for (const wx of wheelX) for (const sx of [-1, 1]) b.box(sx * (c.sideX(wx + R + 0.06, 0.25) - 0.03), 0.2, c.z(wx + R + 0.05), 0.012, 0.2, 0.2, TRIM, PART.fixed);
  }
  // фары, поворотники, решётка (перёд)
  const hS = s.head, tS = s.tail;
  const hx0 = hw0 * hS.ax0, hx1 = hw0 * hS.ax1;
  const hTop = yFas + hS.dy;
  endPatch(b, c, true, hx0, hx1, hTop - hS.h0, hTop, hTop - hS.h1, hTop, LAMP_W, PART.head, 0.006, fine ? 5 : 2);
  endPatch(b, c, true, hx1 * 0.78, hx1 * 0.98, hTop - hS.h1 - 0.075, hTop - hS.h1 - 0.012, hTop - hS.h1 - 0.075, hTop - hS.h1 - 0.012, LAMP_A, PART.indL, 0.007, 2);
  if (s.grille) {
    const g = s.grille, gy1 = yFas + g.dy, gy0 = gy1 - g.h;
    if (g.frame != null && fine) endPatch(b, c, true, 0, hw0 * g.w + 0.012, gy0 - 0.012, gy1 + 0.012, gy0 - 0.012, gy1 + 0.012, g.frame, PART.chrome, 0.004, 3);
    endPatch(b, c, true, 0, hw0 * g.w, gy0, gy1, gy0, gy1, g.color, PART.fixed, 0.007, 3);
    if (g.lowerW && fine) {
      const ly = c.yBot(0) + s.band.nose * 0.35;
      endPatch(b, c, true, 0, hw0 * g.lowerW, ly, ly + s.band.nose * 0.45, ly, ly + s.band.nose * 0.45, 0x0a0a0b, PART.fixed, 0.006, 3);
    }
  }
  if (fine && s.fogLamps) endPatch(b, c, true, hw0 * 0.6, hw0 * 0.76, c.yBot(0) + 0.07, c.yBot(0) + 0.15, c.yBot(0) + 0.07, c.yBot(0) + 0.15, LAMP_W, PART.fixed, 0.006, 1);
  void 0;
  plate(b, c, true, Math.max(c.yBot(0) + 0.16, yFas - 0.27));
  // корма
  const tx0 = hw0 * tS.ax0, tx1 = hw0 * tS.ax1, tTop = yTail + tS.dy;
  endPatch(b, c, false, tx0, tx1, tTop - tS.h0, tTop, tTop - tS.h1, tTop, LAMP_R, PART.tail, 0.006, fine ? 5 : 2);
  endPatch(b, c, false, tx0, tx0 + (tx1 - tx0) * 0.3, tTop - tS.h0 - 0.06, tTop - tS.h0 - 0.012, tTop - tS.h0 - 0.06, tTop - tS.h0 - 0.012, LAMP_A, PART.indL, 0.007, 1);
  if (fine) endPatch(b, c, false, tx0 + (tx1 - tx0) * 0.35, tx0 + (tx1 - tx0) * 0.55, tTop - tS.h0 - 0.06, tTop - tS.h0 - 0.012, tTop - tS.h0 - 0.06, tTop - tS.h0 - 0.012, 0xe6e4dc, PART.fixed, 0.007, 1);
  plate(b, c, false, Math.max(c.yBot(L) + 0.2, yTail - 0.2 - (s.rear === 'gate' ? 0.04 : 0)));
  if (s.chromeBumpers) {
    for (const [x, d] of [[0.025, -1], [L - 0.025, 1]] as const) {
      const yb = c.yBot(x) + 0.17;
      b.box(0, yb, c.z(x) + d * 0.02, s.W * 0.96, 0.1, 0.07, CHROME, PART.chrome);
    }
  }
  if (fine) {
    // зеркала
    const mx = s.mirror?.x ?? s.roof[0][0] + 0.2, mw = s.mirror?.w ?? 0.2;
    const mbelt = c.lowTop(mx) + 0.1;
    for (const sx of [-1, 1]) {
      const xx = c.sideX(mx, c.lowTop(mx) - 0.12) + 0.1;
      b.box(sx * (xx - 0.07), mbelt - 0.03, c.z(mx), 0.14, 0.03, 0.04, TRIM, PART.fixed);
      b.box(sx * (xx + 0.015), mbelt + 0.03, c.z(mx) + 0.02, 0.1, 0.12, mw * 0.8, white, PART.paint);
      b.box(sx * (xx + 0.015), mbelt + 0.03, c.z(mx) + 0.02 + mw * 0.4 + 0.004, 0.09, 0.1, 0.012, 0x0c1013, PART.glass);
    }
    // швы дверей и ручки
    for (const x of s.seams) {
      for (const sx of [-1, 1]) {
        const y0 = c.yBot(x) + Math.max(s.band.side, 0.08) + 0.03, y1 = c.lowTop(x) - 0.04;
        const wx = c.sideX(x, (y0 + y1) / 2);
        b.patch(1, 1, (u, v) => ({ p: [sx * (wx + 0.003), y0 + (y1 - y0) * v, c.z(x) + (u - 0.5) * 0.012], n: [sx, 0, 0] }), 0x101113, PART.fixed);
      }
    }
    for (const x of s.handles) {
      for (const sx of [-1, 1]) {
        const y = c.lowTop(x) - 0.07;
        const wx = c.sideX(x, y);
        b.box(sx * (wx + 0.008), y, c.z(x), 0.02, 0.025, 0.13, CHROME, PART.chrome);
      }
    }
    if (s.rails) {
      const rx0 = s.roof[1][0] + 0.3, rx1 = s.roof[s.roof.length - 2][0] - 0.1;
      for (const sx of [-1, 1]) {
        const ry = c.roof(rx1) + 0.03, rw = c.hw((rx0 + rx1) / 2) * s.gw[2] - 0.01;
        b.box(sx * rw, ry, c.z((rx0 + rx1) / 2), 0.035, 0.035, rx1 - rx0, 0x2a2b2e, PART.fixed);
      }
    }
  } else {
    for (const sx of [-1, 1]) {
      const mx = s.mirror?.x ?? s.roof[0][0] + 0.2;
      b.box(sx * (c.hw(mx) + 0.05), c.lowTop(mx) + 0.1, c.z(mx), 0.1, 0.1, 0.16, white, PART.paint);
    }
  }
  s.extra?.(b, c);

  // ---- колёса (в LOD1 запекаются) ----
  const wx = hw0 - s.tw / 2 + 0.012;
  const wheels: [number, number, number][] = [[-wx, R, c.z(wheelX[0])], [wx, R, c.z(wheelX[0])], [-wx, R, c.z(wheelX[1])], [wx, R, c.z(wheelX[1])]];
  const body = b.build();
  return { near: body, far: body, wheels, wheelRadius: R, wheelWidth: s.tw, length: L, width: s.W, height: Math.max(...s.roof.map((p) => p[1])) };
}

/** Сливает колёса в геометрию кузова (для парковки и LOD1): левое — поворот на π вокруг Y. */
export function bakeWheels(body: THREE.BufferGeometry, built: Pick<BuiltCar, 'wheels' | 'wheelRadius' | 'wheelWidth'>, rim: RimStyle, lod: 0 | 1 | 2): THREE.BufferGeometry {
  const unit = buildWheelGeometry(rim, lod);
  const parts: THREE.BufferGeometry[] = [body];
  for (const [x, y, z] of built.wheels) {
    const w = unit.clone();
    w.scale(built.wheelWidth, built.wheelRadius, built.wheelRadius);
    if (x < 0) w.rotateY(Math.PI);
    w.translate(x, y, z);
    parts.push(w);
  }
  return mergeIndexed(parts);
}

export function mergeIndexed(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let nv = 0, ni = 0;
  for (const g of geos) { nv += g.getAttribute('position').count; ni += g.index!.count; }
  const names = ['position', 'normal', 'color', 'aPart', 'uv'];
  const sizes = [3, 3, 3, 1, 2];
  const arrs = sizes.map((sz) => new Float32Array(nv * sz));
  const idx = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const g of geos) {
    names.forEach((n, k) => { const a = g.getAttribute(n); if (a) arrs[k].set(a.array as Float32Array, vo * sizes[k]); });
    const gi = g.index!.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += g.getAttribute('position').count; io += gi.length;
  }
  const out = new THREE.BufferGeometry();
  names.forEach((n, k) => out.setAttribute(n, new THREE.BufferAttribute(arrs[k], sizes[k])));
  out.setIndex(nv > 65535 ? new THREE.BufferAttribute(idx, 1) : new THREE.BufferAttribute(Uint16Array.from(idx), 1));
  out.computeBoundingSphere(); out.computeBoundingBox();
  return out;
}
