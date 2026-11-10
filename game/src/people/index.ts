import * as THREE from 'three';
import { WalkGraph } from './walk-graph';
import { PeopleSystem, type PedSignalSource, type PlayerCarState, type TrafficCarsSource, type VehicleSource, type ObstacleSource } from './people-system';
import { RoadMask, type RoadGraphLike } from './road-mask';
import { RagdollPool } from './ragdoll';
import { GltfPeopleView } from './gltf-people-view';
import type { PeopleView } from './people-view';
import type { PhysicsWorld } from '../physics/world';

export { WalkGraph } from './walk-graph';
export { PeopleSystem } from './people-system';
export { GltfPeopleView } from './gltf-people-view';
export type { PedSignalSource, PlayerCarState, TrafficCarsSource, VehicleSource, ObstacleSource } from './people-system';

/** Минимум от трафика (src/traffic): машины симуляции и разбитые (физические) машины. */
export interface TrafficLike {
  sim: { vehicles: readonly { id: number; x: number; y: number; z: number; fx: number; fz: number; v: number; len: number; halfW: number; crashed: boolean }[] };
  physics: { crashedVehicles(): readonly { v: { id: number; x: number; y: number; z: number; fx: number; fz: number; len: number; halfW: number }; body: { linvel(): { x: number; y: number; z: number } } }[] };
}

/** Машины трафика для PeopleSystem.setVehicleSource: едущие — по скорости симуляции, разбитые — по скорости тела Rapier. */
export function vehiclesFromTraffic(t: TrafficLike): VehicleSource {
  return (fn) => {
    for (const v of t.sim.vehicles) if (!v.crashed) fn(v.id, v.x, v.y, v.z, v.fx * v.v, v.fz * v.v, v.fx, v.fz, v.len / 2, v.halfW);
    for (const c of t.physics.crashedVehicles()) {
      const lv = c.body.linvel(), v = c.v;
      fn(v.id, v.x, v.y, v.z, lv.x, lv.z, v.fx, v.fz, v.len / 2, v.halfW);
    }
  };
}

/** Минимум от машины игрока, что нужен пешеходам. */
export interface CarLike {
  position: THREE.Vector3;
  visual: THREE.Object3D;
  body: { linvel(): { x: number; y: number; z: number } };
}

export function playerFromCar(car: CarLike): () => PlayerCarState {
  const f = new THREE.Vector3();
  const st: PlayerCarState = { x: 0, y: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: -1, halfLength: 2.2, halfWidth: 0.9 };
  return () => {
    const p = car.position, v = car.body.linvel();
    f.set(0, 0, -1).applyQuaternion(car.visual.quaternion);
    const l = Math.hypot(f.x, f.z) || 1;
    st.x = p.x; st.y = p.y; st.z = p.z; st.vx = v.x; st.vz = v.z; st.fx = f.x / l; st.fz = f.z / l;
    return st;
  };
}

/**
 * Обёртка для main.ts: асинхронно грузит people/walk.json (не блокирует старт), до загрузки — ничего не делает.
 * Настройки (плотность, светофоры, трафик) можно задавать сразу — применятся после загрузки.
 */
export class People {
  system: PeopleSystem | null = null;
  readonly ready: Promise<PeopleSystem | null>;
  private density = 1;
  private signal: PedSignalSource | null = null;
  private traffic: TrafficCarsSource | null = null;
  private vehicles: VehicleSource | null = null;
  /** Вид: glTF-персонажи (до загрузки и при ошибке — процедурные внутри), ?people_view=proc — только процедурный. */
  readonly view: PeopleView | undefined;

  constructor(baseUrl: string, scene: THREE.Scene, opts: {
    heightAt: (x: number, z: number) => number; player: () => PlayerCarState | null; maxAgents?: number;
    /** roads/graph.json — чтобы при уклонении не шагать на проезжую часть. */
    roads?: RoadGraphLike;
    /** Rapier: здания (луч вниз) и рэгдоллы сбитых (пул 8). */
    physics?: PhysicsWorld;
    ragdolls?: number;
    /** Статические препятствия пропсов (city.props: queryObstacles / isBlocked). */
    obstacles?: ObstacleSource;
  }) {
    const viewParam = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('people_view') : null;
    this.view = viewParam === 'proc' ? undefined : new GltfPeopleView(Math.max((opts.maxAgents ?? 1300) + 300, 512), { heightAt: opts.heightAt });
    this.ready = WalkGraph.load(baseUrl).then((g) => {
      if (!g) { console.info('[people] нет people/walk.json — пешеходов не будет'); this.view?.dispose(); return null; }
      const ph = opts.physics;
      const s = new PeopleSystem(g, {
        heightAt: opts.heightAt, maxAgents: opts.maxAgents, view: this.view,
        roadMask: opts.roads ? new RoadMask(opts.roads) : undefined,
        isBlocked: ph ? (x, z) => ph.groundHeightAt(x, z) - opts.heightAt(x, z) > 1.0 : undefined,
        ragdolls: ph && (opts.ragdolls ?? 8) > 0 ? this.makeRagdolls(ph, scene, opts.ragdolls ?? 8) : undefined,
        obstacles: opts.obstacles,
      });
      s.setVehicleSource(this.vehicles);
      s.setPlayerSource(opts.player);
      s.setDensityFactor(this.density);
      s.setSignalSource(this.signal);
      s.setTrafficSource(this.traffic);
      scene.add(s.root);
      this.system = s;
      console.info(`[people] граф: ${g.n} узлов, ${g.stats.edges} рёбер, ${g.crossings.length} переходов, ${g.poiN} POI`);
      return s;
    });
  }

  private makeRagdolls(ph: PhysicsWorld, scene: THREE.Scene, n: number): RagdollPool {
    const pool = new RagdollPool(ph, scene, n);
    if (this.view instanceof GltfPeopleView) pool.skin = this.view; // сбитые — тем же glTF-персонажем
    // ?ragdoll_debug=1 — тела рэгдолла каркасом поверх персонажа (проверка привязки костей)
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('ragdoll_debug') === '1') pool.debug = true;
    return pool;
  }

  update(dt: number, center: THREE.Vector3, camera: THREE.Camera): void {
    if (this.view instanceof GltfPeopleView) this.view.camera = camera;
    this.system?.update(dt, center, camera);
  }
  setDensityFactor(f: number): void { this.density = f; this.system?.setDensityFactor(f); }
  setSignalSource(fn: PedSignalSource | null): void { this.signal = fn; this.system?.setSignalSource(fn); }
  setTrafficSource(src: TrafficCarsSource | null): void { this.traffic = src; this.system?.setTrafficSource(src); }
  /** Машины трафика пугают/сбивают пешеходов так же, как машина игрока (см. vehiclesFromTraffic). */
  setVehicleSource(src: VehicleSource | null): void { this.vehicles = src; this.system?.setVehicleSource(src); }
  /**
   * Сезон одежды пешеходов (glTF-вид, иначе ничего не делает): 0 — осень, 1 — зима (пальто, шапки, шарфы, перчатки,
   * тёмная палитра); дробное — доля «зимних» людей. См. GltfPeopleView.setWinter.
   */
  setWinter(f: number): void { if (this.view instanceof GltfPeopleView) this.view.setWinter(f); }
  setSeason(season: 'autumn' | 'winter'): void { this.setWinter(season === 'winter' ? 1 : 0); }
  /** Строка для отладочной панели. */
  info(): string {
    const s = this.system?.stats;
    if (!s) return '';
    const v = this.view instanceof GltfPeopleView && this.view.stats.ready ? `\n  glTF lod0 ${this.view.stats.lod0} lod1 ${this.view.stats.lod1} proc ${this.view.stats.proc}` : '';
    return `\npeople ${s.visible}/${s.active} (target ${s.target}) ${s.updateMs.toFixed(2)}ms  wait ${s.waitingAtCrossings} cross ${s.crossing}` + v;
  }
}
