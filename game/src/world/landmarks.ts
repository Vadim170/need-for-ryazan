import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import { cityUniforms } from './materials';
import { smooth } from '../render/time-of-day';

/**
 * Hero-модели (docs/stage2/landmarks.md): манифест /assets/landmarks/landmarks.json.
 * Стриминг по расстоянию до игрока: в loadRadius грузится LOD1, ближе lod1Distance·1.5 — LOD0 (с коллайдерами),
 * переключение LOD с гистерезисом. Коллайдеры — кубоиды из дочерних нод `collider` (OBB по геометрии и мировой матрице).
 * Ночь: emissive-атлас (окна, подсветка фасадов) × cityUniforms.uNfrNight + аддитивные пятна света на земле (pools).
 */

export interface LandmarkDef {
  id: string; name?: string; glb: string; lod1?: string; enabled?: boolean;
  x: number; z: number; rotY: number; yOffset?: number;
  ground?: { mode: 'min' | 'mean'; points: [number, number][] };
  loadRadius?: number; lod1Distance?: number;
  pools?: [number, number, number, number, number][];   // локальные x, y, z, радиус, сила
}

interface State {
  def: LandmarkDef;
  y: number;
  root: THREE.Group;
  lod0?: THREE.Object3D; lod1?: THREE.Object3D;
  loading0: boolean; loading1: boolean;
  colliders: RAPIER.Collider[];
  mats: THREE.MeshStandardMaterial[];
  tris: { lod0: number; lod1: number };
}

const BASE = `${import.meta.env.BASE_URL}assets/landmarks/`;
const POOL_VERT = /* glsl */ `
varying vec2 vUv; varying float vDist; varying float vK;
attribute float aK;
void main() {
  vUv = uv; vK = aK;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vDist = distance(wp.xyz, cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const POOL_FRAG = /* glsl */ `
uniform float uOn, uFogNear, uFogFar; uniform vec3 uColor;
varying vec2 vUv; varying float vDist; varying float vK;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = pow(max(1.0 - r, 0.0), 1.8) * vK;
  a *= 1.0 - smoothstep(uFogNear, uFogFar, vDist);
  gl_FragColor = vec4(uColor * a * uOn, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const MAX_POOLS = 64;

export class Landmarks {
  readonly stats = { loaded: 0, lod0: 0, triangles: 0, drawCalls: 0, colliders: 0 };
  /** Множитель свечения ночью (окна, подсветка). */
  emissiveBoost = 0.8;
  private list: State[] = [];
  private loader = new GLTFLoader();
  private acc = 1e9;
  private pools: THREE.InstancedMesh;
  private poolMat: THREE.ShaderMaterial;
  private poolK: THREE.InstancedBufferAttribute;
  private poolsDirty = true;

  constructor(
    private scene: THREE.Scene,
    private physics: PhysicsWorld,
    private heightAt: (x: number, z: number) => number,
    private envMap: THREE.Texture | null,
  ) {
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    this.poolK = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POOLS), 1);
    g.setAttribute('aK', this.poolK);
    this.poolMat = new THREE.ShaderMaterial({
      vertexShader: POOL_VERT, fragmentShader: POOL_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      uniforms: { uOn: { value: 0 }, uFogNear: { value: 150 }, uFogFar: { value: 720 }, uColor: { value: new THREE.Color(1.0, 0.78, 0.5) } },
    });
    this.pools = new THREE.InstancedMesh(g, this.poolMat, MAX_POOLS);
    this.pools.count = 0;
    this.pools.frustumCulled = false;
    this.pools.renderOrder = 2;
    this.pools.name = 'landmark-pools';
    scene.add(this.pools);
  }

  static async load(scene: THREE.Scene, physics: PhysicsWorld, heightAt: (x: number, z: number) => number, envMap: THREE.Texture | null): Promise<Landmarks | null> {
    const r = await fetch(BASE + 'landmarks.json').catch(() => null);
    if (!r || !r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j.landmarks)) return null;
    const lm = new Landmarks(scene, physics, heightAt, envMap);
    for (const d of j.landmarks as LandmarkDef[]) if (d.enabled !== false) lm.add(d);
    return lm;
  }

  private add(def: LandmarkDef): void {
    const c = Math.cos(def.rotY), s = Math.sin(def.rotY);
    const toWorld = (x: number, z: number): [number, number] => [def.x + x * c + z * s, def.z - x * s + z * c];
    const pts = def.ground?.points?.length ? def.ground.points : [[0, 0] as [number, number]];
    const hs = pts.map(([x, z]) => this.heightAt(...toWorld(x, z)));
    const y = (def.ground?.mode === 'mean' ? hs.reduce((a, b) => a + b, 0) / hs.length : Math.min(...hs)) + (def.yOffset ?? 0);
    const root = new THREE.Group();
    root.name = 'landmark_' + def.id;
    root.position.set(def.x, y, def.z);
    root.rotation.y = def.rotY;
    root.updateMatrixWorld(true);
    this.scene.add(root);
    this.list.push({ def, y, root, loading0: false, loading1: false, colliders: [], mats: [], tris: { lod0: 0, lod1: 0 } });
  }

  /** Вызывать каждый кадр. */
  update(pos: THREE.Vector3, dt: number): void {
    const night = cityUniforms.uNfrNight.value;
    const e = night * this.emissiveBoost * (0.75 + 0.25 * Math.min(1, cityUniforms.uNfrWin.value * 1.6));
    for (const st of this.list) for (const m of st.mats) m.emissiveIntensity = e;
    this.poolMat.uniforms.uOn.value = smooth(0.12, 0.4, night) * 0.45;
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) { this.poolMat.uniforms.uFogNear.value = fog.near; this.poolMat.uniforms.uFogFar.value = fog.far; }
    this.pools.visible = this.poolMat.uniforms.uOn.value > 0.01 && this.pools.count > 0;
    this.acc += dt;
    if (this.acc < 0.4) return;
    this.acc = 0;
    for (const st of this.list) {
      const d = Math.hypot(pos.x - st.def.x, pos.z - st.def.z);
      const R = st.def.loadRadius ?? 1000, L1 = st.def.lod1Distance ?? 250;
      if (d > R + 200) { this.unload(st); continue; }
      if (d < R && !st.lod1 && !st.loading1 && st.def.lod1) this.fetch(st, 1);
      if (d < L1 * 1.5 && !st.lod0 && !st.loading0) this.fetch(st, 0);
      const near = st.lod0 && (d < L1 || (st.lod0.visible && d < L1 * 1.15) || !st.lod1);
      if (st.lod0) st.lod0.visible = !!near;
      if (st.lod1) st.lod1.visible = !near;
    }
    this.refreshStats();
    if (this.poolsDirty) this.rebuildPools();
  }

  private fetch(st: State, lod: 0 | 1): void {
    const url = BASE + (lod === 0 ? st.def.glb : st.def.lod1!);
    if (lod === 0) st.loading0 = true; else st.loading1 = true;
    this.loader.loadAsync(url).then((gltf) => {
      const obj = gltf.scene;
      const colliderNodes: THREE.Object3D[] = [];
      obj.traverse((o) => { if (o.name === 'collider' || o.userData.collider) colliderNodes.push(o); });
      for (const c of colliderNodes) c.parent?.remove(c);
      let tris = 0;
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true; m.receiveShadow = true;
        tris += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          const sm = mat as THREE.MeshStandardMaterial;
          if (!sm.isMeshStandardMaterial) continue;
          sm.envMap = this.envMap; sm.envMapIntensity = 0.8;
          if (sm.emissiveMap) { sm.emissive.set(0xffffff); sm.emissiveIntensity = 0; st.mats.push(sm); }
        }
      });
      st.root.add(obj);
      st.root.updateMatrixWorld(true);
      if (lod === 0) {
        st.lod0 = obj; st.tris.lod0 = tris;
        for (const c of colliderNodes) this.addColliders(st, c);
        this.poolsDirty = true;
      } else { st.lod1 = obj; st.tris.lod1 = tris; obj.visible = !st.lod0; }
      if (st.lod0 && st.lod1) st.lod1.visible = !st.lod0.visible;
    }).catch((e) => console.warn('[landmarks] не загрузилась', url, e))
      .finally(() => { if (lod === 0) st.loading0 = false; else st.loading1 = false; });
  }

  /** Кубоиды по каждому мешу ноды collider: OBB = bbox геометрии в локальных осях × мировая матрица. */
  private addColliders(st: State, node: THREE.Object3D): void {
    st.root.add(node);           // временно — ради мировых матриц
    node.updateMatrixWorld(true);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), c = new THREE.Vector3(), size = new THREE.Vector3();
    node.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox!;
      m.matrixWorld.decompose(p, q, s);
      bb.getCenter(c).applyMatrix4(m.matrixWorld);
      bb.getSize(size).multiply(s).multiplyScalar(0.5);
      const desc = RAPIER.ColliderDesc.cuboid(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z))
        .setTranslation(c.x, c.y, c.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(0.6);
      st.colliders.push(this.physics.world.createCollider(desc));
    });
    st.root.remove(node);
    node.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
  }

  private unload(st: State): void {
    for (const k of ['lod0', 'lod1'] as const) {
      const o = st[k];
      if (!o) continue;
      st.root.remove(o);
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          const sm = mat as THREE.MeshStandardMaterial;
          sm.map?.dispose(); sm.emissiveMap?.dispose(); sm.dispose();
        }
      });
      st[k] = undefined;
    }
    st.mats.length = 0;
    if (st.colliders.length) {
      for (const c of st.colliders) this.physics.world.removeCollider(c, false);
      st.colliders.length = 0;
      this.poolsDirty = true;
    }
  }

  private rebuildPools(): void {
    this.poolsDirty = false;
    const m = new THREE.Matrix4(), v = new THREE.Vector3();
    let n = 0;
    for (const st of this.list) {
      if (!st.lod0 || !st.def.pools) continue;
      for (const [x, , z, r, k] of st.def.pools) {
        if (n >= MAX_POOLS) break;
        v.set(x, 0, z).applyMatrix4(st.root.matrixWorld);
        m.makeScale(2 * r, 1, 2 * r).setPosition(v.x, this.heightAt(v.x, v.z) + 0.12, v.z);
        this.pools.setMatrixAt(n, m);
        this.poolK.setX(n, k);
        n++;
      }
    }
    this.pools.count = n;
    this.pools.instanceMatrix.needsUpdate = true;
    this.poolK.needsUpdate = true;
  }

  private refreshStats(): void {
    let loaded = 0, lod0 = 0, tris = 0, calls = 0, col = 0;
    for (const st of this.list) {
      if (st.lod0 || st.lod1) loaded++;
      col += st.colliders.length;
      const vis = st.lod0?.visible ? st.lod0 : st.lod1?.visible ? st.lod1 : null;
      if (!vis) continue;
      if (vis === st.lod0) lod0++;
      tris += vis === st.lod0 ? st.tris.lod0 : st.tris.lod1;
      vis.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) calls += Array.isArray(m.material) ? m.material.length : 1; });
    }
    Object.assign(this.stats, { loaded, lod0, triangles: Math.round(tris), drawCalls: calls, colliders: col });
  }

  /** Для отладки/скриншотов: позиция и высота модели. */
  info(): { id: string; x: number; y: number; z: number; rotY: number; loaded: boolean }[] {
    return this.list.map((s) => ({ id: s.def.id, x: s.def.x, y: s.y, z: s.def.z, rotY: s.def.rotY, loaded: !!(s.lod0 || s.lod1) }));
  }
}
