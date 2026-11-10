import { PART, type RGB, MeshBuilder, lin, type V3 } from './mesh';
import type { BodySpec, CarCtx, LampStyle, VehicleKind, Zone } from './body';
import type { RimStyle } from './wheels';

/**
 * Пресеты машин с реальными габаритами (L×W×H, база, свес, радиус колеса), состав — по Рязани
 * (панорамы Яндекса: Гранта/Веста/Приора/2114/Калина, Солярис/Рио/Поло/Логан, Ларгус, Нива, кроссоверы; белый/серебро/серый/чёрный).
 * Форма — шаблонами силуэтов (sedan / liftback / hatch / wagon / suv / van / bus), параметры — доли длины и высоты.
 */

type Style = 'sedan' | 'liftback' | 'hatch' | 'wagon' | 'suv';
interface P {
  id: string; name: string; kind: VehicleKind; style: Style;
  L: number; W: number; H: number; wb: number; fo: number; R: number; tw?: number; clear?: number;
  weight: number; parkedWeight?: number; mass?: number; rim?: RimStyle; dirt?: number;
  over?: Partial<BodySpec> & { xA0?: number; xA1?: number; xC0?: number; xC1?: number; belt?: number; fas?: number };
}

const HEAD_RECT: LampStyle = { ax0: 0.42, ax1: 0.93, h0: 0.12, h1: 0.14, dy: -0.025 };
const HEAD_SLIM: LampStyle = { ax0: 0.36, ax1: 0.95, h0: 0.075, h1: 0.1, dy: -0.04 };
const HEAD_BIG: LampStyle = { ax0: 0.5, ax1: 0.93, h0: 0.15, h1: 0.15, dy: -0.02 };
const TAIL_DECK: LampStyle = { ax0: 0.58, ax1: 0.97, h0: 0.11, h1: 0.14, dy: -0.04 };
const TAIL_TALL: LampStyle = { ax0: 0.76, ax1: 0.98, h0: 0.2, h1: 0.26, dy: -0.04 };
const TAIL_WIDE: LampStyle = { ax0: 0.62, ax1: 0.98, h0: 0.12, h1: 0.12, dy: -0.04 };
export const LAMPS = { HEAD_RECT, HEAD_SLIM, HEAD_BIG, TAIL_DECK, TAIL_TALL, TAIL_WIDE };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function carSpec(p: P): BodySpec {
  const { L, H } = p;
  const o = p.over ?? {};
  const st = p.style;
  const T = {
    sedan: { xA0: 0.335, xA1: 0.52, xC0: 0.675, xC1: 0.815, belt: 0.635, fas: 0.52, tail: 0.585 },
    liftback: { xA0: 0.335, xA1: 0.52, xC0: 0.68, xC1: 0.93, belt: 0.635, fas: 0.52, tail: 0.61 },
    hatch: { xA0: 0.30, xA1: 0.47, xC0: 0.80, xC1: 0.965, belt: 0.635, fas: 0.52, tail: 0.65 },
    wagon: { xA0: 0.31, xA1: 0.47, xC0: 0.89, xC1: 0.975, belt: 0.635, fas: 0.52, tail: 0.67 },
    suv: { xA0: 0.30, xA1: 0.44, xC0: 0.86, xC1: 0.975, belt: 0.61, fas: 0.52, tail: 0.67 },
  }[st];
  const xA0 = (o.xA0 ?? T.xA0) * L, xA1 = (o.xA1 ?? T.xA1) * L, xC0 = (o.xC0 ?? T.xC0) * L, xC1 = (o.xC1 ?? T.xC1) * L;
  const belt = (o.belt ?? T.belt) * H, fas = (o.fas ?? T.fas) * H;
  const sedanLike = st === 'sedan';
  const tail = T.tail * H;
  const lowTop: [number, number][] = [
    [0, fas], [0.035 * L, fas + 0.04 * H], [0.14 * L, lerp(fas, belt, 0.55)], [xA0, belt], [xC1, belt],
  ];
  if (sedanLike) lowTop.push([xC1 + 0.07 * L, belt - 0.025 * H], [L - 0.03 * L, tail + 0.015 * H], [L, tail]);
  else lowTop.push([L - 0.02 * L, lerp(belt, tail, 0.6)], [L, tail]);
  const roofY = H - 0.004;
  const roof: [number, number][] = [
    [xA0, belt], [xA0 + 0.5 * (xA1 - xA0), lerp(belt, roofY, 0.6)], [xA1, roofY - 0.035], [xA1 + 0.4 * (xC0 - xA1), roofY],
    [xC0, roofY - (sedanLike || st === 'liftback' ? 0.09 : 0.045)],
    [xC0 + 0.5 * (xC1 - xC0), lerp(belt, roofY, st === 'sedan' ? 0.36 : st === 'liftback' ? 0.5 : 0.6)], [xC1, belt],
  ];
  const xB = lerp(xA1, xC0, st === 'sedan' || st === 'liftback' ? 0.5 : 0.46);
  const zones: Zone[] = [
    { x0: xA0, x1: xA1, t: 'ws' }, { x0: xA1, x1: xB - 0.05, t: 'win' }, { x0: xB - 0.05, x1: xB + 0.05, t: 'solid' },
    { x0: xB + 0.05, x1: xC0, t: 'win' },
    { x0: xC0, x1: xC1, t: st === 'liftback' ? 'blsolid' : 'bl' },
  ];
  const boxy = st === 'suv';
  const spec: BodySpec = {
    id: p.id, name: p.name, kind: p.kind, L, W: p.W, H, wb: p.wb, fo: p.fo, R: p.R, tw: p.tw ?? 0.185, clear: p.clear ?? (boxy ? 0.2 : 0.16),
    lowTop, roof, zones, rn: boxy ? 0.5 : 0.62, rt: boxy ? 0.4 : 0.5, fN: boxy ? 0.78 : 0.7, fT: boxy ? 0.82 : 0.74,
    gw: boxy ? [0.95, 0.93, 0.84, 0.76] : [0.93, 0.9, 0.8, 0.7],
    band: { side: boxy ? 0.09 : 0.075, nose: boxy ? 0.21 : 0.19, tail: boxy ? 0.2 : 0.17 },
    crown: 0.016, shoulder: boxy ? 0.1 : 0.13,
    rim: p.rim ?? 'steelcap', head: HEAD_RECT, tail: st === 'sedan' || st === 'liftback' ? TAIL_DECK : TAIL_TALL,
    grille: { w: 0.34, h: 0.1, dy: -0.07, color: 0x0e0e10, frame: 0xb4b8bc, lowerW: 0.62 },
    rear: st === 'sedan' ? 'deck' : 'gate',
    seams: [xA0 + 0.1, xB - 0.06, xB + 0.06, xC1 - 0.12], handles: [xB - 0.4, xB + 0.4],
    mirror: { x: xA0 + 0.18, w: 0.2 },
    dirt: p.dirt ?? 0.55, weight: p.weight, parkedWeight: p.parkedWeight ?? 0, mass: p.mass ?? (boxy ? 1500 : 1150),
  };
  const { xA0: _a, xA1: _b, xC0: _c, xC1: _d, belt: _e, fas: _f, ...rest } = o;
  void _a; void _b; void _c; void _d; void _e; void _f;
  return Object.assign(spec, rest);
}

// ---------- ливреи / доп. детали

const GLASS = 0x1d2630;

function sideStripe(b: MeshBuilder, c: CarCtx, x0: number, x1: number, y0: number, y1: number, color: number, part: number = PART.fixed, lift = 0.004): void {
  for (const sx of [-1, 1]) {
    b.patch(Math.max(2, Math.round((x1 - x0) / 0.5)), 1, (u, v) => {
      const x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * v;
      return { p: [sx * (c.sideX(x, y) + lift), y, c.z(x)], n: [sx, 0, 0] };
    }, color, part);
  }
}

function checker(b: MeshBuilder, c: CarCtx): void {
  const s = c.s, x0 = s.roof[0][0] + 0.45, x1 = s.roof[s.roof.length - 1][0] - 0.45;
  const y = c.lowTop((x0 + x1) / 2) - 0.19, q = 0.07;
  const n = Math.floor((x1 - x0) / q);
  for (const sx of [-1, 1]) for (let i = 0; i < n; i++) for (let r = 0; r < 2; r++) {
    if ((i + r) % 2) continue;
    const xa = x0 + i * q, ya = y + r * q;
    b.patch(1, 1, (u, v) => ({ p: [sx * (c.sideX(xa + u * q, ya + v * q) + 0.004), ya + v * q, c.z(xa + u * q)], n: [sx, 0, 0] }), 0x0e0e0f, PART.fixed);
  }
}

function roofSign(b: MeshBuilder, c: CarCtx): void {
  const xm = (c.s.roof[2][0] + c.s.roof[4][0]) / 2, y = c.roof(xm);
  b.box(0, y + 0.09, c.z(xm), 0.6, 0.15, 0.22, 0xf2d22a, PART.sign);
  b.box(0, y + 0.015, c.z(xm), 0.56, 0.03, 0.2, 0x111111, PART.fixed);
  // «шашечки»: чёрные квадраты на торцах знака
  for (const dz of [-1, 1]) for (let i = 0; i < 5; i++) if (i % 2 === 0) b.box(-0.2 + i * 0.1, y + 0.09, c.z(xm) + dz * 0.111, 0.07, 0.08, 0.004, 0x151515, PART.fixed);
}

function lightBar(b: MeshBuilder, c: CarCtx, blueRed = true): void {
  const xm = (c.s.roof[2][0] + c.s.roof[4][0]) / 2, y = c.roof(xm);
  b.box(0, y + 0.02, c.z(xm), 1.1, 0.03, 0.26, 0x1b1c1e, PART.fixed);
  b.box(-0.27, y + 0.075, c.z(xm), 0.5, 0.075, 0.22, blueRed ? 0x2050ff : 0xff3020, PART.beacon);
  b.box(0.27, y + 0.075, c.z(xm), 0.5, 0.075, 0.22, 0xff2020, PART.beacon);
}

/** ДПС: белый кузов, синяя полоса вдоль дверей, красная нижняя линия, капот — синий «шеврон»-полоса. */
function policeLivery(b: MeshBuilder, c: CarCtx): void {
  const s = c.s, x0 = s.roof[0][0] - 0.2, x1 = s.roof[s.roof.length - 1][0] - 0.1;
  const yb = c.yBot(x0) + Math.max(s.band.side, 0.075);
  sideStripe(b, c, x0, x1, yb + 0.08, yb + 0.27, 0x1d3f9a);
  sideStripe(b, c, x0, x1, yb + 0.27, yb + 0.3, 0xc8202a);
  sideStripe(b, c, x0 + 0.4, x1 - 0.5, c.lowTop(x0 + 1) - 0.2, c.lowTop(x0 + 1) - 0.12, 0x1d3f9a);
  lightBar(b, c);
}

// ---------- таблица легковых

const sedans: P[] = [
  { id: 'granta_sedan', name: 'Lada Granta', kind: 'sedan', style: 'sedan', L: 4.268, W: 1.7, H: 1.5, wb: 2.476, fo: 0.9, R: 0.292, weight: 22, parkedWeight: 14, rim: 'steelcap',
    over: { mudflaps: true, dirt: 0.6 } },
  { id: 'granta_liftback', name: 'Lada Granta Liftback', kind: 'sedan', style: 'liftback', L: 4.268, W: 1.7, H: 1.5, wb: 2.476, fo: 0.9, R: 0.292, weight: 10, parkedWeight: 6, rim: 'alloy5',
    over: { mudflaps: true } },
  { id: 'vesta_sedan', name: 'Lada Vesta', kind: 'sedan', style: 'sedan', L: 4.41, W: 1.764, H: 1.497, wb: 2.635, fo: 0.9, R: 0.31, weight: 14, parkedWeight: 10, rim: 'alloy5',
    over: { head: HEAD_SLIM, mudflaps: true, belt: 0.645, grille: { w: 0.4, h: 0.07, dy: -0.07, color: 0x111113, frame: 0xb4b8bc, lowerW: 0.7 } } },
  { id: 'priora_sedan', name: 'Lada Priora', kind: 'sedan', style: 'sedan', L: 4.35, W: 1.68, H: 1.42, wb: 2.492, fo: 0.9, R: 0.29, weight: 12, parkedWeight: 8, rim: 'steel', dirt: 0.8,
    over: { mudflaps: true, head: { ax0: 0.45, ax1: 0.94, h0: 0.11, h1: 0.15, dy: -0.025 } } },
  { id: 'vaz2107', name: 'ВАЗ-2107', kind: 'sedan', style: 'sedan', L: 4.145, W: 1.62, H: 1.44, wb: 2.424, fo: 0.82, R: 0.29, weight: 5, parkedWeight: 6, rim: 'steel', dirt: 1,
    over: { chromeBumpers: true, belt: 0.64, xA0: 0.345, xA1: 0.5, xC0: 0.72, xC1: 0.8, rn: 0.32, rt: 0.3, fN: 0.82, fT: 0.84, gw: [0.95, 0.93, 0.87, 0.8],
      band: { side: 0.05, nose: 0.1, tail: 0.1 }, head: { ax0: 0.52, ax1: 0.93, h0: 0.15, h1: 0.15, dy: -0.03 }, tail: { ax0: 0.58, ax1: 0.97, h0: 0.13, h1: 0.16, dy: -0.05 },
      grille: { w: 0.31, h: 0.09, dy: -0.06, color: 0x16171a, frame: 0xc4c7cb }, shoulder: 0.1, mass: 1050 } },
  { id: 'logan', name: 'Renault Logan', kind: 'sedan', style: 'sedan', L: 4.346, W: 1.733, H: 1.517, wb: 2.634, fo: 0.82, R: 0.31, weight: 8, parkedWeight: 6, rim: 'steelcap',
    over: { head: HEAD_BIG, mudflaps: false } },
  { id: 'solaris_sedan', name: 'Hyundai Solaris', kind: 'sedan', style: 'sedan', L: 4.405, W: 1.7, H: 1.47, wb: 2.57, fo: 0.85, R: 0.31, weight: 13, parkedWeight: 9, rim: 'alloy10',
    over: { head: HEAD_SLIM, xA0: 0.34, xC0: 0.67, xC1: 0.83 } },
  { id: 'rio_sedan', name: 'Kia Rio', kind: 'sedan', style: 'sedan', L: 4.4, W: 1.74, H: 1.47, wb: 2.6, fo: 0.86, R: 0.31, weight: 12, parkedWeight: 9, rim: 'turbine',
    over: { head: HEAD_SLIM, xA0: 0.34, xC0: 0.67, xC1: 0.83, grille: { w: 0.36, h: 0.075, dy: -0.07, color: 0x0e0e10, frame: 0x8e9298, lowerW: 0.66 } } },
  { id: 'polo_sedan', name: 'Volkswagen Polo', kind: 'sedan', style: 'liftback', L: 4.39, W: 1.699, H: 1.469, wb: 2.552, fo: 0.86, R: 0.31, weight: 9, parkedWeight: 6, rim: 'alloy5',
    over: { head: HEAD_SLIM, xC1: 0.88 } },
  { id: 'camry', name: 'Toyota Camry', kind: 'sedan', style: 'sedan', L: 4.885, W: 1.84, H: 1.445, wb: 2.825, fo: 0.96, R: 0.33, tw: 0.215, weight: 5, parkedWeight: 3, rim: 'alloy10', mass: 1550,
    over: { head: HEAD_SLIM, xA0: 0.37, xA1: 0.56, xC0: 0.67, xC1: 0.82, grille: { w: 0.44, h: 0.075, dy: -0.07, color: 0x0e0e10, frame: 0xb4b8bc, lowerW: 0.74 } } },
  { id: 'octavia', name: 'Škoda Octavia', kind: 'sedan', style: 'liftback', L: 4.689, W: 1.814, H: 1.452, wb: 2.686, fo: 0.92, R: 0.32, tw: 0.205, weight: 5, parkedWeight: 4, rim: 'alloy5', mass: 1350,
    over: { head: HEAD_SLIM, xC1: 0.93 } },
];

const hatches: P[] = [
  { id: 'vaz2114', name: 'ВАЗ-2114', kind: 'hatch', style: 'hatch', L: 4.122, W: 1.65, H: 1.5, wb: 2.46, fo: 0.78, R: 0.29, weight: 14, parkedWeight: 12, rim: 'steel', dirt: 1,
    over: { mudflaps: true, belt: 0.64, xA0: 0.32, xA1: 0.5, xC0: 0.79, xC1: 0.96, head: { ax0: 0.5, ax1: 0.93, h0: 0.12, h1: 0.14, dy: -0.03 }, mass: 1050 } },
  { id: 'kalina_hatch', name: 'Lada Kalina', kind: 'hatch', style: 'hatch', L: 3.893, W: 1.7, H: 1.5, wb: 2.476, fo: 0.78, R: 0.29, weight: 14, parkedWeight: 10, rim: 'steelcap', dirt: 0.8,
    over: { mudflaps: true, xA0: 0.31, xA1: 0.49, xC0: 0.8 } },
  { id: 'solaris_hatch', name: 'Hyundai Solaris Hatch', kind: 'hatch', style: 'hatch', L: 4.12, W: 1.7, H: 1.47, wb: 2.57, fo: 0.82, R: 0.31, weight: 8, parkedWeight: 6, rim: 'alloy10', over: { head: HEAD_SLIM } },
  { id: 'rio_hatch', name: 'Kia Rio Hatch', kind: 'hatch', style: 'hatch', L: 4.065, W: 1.725, H: 1.455, wb: 2.58, fo: 0.82, R: 0.31, weight: 8, parkedWeight: 6, rim: 'turbine', over: { head: HEAD_SLIM } },
  { id: 'xray', name: 'Lada XRAY', kind: 'hatch', style: 'hatch', L: 4.165, W: 1.764, H: 1.57, wb: 2.592, fo: 0.82, R: 0.32, weight: 7, parkedWeight: 4, rim: 'alloy5', clear: 0.19,
    over: { head: HEAD_SLIM, belt: 0.62, mudflaps: true } },
  { id: 'sandero', name: 'Renault Sandero', kind: 'hatch', style: 'hatch', L: 4.06, W: 1.745, H: 1.52, wb: 2.59, fo: 0.8, R: 0.31, weight: 5, parkedWeight: 3, rim: 'steelcap', over: { head: HEAD_BIG } },
];

const wagons: P[] = [
  { id: 'largus', name: 'Lada Largus', kind: 'wagon', style: 'wagon', L: 4.47, W: 1.75, H: 1.65, wb: 2.905, fo: 0.82, R: 0.31, tw: 0.2, weight: 14, parkedWeight: 9, rim: 'steelcap', clear: 0.17,
    over: { belt: 0.61, mudflaps: true, rails: true, mass: 1350, tail: { ax0: 0.84, ax1: 0.985, h0: 0.32, h1: 0.36, dy: -0.03 } } },
  { id: 'priora_wagon', name: 'Lada Priora Wagon', kind: 'wagon', style: 'wagon', L: 4.28, W: 1.68, H: 1.5, wb: 2.492, fo: 0.9, R: 0.29, weight: 8, parkedWeight: 5, rim: 'steel', dirt: 0.8, over: { mudflaps: true } },
  { id: 'kalina_wagon', name: 'Lada Kalina Wagon', kind: 'wagon', style: 'wagon', L: 4.04, W: 1.7, H: 1.5, wb: 2.476, fo: 0.78, R: 0.29, weight: 6, parkedWeight: 4, rim: 'steelcap', over: { mudflaps: true } },
  { id: 'vesta_sw', name: 'Lada Vesta SW', kind: 'wagon', style: 'wagon', L: 4.41, W: 1.764, H: 1.52, wb: 2.635, fo: 0.9, R: 0.31, weight: 7, parkedWeight: 5, rim: 'alloy5', over: { head: HEAD_SLIM, rails: true, mudflaps: true } },
  { id: 'octavia_wagon', name: 'Škoda Octavia Combi', kind: 'wagon', style: 'wagon', L: 4.68, W: 1.814, H: 1.47, wb: 2.686, fo: 0.92, R: 0.32, tw: 0.205, weight: 4, parkedWeight: 3, rim: 'alloy5', mass: 1400, over: { head: HEAD_SLIM, rails: true } },
];

const suvs: P[] = [
  { id: 'duster', name: 'Renault Duster', kind: 'suv', style: 'suv', L: 4.315, W: 1.822, H: 1.695, wb: 2.673, fo: 0.88, R: 0.34, tw: 0.215, weight: 14, parkedWeight: 8, rim: 'steelcap', over: { rails: true, head: HEAD_RECT } },
  { id: 'creta', name: 'Hyundai Creta', kind: 'suv', style: 'suv', L: 4.27, W: 1.78, H: 1.63, wb: 2.59, fo: 0.87, R: 0.335, tw: 0.215, weight: 14, parkedWeight: 8, rim: 'alloy5', over: { rails: true, head: HEAD_SLIM, belt: 0.62 } },
  { id: 'niva_2121', name: 'Lada Niva', kind: 'suv', style: 'suv', L: 3.74, W: 1.68, H: 1.64, wb: 2.2, fo: 0.7, R: 0.34, tw: 0.18, weight: 8, parkedWeight: 7, rim: 'steel', dirt: 1,
    over: { mass: 1210, belt: 0.59, xA0: 0.3, xA1: 0.44, xC0: 0.85, xC1: 0.97, rn: 0.3, rt: 0.28, fN: 0.85, fT: 0.86, chromeBumpers: false, head: { ax0: 0.45, ax1: 0.93, h0: 0.14, h1: 0.14, dy: -0.02 }, shoulder: 0.08, clear: 0.22 } },
  { id: 'chevy_niva', name: 'Chevrolet Niva', kind: 'suv', style: 'suv', L: 4.056, W: 1.8, H: 1.652, wb: 2.45, fo: 0.75, R: 0.34, tw: 0.2, weight: 9, parkedWeight: 6, rim: 'steelcap', dirt: 0.9,
    over: { rails: true, mass: 1400, belt: 0.6 } },
  { id: 'patriot', name: 'УАЗ Патриот', kind: 'suv', style: 'suv', L: 4.75, W: 1.9, H: 1.91, wb: 2.76, fo: 0.9, R: 0.37, tw: 0.225, weight: 6, parkedWeight: 3, rim: 'alloy5', clear: 0.21, mass: 2100,
    over: { rails: true, belt: 0.57, xA0: 0.3, xA1: 0.43, head: HEAD_BIG, band: { side: 0.12, nose: 0.25, tail: 0.22 }, rn: 0.38 } },
];

const taxis: P[] = [
  { id: 'taxi_granta', name: 'Такси (Granta)', kind: 'taxi', style: 'sedan', L: 4.268, W: 1.7, H: 1.5, wb: 2.476, fo: 0.9, R: 0.292, weight: 3, rim: 'steelcap', over: { mudflaps: true, fixedPaint: 0xf2c218, extra: (b, c) => { roofSign(b, c); checker(b, c); } } },
  { id: 'taxi_solaris', name: 'Такси (Solaris)', kind: 'taxi', style: 'sedan', L: 4.405, W: 1.7, H: 1.47, wb: 2.57, fo: 0.85, R: 0.31, weight: 3, rim: 'steelcap', over: { head: HEAD_SLIM, fixedPaint: 0xf2c218, extra: (b, c) => { roofSign(b, c); checker(b, c); } } },
  { id: 'taxi_logan', name: 'Такси (Logan)', kind: 'taxi', style: 'sedan', L: 4.346, W: 1.733, H: 1.517, wb: 2.634, fo: 0.82, R: 0.31, weight: 2, rim: 'steelcap', over: { head: HEAD_BIG, fixedPaint: 0xf2c218, extra: (b, c) => { roofSign(b, c); checker(b, c); } } },
  { id: 'taxi_camry', name: 'Такси (Camry)', kind: 'taxi', style: 'sedan', L: 4.885, W: 1.84, H: 1.445, wb: 2.825, fo: 0.96, R: 0.33, tw: 0.215, weight: 1, rim: 'alloy10', mass: 1550,
    over: { head: HEAD_SLIM, xA0: 0.37, xA1: 0.56, xC0: 0.67, xC1: 0.82, fixedPaint: 0xf2c218, extra: (b, c) => { roofSign(b, c); checker(b, c); } } },
];

const police: P[] = [
  { id: 'police_granta', name: 'ДПС (Granta)', kind: 'police', style: 'sedan', L: 4.268, W: 1.7, H: 1.5, wb: 2.476, fo: 0.9, R: 0.292, weight: 3, rim: 'steelcap', over: { mudflaps: true, fixedPaint: 0xf4f4f4, extra: policeLivery } },
  { id: 'police_vesta', name: 'ДПС (Vesta)', kind: 'police', style: 'sedan', L: 4.41, W: 1.764, H: 1.497, wb: 2.635, fo: 0.9, R: 0.31, weight: 3, rim: 'alloy5', over: { head: HEAD_SLIM, belt: 0.645, fixedPaint: 0xf4f4f4, extra: policeLivery } },
  { id: 'police_rio', name: 'ДПС (Kia Rio)', kind: 'police', style: 'sedan', L: 4.4, W: 1.74, H: 1.47, wb: 2.6, fo: 0.86, R: 0.31, weight: 2, rim: 'steelcap', over: { head: HEAD_SLIM, xA0: 0.34, xC0: 0.67, xC1: 0.83, fixedPaint: 0xf4f4f4, extra: policeLivery } },
  { id: 'police_camry', name: 'ДПС (Camry)', kind: 'police', style: 'sedan', L: 4.885, W: 1.84, H: 1.445, wb: 2.825, fo: 0.96, R: 0.33, tw: 0.215, weight: 1, rim: 'alloy10', mass: 1550,
    over: { head: HEAD_SLIM, xA0: 0.37, xA1: 0.56, xC0: 0.67, xC1: 0.82, fixedPaint: 0xf4f4f4, extra: policeLivery } },
];

export const CAR_PRESETS: BodySpec[] = [...sedans, ...hatches, ...wagons, ...suvs, ...taxis, ...police].map(carSpec);

// ---------- ГАЗель, автобусы, троллейбусы

function vanZones(xA0: number, xA1: number, windows: [number, number][], tailX: [number, number], tailType: Zone['t']): Zone[] {
  const z: Zone[] = [{ x0: xA0, x1: xA1, t: 'ws' }];
  for (const [a, b] of windows) z.push({ x0: a, x1: b, t: 'win' });
  z.push({ x0: tailX[0], x1: tailX[1], t: tailType });
  return z;
}

/** Номерной щиток (плоская заплатка с UV под атлас номеров маршрутов). */
function boardPatch(b: MeshBuilder, pos: (u: number, v: number) => V3, n: V3, bg: number): void {
  b.patch(1, 1, (u, v) => ({ p: pos(u, v), n }), bg, PART.board, (u, v) => [u, v]);
}

function gazelleSpec(id: string, name: string, v: 'bus' | 'cargo' | 'ambulance', weight: number): BodySpec {
  const L = 6.0, W = 2.09, H = v === 'bus' ? 2.45 : 2.4, fo = 1.0, wb = 3.4;
  const belt = 1.25, xA0 = 1.12, xA1 = 1.62, xC0 = L - 0.18, xC1 = L - 0.03;
  const lowTop: [number, number][] = [[0, 0.98], [0.1, 1.04], [0.5, 1.15], [xA0, belt], [xC1, belt], [L, belt - 0.05]];
  const roofY = H - 0.004;
  const roof: [number, number][] = [[xA0, belt], [xA0 + 0.25, 1.62], [xA1, roofY - 0.05], [xA1 + 0.2, roofY], [xC0, roofY], [xC1 - 0.1, roofY - 0.4], [xC1, belt]];
  const windows: [number, number][] = v === 'bus'
    ? [[xA1, 2.38], [2.5, 3.65], [3.75, 4.85], [4.95, 5.7]]
    : [[xA1, 2.38]];
  const zones = vanZones(xA0, xA1, windows, v === 'bus' ? [5.7, xC1] : [2.38, xC1], v === 'bus' ? 'bl' : 'blsolid');
  if (v !== 'bus') zones.push({ x0: 2.38, x1: xC1, t: 'solid' });
  const extra = (b: MeshBuilder, c: CarCtx) => {
    const s = c.s;
    if (v === 'bus') {
      // номер маршрута: плакат в лобовом справа (для пассажира) и на правом борту у двери
      const xw = 1.12 + 0.25, yw = c.roof(xw) + 0.0;
      const slope = (c.roof(xw + 0.1) - c.roof(xw - 0.1)) / 0.2;
      const nrm: V3 = [0, 1, -slope]; const nl = Math.hypot(nrm[1], nrm[2]); nrm[1] /= nl; nrm[2] = -slope / nl; nrm[2] = -Math.abs(nrm[2]); nrm[1] = Math.abs(nrm[1]);
      void yw;
      boardPatch(b, (u, v2) => {
        const x = xw + 0.0 + v2 * 0.08, xl = 0.1 + (1 - u) * 0.5; // +X — правый борт машины (пассажир)
        return [xl, c.roof(x) + 0.003, c.z(x) - 0.008];
      }, [0, 0.6, -0.8], 0xf4e8a0);
      const zb = c.z(3.1);
      boardPatch(b, (u, v2) => [c.sideX(3.1, 1.6) + 0.006, 1.58 + v2 * 0.2, zb + (0.5 - u) * 0.7], [1, 0, 0], 0xf4e8a0);
      sideStripe(b, c, 1.0, L - 0.3, 0.62, 0.78, 0x2a6fb8);
    }
    if (v === 'ambulance') {
      sideStripe(b, c, 0.6, L - 0.2, 0.95, 1.18, 0xc8202a);
      sideStripe(b, c, 0.6, L - 0.2, 1.18, 1.22, 0x1d3f9a);
      b.box(0, H + 0.04, c.z(1.9), 1.2, 0.07, 0.24, 0x1b1c1e, PART.fixed);
      b.box(-0.3, H + 0.1, c.z(1.9), 0.5, 0.07, 0.2, 0x2050ff, PART.beacon);
      b.box(0.3, H + 0.1, c.z(1.9), 0.5, 0.07, 0.2, 0x2050ff, PART.beacon);
      for (const sx of [-1, 1]) b.box(sx * (c.sideX(3.6, 1.7) + 0.004), 1.75, c.z(3.6), 0.006, 0.4, 0.14, 0xc8202a, PART.fixed), b.box(sx * (c.sideX(3.6, 1.7) + 0.004), 1.75, c.z(3.6), 0.007, 0.14, 0.4, 0xc8202a, PART.fixed);
    }
    if (v === 'cargo') sideStripe(b, c, 0.9, L - 0.1, 0.72, 0.8, 0x2a2c30);
    void s;
  };
  return {
    id, name, kind: 'gazelle', L, W, H, wb, fo, R: 0.36, tw: 0.225, clear: 0.24, lowTop, roof, zones,
    rn: 0.55, rt: 0.35, fN: 0.8, fT: 0.9, gw: [0.985, 0.975, 0.93, 0.88],
    band: { side: 0.11, nose: 0.25, tail: 0.22 }, crown: 0.012, shoulder: 0.13,
    rim: 'steel', head: { ax0: 0.5, ax1: 0.94, h0: 0.14, h1: 0.14, dy: -0.04 }, tail: { ax0: 0.9, ax1: 0.985, h0: 0.45, h1: 0.45, dy: -0.12 },
    grille: { w: 0.4, h: 0.12, dy: -0.06, color: 0x101113, frame: 0xb4b8bc, lowerW: 0.7 },
    rear: 'gate', seams: [xA0 + 0.1, 2.38, 2.42], handles: [2.1], mirror: { x: 1.18, w: 0.28 }, dirt: 0.5,
    weight, parkedWeight: 0, mass: 3200, fixedPaint: v === 'ambulance' ? 0xf2f2ee : undefined, extra,
    farGroup: 'gazelle_' + v, mudflaps: false,
  };
}

function busZones(L: number, doors: [number, number][], pillars: number[]): Zone[] {
  const zs: Zone[] = [{ x0: 0, x1: 0.25, t: 'ws' }];
  const cuts = [...doors.flatMap(([a, b]) => [a, b]), ...pillars].sort((a, b) => a - b);
  void cuts;
  let x = 0.25;
  const items: { x0: number; x1: number; t: Zone['t'] }[] = [];
  for (const [a, b] of doors) items.push({ x0: a, x1: b, t: 'door' });
  items.sort((p, q) => p.x0 - q.x0);
  const gaps: [number, number][] = [];
  for (const it of items) { if (it.x0 > x) gaps.push([x, it.x0]); x = it.x1; }
  gaps.push([x, L - 0.25]);
  const all = [...items.map((i) => ({ ...i })), ...gaps.map(([a, b]) => ({ x0: a, x1: b, t: 'win' as Zone['t'] }))].sort((p, q) => p.x0 - q.x0);
  for (const it of all) {
    if (it.t === 'win' && it.x1 - it.x0 > 1.5) {
      // стойки через ~1.3 м
      const n = Math.round((it.x1 - it.x0) / 1.4);
      const w = (it.x1 - it.x0) / n;
      for (let i = 0; i < n; i++) {
        const a = it.x0 + i * w, bb = a + w;
        zs.push({ x0: a + (i ? 0.05 : 0), x1: bb - 0.05, t: 'win' }, { x0: bb - 0.05, x1: bb + 0.05, t: 'solid' });
      }
      zs.pop();
    } else zs.push(it);
  }
  zs.push({ x0: L - 0.25, x1: L, t: 'bl' });
  // убрать пересечения: сортируем и подрезаем
  zs.sort((p, q) => p.x0 - q.x0);
  const out: Zone[] = [];
  for (const z of zs) { const prev = out[out.length - 1]; if (prev && z.x0 < prev.x1) z.x0 = prev.x1; if (z.x1 > z.x0) out.push(z); }
  return out;
}

function busSpec(o: { id: string; name: string; kind: 'paz' | 'liaz' | 'trolleybus'; L: number; W: number; H: number; wb: number; fo: number; R: number; tw: number;
  belt: number; doors: [number, number][]; mass: number; weight: number; stripe: number; poles?: boolean; hood?: boolean; yBot?: number; farGroup?: string }): BodySpec {
  const { L, H, belt } = o;
  let lowTop: [number, number][], roof: [number, number][], zones: Zone[], xA0: number;
  if (o.hood) {
    // ПАЗ-3205: капот
    xA0 = 1.45;
    lowTop = [[0, 1.0], [0.08, 1.08], [0.9, 1.2], [xA0, belt], [L - 0.1, belt], [L, belt - 0.05]];
    roof = [[xA0, belt], [xA0 + 0.1, belt + 0.8], [xA0 + 0.22, H - 0.12], [xA0 + 0.5, H - 0.02], [xA0 + 0.9, H], [L - 0.5, H], [L - 0.2, H - 0.12], [L - 0.1, belt + 0.6], [L - 0.1, belt]];
    zones = [{ x0: xA0, x1: xA0 + 0.3, t: 'ws' }];
    const doorsX = o.doors;
    let x = xA0 + 0.3;
    for (const [a, bb] of doorsX) { if (a > x) zones.push({ x0: x, x1: a, t: 'win' }); zones.push({ x0: a, x1: bb, t: 'door' }); x = bb; }
    zones.push({ x0: x, x1: L - 0.6, t: 'win' }, { x0: L - 0.6, x1: L - 0.1, t: 'win' });
  } else {
    xA0 = 0;
    lowTop = [[0, belt - 0.05], [0.1, belt], [L - 0.1, belt], [L, belt - 0.05]];
    roof = [[0, belt - 0.05], [0.06, belt + 0.6], [0.14, H - 0.7], [0.25, H - 0.2], [0.55, H - 0.02], [1.0, H], [L - 1.0, H], [L - 0.55, H - 0.02], [L - 0.25, H - 0.2], [L - 0.12, H - 0.7], [L - 0.06, belt + 0.6], [L, belt]];
    zones = busZones(L, o.doors, []);
  }
  const extra = (b: MeshBuilder, c: CarCtx) => {
    // ливрея: полоса под окнами
    sideStripe(b, c, 0.4, L - 0.4, belt - 0.32, belt - 0.12, o.stripe);
    // маршрутоуказатель: спереди над лобовым, справа у двери, сзади
    const front = (u: number, v: number): V3 => {
      const y = H - 0.42 + v * 0.26;
      let x = 0;
      while (x < 1 && c.roof(x) < y) x += 0.004; // точка лобового стекла на высоте y
      return [(0.5 - u) * 1.5, y, c.z(x) - 0.012];
    };
    boardPatch(b, o.hood ? (u, v) => { const x = 1.45 + 0.14 + v * 0.18; return [(0.5 - u) * 0.75, c.roof(x) + 0.004, c.z(x) - 0.01]; } : front, [0, o.hood ? 0.6 : 0, o.hood ? -0.8 : -1], 0x0d0d0f);
    const sx = c.sideX(o.hood ? 2.6 : 2.4, belt + 0.6);
    boardPatch(b, (u, v) => [sx + 0.008, belt + 0.35 + v * 0.3, c.z(o.hood ? 3.0 : 2.6) + (0.5 - u) * 0.8], [1, 0, 0], 0x0d0d0f);
    // правый борт: двери — тёмные створки и швы
    for (const [a, bb] of o.doors) {
      for (const xx of [a, (a + bb) / 2, bb]) b.patch(1, 1, (u, v) => ({ p: [c.sideX(xx, belt - 0.2) + 0.004, 0.55 + (belt + 1.4 - 0.55) * v, c.z(xx) + (u - 0.5) * 0.014], n: [1, 0, 0] }), 0x0b0c0d, PART.fixed);
    }
    if (o.poles) {
      const xm = L * 0.4;
      b.box(0, H + 0.16, c.z(xm), 1.5, 0.32, 3.6, 0x8a8f94, PART.fixed);
      b.box(0, H + 0.3, c.z(xm), 1.2, 0.04, 3.2, 0x5f6368, PART.fixed);
      const a: V3 = [0, H + 0.35, c.z(L * 0.55)];
      const len = 5.4, ang = 0.33;
      for (const sx2 of [-1, 1]) {
        const tip: V3 = [sx2 * 0.55, H + 0.35 + Math.sin(ang) * len, a[2] + Math.cos(ang) * len];
        b.tube([sx2 * 0.32, H + 0.35, a[2]], tip, 0.035, 0x1a1a1a, PART.fixed, 5);
        b.box(sx2 * 0.55, tip[1], tip[2] + 0.03, 0.12, 0.06, 0.2, 0x151515, PART.fixed);
      }
    }
  };
  return {
    id: o.id, name: o.name, kind: o.kind, L, W: o.W, H, wb: o.wb, fo: o.fo, R: o.R, tw: o.tw, clear: o.yBot ?? 0.3, lowTop, roof, zones,
    rn: 0.3, rt: 0.32, fN: o.hood ? 0.8 : 0.9, fT: 0.9, gw: [0.99, 0.985, 0.95, 0.9],
    band: { side: 0.2, nose: 0.3, tail: 0.3 }, crown: 0.03, shoulder: 0.2,
    rim: 'bus', head: { ax0: 0.5, ax1: 0.94, h0: 0.17, h1: 0.17, dy: -0.07 }, tail: { ax0: 0.84, ax1: 0.98, h0: 0.36, h1: 0.36, dy: -0.1 },
    grille: o.hood ? { w: 0.4, h: 0.22, dy: -0.12, color: 0x101113, frame: 0xb4b8bc } : undefined,
    rear: 'gate', seams: [], handles: [], mirror: { x: o.hood ? 1.55 : 0.35, w: 0.3 }, dirt: 0.5,
    weight: o.weight, parkedWeight: 0, mass: o.mass, doorsX: o.doors, extra, farGroup: o.farGroup,
  };
}

export const GAZELLE_PRESETS: BodySpec[] = [
  gazelleSpec('gazelle_next_bus', 'ГАЗель Next (маршрутка)', 'bus', 6),
  gazelleSpec('gazelle_cargo', 'ГАЗель (фургон)', 'cargo', 3),
  gazelleSpec('gazelle_ambulance', 'ГАЗель (скорая)', 'ambulance', 1),
];

export const BUS_PRESETS: BodySpec[] = [
  busSpec({ id: 'paz3205', name: 'ПАЗ-3205', kind: 'paz', L: 7.0, W: 2.44, H: 2.95, wb: 3.6, fo: 1.15, R: 0.45, tw: 0.26, belt: 1.35, doors: [[2.4, 3.2], [5.0, 5.8]], mass: 7000, weight: 1, stripe: 0x3a3a3a, hood: true, yBot: 0.34 }),
  busSpec({ id: 'liaz5292', name: 'ЛиАЗ-5292', kind: 'liaz', L: 11.9, W: 2.5, H: 3.0, wb: 5.9, fo: 2.6, R: 0.5, tw: 0.3, belt: 1.05, doors: [[0.75, 1.85], [5.4, 6.5], [8.6, 9.7]], mass: 11000, weight: 1, stripe: 0x3a7f4a }),
  busSpec({ id: 'trolza5265', name: 'Тролза-5265 «Мегаполис»', kind: 'trolleybus', L: 12.0, W: 2.55, H: 3.45, wb: 5.9, fo: 2.6, R: 0.5, tw: 0.3, belt: 1.0, doors: [[0.8, 1.9], [5.7, 6.8], [8.4, 9.5]], mass: 12000, weight: 3, stripe: 0x1f5fb0, poles: true }),
  busSpec({ id: 'ziu682', name: 'ЗиУ-682', kind: 'trolleybus', L: 11.2, W: 2.5, H: 3.4, wb: 6.0, fo: 2.4, R: 0.5, tw: 0.3, belt: 1.05, doors: [[0.7, 1.7], [5.3, 6.3], [8.0, 9.0]], mass: 11000, weight: 1, stripe: 0x1f5fb0, poles: true }),
];

export const ALL_PRESETS: BodySpec[] = [...CAR_PRESETS, ...GAZELLE_PRESETS, ...BUS_PRESETS];
void lin; void ({} as RGB);
void GLASS;
