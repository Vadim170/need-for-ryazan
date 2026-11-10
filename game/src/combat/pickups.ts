import * as THREE from 'three';
import { buildCash, buildWeaponMesh } from './weapon-meshes';
import type { WeaponId } from './weapons';
import { WEAPONS } from './weapons';

/**
 * Подбираемые предметы: деньги (выпадают у ограбленных/сбитых), оружие с патронами (у полицейских), бронежилет, аптечка.
 * Падают с небольшим подбросом, крутятся над землёй; подбор — игрок пешком ближе 1.3 м. Живут 90 с, не больше 40 штук.
 */
export interface Pickup {
  kind: 'money' | 'weapon' | 'armor' | 'health';
  amount: number;
  weapon?: WeaponId;
  obj: THREE.Object3D;
  pos: THREE.Vector3;
  vy: number; vx: number; vz: number;
  ground: number;
  t: number;
}

const armorMat = new THREE.MeshStandardMaterial({ color: 0x2b3b5a, roughness: 0.8 });
const healthMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6, emissive: 0x220000 });
const crossMat = new THREE.MeshStandardMaterial({ color: 0xd02020, roughness: 0.6 });

export class Pickups {
  readonly list: Pickup[] = [];
  private root = new THREE.Group();

  constructor(scene: THREE.Scene, private groundAt: (x: number, y: number, z: number) => number) {
    this.root.name = 'pickups';
    scene.add(this.root);
  }

  drop(kind: Pickup['kind'], at: THREE.Vector3, amount: number, weapon?: WeaponId, toss = true): Pickup {
    let obj: THREE.Object3D;
    if (kind === 'money') obj = buildCash();
    else if (kind === 'weapon') obj = buildWeaponMesh(weapon ?? 'pistol')?.root ?? buildCash();
    else if (kind === 'armor') {
      obj = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.12), armorMat);
    } else {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.14), healthMat));
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.15), crossMat), c2 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.15), crossMat);
      g.add(c1, c2);
      obj = g;
    }
    obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
    obj.position.copy(at);
    this.root.add(obj);
    const a = Math.random() * Math.PI * 2, s = toss ? 1 + Math.random() * 1.5 : 0;
    const p: Pickup = { kind, amount, weapon, obj, pos: at.clone(), vy: toss ? 3 + Math.random() * 1.5 : 0, vx: Math.cos(a) * s, vz: Math.sin(a) * s,
      ground: this.groundAt(at.x, at.y, at.z), t: 0 };
    this.list.push(p);
    while (this.list.length > 40) this.remove(this.list[0]);
    return p;
  }

  remove(p: Pickup): void {
    const i = this.list.indexOf(p);
    if (i >= 0) this.list.splice(i, 1);
    p.obj.removeFromParent();
  }

  clear(): void { for (const p of [...this.list]) this.remove(p); }

  /** Кадр: физика подброса, вращение; collect(p) → true — подобрано (удаляется). */
  update(dt: number, player: THREE.Vector3 | null, collect: (p: Pickup) => boolean): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.t += dt;
      if (p.t > 90) { this.remove(p); continue; }
      const floor = p.ground + 0.25;
      if (p.vy !== 0 || p.pos.y > floor + 0.01) {
        p.vy -= 14 * dt;
        p.pos.x += p.vx * dt; p.pos.z += p.vz * dt; p.pos.y += p.vy * dt;
        if (p.pos.y <= floor) { p.pos.y = floor; p.vy = 0; p.vx = 0; p.vz = 0; p.ground = this.groundAt(p.pos.x, p.pos.y + 1, p.pos.z); }
      }
      p.obj.position.set(p.pos.x, p.pos.y + (p.vy === 0 ? Math.sin(p.t * 3) * 0.06 : 0), p.pos.z);
      p.obj.rotation.y = p.t * 2;
      if (player && p.t > 0.4 && Math.hypot(p.pos.x - player.x, p.pos.z - player.z) < 1.3 && Math.abs(p.pos.y - player.y) < 1.8) {
        if (collect(p)) this.remove(p);
      }
    }
  }

  /** Подпись для HUD. */
  static label(p: Pickup): string {
    if (p.kind === 'money') return `₽ ${p.amount}`;
    if (p.kind === 'weapon') return `${WEAPONS[p.weapon ?? 'pistol'].name} +${p.amount}`;
    if (p.kind === 'armor') return 'Бронежилет';
    return 'Аптечка';
  }
}
