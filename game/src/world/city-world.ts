import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createCityMaterials, NODE_KINDS, BUILDING_BASE, type CityMaterials } from './materials';
import { Props } from './props';
import { captureSurface, surfAt, type TileSurface } from './surface-mask';
import { prepBuildingGeometry } from './building-material';
import { buildBalconies } from './balconies';

/** Формат: docs/world-format.md (v1). Всё в координатах игры (Y вверх, север = -Z). */
export interface Manifest {
  version: number;
  baseHeight: number;
  origin: { lat: number; lon: number };
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  terrain: { file: string; cols: number; rows: number; cellSize: number; minX: number; minZ: number };
  tileSize: number;
  tiles: { ix: number; iz: number; file: string; minX: number; minZ: number; maxX: number; maxZ: number; props?: string }[];
  roads: { file: string };
  spawnPoints: SpawnPoint[];
}
export interface RoadGraph {
  nodes: { id: number; x: number; y: number; z: number }[];
  edges: { id: number; from: number; to: number; name?: string; highway?: string; width?: number; points: number[][]; oneway?: boolean; lanesForward?: number; lanesBackward?: number; bridge?: boolean }[];
}
export interface SpawnPoint { x: number; y: number; z: number; heading: number; name?: string }

export interface CityWorldOptions {
  /** Куда смотреть: каталог мира, например '/world/'. */
  baseUrl: string;
  loadRadius?: number;
  unloadRadius?: number;
  maxConcurrent?: number;
}

interface TileState {
  key: string;
  def: Manifest['tiles'][number];
  loading: boolean;
  cancelled: boolean;
  group?: THREE.Group;
  colliders: RAPIER.Collider[];
  colliderTris: number;
}

/** Пытается загрузить манифест; null — если мира нет (404 / SPA-фолбэк Vite отдаёт html). */
export async function tryFetchManifest(baseUrl: string): Promise<Manifest | null> {
  try {
    const r = await fetch(baseUrl + 'manifest.json');
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.version === 1 && Array.isArray(j.tiles) ? (j as Manifest) : null;
  } catch {
    return null;
  }
}

export class CityWorld {
  readonly stats = { tilesLoaded: 0, tilesLoading: 0, colliderTriangles: 0 };
  /** Пропсы (деревья, фонари, машины…): глобальные инстанс-пулы, стримятся вместе с тайлами. */
  readonly props: Props;
  readonly root = new THREE.Group();
  heights!: Float32Array;
  graph!: RoadGraph;
  readonly loadRadius: number;
  readonly unloadRadius: number;
  readonly maxConcurrent: number;
  private tiles = new Map<string, TileState>();
  private loader = new GLTFLoader();
  /** Материалы города (override — подмена по имени glTF-материала до загрузки тайлов, например пути src/rail). */
  readonly mats: CityMaterials;
  private terrainCollider?: RAPIER.Collider;
  private acc = 0;
  private waiters: (() => void)[] = [];

  private constructor(
    readonly manifest: Manifest,
    private opts: CityWorldOptions,
    private physics: PhysicsWorld,
    private scene: THREE.Scene,
    envMap: THREE.Texture | null,
  ) {
    this.loadRadius = opts.loadRadius ?? 600;
    this.unloadRadius = opts.unloadRadius ?? 800;
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.mats = createCityMaterials(envMap);
    this.props = new Props(physics, scene);
    this.props.setEnvMap(envMap);
    for (const t of manifest.tiles) {
      this.tiles.set(`${t.ix}_${t.iz}`, { key: `${t.ix}_${t.iz}`, def: t, loading: false, cancelled: false, colliders: [], colliderTris: 0 });
    }
    scene.add(this.root);
  }

  static async create(
    manifest: Manifest,
    opts: CityWorldOptions,
    physics: PhysicsWorld,
    scene: THREE.Scene,
    envMap: THREE.Texture | null,
  ): Promise<CityWorld> {
    const w = new CityWorld(manifest, opts, physics, scene, envMap);
    const [hbuf, graph] = await Promise.all([
      fetch(opts.baseUrl + manifest.terrain.file).then((r) => {
        if (!r.ok) throw new Error('heightmap: ' + r.status);
        return r.arrayBuffer();
      }),
      fetch(opts.baseUrl + manifest.roads.file).then((r) => (r.ok ? r.json() : { nodes: [], edges: [] })) as Promise<RoadGraph>,
    ]);
    const { cols, rows } = manifest.terrain;
    if (hbuf.byteLength !== cols * rows * 4) throw new Error(`heightmap size ${hbuf.byteLength} != ${cols}*${rows}*4`);
    w.heights = new Float32Array(hbuf);
    w.graph = graph;
    w.props.setTerrain(manifest.terrain, w.heights, manifest.tileSize);
    w.props.setRoadGraph(graph.edges as never);
    w.buildTerrainCollider();
    return w;
  }

  get spawnPoints(): SpawnPoint[] {
    return this.manifest.spawnPoints;
  }

  /**
   * Rapier heightfield: `heights` — column-major, длина (nrows+1)*(ncols+1), index = col*(nrows+1)+row;
   * col идёт вдоль X, row вдоль Z (проверено тестом checkTerrain, см. README). scale — полные размеры по X и Z.
   * Heightmap контракта: row-major, строка 0 = север (min Z), столбец 0 = min X — т.е. row растёт с +Z, col с +X.
   */
  private buildTerrainCollider(): void {
    const { cols, rows, cellSize, minX, minZ } = this.manifest.terrain;
    const h = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) h[c * rows + r] = this.heights[r * cols + c];
    const sx = (cols - 1) * cellSize, sz = (rows - 1) * cellSize;
    const desc = RAPIER.ColliderDesc.heightfield(rows - 1, cols - 1, h, { x: sx, y: 1, z: sz })
      .setTranslation(minX + sx / 2, 0, minZ + sz / 2)
      .setFriction(1);
    this.terrainCollider = this.physics.world.createCollider(desc);
  }

  /** Высота рельефа (bilinear по heightmap); вне карты — ближайший край. */
  /** Растры покрытий загруженных тайлов (GTA-режим: вода, звук шагов). */
  private surfaces = new Map<string, TileSurface>();
  /** Код покрытия SURF (world/surface-mask.ts) в точке; −1 — тайл не загружен. */
  surfaceAt(x: number, z: number): number {
    for (const s of this.surfaces.values()) {
      const c = surfAt(s, x, z);
      if (c >= 0) return c;
    }
    return -1;
  }

  heightAt(x: number, z: number): number {
    const { cols, rows, cellSize, minX, minZ } = this.manifest.terrain;
    const fx = Math.min(Math.max((x - minX) / cellSize, 0), cols - 1.0001);
    const fz = Math.min(Math.max((z - minZ) / cellSize, 0), rows - 1.0001);
    const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r;
    const H = this.heights, i = r * cols + c;
    return (H[i] * (1 - tx) + H[i + 1] * tx) * (1 - tz) + (H[i + cols] * (1 - tx) + H[i + cols + 1] * tx) * tz;
  }

  private distTo(t: Manifest['tiles'][number], x: number, z: number): number {
    const dx = Math.max(t.minX - x, 0, x - t.maxX), dz = Math.max(t.minZ - z, 0, z - t.maxZ);
    return Math.hypot(dx, dz);
  }

  /** Вызывать каждый кадр; сам ограничивает частоту пересчёта. */
  update(pos: THREE.Vector3, dt: number): void {
    this.acc += dt;
    if (this.acc < 0.2) return;
    this.acc = 0;
    this.schedule(pos);
  }

  private schedule(pos: THREE.Vector3): void {
    const want: { t: TileState; d: number }[] = [];
    for (const t of this.tiles.values()) {
      const d = this.distTo(t.def, pos.x, pos.z);
      const present = t.group || t.loading;
      if (present && d > this.unloadRadius) this.unload(t);
      else if (!present && d < this.loadRadius) want.push({ t, d });
    }
    want.sort((a, b) => a.d - b.d);
    let loading = this.stats.tilesLoading;
    for (const { t } of want) {
      if (loading >= this.maxConcurrent) break;
      this.startLoad(t);
      loading++;
    }
  }

  /** Дождаться, пока загрузятся все тайлы в радиусе от точки (для старта/телепорта). */
  async preload(pos: THREE.Vector3, radius: number): Promise<void> {
    const need = () => [...this.tiles.values()].filter((t) => this.distTo(t.def, pos.x, pos.z) < radius && !t.group);
    this.schedule(pos);
    while (need().length) {
      await new Promise<void>((res) => this.waiters.push(res));
      this.schedule(pos);
    }
  }

  private startLoad(t: TileState): void {
    t.loading = true;
    t.cancelled = false;
    this.stats.tilesLoading++;
    const propsP = t.def.props
      ? fetch(this.opts.baseUrl + t.def.props).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      : Promise.resolve(null);
    Promise.all([this.loader.loadAsync(this.opts.baseUrl + t.def.file), propsP])
      .then(([gltf, props]) => {
        if (t.cancelled) { this.disposeObject(gltf.scene, true); return; }
        const surf = captureSurface(gltf.scene, t.def); // растр покрытий (трава, стили оград) — до переработки сцены
        this.surfaces.set(t.key, surf);
        this.finishLoad(t, gltf.scene);
        this.props.addTile(t.key, props, t.def, surf);
      })
      .catch((e) => console.warn('tile load failed', t.key, e))
      .finally(() => {
        t.loading = false;
        this.stats.tilesLoading--;
        const w = this.waiters.splice(0);
        w.forEach((f) => f());
      });
  }

  /**
   * Ноды тайла: коллайдеры → trimesh (не рисуются); terrain из glb игнорируется; многоматериальные ноды
   * (roads/sidewalks/areas/buildings) склеиваются в один меш с атрибутом aKind (см. materials.ts) — 1 draw call на ноду.
   */
  private finishLoad(t: TileState, scene: THREE.Group): void {
    const group = new THREE.Group();
    group.name = 'tile_' + t.key;
    group.matrixAutoUpdate = false;
    scene.updateMatrixWorld(true);
    const disposeOld = (m: THREE.Mesh) => { m.geometry.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose()); };
    for (const node of [...scene.children]) {
      const meshes: THREE.Mesh[] = [];
      node.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
      if (node.name === 'balconies') { const b = buildBalconies(node); if (b) group.add(b); continue; } // здания v2: инстансы балконов
      if (!meshes.length) continue;
      const isCollider = node.userData.collider === true || node.name.endsWith('_colliders') || meshes.some((m) => m.userData.collider === true);
      if (isCollider) {
        for (const m of meshes) { this.addTrimesh(t, m); disposeOld(m); }
        continue;
      }
      if (node.name === 'terrain') { meshes.forEach(disposeOld); continue; } // рельеф строим из heightmap
      const matName = (m: THREE.Mesh) => (Array.isArray(m.material) ? m.material[0] : m.material).name;
      const kinds = NODE_KINDS[node.name];
      const nodeMat = this.mats.forNode(node.name);
      const canMerge = nodeMat && !meshes.some((m) => this.mats.isOverridden(matName(m)));
      const out: THREE.Mesh[] = [];
      if (canMerge) {
        const geos = meshes.map((m) => this.prepGeometry(m, kinds ? Math.max(kinds.indexOf(matName(m)), 0) : 0, node.name === 'buildings' ? matName(m) : null));
        const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
        if (geos.length > 1) geos.forEach((g) => g.dispose());
        if (merged) out.push(new THREE.Mesh(merged, nodeMat));
      } else {
        for (const m of meshes) out.push(new THREE.Mesh(this.prepGeometry(m, kinds ? Math.max(kinds.indexOf(matName(m)), 0) : 0, node.name === 'buildings' ? matName(m) : null), this.mats.byName(matName(m))));
      }
      meshes.forEach(disposeOld);
      for (const mesh of out) {
        mesh.name = node.name;
        mesh.castShadow = node.name === 'buildings' || node.name === 'bridges';
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
      }
    }
    group.add(this.buildTerrainMesh(t.def));
    group.updateMatrixWorld(true);
    this.root.add(group);
    t.group = group;
    this.stats.tilesLoaded++;
  }

  /** Копия геометрии примитива в мировых координатах с единым набором атрибутов (position, normal, uv, aKind[, color]). */
  private prepGeometry(m: THREE.Mesh, kind: number, buildingMat: string | null): THREE.BufferGeometry {
    if (buildingMat !== null) return prepBuildingGeometry(m, buildingMat); // здания: свой набор атрибутов (building-material.ts)
    const src = m.geometry;
    const g = new THREE.BufferGeometry();
    const n = src.getAttribute('position').count;
    g.setAttribute('position', src.getAttribute('position'));
    if (src.getAttribute('normal')) g.setAttribute('normal', src.getAttribute('normal'));
    g.setAttribute('uv', src.getAttribute('uv') ?? new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    g.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(n).fill(kind), 1));
    if (buildingMat !== null) {
      const c = new THREE.Color(BUILDING_BASE[buildingMat] ?? BUILDING_BASE.building_other);
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    if (src.index) g.setIndex(src.index);
    // атрибуты из glTF могут быть interleaved/normalized — mergeGeometries требует одинаковых типов: приводим к Float32
    for (const k of Object.keys(g.attributes)) {
      const a = g.getAttribute(k) as THREE.BufferAttribute;
      if (!(a.array instanceof Float32Array) || (a as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute || a.normalized) {
        const f = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let j = 0; j < a.itemSize; j++) f[i * a.itemSize + j] = a.getComponent(i, j);
        g.setAttribute(k, new THREE.BufferAttribute(f, a.itemSize));
      }
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!m.matrixWorld.equals(new THREE.Matrix4())) g.applyMatrix4(m.matrixWorld);
    if (src.index && !(src.index.array instanceof Uint32Array)) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(src.index.array), 1));
    return g;
  }

  /** Меш рельефа тайла из heightmap (та же триангуляция, что у Rapier и пайплайна; нормали по центральным разностям — без швов). */
  private buildTerrainMesh(def: Manifest['tiles'][number]): THREE.Mesh {
    const { cols, rows, cellSize, minX, minZ } = this.manifest.terrain;
    const H = this.heights;
    const c0 = Math.round((def.minX - minX) / cellSize), r0 = Math.round((def.minZ - minZ) / cellSize);
    const n = Math.round((def.maxX - def.minX) / cellSize) + 1, m = Math.round((def.maxZ - def.minZ) / cellSize) + 1;
    const hAt = (r: number, c: number) => H[Math.min(Math.max(r, 0), rows - 1) * cols + Math.min(Math.max(c, 0), cols - 1)];
    const pos = new Float32Array(n * m * 3), nrm = new Float32Array(n * m * 3);
    for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
      const r = r0 + j, c = c0 + i, k = (j * n + i) * 3;
      pos[k] = minX + c * cellSize; pos[k + 1] = hAt(r, c); pos[k + 2] = minZ + r * cellSize;
      const nx = hAt(r, c - 1) - hAt(r, c + 1), nz = hAt(r - 1, c) - hAt(r + 1, c), l = Math.hypot(nx, 2 * cellSize, nz);
      nrm[k] = nx / l; nrm[k + 1] = 2 * cellSize / l; nrm[k + 2] = nz / l;
    }
    const idx = new Uint32Array((n - 1) * (m - 1) * 6);
    let q = 0;
    for (let j = 0; j < m - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + n, c = b + 1, d = a + 1; // a=(r,c) b=(r+1,c) c=(r+1,c+1) d=(r,c+1)
      idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = a; idx[q++] = c; idx[q++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const mesh = new THREE.Mesh(g, this.mats.terrain);
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  private addTrimesh(t: TileState, mesh: THREE.Mesh): void {
    const g = mesh.geometry;
    const p = g.getAttribute('position');
    const v = new Float32Array(p.count * 3);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      tmp.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
      v.set([tmp.x, tmp.y, tmp.z], i * 3);
    }
    let idx: Uint32Array;
    if (g.index) idx = Uint32Array.from(g.index.array);
    else { idx = new Uint32Array(p.count); for (let i = 0; i < idx.length; i++) idx[i] = i; }
    const c = this.physics.world.createCollider(RAPIER.ColliderDesc.trimesh(v, idx).setFriction(0.6));
    t.colliders.push(c);
    t.colliderTris += idx.length / 3;
    this.stats.colliderTriangles += idx.length / 3;
  }

  private unload(t: TileState): void {
    if (t.loading) { t.cancelled = true; }
    if (t.group) {
      this.root.remove(t.group);
      this.disposeObject(t.group);
      t.group = undefined;
      this.stats.tilesLoaded--;
    }
    this.props.removeTileAll(t.key);
    this.surfaces.delete(t.key);
    for (const c of t.colliders) this.physics.world.removeCollider(c, false);
    this.stats.colliderTriangles -= t.colliderTris;
    t.colliders.length = 0;
    t.colliderTris = 0;
  }

  /** Геометрии тайла уникальны → dispose. Материалы города общие → трогаем только у «сырой» (не обработанной) сцены. */
  private disposeObject(o: THREE.Object3D, disposeMaterials = false): void {
    o.traverse((x) => {
      const m = x as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      if (disposeMaterials) (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm.dispose());
    });
  }

  dispose(): void {
    for (const t of this.tiles.values()) this.unload(t);
    if (this.terrainCollider) this.physics.world.removeCollider(this.terrainCollider, false);
    this.scene.remove(this.root);
    this.props.dispose();
    this.mats.dispose();
  }

  /**
   * Самопроверка раскладки heightfield: бросает лучи вниз в N точках, сравнивает с heightAt (bilinear).
   * Дома могут перекрывать — ловим только попадания «в рельеф» (разница < 0.5 м вверх), остальное считаем хитами по зданиям.
   */
  checkTerrain(n = 200): { n: number; maxErr: number; meanErr: number; onBuildings: number } {
    const { minX, minZ, cols, rows, cellSize } = this.manifest.terrain;
    this.physics.world.step();
    let maxErr = 0, sum = 0, cnt = 0, onB = 0;
    for (let i = 0; i < n; i++) {
      const x = minX + Math.random() * (cols - 2) * cellSize;
      const z = minZ + Math.random() * (rows - 2) * cellSize;
      const gh = this.physics.groundHeightAt(x, z), h = this.heightAt(x, z);
      if (gh - h > 0.5) { onB++; continue; }
      const e = Math.abs(gh - h);
      maxErr = Math.max(maxErr, e); sum += e; cnt++;
    }
    return { n: cnt, maxErr, meanErr: sum / Math.max(cnt, 1), onBuildings: onB };
  }
}
