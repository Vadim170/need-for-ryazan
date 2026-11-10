import * as THREE from 'three';

/**
 * Накопитель геометрии процедурных машин: индексированная сетка с атрибутами position/normal/color/aPart/uv.
 * aPart — роль детали (PART): лак красится цветом инстанса, фары/фонари светятся по aLamp (traffic/models.ts: vehicleMaterial).
 */
export const PART = { paint: 0, fixed: 1, head: 2, tail: 3, indL: 4, indR: 5, glass: 6, sign: 7, beacon: 8, board: 9, chrome: 10 } as const;

export type RGB = [number, number, number];
const _cc = new Map<number, RGB>();
/** sRGB hex → линейный RGB (как THREE.Color). */
export function lin(hex: number): RGB {
  let c = _cc.get(hex);
  if (!c) { const t = new THREE.Color(hex); c = [t.r, t.g, t.b]; _cc.set(hex, c); }
  return c;
}

export type V3 = [number, number, number];

export class MeshBuilder {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; part: number[] = []; uv: number[] = []; idx: number[] = [];
  get vcount(): number { return this.pos.length / 3; }
  get tris(): number { return this.idx.length / 3; }

  vert(p: V3, n: V3, c: RGB, part: number, u = 0, v = 0): number {
    this.pos.push(p[0], p[1], p[2]); this.nrm.push(n[0], n[1], n[2]); this.col.push(c[0], c[1], c[2]); this.part.push(part); this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number): void { this.idx.push(a, b, c, a, c, d); }

  /** Ящик (центр, размеры), плоские нормали; rotY/rotX — поворот вокруг своего центра. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: number | RGB, part: number = PART.fixed, rotY = 0, rotX = 0): this {
    const c = typeof color === 'number' ? lin(color) : color;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(cx, cy, cz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, 0, 'YXZ')), new THREE.Vector3(1, 1, 1));
    const faces: [V3, V3, V3][] = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    ];
    const h = [sx / 2, sy / 2, sz / 2];
    const v = new THREE.Vector3(), nv = new THREE.Vector3();
    for (const [n, u, w] of faces) {
      const ids: number[] = [];
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        v.set(0, 0, 0);
        for (let i = 0; i < 3; i++) (v as unknown as Record<string, number>)[['x', 'y', 'z'][i]] = n[i] * h[i] + u[i] * a * h[i] + w[i] * b * h[i];
        v.applyMatrix4(m);
        nv.set(n[0], n[1], n[2]).transformDirection(m);
        ids.push(this.vert([v.x, v.y, v.z], [nv.x, nv.y, nv.z], c, part));
      }
      this.quad(ids[0], ids[1], ids[2], ids[3]);
    }
    return this;
  }

  /** Шестигранная труба от a до b радиуса r (штанги, стойки). */
  tube(a: V3, b: V3, r: number, color: number, part: number = PART.fixed, segs = 6): this {
    const c = lin(color);
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = d.length(); d.normalize();
    const u = new THREE.Vector3(0, 1, 0);
    if (Math.abs(d.y) > 0.95) u.set(1, 0, 0);
    const e1 = new THREE.Vector3().crossVectors(d, u).normalize();
    const e2 = new THREE.Vector3().crossVectors(d, e1).normalize();
    void len;
    const i0 = this.vcount;
    for (let s = 0; s < segs; s++) {
      const t = (s / segs) * Math.PI * 2, ct = Math.cos(t), st = Math.sin(t);
      const n: V3 = [e1.x * ct + e2.x * st, e1.y * ct + e2.y * st, e1.z * ct + e2.z * st];
      this.vert([a[0] + n[0] * r, a[1] + n[1] * r, a[2] + n[2] * r], n, c, part);
      this.vert([b[0] + n[0] * r, b[1] + n[1] * r, b[2] + n[2] * r], n, c, part);
    }
    for (let s = 0; s < segs; s++) {
      const s2 = (s + 1) % segs;
      this.quad(i0 + s * 2, i0 + s2 * 2, i0 + s2 * 2 + 1, i0 + s * 2 + 1);
    }
    return this;
  }

  /**
   * Параметрическая заплатка nu×nv: fn(u, v) → точка и нормаль (u, v ∈ [0,1]); порядок обхода выбирается так,
   * чтобы лицевая сторона смотрела по нормали. colorFn — цвет по (u, v) (иначе color).
   */
  patch(nu: number, nv: number, fn: (u: number, v: number) => { p: V3; n: V3 }, color: number | RGB, part: number, uvFn?: (u: number, v: number) => [number, number]): this {
    const c = typeof color === 'number' ? lin(color) : color;
    const i0 = this.vcount;
    const ps: V3[] = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const { p, n } = fn(i / nu, j / nv);
      ps.push(p);
      const t = uvFn ? uvFn(i / nu, j / nv) : [0, 0];
      this.vert(p, n, c, part, t[0], t[1]);
    }
    // ориентация по первой невырожденной ячейке
    let flip = false;
    search: for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const k0 = j * (nu + 1) + i;
      const a = new THREE.Vector3(...ps[k0]), b = new THREE.Vector3(...ps[k0 + 1]), d = new THREE.Vector3(...ps[k0 + nu + 1]);
      const g = new THREE.Vector3().crossVectors(b.sub(a), d.sub(a));
      if (g.lengthSq() < 1e-12) continue;
      const n0 = fn(i / nu, j / nv).n;
      flip = g.x * n0[0] + g.y * n0[1] + g.z * n0[2] < 0;
      break search;
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a0 = i0 + j * (nu + 1) + i, b0 = a0 + 1, d0 = a0 + nu + 1, c0 = d0 + 1;
      if (flip) this.quad(a0, d0, c0, b0); else this.quad(a0, b0, c0, d0);
    }
    return this;
  }

  /**
   * Лофт: станции zs[i] с кольцами rings[i] (точки одной длины, открытая ломаная «слева → через верх → вправо»).
   * tag(i, k) → {color, part} для ячейки между станциями i,i+1 и сегментом k (null — пропустить).
   * Нормали сглаженные по сетке; цвет/роль — по ячейкам (вершины дублируются).
   */
  loft(zs: number[], rings: V3[][], tag: (i: number, k: number) => { color: RGB; part: number; colorAt?: (y: number) => RGB } | null): void {
    const S = zs.length, N = rings[0].length;
    const nrm: V3[] = new Array(S * N);
    for (let i = 0; i < S * N; i++) nrm[i] = [0, 0, 0];
    const P = (i: number, k: number) => rings[i][k];
    const cell = (i: number, k: number): { n: V3; ids: number[] } => {
      const a = P(i, k), b = P(i, k + 1), c = P(i + 1, k + 1), d = P(i + 1, k);
      // n = (d−a) × (b−a)  (станция × кольцо)
      const e1: V3 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]], e2: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e3: V3 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]], e4: V3 = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
      const n1 = cross(e1, e2), n2 = cross([d[0] - b[0], d[1] - b[1], d[2] - b[2]], e3);
      void e4;
      return { n: [n1[0] + n2[0], n1[1] + n2[1], n1[2] + n2[2]], ids: [i * N + k, i * N + k + 1, (i + 1) * N + k + 1, (i + 1) * N + k] };
    };
    for (let i = 0; i < S - 1; i++) for (let k = 0; k < N - 1; k++) {
      const { n, ids } = cell(i, k);
      for (const id of ids) { nrm[id][0] += n[0]; nrm[id][1] += n[1]; nrm[id][2] += n[2]; }
    }
    for (const n of nrm) { const l = Math.hypot(n[0], n[1], n[2]) || 1; n[0] /= l; n[1] /= l; n[2] /= l; }
    for (let i = 0; i < S - 1; i++) for (let k = 0; k < N - 1; k++) {
      const t = tag(i, k);
      if (!t) continue;
      const ids = [[i, k], [i, k + 1], [i + 1, k + 1], [i + 1, k]].map(([si, sk]) => {
        const p = P(si, sk);
        const col = t.colorAt ? t.colorAt(p[1]) : t.color;
        return this.vert(p, nrm[si * N + sk], col, t.part);
      });
      this.tri(ids[0], ids[3], ids[1]);
      this.tri(ids[1], ids[3], ids[2]);
    }
  }

  /** Крышка кольца веером из центра; dir = −1 (нос, смотрит на −Z) или +1 (корма). */
  cap(ring: V3[], color: RGB, part: number, dir: -1 | 1, colorAt?: (y: number) => RGB): void {
    let cx = 0, cy = 0, cz = 0;
    for (const p of ring) { cx += p[0]; cy += p[1]; cz += p[2]; }
    cx /= ring.length; cy /= ring.length; cz /= ring.length;
    const n: V3 = [0, 0, dir];
    const ic = this.vert([cx, cy, cz], n, colorAt ? colorAt(cy) : color, part);
    const ids = ring.map((p) => this.vert(p, n, colorAt ? colorAt(p[1]) : color, part));
    for (let k = 0; k < ring.length; k++) {
      const k2 = (k + 1) % ring.length;
      if (dir < 0) this.tri(ic, ids[k], ids[k2]); else this.tri(ic, ids[k2], ids[k]);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.vcount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function cross(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

/** Монотонная кубическая интерполяция (Fritsch–Carlson) по точкам [x, y], x возрастает. */
export function pchip(pts: [number, number][]): (x: number) => number {
  const n = pts.length;
  const h: number[] = [], d: number[] = [], m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { h.push(pts[i + 1][0] - pts[i][0]); d.push((pts[i + 1][1] - pts[i][1]) / (h[i] || 1e-9)); }
  if (n === 1) return () => pts[0][1];
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x: number) => {
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[n - 1][0]) return pts[n - 1][1];
    let i = 0;
    while (x > pts[i + 1][0]) i++;
    const t = (x - pts[i][0]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * pts[i][1] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * pts[i + 1][1] + (t3 - t2) * h[i] * m[i + 1];
  };
}
