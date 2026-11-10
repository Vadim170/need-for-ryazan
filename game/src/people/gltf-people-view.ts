import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ProceduralPeopleView, LOOK_STRIDE, type PeopleView } from './people-view';
import { Body, Pose } from './human-factory';
import type { RagdollSkin, RagdollJoints, RagdollResult } from './ragdoll';
import type { RAPIER } from '../physics/world';

/**
 * Пешеходы из glTF (MakeHuman/MPFB2, CC0) с анимациями CMU mocap — тот же интерфейс PeopleView, агентам всё равно.
 *
 * Ассеты: public/assets/people/people.json (+ <id>.glb с мешами lod0/lod1, clips.bin). Сборка — assets/scripts/people/.
 *
 * Скиннинг на GPU для инстансов: при загрузке для КАЖДОГО персонажа все клипы считаются на его скелете (ретаргет:
 * поворот кости = Δ(клип) · C(персонаж), C — из его позы покоя в Т-позу, см. build_clips.py) и пишутся в текстуру
 * матриц скиннинга (half-float, 3 текселя на кость, строка = кадр 30 fps). Один InstancedMesh на персонажа и LOD;
 * вершинный шейдер (onBeforeCompile у MeshStandardMaterial, + такой же у MeshDepthMaterial для теней) берёт кадр клипа из
 * атрибутов инстанса (начало, длина, время), интерполирует соседние кадры и плавно смешивает с предыдущим клипом
 * (0.25 с). Цвет: атлас персонажа × тон региона (_REGION: верх/низ/шапка/волосы) из внешности агента.
 *
 * LOD: ближние (флаг near, < 70 м) — LOD0 (3–8 тыс. треугольников) с тенями; до farDist — LOD1 (~800); дальше — процедурный
 * человек (ProceduralPeopleView внутри). Пока ассеты грузятся (или если не загрузились) — всё рисует процедурный вид.
 */

interface ClipMeta { name: string; frames: number; duration: number; loop: boolean; offset: number; strideNorm?: number; speedNorm?: number; strideM?: number; rootY?: number }
interface CharMeta {
  id: string; file: string; body: 'man' | 'woman' | 'kid' | 'elder' | 'teen'; female: boolean; height: number;
  tris: number; lod1Tris: number; joints: Record<string, number[]>; tips: Record<string, number[]>; hairColor?: number[] | null;
  /** Сутулость, рад: верх тела наклоняется вперёд (пожилые). */
  stoop?: number;
  /** Зимний вариант (пальто/шапка/шарф/перчатки) — используется при setWinter(f > 0). */
  winter?: boolean;
}
interface Manifest {
  skeleton: { bones: string[]; parents: (string | null)[]; tposeDirs: Record<string, number[]> };
  clipsFile: string; fps: number; frameFloats: number; clips: ClipMeta[]; characters: CharMeta[];
}

/** Клипы в текстуре (индексы). WALK_ANGRY — производный: ноги от ходьбы, верх от «сердится» (5 циклов шага). */
const enum C { Idle, Walk, Run, Sit, Talk, Phone, Angry, Dodge, Fallen, GetupBack, GetupFront, WalkAngry, N }
const CLIP_NAMES = ['idle', 'walk', 'run', 'sit', 'talk', 'phone', 'angry', 'dodge', 'fallen', 'getup_back', 'getup_front'];
/** Переход от позы рэгдолла к клипу подъёма, с; конец подъёма — передача агенту за GETUP_HANDOFF до конца клипа. */
const GETUP_BLEND = 0.6;
const GETUP_SYS = 0.8; // people-system: состояние GetUp длится 0.8 с после Lie
const WALK_ANGRY_CYCLES = 5;
const FADE = 0.25;
const BODY_H = 1.75; // рост процедурного человека: матрица агента рассчитана на модель 1.75 м
const DIR_TIPS: Record<string, string> = {
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', LeftFoot: 'tip:LeftFoot', RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', RightFoot: 'tip:RightFoot',
  LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', LeftHand: 'tip:LeftHand', RightArm: 'RightForeArm', RightForeArm: 'RightHand', RightHand: 'tip:RightHand',
};
const LOWER = new Set(['Hips', 'LHipJoint', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RHipJoint', 'RightUpLeg', 'RightLeg', 'RightFoot']);

// ------------------------------------------------------------------ палитры (sRGB hex). Повторы = вес.
// Осенний город: тёмно-синий, оливковый, бежевый, серый, бордовый, горчичный, светлый деним, немного ярких спортивных.
const P_TOP_M = [0x1f2d4a, 0x1f2d4a, 0x4f5a32, 0xb9a888, 0x7c7f84, 0x3a3c40, 0x3a3c40, 0x6b2230, 0xb08a2e, 0x6f8fb3, 0x1c1c1e, 0x1c1c1e,
  0x5a4030, 0x8a7f5a, 0x2f4a3a, 0xb3262e, 0x2b5fb3, 0x2a7a7a, 0xc86a1e, 0x545a62];
const P_TOP_F = [0x1f2d4a, 0xa67b4f, 0xa67b4f, 0x5c2f4f, 0xc08a8f, 0xd8cfb8, 0x9e2a2b, 0xb08a2e, 0xb9a888, 0x7c7f84, 0x1c1c1e,
  0x6b2230, 0x4f5a32, 0x6f8fb3, 0x2a7a7a, 0x3a3c40, 0x8c5a7a, 0xc9b28a];
const P_TOP_KID = [0xd23a2a, 0xe6b42a, 0x2f6fd0, 0x3a9a4a, 0xd86a9a, 0xe0702a, 0x6a4ab0, 0x1fa0a8, 0x6aaee0, 0x1f2d4a];
const P_TOP_OLD = [0x7c7f84, 0x5a4030, 0xb9a888, 0x1f2d4a, 0x3a3c40, 0x4f5a32, 0x5a2030, 0xa67b4f, 0x545a62, 0x6e6458];
const P_BOTTOM = [0x23324e, 0x23324e, 0x3e5a80, 0x7591b5, 0x1a1a1c, 0x1a1a1c, 0x38393c, 0x6c6e72, 0x4a3a2c, 0x8c805e, 0xa89a7a, 0x1e2638];
const P_BOTTOM_F = [0x1a1a1c, 0x1a1a1c, 0x23324e, 0x38393c, 0x6c6e72, 0x5a2030, 0xa67b4f, 0x3e5a80, 0x1e2638, 0x4a3a2c, 0x7591b5, 0x5c2f4f];
const P_INNER = [0xe8e6e0, 0xb8babd, 0x9db7d6, 0xd9cdb0, 0x202022, 0xd9b3b3, 0xa9cbb7, 0x6b2230];
const P_SHOES = [0x1b1b1b, 0x1b1b1b, 0x1b1b1b, 0x1b1b1b, 0x3a2a1e, 0x3a2a1e, 0x5c3e28, 0x5d5f62, 0x22283a, 0xdedede];
const P_SHOES_KID = [0xd23a2a, 0x2f6fd0, 0xe6b42a, 0x3a9a4a, 0x1b1b1b, 0xd86a9a];
const P_HAT = [0x1b1b1d, 0x3a3a3c, 0x7c7f84, 0x6b2230, 0x1f2d4a, 0xb08a2e, 0xd8cfb8, 0x2f4a3a, 0x5a4030];
const P_HAT_KID = [0xd23a2a, 0x2f6fd0, 0xd86a9a, 0xe6b42a, 0x3a9a4a, 0x6a4ab0];
const P_SCARF = [0x6b2230, 0xb08a2e, 0x7c7f84, 0xd8cfb8, 0x1f2d4a, 0xa02a2a, 0x2f4a3a, 0xa67b4f, 0x1c1c1e];
const P_GLOVES = [0x1b1b1b, 0x1b1b1b, 0x3a2a1e, 0x4a4c50, 0x22283a];
const P_HAIR = [0x2a1d14, 0x3b2a1e, 0x16110e, 0x6a4a2e, 0x9a7a4e, 0x4a3a2c, 0x2a1d14, 0x16110e, 0xb8935a, 0x7a4a26];
const P_GREY = [0x9a9a96, 0xb8b6b0, 0x7a7874, 0xc8c6c0];
// зима: тёмные тяжёлые пуховики/пальто; дети — ярко
const W_TOP = [0x1c1c1e, 0x1c1c1e, 0x2a2c30, 0x1f2d4a, 0x3a2a22, 0x22352b, 0x4f1a24, 0x4a4c50, 0x3c4a5c, 0x8a6a48, 0x5c2f4f];
const W_BOTTOM = [0x1a1a1c, 0x1a1a1c, 0x23324e, 0x2a2c30, 0x38393c, 0x1e2638, 0x3a2a22];
const W_TOP_KID = [0xd23a2a, 0x2f6fd0, 0x6a4ab0, 0x3a9a4a, 0xe0702a, 0xd86a9a, 0x1fa0a8];

// Регион (_REGION) -> слот цвета: iC0 = (1 верх, 2 низ, 3 обувь, 4 волосы), iC1 = (5 шапка, 6 внутренний верх, 7 шарф, 8 перчатки).

const SKIN_GLSL = /* glsl */ `
uniform highp sampler2D uBones;
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute vec4 iAnimA;
attribute vec4 iAnimB;
mat4 nfrBone(float row, float j) {
  ivec2 p = ivec2(int(j) * 3, int(row));
  vec4 a = texelFetch(uBones, p, 0), b = texelFetch(uBones, p + ivec2(1, 0), 0), c = texelFetch(uBones, p + ivec2(2, 0), 0);
  return mat4(a.x, b.x, c.x, 0.0, a.y, b.y, c.y, 0.0, a.z, b.z, c.z, 0.0, a.w, b.w, c.w, 1.0);
}
mat4 nfrRow(float row) {
  return nfrBone(row, skinIndex.x) * skinWeight.x + nfrBone(row, skinIndex.y) * skinWeight.y +
    nfrBone(row, skinIndex.z) * skinWeight.z + nfrBone(row, skinIndex.w) * skinWeight.w;
}
mat4 nfrClip(vec4 an) {
  float f0 = floor(an.z), fr = an.z - f0;
  mat4 m = nfrRow(an.x + f0);
  if (fr > 0.01) m = m * (1.0 - fr) + nfrRow(an.x + mod(f0 + 1.0, an.y)) * fr;
  return m;
}
mat4 nfrSkin() {
  mat4 m = nfrClip(iAnimA);
  if (iAnimA.w > 0.002) m = m * (1.0 - iAnimA.w) + nfrClip(iAnimB) * iAnimA.w;
  return m;
}
`;

const TINT_GLSL = /* glsl */ `
attribute float _region;
attribute vec4 iC0;
attribute vec4 iC1;
varying vec3 vNfrTint;
// цвет упакован в float как 0xRRGGBB (sRGB); точно до 2^24
vec3 nfrUnpack(float f) {
  float r = floor(f / 65536.0), g = floor((f - r * 65536.0) / 256.0), b = f - r * 65536.0 - g * 256.0;
  return pow(vec3(r, g, b) / 255.0, vec3(2.2));
}
vec3 nfrTint(int r) {
  if (r <= 0 || r > 8) return vec3(1.0);
  float f = r == 1 ? iC0.x : r == 2 ? iC0.y : r == 3 ? iC0.z : r == 4 ? iC0.w : r == 5 ? iC1.x : r == 6 ? iC1.y : r == 7 ? iC1.z : iC1.w;
  return nfrUnpack(f);
}
`;

let _loader: GLTFLoader | null = null;
function loader(): GLTFLoader {
  if (!_loader) { _loader = new GLTFLoader(); _loader.setMeshoptDecoder(MeshoptDecoder); }
  return _loader;
}

/** Инстансы одного персонажа одного LOD. */
class Bucket {
  readonly mesh: THREE.InstancedMesh;
  readonly animA: Float32Array; readonly animB: Float32Array;
  readonly c0: Float32Array; readonly c1: Float32Array;
  private attrs: THREE.InstancedBufferAttribute[] = [];
  count = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, depth: THREE.Material, readonly cap: number, shadows: boolean, name: string) {
    const g = geo.clone();
    const mk = (nm: string) => {
      const arr = new Float32Array(cap * 4);
      const at = new THREE.InstancedBufferAttribute(arr, 4);
      at.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(nm, at);
      this.attrs.push(at);
      return arr;
    };
    this.animA = mk('iAnimA'); this.animB = mk('iAnimB'); this.c0 = mk('iC0'); this.c1 = mk('iC1');
    this.mesh = new THREE.InstancedMesh(g, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.customDepthMaterial = depth as THREE.MeshDepthMaterial;
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = shadows;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.name = name;
  }
  flush(): void {
    const n = this.count;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (!n) return;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(0, n * 16); im.needsUpdate = true;
    for (const a of this.attrs) { a.clearUpdateRanges(); a.addUpdateRange(0, n * 4); a.needsUpdate = true; }
  }
  dispose(): void { this.mesh.geometry.dispose(); this.mesh.dispose(); }
}

interface Character {
  meta: CharMeta;
  k: number; // нормировка роста: 1.75 / рост
  lod0: Bucket; lod1: Bucket;
  /** строка начала клипа в текстуре, кадров. */
  clipRow: Int32Array; clipLen: Int32Array;
  /** Длина цикла ходьбы/бега, м при масштабе агента 1 (по проходу таза в mocap), и длительности циклов, с. */
  strideW: number; strideR: number; durW: number; durR: number;
  tex: THREE.DataTexture;
  material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial;
  hasHat: boolean;
  /** Геометрия LOD0 (поза покоя) — для рэгдоллов. */
  geo0: THREE.BufferGeometry;
  /** Матрицы скиннинга 1-го кадра idle (3×4 на кость) — поза «стоит» для рэгдолла. */
  idle0: Float32Array;
  boneNames: string[];
}

export interface GltfPeopleViewOptions {
  baseUrl?: string;
  /** Дальше — процедурный человек (м). */
  farDist?: number;
  /** Мест на персонажа: LOD0 / LOD1. */
  capLod0?: number; capLod1?: number;
  /** Высота земли (для подъёма после рэгдолла). */
  heightAt?: (x: number, z: number) => number;
}

export class GltfPeopleView implements PeopleView, RagdollSkin {
  readonly root = new THREE.Group();
  readonly stats = { near: 0, far: 0, trisPerHuman: 0, lod0: 0, lod1: 0, proc: 0, ready: false, chars: 0, bakeMs: 0, loadMs: 0 };
  /** Камера для выбора LOD (ставит People.update). Без неё LOD1 рисуется до бесконечности. */
  camera: THREE.Camera | null = null;
  readonly ready: Promise<boolean>;
  private proc: ProceduralPeopleView;
  private chars: Character[] = [];
  private pools: number[][] = [[], [], [], []]; // по Body, осенние
  private poolsW: number[][] = [[], [], [], []]; // по Body, зимние варианты
  private femaleSet = new Set<number>();
  private winter = 0;
  private clips: ClipMeta[] = [];
  private time = 0;
  private frame = 0;
  private farDist2: number;
  // состояние агентов (индекс = lo / LOOK_STRIDE)
  private stChar = new Int16Array(0); private stHash = new Uint32Array(0); private stClip = new Int8Array(0);
  private stPrev = new Int8Array(0); private stSwitch = new Float32Array(0); private stPrevT = new Float32Array(0);
  private stSeen = new Uint32Array(0); private stStart = new Float32Array(0);
  private stPX = new Float32Array(0); private stPZ = new Float32Array(0); private stSpeed = new Float32Array(0);
  private stCyc = new Float32Array(0); private stCol = new Float32Array(0); private stFade = new Float32Array(0);
  private dt = 1 / 60;
  private farLook = new Float32Array(LOOK_STRIDE);
  private tmpM = new THREE.Matrix4(); private tmpS = new THREE.Matrix4(); private tmpM2 = new THREE.Matrix4();
  private opts: Required<GltfPeopleViewOptions>;
  private lookRef: ArrayLike<number> | null = null;
  private rag: (RagSlot | null)[] = [];
  private getups = new Map<number, Getup>();
  private disposed = false;

  constructor(capacity = 2048, opts: GltfPeopleViewOptions = {}) {
    this.opts = { baseUrl: opts.baseUrl ?? '/assets/people/', farDist: opts.farDist ?? 170, capLod0: opts.capLod0 ?? 160, capLod1: opts.capLod1 ?? 320, heightAt: opts.heightAt ?? (() => NaN) };
    this.farDist2 = this.opts.farDist ** 2;
    this.root.name = 'people_gltf';
    this.proc = new ProceduralPeopleView(capacity);
    this.root.add(this.proc.root);
    this.stats.trisPerHuman = this.proc.stats.trisPerHuman;
    this.ready = this.load().then(() => true).catch((e) => {
      console.warn('[people] glTF-пешеходы не загрузились, остаются процедурные:', e);
      return false;
    });
  }

  // ------------------------------------------------------------------ загрузка
  private async load(): Promise<void> {
    const base = this.opts.baseUrl;
    const res = await fetch(base + 'people.json');
    if (!res.ok) throw new Error(`people.json: ${res.status}`);
    const man = (await res.json()) as Manifest;
    const bin = await fetch(base + man.clipsFile);
    if (!bin.ok) throw new Error(`${man.clipsFile}: ${bin.status}`);
    const clipData = new Float32Array(await bin.arrayBuffer());
    this.clips = CLIP_NAMES.map((n) => {
      const c = man.clips.find((x) => x.name === n);
      if (!c) throw new Error(`нет клипа ${n}`);
      return c;
    });
    const tl = performance.now();
    // персонажи игрока (body 'player', src/player) пешеходами не бывают
    man.characters = man.characters.filter((c) => (c.body as string) !== 'player');
    const gltfs = await Promise.all(man.characters.map((c) => loader().loadAsync(base + c.file)));
    this.stats.loadMs = performance.now() - tl;
    let bake = 0;
    for (let i = 0; i < gltfs.length; i++) {
      if (this.disposed) return;
      const t0 = performance.now();
      try {
        this.chars.push(this.prepare(man, clipData, man.characters[i], gltfs[i].scene));
      } catch (e) {
        console.warn('[people] персонаж', man.characters[i].id, e);
      }
      bake += performance.now() - t0;
      await new Promise((r) => setTimeout(r, 0)); // запекание по одному персонажу за задачу — без долгого фриза
    }
    if (!this.chars.length) throw new Error('нет персонажей');
    this.chars.forEach((c, i) => {
      const b = c.meta.body;
      const pool = b === 'kid' ? Body.Kid : b === 'elder' ? Body.Elder : c.meta.female ? Body.Woman : Body.Man;
      (c.meta.winter ? this.poolsW : this.pools)[pool].push(i);
      if (c.meta.female) this.femaleSet.add(i);
      this.root.add(c.lod0.mesh, c.lod1.mesh);
    });
    // пустые пулы — из взрослых
    for (const b of [Body.Kid, Body.Elder, Body.Woman, Body.Man]) if (!this.pools[b].length) this.pools[b] = this.chars.map((_, i) => i);
    this.stats.bakeMs = bake;
    this.stats.ready = true;
    this.stats.chars = this.chars.length;
    this.stats.trisPerHuman = this.chars.reduce((s, c) => s + c.meta.tris, 0) / this.chars.length;
    console.info(`[people] glTF: ${this.chars.length} персонажей, ${this.clips.length} клипов, загрузка ${this.stats.loadMs.toFixed(0)} мс, запекание ${this.stats.bakeMs.toFixed(0)} мс`);
  }

  private prepare(man: Manifest, clipData: Float32Array, meta: CharMeta, scene: THREE.Object3D): Character {
    scene.updateMatrixWorld(true);
    const meshes: Record<string, THREE.SkinnedMesh> = {};
    scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes[o.name] = o as THREE.SkinnedMesh; });
    const m0 = meshes.lod0, m1 = meshes.lod1 ?? meshes.lod0;
    if (!m0) throw new Error('нет меша lod0');
    const boneNames = m0.skeleton.bones.map((b) => b.name);
    if (m1.skeleton.bones.some((b, i) => b.name !== boneNames[i])) throw new Error('разный порядок костей в LOD');
    const tex = this.bake(man, clipData, meta, boneNames);
    const srcMat = m0.material as THREE.MeshStandardMaterial;
    const map = srcMat.map ?? null;
    if (map) { map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4; }
    const { material, depth } = makeMaterials(map, tex.tex, meta.id);
    const k = BODY_H / meta.height;
    const L = meta.joints.Hips[1] - 0.5 * (meta.joints.LeftFoot[1] + meta.joints.RightFoot[1]);
    const walk = this.clips[C.Walk], run = this.clips[C.Run];
    const geo0 = restGeometry(m0), geo1 = restGeometry(m1);
    const ch: Character = {
      meta, k,
      lod0: new Bucket(geo0, material, depth, this.opts.capLod0, true, `people_${meta.id}_lod0`),
      lod1: new Bucket(geo1, material, depth, this.opts.capLod1, false, `people_${meta.id}_lod1`),
      clipRow: tex.row, clipLen: tex.len, tex: tex.tex, material, depth,
      strideW: (walk.strideNorm ?? 1.77) * L * k, strideR: (run.strideNorm ?? 2.3) * L * k, durW: walk.duration, durR: run.duration,
      hasHat: m0.geometry.getAttribute('_region') ? hasRegion(m0.geometry, 5) : false,
      geo0, idle0: tex.idle0, boneNames,
    };
    geo1.dispose();
    return ch;
  }

  /** Все клипы на скелете персонажа -> текстура матриц скиннинга (3 текселя RGBA на кость, строка = кадр). */
  private bake(man: Manifest, clipData: Float32Array, meta: CharMeta, boneNames: string[]): { tex: THREE.DataTexture; row: Int32Array; len: Int32Array; idle0: Float32Array } {
    const sk = man.skeleton.bones;
    const nb = sk.length;
    const ff = man.frameFloats;
    const J = boneNames.length;
    const kOf = boneNames.map((n) => sk.indexOf(n));
    if (kOf.some((k) => k < 0)) throw new Error('кость не из общего скелета');
    const parent = sk.map((_, i) => (man.skeleton.parents[i] === null ? -1 : sk.indexOf(man.skeleton.parents[i] as string)));
    const rest = sk.map((n) => new THREE.Vector3().fromArray(meta.joints[n]));
    // C: поза покоя персонажа -> Т-поза (кости рук/ног)
    const Cq = sk.map((n) => {
      const tip = DIR_TIPS[n];
      const q = new THREE.Quaternion();
      if (!tip) return q;
      const to = tip.startsWith('tip:') ? new THREE.Vector3().fromArray(meta.tips[tip.slice(4)]) : rest[sk.indexOf(tip)];
      const d = to.clone().sub(rest[sk.indexOf(n)]).normalize();
      const t = new THREE.Vector3().fromArray(man.skeleton.tposeDirs[n]).normalize();
      return q.setFromUnitVectors(d, t);
    });
    const L = meta.joints.Hips[1] - 0.5 * (meta.joints.LeftFoot[1] + meta.joints.RightFoot[1]);
    const hScale = meta.height / BODY_H;
    const stoop = meta.stoop ?? 0;
    const qStoop = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -stoop);
    // кадры: обычные клипы + производный walk_angry
    const wa = this.clips[C.Walk], an = this.clips[C.Angry];
    const lens = [...this.clips.map((c) => c.frames), wa.frames * WALK_ANGRY_CYCLES];
    const row = new Int32Array(C.N), len = new Int32Array(C.N);
    let total = 0;
    for (let c = 0; c < C.N; c++) { row[c] = total; len[c] = lens[c]; total += lens[c]; }
    const W = J * 3;
    const data = new Uint16Array(W * total * 4);
    const idle0 = new Float32Array(J * 12); // клип idle — первый, строка 0
    const R = sk.map(() => new THREE.Quaternion());
    const P = sk.map(() => new THREE.Vector3());
    const q = new THREE.Quaternion(), qh = new THREE.Quaternion(), qa = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const m = new THREE.Matrix4(), mt = new THREE.Matrix4();
    const h = THREE.DataUtils.toHalfFloat;
    const readQ = (clip: ClipMeta, f: number, b: number, out: THREE.Quaternion) => {
      const o = clip.offset + f * ff + b * 4;
      return out.set(clipData[o], clipData[o + 1], clipData[o + 2], clipData[o + 3]);
    };
    const writeFrame = (rowIdx: number, clip: ClipMeta, f: number, upper: ClipMeta | null, fu: number) => {
      // повороты
      for (let b = 0; b < nb; b++) {
        readQ(clip, f, b, q);
        if (upper && !LOWER.has(sk[b])) {
          // верх тела из другого клипа, относительно таза: Δ' = Δhips(низ) · Δhips(верх)^-1 · Δb(верх)
          readQ(clip, f, 0, qh);
          readQ(upper, fu, 0, qa).invert();
          readQ(upper, fu, b, q);
          q.premultiply(qa).premultiply(qh);
        }
        if (stoop && !LOWER.has(sk[b])) {
          // сутулость: наклон вперёд в системе таза (Δhips · Rx · Δhips^-1)
          readQ(clip, f, 0, qh);
          qa.copy(qh).multiply(qStoop).multiply(qh.invert());
          q.premultiply(qa);
        }
        R[b].copy(q).multiply(Cq[b]);
      }
      // позиции суставов
      const o = clip.offset + f * ff + nb * 4;
      for (let b = 0; b < nb; b++) {
        const p = parent[b];
        if (p < 0) {
          P[b].set(rest[b].x + clipData[o] * L, rest[b].y + clipData[o + 1] * L, rest[b].z + clipData[o + 2] * L);
          if (clip.rootY !== undefined) P[b].y = clip.rootY * hScale + clipData[o + 1] * L;
        } else {
          v.copy(rest[b]).sub(rest[p]).applyQuaternion(R[p]);
          P[b].copy(P[p]).add(v);
        }
      }
      // S = T(P) · R · T(−rest), строки 3×4
      for (let j = 0; j < J; j++) {
        const b = kOf[j];
        m.makeRotationFromQuaternion(R[b]);
        mt.makeTranslation(-rest[b].x, -rest[b].y, -rest[b].z);
        m.multiply(mt);
        m.elements[12] += P[b].x; m.elements[13] += P[b].y; m.elements[14] += P[b].z;
        const e = m.elements;
        const base = (rowIdx * W + j * 3) * 4;
        if (rowIdx === 0) for (let r = 0; r < 3; r++) { idle0[j * 12 + r * 4] = e[r]; idle0[j * 12 + r * 4 + 1] = e[4 + r]; idle0[j * 12 + r * 4 + 2] = e[8 + r]; idle0[j * 12 + r * 4 + 3] = e[12 + r]; }
        for (let r = 0; r < 3; r++) {
          data[base + r * 4] = h(e[r]); data[base + r * 4 + 1] = h(e[4 + r]); data[base + r * 4 + 2] = h(e[8 + r]); data[base + r * 4 + 3] = h(e[12 + r]);
        }
      }
    };
    for (let c = 0; c < this.clips.length; c++) {
      const clip = this.clips[c];
      for (let f = 0; f < clip.frames; f++) writeFrame(row[c] + f, clip, f, null, 0);
    }
    for (let f = 0; f < len[C.WalkAngry]; f++) {
      const fu = Math.floor((f / wa.frames) * wa.duration / an.duration * an.frames) % an.frames;
      writeFrame(row[C.WalkAngry] + f, wa, f % wa.frames, an, fu);
    }
    const tex = new THREE.DataTexture(data, W, total, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    tex.name = 'people_bones_' + meta.id;
    return { tex, row, len, idle0 };
  }

  // ------------------------------------------------------------------ кадр
  begin(time?: number): void {
    // dt кадра — до push (скорость по смещению = смещение этого кадра / dt этого же кадра; иначе при плавающем dt ноги дёргаются)
    if (time !== undefined) { const dt = time - this.time; if (dt > 1e-4 && dt < 0.25) this.dt = dt; this.time = time; }
    this.proc.begin();
    for (const c of this.chars) { c.lod0.count = 0; c.lod1.count = 0; }
    this.frame++;
  }

  push(m: ArrayLike<number>, mo: number, look: ArrayLike<number>, lo: number, near: boolean, body?: number): void {
    this.lookRef = look;
    if (!this.stats.ready) { this.proc.push(m, mo, look, lo, near); return; }
    const lod = near ? 0 : 1;
    const x = m[mo + 12], z = m[mo + 14];
    const id = (lo / LOOK_STRIDE) | 0;
    this.ensure(id);
    const hash = lookHash(look, lo);
    const gu = this.getups.get(id);
    if (gu) {
      if (gu.hash === hash) { this.stPX[id] = x; this.stPZ[id] = z; this.stSeen[id] = this.frame; return; } // рисует подъём
      this.endGetup(id, false); // на этом месте уже другой человек
    }
    if (!near && this.camera) {
      const cp = this.camera.position;
      if ((x - cp.x) ** 2 + (z - cp.z) ** 2 > this.farDist2) { this.pushFar(id, hash, m, mo, look, lo, body); return; }
    }
    const fresh = this.stHash[id] !== hash || this.stChar[id] < 0;
    if (fresh || this.frame - this.stSeen[id] > 30) {
      if (fresh) { this.stChar[id] = this.pick(hash, look, lo, m, mo, body); this.assignColors(id, hash); }
      this.stHash[id] = hash;
      this.stClip[id] = -1;
      this.stSpeed[id] = 0; this.stPX[id] = x; this.stPZ[id] = z;
    }
    this.stSeen[id] = this.frame;
    const ch = this.chars[this.stChar[id]];
    let bk = lod === 0 ? ch.lod0 : ch.lod1;
    if (bk.count >= bk.cap) {
      if (lod === 0 && ch.lod1.count < ch.lod1.cap) bk = ch.lod1;
      else { this.proc.push(m, mo, look, lo, near); return; }
    }
    // --- скорость по земле: из смещения матрицы между кадрами (сглажено); масштаб агента — из матрицы
    const dt = this.dt;
    const raw = Math.hypot(x - this.stPX[id], z - this.stPZ[id]) / dt;
    this.stPX[id] = x; this.stPZ[id] = z;
    if (raw < 9) this.stSpeed[id] += (raw - this.stSpeed[id]) * Math.min(1, dt * 12);
    const sc = Math.hypot(m[mo], m[mo + 1], m[mo + 2]) || 1;
    const v = this.stSpeed[id] / sc; // м/с в масштабе персонажа 1.75 м
    // --- локомоция: walk↔run по скорости, темп = скорость / длина цикла (ноги не скользят), idle при остановке
    const vW = ch.strideW / ch.durW, vR = ch.strideR / ch.durR;
    const wRun = smooth(vW * 1.15, vR * 0.8, v);
    const wMove = smooth(0.1, 0.45, v);
    const stride = ch.strideW + (ch.strideR - ch.strideW) * wRun;
    let cyc = this.stCyc[id] + (v * dt) / stride;
    if (cyc > 1000) cyc -= 1000; // кратно 5 (walk_angry) и 1
    this.stCyc[id] = cyc;
    // --- логический клип
    const pose = Math.round(look[lo + 16]);
    let logic: number;
    switch (pose) {
      case Pose.Sit: logic = C.Sit; break;
      case Pose.Talk: logic = C.Talk; break;
      case Pose.Phone: logic = C.Phone; break;
      case Pose.Dodge: logic = wMove > 0.5 ? C.Walk : C.Dodge; break;
      case Pose.Fallen: logic = C.Fallen; break;
      case Pose.Angry: logic = wMove > 0.3 ? C.WalkAngry : C.Angry; break;
      default: logic = C.Walk; // локомоция (idle/walk/run по скорости)
    }
    const now = this.time;
    const cur = this.stClip[id];
    if (cur !== logic) {
      if (cur >= 0) {
        this.stPrev[id] = this.dominant(cur, wMove, wRun);
        this.stSwitch[id] = now;
        this.stFade[id] = cur === C.Fallen ? 0.45 : FADE; // подъём после падения — мягче
      } else this.stSwitch[id] = -1e9;
      this.stClip[id] = logic;
      this.stStart[id] = now;
    }
    const i = bk.count++;
    const a4 = i * 4;
    const A = bk.animA, B = bk.animB;
    const fw = 1 - (now - this.stSwitch[id]) / this.stFade[id];
    const setA = (c: number) => { A[a4] = ch.clipRow[c]; A[a4 + 1] = ch.clipLen[c]; A[a4 + 2] = this.clipTime(ch, c, id, cyc, hash); };
    const setB = (c: number, w: number) => { A[a4 + 3] = w; B[a4] = ch.clipRow[c]; B[a4 + 1] = ch.clipLen[c]; B[a4 + 2] = this.clipTime(ch, c, id, cyc, hash); };
    A[a4 + 3] = 0;
    if (fw > 0 && lod === 0) {
      // переход между логическими клипами: A — новый (его доминирующая часть), B — старый
      setA(this.dominant(logic, wMove, wRun));
      setB(this.stPrev[id], fw);
    } else if (logic === C.Walk || logic === C.WalkAngry) {
      const walkC = logic, idleC = logic === C.Walk ? C.Idle : C.Angry;
      if (lod === 1) setA(this.dominant(logic, wMove, wRun));
      else if (wMove < 0.999) { setA(walkC); setB(idleC, 1 - wMove); }
      else if (wRun > 0.001 && logic === C.Walk) { setA(C.Walk); setB(C.Run, wRun); }
      else setA(walkC);
    } else setA(logic);
    // --- цвета (по человеку, стабильно; см. assignColors)
    const co = id * 8;
    bk.c0[a4] = this.stCol[co]; bk.c0[a4 + 1] = this.stCol[co + 1]; bk.c0[a4 + 2] = this.stCol[co + 2]; bk.c0[a4 + 3] = this.stCol[co + 3];
    bk.c1[a4] = this.stCol[co + 4]; bk.c1[a4 + 1] = this.stCol[co + 5]; bk.c1[a4 + 2] = this.stCol[co + 6]; bk.c1[a4 + 3] = this.stCol[co + 7];
    // --- матрица: агентская (рассчитана на 1.75 м) × нормировка роста персонажа
    const tm = this.tmpM.fromArray(m, mo).multiply(this.tmpS.makeScale(ch.k, ch.k, ch.k));
    tm.toArray(bk.mesh.instanceMatrix.array as Float32Array, i * 16);
    const dw = this.dbg.get(id);
    if (dw) { dw.ch = this.stChar[id]; dw.A = Array.from(A.subarray(a4, a4 + 4)); dw.B = Array.from(B.subarray(a4, a4 + 4)); dw.m = tm.toArray(); dw.v = v; }
  }

  // ------------------------------------------------------------------ отладка
  private dbg = new Map<number, { ch: number; A: number[]; B: number[]; m: number[]; v: number }>();
  /** Отладка: следить за агентом (индекс в people-system) — для debugJoint. */
  debugWatch(id: number, on = true): void { if (on) this.dbg.set(id, { ch: -1, A: [], B: [], m: [], v: 0 }); else this.dbg.delete(id); }
  /** Отладка: мировая позиция сустава агента в последнем кадре (тот же скиннинг, что в шейдере, на CPU). */
  debugJoint(id: number, bone: string): { x: number; y: number; z: number; v: number } | null {
    const d = this.dbg.get(id);
    if (!d || d.ch < 0) return null;
    const ch = this.chars[d.ch];
    const j = ch.boneNames.indexOf(bone);
    const data = ch.tex.image.data as Uint16Array;
    const W = ch.boneNames.length * 3;
    const rowM = (row: number) => {
      const out = new Array(12);
      for (let k = 0; k < 12; k++) out[k] = THREE.DataUtils.fromHalfFloat(data[(row * W + j * 3) * 4 + k]);
      return out;
    };
    const clipM = (an: number[]) => {
      const f0 = Math.floor(an[2]), fr = an[2] - f0;
      const a = rowM(an[0] + f0);
      if (fr <= 0.01) return a;
      const b = rowM(an[0] + ((f0 + 1) % an[1]));
      return a.map((x, k) => x * (1 - fr) + b[k] * fr);
    };
    let M = clipM(d.A);
    if (d.A[3] > 0.002) { const mb = clipM(d.B); M = M.map((x, k) => x * (1 - d.A[3]) + mb[k] * d.A[3]); }
    const r = ch.meta.joints[bone];
    const p = new THREE.Vector3(
      M[0] * r[0] + M[1] * r[1] + M[2] * r[2] + M[3], M[4] * r[0] + M[5] * r[1] + M[6] * r[2] + M[7], M[8] * r[0] + M[9] * r[1] + M[10] * r[2] + M[11]);
    p.applyMatrix4(new THREE.Matrix4().fromArray(d.m));
    return { x: p.x, y: p.y, z: p.z, v: d.v };
  }

  /** Дальний — процедурный человек, но в тех же цветах, что и его glTF-персонаж (без резкой смены при переходе LOD). */
  private pushFar(id: number, hash: number, m: ArrayLike<number>, mo: number, look: ArrayLike<number>, lo: number, body?: number): void {
    if (this.stHash[id] !== hash || this.stChar[id] < 0) {
      this.stChar[id] = this.pick(hash, look, lo, m, mo, body);
      this.assignColors(id, hash);
      this.stHash[id] = hash;
      this.stClip[id] = -1;
    }
    this.stPX[id] = m[mo + 12]; this.stPZ[id] = m[mo + 14]; this.stSeen[id] = this.frame;
    const t = this.farLook;
    for (let k = 0; k < LOOK_STRIDE; k++) t[k] = look[lo + k];
    const co = id * 8;
    unpackLinear(this.stCol[co], t, 0); // верх
    unpackLinear(this.stCol[co + 1], t, 3); // низ
    unpackLinear(this.chars[this.stChar[id]].meta.winter ? this.stCol[co + 4] : this.stCol[co + 3], t, 6); // шапка (зимой) или волосы
    this.proc.push(m, mo, t, 0, false);
  }

  /** Какой клип реально виден у логического (для локомоции — по скорости). */
  private dominant(logic: number, wMove: number, wRun: number): number {
    if (logic === C.Walk) return wMove < 0.5 ? C.Idle : wRun > 0.5 ? C.Run : C.Walk;
    if (logic === C.WalkAngry) return wMove < 0.5 ? C.Angry : C.WalkAngry;
    return logic;
  }

  /** Время клипа в кадрах (дробное). Ходьба/бег — по накопленным циклам шага (фазы клипов совпадают). */
  private clipTime(ch: Character, clip: number, id: number, cyc: number, hash: number): number {
    const n = ch.clipLen[clip];
    switch (clip) {
      case C.Walk: case C.Run: return (cyc - Math.floor(cyc)) * n;
      case C.WalkAngry: {
        const c5 = cyc - Math.floor(cyc / WALK_ANGRY_CYCLES) * WALK_ANGRY_CYCLES;
        return (c5 / WALK_ANGRY_CYCLES) * n;
      }
      case C.Dodge: return Math.min((this.time - this.stStart[id]) * 30, n - 1);
      case C.GetupBack: case C.GetupFront: return n - 1; // только как «прошлый» клип при передаче агенту
      default: {
        const t = (this.time + (hash % 1000) * 0.137) * 30;
        return t - Math.floor(t / n) * n;
      }
    }
  }

  private pick(hash: number, look: ArrayLike<number>, lo: number, m: ArrayLike<number> | null, mo: number, body?: number): number {
    let b = body;
    if (b === undefined) {
      const s = m ? Math.hypot(m[mo], m[mo + 1], m[mo + 2]) : 1;
      b = s < 0.8 ? Body.Kid : look[lo + 13] > 0.15 ? Body.Elder : (hash & 1 ? Body.Woman : Body.Man);
    }
    const wantW = ((hash >>> 9) & 1023) / 1024 < this.winter;
    let pool = (wantW && this.poolsW[b]?.length ? this.poolsW[b] : this.pools[b]) ?? this.pools[Body.Man];
    if (!pool.length) pool = this.pools[Body.Man].length ? this.pools[Body.Man] : this.chars.map((_, i) => i);
    // пожилые: женщины — длинное пальто (как в randomLook), мужчины — короче
    if (b === Body.Elder) {
      const wantF = look[lo + 10] > 0.34 && (hash & 4) !== 0;
      const sub = pool.filter((i) => this.femaleSet.has(i) === wantF);
      if (sub.length) pool = sub;
    }
    return pool[(hash >>> 5) % pool.length];
  }

  /** Цвета регионов человека: стабильно по хешу внешности, палитра осенняя/зимняя (доля зимы — setWinter). */
  private assignColors(id: number, hash: number): void {
    const ch = this.chars[this.stChar[id]];
    const kid = ch.meta.body === 'kid', old = ch.meta.body === 'elder', fem = ch.meta.female;
    const win = ((hash >>> 9) & 1023) / 1024 < this.winter;
    let hs = hash;
    const rnd = () => { hs = Math.imul(hs ^ (hs >>> 15), 2246822519) + 0x9e3779b9 | 0; hs ^= hs >>> 13; return ((hs >>> 0) % 100000) / 100000; };
    const pick = (p: number[]) => p[Math.floor(rnd() * p.length) % p.length];
    const jit = (hex: number, k = 0.12) => {
      const f = 1 + (rnd() - 0.5) * 2 * k;
      const r = Math.min(255, Math.round(((hex >> 16) & 255) * f)), g = Math.min(255, Math.round(((hex >> 8) & 255) * f)), b = Math.min(255, Math.round((hex & 255) * f));
      return r * 65536 + g * 256 + b;
    };
    const top = win ? (kid ? W_TOP_KID : W_TOP) : kid ? P_TOP_KID : old ? P_TOP_OLD : fem ? P_TOP_F : P_TOP_M;
    const bot = win ? W_BOTTOM : fem && !kid ? P_BOTTOM_F : P_BOTTOM;
    const o = id * 8;
    this.stCol[o] = jit(pick(top));
    this.stCol[o + 1] = jit(pick(bot));
    this.stCol[o + 2] = jit(pick(kid ? P_SHOES_KID : P_SHOES), 0.08);
    const hc = ch.meta.hairColor;
    this.stCol[o + 3] = hc ? jit(Math.round(hc[0] * 255) * 65536 + Math.round(hc[1] * 255) * 256 + Math.round(hc[2] * 255), 0.06)
      : jit(pick(old ? P_GREY : P_HAIR), 0.1);
    this.stCol[o + 4] = jit(pick(kid ? P_HAT_KID : P_HAT));
    this.stCol[o + 5] = jit(pick(P_INNER), 0.06);
    this.stCol[o + 6] = jit(pick(P_SCARF));
    this.stCol[o + 7] = jit(pick(P_GLOVES), 0.06);
  }

  // ------------------------------------------------------------------ сезон
  /**
   * Сезон одежды: 0 — осень, 1 — зима; дробное — доля «зимних» людей. Зимой выбираются зимние варианты персонажей
   * (пальто/куртки, шапки, шарфы, перчатки) и тёмная тяжёлая палитра; дети — ярко. Выбор у каждого человека
   * стабилен (по хешу внешности); при смене значения все переодеваются в следующем кадре.
   */
  setWinter(f: number): void {
    const v = Math.max(0, Math.min(1, f));
    if (Math.abs(v - this.winter) < 1e-3) return;
    this.winter = v;
    this.stChar.fill(-1);
  }
  setSeason(season: 'autumn' | 'winter'): void { this.setWinter(season === 'winter' ? 1 : 0); }
  get winterAmount(): number { return this.winter; }

  private ensure(id: number): void {
    if (id < this.stChar.length) return;
    const n = Math.max(id + 1, this.stChar.length * 2, 1024);
    const grow = <T extends Int16Array | Uint32Array | Int8Array | Float32Array>(a: T, fill = 0): T => {
      const b = new (a.constructor as new (n: number) => T)(n);
      b.fill(fill as never);
      b.set(a as never);
      return b;
    };
    this.stChar = grow(this.stChar, -1); this.stHash = grow(this.stHash); this.stClip = grow(this.stClip, -1);
    this.stPrev = grow(this.stPrev); this.stSwitch = grow(this.stSwitch, -1e9); this.stPrevT = grow(this.stPrevT);
    this.stSeen = grow(this.stSeen); this.stStart = grow(this.stStart);
    this.stPX = grow(this.stPX); this.stPZ = grow(this.stPZ); this.stSpeed = grow(this.stSpeed); this.stCyc = grow(this.stCyc);
    this.stFade = grow(this.stFade, FADE);
    const col = new Float32Array(n * 8); col.set(this.stCol); this.stCol = col;
  }

  // ------------------------------------------------------------------ рэгдоллы (RagdollSkin)
  private charOf(agent: number): Character | null {
    if (!this.stats.ready || agent < 0) return null;
    this.ensure(agent);
    if (this.stChar[agent] < 0) {
      // ещё ни разу не рисовался glTF-видом (был вне кадра) — выбрать персонажа по внешности
      if (!this.lookRef) return null;
      const lo = agent * LOOK_STRIDE, h = lookHash(this.lookRef, lo);
      this.stHash[agent] = h;
      this.stChar[agent] = this.pick(h, this.lookRef, lo, null, 0);
      this.assignColors(agent, h);
    }
    return this.chars[this.stChar[agent]];
  }

  /** Суставы персонажа в позе «стоит» (1-й кадр idle), модель агента: рост 1.75, ноги в 0 — по ним строится рэгдолл. */
  shape(agent: number): RagdollJoints | null {
    const ch = this.charOf(agent);
    if (!ch) return null;
    const P = (bone: string, tip?: string) => this.posedJoint(ch, ch.idle0, bone, tip).multiplyScalar(ch.k);
    return {
      hips: P('Hips'), spine: P('LowerBack'), neck: P('Neck'), head: P('Neck1'), headTop: P('Head', 'Head'),
      shoulderL: P('LeftArm'), elbowL: P('LeftForeArm'), wristL: P('LeftHand'), handL: P('LeftHand', 'LeftHand'),
      shoulderR: P('RightArm'), elbowR: P('RightForeArm'), wristR: P('RightHand'), handR: P('RightHand', 'RightHand'),
      hipL: P('LeftUpLeg'), kneeL: P('LeftLeg'), ankleL: P('LeftFoot'), toeL: P('LeftFoot', 'LeftFoot'),
      hipR: P('RightUpLeg'), kneeR: P('RightLeg'), ankleR: P('RightFoot'), toeR: P('RightFoot', 'RightFoot'),
    };
  }

  /** Сустав (или «кончик» кости) в позе по матрицам скиннинга rows (3×4 на кость), модель персонажа. */
  private posedJoint(ch: Character, rows: ArrayLike<number>, bone: string, tip?: string): THREE.Vector3 {
    const j = ch.boneNames.indexOf(bone);
    const r = tip ? ch.meta.tips[tip] : ch.meta.joints[bone];
    const o = j * 12;
    return new THREE.Vector3(
      rows[o] * r[0] + rows[o + 1] * r[1] + rows[o + 2] * r[2] + rows[o + 3],
      rows[o + 4] * r[0] + rows[o + 5] * r[1] + rows[o + 6] * r[2] + rows[o + 7],
      rows[o + 8] * r[0] + rows[o + 9] * r[1] + rows[o + 10] * r[2] + rows[o + 11]);
  }

  /** Строка кадра клипа (half-float текстура) -> 3×4 на кость, модель персонажа. */
  private clipRows(ch: Character, clip: number, f: number, out: Float32Array): Float32Array {
    const data = ch.tex.image.data as Uint16Array;
    const W = ch.boneNames.length * 3;
    const row = ch.clipRow[clip] + Math.max(0, Math.min(ch.clipLen[clip] - 1, f));
    const base = row * W * 4;
    for (let k = 0; k < W * 4; k++) out[k] = THREE.DataUtils.fromHalfFloat(data[base + k]);
    return out;
  }

  /** Сбитый человек — тот же glTF-персонаж, кости ведут тела Rapier (поза «стоит» из 1-го кадра idle). */
  attach(slot: number, agent: number, x: number, y: number, z: number, yaw: number, bodies: readonly RAPIER.RigidBody[], parts: readonly string[], s = 1): boolean {
    const ch = this.charOf(agent);
    if (!ch) return false;
    this.disposeSlot(slot);
    this.endGetup(agent, false);
    const r = this.makeSingle(ch, agent, 'people_ragdoll_' + slot);
    // A_P = W_P(0)^-1 · L, L = T(x,y,z)·R(yaw)·S(k·s) — тела построены по тем же суставам (shape)
    const L = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(ch.k * s, ch.k * s, ch.k * s));
    const A = bodies.map((rb) => bodyMatrix(rb, new THREE.Matrix4()).invert().multiply(L));
    const part = ch.boneNames.map((n) => parts.indexOf(BONE_PART[n] ?? 'torso'));
    this.rag[slot] = { ...r, A, part, idle0: ch.idle0, agent, ch: this.stChar[agent], s };
    this.update(slot, bodies);
    return true;
  }

  /** Отдельный меш на одного человека с собственной 1-строчной текстурой матриц (мир). */
  private makeSingle(ch: Character, agent: number, name: string): { b: Bucket; tex: THREE.DataTexture; data: Float32Array; mat: THREE.Material; depth: THREE.Material } {
    const J = ch.boneNames.length;
    const data = new Float32Array(J * 3 * 4);
    const tex = new THREE.DataTexture(data, J * 3, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    const { material, depth } = makeMaterials(ch.material.map, tex, ch.meta.id + '_single');
    const b = new Bucket(ch.geo0, material, depth, 1, true, name);
    b.count = 1;
    b.animA.set([0, 1, 0, 0]);
    if (this.stCol[agent * 8] === 0) this.assignColors(agent, this.stHash[agent]);
    b.c0.set(this.stCol.subarray(agent * 8, agent * 8 + 4));
    b.c1.set(this.stCol.subarray(agent * 8 + 4, agent * 8 + 8));
    new THREE.Matrix4().toArray(b.mesh.instanceMatrix.array as Float32Array, 0);
    b.flush();
    this.root.add(b.mesh);
    return { b, tex, data, mat: material, depth };
  }

  update(slot: number, bodies: readonly RAPIER.RigidBody[]): void {
    const r = this.rag[slot];
    if (!r) return;
    const S = this.tmpS, M = this.tmpM2;
    const J = r.part.length;
    const bm = bodies.map((rb) => bodyMatrix(rb, new THREE.Matrix4()));
    for (let j = 0; j < J; j++) {
      const p = r.part[j];
      const i0 = r.idle0;
      S.set(i0[j * 12], i0[j * 12 + 1], i0[j * 12 + 2], i0[j * 12 + 3], i0[j * 12 + 4], i0[j * 12 + 5], i0[j * 12 + 6], i0[j * 12 + 7],
        i0[j * 12 + 8], i0[j * 12 + 9], i0[j * 12 + 10], i0[j * 12 + 11], 0, 0, 0, 1);
      M.copy(bm[p]).multiply(r.A[p]).multiply(S);
      writeRow(M, r.data, j);
    }
    r.tex.needsUpdate = true;
  }

  /**
   * Рэгдолл отпущен. result != null — человек улёгся: начинается подъём. Поза рэгдолла (матрицы костей в мире)
   * запоминается; клип getup_back (лицом вверх) / getup_front (лицом вниз) ставится так, что его 1-й кадр лежит
   * тазом в точке таза рэгдолла и головой в ту же сторону; за GETUP_BLEND с поза рэгдолла перетекает в клип.
   * В result записываются точка и направление, где человек окажется стоя в конце клипа, — people-system ставит
   * туда агента (а пока клип идёт, держит его лежащим — holdDown). Позы покоя (bind/Т-поза) не видно ни в один кадр.
   */
  detach(slot: number, result: RagdollResult | null): void {
    const r = this.rag[slot];
    if (!r) return;
    this.rag[slot] = null;
    if (!result) { this.disposeSingle(r); return; }
    const ch = this.chars[r.ch];
    const clip = result.faceUp ? C.GetupBack : C.GetupFront;
    const n = ch.clipLen[clip];
    const rows0 = this.clipRows(ch, clip, 0, new Float32Array(ch.boneNames.length * 12));
    const rowsN = this.clipRows(ch, clip, n - 1, new Float32Array(ch.boneNames.length * 12));
    const hips0 = this.posedJoint(ch, rows0, 'Hips'), head0 = this.posedJoint(ch, rows0, 'Head');
    const hipsN = this.posedJoint(ch, rowsN, 'Hips');
    // поворот: голова клипа (кадр 0) -> голова рэгдолла
    const phi = (x: number, z: number) => Math.atan2(x, z);
    const th = phi(result.headX, result.headZ) - phi(head0.x - hips0.x, head0.z - hips0.z);
    const sc = ch.k * r.s;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), th);
    const h0 = hips0.clone().multiplyScalar(sc).applyQuaternion(q);
    let gy = this.opts.heightAt(result.x, result.z);
    if (!Number.isFinite(gy)) gy = result.y - hips0.y * sc; // без высоты земли — по тазу
    const root = new THREE.Matrix4().compose(new THREE.Vector3(result.x - h0.x, gy, result.z - h0.z), q, new THREE.Vector3(sc, sc, sc));
    // где встанет и куда смотрит: конец клипа
    const end = hipsN.clone().applyMatrix4(root);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q); // клип кончается лицом в −Z модели
    result.x = end.x; result.z = end.z;
    if (result.faceUp) { result.headX = -f.x; result.headZ = -f.z; } else { result.headX = f.x; result.headZ = f.z; }
    const g: Getup = { ...r, clip, root, t0: this.time, dur: n / 30, hash: this.stHash[r.agent], captured: r.data.slice(), rows: new Float32Array(rows0.length) };
    this.getups.set(r.agent, g);
  }

  /** Агент ещё поднимается (people-system держит его в состоянии «лежит», пока это true). */
  holdDown(agent: number): boolean {
    const g = this.getups.get(agent);
    return !!g && this.time < g.t0 + g.dur - GETUP_SYS;
  }

  private stepGetups(): void {
    const M = this.tmpM2, C4 = this.tmpS;
    for (const [agent, g] of this.getups) {
      const t = this.time - g.t0;
      if (t >= g.dur + 0.1) { this.endGetup(agent, true); continue; } // +0.1 с: системный GetUp (0.8 с) успевает закончиться
      const ch = this.chars[g.ch];
      const f = Math.min(t * 30, ch.clipLen[g.clip] - 1);
      const f0 = Math.floor(f), fr = f - f0;
      const A = this.clipRows(ch, g.clip, f0, g.rows);
      const Bn = fr > 0.01 ? this.clipRows(ch, g.clip, f0 + 1, new Float32Array(g.rows.length)) : null;
      const w = smooth(0, GETUP_BLEND, t);
      const J = ch.boneNames.length;
      for (let j = 0; j < J; j++) {
        const o = j * 12;
        const v = (k: number) => (Bn ? A[o + k] * (1 - fr) + Bn[o + k] * fr : A[o + k]);
        C4.set(v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7), v(8), v(9), v(10), v(11), 0, 0, 0, 1);
        M.copy(g.root).multiply(C4);
        const e = M.elements;
        for (let k = 0; k < 3; k++) {
          for (let c = 0; c < 4; c++) {
            const clipV = e[c * 4 + k];
            g.data[o + k * 4 + c] = g.captured[o + k * 4 + c] * (1 - w) + clipV * w;
          }
        }
      }
      g.tex.needsUpdate = true;
    }
  }

  /** Конец подъёма: убрать отдельный меш; handoff — плавный переход обычного вида из последнего кадра клипа. */
  private endGetup(agent: number, handoff: boolean): void {
    const g = this.getups.get(agent);
    if (!g) return;
    this.getups.delete(agent);
    this.disposeSingle(g);
    if (handoff && agent < this.stClip.length) {
      this.stClip[agent] = g.clip; // следующий кадр: переход getup(последний кадр) -> текущий клип
      this.stSeen[agent] = this.frame;
    }
  }

  private disposeSingle(r: { b: Bucket; tex: THREE.DataTexture; mat: THREE.Material; depth: THREE.Material }): void {
    this.root.remove(r.b.mesh);
    r.b.mesh.geometry.dispose(); r.b.mesh.dispose();
    r.tex.dispose(); r.mat.dispose(); r.depth.dispose();
  }

  private disposeSlot(slot: number): void {
    const r = this.rag[slot];
    if (!r) return;
    this.rag[slot] = null;
    this.disposeSingle(r);
  }

  end(time: number): void {
    const dt = time - this.time;
    if (dt > 1e-4 && dt < 0.25) this.dt = dt;
    this.time = time;
    if (this.getups.size) this.stepGetups();
    this.proc.end(time);
    let l0 = 0, l1 = 0;
    for (const c of this.chars) { c.lod0.flush(); c.lod1.flush(); l0 += c.lod0.count; l1 += c.lod1.count; }
    const pr = this.proc.stats.near + this.proc.stats.far;
    this.stats.lod0 = l0; this.stats.lod1 = l1; this.stats.proc = pr;
    this.stats.near = l0 + (this.stats.ready ? 0 : this.proc.stats.near);
    this.stats.far = l1 + (this.stats.ready ? pr : this.proc.stats.far);
  }

  dispose(): void {
    this.disposed = true;
    this.proc.dispose();
    for (let i = 0; i < this.rag.length; i++) this.disposeSlot(i);
    for (const a of [...this.getups.keys()]) this.endGetup(a, false);
    for (const c of this.chars) { c.lod0.dispose(); c.lod1.dispose(); c.tex.dispose(); c.material.dispose(); c.depth.dispose(); c.material.map?.dispose(); c.geo0.dispose(); }
    this.chars = [];
  }
}

interface RagSlot {
  b: Bucket; tex: THREE.DataTexture; data: Float32Array; A: THREE.Matrix4[]; part: number[]; idle0: Float32Array;
  mat: THREE.Material; depth: THREE.Material; agent: number; ch: number; s: number;
}
interface Getup extends RagSlot {
  clip: number; root: THREE.Matrix4; t0: number; dur: number; hash: number; captured: Float32Array; rows: Float32Array;
}

/** Матрица -> строки 3×4 кости j. */
function writeRow(M: THREE.Matrix4, out: Float32Array, j: number): void {
  const e = M.elements, o = j * 12;
  for (let k = 0; k < 3; k++) { out[o + k * 4] = e[k]; out[o + k * 4 + 1] = e[4 + k]; out[o + k * 4 + 2] = e[8 + k]; out[o + k * 4 + 3] = e[12 + k]; }
}

/** Кость скелета -> тело рэгдолла (ragdoll.ts RAGDOLL_PARTS). */
const BONE_PART: Record<string, string> = {
  Hips: 'pelvis', LHipJoint: 'pelvis', RHipJoint: 'pelvis', LowerBack: 'torso', Spine: 'torso', Spine1: 'torso', Neck: 'torso',
  LeftShoulder: 'torso', RightShoulder: 'torso', Neck1: 'head', Head: 'head',
  LeftArm: 'uarmL', LeftForeArm: 'farmL', LeftHand: 'farmL', RightArm: 'uarmR', RightForeArm: 'farmR', RightHand: 'farmR',
  LeftUpLeg: 'thighL', LeftLeg: 'shinL', LeftFoot: 'shinL', RightUpLeg: 'thighR', RightLeg: 'shinR', RightFoot: 'shinR',
};

function bodyMatrix(rb: RAPIER.RigidBody, out: THREE.Matrix4): THREE.Matrix4 {
  const t = rb.translation(), q = rb.rotation();
  return out.compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(q.x, q.y, q.z, q.w), new THREE.Vector3(1, 1, 1));
}

/** 0xRRGGBB (sRGB) -> линейный RGB в out[o..o+2]. */
function unpackLinear(f: number, out: Float32Array, o: number): void {
  out[o] = Math.pow(((f >> 16) & 255) / 255, 2.2);
  out[o + 1] = Math.pow(((f >> 8) & 255) / 255, 2.2);
  out[o + 2] = Math.pow((f & 255) / 255, 2.2);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Устойчивый хеш внешности (цвета) — чтобы выбор персонажа не менялся от кадра к кадру. */
function lookHash(look: ArrayLike<number>, lo: number): number {
  let h = 2166136261;
  for (let k = 0; k < 10; k++) {
    h ^= Math.round(look[lo + k] * 4095);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeMaterials(map: THREE.Texture | null, bones: THREE.Texture, id: string): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial; uBones: { value: THREE.Texture } } {
  const uBones = { value: bones };
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.85, metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide });
  material.name = 'people_' + id;
  material.customProgramCacheKey = () => 'nfr-gltf-human';
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uBones = uBones;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + SKIN_GLSL + TINT_GLSL)
      .replace('#include <beginnormal_vertex>', `mat4 nfrM = nfrSkin();
vec3 objectNormal = normalize(mat3(nfrM) * normal);
int nfrR = int(_region + 0.5);
vNfrTint = nfrTint(nfrR);`)
      .replace('#include <begin_vertex>', 'vec3 transformed = (nfrM * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNfrTint;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vNfrTint;');
  };
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.customProgramCacheKey = () => 'nfr-gltf-human-depth';
  depth.onBeforeCompile = (sh) => {
    sh.uniforms.uBones = uBones;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + SKIN_GLSL)
      .replace('#include <begin_vertex>', 'vec3 transformed = (nfrSkin() * vec4(position, 1.0)).xyz;');
  };
  return { material, depth, uBones };
}

function hasRegion(g: THREE.BufferGeometry, r: number): boolean {
  const a = g.getAttribute('_region');
  for (let i = 0; i < a.count; i++) if (Math.round(a.getX(i)) === r) return true;
  return false;
}

/**
 * Геометрия в позе покоя в координатах сцены glTF (как суставы в people.json): позиции через скиннинг в покое
 * (снимает квантование meshopt, у LOD свои bind-матрицы), всё во float.
 */
function restGeometry(sm: THREE.SkinnedMesh): THREE.BufferGeometry {
  // узлы костей glTF уже в позе покоя; скиннинг как при отрисовке (учитывает и bind-матрицы квантования)
  sm.updateMatrixWorld(true);
  const src = sm.geometry;
  const n = src.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  const sn = src.getAttribute('normal');
  for (let i = 0; i < n; i++) {
    sm.getVertexPosition(i, v);
    v.applyMatrix4(sm.matrixWorld);
    v.toArray(pos, i * 3);
    if (sn) { v.fromBufferAttribute(sn, i).normalize(); v.toArray(nrm, i * 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  for (const nm of ['uv', 'skinIndex', 'skinWeight', '_region']) {
    const a = src.getAttribute(nm);
    if (a) g.setAttribute(nm, a);
  }
  g.setIndex(src.getIndex());
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.2);
  return g;
}
