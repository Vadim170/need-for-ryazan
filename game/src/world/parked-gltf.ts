import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PART } from '../traffic/models';
import { allVariants, type VehicleVariant } from '../vehicles/procedural';
import { MeshBuilder } from '../vehicles/procedural/mesh';
import { ParkedBatch, type PoolLike } from './parked-batch';
import { bakeWheels } from '../vehicles/procedural/body';
import type { VehicleLibrary } from '../traffic/gltf-models';
import { applySurfaceWeather } from '../render/weather';

/**
 * Припаркованные машины из glTF (docs/stage2/models.md): модели с ролью 'parked' из game/public/assets/vehicles/vehicles.json
 * превращаются в виды пропсов car_<id> (Props.addParkedCarModels). Ближний LOD — кузов + 4 колеса одной геометрией,
 * дальний — LOD1 модели. Атрибут aFlag: 7 — лак (тонируется цветом инстанса, глянец), 8 — стекло, 0 — прочее.
 * Начало координат модели — на земле между осями, как у процедурной машины (Props.carMatrix ставит её на 4 колеса).
 */

export interface ParkedCarDef {
  key: string;
  near: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  material: THREE.Material;
  farMaterial: THREE.Material;
  /** Габарит: длина, ширина, высота. */
  dims: { length: number; width: number; height: number };
  /** Дальность ближнего LOD (м), по умолчанию 130. */
  nearDist?: number;
  /** Готовые пулы (BatchedMesh, parked-batch.ts) вместо InstancedMesh-пулов Props; objects — их меши (добавить в сцену). */
  pools?: { near: PoolLike; far: PoolLike };
  objects?: THREE.Object3D[];
  /** Доля в выборе вида для parked_car (нормируется по всем видам). */
  weight: number;
}

/** Доля одной glTF-модели среди машин парковки; все glTF вместе — не больше GLTF_MAX_SHARE (остальное — процедурные). */
const GLTF_SHARE = 0.12, GLTF_MAX_SHARE = 0.85;

function toPropGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv', 'color']) { const a = g.getAttribute(k); if (a) out.setAttribute(k, a); }
  out.index = g.index;
  const part = g.getAttribute('aPart');
  const flag = new Float32Array(part.count);
  for (let i = 0; i < part.count; i++) {
    const p = part.getX(i);
    flag[i] = p === PART.paint ? 7 : p === PART.glass ? 8 : 0;
  }
  out.setAttribute('aFlag', new THREE.Float32BufferAttribute(flag, 1));
  out.computeBoundingSphere();
  return out;
}

function parkedMaterial(map: THREE.Texture | null, envMap?: THREE.Texture | null, batched = false): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, map, vertexColors: true, roughness: 0.75, metalness: 0, envMap: envMap ?? null, envMapIntensity: 0.55 });
  if (map) map.colorSpace = THREE.SRGBColorSpace;
  m.customProgramCacheKey = () => (batched ? 'nfr-parked-batch' : 'nfr-parked-gltf');
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFlag; varying float vFlag;')
      .replace('#include <color_vertex>', `#include <color_vertex>
        vFlag = aFlag;
        vColor = vec4(color.rgb, 1.0);
        #ifdef USE_INSTANCING_COLOR
          if (aFlag > 6.5 && aFlag < 7.5) vColor.rgb *= instanceColor.rgb;
        #endif
        #ifdef USE_BATCHING_COLOR
          if (aFlag > 6.5 && aFlag < 7.5) vColor.rgb *= getBatchingColor(getIndirectIndex(gl_DrawID)).rgb;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFlag;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        if (vFlag > 6.5 && vFlag < 7.5) roughnessFactor = 0.32;
        else if (vFlag > 7.5) roughnessFactor = 0.06;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        if (vFlag > 6.5 && vFlag < 7.5) metalnessFactor = 0.3;
        else if (vFlag > 7.5) metalnessFactor = 0.2;`);
  };
  return applySurfaceWeather(m, 'prop'); // снег на крыше/капоте зимой, мокрый лак (render/weather.ts)
}

/**
 * Виды машин парковки: glTF-модели с ролью 'parked' (по GLTF_SHARE каждая) + процедурные кузова трафика
 * (седан/хэтчбек/универсал/внедорожник, src/traffic/models.ts) на остаток доли — чтобы одна модель не заполняла дворы.
 */
export function buildParkedCarDefs(lib: VehicleLibrary | null, envMap?: THREE.Texture | null): ParkedCarDef[] {
  const out = lib ? buildGltfDefs(lib, envMap) : [];
  const raw = out.reduce((a, d) => a + d.weight, 0);
  const share = Math.min(GLTF_MAX_SHARE, GLTF_SHARE * raw);
  for (const d of out) d.weight = (share * d.weight) / (raw || 1);
  const proc = buildProceduralDefs(envMap);
  for (const d of proc) d.weight *= 1 - share;
  return [...out, ...proc];
}

/** «Коробка» — импостор для дальней дистанции (~50 треугольников): кузов, кабина-стекло, крыша. */
function boxImpostor(v: VehicleVariant): THREE.BufferGeometry {
  const L = v.length, W = v.width, H = v.height, cz = (v.wheels[0][2] + v.wheels[2][2]) / 2;
  const sp = v.spec;
  const belt = sp.lowTop[3][1], y0 = sp.clear + 0.1;
  const a = sp.roof[0][0] - L / 2, bz = sp.roof[sp.roof.length - 1][0] - L / 2;
  void cz;
  const b = new MeshBuilder();
  b.box(0, (belt + y0) / 2, v.dz, W * 0.98, belt - y0, L * 0.98, [1, 1, 1], PART.paint);
  b.box(0, (H + belt) / 2 - 0.02, (a + bz) / 2 + v.dz, W * 0.84, H - belt - 0.02, (bz - a) * 0.92, 0x1d2630, PART.glass);
  b.box(0, H - 0.015, (a + bz) / 2 + v.dz, W * 0.82, 0.04, (bz - a) * 0.78, [1, 1, 1], PART.paint);
  b.box(0, 0.3, v.dz, W * 0.96, 0.3, L * 0.62, 0x151515, PART.fixed);
  return b.build();
}

/** Процедурные машины (src/vehicles/procedural) как пропсы на BatchedMesh: LOD0 (кузов + колёса LOD2 одной геометрией, до 55 м), LOD1, коробка. */
function buildProceduralDefs(envMap?: THREE.Texture | null): ParkedCarDef[] {
  const mat = parkedMaterial(null, envMap);
  const bmat = parkedMaterial(null, envMap, true);
  const vs = allVariants().filter((v) => v.parkedWeight > 0);
  const geos = vs.map((v) => ({
    near: toPropGeometry(bakeWheels(v.near, v, v.rim, 2)), far: toPropGeometry(v.far), box: toPropGeometry(boxImpostor(v)),
  }));
  const batch = new ParkedBatch(bmat, geos);
  const out: ParkedCarDef[] = vs.map((v, i) => ({
    key: 'car_p_' + v.id, near: geos[i].near, far: geos[i].far, material: mat, farMaterial: mat,
    dims: { length: v.length, width: v.width, height: v.height }, weight: v.parkedWeight, nearDist: 40,
    pools: { near: batch.near(i), far: batch.far(i) }, objects: i === 0 ? batch.objects : undefined,
  }));
  const tot = out.reduce((a, d) => a + d.weight, 0);
  for (const d of out) d.weight /= tot;
  return out;
}

function buildGltfDefs(lib: VehicleLibrary, envMap?: THREE.Texture | null): ParkedCarDef[] {
  const out: ParkedCarDef[] = [];
  for (const md of lib.withRole('parked')) {
    const parts: THREE.BufferGeometry[] = [md.body];
    if (md.wheel) {
      for (const [x, y, z] of md.wheels) {
        const w = md.wheel.clone();
        if (x < 0) w.rotateY(Math.PI);
        w.translate(x, y, z);
        parts.push(w);
      }
    }
    const merged = parts.length > 1 ? mergeGeometries(parts, false) : md.body;
    if (!merged) continue;
    out.push({
      key: 'car_' + md.entry.id,
      near: toPropGeometry(merged),
      far: toPropGeometry(md.far),
      material: parkedMaterial(md.map, envMap),
      farMaterial: parkedMaterial(md.farMap, envMap),
      dims: md.entry.dims,
      weight: md.entry.parkedWeight ?? 1,
    });
  }
  return out;
}
