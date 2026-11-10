import * as THREE from 'three';
import type { RAPIER } from '../physics/world';
import type { RigAssets, RigCharacter, RigClip } from './rig-assets';

/**
 * Человек с позой на CPU (игрок, полицейские): тот же glTF-персонаж и CMU-клипы, что у пешеходов, но поза считается
 * каждый кадр на CPU (23 кости — микросекунды) и пишется в маленькую float-текстуру матриц скиннинга (3 текселя на кость).
 * Это позволяет смешивать клипы как угодно: локомоция idle/walk/run/sprint по скорости (общая фаза шага), прыжок,
 * удары (верх тела поверх ходьбы), процедурное прицеливание (руки на цель, наклон головы), «сесть» в машину, лежать,
 * и рэгдолл (кости ведут тела Rapier; интерфейс RagdollSkin через RigRagdollSkin).
 *
 * Один draw call (+ тень) на человека — их немного (игрок + до ~10 полицейских).
 */

export type AimKind = 'none' | 'pistol' | 'rifle';

/**
 * Цвета регионов одежды (0xRRGGBB, sRGB) — те же 8 регионов, что у пешеходов (gltf-people-view.ts, атрибут _region):
 * 1 верх, 2 низ, 3 обувь, 4 волосы, 5 шапка, 6 внутренний верх, 7 шарф, 8 перчатки. Текстуры одежды пешеходов нейтрально-серые
 * (под тон): не заданные shoes/inner/scarf/gloves берутся из палитр пешеходов по случайному зерну рига. Свой персонаж
 * игрока (id player_me*) — обувь и перчатки со своей текстуры (без тона), если не заданы явно.
 */
export interface RigLook { top: number; bottom: number; hat: number; hair: number; shoes?: number; inner?: number; scarf?: number; gloves?: number }

// палитры — как у пешеходов (people/gltf-people-view.ts)
const P_SHOES = [0x1b1b1b, 0x1b1b1b, 0x1b1b1b, 0x1b1b1b, 0x3a2a1e, 0x3a2a1e, 0x5c3e28, 0x5d5f62, 0x22283a];
const P_INNER = [0xe8e6e0, 0xb8babd, 0x9db7d6, 0xd9cdb0, 0x202022, 0xd9b3b3, 0xa9cbb7, 0x6b2230];
const P_SCARF = [0x6b2230, 0xb08a2e, 0x7c7f84, 0xd8cfb8, 0x1f2d4a, 0xa02a2a, 0x2f4a3a, 0xa67b4f, 0x1c1c1e];
const P_GLOVES = [0x1b1b1b, 0x1b1b1b, 0x3a2a1e, 0x4a4c50, 0x22283a];

const UPPER = new Set(['LowerBack', 'Spine', 'Spine1', 'Neck', 'Neck1', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand']);
const ARM_BONES = ['RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'LeftHand'] as const;
/** Направления костей рук при прицеливании (модель: вперёд −Z, вправо +X, вверх +Y), до поворота на тангаж. */
const AIM_DIRS: Record<'pistol' | 'rifle', Record<string, [number, number, number]>> = {
  pistol: {
    RightArm: [-0.3, -0.02, -0.95], RightForeArm: [-0.3, 0.0, -0.95], RightHand: [-0.25, 0.0, -0.97],
    LeftArm: [0.34, -0.06, -0.94], LeftForeArm: [0.28, 0.02, -0.96], LeftHand: [0.2, 0.0, -0.98],
  },
  rifle: {
    RightArm: [0.2, -0.82, -0.36], RightForeArm: [-0.55, 0.15, -0.82], RightHand: [-0.3, 0.05, -0.95],
    LeftArm: [0.42, -0.42, -0.8], LeftForeArm: [0.1, 0.12, -0.99], LeftHand: [0.0, 0.05, -1],
  },
};

/** Руки при перелезании: опора ладонями на верх препятствия перед собой / тянутся вверх (подтянуться). */
const REACH_DIRS: Record<'plant' | 'up', Record<string, [number, number, number]>> = {
  plant: {
    RightArm: [0.2, -0.55, -0.8], RightForeArm: [0.05, -0.75, -0.65], RightHand: [0.0, -0.9, -0.4],
    LeftArm: [-0.2, -0.55, -0.8], LeftForeArm: [-0.05, -0.75, -0.65], LeftHand: [0.0, -0.9, -0.4],
  },
  up: {
    RightArm: [0.15, 0.45, -0.88], RightForeArm: [0.05, 0.35, -0.94], RightHand: [0.0, 0.1, -1.0],
    LeftArm: [-0.15, 0.45, -0.88], LeftForeArm: [-0.05, 0.35, -0.94], LeftHand: [0.0, 0.1, -1.0],
  },
};

const SKIN_GLSL = /* glsl */ `
uniform highp sampler2D uBones;
attribute vec4 skinIndex;
attribute vec4 skinWeight;
mat4 rigBone(float j) {
  ivec2 p = ivec2(int(j) * 3, 0);
  vec4 a = texelFetch(uBones, p, 0), b = texelFetch(uBones, p + ivec2(1, 0), 0), c = texelFetch(uBones, p + ivec2(2, 0), 0);
  return mat4(a.x, b.x, c.x, 0.0, a.y, b.y, c.y, 0.0, a.z, b.z, c.z, 0.0, a.w, b.w, c.w, 1.0);
}
mat4 rigSkin() {
  return rigBone(skinIndex.x) * skinWeight.x + rigBone(skinIndex.y) * skinWeight.y +
    rigBone(skinIndex.z) * skinWeight.z + rigBone(skinIndex.w) * skinWeight.w;
}
`;

function makeMaterials(map: THREE.Texture | null, bones: THREE.Texture, tint: Record<'top' | 'bottom' | 'hat' | 'hair' | 'shoes' | 'inner' | 'scarf' | 'gloves', THREE.Color>) {
  const uBones = { value: bones };
  const u = { uTop: { value: tint.top }, uBottom: { value: tint.bottom }, uHat: { value: tint.hat }, uHair: { value: tint.hair },
    uShoes: { value: tint.shoes }, uInner: { value: tint.inner }, uScarf: { value: tint.scarf }, uGloves: { value: tint.gloves }, uFlash: { value: 0 } };
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.85, metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide });
  material.customProgramCacheKey = () => 'nfr-rig-human';
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uBones = uBones;
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + SKIN_GLSL + `attribute float _region;
uniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uHat; uniform vec3 uHair; uniform vec3 uShoes; uniform vec3 uInner; uniform vec3 uScarf; uniform vec3 uGloves;
varying vec3 vRigTint;`)
      .replace('#include <beginnormal_vertex>', `mat4 rigM = rigSkin();
vec3 objectNormal = normalize(mat3(rigM) * normal);
int rigR = int(_region + 0.5);
vRigTint = rigR == 1 ? uTop : rigR == 2 ? uBottom : rigR == 3 ? uShoes : rigR == 4 ? uHair : rigR == 5 ? uHat : rigR == 6 ? uInner : rigR == 7 ? uScarf : rigR == 8 ? uGloves : vec3(1.0);`)
      .replace('#include <begin_vertex>', 'vec3 transformed = (rigM * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRigTint; uniform float uFlash;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vRigTint;\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.35, 0.25), uFlash);');
  };
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.customProgramCacheKey = () => 'nfr-rig-human-depth';
  depth.onBeforeCompile = (sh) => {
    sh.uniforms.uBones = uBones;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + SKIN_GLSL)
      .replace('#include <begin_vertex>', 'vec3 transformed = (rigSkin() * vec4(position, 1.0)).xyz;');
  };
  return { material, depth, flash: u.uFlash };
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qh = new THREE.Quaternion(), _qa = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);

/** Поза: кватернионы Δ (23×4) + смещение таза (3). */
class PoseBuf {
  readonly q: Float32Array;
  readonly off = new Float32Array(3);
  constructor(n: number) { this.q = new Float32Array(n * 4); }
}

export class HumanRig {
  readonly mesh: THREE.Mesh;
  readonly ready: boolean = true;
  /** Положение ног (мир) и курс (рад, 0 — смотрит на −Z). */
  readonly pos = new THREE.Vector3();
  yaw = 0;
  /** Скорость по земле (м/с) — выбор и темп клипа ходьбы/бега/спринта. */
  speed = 0;
  /** В воздухе (прыжок/падение). */
  airborne = false;
  /** Прицеливание: вид оружия и вес (0..1 плавно), тангаж (рад, + вверх). */
  aim: AimKind = 'none';
  aimPitch = 0;
  /** Руки при перелезании (player/climb.ts): 'plant' — опора на препятствие перед собой, 'up' — тянутся вверх. */
  reach: 'none' | 'plant' | 'up' = 'none';
  /** Сидит (в машине / садится): 0..1. */
  sit = 0;
  /** Лежит: кувырок вокруг X (рад, ±π/2 — на спине/лицом вниз), 0 — стоит. */
  tumble = 0;
  /** Поза «лежит» (клип fallen): 0..1. */
  lying = 0;
  /** Вспышка попадания (красноватый оттенок), затухает сама. */
  hitFlash = 0;
  visible = true;

  private bones: number;
  private Q: PoseBuf; private T: PoseBuf;
  private R: THREE.Quaternion[]; private P: THREE.Vector3[];
  private data: Float32Array; private tex: THREE.DataTexture;
  private flashU: { value: number };
  private phase = 0;
  private vBlend = 0;
  private airT = 0; private airW = 0;
  private aimW = 0;
  private reachW = 0; private reachK: 'plant' | 'up' = 'plant';
  private action: { clip: RigClip; t: number; rate: number; upper: boolean; w: number } | null = null;
  private time = Math.random() * 10;
  private clipsC: { idle: RigClip; walk: RigClip; run: RigClip; jog: RigClip; sprint: RigClip; jump: RigClip; fallen: RigClip; sit: RigClip };
  private rag: { bodies: readonly RAPIER.RigidBody[]; A: THREE.Matrix4[]; part: number[]; S0: Float32Array } | null = null;
  private strideK: number;

  constructor(readonly assets: RigAssets, readonly ch: RigCharacter, look: RigLook, parent: THREE.Object3D) {
    const J = ch.kOf.length;
    this.bones = assets.bones.length;
    this.Q = new PoseBuf(this.bones); this.T = new PoseBuf(this.bones);
    this.R = assets.bones.map(() => new THREE.Quaternion());
    this.P = assets.bones.map(() => new THREE.Vector3());
    this.data = new Float32Array(J * 3 * 4);
    this.tex = new THREE.DataTexture(this.data, J * 3, 1, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;
    const hair = ch.meta.hairColor ? new THREE.Color().fromArray(ch.meta.hairColor) : new THREE.Color(look.hair);
    const own = ch.id.startsWith('player_me');
    const seed = own ? 0 : Math.floor(Math.random() * 1e9); // свой персонаж — стабильно
    const pick = (p: number[], k: number) => p[(seed >>> k) % p.length];
    const { material, depth, flash } = makeMaterials(ch.map, this.tex, {
      top: new THREE.Color(look.top), bottom: new THREE.Color(look.bottom), hat: new THREE.Color(look.hat), hair,
      shoes: new THREE.Color(look.shoes ?? (own ? 0xffffff : pick(P_SHOES, 0))),
      inner: new THREE.Color(look.inner ?? pick(P_INNER, 4)),
      scarf: new THREE.Color(look.scarf ?? pick(P_SCARF, 8)),
      gloves: new THREE.Color(look.gloves ?? (own ? 0xffffff : pick(P_GLOVES, 12))),
    });
    this.flashU = flash;
    this.mesh = new THREE.Mesh(ch.geometry, material);
    this.mesh.customDepthMaterial = depth;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'rig_' + ch.id;
    parent.add(this.mesh);
    const c = (n: string, f = 'idle') => assets.clip(n, f);
    this.clipsC = { idle: c('idle'), walk: c('walk'), run: c('run', 'walk'), jog: c('jog', 'run'), sprint: c('sprint', 'run'), jump: c('jump', 'dodge'), fallen: c('fallen'), sit: c('sit') };
    this.strideK = ch.L / 0.85;
    this.evaluate(0);
  }

  /** Разовое действие: punch / kick / dodge и т.п. upper — только верх тела поверх ходьбы. */
  play(name: string, opts: { upper?: boolean; rate?: number } = {}): void {
    const clip = this.assets.clips.get(name);
    if (!clip) return;
    this.action = { clip, t: 0, rate: opts.rate ?? 1, upper: opts.upper ?? false, w: 0 };
  }
  get acting(): boolean { return !!this.action; }
  /** Время (с) внутри текущего действия, −1 — нет. */
  get actionTime(): number { return this.action ? this.action.t : -1; }

  /** Каждый кадр: обновить позу и матрицу. */
  update(dt: number): void {
    this.time += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4);
    this.flashU.value = this.hitFlash * 0.6;
    this.mesh.visible = this.visible;
    if (!this.visible) return;
    if (this.rag) { this.updateRagdollPose(); return; }
    this.evaluate(dt);
    // матрица: T(pos)·R(yaw)·[кувырок вокруг центра масс]
    const m = this.mesh.matrix;
    _q.setFromAxisAngle(_up, this.yaw);
    m.compose(this.pos, _q, _v.set(1, 1, 1));
    const tb = this.tumble;
    if (tb !== 0) {
      const c = 0.9;
      const lie = -(c - 0.14) * Math.abs(Math.sin(tb));
      _m.makeTranslation(0, c + lie, 0).multiply(_m2.makeRotationX(tb)).multiply(_m3.makeTranslation(0, -c, 0));
      m.multiply(_m);
    }
    this.mesh.matrixWorldNeedsUpdate = true;
    this.mesh.updateMatrixWorld();
  }

  // ------------------------------------------------------------------ поза
  private sample(clip: RigClip, frame: number, out: PoseBuf): void {
    const ff = this.assets.ff, n = clip.frames, nb = this.bones;
    let f0 = Math.floor(frame), fr = frame - f0;
    if (clip.loop) { f0 = ((f0 % n) + n) % n; } else if (f0 >= n - 1) { f0 = n - 1; fr = 0; } else if (f0 < 0) { f0 = 0; fr = 0; }
    const f1 = clip.loop ? (f0 + 1) % n : Math.min(f0 + 1, n - 1);
    const d = clip.data, o0 = f0 * ff, o1 = f1 * ff;
    const q = out.q;
    for (let b = 0; b < nb; b++) {
      const i0 = o0 + b * 4, i1 = o1 + b * 4;
      let x1 = d[i1], y1 = d[i1 + 1], z1 = d[i1 + 2], w1 = d[i1 + 3];
      const x0 = d[i0], y0 = d[i0 + 1], z0 = d[i0 + 2], w0 = d[i0 + 3];
      if (x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1 < 0) { x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1; }
      let x = x0 + (x1 - x0) * fr, y = y0 + (y1 - y0) * fr, z = z0 + (z1 - z0) * fr, w = w0 + (w1 - w0) * fr;
      const l = Math.hypot(x, y, z, w) || 1;
      x /= l; y /= l; z /= l; w /= l;
      q[b * 4] = x; q[b * 4 + 1] = y; q[b * 4 + 2] = z; q[b * 4 + 3] = w;
    }
    const r0 = o0 + nb * 4, r1 = o1 + nb * 4;
    for (let k = 0; k < 3; k++) out.off[k] = d[r0 + k] + (d[r1 + k] - d[r0 + k]) * fr;
  }

  /** dst = nlerp(dst, src, w) по костям из mask (null — все); rebase: верх тела относительно таза dst. */
  private blend(dst: PoseBuf, src: PoseBuf, w: number, mask: Set<string> | null, rebase: boolean, root: boolean): void {
    if (w <= 0) return;
    const nb = this.bones, names = this.assets.bones, a = dst.q, s = src.q;
    if (rebase) {
      _qh.set(a[0], a[1], a[2], a[3]);
      _qa.set(s[0], s[1], s[2], s[3]).invert();
      _qh.multiply(_qa); // Δhips(dst) · Δhips(src)^-1
    }
    for (let b = 0; b < nb; b++) {
      if (mask && !mask.has(names[b])) continue;
      _q2.set(s[b * 4], s[b * 4 + 1], s[b * 4 + 2], s[b * 4 + 3]);
      if (rebase) _q2.premultiply(_qh);
      _q.set(a[b * 4], a[b * 4 + 1], a[b * 4 + 2], a[b * 4 + 3]);
      _q.slerp(_q2, Math.min(1, w));
      a[b * 4] = _q.x; a[b * 4 + 1] = _q.y; a[b * 4 + 2] = _q.z; a[b * 4 + 3] = _q.w;
    }
    if (root) for (let k = 0; k < 3; k++) dst.off[k] += (src.off[k] - dst.off[k]) * Math.min(1, w);
  }

  private evaluate(dt: number): void {
    const C = this.clipsC, Q = this.Q, T = this.T;
    const fps = this.assets.fps;
    // --- локомоция: веса по скорости, общая фаза шага (клипы выровнены: кадр 0 — левая стопа впереди).
    // Цепочка walk (1.6 м/с) → run (2.7) → jog (3.8, CMU 16_45) → sprint (6.5): у каждого клипа естественная скорость
    // (длина цикла / длительность, как у пешеходов в gltf-people-view.ts); между соседними — смешивание, темп =
    // скорость / смешанная длина цикла (стопа не скользит). Бег трусцой 4.6 м/с — jog в 1.2× (раньше — run в 1.7×:
    // «семенящие» ноги, 4.5 шага/с). Sprint (143_01, плохо замкнут — правая стопа скользит) не подмешивается к трусце.
    // Веса — по сглаженной скорости (без дёрганья на рывках), темп — по фактической.
    const v = this.speed;
    this.vBlend += (v - this.vBlend) * Math.min(1, dt * 10);
    const vb = this.vBlend;
    const sk = this.strideK;
    const loco = [C.walk, C.run, C.jog, C.sprint];
    const strides = loco.map((c) => (c.strideM ?? 1.5) * sk);
    const nat = loco.map((c, i) => strides[i] / (c.frames / fps));
    const lw = [0, 0, 0, 0];
    const band = (a: number, b: number) => { const t = Math.min(1, Math.max(0, (vb - a) / Math.max(0.05, b - a))); return t * t * (3 - 2 * t); };
    // пороги переходов: walk→run, run→jog — вокруг естественных скоростей; jog→sprint — ближе к спринту
    const edges: [number, number][] = [[nat[0] * 1.12, nat[1] * 0.98], [nat[1] * 1.02, nat[2] * 0.98], [Math.max(nat[2] * 1.35, 5.2), nat[3] * 0.97]];
    let k = 0;
    while (k < 3 && vb >= edges[k][1]) k++;
    if (k < 3 && vb > edges[k][0]) { const t = band(edges[k][0], edges[k][1]); lw[k] = 1 - t; lw[k + 1] = t; } else lw[k] = 1;
    const tMove = band(0.12, 0.75);
    const wI = 1 - tMove;
    for (let i = 0; i < 4; i++) lw[i] *= tMove;
    const sw = lw[0] + lw[1] + lw[2] + lw[3];
    const stride = sw > 0 ? (lw[0] * strides[0] + lw[1] * strides[1] + lw[2] * strides[2] + lw[3] * strides[3]) / sw : strides[0];
    this.phase += (Math.max(v, 0.3 * (1 - wI)) * dt) / stride;
    this.phase -= Math.floor(this.phase);
    const ph = this.phase;
    // база: idle
    this.sample(C.idle, this.time * fps, Q);
    const layer = (clip: RigClip, w: number) => { if (w > 0.001) { this.sample(clip, ph * clip.frames, T); this.blend(Q, T, w, null, false, true); } };
    // нормированные веса без idle: последовательное смешивание (вес каждого — доля от накопленного)
    let acc = wI;
    for (let i = 0; i < 4; i++) {
      const clip = loco[i], w = lw[i];
      if (w <= 0) continue;
      acc += w;
      layer(clip, w / acc);
    }
    // --- прыжок/полёт
    if (this.airborne) this.airT += dt; else this.airT = 0;
    this.airW += ((this.airborne ? 1 : 0) - this.airW) * Math.min(1, dt * (this.airborne ? 12 : 9));
    if (this.airW > 0.01) {
      this.sample(C.jump, Math.min(this.airT * fps * 1.1, C.jump.frames - 1), T);
      T.off[0] = 0; T.off[1] = 0; T.off[2] = 0; // высоту даёт физика (капсула)
      this.blend(Q, T, this.airW, null, false, true);
    }
    // --- сидит (садится в машину)
    if (this.sit > 0.01) {
      this.sample(C.sit, this.time * fps * 0.2, T);
      T.off[1] = Math.min(T.off[1], -0.35);
      this.blend(Q, T, this.sit, null, false, true);
    }
    // --- лежит
    if (this.lying > 0.01) {
      this.sample(C.fallen, this.time * fps, T);
      this.blend(Q, T, this.lying, null, false, true);
    }
    // --- разовое действие
    const A = this.action;
    if (A) {
      A.t += dt * A.rate;
      const dur = (A.clip.frames - 1) / fps;
      const fadeIn = Math.min(1, A.t / 0.08), fadeOut = Math.min(1, (dur - A.t) / 0.15);
      A.w = Math.max(0, Math.min(fadeIn, fadeOut));
      if (A.t >= dur) this.action = null;
      else {
        this.sample(A.clip, A.t * fps, T);
        if (A.upper) this.blend(Q, T, A.w, UPPER, true, false);
        else { T.off[1] = Math.min(T.off[1], Q.off[1] + 0.05); this.blend(Q, T, A.w, null, false, true); }
      }
    }
    // --- прицеливание: руки на цель
    this.aimW += ((this.aim !== 'none' ? 1 : 0) - this.aimW) * Math.min(1, dt * 14);
    if (this.aimW > 0.01 && this.aim !== 'none') this.applyAim(this.aim, this.aimW);
    // --- руки при перелезании
    if (this.reach !== 'none') this.reachK = this.reach;
    this.reachW += ((this.reach !== 'none' ? 1 : 0) - this.reachW) * Math.min(1, dt * 16);
    if (this.reachW > 0.01) this.applyDirs(REACH_DIRS[this.reachK], this.reachW);
    this.solve();
  }

  /** Направления костей рук (модель: вперёд −Z, вверх +Y) с весом w. */
  private applyDirs(dirs: Record<string, [number, number, number]>, w: number): void {
    const names = this.assets.bones, td = this.assets.tposeDirs, q = this.Q.q;
    for (const bn of ARM_BONES) {
      const b = names.indexOf(bn);
      const d = dirs[bn];
      _v.set(d[0], d[1], d[2]).normalize();
      _q2.setFromUnitVectors(td[b], _v);
      _q.set(q[b * 4], q[b * 4 + 1], q[b * 4 + 2], q[b * 4 + 3]).slerp(_q2, w);
      q[b * 4] = _q.x; q[b * 4 + 1] = _q.y; q[b * 4 + 2] = _q.z; q[b * 4 + 3] = _q.w;
    }
  }

  private applyAim(kind: 'pistol' | 'rifle', w: number): void {
    const names = this.assets.bones, td = this.assets.tposeDirs, q = this.Q.q;
    const dirs = AIM_DIRS[kind];
    const p = Math.max(-1.1, Math.min(1.1, this.aimPitch));
    const cp = Math.cos(p), sp = Math.sin(p);
    for (const bn of ARM_BONES) {
      const b = names.indexOf(bn);
      const d = dirs[bn];
      // поворот на тангаж вокруг X: (x, y, z) → (x, y·cos − z·sin… ) с «вперёд» −Z, вверх +Y
      _v.set(d[0], d[1] * cp - d[2] * sp, d[1] * sp + d[2] * cp).normalize();
      _q2.setFromUnitVectors(td[b], _v);
      _q.set(q[b * 4], q[b * 4 + 1], q[b * 4 + 2], q[b * 4 + 3]).slerp(_q2, w);
      q[b * 4] = _q.x; q[b * 4 + 1] = _q.y; q[b * 4 + 2] = _q.z; q[b * 4 + 3] = _q.w;
    }
    // голова и грудь — вслед за тангажом
    for (const [bn, k] of [['Spine1', 0.25], ['Neck', 0.3], ['Head', 0.35]] as [string, number][]) {
      const b = names.indexOf(bn);
      _qh.setFromAxisAngle(_v2.set(1, 0, 0), p * k * w);
      _q.set(q[b * 4], q[b * 4 + 1], q[b * 4 + 2], q[b * 4 + 3]).premultiply(_qh);
      q[b * 4] = _q.x; q[b * 4 + 1] = _q.y; q[b * 4 + 2] = _q.z; q[b * 4 + 3] = _q.w;
    }
  }

  /** Δ → мировые повороты и позиции суставов → матрицы скиннинга в текстуру. */
  private solve(): void {
    const ch = this.ch, nb = this.bones, par = this.assets.parent, q = this.Q.q, R = this.R, P = this.P, rest = ch.rest;
    for (let b = 0; b < nb; b++) {
      R[b].set(q[b * 4], q[b * 4 + 1], q[b * 4 + 2], q[b * 4 + 3]).multiply(ch.Cq[b]);
      const p = par[b];
      if (p < 0) {
        const o = this.Q.off;
        P[b].set(rest[b].x + o[0] * ch.L, rest[b].y + o[1] * ch.L, rest[b].z + o[2] * ch.L);
      } else {
        _v.copy(rest[b]).sub(rest[p]).applyQuaternion(R[p]);
        P[b].copy(P[p]).add(_v);
      }
    }
    const kOf = ch.kOf, D = this.data;
    for (let j = 0; j < kOf.length; j++) {
      const b = kOf[j];
      _m.makeRotationFromQuaternion(R[b]);
      const e = _m.elements;
      _v.copy(rest[b]).applyQuaternion(R[b]);
      const tx = P[b].x - _v.x, ty = P[b].y - _v.y, tz = P[b].z - _v.z;
      const o = j * 12;
      D[o] = e[0]; D[o + 1] = e[4]; D[o + 2] = e[8]; D[o + 3] = tx;
      D[o + 4] = e[1]; D[o + 5] = e[5]; D[o + 6] = e[9]; D[o + 7] = ty;
      D[o + 8] = e[2]; D[o + 9] = e[6]; D[o + 10] = e[10]; D[o + 11] = tz;
    }
    this.tex.needsUpdate = true;
  }

  /** Мировая позиция сустава (после update). */
  joint(name: string, out: THREE.Vector3): THREE.Vector3 {
    const b = this.assets.boneIndex.get(name) ?? 0;
    if (this.rag) {
      const t = this.rag.bodies[name.includes('Hand') ? (name.startsWith('Right') ? 6 : 5) : name === 'Head' ? 2 : 1].translation();
      return out.set(t.x, t.y, t.z);
    }
    return out.copy(this.P[b]).applyMatrix4(this.mesh.matrixWorld);
  }

  /** Мировая матрица кисти (поворот кости + позиция) — для оружия в руке. */
  handMatrix(right: boolean, out: THREE.Matrix4): THREE.Matrix4 {
    const b = this.assets.boneIndex.get(right ? 'RightHand' : 'LeftHand') ?? 0;
    out.compose(this.P[b], this.R[b], _v2.set(1, 1, 1));
    return out.premultiply(this.mesh.matrixWorld);
  }

  // ------------------------------------------------------------------ рэгдолл (RigRagdollSkin)
  attachRagdoll(bodies: readonly RAPIER.RigidBody[], parts: readonly string[]): void {
    const S0 = this.data.slice();
    const L = this.mesh.matrixWorld.clone();
    const A = bodies.map((rb) => bodyMatrix(rb, new THREE.Matrix4()).invert().multiply(L));
    const part = this.ch.kOf.length ? Array.from(this.ch.kOf, (b) => parts.indexOf(BONE_PART[this.assets.bones[b]] ?? 'torso')) : [];
    this.rag = { bodies, A, part, S0 };
    this.mesh.matrix.identity();
    this.mesh.matrixWorldNeedsUpdate = true;
    this.mesh.updateMatrixWorld();
  }
  detachRagdoll(): void { this.rag = null; }
  get ragdolled(): boolean { return !!this.rag; }

  private updateRagdollPose(): void {
    const r = this.rag!;
    const D = this.data;
    const bm = r.bodies.map((rb, i) => bodyMatrix(rb, new THREE.Matrix4()).multiply(r.A[i]));
    for (let j = 0; j < r.part.length; j++) {
      const o = j * 12, S = r.S0;
      _m2.set(S[o], S[o + 1], S[o + 2], S[o + 3], S[o + 4], S[o + 5], S[o + 6], S[o + 7], S[o + 8], S[o + 9], S[o + 10], S[o + 11], 0, 0, 0, 1);
      _m.copy(bm[Math.max(0, r.part[j])]).multiply(_m2);
      const e = _m.elements;
      D[o] = e[0]; D[o + 1] = e[4]; D[o + 2] = e[8]; D[o + 3] = e[12];
      D[o + 4] = e[1]; D[o + 5] = e[5]; D[o + 6] = e[9]; D[o + 7] = e[13];
      D[o + 8] = e[2]; D[o + 9] = e[6]; D[o + 10] = e[10]; D[o + 11] = e[14];
    }
    this.tex.needsUpdate = true;
    const p = r.bodies[0].translation();
    this.pos.set(p.x, p.y - 0.95, p.z);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.customDepthMaterial?.dispose();
    this.tex.dispose();
  }
}

/** Кость скелета → тело рэгдолла (people/ragdoll.ts RAGDOLL_PARTS). */
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

/**
 * Скин рэгдолла для HumanRig (people/ragdoll.ts RagdollPool.skin): agent — номер, выданный register().
 */
export class RigRagdollSkin {
  private rigs = new Map<number, HumanRig>();
  private bySlot = new Map<number, HumanRig>();
  private next = 1;
  register(rig: HumanRig): number { const id = this.next++; this.rigs.set(id, rig); return id; }
  unregister(id: number): void { this.rigs.delete(id); }
  attach(slot: number, agent: number, _x: number, _y: number, _z: number, _yaw: number, bodies: readonly RAPIER.RigidBody[], parts: readonly string[]): boolean {
    const rig = this.rigs.get(agent);
    if (!rig) return false;
    rig.attachRagdoll(bodies, parts);
    this.bySlot.set(slot, rig);
    return true;
  }
  update(slot: number): void { /* поза считается в HumanRig.update */ void slot; }
  detach(slot: number): void { this.bySlot.get(slot)?.detachRagdoll(); this.bySlot.delete(slot); }
}
