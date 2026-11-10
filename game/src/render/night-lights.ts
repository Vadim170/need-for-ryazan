import * as THREE from 'three';
import { headlightsWanted, smooth, timeUniforms } from './time-of-day';
import type { Props } from '../world/props';
import type { Vehicle } from '../vehicle/vehicle';

/**
 * Ночной свет вокруг машины (без сотен динамических источников):
 *  - «световые пятна» фонарей на дороге — один InstancedMesh из аддитивных круглых декалей (1 draw call, до MAX_POOLS штук);
 *  - фары игрока — 2 SpotLight без теней, включаются автоматически (гистерезис по nightFactor);
 *  - свечение плафонов фонарей и окон — в шейдерах мира (cityUniforms.uNfrNight, см. day-night.ts), bloom — post.ts.
 */

const MAX_POOLS = 256;
const LAMP_RADIUS = 220;      // фонари дальше не светят пятном (туман всё равно съедает)
const POOL_SIZE = 15;         // диаметр пятна, м (фонарь на 9 м)

const POOL_VERT = /* glsl */ `
varying vec2 vUv; varying float vDist;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vDist = distance(wp.xyz, cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const POOL_FRAG = /* glsl */ `
uniform float uOn, uFogNear, uFogFar; uniform vec3 uColor;
varying vec2 vUv; varying float vDist;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = pow(max(1.0 - r, 0.0), 2.2);
  a *= 1.0 - smoothstep(uFogNear, uFogFar, vDist);
  gl_FragColor = vec4(uColor * a * uOn, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class NightLights {
  readonly pools: THREE.InstancedMesh;
  readonly poolMat: THREE.ShaderMaterial;
  readonly headL = new THREE.SpotLight(0xfff0d0, 0, 90, 0.5, 0.75, 1.6);
  readonly headR = new THREE.SpotLight(0xfff0d0, 0, 90, 0.5, 0.75, 1.6);
  /** Максимальная сила фар (кандела). */
  headIntensity = 300;
  poolIntensity = 0.7;
  headlightsOn = false;
  private on = 0;
  private lastPos = new THREE.Vector3(1e9, 0, 1e9);
  private buf: number[] = [];
  private timer = 0;
  private m = new THREE.Matrix4();
  count = 0;

  constructor(private scene: THREE.Scene) {
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    this.poolMat = new THREE.ShaderMaterial({
      vertexShader: POOL_VERT, fragmentShader: POOL_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      uniforms: { uOn: { value: 0 }, uFogNear: { value: 150 }, uFogFar: { value: 720 }, uColor: { value: new THREE.Color(1.0, 0.72, 0.4) } },
    });
    this.pools = new THREE.InstancedMesh(g, this.poolMat, MAX_POOLS);
    this.pools.count = 0;
    this.pools.frustumCulled = false;
    this.pools.renderOrder = 2;
    this.pools.name = 'lamp-pools';
    scene.add(this.pools);
    for (const l of [this.headL, this.headR]) {
      l.castShadow = false;
      scene.add(l, l.target);
    }
  }

  update(dt: number, car: Vehicle, props: Props | null): void {
    this.headlightsOn = headlightsWanted(this.headlightsOn);
    car.lights?.setHeadlights(this.headlightsOn);
    this.on += ((this.headlightsOn ? 1 : 0) - this.on) * Math.min(1, dt * 6);
    const I = this.headIntensity * this.on;
    this.headL.intensity = I; this.headR.intensity = I;
    car.visual.updateMatrixWorld();
    for (const [l, sx] of [[this.headL, -0.62], [this.headR, 0.62]] as const) {
      l.position.set(sx, 0.72, -2.05).applyMatrix4(car.visual.matrixWorld);
      l.target.position.set(sx * 0.6, -0.15, -22).applyMatrix4(car.visual.matrixWorld);
      l.target.updateMatrixWorld();
    }

    const night = timeUniforms.nightFactor.value;
    const lampOn = smooth(0.12, 0.4, night); // фонари включены чуть раньше фар
    this.poolMat.uniforms.uOn.value = lampOn * this.poolIntensity;
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) { this.poolMat.uniforms.uFogNear.value = fog.near; this.poolMat.uniforms.uFogFar.value = fog.far; }
    this.pools.visible = lampOn > 0.01 && !!props;
    if (!this.pools.visible || !props) return;
    this.timer -= dt;
    const p = car.position;
    if (this.timer > 0 && p.distanceToSquared(this.lastPos) < 25) return;
    this.timer = 0.4;
    this.lastPos.copy(p);
    const n = Math.min(props.collectLamps(p.x, p.z, LAMP_RADIUS, this.buf), MAX_POOLS);
    const b = this.buf;
    for (let i = 0; i < n; i++) {
      this.m.makeScale(POOL_SIZE, 1, POOL_SIZE).setPosition(b[i * 3], b[i * 3 + 1] + 0.1, b[i * 3 + 2]);
      this.pools.setMatrixAt(i, this.m);
    }
    this.pools.count = n;
    this.pools.instanceMatrix.needsUpdate = true;
    this.count = n;
  }
}
