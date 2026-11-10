import * as THREE from 'three';
import { cityUniforms } from './materials';

/**
 * Вывески витрин: атлас 2048×2048 (ячейки 384×48 → 5×42 = 210 вывесок), текст рисуется в canvas по требованию
 * (ближайшие к камере витрины), в атлас копируется только ячейка (renderer.copyTextureToTexture), ≤ 6 за кадр.
 * Ячейки переиспользуются (LRU). Пока ячейки нет — вывеска рисуется сплошным фирменным цветом (instanceColor).
 * Ночью вывески светятся (cityUniforms.uNfrNight).
 */

const W = 2048, H = 2048, CW = 384, CH = 48;
const COLS = Math.floor(W / CW), ROWS = Math.floor(H / CH);
export const SIGN_CELLS = COLS * ROWS;

export class SignAtlas {
  readonly tex: THREE.DataTexture;
  private cells = new Map<string, number>(); // id → ячейка (порядок вставки = LRU)
  private free: number[] = [];
  private queue: { cell: number; text: string; color: string }[] = [];
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private small: THREE.CanvasTexture;
  private pos = new THREE.Vector2();
  private inited = false;

  constructor() {
    this.tex = new THREE.DataTexture(new Uint8Array(W * H * 4), W, H, THREE.RGBAFormat);
    this.tex.flipY = false;
    this.tex.generateMipmaps = true;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.anisotropy = 4;
    this.tex.needsUpdate = true;
    this.canvas.width = CW; this.canvas.height = CH;
    this.ctx = this.canvas.getContext('2d')!;
    this.small = new THREE.CanvasTexture(this.canvas);
    this.small.flipY = false;
    for (let i = SIGN_CELLS - 1; i >= 0; i--) this.free.push(i);
  }

  /** Ячейка для вывески (−1 — нет места). keep — ячейки, которые нельзя вытеснять в этой пересборке. */
  cellFor(id: string, text: string, color: string, keep: Set<number>): number {
    const c = this.cells.get(id);
    if (c !== undefined) { this.cells.delete(id); this.cells.set(id, c); keep.add(c); return c; }
    let cell = this.free.pop();
    if (cell === undefined) {
      for (const [k, v] of this.cells) { if (!keep.has(v)) { this.cells.delete(k); cell = v; break; } }
      if (cell === undefined) return -1;
    }
    this.cells.set(id, cell);
    keep.add(cell);
    this.queue.push({ cell, text, color });
    return cell;
  }

  /** Вызывается из onBeforeRender меша вывесок. */
  flush(renderer: THREE.WebGLRenderer): void {
    if (!this.inited) { renderer.initTexture(this.tex); this.inited = true; }
    for (let k = 0; k < 6 && this.queue.length; k++) {
      const q = this.queue.shift()!;
      this.draw(q.text, q.color);
      this.small.needsUpdate = true;
      this.pos.set((q.cell % COLS) * CW, Math.floor(q.cell / COLS) * CH);
      renderer.copyTextureToTexture(this.small, this.tex, null, this.pos);
    }
  }

  private draw(text: string, color: string): void {
    const c = this.ctx;
    c.fillStyle = color || '#2a5caa';
    c.fillRect(0, 0, CW, CH);
    const col = new THREE.Color(color || '#2a5caa');
    const lum = 0.299 * col.r + 0.587 * col.g + 0.114 * col.b; // sRGB-компоненты (Color.set из строки → linear; грубо)
    c.fillStyle = 'rgba(255,255,255,0.18)';
    c.fillRect(0, 0, CW, 3); c.fillRect(0, CH - 3, CW, 3);
    c.fillStyle = lum > 0.35 ? '#1a1a1a' : '#ffffff';
    let size = 34;
    c.font = `bold ${size}px "Arial Narrow", Arial, sans-serif`;
    const t = (text || '').toUpperCase().length > 14 ? text : (text || '').toUpperCase();
    const w = c.measureText(t).width;
    if (w > CW - 16) { size = Math.max(14, Math.floor(size * (CW - 16) / w)); c.font = `bold ${size}px "Arial Narrow", Arial, sans-serif`; }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(t, CW / 2, CH / 2 + 1);
  }

  dispose(): void { this.tex.dispose(); this.small.dispose(); }
}

/** Материал вывесок: aExt.x — ячейка атласа (−1 — сплошной цвет инстанса). */
export function signMaterial(atlas: SignAtlas): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
  m.customProgramCacheKey = () => 'nfr-sign';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uAtlas = { value: atlas.tex };
    sh.uniforms.uNfrNight = cityUniforms.uNfrNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aExt; varying vec2 vSUv; varying float vCell;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSUv = uv; vCell = aExt.x;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D uAtlas; uniform float uNfrNight; varying vec2 vSUv; varying float vCell;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 signC = vColor.rgb;
        if (vCell > -0.5) {
          vec2 cell = vec2(mod(vCell, ${COLS}.0), floor(vCell / ${COLS}.0));
          vec2 auv = (cell * vec2(${CW}.0, ${CH}.0) + vec2(vSUv.x, 1.0 - vSUv.y) * vec2(${CW}.0, ${CH}.0)) / vec2(${W}.0, ${H}.0);
          signC = pow(texture2D(uAtlas, auv).rgb, vec3(2.2));
        }
        diffuseColor.rgb = signC;`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uNfrNight * 0.9;');
  };
  return m;
}
