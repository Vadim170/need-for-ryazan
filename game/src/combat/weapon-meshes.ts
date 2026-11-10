import * as THREE from 'three';
import type { WeaponId } from './weapons';

/**
 * Процедурные модели оружия (low-poly): ПМ, АКС-74У, дробовик; пачка денег. Ось ствола — −Z, рукоять у начала координат,
 * muzzle — точка дула в локальных координатах. Материалы общие.
 */

const metal = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.45, metalness: 0.7 });
const dark = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.7, metalness: 0.3 });
const wood = new THREE.MeshStandardMaterial({ color: 0x6b3c1c, roughness: 0.7 });
const cashMat = new THREE.MeshStandardMaterial({ color: 0x9fbf8a, roughness: 0.8, emissive: 0x1a2a10 });
const bandMat = new THREE.MeshStandardMaterial({ color: 0xe9e2c8, roughness: 0.8 });

export interface WeaponMesh { root: THREE.Group; muzzle: THREE.Vector3 }

function box(g: THREE.Group, m: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, rx = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
  mesh.position.set(x, y, z); mesh.rotation.x = rx;
  mesh.castShadow = true;
  g.add(mesh);
  return mesh;
}
function cyl(g: THREE.Group, m: THREE.Material, r: number, len: number, x: number, y: number, z: number): void {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8).rotateX(Math.PI / 2), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  g.add(mesh);
}

export function buildWeaponMesh(id: WeaponId): WeaponMesh | null {
  const g = new THREE.Group();
  g.name = 'weapon_' + id;
  switch (id) {
    case 'pistol':
      box(g, metal, 0.03, 0.032, 0.17, 0, 0.045, -0.05);  // затвор
      box(g, dark, 0.028, 0.11, 0.045, 0, -0.005, 0.0, 0.2); // рукоять
      box(g, metal, 0.008, 0.03, 0.04, 0, 0.0, -0.06);   // спуск
      return { root: g, muzzle: new THREE.Vector3(0, 0.048, -0.14) };
    case 'rifle':
      box(g, metal, 0.05, 0.08, 0.3, 0, 0.04, -0.1);       // ствольная коробка
      cyl(g, metal, 0.012, 0.22, 0, 0.06, -0.36);           // ствол
      cyl(g, dark, 0.022, 0.06, 0, 0.06, -0.48);            // ДТК
      box(g, wood, 0.05, 0.05, 0.16, 0, 0.035, -0.32);      // цевьё
      box(g, dark, 0.035, 0.17, 0.06, 0, -0.07, -0.16, -0.35); // магазин
      box(g, dark, 0.03, 0.1, 0.04, 0, -0.04, 0.02, 0.25);   // рукоять
      box(g, metal, 0.02, 0.03, 0.22, 0, 0.03, 0.15);        // приклад-рамка
      return { root: g, muzzle: new THREE.Vector3(0, 0.06, -0.52) };
    case 'shotgun':
      cyl(g, metal, 0.016, 0.62, 0, 0.06, -0.32);
      cyl(g, dark, 0.02, 0.4, 0, 0.025, -0.22);
      box(g, metal, 0.05, 0.07, 0.18, 0, 0.04, 0.0);
      box(g, wood, 0.045, 0.1, 0.3, 0, 0.0, 0.22, -0.12);
      box(g, wood, 0.05, 0.05, 0.14, 0, 0.02, -0.3);
      return { root: g, muzzle: new THREE.Vector3(0, 0.06, -0.64) };
    default:
      return null;
  }
}

/** Пачка денег (подбор). */
export function buildCash(): THREE.Group {
  const g = new THREE.Group();
  box(g, cashMat, 0.17, 0.05, 0.08, 0, 0.025, 0);
  box(g, bandMat, 0.03, 0.052, 0.082, 0, 0.025, 0);
  return g;
}
