import * as THREE from 'three';
import { SlotBatch } from '../vehicles/procedural/batch';

/**
 * Припаркованные процедурные машины на двух THREE.BatchedMesh (ближний LOD0 с тенью, дальний LOD1 + «коробка»-импостор дальше FAR_BOX м):
 * всего 2 draw call'а вместо ~2 на вид (Props.addParkedCarModels принимает такие пулы вместо InstancedMesh-пулов).
 * Интерфейс PoolLike совпадает с тем, что Props использует у своего Pool (count / addBlock / addOne / commit / begin).
 */
export interface KindDataLike { n: number; mat: Float32Array; col: Float32Array; ext: Float32Array; xz: Float32Array }
export interface PoolLike {
  count: number;
  onBefore: ((r: THREE.WebGLRenderer) => void) | null;
  mesh: { dispose(): void };
  /** Перед заполнением: позиция камеры (выбор LOD по дистанции). */
  begin?(cx: number, cz: number): void;
  addBlock(d: KindDataLike): void;
  addOne(d: KindDataLike, i: number): void;
  commit(): void;
}

/** Дальше этого расстояния (м) — «коробка» (~50 треугольников) вместо LOD1. */
export const FAR_BOX = 190;

export interface ParkedBatchDef { near: THREE.BufferGeometry; far: THREE.BufferGeometry; box: THREE.BufferGeometry }

export class ParkedBatch {
  readonly nearB: SlotBatch; readonly farB: SlotBatch;
  readonly objects: THREE.Object3D[];
  private cx = 0; private cz = 0;
  private nearPools: PoolLike[] = []; private farPools: PoolLike[] = [];

  constructor(material: THREE.Material, defs: ParkedBatchDef[], maxNear = 1500, maxFar = 7000) {
    this.nearB = new SlotBatch(material, defs.map((d) => d.near), maxNear);
    this.farB = new SlotBatch(material, defs.flatMap((d) => [d.far, d.box]), maxFar);
    this.nearB.mesh.castShadow = true; this.nearB.mesh.receiveShadow = true;
    this.farB.mesh.receiveShadow = true;
    this.objects = [this.nearB.mesh, this.farB.mesh];
    const self = this;
    defs.forEach((_, i) => {
      // ближний пул: один слот-массив геометрии i
      const near: PoolLike = {
        count: 0, onBefore: null, mesh: { dispose() {} },
        addBlock(d) { for (let k = 0; k < d.n; k++) this.addOne(d, k); },
        addOne(d, k) {
          if (self.nearB.set(i, this.count, d.mat, k * 16, d.col[k * 3], d.col[k * 3 + 1], d.col[k * 3 + 2]) >= 0) this.count++;
        },
        commit() { self.nearB.commit(i, this.count); },
      };
      // дальний пул: LOD1 (геометрия 2i) и коробка (2i+1) по дистанции от камеры
      let c1 = 0, c2 = 0;
      const far: PoolLike = {
        get count() { return c1 + c2; },
        set count(v: number) { if (v === 0) { c1 = 0; c2 = 0; } },
        onBefore: null, mesh: { dispose() {} },
        begin(cx, cz) { self.cx = cx; self.cz = cz; },
        addBlock(d) { for (let k = 0; k < d.n; k++) this.addOne(d, k); },
        addOne(d, k) {
          const dx = d.xz[k * 2] - self.cx, dz = d.xz[k * 2 + 1] - self.cz;
          const box = dx * dx + dz * dz > FAR_BOX * FAR_BOX;
          const g = 2 * i + (box ? 1 : 0);
          if (self.farB.set(g, box ? c2 : c1, d.mat, k * 16, d.col[k * 3], d.col[k * 3 + 1], d.col[k * 3 + 2]) >= 0) { if (box) c2++; else c1++; }
        },
        commit() { self.farB.commit(2 * i, c1); self.farB.commit(2 * i + 1, c2); },
      };
      this.nearPools.push(near); this.farPools.push(far);
    });
  }

  near(i: number): PoolLike { return this.nearPools[i]; }
  far(i: number): PoolLike { return this.farPools[i]; }
}
