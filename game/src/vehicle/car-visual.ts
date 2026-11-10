import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { VehicleConfig } from './config';

export interface WheelVisual {
  pivot: THREE.Group; // yaw (steer) + position
  spin: THREE.Object3D; // pitch (rolling)
}

/** Пути к моделям Lada Largus (assets/scripts/build_largus.py + pack_largus.sh). */
export const LARGUS_URL = `${import.meta.env.BASE_URL}assets/vehicles/largus/largus.glb`;
export const LARGUS_LOD1_URL = `${import.meta.env.BASE_URL}assets/vehicles/largus/largus_lod1.glb`;

/** Светотехника: материалы 'headlight' / 'taillight' / 'brakelight' из glb. */
export class CarLights {
  readonly head: THREE.MeshStandardMaterial[] = [];
  readonly tail: THREE.MeshStandardMaterial[] = [];
  readonly brake: THREE.MeshStandardMaterial[] = [];
  /** Ближний свет (ночью): фары + габариты. */
  headlights = false;
  private brakeOn = false;

  register(m: THREE.Material): void {
    const mm = m as THREE.MeshStandardMaterial;
    if (m.name === 'headlight') { mm.emissive = new THREE.Color(1.0, 0.95, 0.8); this.head.push(mm); }
    else if (m.name === 'taillight') { mm.emissive = new THREE.Color(1.0, 0.06, 0.03); this.tail.push(mm); }
    else if (m.name === 'brakelight') { mm.emissive = new THREE.Color(1.0, 0.03, 0.02); this.brake.push(mm); }
    else return;
    this.apply();
  }

  /** Вызывать каждый кадр: braking = нажат тормоз/ручник. */
  update(braking: boolean): void {
    if (braking === this.brakeOn) return;
    this.brakeOn = braking;
    this.apply();
  }

  setHeadlights(on: boolean): void {
    this.headlights = on;
    this.apply();
  }

  private apply(): void {
    for (const m of this.head) m.emissiveIntensity = this.headlights ? 2.5 : 0;
    for (const m of this.tail) m.emissiveIntensity = this.headlights || this.brakeOn ? 0.8 : 0;
    for (const m of this.brake) m.emissiveIntensity = this.brakeOn ? 4 : this.headlights ? 0.6 : 0;
  }
}

export interface LargusModel {
  /** Кузов (узел 'body'); начало координат — на земле по центру базы. Сдвигать на groundOffset снаружи. */
  root: THREE.Group;
  /** Порядок как в Vehicle: FL, FR, RL, RR. Пивоты ещё не добавлены никуда. */
  wheels: WheelVisual[];
  lights: CarLights;
  paint: THREE.Material[];
  setPaintColor(hex: number | string): void;
}

const WHEEL_NODES = ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR'];
const DEFAULT_PAINT = 0xa4a8ad;

let _loader: GLTFLoader | null = null;
function loader(): GLTFLoader {
  if (!_loader) {
    _loader = new GLTFLoader();
    _loader.setMeshoptDecoder(MeshoptDecoder);
  }
  return _loader;
}

/**
 * Загружает glb Largus. Колёса вынимаются в отдельные группы: pivot (позиция/руление) -> spin (качение вокруг X).
 * Центр колеса берётся из bbox узла (устойчиво к квантованию meshopt, которое меняет translation/scale узлов).
 */
export async function loadLargusModel(opts: { url?: string; envMap?: THREE.Texture | null } = {}): Promise<LargusModel> {
  const gltf = await loader().loadAsync(opts.url ?? LARGUS_URL);
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const lights = new CarLights();
  const paint: THREE.Material[] = [];
  const seen = new Set<THREE.Material>();

  const wheels: WheelVisual[] = WHEEL_NODES.map((name) => {
    const node = scene.getObjectByName(name);
    if (!node) throw new Error(`Largus glb: нет узла ${name}`);
    const c = new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
    node.removeFromParent();
    node.position.sub(c);
    const spin = new THREE.Group();
    spin.add(node);
    const pivot = new THREE.Group();
    pivot.add(spin);
    return { pivot, spin };
  });

  const prep = (obj: THREE.Object3D) => {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      let glass = false;
      for (const m of mats) {
        if (m.name === 'glass') {
          glass = true;
          m.transparent = true;
          m.depthWrite = false;
        }
        if (seen.has(m)) continue;
        seen.add(m);
        const sm = m as THREE.MeshStandardMaterial;
        if (opts.envMap && 'envMap' in sm) { sm.envMap = opts.envMap; sm.envMapIntensity = m.name === 'paint' ? 0.35 : 0.5; } // небо слишком яркое: иначе лак «выбеливается»
        if (m.name === 'paint') paint.push(m);
        lights.register(m);
      }
      mesh.castShadow = !glass;
      mesh.receiveShadow = !glass;
    });
  };
  prep(scene);
  for (const w of wheels) prep(w.pivot);

  const setPaintColor = (hex: number | string) => { for (const m of paint) (m as THREE.MeshStandardMaterial).color.set(hex); };
  // Серый металлик по умолчанию; ?paint=RRGGBB — другой цвет
  const paintParam = new URLSearchParams(location.search).get('paint');
  setPaintColor(paintParam && /^[0-9a-f]{6}$/i.test(paintParam) ? `#${paintParam}` : DEFAULT_PAINT);

  const root = new THREE.Group();
  root.add(scene);
  return { root, wheels, lights, paint, setPaintColor };
}

/** Запасная модель-заглушка (коробки): используется, пока грузится Largus, и если загрузка не удалась. */
export function buildCarVisual(cfg: VehicleConfig, wheelCount = 4) {
  const root = new THREE.Group();
  const { length, width } = cfg.chassis;

  const paint = new THREE.MeshStandardMaterial({ color: 0xc8321e, roughness: 0.35, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.1, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.8 });

  const mk = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };

  mk(new THREE.BoxGeometry(width, 0.62, length), paint, 0, 0.15, 0); // lower body
  mk(new THREE.BoxGeometry(width * 0.88, 0.52, length * 0.5), glass, 0, 0.7, 0.2); // cabin
  mk(new THREE.BoxGeometry(width * 0.9, 0.06, length * 0.5 + 0.02), paint, 0, 0.99, 0.2); // roof
  mk(new THREE.BoxGeometry(width, 0.1, 0.12), dark, 0, -0.1, -length / 2); // front bumper
  mk(new THREE.BoxGeometry(width, 0.1, 0.12), dark, 0, -0.1, length / 2); // rear bumper
  for (const x of [-0.6, 0.6]) mk(new THREE.BoxGeometry(0.3, 0.12, 0.06), new THREE.MeshBasicMaterial({ color: 0xfff2c0 }), x, 0.3, -length / 2 - 0.02);
  for (const x of [-0.6, 0.6]) mk(new THREE.BoxGeometry(0.3, 0.12, 0.06), new THREE.MeshBasicMaterial({ color: 0xff2200 }), x, 0.3, length / 2 + 0.02);

  const r = cfg.suspension.wheelRadius;
  const wheelGeo = new THREE.CylinderGeometry(r, r, 0.24, 24);
  wheelGeo.rotateZ(Math.PI / 2); // axis along X
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.3 });
  const wheels: WheelVisual[] = [];
  for (let i = 0; i < wheelCount; i++) {
    const pivot = new THREE.Group();
    const spin = new THREE.Mesh(wheelGeo, tireMat);
    spin.castShadow = true;
    // rim marker so the rotation is visible
    const rim = new THREE.Mesh(new THREE.BoxGeometry(0.26, r * 1.1, 0.06), rimMat);
    spin.add(rim);
    pivot.add(spin);
    root.add(pivot);
    wheels.push({ pivot, spin });
  }
  return { root, wheels };
}
