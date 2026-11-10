import * as THREE from 'three';
import { PART, allVariants, wheelGeometry, type VehicleKind, type VehicleVariant } from '../vehicles/procedural';

/**
 * Модели машин трафика: процедурный параметрический генератор src/vehicles/procedural/ (пресеты с реальными габаритами,
 * docs/stage3/procedural-cars.md). Этот модуль — контракт с трафиком/парковкой/GTA-режимом и общий материал.
 *
 * Контракт модели (чтобы фабрику можно было заменить загрузчиком glTF):
 * - система координат: вперёд −Z, вверх +Y, начало — центр габарита на земле (y = 0);
 * - атрибуты геометрии: position, normal, color (линейный RGB), aPart (float, см. PART), uv, индексная;
 *   части PART.paint красятся цветом инстанса (instanceColor), остальные — своим цветом вершин;
 *   фары/фонари/поворотники светятся по пер-инстансному атрибуту aLamp (см. vehicleMaterial);
 *   таблички маршрутов (PART.board) берут ячейку атласа по пер-инстансному aRoute;
 * - колёса — отдельные общие меши (единичное колесо вдоль X по стилю диска), позиции/радиус/ширина — в VehicleModel/variants.
 * VehicleModel — эталон вида (габариты для симуляции и физики); variants — все пресеты вида (кузов/колёса по вариантам).
 */

export { PART };
export type { VehicleKind, VehicleVariant };
export const KINDS: VehicleKind[] = ['sedan', 'hatch', 'wagon', 'suv', 'taxi', 'police', 'gazelle', 'paz', 'liaz', 'trolleybus'];

export interface VehicleModel {
  kind: VehicleKind;
  near: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  length: number; width: number; height: number;
  /** Позиции центров колёс (модельные координаты). */
  wheels: [number, number, number][];
  wheelRadius: number; wheelWidth: number;
  mass: number;
  /** Цвет кузова фиксирован (такси, ДПС) — иначе выбирает трафик. */
  fixedPaint?: number;
  /** Пресеты вида (первый — эталон: его габариты у модели). */
  variants: VehicleVariant[];
}

/** Колесо по умолчанию (совместимость). */
export function buildWheel(): THREE.BufferGeometry { return wheelGeometry('alloy5'); }

/** Фабрика моделей: эталон вида + варианты (генерация один раз, кеш в src/vehicles/procedural). */
export function buildVehicleModels(): Record<VehicleKind, VehicleModel> {
  const out = {} as Record<VehicleKind, VehicleModel>;
  const vs = allVariants();
  for (const k of KINDS) {
    const list = vs.filter((v) => v.kind === k);
    const r = list[0];
    out[k] = { kind: k, near: r.near, far: r.far, length: r.length, width: r.width, height: r.height, wheels: r.wheels, wheelRadius: r.wheelRadius,
      wheelWidth: r.wheelWidth, mass: r.mass, fixedPaint: r.fixedPaint, variants: list };
  }
  return out;
}

// ---------- атлас табличек маршрутов (PART.board)

const CELL_W = 128, CELL_H = 32, COLS = 8, ROWS = 8;
class RouteBoards {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  private cells = new Map<string, number>();
  private next = 1;
  constructor() {
    this.canvas.width = CELL_W * COLS; this.canvas.height = CELL_H * ROWS;
    const g = this.canvas.getContext('2d')!;
    g.fillStyle = '#0b0b0d'; g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.anisotropy = 4;
  }
  /** Ячейка для (тип маршрута, номер). Бус/троллейбус — янтарное табло, маршрутка — белая табличка с чёрным номером. */
  cell(type: string, ref: string): number {
    const key = type + '|' + ref;
    let c = this.cells.get(key);
    if (c !== undefined) return c;
    if (this.next >= COLS * ROWS) return 0;
    c = this.next++;
    this.cells.set(key, c);
    const g = this.canvas.getContext('2d')!;
    const x = (c % COLS) * CELL_W, y = Math.floor(c / COLS) * CELL_H;
    const led = type !== 'share_taxi';
    g.fillStyle = led ? '#0b0b0d' : '#f1ecd2'; g.fillRect(x, y, CELL_W, CELL_H);
    g.fillStyle = led ? '#ffb020' : '#161616';
    g.font = (led ? '600 ' : '700 ') + (ref.length > 3 ? 22 : 26) + 'px Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(ref, x + CELL_W / 2, y + CELL_H / 2 + 1);
    if (led) { g.fillStyle = 'rgba(0,0,0,0.35)'; for (let i = 0; i < CELL_H; i += 3) g.fillRect(x, y + i, CELL_W, 1); }
    this.texture.needsUpdate = true;
    return c;
  }
}
export const routeBoards = new RouteBoards();

/** Общий материал трафика: окраска по instanceColor только для PART.paint, свечение фар по aLamp. */
export const trafficUniforms = { uTime: { value: 0 }, uNight: { value: 0 } };

/** lampTex — для BatchedMesh (src/vehicles/procedural/batch.ts): пер-экземплярные (фары, стоп, поворотник, ячейка таблички) по instanceId. */
export function vehicleMaterial(envMap?: THREE.Texture | null, lampTex?: THREE.DataTexture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.1, envMap: envMap ?? null, envMapIntensity: 0.6 });
  m.customProgramCacheKey = () => (lampTex ? 'nfr-traffic-veh-b' : 'nfr-traffic-veh');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = trafficUniforms.uTime;
    sh.uniforms.uNight = trafficUniforms.uNight;
    sh.uniforms.uBoards = { value: routeBoards.texture };
    if (lampTex) sh.uniforms.uLampTex = { value: lampTex };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aPart;
        attribute float aRoute;
        #ifdef USE_INSTANCING
          attribute vec3 aLamp;
        #endif
        uniform float uTime; uniform float uNight;
        #ifdef USE_BATCHING
          uniform highp sampler2D uLampTex;
        #endif
        varying vec3 vEmis; varying float vRough; varying float vMetal; varying vec3 vBoard;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        vColor.rgb = color.rgb;
        #ifdef USE_INSTANCING_COLOR
          if (aPart < 0.5) vColor.rgb *= instanceColor.rgb;
        #endif
        vec3 lamp = vec3(0.0);
        float routeCell = aRoute;
        #ifdef USE_INSTANCING
          lamp = aLamp;
        #endif
        #ifdef USE_BATCHING
          float bid = getIndirectIndex(gl_DrawID);
          vec4 ld = texelFetch(uLampTex, ivec2(int(bid) & 511, int(bid) >> 9), 0);
          lamp = ld.xyz; routeCell = ld.w;
          #ifdef USE_BATCHING_COLOR
            if (aPart < 0.5) vColor.rgb *= getBatchingColor(bid).rgb;
          #endif
        #endif
        float blink = step(0.5, fract(uTime * 1.5));
        vEmis = vec3(0.0);
        if (aPart > 1.5 && aPart < 2.5) vEmis = vec3(1.0, 0.92, 0.78) * lamp.x * 3.0;
        else if (aPart > 2.5 && aPart < 3.5) vEmis = vec3(1.0, 0.06, 0.03) * (lamp.x * 0.6 + lamp.y * 2.6);
        else if (aPart > 3.5 && aPart < 5.5) {
          float side = aPart < 4.5 ? -1.0 : 1.0;
          float on = (abs(lamp.z - side) < 0.5 || lamp.z > 1.5 && lamp.z < 2.5) ? blink : 0.0;
          vEmis = vec3(1.0, 0.5, 0.05) * on * 3.0;
        }
        else if (aPart > 6.5 && aPart < 7.5) vEmis = vec3(1.0, 0.8, 0.2) * (0.15 + lamp.x * 0.8);
        else if (aPart > 7.5 && aPart < 8.5) {
          float ph = step(0.5, fract(uTime * 2.2 + (position.x > 0.0 ? 0.5 : 0.0)));
          vEmis = color.rgb * (lamp.z > 2.5 ? ph * 4.0 : 0.0);
        }
        vRough = aPart < 0.5 ? 0.32 : (aPart > 5.5 && aPart < 6.5 ? 0.06 : (aPart > 9.5 ? 0.22 : 0.75));
        vMetal = aPart < 0.5 ? 0.35 : (aPart > 5.5 && aPart < 6.5 ? 0.2 : (aPart > 9.5 ? 0.85 : 0.0));
        vBoard = (aPart > 8.5 && aPart < 9.5) ? vec3(uv, routeCell) : vec3(0.0, 0.0, -1.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEmis; varying float vRough; varying float vMetal; varying vec3 vBoard; uniform sampler2D uBoards;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (vBoard.z > -0.5) {
          vec2 bc = vec2(mod(vBoard.z, 8.0), floor(vBoard.z / 8.0));
          diffuseColor.rgb = texture2D(uBoards, vec2((bc.x + vBoard.x) / 8.0, 1.0 - (bc.y + 1.0 - vBoard.y) / 8.0)).rgb;
        }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmis;');
  };
  return m;
}
