import * as THREE from 'three';

/**
 * Обёртка над THREE.BatchedMesh для машин: одна «мульти-отрисовка» вместо InstancedMesh на каждый вариант/LOD.
 * Геометрии добавляются заранее (общий набор атрибутов), экземпляры — «слотами» по геометрии, создаются по требованию и никогда не
 * удаляются: на кадре заполняются слоты [0, n), остальные скрываются. Отсечение и сортировку делает вызывающий код
 * (perObjectFrustumCulled / sortObjects выключены — один проход по слотам).
 */
export class SlotBatch {
  readonly mesh: THREE.BatchedMesh;
  private geos: { gid: number; ids: number[]; shown: number }[] = [];
  private m = new THREE.Matrix4();
  private c = new THREE.Color();
  private allocated = 0;
  private readonly max: number;

  constructor(material: THREE.Material, geometries: THREE.BufferGeometry[], maxInstances: number) {
    let nv = 0, ni = 0;
    for (const g of geometries) { nv += g.getAttribute('position').count; ni += g.index!.count; }
    this.max = maxInstances;
    this.mesh = new THREE.BatchedMesh(maxInstances, nv, ni, material);
    this.mesh.sortObjects = false;
    this.mesh.perObjectFrustumCulled = false;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    for (const g of geometries) this.geos.push({ gid: this.mesh.addGeometry(g), ids: [], shown: 0 });
    // первый экземпляр создаёт текстуру цветов (определяет USE_BATCHING_COLOR до первой компиляции шейдера)
    const id = this.mesh.addInstance(this.geos[0].gid);
    this.mesh.setColorAt(id, this.c.setRGB(1, 1, 1));
    this.mesh.setVisibleAt(id, false);
    this.geos[0].ids.push(id);
    this.allocated = 1;
  }

  /** Экземпляр i геометрии g: создаёт слот при необходимости, ставит матрицу (16 чисел с offset) и цвет; возвращает instanceId (−1 — батч заполнен). */
  set(g: number, i: number, mat: ArrayLike<number>, off: number, r: number, gg: number, b: number): number {
    const G = this.geos[g];
    let id: number;
    if (i < G.ids.length) id = G.ids[i];
    else {
      if (this.allocated >= this.max) return -1;
      this.allocated++;
      id = this.mesh.addInstance(G.gid);
      G.ids.push(id);
      this.mesh.setVisibleAt(id, false);
    }
    this.m.fromArray(mat as number[], off);
    this.mesh.setMatrixAt(id, this.m);
    this.mesh.setColorAt(id, this.c.setRGB(r, gg, b));
    return id;
  }

  /** После заполнения: видны слоты [0, used) геометрии g, остальные скрыты. */
  commit(g: number, used: number): void {
    const G = this.geos[g];
    const n = Math.min(used, G.ids.length);
    if (n === G.shown) {
      // видимость уже верна, кроме случая «shown > n» — обработано ниже
    }
    for (let k = n; k < G.shown; k++) this.mesh.setVisibleAt(G.ids[k], false);
    for (let k = G.shown; k < n; k++) this.mesh.setVisibleAt(G.ids[k], true);
    G.shown = n;
  }

  get instanceCount(): number { return this.geos.reduce((a, G) => a + G.shown, 0); }
}

/** Пер-экземплярные данные (4 float на экземпляр) для шейдера: DataTexture 512 в ширину, индекс = instanceId BatchedMesh. */
export class InstanceData {
  readonly data: Float32Array;
  readonly tex: THREE.DataTexture;
  static readonly W = 512;
  constructor(maxInstances: number) {
    const rows = Math.ceil(maxInstances / InstanceData.W);
    this.data = new Float32Array(InstanceData.W * rows * 4);
    this.tex = new THREE.DataTexture(this.data, InstanceData.W, rows, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = THREE.NearestFilter; this.tex.magFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;
  }
  set(id: number, a: number, b: number, c: number, d: number): void {
    const o = id * 4;
    this.data[o] = a; this.data[o + 1] = b; this.data[o + 2] = c; this.data[o + 3] = d;
  }
}
