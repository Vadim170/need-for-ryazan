import * as THREE from 'three';
import { SURF, SURF_N, SURF_RES, type TileSurface } from './surface-mask';
import { weatherUniforms } from '../render/weather';
import { loadLandcover, LC, type LandcoverMap } from './landcover';

/**
 * Трава у камеры: два кольца инстансов-«пучков» на GPU (1 draw call на кольцо, 0 работы CPU в кадре).
 *  - Сетка пучков привязана к миру (шаг spacing, снап по камере) → пучки не «плывут». Корень = узел + хэш-джиттер.
 *  - Высота корня — из текстуры heightmap (R32F, билинейно в вершинном шейдере), та же сетка, что у рельефа.
 *  - Где расти — «окно» маски RGBA8 0.5 м вокруг камеры (WIN×WIN): R плотность, G «дикость» (высота/неухоженность),
 *    B газон (1) / пустырь (0). Окно пересобирается из масок тайлов при сдвиге камеры > RECENTER м.
 *  - Маска тайла: растр покрытий (surface-mask) + зелёность спутника (public/world-veg/veg.png, build_vegmask.py):
 *    газон area_grass — густо и коротко; рельеф без покрытий — по спутнику, выше; грунт — редко; у бордюров, стен и оград —
 *    высокие сорняки; на дорогах/тротуарах/плитке/парковках/детплощадках/в зданиях/воде — ничего.
 *  - На склонах (по градиенту heightmap) трава выше. Ветер — синус в вершинном шейдере. Края колец плавно гаснут.
 *  - Цветы (одуванчики, клевер на газонах; ромашки, васильки, пижма на пустырях) — «головки» в пучках, видны пятнами по шуму.
 *  - Карта покрова со спутника (world/landcover.ts, docs/stage3/landcover.md) главнее зелёности: луг — высокая трава с
 *    метёлками (осенью — соломенные), газон — коротко и густо, огород/грунт/песок/щебень — редко, под кронами — реже и ниже,
 *    в зарослях — высокий бурьян. Пришла позже тайлов — маски тайлов пересчитываются.
 */

const WIN = 384; // текселей окна (×0.5 м = 192 м)
const RECENTER = 16;
const NEAR = { spacing: 0.26, n: 168, rIn: 0, rOut: 21 };
const FAR = { spacing: 0.7, n: 204, rIn: 17, rOut: 70 };

/** Трава по классу покрова на голом рельефе: [плотность, «дикость» (высота), газон]. Индекс — код LC. */
const LC_GRASS: Record<number, [number, number, number]> = {
  0: [0.6, 0.4, 0],
  [LC.canopy]: [0.38, 0.3, 0], [LC.conifer]: [0.25, 0.25, 0], [LC.thicket]: [0.6, 0.85, 0],
  [LC.meadow]: [0.97, 0.95, 0], [LC.lawn]: [0.93, 0.12, 1], [LC.garden]: [0.28, 0.25, 0], [LC.bare]: [0.12, 0.3, 0],
  [LC.sand]: [0.05, 0.25, 0], [LC.gravel]: [0.14, 0.55, 0], [LC.water]: [0.3, 0.7, 0], [LC.paved]: [0.06, 0.4, 0], [LC.building]: [0, 0, 0],
};

export interface TerrainInfo { cols: number; rows: number; cellSize: number; minX: number; minZ: number }

interface VegMap { cell: number; cols: number; rows: number; minX: number; minZ: number; data: Uint8Array }

export class Grass {
  readonly root = new THREE.Group();
  private tiles = new Map<string, { minX: number; minZ: number; mask: Uint8Array }>();
  private winData = new Uint8Array(WIN * WIN * 4);
  private winTex = new THREE.DataTexture(this.winData, WIN, WIN, THREE.RGBAFormat, THREE.UnsignedByteType);
  private heightTex: THREE.DataTexture | null = null;
  private veg: VegMap | null = null;
  private lc: LandcoverMap | null = null;
  /** входы addTile (для пересчёта, когда придёт карта покрова) */
  private inputs = new Map<string, { s: TileSurface; segs: number[]; clear: number[] }>();
  private winOrigin = new THREE.Vector2(1e9, 1e9);
  private dirty = true;
  readonly uniforms = {
    uMask: { value: this.winTex as THREE.Texture },
    uMaskOrigin: { value: new THREE.Vector2() },
    uMaskSize: { value: WIN * SURF_RES },
    uHeight: { value: null as THREE.Texture | null },
    uHInfo: { value: new THREE.Vector4() }, // minX, minZ, cellSize, —
    uHSize: { value: new THREE.Vector2() },
    uCam: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    // погода (render/weather.ts): снег прячет траву, сезон сушит, ветер качает
    uWxSnow: weatherUniforms.snowCover, uWxSeason: weatherUniforms.season, uWxWind: weatherUniforms.windStrength, uWxDir: weatherUniforms.windDir,
  };
  readonly stats = { recomposes: 0, composeMs: 0 };
  enabled = true;

  constructor(scene: THREE.Scene, time: { value: number }) {
    this.root.name = 'grass';
    this.winTex.magFilter = THREE.LinearFilter;
    this.winTex.minFilter = THREE.LinearFilter;
    this.winTex.generateMipmaps = false;
    this.winTex.flipY = false;
    weatherUniforms.surf.value = this.winTex; // маска покрытий у камеры — и для погоды (A — близость к краю дороги)
    this.uniforms.uTime = time;
    scene.add(this.root);
    this.root.add(this.ring(NEAR, true), this.ring(FAR, false));
    // спутниковая маска зелени (необязательна: без неё — средняя плотность на рельефе)
    fetch('/world-veg/veg.json').then((r) => (r.ok ? r.json() : null)).then(async (meta) => {
      if (!meta) return;
      const img = new Image();
      img.src = '/world-veg/veg.png';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = meta.cols; c.height = meta.rows;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const rgba = ctx.getImageData(0, 0, meta.cols, meta.rows).data;
      const data = new Uint8Array(meta.cols * meta.rows);
      for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
      this.veg = { cell: meta.cell, cols: meta.cols, rows: meta.rows, minX: meta.minX, minZ: meta.minZ, data };
    }).catch(() => undefined);
    loadLandcover().then((m) => {
      if (!m) return;
      this.lc = m;
      for (const [k, v] of this.inputs) this.addTile(k, v.s, v.segs, v.clear);
    });
  }

  setTerrain(t: TerrainInfo, heights: Float32Array): void {
    const tex = new THREE.DataTexture(heights, t.cols, t.rows, THREE.RedFormat, THREE.FloatType);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.flipY = false;
    tex.needsUpdate = true;
    this.heightTex = tex;
    this.uniforms.uHeight.value = tex;
    this.uniforms.uHInfo.value.set(t.minX, t.minZ, t.cellSize, 0);
    this.uniforms.uHSize.value.set(t.cols, t.rows);
  }

  private vegAt(x: number, z: number): number {
    const v = this.veg;
    if (!v) return 0.55;
    const i = Math.floor((x - v.minX) / v.cell), j = Math.floor((z - v.minZ) / v.cell);
    if (i < 0 || j < 0 || i >= v.cols || j >= v.rows) return 0.5;
    return v.data[j * v.cols + i] / 255;
  }

  /** Маска тайла из растра покрытий; segs — отрезки оград (x1,z1,x2,z2) для сорняков вдоль них. */
  /** clear — машины (x, z, cos, sin поворота): под и вокруг них травы нет (иначе колёса «тонут» в траве). */
  addTile(key: string, s: TileSurface, segs: number[], clear: number[] = []): void {
    this.inputs.set(key, { s, segs, clear });
    const N = SURF_N, code = s.code, mask = new Uint8Array(N * N * 4);
    const lcm = this.lc;
    const curb = roadEdgeProximity(code); // A: близость к границе проезжей части (сугробы/каша зимой, render/weather.ts)
    // 1) расстояние (в ячейках, ≤ 3) до «твёрдого» края: дорога/тротуар/здание/плитка — для сорняков у бордюров и стен
    const hard = (c: number) => c === SURF.road || c === SURF.sidewalk || c >= SURF.building || c === SURF.paving || c === SURF.parking;
    const edge = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      if (!hard(code[j * N + i])) continue;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const k = jj * N + ii;
        const d = 3 - Math.max(Math.abs(di), Math.abs(dj));
        if (d > edge[k]) edge[k] = d;
      }
    }
    // 2) ограды: полоса ±0.75 м
    for (let q = 0; q + 3 < segs.length; q += 4) {
      const x1 = segs[q], z1 = segs[q + 1], x2 = segs[q + 2], z2 = segs[q + 3];
      const len = Math.hypot(x2 - x1, z2 - z1), steps = Math.max(1, Math.ceil(len / 0.4));
      for (let t = 0; t <= steps; t++) {
        const px = x1 + (x2 - x1) * t / steps, pz = z1 + (z2 - z1) * t / steps;
        const ci = Math.floor((px - s.minX) / SURF_RES), cj = Math.floor((pz - s.minZ) / SURF_RES);
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = ci + di, jj = cj + dj;
          if (ii >= 0 && jj >= 0 && ii < N && jj < N) edge[jj * N + ii] = Math.max(edge[jj * N + ii], 3);
        }
      }
    }
    for (let j = 0; j < N; j++) {
      const z = s.minZ + (j + 0.5) * SURF_RES;
      let veg = 0, vegI = -1;
      // строка карты покрова (2 м = 4 ячейки)
      const lj = lcm ? Math.floor((z - lcm.minZ) / lcm.cell) : -1;
      const lrow = lcm && lj >= 0 && lj < lcm.rows ? lj * lcm.cols : -1;
      for (let i = 0; i < N; i++) {
        const k = j * N + i, c = code[k];
        let dens = 0, wild = 0, lawn = 0;
        let lcc: number = LC.none;
        if (lrow >= 0 && (c === SURF.terrain || c === SURF.grass)) {
          const li = Math.floor((s.minX + (i + 0.5) * SURF_RES - lcm!.minX) / lcm!.cell);
          if (li >= 0 && li < lcm!.cols) lcc = lcm!.data[lrow + li];
        }
        if (c === SURF.grass) {
          dens = 0.95; wild = 0.15; lawn = 1;
          if (lcc === LC.meadow) { wild = 0.75; lawn = 0.2; }                    // некошеная трава в парке
          else if (lcc === LC.bare || lcc === LC.gravel) { dens = 0.35; wild = 0.3; lawn = 0.5; }   // вытоптано
          else if (lcc === LC.canopy || lcc === LC.conifer) { dens = 0.6; wild = 0.2; }
        } else if (c === SURF.terrain && lcc !== LC.none) {
          const L = LC_GRASS[lcc] ?? LC_GRASS[0];
          dens = L[0]; wild = L[1]; lawn = L[2];
        } else if (c === SURF.terrain) {
          const vi = i >> 3; // спутник 4 м = 8 ячеек
          if (vi !== vegI) { vegI = vi; veg = this.vegAt(s.minX + (i + 0.5) * SURF_RES, z); }
          dens = 0.3 + 0.7 * veg; wild = 0.3 + 0.3 * veg;
        } else if (c === SURF.dirt) { dens = 0.22; wild = 0.35; }
        else if (c === SURF.path) { dens = 0; }
        if (dens > 0 && edge[k]) {
          // у края: сорняки — густо и высоко (кроме 0.5 м прямо у края: там тень бордюра/стены, реже)
          wild = Math.max(wild, 0.5 + 0.12 * edge[k]);
          dens = Math.max(dens, 0.75);
          lawn *= 0.5;
        }
        mask[k * 4] = dens * 255; mask[k * 4 + 1] = Math.min(1, wild) * 255; mask[k * 4 + 2] = lawn * 255; mask[k * 4 + 3] = curb[k];
      }
    }
    // машины: прямоугольник 5.0 × 2.3 м — плотность 0
    for (let q = 0; q + 3 < clear.length; q += 4) {
      const cx = clear[q], cz = clear[q + 1], cs = clear[q + 2], sn = clear[q + 3];
      const i0 = Math.max(0, Math.floor((cx - 3 - s.minX) / SURF_RES)), i1 = Math.min(N - 1, Math.floor((cx + 3 - s.minX) / SURF_RES));
      const j0 = Math.max(0, Math.floor((cz - 3 - s.minZ) / SURF_RES)), j1 = Math.min(N - 1, Math.floor((cz + 3 - s.minZ) / SURF_RES));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const dx = s.minX + (i + 0.5) * SURF_RES - cx, dz = s.minZ + (j + 0.5) * SURF_RES - cz;
        const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
        if (Math.abs(lx) < 1.15 && Math.abs(lz) < 2.5) mask[(j * N + i) * 4] = 0;
      }
    }
    this.tiles.set(key, { minX: s.minX, minZ: s.minZ, mask });
    this.dirty = true;
  }

  removeTile(key: string): void {
    this.inputs.delete(key);
    if (this.tiles.delete(key)) this.dirty = true;
  }

  update(camera: THREE.Camera): void {
    this.root.visible = this.enabled && !!this.heightTex;
    if (!this.root.visible) return;
    const p = camera.position;
    this.uniforms.uCam.value.copy(p);
    const half = WIN * SURF_RES / 2;
    const ox = Math.round((p.x - half) / RECENTER) * RECENTER, oz = Math.round((p.z - half) / RECENTER) * RECENTER;
    if (!this.dirty && ox === this.winOrigin.x && oz === this.winOrigin.y) return;
    this.compose(ox, oz);
  }

  /** Окно маски: копия строк из масок тайлов (тайлы 250 м = 500 ячеек; окно выровнено на 0.5 м). */
  private compose(ox: number, oz: number): void {
    const t0 = performance.now();
    this.dirty = false;
    this.winOrigin.set(ox, oz);
    this.uniforms.uMaskOrigin.value.set(ox, oz);
    weatherUniforms.surfWin.value.set(ox, oz, WIN * SURF_RES, 1);
    const W = this.winData;
    W.fill(0);
    for (const t of this.tiles.values()) {
      // пересечение тайла и окна в ячейках окна
      const ti0 = Math.round((t.minX - ox) / SURF_RES), tj0 = Math.round((t.minZ - oz) / SURF_RES);
      const i0 = Math.max(0, ti0), i1 = Math.min(WIN, ti0 + SURF_N);
      const j0 = Math.max(0, tj0), j1 = Math.min(WIN, tj0 + SURF_N);
      if (i0 >= i1 || j0 >= j1) continue;
      for (let j = j0; j < j1; j++) {
        const src = ((j - tj0) * SURF_N + (i0 - ti0)) * 4;
        W.set(t.mask.subarray(src, src + (i1 - i0) * 4), (j * WIN + i0) * 4);
      }
    }
    this.winTex.needsUpdate = true;
    this.stats.recomposes++;
    this.stats.composeMs = performance.now() - t0;
  }

  private ring(cfg: typeof NEAR, near: boolean): THREE.Mesh {
    const base = tuftGeometry(near, cfg.spacing);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const [k, a] of Object.entries(base.attributes)) g.setAttribute(k, a);
    const cells = new Float32Array(cfg.n * cfg.n * 2);
    let q = 0;
    const r2 = (cfg.rOut / cfg.spacing + 1) ** 2, rin2 = Math.max(0, cfg.rIn / cfg.spacing - 1) ** 2;
    for (let j = 0; j < cfg.n; j++) for (let i = 0; i < cfg.n; i++) {
      const x = i - cfg.n / 2, z = j - cfg.n / 2, d2 = x * x + z * z;
      if (d2 > r2 || d2 < rin2) continue; // только кольцо (квадрат → круг)
      cells[q++] = x; cells[q++] = z;
    }
    g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells.slice(0, q), 2));
    g.instanceCount = q / 2;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const m = new THREE.Mesh(g, grassMaterial(this.uniforms, cfg, near));
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.castShadow = false;
    m.matrixAutoUpdate = false;
    m.name = near ? 'grass_near' : 'grass_far';
    return m;
  }

  dispose(): void {
    this.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    this.winTex.dispose();
    this.heightTex?.dispose();
    this.root.removeFromParent();
  }
}

/**
 * Пучок: несколько изогнутых травинок (near: 5 травинок × 3 сегмента; far: 4 широких треугольника) + головка цветка.
 * Атрибуты: position (x,z — смещение у корня в долях шага; y — 0..1 доля высоты), aBlade (изгиб x,z, ширина, роль:
 * 0 травинка, 1 головка цветка).
 */
function tuftGeometry(near: boolean, spacing: number): THREE.BufferGeometry {
  const pos: number[] = [], blade: number[] = [], idx: number[] = [];
  const rnd = mulberry(near ? 7 : 11);
  const nb = near ? 8 : 5;
  for (let b = 0; b < nb; b++) {
    const a = rnd() * Math.PI * 2, r = (0.1 + 0.9 * rnd()) * spacing * 0.6;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    const ba = rnd() * Math.PI * 2, bend = 0.25 + 0.5 * rnd();
    const dx = Math.cos(ba) * bend, dz = Math.sin(ba) * bend;
    const w = (near ? 0.022 : 0.07) * (0.7 + 0.6 * rnd());
    const px = -Math.sin(ba) * w, pz = Math.cos(ba) * w; // поперёк изгиба
    const v0 = pos.length / 3;
    const segs = near ? 2 : 1;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs, ww = 1 - t * 0.85;
      if (s === segs) { pos.push(bx, t, bz); blade.push(dx, dz, 0, 0); break; }
      pos.push(bx - px * ww, t, bz - pz * ww); blade.push(dx, dz, 0, 0);
      pos.push(bx + px * ww, t, bz + pz * ww); blade.push(dx, dz, 0, 0);
    }
    for (let s = 0; s < segs; s++) {
      const a0 = v0 + s * 2;
      if (s < segs - 1) idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
      else idx.push(a0, a0 + 1, a0 + 2);
    }
  }
  // головка цветка: два скрещенных ромбика на высоте 1 (чуть выше травы)
  const hs = near ? 0.024 : 0.07;
  for (const rot of [0, Math.PI / 2]) {
    const v0 = pos.length / 3, cx = Math.cos(rot) * hs, cz = Math.sin(rot) * hs;
    pos.push(-cx, 1.0, -cz, cx, 1.0, cz, 0, 1.0 + hs / 0.5, 0, 0, 1.0 - hs / 0.5, 0);
    for (let k = 0; k < 4; k++) blade.push(0, 0, 0, 1);
    idx.push(v0, v0 + 2, v0 + 1, v0, v0 + 1, v0 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(blade, 4));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

function mulberry(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function grassMaterial(u: Grass['uniforms'], cfg: typeof NEAR, near: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, side: THREE.DoubleSide });
  m.customProgramCacheKey = () => 'nfr-grass-' + near;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
        attribute vec2 aCell; attribute vec4 aBlade;
        uniform sampler2D uMask; uniform vec2 uMaskOrigin; uniform float uMaskSize;
        uniform sampler2D uHeight; uniform vec4 uHInfo; uniform vec2 uHSize; uniform vec3 uCam; uniform float uTime; uniform float uWxSnow, uWxSeason, uWxWind; uniform vec2 uWxDir;
        varying vec3 vGCol; varying float vGT;
        float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gHash(i), gHash(i + vec2(1, 0)), f.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), f.x), f.y); }
        float gH(vec2 rc) { return texelFetch(uHeight, ivec2(clamp(rc, vec2(0.0), uHSize - 1.0)), 0).r; }
        // высота рельефа: та же триангуляция ячейки, что у Rapier/меша (диагональ (r,c)-(r+1,c+1))
        float gHeight(vec2 xz) {
          vec2 f = (xz - uHInfo.xy) / uHInfo.z; vec2 c = floor(f), t = f - c;
          float h00 = gH(c), h10 = gH(c + vec2(1, 0)), h01 = gH(c + vec2(0, 1)), h11 = gH(c + vec2(1, 1));
          return t.y > t.x ? h00 + (h01 - h00) * t.y + (h11 - h01) * t.x : h00 + (h10 - h00) * t.x + (h11 - h10) * t.y;
        }
        vec3 gPos; float gKeep;`)
      .replace('#include <beginnormal_vertex>', /* glsl */ `
        {
          const float SP = ${cfg.spacing.toFixed(3)};
          vec2 snap = floor(uCam.xz / SP);
          vec2 cellId = snap + aCell;
          vec2 base = (cellId + 0.5) * SP;
          float h1 = gHash(cellId), h2 = gHash(cellId + 17.3), h3 = gHash(cellId + 41.7), h4 = gHash(cellId * 1.37 + 3.1);
          vec2 root = base + (vec2(h1, h2) - 0.5) * SP * 0.9;
          vec4 mk = texture(uMask, (root - uMaskOrigin) / uMaskSize);
          float d = length(root - uCam.xz);
          float fade = (1.0 - smoothstep(${(cfg.rOut * 0.75).toFixed(1)}, ${cfg.rOut.toFixed(1)}, d))${cfg.rIn > 0 ? ` * smoothstep(${cfg.rIn.toFixed(1)}, ${(cfg.rIn + 4).toFixed(1)}, d)` : ''};
          ${near ? `fade *= 1.0 - smoothstep(${(FAR.rIn).toFixed(1)}, ${(FAR.rIn + 4).toFixed(1)}, d);` : ''}
          // плотность: маска × шум пятен (проплешины), прореживание вдали
          float patchN = gNoise(root * 0.35) * 0.6 + gNoise(root * 1.7) * 0.4;
          float dens = mk.r * smoothstep(0.15, 0.55, patchN + mk.r * 0.35);
          dens *= 1.0 - smoothstep(0.12, 0.45, uWxSnow + (patchN - 0.5) * 0.3); // под снегом травы нет
          gKeep = step(h3, dens) * fade;
          // ранний выход для всего пучка: нет травы или пучок позади камеры → вырожденные треугольники
          vec3 camFwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
          vec2 toR = root - uCam.xz;
          bool behind = dot(toR, normalize(camFwd.xz + 1e-5)) < -1.5 && d > 2.0;
          if (gKeep < 0.01 || behind) {
            gPos = vec3(0.0, -1.0e5, 0.0); vGCol = vec3(0.0); vGT = 0.0;
          } else {
          float y0 = gHeight(root);
          // склон: градиент по heightmap → дикая высокая трава в оврагах
          float gx = gHeight(root + vec2(1.5, 0.0)) - y0, gz = gHeight(root + vec2(0.0, 1.5)) - y0;
          float slope = clamp(length(vec2(gx, gz)) / 1.5, 0.0, 1.0);
          float wild = clamp(mk.g + slope * 1.2, 0.0, 1.0);
          float H = mix(0.07, 0.72, wild * wild) * (0.6 + 0.8 * h4) * (0.85 + 0.3 * gNoise(root * 0.5));
          H *= mix(1.0, 0.9, mk.b);
          // цветы: пятна по шуму; газон — одуванчики/клевер, пустырь — ромашки/васильки/пижма
          float fl = smoothstep(0.64, 0.8, gNoise(root * 0.12 + 7.0)) * step(0.72, gHash(cellId + 5.5));
          float isHead = aBlade.w;
          // метёлки злаков на некошеном лугу (G высокий, не газон): до поздней осени, к осени — соломенные
          float seed = step(0.72, mk.g) * (1.0 - mk.b) * step(0.5, gHash(cellId + 9.1)) * (1.0 - fl);
          float show = isHead > 0.5 ? max(fl * step(0.15, mk.r) * step(uWxSeason, 0.3), seed * step(uWxSeason, 0.8)) : 1.0;
          gKeep *= show;
          // ветер: наклон макушки
          float t = position.y;
          vec2 wind = vec2(sin(uTime * 1.6 + root.x * 0.35 + root.y * 0.2), cos(uTime * 1.3 + root.y * 0.3)) * (0.06 + 0.08 * wild);
          wind += vec2(sin(uTime * 4.1 + h1 * 6.28), 0.0) * 0.015;
          wind = wind * (0.35 + 2.4 * uWxWind) + uWxDir * uWxWind * (0.1 + 0.08 * sin(uTime * 0.9 + root.x * 0.05));
          vec2 bend = aBlade.xy * 0.35 * H * t * t + wind * t * t * H * 2.0;
          float hh = isHead > 0.5 ? H + (position.y - 1.0) * 1.0 : H * t;
          float sc = ${near ? '1.0' : '1.0'} * gKeep;
          gPos = vec3(root.x + (position.x + bend.x) * sc, y0 + hh * sc - 0.02, root.y + (position.z + bend.y) * sc);
          // цвет: тёмный низ → светлая макушка; сухие пятна; газон зеленее
          vec3 dark = vec3(0.07, 0.15, 0.035), tip = vec3(0.30, 0.45, 0.12);
          vec3 dry = vec3(0.50, 0.46, 0.22);
          float dryN = smoothstep(0.55, 0.85, gNoise(root * 0.08 + 31.0)) * (1.0 - mk.b * 0.6) + wild * 0.25 * h2;
          dryN = mix(dryN, 0.8, smoothstep(0.3, 0.8, uWxSeason) * (0.7 + 0.3 * h2)); // осень/зима без снега — сухая бурая
          vec3 c = mix(dark, mix(tip, dry, clamp(dryN, 0.0, 0.8)), t) * (0.85 + 0.3 * h1);
          c = mix(c, c * vec3(0.9, 1.08, 0.8), mk.b);
          if (isHead > 0.5) {
            float k = gHash(floor(root * 0.05) + 2.0);
            c = mk.b > 0.5 ? (k < 0.6 ? vec3(1.0, 0.78, 0.05) : vec3(0.95, 0.9, 0.95))           // одуванчик / клевер
                           : (k < 0.5 ? vec3(0.95) : k < 0.65 ? vec3(0.3, 0.42, 0.9) : vec3(0.95, 0.75, 0.1)); // ромашка / василёк / пижма
            if (seed > 0.5) c = mix(vec3(0.24, 0.27, 0.12), vec3(0.46, 0.38, 0.2), smoothstep(0.1, 0.5, uWxSeason) * 0.8 + h2 * 0.3); // метёлка
          }
          vGCol = c; vGT = t;
          }
        }
        vec3 objectNormal = normalize(vec3(aBlade.x * 0.25, 1.0, aBlade.y * 0.25));`)
      .replace('#include <begin_vertex>', 'vec3 transformed = gPos;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGCol; varying float vGT;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vGCol;')
      // двусторонние травинки: нормаль «вверх» с обеих сторон (без переворота для задней грани)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal); nonPerturbedNormal = normal;');
  };
  return m;
}

/**
 * Близость к границе проезжей части 0..255 (255 на краю дороги, 0 дальше ~3 м) для каждой ячейки тайла — и со стороны
 * дороги, и со стороны тротуара/газона. Двухпроходная chamfer-дистанция до ячейки «другого» класса (дорога/не дорога).
 */
function roadEdgeProximity(code: Uint8Array): Uint8Array {
  const N = SURF_N, INF = 1e4;
  const isRoad = (k: number) => code[k] === SURF.road;
  const d = new Float32Array(N * N);
  // расстояние до ближайшей ячейки противоположного класса (в ячейках 0.5 м)
  for (let k = 0; k < N * N; k++) d[k] = INF;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, r = isRoad(k);
    if ((i > 0 && isRoad(k - 1) !== r) || (i < N - 1 && isRoad(k + 1) !== r) || (j > 0 && isRoad(k - N) !== r) || (j < N - 1 && isRoad(k + N) !== r)) d[k] = 0.5;
  }
  const D = Math.SQRT2;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i; let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + 1);
    if (j > 0) { v = Math.min(v, d[k - N] + 1); if (i > 0) v = Math.min(v, d[k - N - 1] + D); if (i < N - 1) v = Math.min(v, d[k - N + 1] + D); }
    d[k] = v;
  }
  for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) {
    const k = j * N + i; let v = d[k];
    if (i < N - 1) v = Math.min(v, d[k + 1] + 1);
    if (j < N - 1) { v = Math.min(v, d[k + N] + 1); if (i < N - 1) v = Math.min(v, d[k + N + 1] + D); if (i > 0) v = Math.min(v, d[k + N - 1] + D); }
    d[k] = v;
  }
  const out = new Uint8Array(N * N);
  for (let k = 0; k < N * N; k++) out[k] = Math.max(0, Math.min(255, Math.round((1 - (d[k] - 0.5) / 6) * 255)));
  return out;
}
