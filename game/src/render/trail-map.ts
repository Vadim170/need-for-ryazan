import * as THREE from 'three';
import { weatherUniforms } from './weather';

/**
 * Карта следов шин вокруг камеры: ОДИН render target 1024² (HalfFloat) на окно 256×256 м (25 см/тексель),
 * тороидальная адресация (тексель = fract(world / size)) — при сдвиге окна ничего не копируется:
 * проход обслуживания каждый кадр гасит R (свежие следы, τ ≈ 90 с, быстрее в снегопад) и обнуляет тексели,
 * сменившие «владельца» (въехавшая полоса окна). Штампы — инстансы-отрезки с MAX-смешиванием.
 *   R — динамические следы (машина игрока, трафик), G — накатанные колеи по полосам (из графа трафика, без затухания;
 *   перештамповываются при сдвиге окна). Шейдеры поверхностей читают через `weatherUniforms.trail/trailWin`.
 */

const SIZE = 256;
const RES = 1024;
const SNAP = 16;
const MAX_STAMPS = 4096;

const FADE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FADE_FRAG = /* glsl */ `
uniform vec2 uOrigin, uPrev; uniform float uSize, uFade;
varying vec2 vUv;
void main() {
  vec2 t = vUv * uSize;
  vec2 a = uOrigin + mod(t - uOrigin, uSize), b = uPrev + mod(t - uPrev, uSize);
  float keep = step(length(a - b), 0.5);
  gl_FragColor = vec4(uFade * keep, keep, 1.0, 1.0);
}`;

const STAMP_VERT = /* glsl */ `
attribute vec4 aSeg; attribute vec3 aParam; // (x0,z0,x1,z1), (half width, R, G)
uniform float uSize;
varying vec2 vQ; varying vec2 vRG;
void main() {
  vec2 a = aSeg.xy, b = aSeg.zw;
  vec2 d = b - a; float L = length(d);
  vec2 f = L > 1e-4 ? d / L : vec2(1.0, 0.0);
  vec2 s = vec2(-f.y, f.x);
  float hw = aParam.x;
  // position.x: 0..1 вдоль (с запасом на полуширину), position.y: -1..1 поперёк
  vec2 p = a + f * (position.x * (L + 2.0 * hw) - hw) + s * position.y * hw;
  vec2 c = mod((a + b) * 0.5, uSize);
  vec2 tp = c + (p - (a + b) * 0.5);
  vQ = vec2(position.y, 0.0); vRG = aParam.yz;
  gl_Position = vec4(tp / uSize * 2.0 - 1.0, 0.0, 1.0);
}`;
const STAMP_FRAG = /* glsl */ `
varying vec2 vQ; varying vec2 vRG;
void main() {
  float k = 1.0 - smoothstep(0.55, 1.0, abs(vQ.x));
  gl_FragColor = vec4(vRG * k, 0.0, 0.0);
}`;

export interface LaneSource { segments(x: number, z: number, r: number, out: number[]): number }

export class TrailMap {
  readonly target: THREE.WebGLRenderTarget;
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private fadeScene = new THREE.Scene();
  private fadeMat: THREE.ShaderMaterial;
  private stampScene = new THREE.Scene();
  private stampGeo: THREE.InstancedBufferGeometry;
  private seg: THREE.InstancedBufferAttribute;
  private par: THREE.InstancedBufferAttribute;
  private n = 0;
  private origin = new THREE.Vector2(NaN, NaN);
  private fadeAcc = 0;
  private laneBuf: number[] = [];
  private cc = new THREE.Color();
  /** Источник колей полос (граф трафика); перештамповка при сдвиге окна. */
  lanes: LaneSource | null = null;
  private lanesDirty = true;
  /** Время жизни свежих следов, с (τ экспоненты). */
  tau = 90;
  enabled = true;

  constructor() {
    this.target = new THREE.WebGLRenderTarget(RES, RES, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    });
    this.target.texture.name = 'trail-map';
    this.fadeMat = new THREE.ShaderMaterial({
      vertexShader: FADE_VERT, fragmentShader: FADE_FRAG, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
      uniforms: { uOrigin: { value: new THREE.Vector2() }, uPrev: { value: new THREE.Vector2() }, uSize: { value: SIZE }, uFade: { value: 1 } },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fadeMat);
    quad.frustumCulled = false;
    this.fadeScene.add(quad);

    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    base.setIndex([0, 1, 2, 0, 2, 3]);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    this.seg = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 4), 4);
    this.par = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 3), 3);
    this.seg.setUsage(THREE.DynamicDrawUsage); this.par.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aSeg', this.seg); g.setAttribute('aParam', this.par);
    g.instanceCount = 0;
    this.stampGeo = g;
    const sm = new THREE.ShaderMaterial({
      vertexShader: STAMP_VERT, fragmentShader: STAMP_FRAG, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: { uSize: { value: SIZE } },
    });
    const mesh = new THREE.Mesh(g, sm);
    mesh.frustumCulled = false;
    this.stampScene.add(mesh);
    weatherUniforms.trail.value = this.target.texture;
  }

  /** Отрезок следа (мировые x,z), полуширина hw, интенсивности каналов R/G. */
  stamp(x0: number, z0: number, x1: number, z1: number, hw: number, r: number, g = 0): void {
    if (this.n >= MAX_STAMPS) return;
    const o = this.origin;
    if (!(x0 >= o.x && z0 >= o.y && x0 < o.x + SIZE && z0 < o.y + SIZE)) return;
    const i = this.n++;
    this.seg.setXYZW(i, x0, z0, x1, z1);
    this.par.setXYZ(i, hw, r, g);
  }

  /** Кадр: сдвиг окна, затухание, колеи полос (при сдвиге), штампы. dt — реальные секунды; fadeMul — ускорение затухания (снегопад). */
  update(renderer: THREE.WebGLRenderer, cx: number, cz: number, dt: number, fadeMul = 1): void {
    const ox = Math.floor((cx - SIZE / 2) / SNAP) * SNAP, oz = Math.floor((cz - SIZE / 2) / SNAP) * SNAP;
    const first = Number.isNaN(this.origin.x);
    const moved = first || ox !== this.origin.x || oz !== this.origin.y;
    const prev = first ? new THREE.Vector2(ox + 1e5, oz + 1e5) : this.origin.clone();
    this.origin.set(ox, oz);
    weatherUniforms.trailWin.value.set(ox, oz, SIZE, this.enabled ? 1 : 0);
    if (!this.enabled) { this.n = 0; return; }
    this.fadeAcc += dt * fadeMul;
    // затухание пачками (≥ 1 % за раз), чтобы не упираться в точность half-float
    const fade = Math.exp(-this.fadeAcc / this.tau);
    const doFade = fade < 0.99;
    if (moved || doFade) {
      this.fadeMat.uniforms.uOrigin.value.set(ox, oz);
      this.fadeMat.uniforms.uPrev.value.copy(prev);
      this.fadeMat.uniforms.uFade.value = doFade ? fade : 1;
      if (doFade) this.fadeAcc = 0;
      this.draw(renderer, this.fadeScene, first);
    }
    if (moved) this.lanesDirty = true;
    if (this.lanesDirty && this.lanes) {
      this.lanesDirty = false;
      const buf = this.laneBuf;
      buf.length = 0;
      const cnt = this.lanes.segments(ox + SIZE / 2, oz + SIZE / 2, SIZE * 0.72, buf);
      // колеи: два следа на полосу (±0.78 м), отрезками; каждая партия ≤ MAX_STAMPS
      for (let q = 0; q < cnt; q++) {
        const x0 = buf[q * 4], z0 = buf[q * 4 + 1], x1 = buf[q * 4 + 2], z1 = buf[q * 4 + 3];
        const L = Math.hypot(x1 - x0, z1 - z0) || 1;
        const sx = -(z1 - z0) / L * 0.78, sz = (x1 - x0) / L * 0.78;
        if (this.n + 2 > MAX_STAMPS) this.flush(renderer);
        this.stamp(x0 + sx, z0 + sz, x1 + sx, z1 + sz, 0.32, 0, 0.85);
        this.stamp(x0 - sx, z0 - sz, x1 - sx, z1 - sz, 0.32, 0, 0.85);
      }
    }
    this.flush(renderer);
  }

  private flush(renderer: THREE.WebGLRenderer): void {
    if (!this.n) return;
    this.stampGeo.instanceCount = this.n;
    this.seg.clearUpdateRanges(); this.seg.addUpdateRange(0, this.n * 4); this.seg.needsUpdate = true;
    this.par.clearUpdateRanges(); this.par.addUpdateRange(0, this.n * 3); this.par.needsUpdate = true;
    this.draw(renderer, this.stampScene, false);
    this.n = 0;
  }

  private draw(renderer: THREE.WebGLRenderer, scene: THREE.Scene, clear: boolean): void {
    const prevRT = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    if (clear) {
      renderer.getClearColor(this.cc); const ca = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false);
      renderer.setClearColor(this.cc, ca);
    }
    renderer.render(scene, this.cam);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAuto;
  }

  dispose(): void { this.target.dispose(); this.stampGeo.dispose(); this.fadeMat.dispose(); }
}
