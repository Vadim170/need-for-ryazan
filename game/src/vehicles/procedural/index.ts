import * as THREE from 'three';
import { buildBody, bakeWheels, type BodySpec, type VehicleKind } from './body';
import { ALL_PRESETS } from './presets';
import { buildWheelGeometry, type RimStyle, RIM_STYLES } from './wheels';

export { PART } from './mesh';
export type { VehicleKind, BodySpec } from './body';
export { RIM_STYLES, buildWheelGeometry } from './wheels';
export type { RimStyle } from './wheels';

/** Вариант (пресет) машины: геометрия ближнего LOD (без колёс) и дальнего (колёса вмурованы), колёса, габариты. */
export interface VehicleVariant {
  id: string; name: string; kind: VehicleKind;
  near: THREE.BufferGeometry; far: THREE.BufferGeometry;
  length: number; width: number; height: number;
  wheels: [number, number, number][]; wheelRadius: number; wheelWidth: number; rim: RimStyle;
  weight: number; parkedWeight: number; mass: number; fixedPaint?: number;
  /** Группа дальнего LOD: все варианты группы рисуются общим мешем (масштаб по габариту) — меньше draw call. */
  farGroup: string;
  /** Для маршрутных машин (ОТ): вариант с табличкой номера маршрута. */
  route: boolean;
  tris: { near: number; far: number };
  /** Сдвиг по Z, чтобы задняя ось совпала с осью эталона вида (кинематика симуляции). */
  dz: number;
  spec: BodySpec;
}

let cache: VehicleVariant[] | null = null;

/** Все варианты, генерируются один раз за сессию. */
export function allVariants(): VehicleVariant[] {
  if (cache) return cache;
  const out: VehicleVariant[] = [];
  const ref = new Map<string, number>(); // вид → z задней оси эталона
  for (const spec of ALL_PRESETS) {
    const n = buildBody(spec, 0), f = buildBody(spec, 1);
    const dzRef = ref.get(spec.kind);
    const zr = n.wheels[2][2];
    const dz = dzRef === undefined ? 0 : dzRef - zr;
    if (dzRef === undefined) ref.set(spec.kind, zr);
    const far = bakeWheels(f.near, f, spec.rim, 1);
    const near = n.near;
    if (dz) { near.translate(0, 0, dz); far.translate(0, 0, dz); }
    near.computeBoundingSphere(); far.computeBoundingSphere();
    out.push({
      id: spec.id, name: spec.name, kind: spec.kind, near, far, length: n.length, width: n.width, height: n.height,
      wheels: n.wheels.map(([x, y, z]) => [x, y, z + dz] as [number, number, number]), wheelRadius: n.wheelRadius, wheelWidth: n.wheelWidth, rim: spec.rim,
      weight: spec.weight, parkedWeight: spec.parkedWeight, mass: spec.mass, fixedPaint: spec.fixedPaint,
      farGroup: spec.farGroup ?? spec.kind, route: spec.id === 'gazelle_next_bus' || spec.kind === 'paz' || spec.kind === 'liaz' || spec.kind === 'trolleybus',
      tris: { near: near.index!.count / 3, far: far.index!.count / 3 }, dz, spec,
    });
  }
  cache = out;
  return out;
}

const wheelCache = new Map<string, THREE.BufferGeometry>();
/** Колесо единичного размера (радиус 1, ширина 1 вдоль X) нужного стиля, кеш. */
export function wheelGeometry(style: RimStyle): THREE.BufferGeometry {
  let g = wheelCache.get(style);
  if (!g) { g = buildWheelGeometry(style, 0); wheelCache.set(style, g); }
  return g;
}
void RIM_STYLES;
