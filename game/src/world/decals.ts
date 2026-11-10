import * as THREE from 'three';

/**
 * Мелкие детали проезжей части — декали (один инстанс-пул на мир): люки, ливнёвки у бордюров, следы шин перед
 * перекрёстками, асфальтовые заплаты. Позиции процедурные (детерминированный хэш) вдоль рёбер дорожного графа
 * (roads/graph.json): ось, ширина, полосы. Декаль лежит на поверхности дороги (y из точек ребра) + сдвиг глубины.
 * aExt: (тип, размер X, размер Z, seed). Типы: 0 люк, 1 ливнёвка, 2 следы шин (пара полос), 3 заплата.
 */

export interface GraphEdge {
  id: number; width?: number; lanesForward?: number; lanesBackward?: number; highway?: string; bridge?: boolean; points: number[][];
}

const frac = (x: number) => x - Math.floor(x);
const hh = (a: number, b: number) => frac(Math.sin(a * 91.17 + b * 47.33) * 43758.5453);

export interface DecalOut { m: number[]; c: number[]; e: number[]; xz: number[] }

/** Декали рёбер, точки которых попадают в тайл [minX,maxX)×[minZ,maxZ). */
export function buildDecals(edges: GraphEdge[], b: { minX: number; minZ: number; maxX: number; maxZ: number }): DecalOut {
  const out: DecalOut = { m: [], c: [], e: [], xz: [] };
  const inTile = (x: number, z: number) => x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ;
  const put = (type: number, x: number, y: number, z: number, ang: number, sx: number, sz: number, seed: number) => {
    if (!inTile(x, z)) return;
    const c = Math.cos(ang), s = Math.sin(ang);
    // поворот вокруг Y: локальная Z → (sin, cos); масштаб sx по X, sz по Z
    out.m.push(c * sx, 0, -s * sx, 0, 0, 1, 0, 0, s * sz, 0, c * sz, 0, x, y + 0.012, z, 1);
    out.c.push(1, 1, 1);
    out.e.push(type, sx, sz, seed);
    out.xz.push(x, z);
  };
  for (const e of edges) {
    const P = e.points;
    if (!P || P.length < 2) continue;
    const W = e.width ?? 7;
    const lf = e.lanesForward ?? 1, lb = e.lanesBackward ?? 0, L = Math.max(1, lf + lb), lw = W / L;
    const service = e.highway === 'service' || e.highway === 'track' || e.highway === 'living_street';
    // длины
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][2] - P[i - 1][2]));
    const total = cum[cum.length - 1];
    if (total < 5) continue;
    const at = (s: number) => {
      let i = 1;
      while (i < P.length - 1 && cum[i] < s) i++;
      const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-6)));
      const a = P[i - 1], q = P[i];
      const dx = q[0] - a[0], dz = q[2] - a[2], l = Math.hypot(dx, dz) || 1;
      return { x: a[0] + dx * t, y: a[1] + (q[1] - a[1]) * t, z: a[2] + dz * t, dx: dx / l, dz: dz / l };
    };
    const right = (p: { dx: number; dz: number }) => ({ rx: -p.dz, rz: p.dx });
    const ang = (p: { dx: number; dz: number }) => Math.atan2(p.dx, p.dz);
    // люки
    for (let s = 8 + hh(e.id, 1) * 30, k = 0; s < total - 4; s += 45 + hh(e.id, k + 2) * 40, k++) {
      const p = at(s), { rx, rz } = right(p), off = (hh(e.id, k + 7) - 0.5) * W * 0.7;
      put(0, p.x + rx * off, p.y, p.z + rz * off, hh(e.id, k + 9) * 6.28, 0.78, 0.78, hh(e.id, k + 11));
    }
    // ливнёвки у обоих бордюров
    if (!service && W >= 6) {
      for (let s = 15 + hh(e.id, 3) * 15, k = 0; s < total - 5; s += 32 + hh(e.id, k + 4) * 12, k++) {
        const p = at(s), { rx, rz } = right(p);
        for (const side of [1, -1]) {
          const off = side * (W / 2 - 0.32);
          put(1, p.x + rx * off, p.y, p.z + rz * off, ang(p), 0.42, 0.9, hh(e.id, k + 13 * side));
        }
      }
    }
    // следы шин перед перекрёстками (по полосам, к концу ребра для прямого направления, к началу — для обратного)
    if (!service && total > 30) {
      for (let k = 0; k < lf; k++) {
        if (hh(e.id, 20 + k) > 0.65) continue;
        const len = 4 + hh(e.id, 30 + k) * 8, s = total - 4 - len / 2 - hh(e.id, 40 + k) * 10;
        const p = at(s), { rx, rz } = right(p), off = lb > 0 ? (k + 0.5) * lw : W / 2 - (k + 0.5) * lw;
        put(2, p.x + rx * off, p.y, p.z + rz * off, ang(p), 1.9, len, hh(e.id, 50 + k));
      }
      for (let k = 0; k < lb; k++) {
        if (hh(e.id, 60 + k) > 0.65) continue;
        const len = 4 + hh(e.id, 70 + k) * 8, s = 4 + len / 2 + hh(e.id, 80 + k) * 10;
        const p = at(s), { rx, rz } = right(p), off = -(k + 0.5) * lw;
        put(2, p.x + rx * off, p.y, p.z + rz * off, ang(p), 1.9, len, hh(e.id, 90 + k));
      }
    }
    // заплаты
    for (let s = 20 + hh(e.id, 5) * 40, k = 0; s < total - 3; s += 50 + hh(e.id, k + 6) * 60, k++) {
      if (hh(e.id, k + 100) > 0.5) continue;
      const p = at(s), { rx, rz } = right(p), off = (hh(e.id, k + 110) - 0.5) * W * 0.6;
      put(3, p.x + rx * off, p.y, p.z + rz * off, ang(p) + (hh(e.id, k + 120) - 0.5) * 0.3, 1.2 + hh(e.id, k + 130) * 2.5, 1.5 + hh(e.id, k + 140) * 3.5, hh(e.id, k + 150));
    }
  }
  return out;
}

/** Материал декалей: прозрачный, без записи глубины, со сдвигом глубины над дорогой (меньше, чем у разметки). */
export function decalMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, transparent: true, depthWrite: false });
  m.customProgramCacheKey = () => 'nfr-decal';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aExt; varying vec4 vDExt; varying vec2 vDUv; varying vec3 vDW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDExt = aExt; vDUv = uv; vDW = (instanceMatrix * vec4(position, 1.0)).xyz;')
      .replace('#include <project_vertex>', '#include <project_vertex>\ngl_Position.z -= 1.2e-6 * gl_Position.w;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec4 vDExt; varying vec2 vDUv; varying vec3 vDW;
        float dh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float dn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(dh(i), dh(i + vec2(1, 0)), f.x), mix(dh(i + vec2(0, 1)), dh(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float t = vDExt.x; vec2 q = vDUv - 0.5; vec2 m = q * vec2(vDExt.y, vDExt.z); // метры от центра
          float a = 1.0; vec3 c = vec3(0.1);
          if (t < 0.5) {                     // люк: чугунная крышка Ø 0.66 в обойме
            float r = length(m);
            if (r > 0.39) discard;
            float rim = smoothstep(0.33, 0.335, r);
            float ring = step(0.5, fract(r / 0.06)) * (1.0 - rim);
            float rib = step(0.5, fract((m.x + m.y) / 0.05)) * step(r, 0.28);
            c = mix(vec3(0.16, 0.15, 0.14), vec3(0.24, 0.23, 0.21), rim);
            c *= 0.85 + 0.2 * ring + 0.12 * rib + 0.15 * dn(m * 20.0);
            c = mix(c, vec3(0.32, 0.18, 0.08), smoothstep(0.6, 0.85, dn(m * 6.0 + vDExt.w * 9.0)) * 0.6); // ржавчина
          } else if (t < 1.5) {              // ливнёвка: решётка с прорезями в раме
            vec2 h = abs(m) / vec2(0.21, 0.45);
            float frame = step(0.82, max(h.x, h.y));
            float slot = step(0.5, fract(m.y / 0.06)) * (1.0 - frame);
            c = mix(vec3(0.2, 0.19, 0.18), vec3(0.03), slot);
            c *= 0.85 + 0.25 * dn(m * 25.0);
          } else if (t < 2.5) {              // следы шин: две полосы ~0.22 м на расстоянии 1.5 м, прерывистые
            float w = min(abs(m.x - 0.75), abs(m.x + 0.75));
            float s = 1.0 - smoothstep(0.07, 0.13, w);
            float along = vDUv.y;
            s *= smoothstep(0.0, 0.15, along) * smoothstep(1.0, 0.7, along) * (0.6 + 0.4 * dn(vec2(m.y * 1.5, vDExt.w * 30.0)));
            c = vec3(0.03); a = s * 0.55;
          } else {                           // заплата: свежий тёмный асфальт с рваным краем и швом
            vec2 h = abs(q) * 2.0;
            float edge = max(h.x, h.y) + (dn(vDW.xz * 1.5) - 0.5) * 0.18;
            if (edge > 1.0) discard;
            float seam = smoothstep(0.9, 0.97, edge);
            c = vec3(0.1, 0.105, 0.11) * (0.8 + 0.4 * dn(vDW.xz * 6.0));
            c = mix(c, vec3(0.04), seam * 0.8);
            a = 0.92;
          }
          diffuseColor.rgb = c; diffuseColor.a = a;
        }`);
  };
  return m;
}
