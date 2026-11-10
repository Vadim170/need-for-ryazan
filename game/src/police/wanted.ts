import * as THREE from 'three';
import { gameEvents } from '../combat/events';

/**
 * Розыск 0–5 звёзд (аркада, docs/stage3/gta-mode.md). «Жар» (heat) растёт от преступлений, уровень — порог жара.
 * Преступление засчитывается, если его видел полицейский (сразу) или прохожие (через 2–5 с «звонок в полицию»).
 * Пока полиция видит игрока — жар не падает; не видит дольше evade(уровень) — минус звезда (звёзды мигают — «поиск»).
 */
export type Crime = 'punch' | 'rob' | 'carjack' | 'steal' | 'shoot' | 'shootPed' | 'hitCop' | 'downCop' | 'shootCop' | 'copCar' | 'explosion' | 'runOver';

const HEAT: Record<Crime, number> = {
  punch: 12, rob: 25, carjack: 30, steal: 15, shoot: 30, shootPed: 45, hitCop: 35, downCop: 90, shootCop: 60, copCar: 160, explosion: 70, runOver: 30,
};
/** Минимальный уровень после преступления. */
const MIN_LEVEL: Partial<Record<Crime, number>> = { hitCop: 2, shootCop: 3, downCop: 3, copCar: 4, shootPed: 2 };
export const LEVELS = [0, 20, 80, 180, 320, 520];

export class Wanted {
  heat = 0;
  level = 0;
  /** Сколько секунд полиция не видит игрока. */
  unseen = 0;
  /** Последнее известное место. */
  readonly lastKnown = new THREE.Vector3();
  /** Звёзды мигают (полиция ищет). */
  searching = false;
  private pending: { crime: Crime; t: number; at: THREE.Vector3 }[] = [];
  /** Отключить (отладка, ?police=0). */
  enabled = true;

  /** Сколько секунд вне видимости нужно, чтобы потерять звезду. */
  evadeTime(level = this.level): number { return 10 + level * 5; }

  /**
   * Преступление: copSaw — видел полицейский (сразу), witnesses — сколько прохожих видели (звонок через 2–5 с).
   * Без свидетелей не засчитывается.
   */
  report(crime: Crime, at: THREE.Vector3, copSaw: boolean, witnesses: number): void {
    if (!this.enabled) return;
    if (copSaw) { this.apply(crime, at); return; }
    if (witnesses <= 0) return;
    if (this.pending.some((p) => p.crime === crime && p.at.distanceTo(at) < 15)) return;
    this.pending.push({ crime, t: 2 + Math.random() * 3 - Math.min(witnesses, 4) * 0.3, at: at.clone() });
  }

  private apply(crime: Crime, at: THREE.Vector3): void {
    const prev = this.level;
    this.heat = Math.min(800, this.heat + HEAT[crime] * (this.level >= 3 ? 0.7 : 1));
    const min = MIN_LEVEL[crime] ?? 1;
    if (this.heat < LEVELS[min]) this.heat = LEVELS[min] + 1;
    this.lastKnown.copy(at);
    this.unseen = 0;
    this.recompute(prev);
  }

  private recompute(prev: number): void {
    let l = 0;
    for (let i = 1; i < LEVELS.length; i++) if (this.heat >= LEVELS[i]) l = i;
    this.level = l;
    if (l !== prev) gameEvents.emit('wanted', { level: l, prev });
  }

  set(level: number): void {
    const prev = this.level;
    this.heat = level > 0 ? LEVELS[Math.min(5, level)] + 1 : 0;
    this.unseen = 0;
    this.recompute(prev);
  }

  clear(): void { this.pending.length = 0; this.set(0); }

  update(dt: number, seen: boolean, playerPos: THREE.Vector3): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      p.t -= dt;
      if (p.t <= 0) { this.pending.splice(i, 1); this.apply(p.crime, p.at); }
    }
    if (this.level === 0) { this.searching = false; return; }
    if (seen) { this.unseen = 0; this.lastKnown.copy(playerPos); this.searching = false; return; }
    this.unseen += dt;
    this.searching = this.unseen > 3;
    if (this.unseen > this.evadeTime()) {
      const prev = this.level;
      this.heat = this.level > 1 ? LEVELS[this.level - 1] + 1 : 0;
      this.unseen = 0;
      this.recompute(prev);
    }
  }
}
