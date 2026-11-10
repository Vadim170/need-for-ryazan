import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * Ассеты «живых» персонажей с CPU-позой (игрок, полицейские, docs/stage3/gta-mode.md): те же MakeHuman-персонажи и
 * CMU-клипы, что у пешеходов (public/assets/people/people.json + clips.bin), плюс клипы игрока
 * (public/assets/player/clips.bin: sprint, jump, punch, kick — assets/scripts/people/build_player_clips.py).
 *
 * Формат кадра клипа (как build_clips.py): на каждую из 23 костей общего скелета кватернион Δ — поворот кости в мире
 * относительно Т-позы, затем смещение таза (x, y, z) в долях длины ноги. Ретаргет: R = Δ · C, C — поза покоя персонажа →
 * Т-поза (кости рук/ног); позиции суставов — по иерархии от таза (см. HumanRig).
 */

export interface RigClip {
  name: string;
  frames: number;
  loop: boolean;
  /** Кадры подряд: frames × frameFloats. */
  data: Float32Array;
  /** Метров на цикл (ходьба/бег) для человека с длиной ноги 0.85 м. */
  strideM?: number;
  rootY?: number;
}

interface CharMeta {
  id: string; file: string; body: string; female: boolean; height: number;
  joints: Record<string, number[]>; tips: Record<string, number[]>; hairColor?: number[] | null; stoop?: number;
}
interface PeopleManifest {
  skeleton: { bones: string[]; parents: (string | null)[]; tposeDirs: Record<string, number[]> };
  clipsFile: string; fps: number; frameFloats: number;
  clips: { name: string; frames: number; loop: boolean; offset: number; strideM?: number; rootY?: number }[];
  characters: CharMeta[];
}

const DIR_TIPS: Record<string, string> = {
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', LeftFoot: 'tip:LeftFoot', RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', RightFoot: 'tip:RightFoot',
  LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', LeftHand: 'tip:LeftHand', RightArm: 'RightForeArm', RightForeArm: 'RightHand', RightHand: 'tip:RightHand',
};

/** Персонаж: геометрия в позе покоя + всё для ретаргета клипов на его скелет. */
export interface RigCharacter {
  id: string;
  meta: CharMeta;
  geometry: THREE.BufferGeometry;
  map: THREE.Texture | null;
  /** Кости меша → индекс в общем скелете. */
  kOf: Int16Array;
  /** Суставы покоя (общий скелет). */
  rest: THREE.Vector3[];
  /** Поворот «поза покоя → Т-поза» на кость общего скелета. */
  Cq: THREE.Quaternion[];
  /** Длина ноги таз–лодыжка (м). */
  L: number;
  height: number;
}

export class RigAssets {
  readonly bones: string[];
  readonly parent: Int16Array;
  readonly boneIndex = new Map<string, number>();
  readonly tposeDirs: THREE.Vector3[];
  readonly fps: number;
  readonly ff: number;
  readonly clips = new Map<string, RigClip>();
  private chars = new Map<string, Promise<RigCharacter>>();
  private loader: GLTFLoader;

  private constructor(readonly manifest: PeopleManifest, private base: string) {
    const sk = manifest.skeleton;
    this.bones = sk.bones;
    this.bones.forEach((b, i) => this.boneIndex.set(b, i));
    this.parent = Int16Array.from(sk.parents.map((p) => (p === null ? -1 : sk.bones.indexOf(p))));
    this.tposeDirs = sk.bones.map((b) => new THREE.Vector3().fromArray(sk.tposeDirs[b] ?? [0, 1, 0]).normalize());
    this.fps = manifest.fps;
    this.ff = manifest.frameFloats;
    this.loader = new GLTFLoader();
    this.loader.setMeshoptDecoder(MeshoptDecoder);
  }

  static async load(peopleBase = '/assets/people/', playerBase = '/assets/player/'): Promise<RigAssets> {
    const man = (await (await fetch(peopleBase + 'people.json')).json()) as PeopleManifest;
    const a = new RigAssets(man, peopleBase);
    const data = new Float32Array(await (await fetch(peopleBase + man.clipsFile)).arrayBuffer());
    for (const c of man.clips) {
      a.clips.set(c.name, { name: c.name, frames: c.frames, loop: c.loop, data: data.subarray(c.offset, c.offset + c.frames * a.ff), strideM: c.strideM, rootY: c.rootY });
    }
    try {
      const pj = await (await fetch(playerBase + 'clips.json')).json() as { frameFloats: number; clips: { name: string; frames: number; loop: boolean; offset: number; strideM?: number }[] };
      if (pj.frameFloats !== a.ff) throw new Error('frameFloats');
      const pd = new Float32Array(await (await fetch(playerBase + 'clips.bin')).arrayBuffer());
      for (const c of pj.clips) {
        a.clips.set(c.name, { name: c.name, frames: c.frames, loop: c.loop, data: pd.subarray(c.offset, c.offset + c.frames * a.ff), strideM: c.strideM });
      }
    } catch (e) {
      console.warn('[player] клипы игрока не загрузились (будут заменены ходьбой/бегом):', e);
    }
    return a;
  }

  /** Список id персонажей по типу тела. */
  ids(filter?: (m: CharMeta) => boolean): string[] {
    return this.manifest.characters.filter((c) => !filter || filter(c)).map((c) => c.id);
  }

  clip(name: string, fallback = 'idle'): RigClip {
    return this.clips.get(name) ?? this.clips.get(fallback)!;
  }

  character(id: string): Promise<RigCharacter> {
    let p = this.chars.get(id);
    if (!p) { p = this.loadChar(id); this.chars.set(id, p); }
    return p;
  }

  private async loadChar(id: string): Promise<RigCharacter> {
    const meta = this.manifest.characters.find((c) => c.id === id) ?? this.manifest.characters[0];
    const gltf = await this.loader.loadAsync(this.base + meta.file);
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    let sm: THREE.SkinnedMesh | null = null;
    scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && (o.name === 'lod0' || !sm)) sm = o as THREE.SkinnedMesh; });
    if (!sm) throw new Error('нет меша lod0');
    const m0 = sm as THREE.SkinnedMesh;
    const geometry = restGeometry(m0);
    const map = (m0.material as THREE.MeshStandardMaterial).map ?? null;
    if (map) { map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4; }
    const kOf = Int16Array.from(m0.skeleton.bones.map((b) => this.boneIndex.get(b.name) ?? 0));
    const rest = this.bones.map((n) => new THREE.Vector3().fromArray(meta.joints[n] ?? [0, 0, 0]));
    const Cq = this.bones.map((n, i) => {
      const q = new THREE.Quaternion();
      const tip = DIR_TIPS[n];
      if (!tip) return q;
      const to = tip.startsWith('tip:') ? new THREE.Vector3().fromArray(meta.tips[tip.slice(4)]) : rest[this.boneIndex.get(tip)!];
      const d = to.clone().sub(rest[i]).normalize();
      return q.setFromUnitVectors(d, this.tposeDirs[i]);
    });
    const L = meta.joints.Hips[1] - 0.5 * (meta.joints.LeftFoot[1] + meta.joints.RightFoot[1]);
    return { id: meta.id, meta, geometry, map, kOf, rest, Cq, L, height: meta.height };
  }
}

/** Геометрия LOD0 в позе покоя (координаты сцены glTF), всё во float — как в gltf-people-view.ts. */
function restGeometry(sm: THREE.SkinnedMesh): THREE.BufferGeometry {
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
  if (!g.getAttribute('_region')) g.setAttribute('_region', new THREE.BufferAttribute(new Float32Array(n), 1));
  g.setIndex(src.getIndex());
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.3);
  return g;
}
