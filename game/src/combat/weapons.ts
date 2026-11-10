/** Оружие (аркада, без крови): урон по «здоровью» людей 100, машин — см. vehicle-damage.ts. */
export type WeaponId = 'fists' | 'pistol' | 'rifle' | 'shotgun';

export interface WeaponDef {
  id: WeaponId;
  /** Название для HUD. */
  name: string;
  melee: boolean;
  damage: number;
  /** Урон машине за попадание. */
  vehDamage: number;
  /** Выстрелов в секунду. */
  rate: number;
  auto: boolean;
  mag: number;
  reload: number;
  /** Разброс (рад) стоя/в движении. */
  spread: number;
  spreadMove: number;
  pellets: number;
  range: number;
  /** Сила удара (м/с телу/рэгдоллу). */
  push: number;
  hold: 'none' | 'pistol' | 'rifle';
  /** Патронов в подобранном оружии. */
  pickupAmmo: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: { id: 'fists', name: 'Кулаки', melee: true, damage: 18, vehDamage: 0, rate: 2.4, auto: false, mag: 0, reload: 0, spread: 0, spreadMove: 0, pellets: 0, range: 1.4, push: 3.5, hold: 'none', pickupAmmo: 0 },
  pistol: { id: 'pistol', name: 'ПМ', melee: false, damage: 34, vehDamage: 6, rate: 4, auto: false, mag: 8, reload: 1.3, spread: 0.008, spreadMove: 0.03, pellets: 1, range: 150, push: 4, hold: 'pistol', pickupAmmo: 24 },
  rifle: { id: 'rifle', name: 'АКС-74У', melee: false, damage: 30, vehDamage: 9, rate: 10, auto: true, mag: 30, reload: 2.2, spread: 0.014, spreadMove: 0.045, pellets: 1, range: 220, push: 5, hold: 'rifle', pickupAmmo: 90 },
  shotgun: { id: 'shotgun', name: 'Дробовик', melee: false, damage: 16, vehDamage: 4, rate: 1.2, auto: false, mag: 6, reload: 2.6, spread: 0.06, spreadMove: 0.08, pellets: 8, range: 45, push: 7, hold: 'rifle', pickupAmmo: 18 },
};

export const WEAPON_ORDER: WeaponId[] = ['fists', 'pistol', 'shotgun', 'rifle'];

/** Оружие у игрока: патроны в магазине и запас. */
export interface WeaponSlot { id: WeaponId; clip: number; reserve: number }

export class Inventory {
  slots = new Map<WeaponId, WeaponSlot>([['fists', { id: 'fists', clip: 0, reserve: 0 }]]);
  current: WeaponId = 'fists';
  reloadT = 0;
  cooldown = 0;

  get def(): WeaponDef { return WEAPONS[this.current]; }
  get slot(): WeaponSlot { return this.slots.get(this.current)!; }

  add(id: WeaponId, ammo: number): void {
    const s = this.slots.get(id);
    if (s) s.reserve += ammo;
    else {
      const d = WEAPONS[id];
      const clip = Math.min(d.mag, ammo);
      this.slots.set(id, { id, clip, reserve: ammo - clip });
    }
  }
  has(id: WeaponId): boolean { return this.slots.has(id); }
  select(id: WeaponId): boolean {
    if (!this.slots.has(id) || id === this.current) return false;
    this.current = id; this.reloadT = 0;
    return true;
  }
  cycle(dir: number): boolean {
    const list = WEAPON_ORDER.filter((w) => this.slots.has(w));
    const i = list.indexOf(this.current);
    return this.select(list[(i + dir + list.length) % list.length]);
  }
  clear(): void {
    this.slots = new Map([['fists', { id: 'fists', clip: 0, reserve: 0 }]]);
    this.current = 'fists'; this.reloadT = 0;
  }
  /** Перезарядка закончилась — переложить патроны. */
  finishReload(): void {
    const s = this.slot, d = this.def;
    const n = Math.min(d.mag - s.clip, s.reserve);
    s.clip += n; s.reserve -= n;
  }
}
