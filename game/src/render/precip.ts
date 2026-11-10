import * as THREE from 'three';
import { weatherUniforms } from './weather';

/**
 * Осадки и частицы погоды — всё на GPU, CPU только пишет uniform-ы / кольцевой буфер запусков:
 *  - дождь: штрихи вокруг камеры (до 16k инстансов, бокс 44 м), наклон по ветру и скорости камеры (на ходу капли летят
 *    навстречу), позиция — из seed и времени в вершинном шейдере (0 CPU);
 *  - снег: хлопья (до 14k), медленное падение, завихрения;
 *  - брызги капель на земле (CPU раскладывает точки с высотой рельефа, анимация — в шейдере);
 *  - «пуфы» — универсальные мягкие частицы с баллистикой (пар из выхлопа и дыхание в мороз, сдуваемый снег с крыши,
 *    водяная пыль из-под колёс);
 *  - молния: ломаная-лента в небе на пару кадров (HDR → bloom).
 */

const RAIN_MAX = 16000;
const SNOW_MAX = 14000;
const SPLASH_MAX = 1200;
const PUFF_MAX = 3000;

const RAIN_VERT = /* glsl */ `
attribute vec3 aSeed;
uniform vec3 uCam, uCamVel; uniform float uTime, uBox, uH, uFall, uLen, uW; uniform vec2 uWind;
varying float vA; varying float vT;
void main() {
  float fall = uFall * (0.85 + 0.3 * aSeed.z);
  float ph = fract(aSeed.y + uTime * fall / uH);
  vec3 p;
  p.y = uCam.y + uH * 0.6 - ph * uH;
  vec2 base = aSeed.xz * uBox + uWind * (uTime + aSeed.y * 3.0);
  p.xz = uCam.xz + mod(base - uCam.xz + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 vel = vec3(uWind.x, -fall, uWind.y) - uCamVel * 0.8;
  vec3 dir = normalize(vel);
  float len = uLen * clamp(length(vel) / 9.0, 0.6, 2.2);
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = normalize(cross(dir, toCam)) * uW;
  vec3 wp = p + dir * position.y * len + side * position.x;
  float d = distance(p, cameraPosition);
  vA = smoothstep(1.2, 4.0, d) * (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, d));
  vT = position.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const RAIN_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uAlpha;
varying float vA; varying float vT;
void main() {
  float a = vA * uAlpha * (0.4 + 0.6 * vT);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

const SNOW_VERT = /* glsl */ `
attribute vec3 aSeed;
uniform vec3 uCam, uCamVel; uniform float uTime, uBox, uH, uFall, uSize; uniform vec2 uWind;
varying float vA; varying vec2 vUv;
void main() {
  float fall = uFall * (0.7 + 0.6 * aSeed.z);
  float ph = fract(aSeed.y + uTime * fall / uH);
  float tt = uTime + aSeed.x * 40.0;
  vec3 p;
  p.y = uCam.y + uH * 0.6 - ph * uH;
  vec2 swirl = vec2(sin(tt * 1.3 + aSeed.z * 6.0), cos(tt * 1.1 + aSeed.x * 6.0)) * 0.35;
  vec2 base = aSeed.xz * uBox + uWind * (uTime + aSeed.y * 9.0) * 0.9 + swirl;
  p.xz = uCam.xz + mod(base - uCam.xz + uBox * 0.5, uBox) - uBox * 0.5;
  // на скорости — короткие штрихи навстречу
  vec3 vel = vec3(uWind.x, -fall, uWind.y) - uCamVel;
  vec3 dir = normalize(vel);
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = normalize(cross(dir, toCam));
  vec3 upv = normalize(cross(toCam, side));
  float s = uSize * (0.6 + 0.8 * aSeed.z);
  float stretch = clamp(length(uCamVel) * 0.012, 0.0, 0.25);
  vec3 wp = p + side * position.x * s + (upv * position.y * s) + dir * position.y * stretch;
  float d = distance(p, cameraPosition);
  vA = smoothstep(1.5, 4.0, d) * (1.0 - smoothstep(uBox * 0.32, uBox * 0.5, d));
  vUv = position.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const SNOW_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uAlpha;
varying float vA; varying vec2 vUv;
void main() {
  float a = (1.0 - smoothstep(0.35, 1.0, length(vUv))) * vA * uAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

const SPLASH_VERT = /* glsl */ `
attribute vec4 aP; // x, y, z, birth
uniform float uTime;
varying vec2 vUv; varying float vT;
void main() {
  float t = (uTime - aP.w) / 0.35;
  vT = t;
  if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 toCam = normalize(cameraPosition - aP.xyz);
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  float s = 0.05 + 0.13 * t;
  vec3 wp = aP.xyz + side * position.x * s + vec3(0.0, 1.0, 0.0) * (position.y + 1.0) * s * 0.7;
  vUv = position.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const SPLASH_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uAlpha;
varying vec2 vUv; varying float vT;
void main() {
  // «корона»: дуга по краю, исчезает к концу
  float r = length(vUv * vec2(1.0, 1.4) - vec2(0.0, -0.4));
  float a = smoothstep(0.2, 0.6, r) * (1.0 - smoothstep(0.75, 1.0, r)) * (1.0 - vT) * uAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

const PUFF_VERT = /* glsl */ `
attribute vec4 aP0;  // x, y, z, birth
attribute vec4 aV0;  // vx, vy, vz, life
attribute vec4 aS;   // size0, size1, alpha, gravity
attribute vec3 aC;   // цвет (линейный)
uniform float uTime;
varying vec2 vUv; varying float vA; varying vec3 vC;
void main() {
  float age = uTime - aP0.w;
  float t = age / aV0.w;
  if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  const float K = 1.6; // сопротивление воздуха
  float drag = (1.0 - exp(-K * age)) / K;
  vec3 p = aP0.xyz + aV0.xyz * drag + vec3(0.0, -0.5 * aS.w * age * age, 0.0);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float s = mix(aS.x, aS.y, sqrt(t));
  mv.xy += position.xy * s;
  vUv = position.xy;
  vA = aS.z * (1.0 - t) * smoothstep(0.0, 0.08, t);
  vC = aC;
  gl_Position = projectionMatrix * mv;
}`;
const PUFF_FRAG = /* glsl */ `
varying vec2 vUv; varying float vA; varying vec3 vC;
void main() {
  float a = (1.0 - smoothstep(0.2, 1.0, length(vUv))) * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vC, a);
  #include <colorspace_fragment>
}`;

const BOLT_FRAG = /* glsl */ `
uniform float uI;
void main() { gl_FragColor = vec4(vec3(0.85, 0.88, 1.0) * uI * 2.2, 1.0); }`;
const BOLT_VERT = /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

function quad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

function seeded(n: number, seed: number): Float32Array {
  const a = new Float32Array(n * 3);
  let s = seed >>> 0;
  for (let i = 0; i < a.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = s / 4294967296; }
  return a;
}

function instanced(base: THREE.BufferGeometry, n: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.getAttribute('position'));
  g.instanceCount = n;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return g;
}

export interface PuffSpec {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  life: number; size0: number; size1: number; alpha: number; gravity: number; r: number; g: number; b: number;
}

export class Precipitation {
  readonly root = new THREE.Group();
  private rain: THREE.Mesh;
  private rainMat: THREE.ShaderMaterial;
  private snow: THREE.Mesh;
  private snowMat: THREE.ShaderMaterial;
  private splashMesh: THREE.Mesh;
  private splashMat: THREE.ShaderMaterial;
  private splashAttr: THREE.InstancedBufferAttribute;
  private splashHead = 0;
  private splashAcc = 0;
  private puffMesh: THREE.Mesh;
  private puffMat: THREE.ShaderMaterial;
  private puffAttrs: { p0: THREE.InstancedBufferAttribute; v0: THREE.InstancedBufferAttribute; s: THREE.InstancedBufferAttribute; c: THREE.InstancedBufferAttribute };
  private puffHead = 0;
  private puffDirty: [number, number] | null = null;
  private bolt: THREE.Mesh;
  private boltMat: THREE.ShaderMaterial;
  private boltT = 0;
  private time = 0;
  private lastCam = new THREE.Vector3();
  private camVel = new THREE.Vector3();
  /** Высота земли для брызг (city.heightAt); без неё брызг нет. */
  heightAt: ((x: number, z: number) => number) | null = null;
  readonly stats = { rain: 0, snow: 0 };

  constructor(scene: THREE.Scene) {
    this.root.name = 'precipitation';
    scene.add(this.root);
    const q = quad();
    const common = { uCam: { value: new THREE.Vector3() }, uCamVel: { value: new THREE.Vector3() }, uTime: { value: 0 }, uWind: { value: new THREE.Vector2() } };

    // дождь: штрих из прямоугольника (position.y 0..1 вдоль)
    const streak = new THREE.BufferGeometry();
    streak.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    streak.setIndex([0, 1, 2, 0, 2, 3]);
    const rg = instanced(streak, 0);
    rg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeded(RAIN_MAX, 77), 3));
    this.rainMat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { ...common, uCamVel: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2() }, uBox: { value: 44 }, uH: { value: 24 }, uFall: { value: 9 }, uLen: { value: 0.7 }, uW: { value: 0.0045 }, uColor: { value: new THREE.Color() }, uAlpha: { value: 0.35 } },
    });
    this.rain = new THREE.Mesh(rg, this.rainMat);
    this.rain.frustumCulled = false; this.rain.renderOrder = 5; this.rain.name = 'rain';

    const sg = instanced(q, 0);
    sg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeded(SNOW_MAX, 91), 3));
    this.snowMat = new THREE.ShaderMaterial({
      vertexShader: SNOW_VERT, fragmentShader: SNOW_FRAG, transparent: true, depthWrite: false,
      uniforms: { ...common, uCamVel: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2() }, uBox: { value: 50 }, uH: { value: 26 }, uFall: { value: 1.3 }, uSize: { value: 0.03 }, uColor: { value: new THREE.Color() }, uAlpha: { value: 0.9 } },
    });
    this.snow = new THREE.Mesh(sg, this.snowMat);
    this.snow.frustumCulled = false; this.snow.renderOrder = 5; this.snow.name = 'snowfall';

    const spg = instanced(q, SPLASH_MAX);
    this.splashAttr = new THREE.InstancedBufferAttribute(new Float32Array(SPLASH_MAX * 4).fill(-1e5), 4);
    this.splashAttr.setUsage(THREE.DynamicDrawUsage);
    spg.setAttribute('aP', this.splashAttr);
    this.splashMat = new THREE.ShaderMaterial({
      vertexShader: SPLASH_VERT, fragmentShader: SPLASH_FRAG, transparent: true, depthWrite: false,
      uniforms: { uTime: common.uTime, uColor: { value: new THREE.Color() }, uAlpha: { value: 0.5 } },
    });
    this.splashMesh = new THREE.Mesh(spg, this.splashMat);
    this.splashMesh.frustumCulled = false; this.splashMesh.renderOrder = 5; this.splashMesh.name = 'rain-splashes';

    const pg = instanced(q, PUFF_MAX);
    const mk = (n: number, fill = 0) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(PUFF_MAX * n).fill(fill), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.puffAttrs = { p0: mk(4, -1e5), v0: mk(4, 1), s: mk(4), c: mk(3, 1) };
    pg.setAttribute('aP0', this.puffAttrs.p0); pg.setAttribute('aV0', this.puffAttrs.v0);
    pg.setAttribute('aS', this.puffAttrs.s); pg.setAttribute('aC', this.puffAttrs.c);
    this.puffMat = new THREE.ShaderMaterial({
      vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG, transparent: true, depthWrite: false, uniforms: { uTime: common.uTime },
    });
    this.puffMesh = new THREE.Mesh(pg, this.puffMat);
    this.puffMesh.frustumCulled = false; this.puffMesh.renderOrder = 4; this.puffMesh.name = 'weather-puffs';

    this.boltMat = new THREE.ShaderMaterial({ vertexShader: BOLT_VERT, fragmentShader: BOLT_FRAG, uniforms: { uI: { value: 0 } }, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, transparent: true, side: THREE.DoubleSide });
    this.bolt = new THREE.Mesh(new THREE.BufferGeometry(), this.boltMat);
    this.bolt.frustumCulled = false; this.bolt.visible = false; this.bolt.renderOrder = -7;

    this.root.add(this.rain, this.snow, this.splashMesh, this.puffMesh, this.bolt);
  }

  /** Запуск мягкой частицы (пар, снег с крыши, брызги). */
  puff(s: PuffSpec): void {
    const i = this.puffHead;
    this.puffHead = (i + 1) % PUFF_MAX;
    const A = this.puffAttrs;
    A.p0.setXYZW(i, s.x, s.y, s.z, this.time);
    A.v0.setXYZW(i, s.vx, s.vy, s.vz, s.life);
    A.s.setXYZW(i, s.size0, s.size1, s.alpha, s.gravity);
    A.c.setXYZ(i, s.r, s.g, s.b);
    if (!this.puffDirty) this.puffDirty = [i, i];
    else this.puffDirty[1] = i;
  }

  /** Молния: ломаная из облаков к земле на расстоянии dist в направлении ang. */
  strike(camera: THREE.Camera, ang: number, dist: number): void {
    const c = camera.position;
    const x0 = c.x + Math.cos(ang) * dist, z0 = c.z + Math.sin(ang) * dist;
    const pts: THREE.Vector3[] = [];
    let x = x0, y = c.y + 420 + Math.random() * 200, z = z0;
    while (y > c.y - 20) {
      pts.push(new THREE.Vector3(x, y, z));
      y -= 25 + Math.random() * 45;
      x += (Math.random() - 0.5) * 70; z += (Math.random() - 0.5) * 70;
    }
    pts.push(new THREE.Vector3(x, c.y - 20, z));
    // лента шириной 5 м, повёрнута к камере
    const pos: number[] = [], idx: number[] = [];
    const v = new THREE.Vector3(), side = new THREE.Vector3(), d = new THREE.Vector3();
    pts.forEach((p, i) => {
      const nb = pts[Math.min(i + 1, pts.length - 1)], pb = pts[Math.max(i - 1, 0)];
      d.subVectors(nb, pb).normalize();
      v.subVectors(c, p).normalize();
      side.crossVectors(d, v).normalize().multiplyScalar((3 + 4 * (1 - i / pts.length)) * dist / 1500);
      pos.push(p.x - side.x, p.y - side.y, p.z - side.z, p.x + side.x, p.y + side.y, p.z + side.z);
      if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    });
    this.bolt.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    this.bolt.geometry = g;
    this.boltT = 0.28;
  }

  update(dt: number, camera: THREE.Camera, lightColor: THREE.Color): void {
    this.time += dt;
    const w = weatherUniforms;
    const cam = camera.position;
    if (dt > 0) {
      this.camVel.subVectors(cam, this.lastCam).divideScalar(dt);
      if (this.camVel.lengthSq() > 60 * 60) this.camVel.set(0, 0, 0); // телепорт
    }
    this.lastCam.copy(cam);
    const wind = w.windDir.value, ws = w.windStrength.value;
    for (const m of [this.rainMat, this.snowMat]) {
      m.uniforms.uCam.value.copy(cam);
      m.uniforms.uCamVel.value.lerp(this.camVel, Math.min(1, dt * 4));
      m.uniforms.uTime.value = this.time;
    }
    this.rainMat.uniforms.uWind.value.copy(wind).multiplyScalar(ws * 7);
    this.snowMat.uniforms.uWind.value.copy(wind).multiplyScalar(ws * 5);

    // цвет капель/снега — по освещённости (свет неба/солнца), ночью темнее; молния — вспышка
    const flash = w.lightning.value;
    const rc = this.rainMat.uniforms.uColor.value as THREE.Color;
    rc.copy(lightColor).multiplyScalar(0.55).addScalar(0.06 + flash * 0.8);
    (this.snowMat.uniforms.uColor.value as THREE.Color).copy(lightColor).multiplyScalar(0.95).addScalar(0.08 + flash);
    (this.splashMat.uniforms.uColor.value as THREE.Color).copy(rc);

    const rain = w.rainIntensity.value, snow = w.snowIntensity.value;
    const nr = Math.round(RAIN_MAX * Math.min(1, rain * 1.1));
    (this.rain.geometry as THREE.InstancedBufferGeometry).instanceCount = nr;
    this.rain.visible = nr > 0;
    this.rainMat.uniforms.uAlpha.value = 0.16 + 0.14 * rain;
    const ns = Math.round(SNOW_MAX * Math.min(1, snow));
    (this.snow.geometry as THREE.InstancedBufferGeometry).instanceCount = ns;
    this.snow.visible = ns > 0;
    this.stats.rain = nr; this.stats.snow = ns;

    // брызги: ~420/с при ливне в радиусе 16 м
    this.splashMesh.visible = rain > 0.02 && !!this.heightAt;
    if (this.splashMesh.visible && this.heightAt) {
      this.splashAcc += dt * 420 * rain;
      let n = Math.floor(this.splashAcc);
      this.splashAcc -= n;
      n = Math.min(n, 60);
      const i0 = this.splashHead;
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 16;
        const x = cam.x + Math.cos(a) * r + this.camVel.x * 0.25, z = cam.z + Math.sin(a) * r + this.camVel.z * 0.25;
        const y = this.heightAt(x, z) + 0.17;
        this.splashAttr.setXYZW(this.splashHead, x, y, z, this.time + Math.random() * dt);
        this.splashHead = (this.splashHead + 1) % SPLASH_MAX;
      }
      if (n) this.markRange(this.splashAttr, i0, n, 4, SPLASH_MAX);
    }

    if (this.puffDirty) {
      const [a, b] = this.puffDirty;
      const n = b >= a ? b - a + 1 : PUFF_MAX - a + b + 1;
      for (const at of [this.puffAttrs.p0, this.puffAttrs.v0, this.puffAttrs.s]) this.markRange(at, a, n, 4, PUFF_MAX);
      this.markRange(this.puffAttrs.c, a, n, 3, PUFF_MAX);
      this.puffDirty = null;
    }

    if (this.boltT > 0) {
      this.boltT -= dt;
      this.bolt.visible = this.boltT > 0;
      this.boltMat.uniforms.uI.value = Math.max(0, this.boltT / 0.28) * (0.6 + 0.4 * Math.random());
    }
  }

  private markRange(a: THREE.InstancedBufferAttribute, start: number, n: number, size: number, cap: number): void {
    a.clearUpdateRanges();
    if (start + n <= cap) a.addUpdateRange(start * size, n * size);
    else { a.addUpdateRange(start * size, (cap - start) * size); a.addUpdateRange(0, (start + n - cap) * size); }
    a.needsUpdate = true;
  }
}
