/**
 * События GTA-режима для звука и других систем (docs/stage3/gta-mode.md, раздел «События»). Подписка:
 *   import { gameEvents } from '../combat/events';
 *   gameEvents.on('gunshot', (e) => …);
 * Также доступно как window.__game.gta.events. Координаты — мировые (three.js).
 * Непрерывные источники (сирены полиции) — опрос: window.__game.gta.police.sirens() / Police.sirens().
 */
export interface GameEventMap {
  /** Выстрел: оружие, точка дула, кто стрелял. */
  gunshot: { weapon: string; x: number; y: number; z: number; byPlayer: boolean };
  /** Попадание пули: поверхность ('world' | 'vehicle' | 'ped' | 'cop' | 'player' | 'glass'). */
  impact: { surface: string; x: number; y: number; z: number };
  /** Удар рукой/ногой: hit — попал ли. */
  punch: { x: number; y: number; z: number; hit: boolean; kick: boolean; byPlayer: boolean };
  /** Шаг игрока (и полицейских рядом): run/sprint — темп, surface — код покрытия (world/surface-mask SURF, −1 — неизвестно). */
  footstep: { x: number; y: number; z: number; speed: number; surface: number; byPlayer: boolean };
  /** Прыжок/приземление игрока. */
  jump: { x: number; y: number; z: number };
  land: { x: number; y: number; z: number; speed: number };
  /** Дверь машины: открыть/закрыть (посадка/высадка/угон). */
  carDoor: { x: number; y: number; z: number; open: boolean };
  /** Сирена конкретной машины полиции включилась/выключилась (непрерывный звук — опросом sirens()). */
  siren: { id: number; on: boolean; x: number; y: number; z: number };
  /** Взрыв машины. */
  explosion: { x: number; y: number; z: number; power: number };
  /** Пустой магазин / перезарядка / смена оружия. */
  dryFire: { weapon: string };
  reload: { weapon: string };
  weaponSwitch: { weapon: string };
  /** Подобрал деньги/оружие. */
  pickup: { kind: 'money' | 'weapon' | 'ammo' | 'armor' | 'health'; amount: number; x: number; y: number; z: number };
  /** Уровень розыска изменился. */
  wanted: { level: number; prev: number };
  /** Крик/паника пешеходов. */
  scream: { x: number; y: number; z: number };
  /** Смерть / арест игрока, респаун. */
  wasted: { x: number; y: number; z: number };
  busted: { x: number; y: number; z: number };
  respawn: { x: number; y: number; z: number; at: 'hospital' | 'police' };
}

type Handler<T> = (e: T) => void;

export class GameEvents {
  private h = new Map<keyof GameEventMap, Handler<never>[]>();
  /** Последние события (отладка). */
  readonly log: { type: string; t: number }[] = [];
  on<K extends keyof GameEventMap>(type: K, fn: Handler<GameEventMap[K]>): () => void {
    const l = this.h.get(type) ?? [];
    l.push(fn as Handler<never>);
    this.h.set(type, l);
    return () => { const i = l.indexOf(fn as Handler<never>); if (i >= 0) l.splice(i, 1); };
  }
  emit<K extends keyof GameEventMap>(type: K, e: GameEventMap[K]): void {
    this.log.push({ type, t: performance.now() });
    if (this.log.length > 50) this.log.shift();
    const l = this.h.get(type);
    if (l) for (const fn of l) (fn as Handler<GameEventMap[K]>)(e);
  }
}

export const gameEvents = new GameEvents();
