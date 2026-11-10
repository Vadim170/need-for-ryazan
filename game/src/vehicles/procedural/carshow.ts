import * as THREE from 'three';
import { allVariants, wheelGeometry, type VehicleVariant } from './index';
import { vehicleMaterial, routeBoards } from '../../traffic/models';

/**
 * Отладочная витрина `?carshow=1`: все пресеты машин в ряд на плоскости над миром, камера управляется из консоли:
 * `__game.carshow.view({ from, to, mode: 'side'|'q34'|'rear34'|'front'|'top', lod: 0|1, lamps: 0|1, route: '33' })`.
 * Рекомендуется `?carshow=1&world=test&traffic=0&people=0`.
 */
export interface CarShow {
  group: THREE.Group; variants: VehicleVariant[];
  view(o: { from?: number; to?: number; ids?: string[]; mode?: string; lod?: 0 | 1; lamps?: number; brake?: number; ind?: number; dist?: number; fov?: number }): string[];
  stats(): { id: string; near: number; far: number }[];
}

const PAINTS = [0xe9e9e6, 0xb5b8bb, 0x1b1c1e, 0x6b6f73, 0x23365c, 0x8e1a1a, 0xe9e9e6, 0x2f4d32, 0xc9b994, 0xb5b8bb, 0x5a1222, 0x7a8fa8];

export function installCarShow(rc: { scene: THREE.Scene; camera: THREE.PerspectiveCamera; render(): void; envMap: THREE.Texture | null }, center: THREE.Vector3): CarShow {
  const mat = vehicleMaterial(rc.envMap);
  const variants = allVariants();
  const group = new THREE.Group();
  group.position.copy(center);
  rc.scene.add(group);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = 0.02; ground.receiveShadow = true;
  group.add(ground);
  // 'asphalt' strips
  const cur: THREE.Object3D[] = [];
  const lampAttrs: THREE.InstancedBufferAttribute[] = [];
  const fakeCell = routeBoards.cell('share_taxi', '33'), busCell = routeBoards.cell('bus', '14'), troCell = routeBoards.cell('trolleybus', '5');

  const clear = () => { for (const o of cur) { group.remove(o); (o as THREE.Mesh).geometry?.dispose(); } cur.length = 0; lampAttrs.length = 0; };
  const mkInst = (geo: THREE.BufferGeometry, n: number, color: THREE.Color | null, lamp: [number, number, number], cell = 0): THREE.InstancedMesh => {
    const g = geo.clone();
    const la = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    for (let i = 0; i < n; i++) la.setXYZ(i, ...lamp);
    g.setAttribute('aLamp', la);
    g.setAttribute('aRoute', new THREE.InstancedBufferAttribute(new Float32Array(n).fill(cell), 1));
    const im = new THREE.InstancedMesh(g, mat, n);
    im.frustumCulled = false; im.castShadow = true; im.receiveShadow = true;
    for (let i = 0; i < n; i++) im.setColorAt(i, color ?? new THREE.Color(1, 1, 1));
    lampAttrs.push(la);
    return im;
  };

  const api: CarShow = {
    group, variants,
    stats: () => variants.map((v) => ({ id: v.id, near: v.tris.near, far: v.tris.far })),
    view(o) {
      clear();
      let list = o.ids ? variants.filter((v) => o.ids!.includes(v.id)) : variants.slice(o.from ?? 0, o.to ?? variants.length);
      const mode = o.mode ?? 'q34';
      const yaw = mode === 'side' ? Math.PI / 2 : mode === 'q34' ? Math.PI - 0.62 : mode === 'rear34' ? -0.62 : mode === 'front' ? Math.PI : mode === 'top' ? Math.PI / 2 : 0;
      // ряд вдоль X: шаг по длине/ширине в зависимости от поворота
      let x = 0; const placed: { v: VehicleVariant; x: number }[] = [];
      const lamp: [number, number, number] = [o.lamps ?? 0, o.brake ?? 0, o.ind ?? 0];
      for (const v of list) {
        const ext = mode === 'side' || mode === 'top' ? v.length : Math.abs(Math.sin(yaw)) * v.length + Math.abs(Math.cos(yaw)) * v.width + 0.4;
        const w = ext + 1.1;
        x += w / 2; placed.push({ v, x }); x += w / 2;
      }
      const total = x;
      list = placed.map((p) => p.v);
      placed.forEach(({ v, x: px }, i) => {
        const g = new THREE.Group();
        g.position.set(px - total / 2, 0, 0);
        g.rotation.y = yaw;
        const color = new THREE.Color(v.fixedPaint ?? PAINTS[i % PAINTS.length]);
        const cell = v.route ? (v.kind === 'trolleybus' ? troCell : v.kind === 'gazelle' ? fakeCell : busCell) : 0;
        const body = mkInst(o.lod === 1 ? v.far : v.near, 1, color, lamp, cell);
        g.add(body);
        if (o.lod !== 1) {
          const wm = mkInst(wheelGeometry(v.rim), 4, null, lamp);
          const m = new THREE.Matrix4();
          v.wheels.forEach(([wx, wy, wz], k) => {
            m.compose(new THREE.Vector3(wx, wy, wz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, wx < 0 ? Math.PI : 0, 0)), new THREE.Vector3(v.wheelWidth, v.wheelRadius, v.wheelRadius));
            wm.setMatrixAt(k, m);
          });
          g.add(wm);
        }
        const im = body; im.setMatrixAt(0, new THREE.Matrix4());
        group.add(g); cur.push(g);
      });
      // камера
      const cam = rc.camera;
      const D = o.dist ?? Math.max(9, total * 0.55);
      cam.fov = o.fov ?? 38; cam.updateProjectionMatrix();
      const p = group.position;
      const h = mode === 'top' ? D * 1.1 : 1.5;
      const camPos = mode === 'top' ? new THREE.Vector3(p.x, p.y + h, p.z + 0.1)
        : mode === 'side' ? new THREE.Vector3(p.x, p.y + 1.3, p.z + D) : new THREE.Vector3(p.x, p.y + 1.3, p.z + D);
      (api as unknown as { cam: [THREE.Vector3, THREE.Vector3] }).cam = [camPos, new THREE.Vector3(p.x, p.y + 0.8, p.z)];
      return list.map((v) => v.id);
    },
  };
  const orig = rc.render.bind(rc);
  rc.render = () => {
    const c = (api as unknown as { cam?: [THREE.Vector3, THREE.Vector3] }).cam;
    if (c) { rc.camera.position.copy(c[0]); rc.camera.lookAt(c[1]); rc.camera.updateMatrixWorld(true); }
    orig();
  };
  api.view({ from: 0, to: 6 });
  return api;
}
