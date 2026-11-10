import * as THREE from 'three';
import { cityUniforms } from './materials';

/**
 * Балконы зданий v2 (docs/world-format.md «Здания v2»): нода тайла `balconies` — glTF POINTS, одна точка на
 * вертикальную стопку балконов: POSITION (низ плиты первого балкона в плоскости фасада), _BAL (тип, rotY, этажей,
 * высота этажа), _BAL2 (ширина, вынос, доля застеклённых, seed 0..1). Здесь стопки разворачиваются в поэтажные
 * инстансы одного InstancedMesh на тайл (1 draw call), виден до DRAW_DIST м (THREE.LOD на тайл).
 *
 * Тип: 0 — открытый балкон (по этажам часть застеклена жильцами: доля из _BAL2.z), 1 — застеклённый, 2 — лоджия
 * (неглубокий выступ, остеклена или нет). Модель: локальная −Z — наружу от фасада, x — поперёк (ширина 1), y — м.
 */

const DRAW_DIST = 420;

let sharedMat: THREE.MeshStandardMaterial | null = null;
let baseGeo: THREE.BufferGeometry | null = null;

/** Коробка балкона: плита, фронт, бока, крыша (только у застеклённых). aTop: 0 — низ, 1 — верх ограждения/остекления, 2 — крыша. */
function makeBaseGeometry(): THREE.BufferGeometry {
  const P: number[] = [], N: number[] = [], T: number[] = [], K: number[] = [], I: number[] = [];
  // part: 0 плита, 1 ограждение/остекление
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], top: number[], part: number) => {
    const i0 = P.length / 3;
    for (const [v, t] of [[a, top[0]], [b, top[1]], [c, top[2]], [d, top[3]]] as [number[], number][]) { P.push(...v); N.push(...n); T.push(t); K.push(part); }
    I.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  };
  const s = 0.12; // толщина плиты
  // плита: верх, низ, торец, бока
  quad([-0.5, s, 0], [-0.5, s, -1], [0.5, s, -1], [0.5, s, 0], [0, 1, 0], [0, 0, 0, 0], 0);
  quad([-0.5, 0, 0], [0.5, 0, 0], [0.5, 0, -1], [-0.5, 0, -1], [0, -1, 0], [0, 0, 0, 0], 0);
  quad([-0.5, 0, -1], [0.5, 0, -1], [0.5, s, -1], [-0.5, s, -1], [0, 0, -1], [0, 0, 0, 0], 0);
  // фронт ограждения (y от плиты до верха)
  quad([-0.5, s, -1], [0.5, s, -1], [0.5, s, -1], [-0.5, s, -1], [0, 0, -1], [0, 0, 1, 1], 1);
  // бока
  quad([0.5, s, -1], [0.5, s, 0], [0.5, s, 0], [0.5, s, -1], [1, 0, 0], [0, 0, 1, 1], 1);
  quad([-0.5, s, 0], [-0.5, s, -1], [-0.5, s, -1], [-0.5, s, 0], [-1, 0, 0], [0, 0, 1, 1], 1);
  // крыша застеклённого (у открытых схлопывается)
  quad([-0.5, s, 0], [-0.5, s, -1], [0.5, s, -1], [0.5, s, 0], [0, 1, 0], [2, 2, 2, 2], 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('aTop', new THREE.Float32BufferAttribute(T, 1));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(K, 1));
  g.setIndex(I);
  return g;
}

function material(): THREE.MeshStandardMaterial {
  if (sharedMat) return sharedMat;
  // двусторонний: ограждение видно и изнутри балкона, порядок обхода граней не важен
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, side: THREE.DoubleSide });
  m.customProgramCacheKey = () => 'nfr-balcony';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNfrNight = cityUniforms.uNfrNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aTop; attribute float aPart; attribute vec4 aBal;
varying vec3 vBl; varying vec4 vBalI; varying float vBPart;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float glazed = step(0.5, aBal.x);            // 0 открытый, 1 застеклённый (тип 1 или лоджия с остеклением)
  float topH = mix(1.08, aBal.y - 0.15, glazed);
  if (aTop > 0.5 && aTop < 1.5) transformed.y = topH;
  if (aTop > 1.5) { transformed.y = topH; transformed.x *= glazed; transformed.z *= glazed; }
  vBl = vec3(transformed.x, transformed.y, -transformed.z);
  vBalI = aBal; vBPart = aPart;
}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vBl; varying vec4 vBalI; varying float vBPart; uniform float uNfrNight;
float blHash(float x) { return fract(sin(x * 91.3458) * 47453.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec3 blEm = vec3(0.0); float blRough = 0.8;
{
  float sd = vBalI.z;
  float glazed = step(0.5, vBalI.x);
  float h = blHash(sd * 113.0);
  vec3 c;
  if (vBPart < 0.5) {
    c = vec3(0.6, 0.59, 0.56) * (0.85 + 0.2 * blHash(sd * 7.0));      // бетонная плита
  } else {
    // ограждение: крашеный профлист/бетон/решётка; выше 1 м у застеклённых — рамы и стекло
    vec3 pc = h < 0.25 ? vec3(0.82, 0.8, 0.76) : h < 0.4 ? vec3(0.45, 0.55, 0.62) : h < 0.55 ? vec3(0.42, 0.5, 0.38)
            : h < 0.7 ? vec3(0.52, 0.36, 0.24) : h < 0.85 ? vec3(0.62, 0.62, 0.6) : vec3(0.7, 0.62, 0.45);
    float corr = 0.88 + 0.12 * sin(vBl.x * 60.0);
    c = pc * corr;
    if (glazed > 0.5 && vBl.y > 1.0) {
      float fx = abs(fract(vBl.x * 2.2) - 0.5);
      float frame = step(0.44, fx) + step(abs(vBl.y - 1.0), 0.05) + step(vBalI.y - 0.3, vBl.y);
      vec3 fr = h < 0.6 ? vec3(0.88, 0.88, 0.86) : vec3(0.35, 0.25, 0.18);
      vec3 gl = vec3(0.07, 0.08, 0.1) + vec3(0.25, 0.3, 0.36) * blHash(sd * 31.0) * 0.6;
      c = mix(gl, fr, clamp(frame, 0.0, 1.0));
      blRough = frame > 0.5 ? 0.6 : 0.1;
      float on = step(0.8, blHash(sd * 57.0));
      blEm = vec3(1.0, 0.75, 0.45) * on * (1.0 - clamp(frame, 0.0, 1.0)) * 0.6;
    }
  }
  diffuseColor.rgb = c;
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = blRough;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += blEm * uNfrNight;');
  };
  sharedMat = m;
  return m;
}

function hash(x: number): number { const s = Math.sin(x * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }

/** Разворачивает ноду `balconies` (THREE.Points из glTF) в LOD с InstancedMesh; null — если пусто. */
export function buildBalconies(node: THREE.Object3D): THREE.Object3D | null {
  let pts: THREE.Points | null = null;
  node.traverse((o) => { if ((o as THREE.Points).isPoints) pts = o as THREE.Points; });
  if (!pts) return null;
  const p = pts as THREE.Points;
  const g = p.geometry;
  const pos = g.getAttribute('position'), b1 = g.getAttribute('_bal'), b2 = g.getAttribute('_bal2');
  if (!pos || !b1 || !b2) { g.dispose(); return null; }
  let total = 0;
  for (let i = 0; i < pos.count; i++) total += Math.max(0, Math.round(b1.getZ(i)));
  if (!total) { g.dispose(); return null; }
  baseGeo ??= makeBaseGeometry();
  const geo = baseGeo.clone();
  const bal = new Float32Array(total * 4);
  const mesh = new THREE.InstancedMesh(geo, material(), total);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), v = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const box = new THREE.Box3();
  let k = 0;
  for (let i = 0; i < pos.count; i++) {
    const typ = Math.round(b1.getX(i)), rot = b1.getY(i), n = Math.round(b1.getZ(i)), fh = b1.getW(i);
    const w = b2.getX(i), d = b2.getY(i), share = b2.getZ(i), seed = b2.getW(i);
    q.setFromAxisAngle(up, rot);
    for (let f = 0; f < n; f++) {
      const hs = hash(seed * 1000 + f * 7.13);
      const glazed = typ === 1 ? 1 : (hs < share ? 1 : 0);
      v.set(pos.getX(i), pos.getY(i) + f * fh, pos.getZ(i));
      sc.set(w, 1, typ === 2 ? d : d * (0.95 + 0.1 * hash(seed + f)));
      m4.compose(v, q, sc);
      mesh.setMatrixAt(k, m4);
      bal[k * 4] = glazed; bal[k * 4 + 1] = fh; bal[k * 4 + 2] = typ === 0 ? hash(seed * 77 + f) : seed; bal[k * 4 + 3] = typ;
      box.expandByPoint(v);
      k++;
    }
  }
  geo.setAttribute('aBal', new THREE.InstancedBufferAttribute(bal, 4));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = 'balconies';
  g.dispose();
  (Array.isArray(p.material) ? p.material : [p.material]).forEach((mm) => mm.dispose());
  // выгрузка тайла диспоузит геометрию → освобождаем и буферы инстансов
  geo.addEventListener('dispose', () => mesh.dispose());
  const lod = new THREE.LOD();
  const c = box.getCenter(new THREE.Vector3());
  lod.position.copy(c);
  mesh.position.copy(c).negate();
  mesh.updateMatrix();
  lod.addLevel(mesh, 0);
  lod.addLevel(new THREE.Object3D(), DRAW_DIST);
  lod.name = 'balconies';
  lod.updateMatrixWorld(true);
  return lod;
}
