import * as THREE from 'three';
import { HumanRig } from '../player/human-rig';
import { CharacterBody } from '../player/character-body';
import type { Fighter } from '../combat/combat';
import { WEAPONS, type WeaponId } from '../combat/weapons';
import type { PhysicsWorld } from '../physics/world';
import type { RigAssets, RigCharacter } from '../player/rig-assets';
import type { FleetCar } from '../player/fleet';

/** Полицейский пешком: HumanRig + капсула (KCC), здоровье 100, оружие. Логика — в PoliceForce. */
export type CopState = 'ride' | 'deploy' | 'chase' | 'shoot' | 'arrest' | 'down' | 'return' | 'leave';

// форма ДПС: тёмно-синие куртка/брюки/кепи, голубая рубашка, чёрные ботинки и перчатки, шарф в цвет формы
export const COP_LOOK = { top: 0x2c3a58, bottom: 0x1d2433, hat: 0x1d2433, hair: 0x2a1d14, shoes: 0x141414, inner: 0x9db7d6, scarf: 0x1d2433, gloves: 0x141414 };

export class Cop implements Fighter {
  readonly isPlayer = false;
  readonly isCop = true;
  readonly rig: HumanRig;
  readonly body: CharacterBody;
  readonly pos = new THREE.Vector3();
  hp = 100;
  state: CopState = 'ride';
  weapon: WeaponId;
  clip: number;
  cooldown = 0;
  /** Время прицеливания по текущей цели (точность растёт). */
  aimT = 0;
  /** Видит игрока (обновляется ~4 Гц). */
  los = false;
  losT = Math.random() * 0.25;
  arrestT = 0;
  /** Обход препятствия: время и знак. */
  sideT = 0; side = 1;
  stuckT = 0;
  downT = 0;
  /** id в RigRagdollSkin. */
  ragId = -1;
  /** Ударил игрок (для розыска). */
  lastHitByPlayer = false;
  onHit: ((cop: Cop, dmg: number, byPlayer: boolean, melee: boolean, dir: THREE.Vector3, push: number) => void) | null = null;
  /** Последний шаг (звук шагов). */
  stepPhase = 0;

  constructor(assets: RigAssets, ch: RigCharacter, scene: THREE.Object3D, physics: PhysicsWorld, at: THREE.Vector3, public car: FleetCar | null, weapon: WeaponId) {
    this.rig = new HumanRig(assets, ch, COP_LOOK, scene);
    this.body = new CharacterBody(physics, at);
    this.body.accel = 30;
    this.weapon = weapon;
    this.clip = WEAPONS[weapon].mag;
    this.pos.copy(at);
    this.rig.pos.copy(at);
    this.setRiding(true);
  }

  get down(): boolean { return this.state === 'down'; }
  hittable(): boolean { return this.state !== 'ride' && this.rig.visible; }

  setRiding(on: boolean): void {
    this.state = on ? 'ride' : this.state;
    this.rig.visible = !on;
    this.body.setActive(!on);
  }

  takeHit(dmg: number, dir: THREE.Vector3, push: number, byPlayer: boolean, melee: boolean): void {
    if (this.state === 'down' || this.state === 'ride') return;
    // рукопашная: три удара — нокаут; пули — по урону оружия
    const d = melee ? 36 * (dmg > 20 ? 1.3 : 1) : dmg;
    this.hp -= d;
    this.rig.hitFlash = 1;
    this.lastHitByPlayer = byPlayer;
    this.onHit?.(this, d, byPlayer, melee, dir, push);
  }

  dispose(): void {
    this.rig.dispose();
    this.body.dispose();
  }
}
