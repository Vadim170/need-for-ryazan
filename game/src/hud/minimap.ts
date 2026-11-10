import type * as THREE from 'three';
import type { RoadGraph } from '../world/city-world';

/** Ориентиры на радаре (координаты игры: x — восток, z — юг; Кремль — начало координат мира). */
export const LANDMARKS = [
  { letter: 'К', x: 0, z: 0 },        // Рязанский кремль
  { letter: 'Т', x: 484, z: 1615 },   // Театральная площадь
];

/** Классы дорог, у которых на радаре пишется название. */
const LABEL_CLASSES = new Set(['trunk', 'primary', 'secondary', 'tertiary']);

/** Сокращения для подписей: «улица Есенина» → «ул. Есенина». */
const ABBR: [string, string][] = [
  ['улица', 'ул.'], ['проспект', 'пр.'], ['шоссе', 'ш.'], ['проезд', 'пр-д'],
  ['бульвар', 'б-р'], ['площадь', 'пл.'], ['переулок', 'пер.'], ['набережная', 'наб.'],
];
// \b в JS не видит границы кириллических слов — ищем слово между пробелами/краями строки
const ABBR_RE = ABBR.map(([w, r]) => [new RegExp(`(^|\\s)${w}(?=\\s|$)`, 'i'), `$1${r}`] as const);
export const shortName = (n: string) => ABBR_RE.reduce((t, [re, r]) => t.replace(re, r), n);

/** Миникарта (canvas, правый верх): дороги из graph.json вокруг машины, «вперёд» вверх. Пространственная сетка + 15 Гц. */
export class Minimap {
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private cells = new Map<string, number[]>();
  private readonly CELL = 200;
  private readonly SIZE = 190;
  private readonly RANGE = 260; // метров от центра до края
  private acc = 0;
  /** Машины трафика (src/traffic): обход точек (x, z, крупная). */
  traffic: ((cb: (x: number, z: number, big: boolean) => void) => void) | null = null;
  /** Железная дорога (src/rail): ломаные путей (x, z подряд) и поезда (точки x, z от головы к хвосту). */
  rail: { lines: Float32Array[]; trains: (cb: (xz: number[]) => void) => void } | null = null;
  /** Метки GTA-режима (полиция и т.п.): cb(x, z, цвет, размер пикс; мигает — blink). За краем — у края радара. */
  blips: ((cb: (x: number, z: number, color: string, size: number, blink?: boolean) => void) => void) | null = null;
  private blinkT = 0;
  /** Путевая точка (карта мира, ПКМ): метка на радаре, за краем — у края. */
  waypoint: { x: number; z: number } | null = null;

  constructor(private graph: RoadGraph) {
    const c = this.canvas;
    c.width = c.height = this.SIZE;
    c.style.cssText = `position:fixed;right:12px;top:12px;width:${this.SIZE}px;height:${this.SIZE}px;border-radius:50%;` +
      'background:rgba(20,24,28,.72);border:2px solid rgba(255,255,255,.35);z-index:5;pointer-events:none';
    document.body.appendChild(c);
    this.g = c.getContext('2d')!;
    graph.edges.forEach((e, i) => {
      const seen = new Set<string>();
      for (const p of e.points) {
        const k = `${Math.floor(p[0] / this.CELL)},${Math.floor(p[2] / this.CELL)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(i);
      }
    });
  }

  update(dt: number, pos: THREE.Vector3, fwdX: number, fwdZ: number): void {
    this.acc += dt;
    if (this.acc < 1 / 15) return;
    this.acc = 0;
    const { g, SIZE, RANGE, CELL } = this;
    const s = SIZE / 2 / RANGE, half = SIZE / 2;
    const l = Math.hypot(fwdX, fwdZ) || 1, fx = fwdX / l, fz = fwdZ / l;
    g.clearRect(0, 0, SIZE, SIZE);
    g.save();
    g.beginPath(); g.arc(half, half, half - 1, 0, Math.PI * 2); g.clip();
    g.lineCap = 'round'; g.lineJoin = 'round';
    const tx = (x: number, z: number): [number, number] => {
      const dx = x - pos.x, dz = z - pos.z;
      return [half + (dx * -fz + dz * fx) * s, half - (dx * fx + dz * fz) * s];
    };
    const drawn = new Set<number>();
    const labels = new Map<string, { len: number; edge: number }>();
    const c0x = Math.floor((pos.x - RANGE) / CELL), c1x = Math.floor((pos.x + RANGE) / CELL);
    const c0z = Math.floor((pos.z - RANGE) / CELL), c1z = Math.floor((pos.z + RANGE) / CELL);
    // пути: тонкий штрих под дорогами
    if (this.rail) {
      g.strokeStyle = 'rgba(190,170,150,.8)'; g.lineWidth = 1.2; g.setLineDash([4, 3]);
      const R = RANGE + 60;
      for (const L of this.rail.lines) {
        let vis = false;
        for (let i = 0; i < L.length; i += 2) if (Math.abs(L[i] - pos.x) < R && Math.abs(L[i + 1] - pos.z) < R) { vis = true; break; }
        if (!vis) continue;
        g.beginPath();
        for (let i = 0; i < L.length; i += 2) { const [x, y] = tx(L[i], L[i + 1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
        g.stroke();
      }
      g.setLineDash([]);
    }
    g.strokeStyle = 'rgba(235,235,235,.85)';
    for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
      const list = this.cells.get(`${cx},${cz}`);
      if (!list) continue;
      for (const i of list) {
        if (drawn.has(i)) continue;
        drawn.add(i);
        const e = this.graph.edges[i];
        g.lineWidth = Math.max(1.2, (e.width ?? 8) * s * 0.9);
        g.beginPath();
        let len = 0, px0 = 0, py0 = 0;
        e.points.forEach((p, k) => {
          const [x, y] = tx(p[0], p[2]);
          if (k) { g.lineTo(x, y); len += Math.hypot(x - px0, y - py0); } else g.moveTo(x, y);
          px0 = x; py0 = y;
        });
        g.stroke();
        // кандидат на подпись: самое длинное видимое ребро главной улицы
        if (e.name && LABEL_CLASSES.has(e.highway ?? '')) {
          const best = labels.get(e.name);
          if (!best || len > best.len) labels.set(e.name, { len, edge: i });
        }
      }
    }
    this.drawLabels(labels, tx, half);
    // машины трафика
    if (this.traffic) {
      const R2 = RANGE * RANGE;
      this.traffic((x, z, big) => {
        const dx = x - pos.x, dz = z - pos.z;
        if (dx * dx + dz * dz > R2) return;
        const [px, py] = tx(x, z);
        g.fillStyle = big ? '#3fa9ff' : '#ffd23f';
        g.fillRect(px - (big ? 2 : 1.5), py - (big ? 2 : 1.5), big ? 4 : 3, big ? 4 : 3);
      });
    }
    // поезда: толстая линия по составу
    if (this.rail) {
      g.strokeStyle = '#ff7a2f'; g.lineWidth = 3.5;
      this.rail.trains((xz) => {
        g.beginPath();
        for (let i = 0; i < xz.length; i += 2) { const [x, y] = tx(xz[i], xz[i + 1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
        g.stroke();
      });
    }
    // ориентиры: буква в точке, а если она за пределами радара — у края по направлению
    for (const lm of LANDMARKS) {
      let [px, py] = tx(lm.x, lm.z);
      const dx = px - half, dy = py - half, d = Math.hypot(dx, dy), rMax = half - 11;
      if (d > rMax) { px = half + (dx / d) * rMax; py = half + (dy / d) * rMax; }
      g.fillStyle = 'rgba(20,24,28,.9)'; g.strokeStyle = '#ffd23f'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(px, py, 8, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#ffd23f'; g.font = 'bold 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(lm.letter, px, py + 0.5);
    }
    if (this.waypoint) {
      let [px, py] = tx(this.waypoint.x, this.waypoint.z);
      const dx = px - half, dy = py - half, d = Math.hypot(dx, dy), rMax = half - 9;
      if (d > rMax) { px = half + (dx / d) * rMax; py = half + (dy / d) * rMax; }
      g.fillStyle = '#35d6ff'; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(px, py - 7); g.lineTo(px + 6, py); g.lineTo(px, py + 7); g.lineTo(px - 6, py); g.closePath(); g.fill(); g.stroke();
    }
    // метки (полиция): красно-синие, за краем — у края
    if (this.blips) {
      this.blinkT += 1 / 15;
      this.blips((x, z, color, size, blink) => {
        let [px, py] = tx(x, z);
        const dx = px - half, dy = py - half, d = Math.hypot(dx, dy), rMax = half - 5;
        if (d > rMax) { px = half + (dx / d) * rMax; py = half + (dy / d) * rMax; }
        g.fillStyle = blink && Math.floor(this.blinkT * 4) % 2 ? '#3a6cff' : color;
        g.strokeStyle = 'rgba(0,0,0,.8)'; g.lineWidth = 1;
        g.beginPath(); g.arc(px, py, size, 0, Math.PI * 2); g.fill(); g.stroke();
      });
    }
    // стрелка машины
    g.fillStyle = '#ff5a3c'; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(half, half - 9); g.lineTo(half + 6, half + 7); g.lineTo(half, half + 3); g.lineTo(half - 6, half + 7); g.closePath();
    g.fill(); g.stroke();
    g.restore();
  }

  /** Мелкие подписи главных улиц вдоль ребра, текст всегда «головой вверх», без наложений. */
  private drawLabels(labels: Map<string, { len: number; edge: number }>, tx: (x: number, z: number) => [number, number], half: number): void {
    const { g } = this;
    g.font = '600 8px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = 2.5; g.strokeStyle = 'rgba(20,24,28,.95)'; g.fillStyle = 'rgba(255,255,255,.9)';
    const placed: [number, number][] = [];
    for (const [name, { len, edge }] of [...labels].sort((a, b) => b[1].len - a[1].len)) {
      const text = shortName(name);
      const w = g.measureText(text).width;
      if (len < w + 6) continue;
      const pts = this.graph.edges[edge].points;
      const m = Math.floor(pts.length / 2), a = pts[Math.max(m - 1, 0)], b = pts[Math.min(m + 1, pts.length - 1)];
      const [ax, ay] = tx(a[0], a[2]), [bx, by] = tx(b[0], b[2]);
      const cx = (ax + bx) / 2, cy = (ay + by) / 2;
      if (Math.hypot(cx - half, cy - half) > half - 14) continue; // у края круга не подписываем
      if (placed.some(([px, py]) => Math.hypot(px - cx, py - cy) < 22)) continue;
      placed.push([cx, cy]);
      let ang = Math.atan2(by - ay, bx - ax);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      g.save(); g.translate(cx, cy); g.rotate(ang);
      g.strokeText(text, 0, 0); g.fillText(text, 0, 0);
      g.restore();
    }
  }

  dispose(): void { this.canvas.remove(); }
}
