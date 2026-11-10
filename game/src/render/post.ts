import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { quality } from './quality';

/**
 * Пост-обработка (docs/stage3/realism.md):
 *   сцена → HDR HalfFloat (+MSAA по пресету, + текстура глубины)
 *   → композит: SSAO (по глубине, половинное/полное разрешение, билатеральное размытие) и motion blur по скорости
 *     (репроекция глубины прошлой матрицей вида-проекции; машину игрока не размывает)
 *   → bloom (порог > 1, только HDR-эмиссия) → тонмаппинг + sRGB (OutputPass)
 *   → цветокоррекция по времени суток (lift/gamma/gain, насыщенность, контраст) + лёгкая виньетка + дизеринг
 *   → SMAA (по пресету).
 * `enabled = false` → прямой рендер в экран (`?bloom=0` — только bloom выключен, `?post=0` — всё).
 */

// ------------------------------------------------------------------ SSAO (по глубине)

const AO_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform vec2 uRes;          // разрешение AO-буфера
uniform float uRadius, uProjScale, uBias, uIntensity, uNear, uFar;
varying vec2 vUv;
vec3 viewPos(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  float d = texture2D(tDepth, vUv).x;
  if (d >= 0.9999) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv);
  vec2 px = 1.0 / uRes;
  // нормаль по соседям: с каждой оси берём сторону с меньшим скачком глубины (без ореолов на краях)
  vec3 pr = viewPos(vUv + vec2(px.x, 0.0)), pl = viewPos(vUv - vec2(px.x, 0.0));
  vec3 pu = viewPos(vUv + vec2(0.0, px.y)), pd = viewPos(vUv - vec2(0.0, px.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 n = normalize(cross(dx, dy));
  float rPx = clamp(uRadius * uProjScale / -P.z, 3.0, 80.0);
  float phi = ign(gl_FragCoord.xy) * 6.2831853;
  float occ = 0.0, R2 = uRadius * uRadius;
  const int NS = 12;
  for (int i = 0; i < NS; i++) {
    float r = sqrt((float(i) + 0.5) / float(NS));
    float th = float(i) * 2.39996323 + phi;
    vec2 suv = vUv + vec2(cos(th), sin(th)) * r * rPx * px;
    vec3 Q = viewPos(suv);
    vec3 v = Q - P;
    float vv = dot(v, v);
    float f = max(R2 - vv, 0.0) / R2;
    occ += f * max(dot(v, n) * inversesqrt(vv + 1e-4) - uBias, 0.0);
  }
  float ao = clamp(1.0 - uIntensity * occ / float(NS), 0.0, 1.0);
  // дальше 120 м — гасим (точность глубины, туман)
  ao = mix(ao, 1.0, smoothstep(80.0, 160.0, -P.z));
  gl_FragColor = vec4(ao, -P.z, 0.0, 1.0);
}`;

const AO_BLUR = /* glsl */ `
uniform sampler2D tAO;
uniform vec2 uRes;
varying vec2 vUv;
void main() {
  vec2 c = texture2D(tAO, vUv).xy;
  float s = 0.0, w = 0.0;
  for (int x = -2; x <= 1; x++) for (int y = -2; y <= 1; y++) {
    vec2 t = texture2D(tAO, vUv + (vec2(x, y) + 0.5) / uRes).xy;
    float k = 1.0 / (1.0 + abs(t.y - c.y) * 4.0 / max(c.y, 1.0) * 10.0);
    s += t.x * k; w += k;
  }
  gl_FragColor = vec4(s / w, c.y, 0.0, 1.0);
}`;

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// ------------------------------------------------------------------ композит: AO + motion blur

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tColor, tDepth, tAO;
uniform float uAO, uBlur;
uniform mat4 uInvViewProj, uPrevViewProj;
uniform vec4 uCar;              // центр машины на экране (uv), радиус (uv по y), глубина ndc-дальше которой размывать
uniform float uAspect;
varying vec2 vUv;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec4 col = texture2D(tColor, vUv);
  #ifdef USE_AO
    float ao = texture2D(tAO, vUv).x;
    col.rgb *= mix(1.0, ao, uAO);
  #endif
  #ifdef USE_BLUR
  if (uBlur > 0.001) {
    float d = texture2D(tDepth, vUv).x;
    vec4 w = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); w /= w.w;
    vec4 pc = uPrevViewProj * w;
    vec2 prev = pc.xy / pc.w * 0.5 + 0.5;
    vec2 vel = (vUv - prev) * uBlur;
    float L = length(vel);
    if (L > 0.03) vel *= 0.03 / L;
    // машина игрока движется вместе с камерой — не размывать её
    vec2 dc = (vUv - uCar.xy) * vec2(uAspect, 1.0);
    float carMask = 1.0 - (1.0 - smoothstep(uCar.z * 0.8, uCar.z, length(dc))) * step(d, uCar.w);
    vel *= carMask;
    if (length(vel) * 1000.0 > 1.0) {
      vec3 acc = col.rgb; float n = 1.0;
      float j = ign(gl_FragCoord.xy) - 0.5;
      for (int i = 1; i <= 8; i++) {
        vec2 o = vel * ((float(i) + j) / 8.0 - 0.5);
        float ds = texture2D(tDepth, vUv + o).x;
        // не тащить ближнюю машину в фон
        float k = step(uCar.w, ds) + (1.0 - carMask);
        acc += texture2D(tColor, vUv + o).rgb * min(k, 1.0); n += min(k, 1.0);
      }
      col.rgb = acc / n;
    }
  }
  #endif
  gl_FragColor = col;
}`;

// ------------------------------------------------------------------ цветокоррекция

/** Цветокоррекция — дописывается в шейдер OutputPass после тонмаппинга и sRGB (один полноэкранный проход). */
const GRADE_DECL = /* glsl */ `
uniform vec3 uLift, uGamma, uGain;
uniform float uSat, uContrast, uVignette, uAspect;
float nfrH12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;
const GRADE_CODE = /* glsl */ `
  {
    vec3 c = clamp(gl_FragColor.rgb, 0.0, 1.0);
    c = c * uGain + uLift * (1.0 - c);
    c = pow(max(c, vec3(0.0)), 1.0 / uGamma);
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, uSat);
    c = (c - 0.5) * uContrast + 0.5;
    vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
    c *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(q));
    c += (nfrH12(gl_FragCoord.xy) - 0.5) / 255.0;
    gl_FragColor.rgb = clamp(c, 0.0, 1.0);
  }
`;

/** Параметры цветокоррекции (как «LUT по времени суток», но аналитически). */
export interface Grade { lift: THREE.Vector3; gamma: THREE.Vector3; gain: THREE.Vector3; sat: number; contrast: number }

const G = (lift: number[], gamma: number[], gain: number[], sat: number, contrast: number): Grade => ({
  lift: new THREE.Vector3(...lift), gamma: new THREE.Vector3(...gamma), gain: new THREE.Vector3(...gain), sat, contrast,
});
/** Ключевые кадры по высоте солнца (градусы). Подобраны по панорамам Рязани (облачный летний день, нейтральный). */
const GRADES: [number, Grade][] = [
  [-14, G([0.004, 0.008, 0.018], [1, 1, 1.02], [0.93, 0.98, 1.08], 0.82, 1.04)],  // ночь: холоднее, приглушённо
  [-4, G([0.006, 0.006, 0.016], [1, 1, 1.02], [0.96, 0.97, 1.05], 0.92, 1.03)],    // синий час
  [3, G([0.012, 0.004, 0.0], [1.02, 1, 0.98], [1.05, 0.99, 0.9], 1.08, 1.06)],     // золотой час
  [12, G([0.004, 0.002, 0.0], [1, 1, 1], [1.02, 1.0, 0.96], 1.04, 1.04)],
  [30, G([0.0, 0.002, 0.004], [1, 1, 1], [1.0, 1.0, 0.99], 1.03, 1.03)],          // день
];

/** Пасс: свой рендер сцены в HDR-буфер с текстурой глубины (нужна AO и motion blur). */
class ScenePass extends Pass {
  constructor(private scene: THREE.Scene, private camera: THREE.Camera, private target: THREE.WebGLRenderTarget) { super(); this.needsSwap = false; }
  render(renderer: THREE.WebGLRenderer): void {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
  }
}

class CompositePass extends Pass {
  readonly quad: FullScreenQuad;
  readonly mat: THREE.ShaderMaterial;
  constructor(defs: Record<string, string>, uniforms: Record<string, THREE.IUniform>) {
    super();
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COMPOSITE_FRAG, uniforms, defines: defs, depthTest: false, depthWrite: false });
    this.quad = new FullScreenQuad(this.mat);
  }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget): void {
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}

export class PostFX {
  enabled = true;
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  /** Сила bloom днём / ночью. */
  dayStrength = 0.1;
  nightStrength = 0.4;
  /** SSAO: сила 0..1, радиус (м). */
  aoStrength = 0.75;
  aoRadius = 1.1;
  /** Motion blur: множитель (1 — «экспозиция» в один кадр 60 Гц). */
  motionBlur = 0.55;
  /** Виньетка 0..1. */
  vignette = 0.16;
  /** Экран машины игрока (main.ts: setCar) — исключается из motion blur. */
  private car = new THREE.Vector4(0.5, 0.6, 0, 0);
  private sceneRT: THREE.WebGLRenderTarget;
  private aoRT: THREE.WebGLRenderTarget | null = null;
  private aoBlurRT: THREE.WebGLRenderTarget | null = null;
  private aoQuad: FullScreenQuad | null = null;
  private aoBlurQuad: FullScreenQuad | null = null;
  private composite: CompositePass;
  private grade: { uniforms: Record<string, THREE.IUniform> };
  private smaa: SMAAPass | null = null;
  private prevViewProj = new THREE.Matrix4();
  private curViewProj = new THREE.Matrix4();
  private grading: Grade = G([0, 0, 0], [1, 1, 1], [1, 1, 1], 1, 1);
  private bloomOn = quality.bloom;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.sceneRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType, samples: this.msaaFor(size.x * size.y),
      depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType),
    });
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new ScenePass(scene, camera, this.sceneRT));
    const useAO = quality.ssao > 0, useBlur = quality.motionBlur;
    if (useAO) {
      const mk = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGFormat, depthBuffer: false });
      this.aoRT = mk(); this.aoBlurRT = mk();
      this.aoQuad = new FullScreenQuad(new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: AO_FRAG, depthTest: false, depthWrite: false,
        uniforms: {
          tDepth: { value: this.sceneRT.depthTexture }, uInvProj: { value: new THREE.Matrix4() }, uRes: { value: new THREE.Vector2() },
          uRadius: { value: this.aoRadius }, uProjScale: { value: 1 }, uBias: { value: 0.12 }, uIntensity: { value: 2.2 }, uNear: { value: 0 }, uFar: { value: 0 },
        },
      }));
      this.aoBlurQuad = new FullScreenQuad(new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: AO_BLUR, depthTest: false, depthWrite: false,
        uniforms: { tAO: { value: this.aoRT.texture }, uRes: { value: new THREE.Vector2() } },
      }));
    }
    const defs: Record<string, string> = {};
    if (useAO) defs.USE_AO = '';
    if (useBlur) defs.USE_BLUR = '';
    this.composite = new CompositePass(defs, {
      tColor: { value: this.sceneRT.texture }, tDepth: { value: this.sceneRT.depthTexture }, tAO: { value: this.aoBlurRT?.texture ?? null },
      uAO: { value: this.aoStrength }, uBlur: { value: 0 }, uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
      uCar: { value: this.car }, uAspect: { value: 1 },
    });
    this.composer.addPass(this.composite);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.5, 0.55, 1.0);
    this.bloom.enabled = this.bloomOn;
    this.composer.addPass(this.bloom);
    // тонмаппинг + sRGB (OutputPass) + цветокоррекция/виньетка/дизеринг — один проход
    const out = new OutputPass();
    Object.assign(out.uniforms, {
      uLift: { value: this.grading.lift }, uGamma: { value: this.grading.gamma }, uGain: { value: this.grading.gain },
      uSat: { value: 1 }, uContrast: { value: 1 }, uVignette: { value: this.vignette }, uAspect: { value: 1 },
    });
    const fs = out.material.fragmentShader;
    const end = fs.lastIndexOf('}');
    out.material.fragmentShader = fs.slice(0, end).replace('varying vec2 vUv;', 'varying vec2 vUv;\n' + GRADE_DECL) + GRADE_CODE + '}';
    out.material.needsUpdate = true;
    this.grade = out;
    this.composer.addPass(out);
    if (quality.smaa) { this.smaa = new SMAAPass(); this.composer.addPass(this.smaa); }
  }

  /** MSAA только если буфер не огромный (MSAA в HalfFloat на 4K+ стоит ~16 мс/кадр — там полагаемся на DPR). */
  private msaaFor(px: number): number { return px > 4.2e6 ? 0 : quality.msaa; }

  /** Bloom вкл/выкл (GUI, ?bloom=0) — остальная обработка остаётся. */
  get bloomEnabled(): boolean { return this.bloomOn; }
  set bloomEnabled(v: boolean) { this.bloomOn = v; this.bloom.enabled = v; }

  setSize(w: number, h: number): void {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    const W = Math.floor(w * pr), H = Math.floor(h * pr);
    const samples = this.msaaFor(W * H);
    if (this.sceneRT.samples !== samples) { this.sceneRT.samples = samples; this.sceneRT.dispose(); }
    this.sceneRT.setSize(W, H);
    if (this.aoRT && this.aoBlurRT) {
      const s = quality.ssao;
      const aw = Math.max(1, Math.floor(W * s)), ah = Math.max(1, Math.floor(H * s));
      this.aoRT.setSize(aw, ah); this.aoBlurRT.setSize(aw, ah);
      ((this.aoQuad!.material as THREE.ShaderMaterial).uniforms.uRes.value as THREE.Vector2).set(aw, ah);
      ((this.aoBlurQuad!.material as THREE.ShaderMaterial).uniforms.uRes.value as THREE.Vector2).set(aw, ah);
    }
    this.composite.mat.uniforms.uAspect.value = w / h;
    this.grade.uniforms.uAspect.value = w / h;
  }

  /** Положение машины игрока (мировые) — исключить из motion blur. */
  setCar(pos: THREE.Vector3, radius = 2.6): void {
    const cam = this.camera;
    const v = new THREE.Vector3().copy(pos).project(cam);
    const dist = pos.distanceTo(cam.position);
    const r = radius / (dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5)) * 0.5;
    // глубина буфера (0..1) точки за машиной: дальше неё — фон
    const back = new THREE.Vector3().subVectors(pos, cam.position).normalize().multiplyScalar(dist + radius * 1.2).add(cam.position).project(cam);
    this.car.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5, r, back.z * 0.5 + 0.5);
  }

  /** Цветокоррекция по высоте солнца (градусы). */
  setSunElevation(el: number): void {
    let i = 1;
    while (i < GRADES.length - 1 && el > GRADES[i][0]) i++;
    const [ea, a] = GRADES[i - 1], [eb, b] = GRADES[i];
    const t = THREE.MathUtils.clamp((el - ea) / (eb - ea), 0, 1);
    const g = this.grading;
    g.lift.lerpVectors(a.lift, b.lift, t); g.gamma.lerpVectors(a.gamma, b.gamma, t); g.gain.lerpVectors(a.gain, b.gain, t);
    this.grade.uniforms.uSat.value = a.sat + (b.sat - a.sat) * t;
    this.grade.uniforms.uContrast.value = a.contrast + (b.contrast - a.contrast) * t;
  }

  render(night: number, dt = 1 / 60): void {
    if (!this.enabled) { this.renderer.render(this.scene, this.camera); return; }
    this.bloom.strength = this.dayStrength + (this.nightStrength - this.dayStrength) * night;
    const cam = this.camera;
    cam.updateMatrixWorld();
    this.curViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const u = this.composite.mat.uniforms;
    u.uInvViewProj.value.copy(this.curViewProj).invert();
    u.uPrevViewProj.value.copy(this.prevViewProj);
    // блюр нормирован на кадр 60 Гц: при низком FPS не размазывать сильнее
    u.uBlur.value = this.motionBlur * Math.min(1, (1 / 60) / Math.max(dt, 1e-3));
    u.uAO.value = this.aoStrength;
    this.grade.uniforms.uVignette.value = this.vignette;
    if (this.aoQuad) {
      // AO считается из буфера глубины прошлого прохода сцены — рендерим сцену заранее (ScenePass) и AO между
      this.composer.passes[0].render(this.renderer, null as never, null as never, 0, false);
      const m = this.aoQuad.material as THREE.ShaderMaterial;
      m.uniforms.uInvProj.value.copy(cam.projectionMatrixInverse);
      m.uniforms.uProjScale.value = (this.aoRT!.height * 0.5) / Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
      m.uniforms.uRadius.value = this.aoRadius;
      this.renderer.setRenderTarget(this.aoRT);
      this.aoQuad.render(this.renderer);
      this.renderer.setRenderTarget(this.aoBlurRT);
      this.aoBlurQuad!.render(this.renderer);
      this.composer.passes[0].enabled = false;
      this.composer.render(dt);
      this.composer.passes[0].enabled = true;
    } else {
      this.composer.render(dt);
    }
    this.prevViewProj.copy(this.curViewProj);
  }
}
