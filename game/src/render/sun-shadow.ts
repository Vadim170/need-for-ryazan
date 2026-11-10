import * as THREE from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';

/**
 * Каскадные тени солнца (docs/stage3/realism.md) на встроенном в three r186 `SunLight` (свет с атласом каскадов,
 * сэмплинг в стандартных шейдерных чанках — работает во ВСЕХ материалах без доработок). Встроенная тень жёстко
 * задаёт 2 каскада; здесь — копия `SunLightShadow` с настраиваемым числом каскадов (2–4) и правка define
 * `SUN_LIGHT_CASCADES` в чанке (до компиляции первого шейдера, поэтому число каскадов меняется только перезагрузкой).
 *
 * Разбиение: «практическое» (смесь равномерного и логарифмического, λ = 0.75 — ближе к логарифмическому, чтобы у
 * машины были резкие тени). Каждый каскад — ограничивающая сфера среза пирамиды камеры, привязка к текселям
 * (без дрожания). Мягкость: радиус PCF (Vogel, 5 выборок × аппаратный 2×2) масштабируется по каскадам так, чтобы
 * полутень в метрах была примерно одинаковой (cascade.w — множитель радиуса; правка чанка ниже).
 */

let patched = 0;
export function patchSunCascades(n: number): void {
  if (patched === n) return;
  const key = 'shadowmap_pars_fragment';
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  let src = chunks[key];
  src = src.replace(/#define SUN_LIGHT_CASCADES \d+/, `#define SUN_LIGHT_CASCADES ${n}`);
  // радиус PCF по каскаду: cascade.w (CascadedSunShadow заполняет), полутень — постоянной ширины в метрах
  src = src.replace(
    /sunLightShadow\.shadowRadius,\s*\n(\s*)sunShadowMatrix\[ cascadeOffset \+ i \] \* shadowWorldPosition/,
    'sunLightShadow.shadowRadius * max( cascade.w, 0.05 ),\n$1sunShadowMatrix[ cascadeOffset + i ] * shadowWorldPosition',
  );
  chunks[key] = src;
  patched = n;
}

const _lightOrientationMatrix = new THREE.Matrix4();
const _viewToLightMatrix = new THREE.Matrix4();
const _lightDirection = new THREE.Vector3();
const _up = new THREE.Vector3();
const _center = new THREE.Vector3();
const _near = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _far = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _corners = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new THREE.Vector3());
const FADE = 0.12;

/** Копия SunLightShadow (three/examples/jsm/lights/SunLightShadow.js) с N каскадами и раскладкой атласа N×1. */
export class CascadedSunShadow extends THREE.LightShadow<THREE.OrthographicCamera> {
  readonly isSunLightShadow = true;
  readonly cascades: number;
  /** 0..1: доля логарифмического разбиения. */
  lambda = 0.75;
  /** Дальность теней, м (camera.far тени). */
  get maxDistance(): number { return this.camera.far; }
  set maxDistance(v: number) { this.camera.far = v; }
  private _cameras: THREE.OrthographicCamera[] = [];
  private _matrices: THREE.Matrix4[] = [];
  private _frustums: THREE.Frustum[] = [];
  private _splits: number[];
  _cascadeData: THREE.Vector4[] = [];
  /** Радиусы каскадов (м) — для отладки. */
  readonly radii: number[] = [];

  constructor(cascades: number) {
    super(new THREE.OrthographicCamera(-5, 5, 5, -5, 0.5, 250));
    this.cascades = cascades;
    this.mapSize.set(2048, 2048);
    this._splits = new Array(cascades + 1).fill(0);
    const self = this as unknown as { _viewportCount: number; _frameExtents: THREE.Vector2; _viewports: THREE.Vector4[] };
    self._viewportCount = cascades;
    self._frameExtents.set(cascades, 1);
    for (let i = 0; i < cascades; i++) {
      this._cameras.push(new THREE.OrthographicCamera());
      this._matrices.push(new THREE.Matrix4());
      this._frustums.push(new THREE.Frustum());
      this._cascadeData.push(new THREE.Vector4());
      this.radii.push(0);
    }
    while (self._viewports.length < cascades) self._viewports.push(new THREE.Vector4());
  }

  getCamera(i = 0): THREE.OrthographicCamera { return this._cameras[i]; }
  getMatrix(i = 0): THREE.Matrix4 { return this._matrices[i]; }
  getFrustum(i = 0): THREE.Frustum { return this._frustums[i]; }

  updateMatrices(light: THREE.Light, viewCamera?: THREE.Camera): void {
    const cam = viewCamera as THREE.PerspectiveCamera | undefined;
    if (!cam) return;
    const N = this.cascades;
    const self = this as unknown as { _viewports: THREE.Vector4[]; _updateMatrix: (c: THREE.Camera, m: THREE.Matrix4, f: THREE.Frustum, v: THREE.Vector4) => void };
    const insetX = Math.min(0.25, (Math.ceil(this.radius * 1.5) + 1) / this.mapSize.x);
    const insetY = Math.min(0.25, (Math.ceil(this.radius * 1.5) + 1) / this.mapSize.y);
    for (let i = 0; i < N; i++) self._viewports[i].set(i + insetX, insetY, 1 - 2 * insetX, 1 - 2 * insetY);
    const resX = this.mapSize.x * (1 - 2 * insetX), resY = this.mapSize.y * (1 - 2 * insetY), res = Math.min(resX, resY);
    const near = cam.near, far = Math.max(near + 1e-6, Math.min(this.camera.far, cam.far));
    const sp = this._splits;
    sp[0] = near;
    for (let i = 1; i < N; i++) {
      const a = i / N;
      sp[i] = (near + (far - near) * a) * (1 - this.lambda) + near * Math.pow(far / near, a) * this.lambda;
    }
    sp[N] = far;
    _lightDirection.setFromMatrixPosition(light.matrixWorld).negate().normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_lightDirection)) > 0.99) _up.set(0, 0, 1);
    _lightOrientationMatrix.lookAt(_center.set(0, 0, 0), _lightDirection, _up);
    _viewToLightMatrix.copy(_lightOrientationMatrix).transpose().multiply(cam.matrixWorld);
    const zNear = -1;
    let maxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
      const x = i === 0 || i === 1 ? 1 : -1, y = i === 0 || i === 3 ? 1 : -1;
      const nc = _near[i].set(x, y, zNear).applyMatrix4(cam.projectionMatrixInverse);
      _far[i].copy(nc).multiplyScalar(far / near);
      nc.applyMatrix4(_viewToLightMatrix); _far[i].applyMatrix4(_viewToLightMatrix);
      maxZ = Math.max(maxZ, nc.z, _far[i].z);
    }
    maxZ += far; // потолок затеняющих: на дальность теней в сторону солнца
    const shadowNear = this.camera.near;
    let r0 = 0;
    for (let i = 0; i < N; i++) {
      const cNear = i === 0 ? sp[0] : this._cascadeData[i - 1].z;
      const cFar = sp[i + 1];
      const fadeStart = cFar - FADE * (cFar - sp[i]);
      const na = (cNear - near) / (far - near), fa = (cFar - near) / (far - near);
      _center.set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        _corners[j * 2].lerpVectors(_near[j], _far[j], na);
        _corners[j * 2 + 1].lerpVectors(_near[j], _far[j], fa);
        _center.add(_corners[j * 2]).add(_corners[j * 2 + 1]);
      }
      _center.multiplyScalar(1 / 8);
      let r2 = 0, minZ = Infinity;
      for (let j = 0; j < 8; j++) { r2 = Math.max(r2, _corners[j].distanceToSquared(_center)); minZ = Math.min(minZ, _corners[j].z); }
      let radius = Math.sqrt(r2);
      if (res > 1) {
        radius /= 1 - 1 / res;
        const tx = 2 * radius / resX, ty = 2 * radius / resY;
        _center.x = Math.round(_center.x / tx) * tx;
        _center.y = Math.round(_center.y / ty) * ty;
      }
      if (i === 0) r0 = radius;
      this.radii[i] = radius;
      // w — множитель радиуса PCF: полутень одинаковой ширины в метрах, но не меньше ~0.6 текселя
      this._cascadeData[i].set(i === 0 ? -1e10 : cNear, cFar, fadeStart, Math.max(r0 / radius, 0.6 / Math.max(this.radius, 0.01)));
      _center.z = maxZ + shadowNear;
      _center.applyMatrix4(_lightOrientationMatrix);
      const c = this._cameras[i];
      c.position.copy(_center);
      c.quaternion.setFromRotationMatrix(_lightOrientationMatrix);
      c.left = -radius; c.right = radius; c.top = radius; c.bottom = -radius;
      c.near = shadowNear; c.far = maxZ - minZ + 2 * shadowNear;
      c.updateProjectionMatrix();
      c.updateMatrixWorld();
      self._updateMatrix(c, this._matrices[i], this._frustums[i], self._viewports[i]);
    }
  }
}

/** Солнце/луна с каскадными тенями. Направление света = позиция (единичный вектор к солнцу). */
export function createSun(cascades: number, mapSize: number, maxDistance: number, radius: number): SunLight {
  patchSunCascades(cascades);
  const sun = new SunLight(0xfff1dd, 3.2);
  const sh = new CascadedSunShadow(cascades);
  sh.mapSize.set(mapSize, mapSize);
  sh.maxDistance = maxDistance;
  sh.camera.near = 0.5;
  sh.radius = radius;
  sh.bias = -0.0003;
  sh.normalBias = 0.04;
  (sun as unknown as { shadow: THREE.LightShadow }).shadow = sh;
  sun.castShadow = true;
  return sun;
}
