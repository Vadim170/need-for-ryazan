import * as THREE from 'three';
import { createHumanFactory, INSTANCE_ATTRS, type HumanFactory } from './human-factory';

/**
 * Отрисовка пешеходов. Агенты (people-system.ts) отдают на кадр плоские массивы; вид их рисует.
 * Реализация по умолчанию — процедурный человек, два InstancedMesh (ближние с тенями, дальние без) = 2 draw call
 * (+1 на тени). Под glTF/Mixamo: другая реализация того же интерфейса (например, InstancedMesh + VAT или SkinnedMesh для
 * ближних), агентов менять не нужно.
 */
export interface PeopleView {
  readonly root: THREE.Object3D;
  /** Начать кадр: count = 0. time — время кадра (с), чтобы вид знал dt этого кадра до push. */
  begin(time?: number): void;
  /**
   * Добавить человека. m — 16 чисел матрицы (column-major), look — 18 чисел: jacket(3) pants(3) head(4) shape(4) anim(4);
   * near — ближний (тени). body — тип тела (Body из human-factory), необязательно (для выбора glTF-персонажа).
   */
  push(m: ArrayLike<number>, mo: number, look: ArrayLike<number>, lo: number, near: boolean, body?: number): void;
  end(time: number): void;
  /** Необязательно: вид ещё показывает подъём после рэгдолла — система держит агента лежащим (gltf-people-view). */
  holdDown?(agent: number): boolean;
  readonly stats: { near: number; far: number; trisPerHuman: number };
  dispose(): void;
}

const LOOK_STRIDE = 18;
export { LOOK_STRIDE };

class Bucket {
  readonly mesh: THREE.InstancedMesh;
  readonly attrs: { name: string; size: number; arr: Float32Array; attr: THREE.InstancedBufferAttribute }[] = [];
  count = 0;
  constructor(f: HumanFactory, readonly cap: number, shadows: boolean, name: string) {
    const geo = f.geometry.clone();
    for (const [nm, size] of Object.entries(INSTANCE_ATTRS)) {
      const arr = new Float32Array(cap * size);
      const attr = new THREE.InstancedBufferAttribute(arr, size);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(nm, attr);
      this.attrs.push({ name: nm, size, arr, attr });
    }
    this.mesh = new THREE.InstancedMesh(geo, f.material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.customDepthMaterial = f.depthMaterial as THREE.MeshDepthMaterial;
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false; // отсечение делают агенты (по одному на человека)
    this.mesh.count = 0;
    this.mesh.name = name;
  }
  push(m: ArrayLike<number>, mo: number, look: ArrayLike<number>, lo: number): void {
    if (this.count >= this.cap) return;
    const i = this.count++;
    const im = this.mesh.instanceMatrix.array as Float32Array;
    for (let k = 0; k < 16; k++) im[i * 16 + k] = m[mo + k];
    let o = lo;
    for (const a of this.attrs) {
      for (let k = 0; k < a.size; k++) a.arr[i * a.size + k] = look[o + k];
      o += a.size;
    }
  }
  flush(): void {
    this.mesh.count = this.count;
    if (this.count === 0) return;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(0, this.count * 16); im.needsUpdate = true;
    for (const a of this.attrs) {
      a.attr.clearUpdateRanges(); a.attr.addUpdateRange(0, this.count * a.size); a.attr.needsUpdate = true;
    }
  }
}

export class ProceduralPeopleView implements PeopleView {
  readonly root = new THREE.Group();
  readonly stats = { near: 0, far: 0, trisPerHuman: 0 };
  private factory: HumanFactory;
  private nearB: Bucket;
  private farB: Bucket;

  constructor(capacity = 2048, factory: HumanFactory = createHumanFactory()) {
    this.factory = factory;
    this.root.name = 'people';
    this.nearB = new Bucket(factory, Math.min(capacity, 600), true, 'people_near');
    this.farB = new Bucket(factory, capacity, false, 'people_far');
    this.root.add(this.nearB.mesh, this.farB.mesh);
    this.stats.trisPerHuman = factory.geometry.attributes.position.count / 3;
  }

  begin(): void {
    this.nearB.count = 0;
    this.farB.count = 0;
  }

  push(m: ArrayLike<number>, mo: number, look: ArrayLike<number>, lo: number, near: boolean): void {
    if (near && this.nearB.count < this.nearB.cap) this.nearB.push(m, mo, look, lo);
    else this.farB.push(m, mo, look, lo);
  }

  end(time: number): void {
    this.factory.uniforms.uTime.value = time;
    this.nearB.flush();
    this.farB.flush();
    this.stats.near = this.nearB.count;
    this.stats.far = this.farB.count;
  }

  dispose(): void {
    for (const b of [this.nearB, this.farB]) { b.mesh.geometry.dispose(); b.mesh.dispose(); }
    this.factory.material.dispose();
    this.factory.depthMaterial.dispose();
  }
}
