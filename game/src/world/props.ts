import type { PoolLike } from './parked-batch';
import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import { cityUniforms } from './materials';
import {
  buildTrees, buildStreetLamp, buildTrafficLight, buildTrafficLightArm, buildBusStop, buildBench, buildTrashBin,
  buildPlaygrounds, buildContainerSite, buildParkedCar, buildShrubVariants, buildFlowerbed, buildBollard, buildBarrierPost,
  buildBarrierArm, buildParkLamp, buildDoubleLamp, buildEntrance, buildStorefront, buildSignPlane, buildDecalQuad,
  buildClassicLamp, buildTreeGrate, buildKiosk, buildCafeTerrace, buildStreetSculptures,
} from './prop-meshes';
import { buildLybedLamp, LybedTrees, type XmasTreeInst } from './lybed'; // Лыбедский бульвар (docs/stage3/lybed.md)
import { buildSegments, buildFencePanel, buildFencePost, buildJersey, fenceMaterial, type SegJson } from './fences';
import { buildDecals, decalMaterial, type GraphEdge } from './decals';
import { SignAtlas, signMaterial, SIGN_CELLS } from './signs';
import { Grass, type TerrainInfo } from './grass';
import { surfAt, SURF, type TileSurface } from './surface-mask';
import { BREAK, DEBRIS_MAX, DEBRIS_TTL, DEBRIS_FAR, CARS_DYNAMIC_MAX } from './breakables';
import { applySurfaceWeather } from '../render/weather';
import { buildTreeSet, THICKET_R, THICKET_H } from './trees';

/**
 * Пропсы из props/{ix}_{iz}.json (docs/world-format.md, «Дворы, площадки и пропсы»).
 *
 * Рендер: глобальные InstancedMesh-пулы — по одному на (вид, LOD), т.е. ~30 draw calls на все пропсы независимо от
 * числа тайлов. Данные тайла при загрузке превращаются в готовые массивы матриц/цветов (Float32Array) по видам.
 * Пулы пересобираются, когда камера сдвинулась > REBUILD_MOVE м или повернулась > REBUILD_TURN рад, или изменился
 * набор тайлов: тайлы вне (расширенного) фрустума пропускаются, тайлы целиком в одной LOD-зоне копируются блоком
 * (Float32Array.set), на границе зон — поштучно по расстоянию. Пул растёт удвоением (без free-list: пересборка дешевле).
 *
 * Физика: статические коллайдеры (стволы, опоры, остановки, контейнеры, машины, ограды/стены) создаются для тайлов
 * ближе COLLIDER_ON м к машине (не больше COLLIDER_BUDGET в кадр) и удаляются дальше COLLIDER_OFF м. Группа
 * коллизий PROP_GROUPS: `groundHeightAt` (камера) их не видит. Лавочки/урны/кусты/детплощадки — без коллайдеров.
 */

export const PROP_GROUPS = (0x0002 << 16) | 0xffff; // membership: бит 2, filter: всё
/** Обломки: membership бит 3 (луч камеры их не видит), сталкиваются со всем. */
const DEBRIS_GROUPS = (0x0004 << 16) | 0xffff;

interface Debris { body: RAPIER.RigidBody; joint: RAPIER.ImpulseJoint | null; kind: string; offset: THREE.Matrix4; col: number[]; ext: number[]; age: number;
  /** Сдвинутая припаркованная машина: откуда она (тайл, фигура, инстанс, ключ сессии). */
  car?: { tile: TileProps; si: number; idx: number; ref: string } }

const REBUILD_MOVE = 4;
const REBUILD_TURN = 0.08;
const FRUSTUM_PAD = 40; // м, запас тайла при отсечении (камера успевает чуть повернуться между пересборками)
const COLLIDER_ON = 120, COLLIDER_OFF = 200, COLLIDER_BUDGET = 500;

type MatKind = 'prop' | 'fence' | 'sign' | 'decal';
const SIGN_DIST = 140;

interface KindDef {
  key: string;
  near: THREE.BufferGeometry;
  far?: THREE.BufferGeometry;
  /** Без far: виден до farDist. С far: near до nearDist, дальше far до farDist. */
  nearDist: number;
  farDist: number;
  mat: MatKind;
  shadow: boolean;
  /** Дальний LOD рисуется пулом другого вида (одинаковая far-геометрия → меньше draw calls). */
  farPool?: string;
  /** Свой материал вида (glTF-машины парковки, parked-gltf.ts) вместо mats[mat]. */
  material?: THREE.Material;
  farMaterial?: THREE.Material;
}

/** Данные вида в тайле: матрицы (16), цвета (3), ext (4: доп. параметры для шейдера вида), xz (2). */
export interface KindData { n: number; mat: Float32Array; col: Float32Array; ext: Float32Array; xz: Float32Array }

interface TileProps {
  key: string;
  min: THREE.Vector2; max: THREE.Vector2;
  box: THREE.Box3; // для фрустума (с запасом)
  kinds: Map<string, KindData>;
  /** Коллайдеры: шаг 8 — [shape 0=cyl 1=box, x, y, z, a, b, c, rotY] (cyl: a=halfHeight b=radius; box: a,b,c = half extents). */
  shapes: Float32Array;
  colliders: (RAPIER.Collider | null)[] | null;
  /** на каждую фигуру: класс разрушения, вид/индекс инстанса, столбы (ограды) */
  smeta: ShapeMeta[];
  /** сломанные фигуры (до перезагрузки тайла) */
  broken: Set<number>;
  pending: number; // сколько из shapes уже создано (при поэтапном создании)
  /** сетка препятствий 32×32 ячейки по 8 м: индексы фигур shapes (лениво, queryObstacles) */
  grid?: (number[] | undefined)[];
  /** вывески (индекс = инстанс вида 'sign'): id, текст, цвет */
  signs: { id: string; text: string; color: string }[];
}

interface ShapeMeta { cls: string; kind: string; idx: number; posts: number[]; ref?: string }

interface PropInst {
  type: string; x: number; y: number; z: number; rotY?: number; scale?: number; seed?: number; variant?: number | string; lanes?: number;
  shape?: string; radius?: number; length?: number; width?: number; height?: number; border?: string; flowers?: number;
  armDir?: number[]; armLength?: number;
}
interface Storefront {
  x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; nx: number; nz: number; width: number; height: number;
  signText?: string; name?: string; label?: string; signColor?: string; osm?: string;
}
interface Entrance { type: string; x: number; y: number; z: number; rotY: number; width?: number; stepsHeight?: number; lamp?: boolean }
export interface PropJson {
  instances: PropInst[];
  segments?: SegJson[];
  storefronts?: Storefront[];
  entrances?: Entrance[];
}

class Pool implements PoolLike {
  mesh: THREE.InstancedMesh;
  count = 0;
  /** Вызывается перед отрисовкой пула (вывески: догрузка ячеек атласа). */
  onBefore: ((r: THREE.WebGLRenderer) => void) | null = null;
  private ext!: THREE.InstancedBufferAttribute;
  constructor(readonly geo: THREE.BufferGeometry, readonly material: THREE.Material, public cap: number, readonly parent: THREE.Object3D, readonly shadow: boolean) {
    this.mesh = this.make(cap);
  }
  private make(cap: number): THREE.InstancedMesh {
    // своя обёртка геометрии на пул (атрибуты базовой геометрии общие) + инстанс-атрибут aExt
    const g = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(this.geo.attributes)) g.setAttribute(k, a);
    g.index = this.geo.index;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const ext = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aExt', ext);
    this.ext = ext;
    const m = new THREE.InstancedMesh(g, this.material, cap);
    m.onBeforeRender = (r) => this.onBefore?.(r);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.castShadow = this.shadow;
    // деревья v2: свой материал теней (опавшая листва не отбрасывает тень, alpha-test по атласу) — world/trees.ts
    const depthMat = (this.material.userData as { nfrDepth?: THREE.Material }).nfrDepth;
    if (depthMat) m.customDepthMaterial = depthMat;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.count = 0;
    this.parent.add(m);
    return m;
  }
  ensure(n: number): void {
    if (n <= this.cap) return;
    let cap = this.cap;
    while (cap < n) cap *= 2;
    const old = this.mesh, oldExt = this.ext;
    this.mesh = this.make(cap);
    this.ext.array.set((oldExt.array as Float32Array).subarray(0, this.count * 4));
    this.mesh.instanceMatrix.array.set((old.instanceMatrix.array as Float32Array).subarray(0, this.count * 16));
    this.mesh.instanceColor!.array.set((old.instanceColor!.array as Float32Array).subarray(0, this.count * 3));
    this.cap = cap;
    old.removeFromParent();
    old.dispose(); // GPU-буферы инстансов
    old.geometry.dispose(); // обёртка (общие атрибуты перезальются при следующем использовании)
  }
  /** Блочное добавление (все инстансы вида из тайла). */
  addBlock(d: KindData): void {
    this.ensure(this.count + d.n);
    (this.mesh.instanceMatrix.array as Float32Array).set(d.mat, this.count * 16);
    (this.mesh.instanceColor!.array as Float32Array).set(d.col, this.count * 3);
    (this.ext.array as Float32Array).set(d.ext, this.count * 4);
    this.count += d.n;
  }
  addOne(d: KindData, i: number): void {
    this.ensure(this.count + 1);
    (this.mesh.instanceMatrix.array as Float32Array).set(d.mat.subarray(i * 16, i * 16 + 16), this.count * 16);
    (this.mesh.instanceColor!.array as Float32Array).set(d.col.subarray(i * 3, i * 3 + 3), this.count * 3);
    (this.ext.array as Float32Array).set(d.ext.subarray(i * 4, i * 4 + 4), this.count * 4);
    this.count++;
  }
  commit(): void {
    const m = this.mesh;
    m.count = this.count;
    m.visible = this.count > 0;
    if (!this.count) return;
    m.instanceMatrix.clearUpdateRanges();
    m.instanceMatrix.addUpdateRange(0, this.count * 16);
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor!.clearUpdateRanges();
    m.instanceColor!.addUpdateRange(0, this.count * 3);
    m.instanceColor!.needsUpdate = true;
    this.ext.clearUpdateRanges();
    this.ext.addUpdateRange(0, this.count * 4);
    this.ext.needsUpdate = true;
  }
}

/** Общий материал пропсов: вершинный цвет, тонировка цветом инстанса (aFlag=1), фонари/светофоры (aFlag 2..5). */
function propMaterial(uniforms: { uTime: { value: number } }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, vertexColors: true });
  m.customProgramCacheKey = () => 'nfr-prop';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.uniforms.uNfrNight = cityUniforms.uNfrNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFlag; varying float vFlag; varying vec3 vTl;')
      .replace('#include <color_vertex>', /* glsl */ `
        vFlag = aFlag; vTl = vec3(0.0);
        vColor = vec4(color.rgb, 1.0);
        #ifdef USE_INSTANCING_COLOR
          if ((aFlag > 0.5 && aFlag < 1.5) || (aFlag > 6.5 && aFlag < 7.5)) vColor.rgb *= instanceColor.rgb;
          vTl = instanceColor.rgb; // светофоры: (фаза, режим, состояние) — см. Props.setSignalSource
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFlag; varying vec3 vTl; uniform float uTime; uniform float uNfrNight;')
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        float nfrLit = 0.0;
        if (vFlag > 2.5) {
          // цикл 30 с: зелёный 0–0.42, жёлтый 0.42–0.5, красный 0.5–1 (красный+жёлтый в конце); фаза — на перекрёсток/ось
          float g, y, r;
          if (vTl.y > 0.5) {
            // внешнее состояние (traffic/signals.ts): 0 красный, 1 жёлтый, 2 зелёный, 3 красный+жёлтый, 4 жёлтый мигает
            float s = vTl.z;
            r = step(s, 0.5) + step(2.5, s) * step(s, 3.5);
            y = step(0.5, s) * step(s, 1.5) + step(2.5, s) * step(s, 3.5) + step(3.5, s) * step(0.5, fract(uTime));
            g = step(1.5, s) * step(s, 2.5);
            if (s > 8.0) { r = 0.0; y = 0.0; g = 0.0; } // сломан — тёмный
          } else {
            float ph = fract(uTime / 30.0 + vTl.x);
            g = step(ph, 0.42);
            y = step(0.42, ph) * step(ph, 0.5) + step(0.93, ph);
            r = step(0.5, ph);
          }
          nfrLit = vFlag < 3.5 ? r : (vFlag < 4.5 ? y : g);
          diffuseColor.rgb *= mix(0.08, 0.6, nfrLit);
        } else if (vFlag > 1.5) {
          nfrLit = uNfrNight * step(0.5, vTl.y); // instanceColor.g = 0 — сломанный фонарь не горит
        }
        vec3 nfrEm = vColor.rgb * (vFlag > 2.5 ? 3.0 : 4.0);
        if (vFlag > 5.5 && vFlag < 6.5) { nfrLit = uNfrNight; nfrEm = vec3(1.0, 0.78, 0.5) * 0.55; } // витрина: тёмное стекло днём, тёплый свет ночью`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += nfrEm * nfrLit;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (vFlag > 6.5 && vFlag < 7.5) roughnessFactor = 0.32; // лак кузова');
  };
  return m;
}

/** Светофор-пропс: положение, направление (лицом к подъезжающим, rotY контракта), число полос подхода. */
export interface TrafficLightRef {
  x: number; y: number; z: number; rotY: number; lanes: number;
  /** Тайл и индекс инстанса (внутреннее). */
  tile: string; kind: string; index: number;
  /** Последнее выставленное состояние (−1 — своя циклограмма). */
  state: number;
}
/** Состояние сигнала: 0 красный, 1 жёлтый, 2 зелёный, 3 красный+жёлтый, 4 жёлтый мигает; null — своя циклограмма. */
export type SignalState = 0 | 1 | 2 | 3 | 4 | null;
export type SignalSource = (light: TrafficLightRef) => SignalState;

interface Def extends Omit<KindDef, 'key'> { colliderR?: number; colliderHH?: number }

export class Props {
  readonly root = new THREE.Group();
  readonly stats = { instances: 0, drawn: 0, colliders: 0, rebuilds: 0, rebuildMs: 0 };
  readonly uniforms = { uTime: { value: 0 } };
  /** Светофоры загруженных тайлов (для внешнего управления фазами). */
  readonly trafficLights: TrafficLightRef[] = [];
  private signalSource: SignalSource | null = null;
  private signalAcc = 0;
  private defs = new Map<string, KindDef>();
  private pools = new Map<string, PoolLike>(); // key + ':n' / ':f' (InstancedMesh-пулы или BatchedMesh-пулы машин парковки)
  private tiles = new Map<string, TileProps>();
  private dirty = true;
  private lastPos = new THREE.Vector3(1e9, 0, 0);
  private lastDir = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private mats: Record<MatKind, THREE.Material>;
  private trees = buildTrees();
  /** Трава у камеры (grass.ts). */
  readonly grass: Grass;
  private atlas = new SignAtlas();
  /** Рендерер (берётся из onBeforeRender пулов) — для асинхронной компиляции шейдера травы. */
  private renderer: THREE.WebGLRenderer | null = null;
  private grassState: 'wait' | 'compiling' | 'ready' = 'wait';
  private edgesByTile = new Map<string, GraphEdge[]>();
  private tileSize = 250;
  /** Каркасная ёлка Лыбедского бульвара (инстанс lybed_xmas_tree, world/lybed.ts). */
  private lybedTrees: LybedTrees;

  constructor(private physics: PhysicsWorld, scene: THREE.Scene) {
    this.root.name = 'props';
    this.root.matrixAutoUpdate = false;
    scene.add(this.root);
    this.grass = new Grass(scene, this.uniforms.uTime);
    physics.onPostStep((dt, ev) => this.onContacts(dt, ev));
    this.mats = { prop: propMaterial(this.uniforms), fence: fenceMaterial(), sign: signMaterial(this.atlas), decal: decalMaterial() };
    // погода (render/weather.ts): снег сверху, мокрые поверхности; кроны — листопад/голые ветки зимой, хвоя — снег на лапах
    applySurfaceWeather(this.mats.prop, 'prop'); applySurfaceWeather(this.mats.fence, 'prop');
    const leafMat = applySurfaceWeather(propMaterial(this.uniforms), 'vegetation');
    const T = this.trees;
    const add = (key: string, d: KindDef | Def) => this.defs.set(key, { ...(d as KindDef), key });
    // деревья v2 (world/trees.ts, docs/stage3/realism.md): кора + карточки листвы, вдали — импостеры
    const TS = buildTreeSet(this.uniforms.uTime);
    applySurfaceWeather(TS.material.near, 'vegetation'); applySurfaceWeather(TS.material.nearPine, 'pine'); applySurfaceWeather(TS.material.far, 'vegetation');
    for (const k of ['tree_birch', 'tree_poplar', 'tree_maple', 'tree_lime', 'tree_pine', 'tree_negundo']) {
      add(k, { near: TS.near[k], far: TS.far[k], nearDist: TS.nearDist, farDist: 680, mat: 'prop', shadow: true, material: k === 'tree_pine' ? TS.material.nearPine : TS.material.near, farMaterial: TS.material.far });
    }
    add('shrub', { near: TS.near.shrub, far: TS.far.shrub, nearDist: 90, farDist: 300, mat: 'prop', shadow: false, material: TS.material.near, farMaterial: TS.material.far });
    // заросли клёна ясенелистного (docs/stage3/landcover.md): клумпы, вдали — широкий импостер; без теней (бюджет: ~2k тр. × сотни клумп)
    add('thicket', { near: TS.near.thicket, far: TS.far.thicket, nearDist: Math.min(TS.nearDist, 80), farDist: 520, mat: 'prop', shadow: false, material: TS.material.near, farMaterial: TS.material.far });
    buildShrubVariants().forEach((g, i) => add('shrub_' + i, { near: g, far: T.shrub.far, farPool: 'shrub', nearDist: 90, farDist: 300, mat: 'prop', shadow: false, material: leafMat }));
    add('street_lamp', { near: buildStreetLamp(), nearDist: 450, farDist: 450, mat: 'prop', shadow: true });
    add('street_lamp_double', { near: buildDoubleLamp(), nearDist: 450, farDist: 450, mat: 'prop', shadow: true });
    add('park_lamp', { near: buildParkLamp(), nearDist: 300, farDist: 300, mat: 'prop', shadow: false });
    add('lybed_lamp_slim', { near: buildLybedLamp('slim'), nearDist: 300, farDist: 300, mat: 'prop', shadow: false });
    add('lybed_lamp_disc2', { near: buildLybedLamp('disc2'), nearDist: 300, farDist: 300, mat: 'prop', shadow: false });
    this.lybedTrees = new LybedTrees(this.root, physics, (x, z) => this.heightAt(x, z));
    add('traffic_light', { near: buildTrafficLight(), nearDist: 300, farDist: 300, mat: 'prop', shadow: false });
    add('traffic_light_arm', { near: buildTrafficLightArm(), nearDist: 350, farDist: 350, mat: 'prop', shadow: true });
    add('bus_stop', { near: buildBusStop(), nearDist: 350, farDist: 350, mat: 'prop', shadow: true });
    add('bench', { near: buildBench(), nearDist: 120, farDist: 120, mat: 'prop', shadow: false });
    add('trash_bin', { near: buildTrashBin(), nearDist: 100, farDist: 100, mat: 'prop', shadow: false });
    add('bollard', { near: buildBollard(), nearDist: 120, farDist: 120, mat: 'prop', shadow: false });
    add('barrier_post', { near: buildBarrierPost(), nearDist: 150, farDist: 150, mat: 'prop', shadow: false });
    add('barrier_arm', { near: buildBarrierArm(), nearDist: 150, farDist: 150, mat: 'prop', shadow: false });
    add('flowerbed_round', { near: buildFlowerbed('round'), nearDist: 160, farDist: 160, mat: 'prop', shadow: false });
    add('flowerbed_rect', { near: buildFlowerbed('rect'), nearDist: 160, farDist: 160, mat: 'prop', shadow: false });
    add('entrance', { near: buildEntrance(), nearDist: 200, farDist: 200, mat: 'prop', shadow: true });
    add('storefront', { near: buildStorefront(), nearDist: 260, farDist: 260, mat: 'prop', shadow: false });
    add('sign', { near: buildSignPlane(), nearDist: 260, farDist: 260, mat: 'sign', shadow: false });
    add('decal', { near: buildDecalQuad(), nearDist: 150, farDist: 150, mat: 'decal', shadow: false });
    buildPlaygrounds().forEach((g, i) => add('playground_' + i, { near: g, nearDist: 250, farDist: 250, mat: 'prop', shadow: false }));
    add('container_site', { near: buildContainerSite(), nearDist: 250, farDist: 250, mat: 'prop', shadow: false });
    // пешеходная улица (Почтовая): docs/stage2/pochtovaya.md
    add('lamp_classic', { near: buildClassicLamp(), nearDist: 300, farDist: 300, mat: 'prop', shadow: true });
    add('tree_grate', { near: buildTreeGrate(), nearDist: 90, farDist: 90, mat: 'prop', shadow: false });
    add('kiosk', { near: buildKiosk(), nearDist: 300, farDist: 300, mat: 'prop', shadow: true });
    add('cafe_terrace', { near: buildCafeTerrace(), nearDist: 220, farDist: 220, mat: 'prop', shadow: true });
    buildStreetSculptures().forEach((g, i) => add('sculpture_' + SCULPTURE_VARIANTS[i], { near: g, nearDist: 260, farDist: 260, mat: 'prop', shadow: true }));
    for (const k of ['wagon', 'sedan'] as const) {
      const c = buildParkedCar(k);
      add('car_' + k, { near: c.near, far: c.far, nearDist: 130, farDist: 420, mat: 'prop', shadow: true });
    }
    add('fence_panel', { near: buildFencePanel(), nearDist: 320, farDist: 320, mat: 'fence', shadow: false });
    add('fence_post', { near: buildFencePost(), nearDist: 220, farDist: 220, mat: 'fence', shadow: false });
    add('jersey', { near: buildJersey(), nearDist: 300, farDist: 300, mat: 'fence', shadow: false });

    for (const d of this.defs.values()) {
      this.pools.set(d.key + ':n', new Pool(d.near, d.material ?? this.mats[d.mat], 256, this.root, d.shadow));
      if (d.far && !d.farPool) this.pools.set(d.key + ':f', new Pool(d.far, d.farMaterial ?? d.material ?? this.mats[d.mat], 256, this.root, false));
    }
    for (const [k, p] of this.pools) p.onBefore = k === 'sign:n' ? (r) => { this.renderer ??= r; this.atlas.flush(r); } : (r) => { this.renderer ??= r; };
  }

  /** Взвешенный выбор вида машины парковки (addParkedCarModels); пусто — процедурные car_sedan/car_wagon по чётности seed. */
  private parkedPick: { key: string; cum: number }[] = [];
  /** Сдвинутые за сессию машины парковки: ключ (тайл + исходная точка) → матрица и фигура коллайдера. */
  private movedCars = new Map<string, { m: number[]; shape: number[] }>();
  /** Хук: машина парковки сдвинута ударом (сигнализация и т.п.). */
  onParkedCarHit: ((x: number, y: number, z: number) => void) | null = null;

  private pickParked(seed: number): string {
    const P = this.parkedPick;
    if (!P.length) return seed & 1 ? 'car_sedan' : 'car_wagon';
    const h = ((Math.imul(seed + 0x9e37, 2654435761) >>> 0) / 4294967296) * P[P.length - 1].cum;
    for (const e of P) if (h < e.cum) return e.key;
    return P[P.length - 1].key;
  }

  /**
   * glTF-машины парковки (src/world/parked-gltf.ts): регистрирует виды car_<id> и использует их для parked_car
   * во всех тайлах, загруженных после вызова (вызывать до первой подгрузки тайлов).
   */
  addParkedCarModels(defs: { key: string; near: THREE.BufferGeometry; far: THREE.BufferGeometry; material: THREE.Material; farMaterial: THREE.Material; weight: number; nearDist?: number; pools?: { near: PoolLike; far: PoolLike }; objects?: THREE.Object3D[] }[]): void {
    if (!defs.length) return;
    let cum = 0;
    this.parkedPick = defs.map((d) => ({ key: d.key, cum: (cum += d.weight) }));
    for (const d of defs) {
      if (this.defs.has(d.key)) continue;
      this.defs.set(d.key, { key: d.key, near: d.near, far: d.far, nearDist: d.nearDist ?? 130, farDist: 420, mat: 'prop', shadow: true, material: d.material, farMaterial: d.farMaterial });
      if (d.objects) for (const o of d.objects) this.root.add(o);
      const n = d.pools?.near ?? new Pool(d.near, d.material, 64, this.root, true), f = d.pools?.far ?? new Pool(d.far, d.farMaterial, 64, this.root, false);
      n.onBefore = f.onBefore = (r) => { this.renderer ??= r; };
      this.pools.set(d.key + ':n', n); this.pools.set(d.key + ':f', f);
    }
  }

  /** Окружение (PMREM неба): отражения лака машин и мягкий заполняющий свет пропсов в тени. */
  setEnvMap(env: THREE.Texture | null): void {
    for (const k of ['prop', 'fence'] as const) {
      const m = this.mats[k] as THREE.MeshStandardMaterial;
      m.envMap = env; m.envMapIntensity = 0.55; m.needsUpdate = true;
    }
  }

  /** Рельеф для травы (вызывает CityWorld после загрузки heightmap). */
  setTerrain(t: TerrainInfo, heights: Float32Array, tileSize = 250): void {
    this.grass.setTerrain(t, heights);
    this.terrain = t; this.heights = heights;
    this.tileSize = tileSize;
  }

  /** Дорожный граф для декалей (люки, ливнёвки, следы шин, заплаты): рёбра раскладываются по тайлам их точек. */
  setRoadGraph(edges: GraphEdge[]): void {
    this.edgesByTile.clear();
    for (const e of edges) {
      const keys = new Set<string>();
      for (const p of e.points ?? []) keys.add(Math.floor(p[0] / this.tileSize) + '_' + Math.floor(p[2] / this.tileSize));
      for (const k of keys) { let l = this.edgesByTile.get(k); if (!l) this.edgesByTile.set(k, (l = [])); l.push(e); }
    }
  }

  private terrain: TerrainInfo | null = null;
  private heights: Float32Array | null = null;
  private player: RAPIER.RigidBody | null = null;
  private debris: Debris[] = [];
  private debrisPools = new Map<string, Pool>();
  readonly breakStats = { broken: 0, debris: 0 };

  /** Высота рельефа (та же триангуляция ячейки, что у коллайдера). */
  heightAt(x: number, z: number): number {
    const T = this.terrain, H = this.heights;
    if (!T || !H) return 0;
    const fx = Math.min(Math.max((x - T.minX) / T.cellSize, 0), T.cols - 1.0001), fz = Math.min(Math.max((z - T.minZ) / T.cellSize, 0), T.rows - 1.0001);
    const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r, i = r * T.cols + c;
    const h00 = H[i], h10 = H[i + 1], h01 = H[i + T.cols], h11 = H[i + T.cols + 1];
    return tz > tx ? h00 + (h01 - h00) * tz + (h11 - h01) * tx : h00 + (h10 - h00) * tx + (h11 - h10) * tz;
  }

  /** Поверхность в точке: рельеф + слой (дорога +0.05, тротуар +0.15, площадки +0.03). */
  private groundY(x: number, z: number, surf: TileSurface | null): number {
    const c = surf ? surfAt(surf, x, z) : -1;
    const off = c === SURF.road ? 0.05 : c === SURF.sidewalk ? 0.15 : c >= SURF.parking && c <= SURF.dirt ? 0.03 : 0;
    return this.heightAt(x, z) + off;
  }

  /** Матрица припаркованной машины: стоит на 4 колёсах (база 2.73 м, колея 1.52 м), наклон по высотам под колёсами. */
  private carMatrix(x: number, z: number, ry: number, s: number, surf: TileSurface | null): number[] {
    const cs = Math.cos(ry), sn = Math.sin(ry);
    const h = (lx: number, lz: number) => this.groundY(x + lx * cs + lz * sn, z - lx * sn + lz * cs, surf);
    const fl = h(-0.76, -1.35), fr = h(0.76, -1.35), rl = h(-0.76, 1.38), rr = h(0.76, 1.38);
    const pitch = Math.atan2((fl + fr - rl - rr) / 2, 2.73), roll = Math.atan2((fr + rr - fl - rl) / 2, 1.52);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, (fl + fr + rl + rr) / 4, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, ry, roll, 'YXZ')),
      new THREE.Vector3(s, s, s));
    return Array.from(m.elements);
  }

  /** Машина игрока: по ней проверяются удары по ломаемым пропсам (каждый шаг физики). */
  setPlayer(body: RAPIER.RigidBody): void { this.player = body; }

  /** Ломаемые коллайдеры: handle → (тайл, фигура). */
  private owners = new Map<number, { t: TileProps; si: number }>();

  /** Ломаемым фигурам — события сил контакта (порог низкий, решение — по скорости сближения в onContacts). */
  private withEvents(desc: RAPIER.ColliderDesc, t: TileProps, si: number): void {
    const meta = t.smeta[si];
    if (!meta || meta.cls === 'static' || !BREAK[meta.cls]) return;
    desc.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(200);
  }

  private own(c: RAPIER.Collider, t: TileProps, si: number): void {
    const meta = t.smeta[si];
    if (meta && meta.cls !== 'static' && BREAK[meta.cls]) this.owners.set(c.handle, { t, si });
  }

  /**
   * После шага физики: реальные контакты с ломаемыми пропсами (CONTACT_FORCE_EVENTS). Машина уже коснулась пропса
   * (Rapier погасил нормальную скорость о статический коллайдер). Скорость сближения до удара восстанавливается из
   * импульса контакта: closing = |v·n| + F·dt/m. Если выше порога класса — пропс становится обломком в своей текущей позе,
   * машине возвращается скорость за вычетом потерь (обмен импульсом + разрушение), чтобы она не «встала как об стену».
   * Ниже порога пропс остаётся твёрдым. Бьёт любое динамическое тело (машина игрока, сдвинутые машины парковки, трафик).
   */
  private onContacts(dt: number, ev: RAPIER.EventQueue): void {
    const w = this.physics.world;
    const hits = new Map<number, { o: { t: TileProps; si: number }; body: RAPIER.RigidBody; F: number; n: { x: number; y: number; z: number } }>();
    ev.drainContactForceEvents((e) => {
      const h1 = e.collider1(), h2 = e.collider2();
      const own1 = this.owners.get(h1), own2 = this.owners.get(h2);
      const o = own1 ?? own2;
      if (!o) return;
      const other = w.getCollider(own1 ? h2 : h1);
      const body = other?.parent();
      if (!body || !body.isDynamic()) return;
      const prev = hits.get(own1 ? h1 : h2);
      const F = e.totalForceMagnitude();
      if (!prev || prev.F < F) hits.set(own1 ? h1 : h2, { o, body, F, n: e.maxForceDirection() });
    });
    for (const [handle, h] of hits) {
      const { t, si } = h.o;
      if (t.broken.has(si) || t.colliders?.[si]?.handle !== handle) continue;
      const meta = t.smeta[si], cls = BREAK[meta.cls];
      if (!cls) continue;
      // нормаль — от машины к пропсу (горизонтальная)
      const S = t.shapes, o = si * 8, bp = h.body.translation();
      let nx = h.n.x, nz = h.n.z;
      const nl = Math.hypot(nx, nz);
      if (nl < 0.2) continue; // контакт сверху (наехал колесом/днищем) — не удар
      nx /= nl; nz /= nl;
      if ((S[o + 1] - bp.x) * nx + (S[o + 3] - bp.z) * nz < 0) { nx = -nx; nz = -nz; }
      const v = h.body.linvel(), m = h.body.mass() || 1;
      const vn = Math.max(0, v.x * nx + v.z * nz);
      const closing = vn + h.F * dt / m; // скорость сближения до удара
      const isPlayer = h.body === this.player;
      if (closing * 3.6 < cls.kmh) continue;
      if (!isPlayer && !cls.car && closing * 3.6 < cls.kmh * 2) continue; // сдвинутая машина ломает остальное только с разгона
      this.breakShape(t, si, cls, nx, nz, closing, h.body, vn);
    }
  }

  private breakShape(t: TileProps, si: number, cls: (typeof BREAK)[string], nx = 0, nz = 0, closing = 0, hitter: RAPIER.RigidBody | null = null, vnAfter = 0): void {
    const w = this.physics.world, S = t.shapes, o = si * 8, meta = t.smeta[si];
    t.broken.add(si);
    const c = t.colliders?.[si];
    if (c) { this.owners.delete(c.handle); w.removeCollider(c, false); t.colliders![si] = null; this.stats.colliders--; }
    const d = t.kinds.get(meta.kind);
    if (!d || meta.idx < 0) return;
    if (cls.flatten) {
      // заросли: стебли пригнуты и поломаны в сторону удара (инстанс наклонён и придавлен), машина теряет скорость
      const M0 = new THREE.Matrix4().fromArray(d.mat, meta.idx * 16);
      const pos = new THREE.Vector3().setFromMatrixPosition(M0);
      const axis = new THREE.Vector3(nz, 0, -nx);
      if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
      axis.normalize();
      const F = new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z)
        .multiply(new THREE.Matrix4().makeRotationAxis(axis, 0.85 + 0.35 * frac(pos.x * 0.37 + pos.z * 0.71)))
        .multiply(new THREE.Matrix4().makeTranslation(-pos.x, -pos.y, -pos.z)).multiply(M0).multiply(new THREE.Matrix4().makeScale(1, 0.55, 1));
      F.toArray(d.mat, meta.idx * 16);
      this.dirty = true;
      this.breakStats.broken++;
      if (hitter && closing > 0) {
        const back = Math.max(0, closing - cls.loss / 3.6 - vnAfter), mc = hitter.mass();
        hitter.applyImpulse({ x: nx * back * mc, y: 0, z: nz * back * mc }, true);
      }
      return;
    }
    // инстанс: запомнить и спрятать (матрица в ноль); столбы секции — тоже
    const M = new THREE.Matrix4().fromArray(d.mat, meta.idx * 16);
    const col = Array.from(d.col.subarray(meta.idx * 3, meta.idx * 3 + 3)), ext = Array.from(d.ext.subarray(meta.idx * 4, meta.idx * 4 + 4));
    d.mat.fill(0, meta.idx * 16, meta.idx * 16 + 16);
    const posts = t.kinds.get('fence_post');
    if (posts) for (const pi of meta.posts) posts.mat.fill(0, pi * 16, pi * 16 + 16);
    this.dirty = true;
    this.breakStats.broken++;
    if (cls.lampOff) col[1] = 0; // плафон гаснет (aFlag 2 светится только при instanceColor.g > 0.5)
    if (cls.tlOff) { col[1] = 1; col[2] = 9; } // светофор тёмный
    if (cls.car) {
      // машина парковки: дальше удар считает Rapier (тело на месте статического коллайдера); вернуть ударившему скорость сближения
      if (hitter && closing > vnAfter) hitter.applyImpulse({ x: nx * (closing - vnAfter) * hitter.mass(), y: 0, z: nz * (closing - vnAfter) * hitter.mass() }, true);
      this.spawnCarBody(t, si, meta, M, col, ext);
      return;
    }
    // динамическое тело: та же фигура
    const isCyl = S[o] === 0;
    const len = isCyl ? 0 : S[o + 6] * 2;
    const mass = cls.mass ?? (cls.perM ?? 20) * Math.max(len, 0.5);
    // опоры: поворот тела = поворот инстанса (консоли/головы — составной коллайдер в локальных осях модели)
    const instYaw = Math.atan2(M.elements[8], M.elements[10]), instS = Math.hypot(M.elements[0], M.elements[1], M.elements[2]) || 1;
    const rot = new THREE.Quaternion().setFromAxisAngle(this.yAxis, isCyl ? instYaw : S[o + 7]);
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(S[o + 1], S[o + 2], S[o + 3]).setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      .setLinearDamping(0.15).setAngularDamping(0.4).setCcdEnabled(true));
    const parts = isCyl ? poleParts(meta.kind, S[o + 4], instS) : [];
    const poleMass = parts.length ? mass * 0.75 : mass;
    const cd = (isCyl ? RAPIER.ColliderDesc.cylinder(S[o + 4], Math.max(S[o + 5], 0.08)) : RAPIER.ColliderDesc.cuboid(S[o + 4], S[o + 5], S[o + 6]))
      .setMass(poleMass).setFriction(0.7).setRestitution(0.05).setCollisionGroups(DEBRIS_GROUPS);
    w.createCollider(cd, body);
    // консоль/голова: боксы с остатком массы (центр масс смещается к консоли, тело не проваливается головой в землю)
    for (const pt of parts) {
      w.createCollider(RAPIER.ColliderDesc.cuboid(pt[3], pt[4], pt[5]).setTranslation(pt[0], pt[1], pt[2])
        .setMass((mass - poleMass) / parts.length).setFriction(0.7).setRestitution(0.05).setCollisionGroups(DEBRIS_GROUPS), body);
    }
    // удар: машина отдаёт импульс обломку (неупругий обмен, эффективная масса ~ масса пропса) + энергия на разрушение
    const car = hitter;
    if (car && closing > 0) {
      const mc = car.mass(), mEff = Math.min(mass, mc * 2);
      const dv = Math.min(closing, closing * mEff / (mc + mEff) + cls.loss / 3.6);
      // контакт уже погасил нормальную скорость машины до vnAfter — вернуть до (closing − dv)
      const back = Math.max(0, closing - dv - vnAfter);
      car.applyImpulse({ x: nx * back * mc, y: 0, z: nz * back * mc }, true);
      const vd = Math.max(closing - dv, Math.min(mc * dv / mass, closing * 1.6)); // не медленнее машины после удара (неупругий), лёгкое — отлетает
      if (cls.pivot && isCyl) {
        // опора срезана у основания и валится от него
        // основание уходит вперёд чуть быстрее машины после удара (не «стена» на пути), верх опрокидывается
        const h = Math.max(S[o + 4], 0.3), om = closing / (2 * h), vb = (closing - dv) * 1.08;
        body.setLinvel({ x: nx * (vb + om * h), y: 0.2, z: nz * (vb + om * h) }, true);
        body.setAngvel({ x: nz * om, y: 0, z: -nx * om }, true);
      } else {
        body.setLinvel({ x: nx * vd, y: 0.5, z: nz * vd }, true);
        if (isCyl) { const h = Math.max(S[o + 4], 0.3); body.setAngvel({ x: nz * vd / h * 0.5, y: 0, z: -nx * vd / h * 0.5 }, true); }
      }
    }
    let joint: RAPIER.ImpulseJoint | null = null;
    // шарнир у основания не нужен: вращение вокруг основания задаётся скоростями выше
    // смещение модели относительно тела: M = T(тело)·R(тело)·offset
    const B = new THREE.Matrix4().compose(new THREE.Vector3(S[o + 1], S[o + 2], S[o + 3]), rot, new THREE.Vector3(1, 1, 1));
    const offset = B.invert().multiply(M);
    this.debris.push({ body, joint, kind: meta.kind, offset, col, ext, age: 0 });
    while (this.debris.length > DEBRIS_MAX) this.removeDebris(0);
  }

  private removeDebris(i: number): void {
    const d = this.debris[i];
    if (d.car) this.settleCar(d);
    this.physics.world.removeRigidBody(d.body);
    this.debris.splice(i, 1);
  }

  /**
   * Припаркованная машина → динамическое тело (Rapier): коробка по коллайдеру, масса 1200 кг с низким центром масс,
   * трение 0.6, демпфирование — скользит и крутится, останавливается за несколько метров. Удар считает Rapier сам
   * (без ручного импульса): машина игрока теряет скорость по обмену импульсом, а не о «стену».
   */
  private spawnCarBody(t: TileProps, si: number, meta: ShapeMeta, M: THREE.Matrix4, col: number[], ext: number[]): void {
    const w = this.physics.world, S = t.shapes, o = si * 8;
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), sc = new THREE.Vector3();
    M.decompose(pos, quat, sc);
    const hx = S[o + 4], hy = S[o + 5], hz = S[o + 6], mass = BREAK.parked_car.mass ?? 1200;
    const c = new THREE.Vector3(0, 0.78 * sc.y, 0).applyQuaternion(quat).add(pos);
    const I = (a: number, b: number) => (mass / 12) * (4 * a * a + 4 * b * b);
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(c.x, c.y, c.z).setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
      .setLinearDamping(0.35).setAngularDamping(0.9).setCcdEnabled(true)
      .setAdditionalMassProperties(mass, { x: 0, y: -0.3, z: 0 }, { x: I(hy, hz), y: I(hx, hz), z: I(hx, hy) }, { x: 0, y: 0, z: 0, w: 1 }));
    w.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setDensity(0).setFriction(0.6).setRestitution(0.05).setCollisionGroups(DEBRIS_GROUPS), body);
    const B = new THREE.Matrix4().compose(c, quat, new THREE.Vector3(1, 1, 1));
    const offset = B.invert().multiply(M);
    this.debris.push({ body, joint: null, kind: meta.kind, offset, col, ext, age: 0, car: { tile: t, si, idx: meta.idx, ref: meta.ref ?? '' } });
    this.onParkedCarHit?.(c.x, c.y, c.z);
    const cars = this.debris.filter((d) => d.car);
    if (cars.length > CARS_DYNAMIC_MAX) this.removeDebris(this.debris.indexOf(cars[0]));
    while (this.debris.length > DEBRIS_MAX) this.removeDebris(0);
  }

  /** Машина остановилась (или лимит/далеко): снова инстанс + статический коллайдер на новом месте; запомнить до конца сессии. */
  private settleCar(d: Debris): void {
    const car = d.car!;
    const tr = d.body.translation(), r = d.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const M = new THREE.Matrix4().compose(new THREE.Vector3(tr.x, tr.y, tr.z), q, new THREE.Vector3(1, 1, 1)).multiply(d.offset);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const t = car.tile, o = car.si * 8, S = t.shapes;
    const shape = [1, tr.x, tr.y, tr.z, S[o + 4], S[o + 5], S[o + 6], Math.atan2(f.x, f.z)];
    if (car.ref) this.movedCars.set(car.ref, { m: Array.from(M.elements), shape });
    if (this.tiles.get(t.key) !== t) return; // тайл выгружен — применится при следующей загрузке
    const kd = t.kinds.get(d.kind);
    if (kd && car.idx >= 0) kd.mat.set(M.elements, car.idx * 16);
    S.set(shape, o);
    t.broken.delete(car.si);
    t.grid = undefined;
    if (t.colliders && car.si < t.colliders.length) {
      const desc = RAPIER.ColliderDesc.cuboid(shape[4], shape[5], shape[6]).setTranslation(shape[1], shape[2], shape[3])
        .setCollisionGroups(PROP_GROUPS).setFriction(0.5);
      this.q.setFromAxisAngle(this.yAxis, shape[7]);
      desc.setRotation({ x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w });
      this.withEvents(desc, t, car.si);
      t.colliders[car.si] = this.physics.world.createCollider(desc);
      this.own(t.colliders[car.si]!, t, car.si);
      this.stats.colliders++;
    }
    this.dirty = true;
  }

  /** Обломки: шарнир «лопается», рендер в отдельных пулах, исчезновение далеко/по времени. */
  private updateDebris(carPos: THREE.Vector3, dt: number): void {
    const m = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    for (const p of this.debrisPools.values()) p.count = 0;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.age += dt;
      const tr = d.body.translation();
      if (d.age > DEBRIS_TTL || Math.hypot(tr.x - carPos.x, tr.z - carPos.z) > DEBRIS_FAR) { this.removeDebris(i); continue; }
      if (d.car && d.age > 1.0) {
        const lv = d.body.linvel(), av = d.body.angvel();
        if (d.body.isSleeping() || (Math.hypot(lv.x, lv.y, lv.z) < 0.05 && Math.hypot(av.x, av.y, av.z) < 0.05)) { this.removeDebris(i); continue; }
      }
      const r = d.body.rotation();
      if (d.joint) {
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat.set(r.x, r.y, r.z, r.w));
        if (up.y < 0.99 || d.age > 0.12) { this.physics.world.removeImpulseJoint(d.joint, true); d.joint = null; } // основание срезано: шарнир держит лишь первые доли секунды
      }
    }
    for (const d of this.debris) {
      const tr = d.body.translation(), r = d.body.rotation();
      m.compose(pos.set(tr.x, tr.y, tr.z), quat.set(r.x, r.y, r.z, r.w), one).multiply(d.offset);
      let pool = this.debrisPools.get(d.kind);
      if (!pool) {
        const def = this.defs.get(d.kind)!;
        pool = new Pool(def.near, def.material ?? this.mats[def.mat], 8, this.root, true);
        this.debrisPools.set(d.kind, pool);
      }
      const one1: KindData = { n: 1, mat: new Float32Array(m.elements), col: new Float32Array(d.col), ext: new Float32Array(d.ext), xz: new Float32Array(2) };
      pool.addOne(one1, 0);
    }
    for (const p of this.debrisPools.values()) p.commit();
    this.breakStats.debris = this.debris.length;
  }

  /**
   * Хук ночного света (render/night-lights.ts): мировые позиции плафонов фонарей в радиусе `r` от (cx, cz).
   * out — плоский массив x,y,z (y — основание фонаря); возвращает число фонарей.
   */
  collectLamps(cx: number, cz: number, r: number, out: number[]): number {
    let n = 0;
    out.length = 0;
    for (const t of this.tiles.values()) {
      const d = t.kinds.get('street_lamp');
      if (!d || t.max.x < cx - r || t.min.x > cx + r || t.max.y < cz - r || t.min.y > cz + r) continue;
      for (let i = 0; i < d.n; i++) {
        const x = d.xz[i * 2], z = d.xz[i * 2 + 1];
        if ((x - cx) ** 2 + (z - cz) ** 2 > r * r) continue;
        if (d.mat[i * 16 + 5] === 0) continue; // сломан
        const m = d.mat, o = i * 16; // плафон: локально (0, 9.2, −1.9) — консоль смотрит в −Z
        out.push(m[o + 12] - m[o + 8] * 1.9, m[o + 13], m[o + 14] - m[o + 10] * 1.9);
        n++;
      }
      // фонари на разделительной (две консоли ±2 м по локальной Z) и парковые (плафон над опорой)
      const dd = t.kinds.get('street_lamp_double');
      for (let i = 0; dd && i < dd.n; i++) {
        const x = dd.xz[i * 2], z = dd.xz[i * 2 + 1];
        if ((x - cx) ** 2 + (z - cz) ** 2 > r * r || dd.mat[i * 16 + 5] === 0) continue;
        const m = dd.mat, o = i * 16;
        for (const sgn of [-2, 2]) { out.push(m[o + 12] + m[o + 8] * sgn, m[o + 13], m[o + 14] + m[o + 10] * sgn); n++; }
      }
      const lc = t.kinds.get('lamp_classic'); // два фонаря на перекладине — одно пятно света
      for (let i = 0; lc && i < lc.n; i++) {
        const x = lc.xz[i * 2], z = lc.xz[i * 2 + 1];
        if ((x - cx) ** 2 + (z - cz) ** 2 > r * r || lc.mat[i * 16 + 5] === 0) continue;
        out.push(x, lc.mat[i * 16 + 13], z); n++;
      }
      for (const pk of ['park_lamp', 'lybed_lamp_slim', 'lybed_lamp_disc2']) {
        const pl = t.kinds.get(pk);
        for (let i = 0; pl && i < pl.n; i++) {
          const x = pl.xz[i * 2], z = pl.xz[i * 2 + 1];
          if ((x - cx) ** 2 + (z - cz) ** 2 > r * r || pl.mat[i * 16 + 5] === 0) continue;
          out.push(x, pl.mat[i * 16 + 13], z); n++;
        }
      }
    }
    return n;
  }

  /** Треугольники модели вида (для отладки). */
  triangles(): Record<string, number> {
    const r: Record<string, number> = {};
    for (const d of this.defs.values()) r[d.key] = d.near.getAttribute('position').count / 3;
    return r;
  }

  // ---------------- загрузка тайла ----------------

  /**
   * Тайл загружен: json — props/{ix}_{iz}.json (может не быть), surf — растр покрытий (surface-mask) для травы и выбора
   * стиля оград. Вызывается для каждого тайла (трава нужна и там, где пропсов нет).
   */
  addTile(key: string, json: PropJson | null, bounds: { minX: number; minZ: number; maxX: number; maxZ: number }, surf: TileSurface | null = null): void {
    json ??= { instances: [] };
    const groups = new Map<string, { m: number[]; c: number[]; e: number[]; xz: number[] }>();
    const shapes: number[] = [];
    const smeta: ShapeMeta[] = [];
    const carClear: number[] = [];
    /** фигура коллайдера + что ломается (класс BREAK, вид/индекс инстанса) */
    const addS = (cls: string, kind: string, idx: number, f: number[]) => { shapes.push(...f); smeta.push({ cls, kind, idx, posts: [] }); };
    const signs: TileProps['signs'] = [];
    let minY = Infinity, maxY = -Infinity;
    const grp = (k: string) => {
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { m: [], c: [], e: [], xz: [] }));
      return g;
    };
    const push = (k: string, m: number[], r: number, g: number, b: number, e0 = 0, e1 = 0, e2 = 0, e3 = 0, x = m[12], z = m[14]) => {
      const G = grp(k);
      G.m.push(...m); G.c.push(r, g, b); G.e.push(e0, e1, e2, e3); G.xz.push(x, z);
      minY = Math.min(minY, m[13]); maxY = Math.max(maxY, m[13] + 22);
    };
    const tl = json.instances.filter((p) => p.type === 'traffic_light');
    const tlPhase = trafficPhases(tl);
    const tlRefs: TrafficLightRef[] = [];
    const col = new THREE.Color();

    for (const p of json.instances) {
      const s = p.scale ?? 1, ry = p.rotY ?? 0;
      let k = p.type;
      let r = 1, g = 1, b = 1;
      const h1 = frac(Math.sin(p.x * 12.9898 + p.z * 78.233) * 43758.5453), h2 = frac(h1 * 91.7 + 0.13);
      const cs = Math.cos(ry), sn = Math.sin(ry);
      if (k === 'flowerbed') {
        // бортик: цвет по материалу; масштаб: round — радиус по XZ, rect — length по X, width по Z; высота бортика по Y
        const bh = p.height ?? 0.3;
        const sx = p.shape === 'rect' ? (p.length ?? 3) : (p.radius ?? 1.5), sz = p.shape === 'rect' ? (p.width ?? 1.5) : (p.radius ?? 1.5);
        col.set(({ granite: 0x9a8a84, concrete: 0xa8a59c, brick: 0x9a4b36 } as Record<string, number>)[p.border ?? ''] ?? [0xe0402a, 0x2f8fd0, 0xf2c014, 0x3fae4a, 0xffffff][Math.floor(h1 * 5)]);
        push(p.shape === 'rect' ? 'flowerbed_rect' : 'flowerbed_round', [cs * sx, 0, -sn * sx, 0, 0, bh, 0, 0, sn * sz, 0, cs * sz, 0, p.x, p.y - 0.02, p.z, 1], col.r, col.g, col.b);
        continue;
      }
      if (k === 'fence_gate') {
        // открытая створка калитки/ворот: панель ограды (сварная секция или по style), петля у точки, створка повёрнута ~70°
        const wdt = p.width ?? 1.2, ht = p.height ?? 1.6;
        const a = ry + 1.2, ux = Math.sin(a), uz = Math.cos(a); // направление створки
        const cx = p.x + ux * wdt / 2, cz = p.z + uz * wdt / 2, th = 0.025;
        const st = (p as unknown as { style?: string }).style ?? '';
        col.set(st === 'wood' ? 0x7a5a3a : st === 'chain_link' || st === 'chain' ? 0x9aa0a4 : h1 < 0.6 ? 0x2e5a3c : 0x1c1e20);
        const pat = st === 'wood' ? 5 : st === 'chain_link' || st === 'chain' ? 2 : 0;
        const G = grp('fence_panel');
        addS('fence', 'fence_panel', G.c.length / 3, [1, cx, p.y + ht / 2, cz, 0.06, ht / 2, wdt / 2, a]);
        push('fence_panel', [uz * th, 0, -ux * th, 0, 0, ht, 0, 0, ux * wdt, 0, uz * wdt, 0, cx, p.y - 0.03, cz, 1], col.r, col.g, col.b, pat, wdt, ht, 160);
        push('fence_post', [uz * 0.06, 0, -ux * 0.06, 0, 0, ht + 0.05, 0, 0, ux * 0.06, 0, uz * 0.06, 0, p.x, p.y - 0.1, p.z, 1], col.r, col.g, col.b, pat, 0, ht, 0);
        continue;
      }
      if (k === 'barrier_gate') {
        push('barrier_post', [cs, 0, -sn, 0, 0, 1, 0, 0, sn, 0, cs, 0, p.x, p.y, p.z, 1], 1, 1, 1);
        const ad = p.armDir ?? [-sn, -cs], L = p.armLength ?? 5;
        const a = Math.atan2(ad[0], ad[1]), ca = Math.cos(a), sa = Math.sin(a);
        push('barrier_arm', [ca, 0, -sa, 0, 0, 1, 0, 0, sa * L, 0, ca * L, 0, p.x + ad[0] * 0.18, p.y + 0.92, p.z + ad[1] * 0.18, 1], 1, 1, 1);
        addS('static', '', -1, [1, p.x, p.y + 0.5, p.z, 0.17, 0.5, 0.17, ry]);
        continue;
      }
      if (k === 'thicket') {
        // клумпа зарослей: XZ — радиус, Y — высота; стена стеблей (пешком не пройти, пешеходы обходят), машина продавливает
        // тонкие клумпы с сильной потерей скорости (стебли пригибаются), густые — останавливают (breakables.ts)
        const rad = p.radius ?? THICKET_R, hh = p.height ?? THICKET_H, sx = rad / THICKET_R, sy = hh / THICKET_H;
        const v = 0.86 + 0.24 * h1, idx = grp('thicket').c.length / 3;
        push('thicket', [cs * sx, 0, -sn * sx, 0, 0, sy, 0, 0, sn * sx, 0, cs * sx, 0, p.x, p.y, p.z, 1], v * (0.94 + 0.12 * h2), v, v * 0.9);
        addS(rad >= 2.5 && hh >= 5.2 ? 'thicket_dense' : 'thicket', 'thicket', idx, [0, p.x, p.y + 1.3, p.z, 1.3, rad * 0.78, 0, 0]);
        continue;
      }
      if (k.startsWith('tree_') || k === 'shrub') {
        if (!this.defs.has(k)) k = 'tree_maple';
        const v = 0.82 + 0.3 * h1; // яркость и лёгкий сдвиг тона кроны
        r = v * (0.92 + 0.18 * h2); g = v; b = v * (0.85 + 0.2 * h2);
        if (k === 'shrub') { const q = frac(h1 * 7.31); if (q > 0.6) k = 'shrub_' + (q < 0.75 ? 0 : q < 0.85 ? 1 : 2); }
        const T = this.trees[k];
        if (k === 'tree_negundo') addS('static', '', -1, [0, p.x, p.y + 2.0, p.z, 2.0, 0.45 * s, 0, 0]); // пучок стволиков
        else if (T && T.trunkR > 0) addS('static', '', -1, [0, p.x, p.y + 2.5, p.z, 2.5, T.trunkR * s, 0, 0]);
      } else if (k === 'parked_car') {
        const seed = p.seed ?? Math.floor(h1 * 65536);
        k = this.pickParked(seed);
        const c = carColor(seed);
        r = c.r; g = c.g; b = c.b;
        // стоит на колёсах: высота — по поверхностям под 4 колёсами (дорога +0.05, тротуар +0.15, площадка +0.03), наклон по ним;
        // сдвинутая ударом в этой сессии — там, где остановилась
        const ref = key + ':' + p.x.toFixed(2) + ',' + p.z.toFixed(2);
        if (this.takenCars.has(ref)) continue; // угнана игроком (GTA-режим) — теперь это физическая машина
        const moved = this.movedCars.get(ref);
        const m = moved ? moved.m : this.carMatrix(p.x, p.z, ry, s, surf);
        const idx = grp(k).c.length / 3;
        push(k, m, r, g, b);
        addS('parked_car', k, idx, moved ? moved.shape.slice() : [1, p.x, m[13] + 0.78, p.z, 0.88 * s, 0.72 * s, 2.25 * s, ry]);
        smeta[smeta.length - 1].ref = ref;
        if (!moved) carClear.push(p.x, p.z, cs, sn);
        continue;
      } else if (k === 'traffic_light') {
        const arm = (p.lanes ?? 0) >= 3;
        k = arm ? 'traffic_light_arm' : 'traffic_light';
        r = tlPhase.get(p)!; g = 0; b = 0; // (фаза, режим 0 = своя циклограмма, состояние)
        tlRefs.push({ x: p.x, y: p.y, z: p.z, rotY: ry, lanes: p.lanes ?? 0, tile: key, kind: k, index: grp(k).c.length / 3, state: -1 });
        addS(arm ? 'tl_arm' : 'tl', k, grp(k).c.length / 3, [0, p.x, p.y + (arm ? 3.2 : 1.6), p.z, arm ? 3.2 : 1.6, arm ? 0.16 : 0.08, 0, 0]);
      } else if (k === 'street_lamp' || k === 'street_lamp_double') {
        const hh = (k === 'street_lamp' ? 4.5 : 5.0) * s;
        addS(k === 'street_lamp' ? 'lamp' : 'lamp_double', k, grp(k).c.length / 3, [0, p.x, p.y + hh, p.z, hh, 0.13, 0, 0]);
      } else if (k === 'park_lamp') {
        addS('park_lamp', k, grp(k).c.length / 3, [0, p.x, p.y + 2.3, p.z, 2.3, 0.08, 0, 0]);
      } else if (k === 'lybed_lamp') { // фонари Лыбедского бульвара (world/lybed.ts)
        k = p.variant === 'disc2' ? 'lybed_lamp_disc2' : 'lybed_lamp_slim';
        addS('park_lamp', k, grp(k).c.length / 3, [0, p.x, p.y + 2.5, p.z, 2.5, 0.08, 0, 0]);
      } else if (k === 'lybed_xmas_tree') {
        this.lybedTrees.place(key, p as unknown as XmasTreeInst);
        continue;
      } else if (k === 'lamp_classic') {
        addS('lamp_classic', k, grp(k).c.length / 3, [0, p.x, p.y + 2.15, p.z, 2.15, 0.12, 0, 0]);
      } else if (k === 'kiosk') {
        col.set(KIOSK_COLORS[(typeof p.variant === 'number' ? p.variant : 0) % KIOSK_COLORS.length]);
        r = col.r; g = col.g; b = col.b;
        addS('kiosk', k, grp(k).c.length / 3, [1, p.x, p.y + 1.25, p.z, 1.35 * s, 1.25 * s, 1.05 * s, ry]);
      } else if (k === 'cafe_terrace') {
        col.set(UMBRELLA_COLORS[(typeof p.variant === 'number' ? p.variant : Math.floor(h1 * 6)) % UMBRELLA_COLORS.length]);
        r = col.r; g = col.g; b = col.b;
        addS('terrace', k, grp(k).c.length / 3, [1, p.x, p.y + 0.5, p.z, 2.0 * s, 0.5, 1.5 * s, ry]);
      } else if (k === 'street_sculpture') {
        const v = typeof p.variant === 'string' && SCULPTURE_VARIANTS.includes(p.variant) ? p.variant : 'figure';
        k = 'sculpture_' + v;
        // бронза на граните — не ломается (как памятники); у знака — стела в 0.9 м за диском (локальная +Z)
        if (v === 'marker') addS('static', '', -1, [1, p.x + sn * 0.9, p.y + 0.65, p.z + cs * 0.9, 0.25, 0.65, 0.15, ry]);
        else addS('static', '', -1, [0, p.x, p.y + 1.0, p.z, 1.0, v === 'mushroom' ? 0.6 : 0.45, 0, 0]);
      } else if (k === 'bollard') {
        addS('bollard', k, grp(k).c.length / 3, [0, p.x, p.y + 0.45, p.z, 0.45, 0.1, 0, 0]);
      } else if (k === 'bus_stop') {
        addS('bus_stop', k, grp(k).c.length / 3, [1, p.x, p.y + 1.3, p.z, 2.05 * s, 1.3 * s, 0.85 * s, ry]);
      } else if (k === 'container_site') {
        addS('container', k, grp(k).c.length / 3, [1, p.x, p.y + 1.1, p.z, 2.2 * s, 1.1 * s, 1.2 * s, ry]);
      } else if (k === 'bench') {
        addS('bench', k, grp(k).c.length / 3, [1, p.x, p.y + 0.42, p.z, 0.9 * s, 0.42 * s, 0.25 * s, ry]);
      } else if (k === 'trash_bin') {
        addS('bin', k, grp(k).c.length / 3, [0, p.x, p.y + 0.35, p.z, 0.35, 0.22, 0, 0]);
      } else if (k === 'playground_set') {
        const v = typeof p.variant === 'number' ? p.variant : 0;
        k = 'playground_' + (v % 4);
        const c = PLAY_COLORS[(v + Math.floor(h1 * 3)) % PLAY_COLORS.length];
        r = c.r; g = c.g; b = c.b;
      }
      if (!this.defs.has(k)) { warnOnce(p.type); continue; }
      push(k, [cs * s, 0, -sn * s, 0, 0, s, 0, 0, sn * s, 0, cs * s, 0, p.x, p.y, p.z, 1], r, g, b);
    }

    // подъезды: модель с крыльцом макс. 0.6 м опускается на (0.6 − stepsHeight)
    for (const en of json.entrances ?? []) {
      const cs = Math.cos(en.rotY), sn = Math.sin(en.rotY), sx = (en.width ?? 1.4) / 1.4;
      push('entrance', [cs * sx, 0, -sn * sx, 0, 0, 1, 0, 0, sn, 0, cs, 0, en.x, en.y - (0.6 - Math.min(0.6, en.stepsHeight ?? 0)), en.z, 1], 1, 1, 1);
    }
    // витрины + вывески: локальная X — вдоль стены (× ширина), Y — этаж (× высота), −Z — наружу (нормаль)
    (json.storefronts ?? []).forEach((sf, i) => {
      let tx = sf.x2 - sf.x1, tz = sf.z2 - sf.z1;
      const L = Math.hypot(tx, tz) || 1;
      tx /= L; tz /= L;
      if (tz * sf.nx - tx * sf.nz < 0) { tx = -tx; tz = -tz; } // det > 0
      const w = sf.width || L, h = sf.height || 3.2;
      const mx = (sf.x1 + sf.x2) / 2 + sf.nx * 0.02, mz = (sf.z1 + sf.z2) / 2 + sf.nz * 0.02, my = Math.min(sf.y1, sf.y2);
      const m = [tx * w, 0, tz * w, 0, 0, h, 0, 0, -sf.nx, 0, -sf.nz, 0, mx, my, mz, 1];
      push('storefront', m, 1, 1, 1);
      col.set(sf.signColor || '#2a5caa');
      push('sign', m, col.r, col.g, col.b, -1);
      signs.push({ id: key + ':' + i, text: sf.signText || sf.name || sf.label || '', color: sf.signColor || '#2a5caa' });
    });
    // ограды/ограждения
    const seg = buildSegments(json.segments ?? [], surf);
    for (const [k, G] of seg.groups) {
      const T = grp(k);
      T.m.push(...G.m); T.c.push(...G.c); T.e.push(...G.e); T.xz.push(...G.xz);
    }
    shapes.push(...seg.shapes);
    smeta.push(...seg.shapeMeta);
    // декали дорог
    const ed = this.edgesByTile.get(key);
    if (ed) {
      const D = buildDecals(ed, bounds);
      const T = grp('decal');
      T.m.push(...D.m); T.c.push(...D.c); T.e.push(...D.e); T.xz.push(...D.xz);
    }
    if (surf) this.grass.addTile(key, surf, seg.lines, carClear);

    const kinds = new Map<string, KindData>();
    for (const [k, G] of groups) {
      if (!G.c.length) continue;
      kinds.set(k, { n: G.c.length / 3, mat: new Float32Array(G.m), col: new Float32Array(G.c), ext: new Float32Array(G.e), xz: new Float32Array(G.xz) });
    }
    if (!isFinite(minY)) { minY = 0; maxY = 0; }
    const box = new THREE.Box3(
      new THREE.Vector3(bounds.minX - FRUSTUM_PAD, minY - 5, bounds.minZ - FRUSTUM_PAD),
      new THREE.Vector3(bounds.maxX + FRUSTUM_PAD, maxY + 5, bounds.maxZ + FRUSTUM_PAD),
    );
    this.tiles.set(key, {
      key, kinds, box, shapes: new Float32Array(shapes), smeta, broken: new Set(), colliders: null, pending: 0, signs,
      min: new THREE.Vector2(bounds.minX, bounds.minZ), max: new THREE.Vector2(bounds.maxX, bounds.maxZ),
    });
    this.trafficLights.push(...tlRefs);
    this.signalAcc = 1e9; // применить внешние фазы сразу
    this.dirty = true;
  }

  /**
   * Внешнее управление светофорами (src/traffic/signals.ts): функция вызывается ~5 раз/с для каждого светофора
   * загруженных тайлов и возвращает состояние; null — своя циклограмма (30 с, фаза на перекрёсток). Без источника — своя.
   */
  setSignalSource(fn: SignalSource | null): void {
    this.signalSource = fn;
    this.signalAcc = 1e9;
    if (!fn) for (const l of this.trafficLights) this.applySignal(l, null);
  }

  private applySignal(l: TrafficLightRef, s: SignalState): void {
    const st = s ?? -1;
    if (st === l.state) return;
    l.state = st;
    const d = this.tiles.get(l.tile)?.kinds.get(l.kind);
    if (!d) return;
    d.col[l.index * 3 + 1] = st < 0 ? 0 : 1;
    d.col[l.index * 3 + 2] = Math.max(st, 0);
    this.dirty = true;
  }

  /** Угнанные игроком машины парковки (ref) — при перезагрузке тайла не появляются. */
  private takenCars = new Set<string>();

  /**
   * GTA-режим: ближайшая целая машина парковки в радиусе r от (x, z). Матрица модели (на земле между осями), вид пропса
   * (car_p_<вид> — процедурная, car_<id> — glTF, car_sedan/car_wagon — старые), цвет инстанса.
   */
  findParkedCar(x: number, z: number, r: number): { tile: string; si: number; matrix: THREE.Matrix4; kind: string; color: THREE.Color; x: number; z: number } | null {
    let best: { tile: string; si: number; matrix: THREE.Matrix4; kind: string; color: THREE.Color; x: number; z: number } | null = null;
    let bd = r;
    for (const t of this.tiles.values()) {
      if (t.max.x < x - r || t.min.x > x + r || t.max.y < z - r || t.min.y > z + r) continue;
      for (let si = 0; si < t.smeta.length; si++) {
        const meta = t.smeta[si];
        if (!meta || meta.cls !== 'parked_car' || t.broken.has(si) || meta.idx < 0) continue;
        const o = si * 8, cx = t.shapes[o + 1], cz = t.shapes[o + 3];
        const d = Math.hypot(cx - x, cz - z);
        if (d >= bd) continue;
        const kd = t.kinds.get(meta.kind);
        if (!kd) continue;
        bd = d;
        best = { tile: t.key, si, matrix: new THREE.Matrix4().fromArray(kd.mat, meta.idx * 16), kind: meta.kind,
          color: new THREE.Color(kd.col[meta.idx * 3], kd.col[meta.idx * 3 + 1], kd.col[meta.idx * 3 + 2]), x: cx, z: cz };
      }
    }
    // сдвинутые ударом (динамическое тело, ещё катятся/не «заснули»): тоже можно угнать — поза из тела
    for (const d of this.debris) {
      if (!d.car || this.tiles.get(d.car.tile.key) !== d.car.tile) continue;
      const tr = d.body.translation();
      const dd = Math.hypot(tr.x - x, tr.z - z);
      if (dd >= bd) continue;
      const r = d.body.rotation();
      const m = new THREE.Matrix4().compose(new THREE.Vector3(tr.x, tr.y, tr.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(1, 1, 1)).multiply(d.offset);
      bd = dd;
      best = { tile: d.car.tile.key, si: d.car.si, matrix: m, kind: d.kind, color: new THREE.Color(d.col[0], d.col[1], d.col[2]), x: tr.x, z: tr.z };
    }
    return best;
  }

  /** Убрать машину парковки (стала физической машиной игрока): инстанс, коллайдер; запомнить до конца сессии. */
  takeParkedCar(tile: string, si: number): boolean {
    const t = this.tiles.get(tile);
    if (!t) return false;
    if (t.broken.has(si)) {
      // сдвинутая ударом (динамическое тело): убрать тело без «засыпания» обратно в инстанс
      const i = this.debris.findIndex((d) => d.car && d.car.tile === t && d.car.si === si);
      if (i < 0) return false;
      const d = this.debris[i];
      this.physics.world.removeRigidBody(d.body);
      this.debris.splice(i, 1);
      if (d.car!.ref) { this.takenCars.add(d.car!.ref); this.movedCars.delete(d.car!.ref); }
      this.dirty = true;
      return true;
    }
    const meta = t.smeta[si];
    t.broken.add(si);
    const c = t.colliders?.[si];
    if (c) { this.owners.delete(c.handle); this.physics.world.removeCollider(c, false); t.colliders![si] = null; this.stats.colliders--; }
    const d = t.kinds.get(meta.kind);
    if (d && meta.idx >= 0) d.mat.fill(0, meta.idx * 16, meta.idx * 16 + 16);
    if (meta.ref) this.takenCars.add(meta.ref);
    t.grid = undefined;
    this.dirty = true;
    return true;
  }

  /**
   * Статические препятствия (для пешеходов и т. п.): твёрдые пропсы — стволы, опоры, машины, остановки, контейнеры,
   * ограды/стены/отбойники, боллards, шлагбаумы — в круге r вокруг (x, z). Берутся те же фигуры, что и для коллайдеров
   * (есть даже без активных коллайдеров). out: плоский массив по 6 чисел на фигуру:
   * [тип 0 — круг (a = радиус) | 1 — повёрнутый прямоугольник (a, b — полуразмеры по локальным X, Z), x, z, a, b, rotY].
   * Возвращает число фигур. Сетка 8 м на тайл строится лениво при первом запросе.
   */
  queryObstacles(x: number, z: number, r: number, out: number[]): number {
    out.length = 0;
    let n = 0;
    for (const t of this.tiles.values()) {
      if (t.max.x < x - r || t.min.x > x + r || t.max.y < z - r || t.min.y > z + r) continue;
      const grid = t.grid ?? (t.grid = buildObstacleGrid(t));
      const i0 = Math.max(0, Math.floor((x - r - t.min.x) / 8)), i1 = Math.min(31, Math.floor((x + r - t.min.x) / 8));
      const j0 = Math.max(0, Math.floor((z - r - t.min.y) / 8)), j1 = Math.min(31, Math.floor((z + r - t.min.y) / 8));
      const seen = new Set<number>();
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        for (const s of grid[j * 32 + i] ?? []) {
          if (seen.has(s) || t.broken.has(s)) continue; // сломанные/угнанные — уже не препятствие
          seen.add(s);
          const o = s * 8, S = t.shapes;
          if (S[o] === 0) out.push(0, S[o + 1], S[o + 3], S[o + 5], 0, 0);
          else out.push(1, S[o + 1], S[o + 3], S[o + 4], S[o + 6], S[o + 7]);
          n++;
        }
      }
    }
    return n;
  }

  /** Точка (x, z) внутри препятствия (с запасом pad, м)? */
  isBlocked(x: number, z: number, pad = 0.2): boolean {
    const buf = this.obstBuf;
    const n = this.queryObstacles(x, z, 3 + pad, buf);
    for (let k = 0; k < n; k++) {
      const o = k * 6, dx = x - buf[o + 1], dz = z - buf[o + 2];
      if (buf[o] === 0) { if (dx * dx + dz * dz < (buf[o + 3] + pad) ** 2) return true; continue; }
      const c = Math.cos(buf[o + 5]), s = Math.sin(buf[o + 5]);
      // локальные координаты прямоугольника: X = (cos, −sin), Z = (sin, cos) (поворот вокруг Y)
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) < buf[o + 3] + pad && Math.abs(lz) < buf[o + 4] + pad) return true;
    }
    return false;
  }
  private obstBuf: number[] = [];

  removeTile(key: string): void {
    const t = this.tiles.get(key);
    if (!t) return;
    for (let i = this.trafficLights.length - 1; i >= 0; i--) if (this.trafficLights[i].tile === key) this.trafficLights.splice(i, 1);
    this.dropColliders(t);
    this.tiles.delete(key);
    this.dirty = true;
  }

  /** Трава снимается и у тайлов без пропсов. */
  removeTileAll(key: string): void {
    this.removeTile(key);
    this.lybedTrees.remove(key);
    this.grass.removeTile(key);
  }

  // ---------------- кадр ----------------

  update(camera: THREE.Camera, carPos: THREE.Vector3, dt: number): void {
    this.uniforms.uTime.value += dt;
    this.signalAcc += dt;
    if (this.signalSource && this.signalAcc >= 0.2) {
      this.signalAcc = 0;
      for (const l of this.trafficLights) this.applySignal(l, this.signalSource(l));
    }
    this.updateColliders(carPos);
    if (this.debris.length || this.debrisPools.size) this.updateDebris(carPos, dt);
    // шейдер травы тяжёлый (≈ секунды синхронной компиляции на ANGLE/Metal) — компилируем асинхронно, до этого трава скрыта
    if (this.grassState === 'wait' && this.renderer && this.root.parent) {
      this.grassState = 'compiling';
      this.grass.root.visible = true;
      this.renderer.compileAsync(this.grass.root, camera, this.root.parent as THREE.Scene)
        .then(() => { this.grassState = 'ready'; }).catch(() => { this.grassState = 'ready'; });
    }
    this.grass.enabled = this.grassState === 'ready';
    this.grass.update(camera);
    const cp = camera.position;
    const dir = camera.getWorldDirection(new THREE.Vector3());
    if (!this.dirty && cp.distanceToSquared(this.lastPos) < REBUILD_MOVE * REBUILD_MOVE && dir.angleTo(this.lastDir) < REBUILD_TURN) return;
    this.rebuild(camera);
  }

  private rebuild(camera: THREE.Camera): void {
    const t0 = performance.now();
    this.dirty = false;
    camera.updateMatrixWorld();
    this.lastPos.copy(camera.position);
    camera.getWorldDirection(this.lastDir);
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const cx = camera.position.x, cz = camera.position.z;
    for (const p of this.pools.values()) { p.count = 0; p.begin?.(cx, cz); }
    this.assignSigns(cx, cz);
    let total = 0;
    for (const t of this.tiles.values()) {
      for (const d of t.kinds.values()) total += d.n;
      if (!this.frustum.intersectsBox(t.box)) continue;
      const dx = Math.max(t.min.x - cx, 0, cx - t.max.x), dz = Math.max(t.min.y - cz, 0, cz - t.max.y);
      const dmin = Math.hypot(dx, dz);
      const fx = Math.max(Math.abs(cx - t.min.x), Math.abs(cx - t.max.x)), fz = Math.max(Math.abs(cz - t.min.y), Math.abs(cz - t.max.y));
      const dmax = Math.hypot(fx, fz);
      for (const [k, d] of t.kinds) {
        const def = this.defs.get(k);
        if (!def) { warnOnce(k); continue; }
        if (dmin > def.farDist) continue;
        const near = this.pools.get(k + ':n')!, far = this.pools.get((def.farPool ?? k) + ':f');
        if (!far) {
          if (dmax <= def.farDist) near.addBlock(d);
          else this.perInstance(d, cx, cz, near, null, def.farDist, def.farDist);
        } else if (dmax <= def.nearDist) near.addBlock(d);
        else if (dmin >= def.nearDist && dmax <= def.farDist) far.addBlock(d);
        else this.perInstance(d, cx, cz, near, far, def.nearDist, def.farDist);
      }
    }
    let drawn = 0;
    for (const p of this.pools.values()) { p.commit(); drawn += p.count; }
    this.stats.instances = total;
    this.stats.drawn = drawn;
    this.stats.rebuilds++;
    this.stats.rebuildMs = performance.now() - t0;
  }

  /** Ячейки атласа ближайшим вывескам (≤ SIGN_CELLS в радиусе SIGN_DIST), остальным −1 (сплошной цвет). */
  private assignSigns(cx: number, cz: number): void {
    const cand: { t: TileProps; d: KindData; i: number; q: number }[] = [];
    for (const t of this.tiles.values()) {
      const d = t.kinds.get('sign');
      if (!d) continue;
      for (let i = 0; i < d.n; i++) {
        const q = (d.xz[i * 2] - cx) ** 2 + (d.xz[i * 2 + 1] - cz) ** 2;
        if (q < SIGN_DIST * SIGN_DIST) cand.push({ t, d, i, q }); else d.ext[i * 4] = -1;
      }
    }
    cand.sort((a, b) => a.q - b.q);
    const keep = new Set<number>();
    cand.forEach((c, n) => {
      const s = c.t.signs[c.i];
      c.d.ext[c.i * 4] = n < SIGN_CELLS - 10 && s.text ? this.atlas.cellFor(s.id, s.text, s.color, keep) : -1;
    });
  }

  private perInstance(d: KindData, cx: number, cz: number, near: PoolLike, far: PoolLike | null, nearD: number, farD: number): void {
    const n2 = nearD * nearD, f2 = farD * farD, xz = d.xz;
    for (let i = 0; i < d.n; i++) {
      const dx = xz[i * 2] - cx, dz = xz[i * 2 + 1] - cz, q = dx * dx + dz * dz;
      if (q < n2) near.addOne(d, i);
      else if (far && q < f2) far.addOne(d, i);
    }
  }

  // ---------------- физика ----------------

  private updateColliders(car: THREE.Vector3): void {
    let budget = COLLIDER_BUDGET;
    for (const t of this.tiles.values()) {
      const dx = Math.max(t.min.x - car.x, 0, car.x - t.max.x), dz = Math.max(t.min.y - car.z, 0, car.z - t.max.y);
      const d = Math.hypot(dx, dz);
      if (d > COLLIDER_OFF) { if (t.colliders) this.dropColliders(t); continue; }
      if (d > COLLIDER_ON && !t.colliders) continue;
      if (!t.colliders) { t.colliders = []; t.pending = 0; }
      if (budget <= 0) continue;
      budget -= this.createSome(t, budget);
    }
  }

  private q = new THREE.Quaternion();
  private yAxis = new THREE.Vector3(0, 1, 0);

  private createSome(t: TileProps, budget: number): number {
    const S = t.shapes, n = S.length / 8;
    let made = 0;
    const w = this.physics.world;
    while (t.pending < n && made < budget) {
      const o = t.pending * 8;
      if (t.broken.has(t.pending)) { t.colliders!.push(null); t.pending++; continue; }
      const desc = S[o] === 0
        ? RAPIER.ColliderDesc.cylinder(S[o + 4], S[o + 5])
        : RAPIER.ColliderDesc.cuboid(S[o + 4], S[o + 5], S[o + 6]);
      desc.setTranslation(S[o + 1], S[o + 2], S[o + 3]).setCollisionGroups(PROP_GROUPS).setFriction(0.5);
      if (S[o] === 1 && S[o + 7] !== 0) {
        this.q.setFromAxisAngle(this.yAxis, S[o + 7]);
        desc.setRotation({ x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w });
      }
      this.withEvents(desc, t, t.pending);
      const col = w.createCollider(desc);
      t.colliders!.push(col);
      this.own(col, t, t.pending);
      t.pending++;
      made++;
    }
    this.stats.colliders += made;
    return made;
  }

  private dropColliders(t: TileProps): void {
    if (!t.colliders) return;
    let n = 0;
    for (const c of t.colliders) if (c) { this.owners.delete(c.handle); this.physics.world.removeCollider(c, false); n++; }
    this.stats.colliders -= n;
    t.colliders = null;
    t.pending = 0;
  }

  dispose(): void {
    for (const t of this.tiles.values()) this.dropColliders(t);
    while (this.debris.length) this.removeDebris(0);
    this.tiles.clear();
    for (const p of this.pools.values()) p.mesh.dispose();
    const geos = new Set<THREE.BufferGeometry>();
    for (const d of this.defs.values()) { geos.add(d.near); if (d.far) geos.add(d.far); }
    geos.forEach((g) => g.dispose());
    Object.values(this.mats).forEach((m) => m.dispose());
    this.grass.dispose();
    this.atlas.dispose();
    this.root.removeFromParent();
  }
}

const frac = (x: number) => x - Math.floor(x);
const warned = new Set<string>();

/**
 * Составной коллайдер опор (обломки): боксы консолей и голов в локальных осях модели относительно центра цилиндра опоры
 * (центр = высота hh над основанием). [x, y, z, hx, hy, hz]; s — масштаб инстанса. Размеры чуть толще геометрии (без туннелирования).
 */
function poleParts(kind: string, hh: number, s: number): number[][] {
  const P = (x: number, y: number, z: number, hx: number, hy: number, hz: number) => [x * s, y * s - hh, z * s, hx * s, hy * s, hz * s];
  switch (kind) {
    case 'street_lamp': return [P(0, 9.05, -0.9, 0.07, 0.08, 0.9), P(0, 9.22, -1.9, 0.17, 0.09, 0.32)];
    case 'street_lamp_double': return [P(0, 9.95, 1.0, 0.07, 0.08, 1.0), P(0, 10.12, 2.0, 0.17, 0.09, 0.32), P(0, 9.95, -1.0, 0.07, 0.08, 1.0), P(0, 10.12, -2.0, 0.17, 0.09, 0.32)];
    case 'traffic_light_arm': return [P(3.2, 6.15, 0, 3.25, 0.08, 0.08), P(5.6, 5.45, 0, 0.18, 0.5, 0.14), P(0, 2.85, 0, 0.18, 0.5, 0.14)];
    case 'traffic_light': return [P(0, 2.85, 0, 0.18, 0.5, 0.14)];
    default: return [];
  }
}

/** Сетка 8 м по тайлу: фигура попадает во все ячейки своего описанного квадрата. */
function buildObstacleGrid(t: TileProps): (number[] | undefined)[] {
  const g: (number[] | undefined)[] = new Array(32 * 32);
  const S = t.shapes, n = S.length / 8;
  for (let s = 0; s < n; s++) {
    const o = s * 8, x = S[o + 1], z = S[o + 3];
    const rad = S[o] === 0 ? S[o + 5] : Math.hypot(S[o + 4], S[o + 6]);
    const i0 = Math.max(0, Math.floor((x - rad - t.min.x) / 8)), i1 = Math.min(31, Math.floor((x + rad - t.min.x) / 8));
    const j0 = Math.max(0, Math.floor((z - rad - t.min.y) / 8)), j1 = Math.min(31, Math.floor((z + rad - t.min.y) / 8));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (g[j * 32 + i] ??= []).push(s);
  }
  return g;
}
/** Неизвестный тип пропса: предупредить один раз и пропустить (не падать на новых слоях пайплайна). */
function warnOnce(type: string): void {
  if (warned.has(type)) return;
  warned.add(type);
  console.warn(`[props] неизвестный тип «${type}» — пропущен`);
}
const lin = (hex: number) => new THREE.Color(hex);

/** Цвета машин (частые в Рязани: белый, серебро, серый, чёрный, синий, вишня, бежевый…), вес — частота. */
const CAR_PALETTE: [number, number][] = [
  [0xe6e6e3, 22], [0xa9adb1, 18], [0x5f6468, 12], [0x25282c, 12], [0x1e2f57, 7], [0x5a1820, 6], [0x9b1d1a, 5],
  [0xbcae8c, 5], [0x2d4a33, 4], [0x6d8fb0, 4], [0x7a5a3a, 3], [0xd5b21c, 2],
].map(([h, w]) => [h, w] as [number, number]);
const CAR_W = CAR_PALETTE.reduce((a, [, w]) => a + w, 0);
const CAR_COLORS = CAR_PALETTE.map(([h]) => lin(h));
function carColor(seed: number): THREE.Color {
  let x = ((seed >>> 1) * 2654435761 >>> 0) % CAR_W;
  for (let i = 0; i < CAR_PALETTE.length; i++) { x -= CAR_PALETTE[i][1]; if (x < 0) return CAR_COLORS[i]; }
  return CAR_COLORS[0];
}

const PLAY_COLORS = [0xd8402c, 0x2f8fd0, 0x3fae4a, 0xe8b820, 0x9a4fc0, 0xe86f20].map(lin);
/** Пешеходная улица: корпуса киосков (variant 0..2), купола зонтов кафе-террас (variant 0..5), варианты скульптур. */
const KIOSK_COLORS = [0x2f6fb0, 0xe6e1d4, 0x3f8a4a];
const UMBRELLA_COLORS = [0xe8e2d0, 0x8a1e22, 0x2f5d3a, 0xd9a521, 0x2a4f7a, 0xc8502a];
const SCULPTURE_VARIANTS = ['figure', 'mushroom', 'marker'];
/**
 * Фазы светофоров: светофоры ближе 45 м друг к другу — один перекрёсток (общая случайная фаза);
 * подходы «поперёк» (|sin rotY| > |cos rotY|) сдвинуты на полцикла.
 */
function trafficPhases(tl: { x: number; z: number; rotY?: number }[]): Map<object, number> {
  const out = new Map<object, number>();
  const cluster: number[] = tl.map((_, i) => i);
  for (let i = 0; i < tl.length; i++) for (let j = 0; j < i; j++) {
    if (Math.hypot(tl[i].x - tl[j].x, tl[i].z - tl[j].z) < 45) { cluster[i] = cluster[j]; break; }
  }
  tl.forEach((p, i) => {
    const c = tl[cluster[i]];
    const base = frac(Math.sin(Math.round(c.x) * 0.173 + Math.round(c.z) * 0.311) * 43758.5453);
    const r = p.rotY ?? 0;
    out.set(p, frac(base + (Math.abs(Math.sin(r)) > Math.abs(Math.cos(r)) ? 0.5 : 0)));
  });
  return out;
}
