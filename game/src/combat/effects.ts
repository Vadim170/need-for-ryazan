import * as THREE from 'three';

/**
 * Визуальные эффекты стрельбы и повреждений (без крови): трассеры, вспышки выстрела (+ одна общая точечная лампа),
 * искры/пыль попаданий, дым и огонь подбитых машин, взрывы. Всё — пулы фиксированного размера (2 Points + 2 InstancedMesh
 * = 4 draw calls), без аллокаций в кадре.
 */

const PCAP = 1500;

class Particles {
  readonly points: THREE.Points;
  private pos: Float32Array; private col: Float32Array; private size: Float32Array; private alpha: Float32Array;
  private vel: Float32Array; private life: Float32Array; private max: Float32Array; private grow: Float32Array; private size0: Float32Array;
  private drag: Float32Array; private lift: Float32Array; private fade: Float32Array;
  private n = 0; private head = 0;
  constructor(additive: boolean, scene: THREE.Scene) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(PCAP * 3); this.col = new Float32Array(PCAP * 3);
    this.size = new Float32Array(PCAP); this.alpha = new Float32Array(PCAP);
    this.vel = new Float32Array(PCAP * 3); this.life = new Float32Array(PCAP); this.max = new Float32Array(PCAP);
    this.grow = new Float32Array(PCAP); this.size0 = new Float32Array(PCAP); this.drag = new Float32Array(PCAP); this.lift = new Float32Array(PCAP);
    this.fade = new Float32Array(PCAP);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 } },
      vertexShader: `attribute float aSize; attribute float aAlpha; attribute vec3 color; varying vec3 vC; varying float vA; uniform float uScale;
        void main() { vC = color; vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(-mv.z, 0.1) : 0.0; }`,
      fragmentShader: `varying vec3 vC; varying float vA;
        void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.15, d) * vA; if (a < 0.01) discard;
          gl_FragColor = vec4(vC, a); }`,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    scene.add(this.points);
  }
  setScale(h: number, fov: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = h / (2 * Math.tan((fov * Math.PI) / 360));
  }
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, size: number, life: number,
    grow = 0, drag = 0.5, lift = 0, fade = 1): void {
    const i = this.head;
    this.head = (this.head + 1) % PCAP;
    if (this.n < PCAP) this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    this.size[i] = this.size0[i] = size; this.life[i] = life; this.max[i] = life; this.grow[i] = grow; this.drag[i] = drag; this.lift[i] = lift;
    this.alpha[i] = fade; this.fade[i] = fade;
  }
  update(dt: number): void {
    const N = this.n === PCAP ? PCAP : this.n;
    for (let i = 0; i < N; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= k; this.vel[i * 3 + 2] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k + (this.lift[i] - 9.8 * (this.lift[i] === 0 ? 1 : 0)) * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const t = Math.max(0, this.life[i] / this.max[i]);
      this.size[i] = this.size0[i] + this.grow[i] * (1 - t);
      this.alpha[i] = this.fade[i] * Math.min(1, t * 2.5) * (this.life[i] > 0 ? 1 : 0);
    }
    const g = this.points.geometry;
    for (const k of ['position', 'color', 'aSize', 'aAlpha']) (g.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;
  }
}

const TCAP = 64;

export class Effects {
  private add: Particles;
  private alpha: Particles;
  private tracers: THREE.InstancedMesh;
  private tLife = new Float32Array(TCAP);
  private tMax = new Float32Array(TCAP);
  private tHead = 0;
  private flashes: THREE.InstancedMesh;
  private fLife = new Float32Array(16);
  private fHead = 0;
  private light = new THREE.PointLight(0xffc070, 0, 14, 2);
  private lightT = 0; private lightPow = 0;
  private boomT = 0;
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private v = new THREE.Vector3(); private s = new THREE.Vector3();
  private col = new THREE.Color();
  /** Тряска камеры (сила) — читает камера. */
  shake = 0;

  constructor(scene: THREE.Scene) {
    this.add = new Particles(true, scene);
    this.alpha = new Particles(false, scene);
    const tg = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, -0.5);
    const tm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.tracers = new THREE.InstancedMesh(tg, tm, TCAP);
    this.tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracers.setColorAt(0, new THREE.Color(0, 0, 0));
    this.tracers.frustumCulled = false;
    this.tracers.count = TCAP;
    for (let i = 0; i < TCAP; i++) { this.tracers.setMatrixAt(i, this.m.makeScale(0, 0, 0)); this.tracers.setColorAt(i, this.col.setRGB(0, 0, 0)); }
    scene.add(this.tracers);
    // вспышка: три скрещённые плоскости
    const fg = new THREE.BufferGeometry();
    const P: number[] = [];
    const quad = (ax: 'x' | 'y' | 'z') => {
      const pts = ax === 'x' ? [[0, -1, 0], [0, 1, 0], [0, 1, -2], [0, -1, -2]] : ax === 'y' ? [[-1, 0, 0], [1, 0, 0], [1, 0, -2], [-1, 0, -2]] : [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]];
      for (const k of [0, 1, 2, 0, 2, 3]) P.push(...pts[k]);
    };
    quad('x'); quad('y'); quad('z');
    fg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    const fm = new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.flashes = new THREE.InstancedMesh(fg, fm, 16);
    this.flashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flashes.frustumCulled = false;
    for (let i = 0; i < 16; i++) this.flashes.setMatrixAt(i, this.m.makeScale(0, 0, 0));
    scene.add(this.flashes);
    scene.add(this.light); // одна лампа на вспышки и взрывы: число источников в сцене постоянно (без перекомпиляции шейдеров)
  }

  /** Трассер от a до b. */
  tracer(a: THREE.Vector3, b: THREE.Vector3, thick = 0.022): void {
    const i = this.tHead; this.tHead = (this.tHead + 1) % TCAP;
    const len = a.distanceTo(b);
    if (len < 0.5) return;
    this.v.subVectors(b, a).normalize();
    this.q.setFromUnitVectors(this.s.set(0, 0, -1), this.v);
    this.m.compose(a, this.q, this.s.set(thick, thick, len));
    this.tracers.setMatrixAt(i, this.m);
    this.tLife[i] = this.tMax[i] = 0.07;
    this.tracers.setColorAt(i, this.col.setRGB(1, 0.85, 0.5));
  }

  /** Вспышка выстрела в точке дула, направление dir. */
  muzzle(p: THREE.Vector3, dir: THREE.Vector3, size = 0.18): void {
    const i = this.fHead; this.fHead = (this.fHead + 1) % 16;
    this.q.setFromUnitVectors(this.s.set(0, 0, -1), dir);
    const r = Math.random() * Math.PI;
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(this.s.set(0, 0, 1), r));
    this.m.compose(p, this.q, this.s.set(size * 0.6, size * 0.6, size));
    this.flashes.setMatrixAt(i, this.m);
    this.fLife[i] = 0.05;
    if (this.boomT <= 0) { this.light.position.copy(p).addScaledVector(dir, 0.3); this.light.distance = 14; this.lightT = 0.06; this.lightPow = 40; }
    for (let k = 0; k < 3; k++) this.alpha.spawn(p.x, p.y, p.z, dir.x * 1.5 + rnd(0.4), dir.y * 1.5 + 0.3 + rnd(0.2), dir.z * 1.5 + rnd(0.4), 0.55, 0.55, 0.55, 0.12, 0.5, 0.35, 2, 0.6, 0.35);
  }

  /** Попадание: искры (металл) или пыль/крошка (стены, земля). */
  impact(p: THREE.Vector3, n: THREE.Vector3, kind: 'world' | 'vehicle' | 'soft'): void {
    if (kind === 'vehicle') {
      for (let k = 0; k < 7; k++) this.add.spawn(p.x, p.y, p.z, n.x * 3 + rnd(3), n.y * 3 + 1.5 + rnd(2), n.z * 3 + rnd(3), 1, 0.75, 0.35, 0.05, 0.25 + Math.random() * 0.2, 0, 1);
    } else if (kind === 'world') {
      for (let k = 0; k < 5; k++) this.alpha.spawn(p.x, p.y, p.z, n.x * 1.8 + rnd(1), n.y * 1.8 + 0.8 + rnd(0.6), n.z * 1.8 + rnd(1), 0.62, 0.58, 0.52, 0.12, 0.55, 0.25, 2.5, 0, 0.8);
      this.add.spawn(p.x, p.y, p.z, 0, 0, 0, 1, 0.8, 0.5, 0.08, 0.06, 0, 0, 0.01);
    } else {
      // «мягкое» попадание (человек): облачко ткани/пыли, без крови
      for (let k = 0; k < 4; k++) this.alpha.spawn(p.x, p.y, p.z, rnd(1), 0.6 + rnd(0.4), rnd(1), 0.75, 0.72, 0.66, 0.08, 0.35, 0.2, 2, 0.4, 0.7);
    }
  }

  /** Дым из моторного отсека: k 0..1 (светлый → чёрный), fire — пламя. */
  smoke(p: THREE.Vector3, k: number, fire: boolean, vx = 0, vz = 0): void {
    const c = 0.65 - k * 0.55;
    this.alpha.spawn(p.x + rnd(0.3), p.y, p.z + rnd(0.3), vx * 0.3 + rnd(0.3), 1.2 + Math.random() * 0.6, vz * 0.3 + rnd(0.3), c, c, c, 0.35 + k * 0.3, 1.6 + k, 1.6 + k * 1.4, 0.8, 1.2, 0.35 + k * 0.4);
    if (fire) {
      this.add.spawn(p.x + rnd(0.35), p.y + 0.1, p.z + rnd(0.35), vx * 0.2 + rnd(0.2), 1.6 + Math.random(), vz * 0.2 + rnd(0.2), 1, 0.45 + Math.random() * 0.2, 0.08, 0.45, 0.45, 0.4, 1, 2.5, 0.9);
    }
  }

  /** Взрыв (машина): огненный шар, дым, искры, вспышка, тряска. */
  explosion(p: THREE.Vector3, power = 1): void {
    for (let k = 0; k < 40 * power; k++) {
      const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, r = Math.sqrt(1 - u * u), sp = 3 + Math.random() * 6;
      this.add.spawn(p.x, p.y + 0.5, p.z, Math.cos(a) * r * sp, Math.abs(u) * sp + 2, Math.sin(a) * r * sp, 1, 0.55 + Math.random() * 0.3, 0.15, 0.9, 0.7 + Math.random() * 0.5, 2.2, 2.5, 3, 1);
    }
    for (let k = 0; k < 30 * power; k++) {
      this.alpha.spawn(p.x + rnd(1.5), p.y + 0.6 + Math.random(), p.z + rnd(1.5), rnd(2.5), 2 + Math.random() * 3, rnd(2.5), 0.12, 0.11, 0.1, 1.2, 3 + Math.random() * 2, 3, 0.7, 1.5, 0.8);
    }
    for (let k = 0; k < 30; k++) this.add.spawn(p.x, p.y + 0.5, p.z, rnd(14), 4 + Math.random() * 10, rnd(14), 1, 0.8, 0.4, 0.06, 0.8 + Math.random(), 0, 0.3);
    this.light.position.set(p.x, p.y + 2, p.z);
    this.light.distance = 70;
    this.boomT = 0.6;
    this.shake = Math.max(this.shake, 0.6 * power);
  }

  /** Пыль из-под ног (приземление, удар). */
  dust(p: THREE.Vector3, n = 6): void {
    for (let k = 0; k < n; k++) this.alpha.spawn(p.x + rnd(0.3), p.y + 0.05, p.z + rnd(0.3), rnd(1.2), 0.4 + Math.random() * 0.4, rnd(1.2), 0.6, 0.57, 0.52, 0.18, 0.6, 0.4, 3, 0.2, 0.55);
  }

  update(dt: number, camera: THREE.PerspectiveCamera, viewportH: number): void {
    this.add.setScale(viewportH, camera.fov); this.alpha.setScale(viewportH, camera.fov);
    this.add.update(dt); this.alpha.update(dt);
    let tc = false;
    for (let i = 0; i < TCAP; i++) {
      if (this.tLife[i] <= 0) continue;
      this.tLife[i] -= dt;
      const k = Math.max(0, this.tLife[i] / this.tMax[i]);
      this.tracers.setColorAt(i, this.col.setRGB(k, 0.85 * k, 0.5 * k));
      if (this.tLife[i] <= 0) this.tracers.setMatrixAt(i, this.m.makeScale(0, 0, 0));
      tc = true;
    }
    if (tc) { this.tracers.instanceMatrix.needsUpdate = true; this.tracers.instanceColor!.needsUpdate = true; }
    let fc = false;
    for (let i = 0; i < 16; i++) {
      if (this.fLife[i] <= 0) continue;
      this.fLife[i] -= dt;
      if (this.fLife[i] <= 0) this.flashes.setMatrixAt(i, this.m.makeScale(0, 0, 0));
      fc = true;
    }
    if (fc) this.flashes.instanceMatrix.needsUpdate = true;
    this.lightT -= dt;
    this.boomT -= dt;
    this.light.intensity = this.boomT > 0 ? 900 * this.boomT : this.lightT > 0 ? this.lightPow : 0;
    this.shake = Math.max(0, this.shake - dt * 1.5);
  }
}

const rnd = (a: number) => (Math.random() * 2 - 1) * a;
