import type { RoadGraph, SpawnPoint } from '../world/city-world';
import type { RoadIndex } from '../world/road-index';
import { LANDMARKS, shortName } from './minimap';

/** Мета пирамиды карты (pipeline/build_map.py → public/world-map/meta.json). */
interface MapMeta {
  tile: number; minX: number; minZ: number; maxX: number; maxZ: number;
  levels: { res: number; w: number; h: number; cols: number; rows: number }[];
  layers: Record<string, boolean>;
}
interface Poi { x: number; z: number; letter: string; name: string; color: string; minScale: number; round?: boolean }
interface LabelEdge { name: string; hw: number; len: number; ax: number; az: number; bx: number; bz: number }

export interface WorldMapOptions {
  graph: RoadGraph;
  roads: RoadIndex;
  spawns: SpawnPoint[];
  /** Базовый URL мира ('/world/') — станции берём из rail/net.json. */
  worldBase: string;
  mapBase?: string;
  /** Игрок (машина или пешком): позиция и курс (рад, по часовой от севера). */
  player: () => { x: number; z: number; heading: number };
  /** Брошенная/последняя машина, когда игрок пешком (иначе null). */
  parkedCar: () => { x: number; z: number; heading: number } | null;
  /** Клик ЛКМ: переехать в точку карты (карта уже закрыта). */
  onTravel: (x: number, z: number) => void;
  /** Куда реально встанем (привязка к дороге/тропе) — превью под курсором. */
  preview?: (x: number, z: number) => { x: number; z: number } | null;
  onWaypoint?: (wp: { x: number; z: number } | null) => void;
  onToggle?: (open: boolean) => void;
}

const HW_RANK: Record<string, number> = { primary: 0, primary_link: 0, secondary: 1, secondary_link: 1, tertiary: 2, tertiary_link: 2, unclassified: 3, residential: 3, living_street: 3 };
/** Минимальный масштаб (px/м), с которого пишем названия улиц данного ранга. */
const HW_SCALE = [0.13, 0.22, 0.34, 0.6];
const MIN_S = 0.06, MAX_S = 3;

/**
 * Карта мира (M): полноэкранная, тайлы схемы/спутника из public/world-map, подписи улиц/районов/ориентиров, клик — быстрый переезд.
 * Пока открыта, main.ts ставит игру на паузу (WorldMap.open).
 */
export class WorldMap {
  open = false;
  private root = document.createElement('div');
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private info = document.createElement('div');
  private msg = document.createElement('div');
  private layerBtns: Record<string, HTMLButtonElement> = {};
  private meta: MapMeta | null = null;
  private loading: Promise<void> | null = null;
  private layer: 'scheme' | 'sat' = 'scheme';
  private cx = 0; private cz = 0; private s = 0.2;
  private W = 0; private H = 0; private dpr = 1;
  private dirty = true;
  private tiles = new Map<string, HTMLImageElement | 'x'>();
  private pois: Poi[] = [];
  private districts: { name: string; x: number; z: number; kind: string; area: number }[] = [];
  private labelEdges: LabelEdge[] = [];
  private waypoint: { x: number; z: number } | null = null;
  private mouse: { x: number; z: number; sx: number; sy: number } | null = null;
  private hoverPreview: { x: number; z: number } | null = null;
  private hoverStreet = '';
  private pointers = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number; t: number; moved: boolean } | null = null;
  private pinch = 0;
  private acc = 0;
  private flash: { x: number; z: number; t: number } | null = null;

  constructor(private o: WorldMapOptions) {
    this.g = this.canvas.getContext('2d')!;
    const r = this.root;
    r.id = 'world-map';
    r.style.cssText = 'position:fixed;inset:0;z-index:40;background:#14171b;display:none;user-select:none;touch-action:none;font-family:system-ui,sans-serif';
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:crosshair';
    r.appendChild(this.canvas);
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;right:14px;top:14px;display:flex;gap:6px;align-items:center';
    const mk = (t: string, title: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = t; b.title = title;
      b.style.cssText = 'min-width:34px;height:34px;padding:0 12px;background:rgba(20,24,28,.88);color:#eee;border:1.5px solid rgba(255,255,255,.35);border-radius:6px;font:600 14px system-ui,sans-serif;cursor:pointer';
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      bar.appendChild(b);
      return b;
    };
    this.layerBtns.scheme = mk('Схема', 'Схема', () => this.setLayer('scheme'));
    this.layerBtns.sat = mk('Спутник', 'Спутниковый снимок', () => this.setLayer('sat'));
    mk('+', 'Приблизить', () => this.zoomBy(1.5));
    mk('−', 'Отдалить', () => this.zoomBy(1 / 1.5));
    mk('◎', 'Центр на игроке', () => this.centerOnPlayer());
    mk('✕', 'Закрыть (M / Esc)', () => this.toggle(false));
    r.appendChild(bar);
    const title = document.createElement('div');
    title.textContent = 'КАРТА ГОРОДА';
    title.style.cssText = 'position:absolute;left:16px;top:14px;color:#ffd23f;font:800 18px system-ui,sans-serif;letter-spacing:.14em;text-shadow:0 1px 3px #000;pointer-events:none';
    r.appendChild(title);
    this.info.style.cssText = 'position:absolute;left:14px;bottom:36px;padding:6px 10px;background:rgba(20,24,28,.85);color:#eee;font:600 13px system-ui,sans-serif;border-radius:6px;pointer-events:none';
    r.appendChild(this.info);
    const hint = document.createElement('div');
    hint.textContent = 'ЛКМ — переехать · ПКМ — метка · перетаскивание — сдвиг · колесо / щипок / + − — масштаб · M или Esc — закрыть';
    hint.style.cssText = 'position:absolute;left:14px;bottom:10px;color:rgba(255,255,255,.7);font:12px system-ui,sans-serif;text-shadow:0 1px 2px #000;pointer-events:none';
    r.appendChild(hint);
    this.msg.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#ddd;font:600 16px system-ui,sans-serif;text-align:center;display:none';
    r.appendChild(this.msg);
    document.body.appendChild(r);

    const cv = this.canvas;
    cv.addEventListener('pointerdown', this.onDown);
    cv.addEventListener('pointermove', this.onMove);
    cv.addEventListener('pointerup', this.onUp);
    cv.addEventListener('pointercancel', this.onUp);
    cv.addEventListener('pointerleave', () => { this.mouse = null; this.hoverPreview = null; this.dirty = true; });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    cv.addEventListener('contextmenu', (e) => { e.preventDefault(); this.rightClick(e.offsetX, e.offsetY); });
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if (e.code === 'Escape') { this.toggle(false); e.preventDefault(); }
      else if (e.code === 'Equal' || e.code === 'NumpadAdd') this.zoomBy(1.4);
      else if (e.code === 'Minus' || e.code === 'NumpadSubtract') this.zoomBy(1 / 1.4);
      else if (e.code === 'KeyF') this.setLayer(this.layer === 'scheme' ? 'sat' : 'scheme');
    });
    window.addEventListener('resize', () => { if (this.open) this.resize(); });
    // названия улиц: по ребру — середина ломаной, ориентация по соседним точкам
    for (const e of o.graph.edges) {
      if (!e.name || e.highway === undefined || !(e.highway in HW_RANK)) continue;
      const p = e.points;
      if (p.length < 2) continue;
      let len = 0;
      for (let i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][2] - p[i - 1][2]);
      if (len < 40) continue;
      const m = Math.floor(p.length / 2), a = p[Math.max(m - 1, 0)], b = p[Math.min(m + (p.length > 2 ? 1 : 0), p.length - 1)];
      this.labelEdges.push({ name: shortName(e.name), hw: HW_RANK[e.highway], len, ax: a[0], az: a[2], bx: b[0], bz: b[2] });
    }
    this.labelEdges.sort((a, b) => a.hw - b.hw || b.len - a.len);
  }

  get blocking(): boolean { return this.open; }

  toggle(on = !this.open): void {
    if (on === this.open) return;
    this.open = on;
    this.root.style.display = on ? 'block' : 'none';
    if (on) {
      if (document.pointerLockElement) document.exitPointerLock?.();
      this.resize();
      this.centerOnPlayer();
      void this.ensureLoaded();
    }
    this.pointers.clear(); this.down = null;
    this.o.onToggle?.(on);
    this.dirty = true;
  }

  setWaypoint(wp: { x: number; z: number } | null): void { this.waypoint = wp; this.o.onWaypoint?.(wp); this.dirty = true; }

  private setLayer(l: 'scheme' | 'sat'): void {
    if (l === 'sat' && !this.meta?.layers.sat) return;
    this.layer = l; this.dirty = true;
    this.layerBtns.scheme.style.borderColor = l === 'scheme' ? '#ffd23f' : 'rgba(255,255,255,.35)';
    this.layerBtns.sat.style.borderColor = l === 'sat' ? '#ffd23f' : 'rgba(255,255,255,.35)';
  }

  private centerOnPlayer(): void {
    const p = this.o.player();
    this.cx = p.x; this.cz = p.z;
    this.s = Math.min(Math.max(this.s < 0.3 ? 0.5 : this.s, MIN_S), MAX_S);
    this.dirty = true;
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth; this.H = window.innerHeight;
    this.canvas.width = Math.round(this.W * this.dpr); this.canvas.height = Math.round(this.H * this.dpr);
    this.dirty = true;
  }

  private minScale(): number {
    const m = this.meta;
    if (!m) return MIN_S;
    return Math.min(this.W / (m.maxX - m.minX), this.H / (m.maxZ - m.minZ)) * 0.9;
  }

  private zoomBy(f: number): void { this.zoomAt(this.W / 2, this.H / 2, f); }
  private zoomAt(sx: number, sy: number, f: number): void {
    const wx = this.cx + (sx - this.W / 2) / this.s, wz = this.cz + (sy - this.H / 2) / this.s;
    this.s = Math.min(MAX_S, Math.max(this.minScale(), this.s * f));
    this.cx = wx - (sx - this.W / 2) / this.s; this.cz = wz - (sy - this.H / 2) / this.s;
    this.dirty = true;
  }

  private toWorld(sx: number, sy: number): { x: number; z: number } {
    return { x: this.cx + (sx - this.W / 2) / this.s, z: this.cz + (sy - this.H / 2) / this.s };
  }

  // ---------------------------------------------------------------- ввод
  private onDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 2) { this.pinch = this.pinchDist(); if (this.down) this.down.moved = true; return; }
    if (e.button === 0) this.down = { x: e.offsetX, y: e.offsetY, t: performance.now(), moved: false };
  };
  private pinchDist(): number { const [a, b] = [...this.pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); }
  private onMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    this.mouse = { ...this.toWorld(e.offsetX, e.offsetY), sx: e.offsetX, sy: e.offsetY };
    if (prev) {
      if (this.pointers.size === 2) {
        this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
        const d = this.pinchDist(), [a, b] = [...this.pointers.values()];
        if (this.pinch > 0 && d > 0) this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / this.pinch);
        this.pinch = d;
      } else if (this.down) {
        const dx = e.offsetX - prev.x, dy = e.offsetY - prev.y;
        if (!this.down.moved && Math.hypot(e.offsetX - this.down.x, e.offsetY - this.down.y) > 5) this.down.moved = true;
        if (this.down.moved) { this.cx -= dx / this.s; this.cz -= dy / this.s; }
        this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      }
    }
    this.hoverPreview = this.o.preview?.(this.mouse.x, this.mouse.z) ?? null;
    const hit = this.o.roads.nearest(this.mouse.x, this.mouse.z, 40);
    this.hoverStreet = hit ? (this.o.graph.edges[hit.edge].name ?? '') : '';
    this.dirty = true;
  };
  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = 0;
    const d = this.down;
    if (d && e.type === 'pointerup' && e.button === 0 && !d.moved && performance.now() - d.t < 600) {
      const w = this.toWorld(e.offsetX, e.offsetY);
      this.down = null;
      this.flash = { x: w.x, z: w.z, t: 0 };
      this.toggle(false);
      this.o.onTravel(w.x, w.z);
      return;
    }
    if (this.pointers.size === 0) this.down = null;
  };
  private rightClick(sx: number, sy: number): void {
    const w = this.toWorld(sx, sy);
    if (this.waypoint && Math.hypot(this.waypoint.x - w.x, this.waypoint.z - w.z) < 14 / this.s) this.setWaypoint(null);
    else this.setWaypoint(w);
  }

  // ---------------------------------------------------------------- данные
  private ensureLoaded(): Promise<void> {
    if (this.loading) return this.loading;
    const base = this.o.mapBase ?? '/world-map/';
    const j = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    this.loading = (async () => {
      const [meta, labels, places, lm, rail] = await Promise.all([
        j(base + 'meta.json'), j(base + 'labels.json'), j('/assets/gta/places.json'), j('/assets/landmarks/landmarks.json'), j(this.o.worldBase + 'rail/net.json'),
      ]);
      if (!meta) { this.msg.style.display = 'block'; this.msg.textContent = 'Карта не построена.\n(cd pipeline && uv run python build_map.py)'; this.msg.style.whiteSpace = 'pre'; return; }
      this.meta = meta as MapMeta;
      if (!this.meta.layers.sat) this.layerBtns.sat.style.display = 'none';
      this.setLayer('scheme');
      this.districts = (labels?.labels ?? []) as typeof this.districts;
      const P: Poi[] = [];
      for (const l of LANDMARKS) P.push({ x: l.x, z: l.z, letter: l.letter, name: l.letter === 'К' ? 'Рязанский кремль' : 'Театральная площадь', color: '#ffd23f', minScale: 0 });
      const LET: Record<string, string> = { drama_theatre: 'Д', circus: 'Ц', lenin_monument: 'Л', astrakhan_bridge: 'М', lybed_skatepark: 'С' };
      const SHORT: Record<string, string> = { drama_theatre: 'Драмтеатр', circus: 'Цирк', lenin_monument: 'Памятник Ленину', astrakhan_bridge: 'Астраханский мост', lybed_skatepark: 'Скейтпарк' };
      for (const l of (lm?.landmarks ?? []) as { id: string; name: string; x: number; z: number }[]) {
        P.push({ x: l.x, z: l.z, letter: LET[l.id] ?? l.name[0], name: SHORT[l.id] ?? l.name.replace(/\s*\(.*$/, ''), color: '#ffd23f', minScale: 0.12 });
      }
      for (const sp of this.o.spawns) if (sp.name) P.push({ x: sp.x, z: sp.z, letter: '★', name: sp.name, color: '#8fe3ff', minScale: 0 });
      // станции: из stations и платформ (название → среднее положение)
      const st = new Map<string, { x: number; z: number; n: number }>();
      for (const s of (rail?.stations ?? []) as { name: string; x: number; z: number; inWorld?: boolean }[]) if (s.inWorld !== false) st.set(s.name, { x: s.x, z: s.z, n: 1 });
      for (const p of (rail?.platforms ?? []) as { station?: string; x: number; z: number }[]) {
        if (!p.station || st.has(p.station)) continue;
        const a = st.get(p.station + '#') ?? { x: 0, z: 0, n: 0 };
        a.x += p.x; a.z += p.z; a.n++; st.set(p.station + '#', a);
      }
      for (const [name, a] of st) P.push({ x: a.x / a.n, z: a.z / a.n, letter: 'Ж', name: name.replace(/#$/, ''), color: '#ff9a4a', minScale: 0.08, round: false });
      for (const p of (places?.places ?? []) as { type: string; name: string; x: number; z: number }[]) {
        if (p.type === 'police') P.push({ x: p.x, z: p.z, letter: 'П', name: p.name || 'Отдел полиции', color: '#4f8cff', minScale: 0.2 });
        else if (p.type === 'hospital') P.push({ x: p.x, z: p.z, letter: '+', name: p.name || 'Больница', color: '#ff5a5a', minScale: 0.3 });
      }
      this.pois = P;
      this.dirty = true;
    })();
    return this.loading;
  }

  private tile(layer: string, z: number, tx: number, ty: number): HTMLImageElement | null {
    const key = `${layer}/${z}/${tx}_${ty}`;
    const c = this.tiles.get(key);
    if (c === 'x') return null;
    if (c) return c.complete && c.naturalWidth ? c : null;
    if (this.tiles.size > 700) { // LRU по порядку вставки
      let n = 0;
      for (const k of this.tiles.keys()) { this.tiles.delete(k); if (++n > 200) break; }
    }
    const img = new Image();
    img.onload = () => { this.dirty = true; };
    img.onerror = () => { this.tiles.set(key, 'x'); this.dirty = true; };
    img.src = `${this.o.mapBase ?? '/world-map/'}${key}.webp`;
    this.tiles.set(key, img);
    return null;
  }

  // ---------------------------------------------------------------- рисование
  update(dt: number): void {
    if (!this.open) return;
    this.acc += dt;
    if (this.flash) { this.flash.t += dt; this.dirty = true; }
    if (!this.dirty && this.acc < 0.25) return; // метка игрока/машин обновляются 4 Гц даже без ввода
    this.acc = 0;
    this.dirty = false;
    this.draw();
  }

  private sx(x: number): number { return (x - this.cx) * this.s + this.W / 2; }
  private sy(z: number): number { return (z - this.cz) * this.s + this.H / 2; }

  private draw(): void {
    const { g, W, H, s } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#1d2127'; g.fillRect(0, 0, W, H);
    const m = this.meta;
    if (m) this.drawTiles(m);
    if (this.layer === 'sat') { g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(0, 0, W, H); }
    this.drawDistricts();
    this.drawStreetNames();
    this.drawPois();
    this.drawWaypoint();
    this.drawActors();
    if (this.hoverPreview && this.mouse) {
      const px = this.sx(this.hoverPreview.x), py = this.sy(this.hoverPreview.z);
      g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.setLineDash([3, 3]);
      g.beginPath(); g.arc(px, py, 9, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ffd23f'; g.beginPath(); g.arc(px, py, 2.5, 0, Math.PI * 2); g.fill();
    }
    if (this.flash && this.flash.t < 0.5) {
      const px = this.sx(this.flash.x), py = this.sy(this.flash.z), r = 8 + this.flash.t * 60;
      g.strokeStyle = `rgba(255,210,63,${1 - this.flash.t * 2})`; g.lineWidth = 3;
      g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.stroke();
    }
    // масштабная линейка
    const nice = [10, 20, 50, 100, 200, 500, 1000, 2000].find((n) => n * s >= 80) ?? 2000;
    const bx = W - 24 - nice * s, by = H - 22;
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(bx, by - 5); g.lineTo(bx, by); g.lineTo(bx + nice * s, by); g.lineTo(bx + nice * s, by - 5); g.stroke();
    g.fillStyle = '#fff'; g.font = '600 12px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.shadowColor = '#000'; g.shadowBlur = 3;
    g.fillText(nice >= 1000 ? `${nice / 1000} км` : `${nice} м`, bx + nice * s / 2, by - 5);
    g.shadowBlur = 0;
    // инфо под курсором
    if (this.mouse) {
      const lm = this.pois.find((p) => Math.hypot((p.x - this.mouse!.x) * s, (p.z - this.mouse!.z) * s) < 14 && s >= p.minScale);
      const where = lm ? lm.name : this.hoverStreet ? this.hoverStreet : '';
      this.info.textContent = `x ${Math.round(this.mouse.x)} · z ${Math.round(this.mouse.z)}${where ? ' · ' + where : ''}`;
      this.info.style.display = 'block';
    } else this.info.style.display = 'none';
  }

  private drawTiles(m: MapMeta): void {
    const { g, W, H, s } = this;
    const layer = this.layer;
    const ideal = 1 / (s * this.dpr);
    let lv = m.levels.length - 1;
    for (let i = 0; i < m.levels.length; i++) if (m.levels[i].res <= ideal * 1.3) { lv = i; break; }
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    const w0 = this.toWorld(0, 0), w1 = this.toWorld(W, H);
    const draw = (z: number, onlyReady = true) => {
      const L = m.levels[z], ts = m.tile * L.res;
      const x0 = Math.max(0, Math.floor((w0.x - m.minX) / ts)), x1 = Math.min(L.cols - 1, Math.floor((w1.x - m.minX) / ts));
      const y0 = Math.max(0, Math.floor((w0.z - m.minZ) / ts)), y1 = Math.min(L.rows - 1, Math.floor((w1.z - m.minZ) / ts));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) return;
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
        const img = this.tile(layer, z, tx, ty);
        if (!img && onlyReady) continue;
        if (!img) continue;
        const ax = Math.floor(this.sx(m.minX + tx * ts)), ay = Math.floor(this.sy(m.minZ + ty * ts));
        const bx = Math.ceil(this.sx(m.minX + (tx + 1) * ts)), by = Math.ceil(this.sy(m.minZ + (ty + 1) * ts));
        g.drawImage(img, ax, ay, bx - ax, by - ay);
      }
    };
    // фон: самый грубый уровень (быстро) и промежуточный, затем нужный
    draw(0);
    if (lv >= 2) draw(lv - 1);
    if (lv > 0) draw(lv);
    // граница мира
    g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 1;
    g.strokeRect(this.sx(m.minX), this.sy(m.minZ), (m.maxX - m.minX) * s, (m.maxZ - m.minZ) * s);
  }

  private drawDistricts(): void {
    const { g, s } = this;
    if (s > 0.45) return;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round';
    for (const d of this.districts) {
      const px = this.sx(d.x), py = this.sy(d.z);
      if (px < -100 || py < -30 || px > this.W + 100 || py > this.H + 30) continue;
      if (d.kind === 'park') { if (s < 0.12 && d.area < 600000) continue; g.font = 'italic 600 12px system-ui,sans-serif'; g.fillStyle = 'rgba(170,235,170,.95)'; }
      else { g.font = '700 13px system-ui,sans-serif'; g.fillStyle = 'rgba(255,255,255,.85)'; }
      g.lineWidth = 3; g.strokeStyle = this.layer === 'sat' ? 'rgba(0,0,0,.8)' : 'rgba(20,24,28,.9)';
      const t = d.kind === 'park' ? d.name : d.name.toUpperCase();
      g.strokeText(t, px, py); g.fillText(t, px, py);
    }
  }

  private drawStreetNames(): void {
    const { g, s } = this;
    if (s < HW_SCALE[0]) return;
    g.font = `600 ${s > 0.8 ? 12 : 11}px system-ui,sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.lineWidth = 3; g.strokeStyle = this.layer === 'sat' ? 'rgba(0,0,0,.85)' : 'rgba(20,24,28,.95)'; g.fillStyle = 'rgba(255,255,255,.92)';
    const placed: [number, number, number, number][] = [];
    let n = 0;
    for (const e of this.labelEdges) {
      if (s < HW_SCALE[e.hw]) continue;
      const ax = this.sx(e.ax), ay = this.sy(e.az), bx = this.sx(e.bx), by = this.sy(e.bz);
      const cx = (ax + bx) / 2, cy = (ay + by) / 2;
      if (cx < -40 || cy < -20 || cx > this.W + 40 || cy > this.H + 20) continue;
      const w = g.measureText(e.name).width;
      if (e.len * s < w + 14) continue;
      let ang = Math.atan2(by - ay, bx - ax);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      const hw = (Math.abs(Math.cos(ang)) * w + 14 * Math.abs(Math.sin(ang))) / 2 + 3, hh = (Math.abs(Math.sin(ang)) * w + 14 * Math.abs(Math.cos(ang))) / 2 + 3;
      if (placed.some(([px, py, pw, ph]) => Math.abs(px - cx) < pw + hw && Math.abs(py - cy) < ph + hh)) continue;
      placed.push([cx, cy, hw, hh]);
      g.save(); g.translate(cx, cy); g.rotate(ang);
      g.strokeText(e.name, 0, 0); g.fillText(e.name, 0, 0);
      g.restore();
      if (++n > 260) break;
    }
  }

  private pin(px: number, py: number, letter: string, color: string, r = 10, round = true): void {
    const { g } = this;
    g.fillStyle = 'rgba(20,24,28,.92)'; g.strokeStyle = color; g.lineWidth = 2;
    g.beginPath();
    if (round) g.arc(px, py, r, 0, Math.PI * 2); else g.roundRect(px - r, py - r + 1, r * 2, r * 2 - 2, 4);
    g.fill(); g.stroke();
    g.fillStyle = color; g.font = `800 ${Math.round(r * 1.2)}px system-ui,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(letter, px, py + 0.5);
  }

  private drawPois(): void {
    const { g, s } = this;
    g.lineJoin = 'round';
    const labels: [string, number, number][] = [];
    for (const p of this.pois) {
      if (s < p.minScale) continue;
      const px = this.sx(p.x), py = this.sy(p.z);
      if (px < -20 || py < -20 || px > this.W + 20 || py > this.H + 20) continue;
      this.pin(px, py, p.letter, p.color, 10, p.round !== false);
      if (s >= 0.3 || p.minScale === 0) labels.push([p.name, px, py + 22]);
    }
    g.font = '700 12px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 3.5; g.strokeStyle = this.layer === 'sat' ? 'rgba(0,0,0,.9)' : 'rgba(20,24,28,.95)'; g.fillStyle = '#fff';
    if (s >= 0.12) for (const [t, x, y] of labels) { g.strokeText(t, x, y); g.fillText(t, x, y); }
  }

  private drawWaypoint(): void {
    const w = this.waypoint;
    if (!w) return;
    const { g } = this;
    const px = this.sx(w.x), py = this.sy(w.z);
    g.fillStyle = '#35d6ff'; g.strokeStyle = '#fff'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(px, py - 12); g.lineTo(px + 9, py); g.lineTo(px, py + 12); g.lineTo(px - 9, py); g.closePath(); g.fill(); g.stroke();
  }

  private drawActors(): void {
    const { g } = this;
    const car = this.o.parkedCar();
    if (car) {
      const px = this.sx(car.x), py = this.sy(car.z);
      g.save(); g.translate(px, py); g.rotate(car.heading);
      g.fillStyle = '#ffd23f'; g.strokeStyle = '#000'; g.lineWidth = 1.5;
      g.beginPath(); g.roundRect(-5, -9, 10, 18, 3); g.fill(); g.stroke();
      g.fillStyle = '#000'; g.fillRect(-3.5, -6, 7, 4);
      g.restore();
      g.font = '700 11px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.9)'; g.fillStyle = '#ffd23f';
      g.strokeText('машина', px, py + 17); g.fillText('машина', px, py + 17);
    }
    const p = this.o.player();
    const px = this.sx(p.x), py = this.sy(p.z);
    g.save(); g.translate(px, py); g.rotate(p.heading);
    g.fillStyle = '#ff5a3c'; g.strokeStyle = '#fff'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -13); g.lineTo(9, 10); g.lineTo(0, 5); g.lineTo(-9, 10); g.closePath(); g.fill(); g.stroke();
    g.restore();
  }

  dispose(): void { this.root.remove(); }
}
