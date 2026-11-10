import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import { cityUniforms } from './materials';
import { weatherUniforms, applySurfaceWeather } from '../render/weather';

/**
 * Лыбедский бульвар (docs/stage3/lybed.md): фонари аллеи и каркасная ёлка.
 *
 * Фонари — обычные виды пропсов (props.ts: `lybed_lamp_slim`, `lybed_lamp_disc2`; геометрия здесь, атрибуты как у
 * prop-meshes.ts: position/normal/color/aFlag, aFlag 2 — светится ночью). По панорамам Яндекса 2026-03:
 *   slim  — центральная часть (Астраханский мост → ул. Горького): тонкая серо-голубая опора ~4.2 м, цилиндрический плафон;
 *   disc2 — нижняя часть (спортзона): опора ~5.2 м, два дисковых светильника на коротких консолях на разной высоте.
 *
 * Ёлка — инстанс `lybed_xmas_tree` (props/{ix}_{iz}.json): стальной каркас (кольцо арок + конус из меридианов и колец
 * с провисающими «лапами»), стоит круглый год (панорамы 2020-08 и 2024-06 — летом). Гирлянды и звезда — только зимой
 * (weatherUniforms.season ≥ 0.75): светодиоды мерцают и «бегут» волнами по высоте, ночью ярче. Коллайдеры — стойки арок.
 */

// ------------------------------------------------------------------ мини-сборщик (как Builder в prop-meshes.ts)
class B {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; flag: number[] = [];
  add(geo: THREE.BufferGeometry, color: number, flag = 0, m?: THREE.Matrix4): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const M = m ?? new THREE.Matrix4();
    const nm = new THREE.Matrix3().getNormalMatrix(M);
    const P = g.getAttribute('position'), N = g.getAttribute('normal');
    const c = new THREE.Color(color), v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(M); this.pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); this.nrm.push(v.x, v.y, v.z);
      this.col.push(c.r, c.g, c.b); this.flag.push(flag);
    }
    if (g !== geo) g.dispose();
    geo.dispose();
    return this;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aFlag', new THREE.Float32BufferAttribute(this.flag, 1));
    g.computeBoundingSphere();
    return g;
  }
}
const at = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
const cyl = (rt: number, rb: number, h: number, seg: number) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, false);

const POLE = 0x4e6578;   // серо-голубая окраска опор бульвара («цвет спрятанной реки»)
const HEAD = 0x2c3238;
const LENS = 0xfff2d8;

/** Фонарь аллеи. «Вперёд» (−Z) — к дорожке. */
export function buildLybedLamp(kind: 'slim' | 'disc2'): THREE.BufferGeometry {
  const b = new B();
  if (kind === 'slim') {
    b.add(cyl(0.1, 0.12, 0.35, 8), POLE, 0, at(0, 0.175, 0))
      .add(cyl(0.05, 0.065, 3.8, 8), POLE, 0, at(0, 2.25, 0))
      .add(cyl(0.13, 0.13, 0.36, 10), HEAD, 0, at(0, 4.33, 0))
      .add(cyl(0.11, 0.11, 0.2, 10), LENS, 2, at(0, 4.06, 0))
      .add(cyl(0.15, 0.15, 0.04, 10), HEAD, 0, at(0, 4.53, 0));
  } else {
    b.add(cyl(0.11, 0.13, 0.4, 8), POLE, 0, at(0, 0.2, 0))
      .add(cyl(0.055, 0.075, 4.95, 8), POLE, 0, at(0, 2.85, 0));
    for (const [h, s] of [[5.2, -1], [4.55, 1]] as const) {
      b.add(new THREE.BoxGeometry(0.05, 0.05, 0.5), POLE, 0, at(0, h + 0.06, s * 0.27))
        .add(cyl(0.33, 0.33, 0.07, 16), HEAD, 0, at(0, h, s * 0.6))
        .add(cyl(0.29, 0.29, 0.02, 16), LENS, 2, at(0, h - 0.04, s * 0.6));
    }
    b.add(new THREE.BoxGeometry(0.12, 0.25, 0.08), 0xb9c0c6, 0, at(0, 4.2, -0.07)); // блок связи на опоре (фото 042)
  }
  return b.build();
}

/** Высота плафона над основанием (пятно света, props.ts collectLamps). */
export const LYBED_LAMP_H = { slim: 4.1, disc2: 4.9 } as const;

// ------------------------------------------------------------------ каркасная ёлка
export interface XmasTreeInst { x: number; y: number; z: number; rotY?: number; height?: number; radius?: number; arches?: number; archH?: number; rings?: number; spire?: number;
  /** круглая площадь под ёлкой: [x, y, z, R] (координаты игры) */
  plaza?: [number, number, number, number] }

const STEEL = new THREE.MeshStandardMaterial({ color: 0xb8bec4, metalness: 0.75, roughness: 0.38 });
const STAR = new THREE.MeshStandardMaterial({ color: 0xffcf40, emissive: 0xffb820, emissiveIntensity: 0.6, metalness: 0.4, roughness: 0.3 });

const LED_VERT = /* glsl */ `
attribute vec4 aLed;          // x — фаза, y — высота 0..1, z — оттенок 0..1, w — кольцо гирлянды
uniform float uTime, uNight;
varying vec3 vCol; varying float vI;
vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
void main() {
  // тёплый белый с золотом + редкие цветные (синий/красный) — как на новогодних гирляндах бульвара
  vec3 warm = vec3(1.0, 0.78, 0.42);
  vec3 c = aLed.z < 0.78 ? warm : (aLed.z < 0.9 ? vec3(0.35, 0.55, 1.0) : vec3(1.0, 0.25, 0.2));
  float tw = 0.55 + 0.45 * sin(uTime * (2.0 + 3.0 * fract(aLed.x * 7.3)) + aLed.x * 40.0);
  float wave = smoothstep(0.75, 1.0, sin(uTime * 1.6 - aLed.y * 9.0) * 0.5 + 0.5);   // волна снизу вверх
  float chase = step(0.5, fract(aLed.w * 0.5 + uTime * 0.5));                         // кольца через одно перемигиваются
  vI = (0.35 + 0.65 * tw) * (0.6 + 0.4 * chase) + 1.2 * wave;
  vI *= mix(0.35, 1.0, uNight);
  vCol = c;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}`;
const LED_FRAG = /* glsl */ `
varying vec3 vCol; varying float vI;
void main() {
  gl_FragColor = vec4(vCol * (0.6 + 2.2 * vI), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface TreeObj { root: THREE.Group; leds: THREE.InstancedMesh; star: THREE.Object3D; plaza: THREE.Mesh | null; colliders: RAPIER.Collider[] }

/** Каркас + гирлянды по параметрам инстанса. */
function buildTree(p: XmasTreeInst): { frame: THREE.BufferGeometry; ledPts: number[]; ledAttr: number[]; top: number } {
  const H = p.height ?? 21.5, R = p.radius ?? 5.2, n = p.arches ?? 12, aH = p.archH ?? 3.0, nr = p.rings ?? 11, sp = p.spire ?? 1.2;
  const parts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const tube = (a: THREE.Vector3, b: THREE.Vector3, r: number) => {
    const d = new THREE.Vector3().subVectors(b, a), L = d.length();
    if (L < 1e-3) return;
    const g = new THREE.CylinderGeometry(r, r, L, 5, 1, true);
    const q = new THREE.Quaternion().setFromUnitVectors(up, d.normalize());
    g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
    parts.push(g);
  };
  const ledPts: number[] = [], ledAttr: number[] = [];
  const led = (v: THREE.Vector3, ring: number) => {
    const ph = Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719) * 43758.5453;
    ledPts.push(v.x, v.y, v.z);
    ledAttr.push(ph - Math.floor(ph), v.y / H, (ph * 3.7) - Math.floor(ph * 3.7), ring);
  };
  const P = (ang: number, r: number, y: number) => new THREE.Vector3(Math.sin(ang) * r, y, Math.cos(ang) * r);
  // кольцо арок: стойки на R, полуциркульные арки между ними, верхнее и нижнее кольцо
  const chord = 2 * R * Math.sin(Math.PI / n), ar = chord / 2, post = aH - ar;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    tube(P(a0, R, 0), P(a0, R, aH), 0.06);
    tube(P(a0, R, aH), P(a1, R, aH), 0.05);
    tube(P(a0, R, 0.25), P(a1, R, 0.25), 0.035);
    const A = P(a0, R, post), Bp = P(a1, R, post), m = A.clone().add(Bp).multiplyScalar(0.5), ax = Bp.clone().sub(A).normalize();
    let prev = A;
    for (let k = 1; k <= 8; k++) {
      const t = Math.PI * (1 - k / 8);
      const v = m.clone().addScaledVector(ax, -Math.cos(t) * ar).add(new THREE.Vector3(0, Math.sin(t) * ar, 0));
      tube(prev, v, 0.035);
      prev = v;
    }
  }
  // конус: меридианы и кольца, между меридианами — провисающие «лапы» (силуэт ели), на них гирлянды
  const cone = (y: number) => R * (1 - (y - aH) / (H - aH));
  const ys: number[] = [];
  for (let j = 0; j <= nr; j++) ys.push(aH + (H - aH) * (j / nr) ** 0.92);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    tube(P(a, R, aH), P(a, 0.08, H), 0.05);
  }
  for (let j = 1; j < ys.length - 1; j++) {
    const y = ys[j], r = cone(y);
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      tube(P(a0, r, y), P(a1, r, y), 0.03);
      // «лапа»: дуга, провисающая на 0.35 м и вынесенная на 0.35 м наружу
      const sag = 0.35 * Math.min(1, r / 2), out = 0.35 * Math.min(1, r / 2);
      let prev = P(a0, r, y);
      for (let k = 1; k <= 6; k++) {
        const t = k / 6, ang = a0 + (a1 - a0) * t, s = Math.sin(Math.PI * t);
        const v = P(ang, r + out * s, y - sag * s);
        tube(prev, v, 0.022);
        prev = v;
      }
      for (let k = 0; k < 10; k++) {
        const t = (k + 0.5) / 10, ang = a0 + (a1 - a0) * t, s = Math.sin(Math.PI * t);
        led(P(ang, r + out * s + 0.03, y - sag * s - 0.03), j);
      }
    }
  }
  // гирлянды по меридианам и по кольцу арок
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    for (let k = 0; k < 40; k++) { const y = aH + (H - aH) * (k + 0.5) / 40; led(P(a, cone(y) + 0.05, y), 100 + i); }
    for (let k = 0; k < 8; k++) { const t = (k + 0.5) / 8; led(P(a + (Math.PI * 2 / n) * t, R + 0.06, aH + 0.05), 0); }
  }
  tube(new THREE.Vector3(0, H - 0.3, 0), new THREE.Vector3(0, H + sp, 0), 0.05);   // шпиль
  const merged = mergeAll(parts);
  return { frame: merged, ledPts, ledAttr, top: H + sp };
}

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let nv = 0;
  for (const g of parts) nv += g.toNonIndexed().getAttribute('position').count;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
  let o = 0;
  for (const g0 of parts) {
    const g = g0.toNonIndexed();
    pos.set(g.getAttribute('position').array as Float32Array, o * 3);
    nrm.set(g.getAttribute('normal').array as Float32Array, o * 3);
    o += g.getAttribute('position').count;
    g.dispose(); g0.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.computeBoundingSphere();
  return out;
}

function starGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 0.42 : 1.0, a = (i / 10) * Math.PI * 2;
    if (i === 0) s.moveTo(Math.sin(a) * r, Math.cos(a) * r); else s.lineTo(Math.sin(a) * r, Math.cos(a) * r);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.18, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 1 });
  g.translate(0, 0, -0.09);
  return g;
}

/** Покрытие круглой площади (панорамы 2020-08 / 2024-06): бежевый бетон, жёлтые радиальные линии, тёмное кольцо у
 *  ёлки, красное кольцо по краю. Текстура — canvas, один раз. */
let plazaMat: THREE.MeshStandardMaterial | null = null;
function plazaMaterial(): THREE.MeshStandardMaterial {
  if (plazaMat) return plazaMat;
  const N = 1024, cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d')!;
  const c = N / 2, R = N / 2;
  g.fillStyle = '#b0665c'; g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.fill();          // красное кольцо 2.5 м
  g.fillStyle = '#d8c9ad'; g.beginPath(); g.arc(c, c, R * (16.5 / 19), 0, Math.PI * 2); g.fill();
  g.fillStyle = '#9a958c'; g.beginPath(); g.arc(c - R * 0.21, c - R * 0.12, R * 0.42, 0, Math.PI * 2); g.fill();   // тёмный круг под ёлкой
  g.strokeStyle = '#d9a92e'; g.lineWidth = N * 0.006;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    g.beginPath(); g.moveTo(c + Math.cos(a) * R * 0.42, c + Math.sin(a) * R * 0.42); g.lineTo(c + Math.cos(a) * R * (16.5 / 19), c + Math.sin(a) * R * (16.5 / 19)); g.stroke();
  }
  g.beginPath(); g.arc(c, c, R * (16.5 / 19), 0, Math.PI * 2); g.stroke();
  const img = g.getImageData(0, 0, N, N);       // зерно бетона
  for (let i = 0; i < img.data.length; i += 4) { const k = (Math.random() - 0.5) * 18; img.data[i] += k; img.data[i + 1] += k; img.data[i + 2] += k; }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  plazaMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  applySurfaceWeather(plazaMat, 'area');
  return plazaMat;
}

/** Ёлки бульвара по тайлам (props.ts вызывает place/remove). */
export class LybedTrees {
  private tiles = new Map<string, TreeObj[]>();
  private uniforms = { uTime: { value: 0 }, uNight: { value: 0 } };
  private ledMat = new THREE.ShaderMaterial({ vertexShader: LED_VERT, fragmentShader: LED_FRAG, uniforms: this.uniforms, fog: false });
  constructor(private parent: THREE.Object3D, private physics: PhysicsWorld, private heightAt: (x: number, z: number) => number = () => NaN) {}

  place(key: string, p: XmasTreeInst): void {
    const t = buildTree(p);
    const root = new THREE.Group();
    root.name = 'lybed_xmas_tree';
    root.position.set(p.x, p.y, p.z);
    root.rotation.y = p.rotY ?? 0;
    const frame = new THREE.Mesh(t.frame, STEEL);
    frame.castShadow = true; frame.receiveShadow = true;
    root.add(frame);
    const nled = t.ledPts.length / 3;
    const ledGeo = new THREE.IcosahedronGeometry(0.055, 0);
    ledGeo.setAttribute('aLed', new THREE.InstancedBufferAttribute(new Float32Array(t.ledAttr), 4));
    const leds = new THREE.InstancedMesh(ledGeo, this.ledMat, nled);
    const m = new THREE.Matrix4();
    for (let i = 0; i < nled; i++) leds.setMatrixAt(i, m.makeTranslation(t.ledPts[i * 3], t.ledPts[i * 3 + 1], t.ledPts[i * 3 + 2]));
    leds.frustumCulled = false;
    leds.onBeforeRender = () => {
      this.uniforms.uTime.value = performance.now() / 1000;
      this.uniforms.uNight.value = cityUniforms.uNfrNight.value;
    };
    root.add(leds);
    const star = new THREE.Group(); // две скрещённые звезды — видна с любой стороны
    const sg = starGeometry();
    for (const a of [0, Math.PI / 2]) { const m = new THREE.Mesh(sg, STAR); m.rotation.y = a; star.add(m); }
    star.position.set(0, t.top + 0.7, 0);
    star.scale.setScalar(0.9);
    root.add(star);
    // сезон: гирлянды и звезда — зимой (проверка на каждом кадре рендера каркаса — дёшево)
    frame.onBeforeRender = () => {
      const winter = weatherUniforms.season.value >= 0.75;
      leds.visible = winter; star.visible = winter;
      STAR.emissiveIntensity = 0.6 + 2.4 * cityUniforms.uNfrNight.value;
    };
    root.updateMatrixWorld(true);
    this.parent.add(root);
    let plaza: THREE.Mesh | null = null;
    if (p.plaza) {
      const [px, py, pz, pr] = p.plaza;
      const geo = new THREE.CircleGeometry(pr, 72, 0, Math.PI * 2).rotateX(-Math.PI / 2);
      const pos = geo.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {   // по рельефу (площадь не плоская: у южного края рельеф выше центра)
        const h = this.heightAt(px + pos.getX(i), pz + pos.getZ(i));
        pos.setY(i, (Number.isFinite(h) ? h - py : 0) + 0.06);
      }
      geo.computeVertexNormals();
      plaza = new THREE.Mesh(geo, plazaMaterial());
      plaza.position.set(px, py, pz);
      plaza.receiveShadow = true;
      plaza.name = 'lybed_plaza';
      this.parent.add(plaza);
    }
    // коллайдеры: стойки арок (каркас внутри проходим — как в жизни)
    const colliders: RAPIER.Collider[] = [];
    const n = p.arches ?? 12, R = p.radius ?? 5.2, aH = p.archH ?? 3.0;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (p.rotY ?? 0);
      const d = RAPIER.ColliderDesc.cylinder(aH / 2, 0.1).setTranslation(p.x + Math.sin(a) * R, p.y + aH / 2, p.z + Math.cos(a) * R);
      colliders.push(this.physics.world.createCollider(d));
    }
    const list = this.tiles.get(key) ?? [];
    list.push({ root, leds, star, plaza, colliders });
    this.tiles.set(key, list);
  }

  remove(key: string): void {
    const list = this.tiles.get(key);
    if (!list) return;
    for (const o of list) {
      this.parent.remove(o.root);
      if (o.plaza) { this.parent.remove(o.plaza); o.plaza.geometry.dispose(); }
      o.root.traverse((x) => { const m = x as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
      for (const c of o.colliders) this.physics.world.removeCollider(c, false);
    }
    this.tiles.delete(key);
  }
}
