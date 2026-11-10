import * as THREE from 'three';
import { cityUniforms } from '../world/materials';
import { GameClock, solarPosition, moonPosition, equatorialMatrix, localSiderealRad, smooth, timeUniforms, windowLitCurve, type SunState, type MoonState } from './time-of-day';

/**
 * Небо, солнце/луна, звёзды, свет, туман и экспозиция по времени суток.
 *
 * Небо — собственный шейдер (горизонт/зенит по палитре от высоты солнца + закатное свечение + диск солнца + лёгкие облака),
 * поэтому цвет неба на горизонте ТОЧНО равен цвету тумана: край стриминга (туман 150–720 м) растворяется в небе без шва.
 * Палитра — `STOPS` (ключевые кадры по высоте солнца в градусах). Свет: одна DirectionalLight с тенями — солнце днём,
 * луна ночью (интенсивности смешиваются, направление — взвешенное), полусферный свет по палитре.
 */

interface Stop {
  el: number;
  horizon: number; zenith: number; glow: number; glowK: number;
  sun: number; sunI: number;
  hemiSky: number; hemiGround: number; hemiI: number;
  exposure: number;
  fogFar: number;
}

// el — высота солнца, градусы. Цвета sRGB hex. glowK — сила закатного свечения.
const STOPS: Stop[] = [
  { el: -18, horizon: 0x0b1226, zenith: 0x02050f, glow: 0x201a40, glowK: 0.0, sun: 0x000000, sunI: 0, hemiSky: 0x20315e, hemiGround: 0x0c0e16, hemiI: 0.5, exposure: 1.55, fogFar: 700 },
  { el: -9, horizon: 0x1a2b50, zenith: 0x060c24, glow: 0x4a3a78, glowK: 0.15, sun: 0x000000, sunI: 0, hemiSky: 0x32467a, hemiGround: 0x101420, hemiI: 0.6, exposure: 1.45, fogFar: 680 },
  { el: -4, horizon: 0x44598c, zenith: 0x14245c, glow: 0xc06a8a, glowK: 0.55, sun: 0x6070b0, sunI: 0.0, hemiSky: 0x6b80b8, hemiGround: 0x2a2a36, hemiI: 0.85, exposure: 1.3, fogFar: 640 },
  { el: -1, horizon: 0x77789e, zenith: 0x2a4688, glow: 0xff7a3c, glowK: 1.0, sun: 0xff6a2c, sunI: 0.15, hemiSky: 0x8a96c4, hemiGround: 0x4a3f3c, hemiI: 1.0, exposure: 1.18, fogFar: 640 },
  { el: 2, horizon: 0xb7a8b2, zenith: 0x4672b8, glow: 0xff9650, glowK: 0.95, sun: 0xff8a42, sunI: 1.3, hemiSky: 0x9aaed8, hemiGround: 0x6a5e52, hemiI: 1.1, exposure: 1.1, fogFar: 660 },
  { el: 6, horizon: 0xd2c8bc, zenith: 0x5686c6, glow: 0xffb070, glowK: 0.55, sun: 0xffb272, sunI: 2.2, hemiSky: 0xa4baea, hemiGround: 0x7d7364, hemiI: 1.2, exposure: 1.05, fogFar: 700 },
  { el: 12, horizon: 0xcbd9e8, zenith: 0x4c86cf, glow: 0xffd8a8, glowK: 0.22, sun: 0xffd9b2, sunI: 3.0, hemiSky: 0xaac4ff, hemiGround: 0x8b8578, hemiI: 1.35, exposure: 1.0, fogFar: 720 },
  { el: 30, horizon: 0xc2d5e8, zenith: 0x3f7bcc, glow: 0xfff0d8, glowK: 0.1, sun: 0xfff1dd, sunI: 3.2, hemiSky: 0xaac4ff, hemiGround: 0x8b8578, hemiI: 1.4, exposure: 1.0, fogFar: 720 },
  { el: 60, horizon: 0xbcd0e4, zenith: 0x3a74c4, glow: 0xfff0d8, glowK: 0.08, sun: 0xfff1dd, sunI: 3.2, hemiSky: 0xaac4ff, hemiGround: 0x8b8578, hemiI: 1.4, exposure: 1.0, fogFar: 720 },
];

export interface Palette {
  horizon: THREE.Color; zenith: THREE.Color; glow: THREE.Color;
  sun: THREE.Color; sunI: number;
  hemiSky: THREE.Color; hemiGround: THREE.Color; hemiI: number;
  exposure: number; fogFar: number;
}

const _c = new THREE.Color();
/** Палитра для высоты солнца `el` (град), линейная интерполяция в линейном RGB. */
export function samplePalette(el: number, out?: Palette): Palette {
  const o: Palette = out ?? {
    horizon: new THREE.Color(), zenith: new THREE.Color(), glow: new THREE.Color(), sun: new THREE.Color(), sunI: 0,
    hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), hemiI: 0, exposure: 1, fogFar: 720,
  };
  let i = 1;
  while (i < STOPS.length - 1 && el > STOPS[i].el) i++;
  const a = STOPS[i - 1], b = STOPS[i];
  const t = THREE.MathUtils.clamp((el - a.el) / (b.el - a.el), 0, 1);
  const mix = (dst: THREE.Color, ha: number, hb: number, ka = 1, kb = 1) => {
    dst.set(ha).multiplyScalar(ka);
    dst.lerp(_c.set(hb).multiplyScalar(kb), t);
  };
  mix(o.horizon, a.horizon, b.horizon);
  mix(o.zenith, a.zenith, b.zenith);
  mix(o.glow, a.glow, b.glow, a.glowK, b.glowK);
  mix(o.sun, a.sun, b.sun);
  mix(o.hemiSky, a.hemiSky, b.hemiSky);
  mix(o.hemiGround, a.hemiGround, b.hemiGround);
  o.sunI = a.sunI + (b.sunI - a.sunI) * t;
  o.hemiI = a.hemiI + (b.hemiI - a.hemiI) * t;
  o.exposure = a.exposure + (b.exposure - a.exposure) * t;
  o.fogFar = a.fogFar + (b.fogFar - a.fogFar) * t;
  return o;
}

// ------------------------------------------------------------------ небо

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uHorizon, uZenith, uGlow, uSunColor;
uniform vec3 uSunDir;
uniform float uSunDisk, uTime, uCloud, uNight, uEnv;
uniform vec3 uGround;
varying vec3 vDir;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(h, 0.42));
  float mu = max(dot(d, uSunDir), 0.0);
  // свечение вокруг солнца: широкое у горизонта + узкое гало
  float horizonBand = exp(-h * 5.0);
  col += uGlow * (pow(mu, 3.0) * horizonBand * 1.1 + pow(mu, 24.0) * 0.5 * (0.3 + horizonBand));
  // диск
  float disk = smoothstep(0.99985, 0.99994, mu) * smoothstep(-0.015, 0.02, d.y);
  col += uSunColor * disk * uSunDisk;
  // облака: плоский слой на высоте, дрейф по ветру, подсветка солнцем
  if (uCloud > 0.001 && d.y > 0.03) {
    vec2 uv = d.xz / (d.y + 0.12) * 0.9 + vec2(uTime * 0.004, uTime * 0.0016);
    float n = fbm(uv * 1.3);
    float cov = smoothstep(1.0 - uCloud, 1.0 - uCloud + 0.28, n + 0.12 * fbm(uv * 5.0));
    cov *= smoothstep(0.03, 0.22, d.y);
    float lit = 0.35 + 0.65 * smoothstep(0.35, 0.75, 1.0 - fbm(uv * 1.3 + uSunDir.xz * 0.15));
    vec3 ambient = mix(uHorizon, uZenith, 0.35) * 1.1;
    vec3 sunLit = uSunColor * uSunDisk * 0.028 * lit * (0.4 + 0.6 * pow(mu, 4.0));
    vec3 ccol = ambient * 0.85 + sunLit + uGlow * pow(mu, 3.0) * 0.5;
    col = mix(col, ccol, cov * 0.85 * (1.0 - uNight * 0.7));
  }
  // окружение (PMREM для IBL): ниже горизонта — «земля» (иначе снизу светит небо)
  if (uEnv > 0.5) col = mix(col, uGround, smoothstep(0.0, -0.08, d.y));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const STAR_VERT = /* glsl */ `
attribute float aSize; attribute float aMag; attribute vec3 aCol;
uniform float uNight, uPx, uTime;
varying vec3 vCol; varying float vA;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float elev = normalize(wp.xyz - cameraPosition).y;
  vCol = aCol;
  float tw = 0.85 + 0.15 * sin(uTime * (1.5 + aMag * 3.0) + aMag * 40.0);
  vA = uNight * aMag * tw * smoothstep(0.0, 0.12, elev);
  gl_PointSize = aSize * uPx;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const STAR_FRAG = /* glsl */ `
varying vec3 vCol; varying float vA;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(q)) * vA;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol * a * 1.6, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const MOON_VERT = /* glsl */ `
varying vec3 vN;
void main() { vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const MOON_FRAG = /* glsl */ `
uniform vec3 uSunDir; uniform float uVis;
varying vec3 vN;
float h31(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vn3(vec3 p) { vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(h31(i), h31(i+vec3(1,0,0)), f.x), mix(h31(i+vec3(0,1,0)), h31(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i+vec3(0,0,1)), h31(i+vec3(1,0,1)), f.x), mix(h31(i+vec3(0,1,1)), h31(i+vec3(1,1,1)), f.x), f.y), f.z); }
void main() {
  vec3 n = normalize(vN);
  float lit = smoothstep(-0.03, 0.06, dot(n, uSunDir));
  float maria = vn3(n * 2.6) * 0.6 + vn3(n * 7.0) * 0.3;
  vec3 albedo = mix(vec3(0.92, 0.92, 0.88), vec3(0.45, 0.46, 0.5), smoothstep(0.45, 0.75, maria));
  vec3 col = albedo * (lit * 2.2 + 0.02);
  gl_FragColor = vec4(col, uVis);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ------------------------------------------------------------------ система

export interface DayNightOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** Солнце/луна: SunLight с каскадными тенями (render/sun-shadow.ts) — направление = позиция. */
  sun: THREE.Light & { shadow: THREE.LightShadow };
  hemi: THREE.HemisphereLight;
  clock: GameClock;
}

const SKY_R = 4500;
const ENV_PERIOD = 0.75; // с, период перезапекания окружения

export class DayNight {
  readonly clock: GameClock;
  readonly sunState: SunState = { dir: new THREE.Vector3(0, 1, 0), elevationDeg: 45, azimuthDeg: 180, lambdaRad: 0 };
  readonly moonState: MoonState = { dir: new THREE.Vector3(0, -1, 0), elevationDeg: -30, illumination: 0.5 };
  readonly palette: Palette = samplePalette(45);
  /** 0..1: насколько «дневной» свет (для интенсивности отражений). */
  dayLight = 1;
  cloudCover = 0.35;
  readonly root = new THREE.Group();
  private skyMat: THREE.ShaderMaterial;
  private stars: THREE.Points;
  private starMat: THREE.ShaderMaterial;
  private moon: THREE.Mesh;
  private moonMat: THREE.ShaderMaterial;
  private envTimer = 0;
  private envMap: THREE.Texture | null = null;
  /** Внешние множители (GUI): экспозиция. */
  exposureBias = 1;
  /** Хук погоды (render/weather-system.ts): правит палитру (облачность, туман, молнии) до применения к небу/свету. */
  paletteHook: ((p: Palette, el: number) => void) | null = null;
  private t = 0;
  private lightDir = new THREE.Vector3(0, 1, 0);
  private tmp = new THREE.Vector3();
  private fogColor = new THREE.Color();
  private readonly o: DayNightOptions;
  /** Подписчики на изменение «ночи» — не нужны; материалы читают timeUniforms. */

  constructor(o: DayNightOptions) {
    this.o = o;
    this.clock = o.clock;
    this.root.name = 'sky';

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: {
        uHorizon: { value: new THREE.Color() }, uZenith: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
        uSunColor: { value: new THREE.Color() }, uSunDir: timeUniforms.sunDir, uSunDisk: { value: 30 }, uTime: { value: 0 },
        uCloud: { value: this.cloudCover }, uNight: timeUniforms.nightFactor, uEnv: { value: 0 }, uGround: { value: new THREE.Color(0.05, 0.05, 0.045) },
      },
    });
    const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 32, 16), this.skyMat);
    skyMesh.renderOrder = -10;
    skyMesh.frustumCulled = false;
    this.root.add(skyMesh);

    // звёзды: ~3000 точек на небесной сфере (экваториальные оси), вращаются со звёздным временем
    const N = 3000;
    const pos = new Float32Array(N * 3), size = new Float32Array(N), mag = new Float32Array(N), col = new Float32Array(N * 3);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < N; i++) {
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      pos[i * 3] = r * Math.cos(a) * (SKY_R - 200); pos[i * 3 + 1] = r * Math.sin(a) * (SKY_R - 200); pos[i * 3 + 2] = z * (SKY_R - 200);
      const m = Math.pow(rnd(), 3.2);                      // много тусклых, мало ярких
      mag[i] = 0.25 + 0.75 * m; size[i] = 1.2 + 2.6 * m;
      const tint = rnd();
      const c = tint < 0.2 ? [1.0, 0.82, 0.66] : tint > 0.75 ? [0.74, 0.84, 1.0] : [1, 1, 1];
      col.set(c, i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    sg.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    sg.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uNight: { value: 0 }, uPx: { value: Math.min(window.devicePixelRatio, 2) }, uTime: { value: 0 } },
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.renderOrder = -9;
    this.stars.frustumCulled = false;
    this.stars.matrixAutoUpdate = false;
    this.root.add(this.stars);

    this.moonMat = new THREE.ShaderMaterial({
      vertexShader: MOON_VERT, fragmentShader: MOON_FRAG, transparent: true, depthWrite: false, fog: false,
      uniforms: { uSunDir: timeUniforms.sunDir, uVis: { value: 1 } },
    });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this.moonMat);
    this.moon.scale.setScalar(58);
    this.moon.renderOrder = -8;
    this.moon.frustumCulled = false;
    this.root.add(this.moon);

    o.scene.add(this.root);
    o.scene.fog = o.scene.fog ?? new THREE.Fog(0xbcd0e4, 150, 720);
    this.apply();
  }

  /**
   * Окружение (IBL) из неба: куб 128² → PMREM в ОДИН и тот же render target (текстура не меняется — материалы,
   * получившие envMap при создании, видят обновления). Перезапекается раз в ENV_PERIOD с (время суток, облака,
   * погода). Возвращает текстуру; её же ставим в scene.environment.
   */
  bakeEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
    if (this.envMap) return this.envMap;
    this.envCube = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
    this.envCam = new THREE.CubeCamera(1, SKY_R * 2, this.envCube);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 32, 16), this.skyMat);
    sky.frustumCulled = false;
    this.envScene.add(sky, this.envCam);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.renderEnv(renderer);
    return this.envMap!;
  }

  private envScene = new THREE.Scene();
  private envCube: THREE.WebGLCubeRenderTarget | null = null;
  private envCam: THREE.CubeCamera | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  /** Множитель IBL (scene.environmentIntensity) и доля оставленного полусферного света. */
  envIntensity = 1.0;
  hemiKeep = 0.25;

  private renderEnv(renderer: THREE.WebGLRenderer): void {
    if (!this.envCam || !this.pmrem || !this.envCube) return;
    const u = this.skyMat.uniforms;
    const disk = u.uSunDisk.value;
    u.uSunDisk.value = 0; u.uEnv.value = 1;            // диск солнца даёт прямой свет SunLight, в IBL не нужен
    this.skyMat.depthTest = true;
    const tm = renderer.toneMapping;
    this.envCam.update(renderer, this.envScene);
    renderer.toneMapping = tm;
    this.skyMat.depthTest = false;
    u.uSunDisk.value = disk; u.uEnv.value = 0;
    this.envRT = this.pmrem.fromCubemap(this.envCube.texture, this.envRT);
    if (!this.envMap) {
      this.envMap = this.envRT.texture;
      this.o.scene.environment = this.envMap;
    }
  }

  /** Кадровое обновление: часы, астрономия, небо, свет. target — точка, вокруг которой строится карта теней. */
  update(dt: number, target: THREE.Vector3): void {
    this.clock.update(dt);
    this.t += dt;
    this.apply();
    this.positionLight(target);
    this.envTimer -= dt;
    if (this.envTimer <= 0 && this.envMap) { this.envTimer = ENV_PERIOD; this.renderEnv(this.o.renderer); }
    timeUniforms.hour.value = this.clock.hour;
  }

  private apply(): void {
    solarPosition(this.clock.ms, this.sunState);
    moonPosition(this.clock.ms, this.sunState.lambdaRad, this.moonState);
    equatorialMatrix(localSiderealRad(this.clock.ms), this.stars.matrix);
    this.stars.matrixWorldNeedsUpdate = true;
    const el = this.sunState.elevationDeg;
    const p = samplePalette(el, this.palette);
    this.paletteHook?.(p, el);
    const night = smooth(6, -6, el);
    timeUniforms.nightFactor.value = night;
    timeUniforms.sunDir.value.copy(this.sunState.dir);
    timeUniforms.moonDir.value.copy(this.moonState.dir);
    const gloom = smooth(5, -1, el);                       // фонари/окна загораются на закате (солнце < ~2°)
    timeUniforms.windowLit.value = windowLitCurve(this.clock.hour) * gloom;
    cityUniforms.uNfrNight.value = gloom;                  // множитель свечения: окна, плафоны фонарей (world/materials.ts, props.ts)
    cityUniforms.uNfrWin.value = windowLitCurve(this.clock.hour);
    this.dayLight = smooth(-6, 8, el);
    timeUniforms.skyColor.value.copy(p.horizon);

    const u = this.skyMat.uniforms;
    u.uHorizon.value.copy(p.horizon); u.uZenith.value.copy(p.zenith); u.uGlow.value.copy(p.glow); u.uSunColor.value.copy(p.sun);
    u.uSunDisk.value = 28 * smooth(-1.5, 2, el);
    u.uTime.value = this.t;
    u.uCloud.value = this.cloudCover;
    const clouds = 1 - THREE.MathUtils.smoothstep(this.cloudCover, 0.45, 0.95) * 0.97; // сплошная облачность закрывает звёзды и луну (погода)
    this.starMat.uniforms.uNight.value = smooth(-3, -12, el) * clouds;
    this.starMat.uniforms.uTime.value = this.t;
    // луна: видна над горизонтом; днём почти растворяется
    this.moon.position.copy(this.moonState.dir).multiplyScalar(4000);
    this.moonMat.uniforms.uVis.value = (1 - 0.88 * this.dayLight) * smooth(-2, 1, this.moonState.elevationDeg) * clouds;

    // туман = цвет горизонта (шва между небом и дальней геометрией нет)
    const fog = this.o.scene.fog as THREE.Fog;
    fog.color.copy(p.horizon);
    fog.far = Math.min(p.fogFar, 720);
    this.fogColor.copy(p.horizon);
    (this.o.scene.background as THREE.Color | null) = this.fogColor;

    // свет: солнце + луна в одной направленной лампе с тенями
    const moonUp = smooth(-1, 6, this.moonState.elevationDeg);
    const moonI = 0.55 * (0.3 + 0.7 * this.moonState.illumination) * moonUp * night;
    const sunI = p.sunI * smooth(-2, 1, el);
    const sum = sunI + moonI;
    const l = this.o.sun;
    if (sum > 1e-4) {
      this.lightDir.copy(this.sunState.dir).multiplyScalar(sunI).addScaledVector(this.moonState.dir, moonI).normalize();
      l.color.copy(p.sun).multiplyScalar(sunI / sum).add(this.tmpColor.set(0x9db4ff).multiplyScalar(moonI / sum));
    } else this.lightDir.copy(this.sunState.dir);
    l.intensity = sum;
    const wSun = sum > 1e-4 ? sunI / sum : 1;
    l.shadow.intensity = THREE.MathUtils.lerp(moonI > 0.05 ? 0.6 : 0, smooth(1.5, 9, el), wSun) * (sum > 0.05 ? 1 : 0);

    const h = this.o.hemi;
    h.color.copy(p.hemiSky);
    h.groundColor.copy(p.hemiGround);
    // рассеянный свет неба даёт IBL (scene.environment); полусферный — малая добавка (материалы без env, Lambert)
    h.intensity = (p.hemiI + moonI * 0.6) * (this.envMap ? THREE.MathUtils.lerp(this.hemiKeep, 0.9, night) : 1); // ночью небо в IBL почти чёрное
    this.o.scene.environmentIntensity = this.envIntensity;
    cityUniforms.uNfrAmb.value.copy(p.hemiSky).multiplyScalar(p.hemiI + moonI * 0.6);   // интерьеры за окнами днём
    u.uGround.value.copy(p.hemiGround).multiplyScalar(0.22 * p.hemiI + 0.3 * sunI * Math.max(this.sunState.dir.y, 0)); // отражённый от земли свет
    this.o.renderer.toneMappingExposure = p.exposure * this.exposureBias;
  }
  private tmpColor = new THREE.Color();

  /** Направление солнца/луны (SunLight: позиция = направление; каскады теней строятся по камере) + небо следует за камерой. */
  private positionLight(_target: THREE.Vector3): void {
    const l = this.o.sun;
    // не опускаем источник ниже ~3° над горизонтом (иначе тени уходят за карту), яркость от этого не меняется
    const d = this.tmp.copy(this.lightDir);
    if (d.y < 0.05) { d.y = 0.05; d.normalize(); }
    l.position.copy(d);
    l.updateMatrixWorld();
    this.root.position.copy(this.o.camera.position);
  }

  /** Лампа в сцене нужна и ночью? Для отладки/HUD. */
  get label(): string { return this.clock.label; }
}
