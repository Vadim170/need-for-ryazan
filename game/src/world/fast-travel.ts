import * as THREE from 'three';
import type { CityWorld } from './city-world';
import { RoadIndex } from './road-index';
import { SURF } from './surface-mask';
import type { PhysicsWorld } from '../physics/world';

export interface FastTravelDeps {
  city: CityWorld;
  physics: PhysicsWorld;
  /** Едет ли игрок (иначе пешком, GTA-режим). */
  driving: () => boolean;
  /** Поставить машину игрока (позиция центра шасси, yaw как у Vehicle.reset); камеру притянуть. */
  placeCar: (pos: THREE.Vector3, yaw: number) => void;
  /** Поставить пешехода (ноги на pos). */
  placeFoot: (pos: THREE.Vector3) => void;
  /** Пешеходный граф (people/walk.json) — когда загружен. */
  walkGraph: () => { nearestNode(x: number, z: number, r: number): number; x: Float32Array; y: Float32Array; z: Float32Array } | null;
  /** Запросить подгрузку тайлов после перестановки (по умолчанию city.preload). */
  onDone?: (x: number, z: number) => void;
}

export interface TravelTarget { x: number; y: number; z: number; yaw: number; kind: 'road' | 'walk' | 'terrain'; snapDist: number }

/**
 * Быстрый переезд по карте мира: ближайшая точка дороги (на машине, в правой полосе, курс вдоль дороги) или пешеходного
 * графа (пешком), затем — подгрузка тайлов вокруг цели с чёрным затемнением, коллайдеры готовы, скорости сброшены.
 * Игра на паузе (`busy`), пока идёт переезд; main.ts не шагает физику и системы.
 */
export class FastTravel {
  busy = false;
  /** Куда сейчас стримить мир (пока busy). */
  focus: THREE.Vector3 | null = null;
  readonly roads: RoadIndex;
  private veil = document.createElement('div');
  private veilText = document.createElement('div');

  constructor(private d: FastTravelDeps) {
    this.roads = new RoadIndex(d.city.graph);
    const v = this.veil;
    v.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:60;transition:opacity .22s;display:flex;align-items:center;justify-content:center';
    this.veilText.style.cssText = 'color:#ddd;font:600 18px system-ui,sans-serif;letter-spacing:.08em;opacity:.8';
    v.appendChild(this.veilText);
    document.body.appendChild(v);
  }

  /** Цель для клика (x, z): без побочных эффектов. */
  resolve(x: number, z: number): TravelTarget {
    const { city } = this.d;
    if (!this.d.driving()) {
      const g = this.d.walkGraph();
      if (g) {
        for (const r of [40, 150, 600]) {
          const n = g.nearestNode(x, z, r);
          if (n >= 0) return { x: g.x[n], y: g.y[n] + 0.1, z: g.z[n], yaw: 0, kind: 'walk', snapDist: Math.hypot(g.x[n] - x, g.z[n] - z) };
        }
      }
      // нет пешеходного графа рядом (лес, пустырь): сам рельеф — воду проверяем после подгрузки тайла
      return { x, y: city.heightAt(x, z) + 0.2, z, yaw: 0, kind: 'terrain', snapDist: 0 };
    }
    let hit = null;
    for (const r of [80, 300, 1200, 4000]) { hit = this.roads.nearest(x, z, r); if (hit) break; }
    if (!hit) return { x, y: city.heightAt(x, z) + 1, z, yaw: 0, kind: 'terrain', snapDist: 0 };
    const e = city.graph.edges[hit.edge];
    // направление движения: односторонняя — по ребру; двусторонняя — по стороне, куда кликнули (правая полоса)
    let dir = e.oneway || (e.lanesBackward ?? 1) === 0 ? 1 : hit.side >= 0 ? 1 : -1;
    const fx = hit.tx * dir, fz = hit.tz * dir;
    let px = hit.x, pz = hit.z;
    if (!(e.oneway || (e.lanesBackward ?? 1) === 0)) { // правая полоса двусторонней: ¼ ширины вправо от оси
      const off = (e.width ?? 6) / 4;
      px += -fz * off; pz += fx * off;
    }
    return { x: px, y: hit.y, z: pz, yaw: Math.atan2(-fx, -fz), kind: 'road', snapDist: hit.dist };
  }

  /** Переехать. Resolve по завершении: тайлы вокруг загружены, игрок стоит на земле. */
  async go(x: number, z: number): Promise<TravelTarget | null> {
    if (this.busy) return null;
    this.busy = true;
    const { city, physics } = this.d;
    try {
      this.veilText.textContent = 'ЗАГРУЗКА…';
      this.veil.style.opacity = '1';
      let t = this.resolve(x, z);
      const pos = new THREE.Vector3(t.x, t.y, t.z);
      this.focus = pos.clone();
      const car = this.d.driving();
      const place = () => {
        if (car) this.d.placeCar(new THREE.Vector3(pos.x, pos.y + 1.0, pos.z), t.yaw);
        else this.d.placeFoot(pos);
      };
      place(); // тело сразу уезжает от старого места (физика не шагает, пока busy)
      await new Promise((r) => setTimeout(r, 230)); // дождаться затемнения
      await city.preload(pos, 250);
      // вода под ногами — ищем ближайшую сушу пешеходным графом (радиус 1.5 км)
      if (!car && t.kind === 'terrain' && city.surfaceAt(pos.x, pos.z) === SURF.water) {
        const g = this.d.walkGraph();
        const n = g ? g.nearestNode(pos.x, pos.z, 1500) : -1;
        if (g && n >= 0) { pos.set(g.x[n], g.y[n] + 0.1, g.z[n]); t = { ...t, x: pos.x, y: pos.y, z: pos.z, kind: 'walk' }; this.focus.copy(pos); await city.preload(pos, 250); }
      }
      // высота по готовым коллайдерам: дорога/мост/рельеф. Здания в точку не попадают (точка на дороге/тротуаре/рельефе)
      const gh = physics.groundHeightAt(pos.x, pos.z);
      if (gh > t.y - 2.5 && gh < t.y + 8) pos.y = Math.max(gh + (car ? 0 : 0.1), t.y);
      else if (t.kind === 'terrain') pos.y = Math.max(city.heightAt(pos.x, pos.z), gh) + (car ? 0 : 0.2);
      place();
      this.d.onDone?.(pos.x, pos.z);
      this.veil.style.opacity = '0';
      return { ...t, x: pos.x, y: pos.y, z: pos.z };
    } finally {
      this.veil.style.opacity = '0';
      this.busy = false;
      this.focus = null;
    }
  }
}
