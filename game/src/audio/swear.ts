/**
 * Ругань пешеходов (assets/scripts/audio/build_swear.py → /assets/audio/swear/): позиционные реплики, слышно только
 * вблизи (линейное затухание до MAX_DIST) и громче, если человек кричит в сторону слушателя (конус направленности
 * по взгляду). Мужские/пожилые голоса — тот же синтез с playbackRate < 1. Выключается ?swear=0.
 */
export type SwearWho = 'man' | 'woman' | 'elder_m' | 'elder_w' | 'kid';
export type SwearKind = 'miss' | 'hit' | 'rob' | 'bump';

interface Line { id: string; file: string; who: SwearWho; kind: SwearKind; rate: number }

const BASE = '/assets/audio/swear/';
const MAX_DIST = 22; // м: дальше не слышно
const PERSON_COOLDOWN = 7; // с между репликами одного человека
const MAX_VOICES = 2; // одновременно

export class SwearVoices {
  enabled = new URLSearchParams(location.search).get('swear') !== '0';
  private lines: Line[] = [];
  private buffers = new Map<string, AudioBuffer>();
  private last = new Map<number, number>();
  private active = 0;
  private lastPicked = new Map<string, string>();
  private loading: Promise<void> | null = null;

  constructor(private readonly ctx: AudioContext, private readonly out: AudioNode) {}

  private load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const m = (await (await fetch(BASE + 'swear.json')).json()) as { lines: Line[] };
        this.lines = m.lines;
        await Promise.all(m.lines.map(async (l) => {
          try {
            this.buffers.set(l.id, await this.ctx.decodeAudioData(await (await fetch(BASE + l.file)).arrayBuffer()));
          } catch (e) { console.warn('[swear] не загрузилась реплика', l.id, e); }
        }));
      } catch (e) { console.warn('[swear] swear.json не загрузился', e); }
    })();
    return this.loading;
  }

  /**
   * Человек `agent` в точке (x,y,z) смотрит по yaw (three: вперёд = (−sin yaw, 0, −cos yaw)) и ругается.
   * listener — позиция слушателя: дальше MAX_DIST реплика даже не запускается.
   */
  shout(agent: number, who: SwearWho, kind: SwearKind, x: number, y: number, z: number, yaw: number,
    listener: { x: number; z: number }): void {
    if (!this.enabled) return;
    if (!this.lines.length) { void this.load(); return; }
    const t = this.ctx.currentTime;
    if (Math.hypot(x - listener.x, z - listener.z) > MAX_DIST) return;
    if (this.active >= MAX_VOICES || t - (this.last.get(agent) ?? -1e9) < PERSON_COOLDOWN) return;
    let pool = this.lines.filter((l) => l.who === who && l.kind === kind && this.buffers.has(l.id));
    if (!pool.length) pool = this.lines.filter((l) => l.who === who && this.buffers.has(l.id));
    if (!pool.length) return;
    const prev = this.lastPicked.get(who + kind);
    if (pool.length > 1) pool = pool.filter((l) => l.id !== prev); // не повторять подряд одну фразу
    const line = pool[Math.floor(Math.random() * pool.length)];
    this.lastPicked.set(who + kind, line.id);
    this.last.set(agent, t);
    if (this.last.size > 500) this.last.clear();

    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'linear';
    p.refDistance = 1.5;
    p.maxDistance = MAX_DIST;
    p.rolloffFactor = 1;
    // направленность: громко спереди, сзади ~30%
    p.coneInnerAngle = 110;
    p.coneOuterAngle = 260;
    p.coneOuterGain = 0.3;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    if (p.positionX) {
      p.positionX.setValueAtTime(x, t); p.positionY.setValueAtTime(y + 1.6, t); p.positionZ.setValueAtTime(z, t);
      p.orientationX.setValueAtTime(fx, t); p.orientationY.setValueAtTime(0, t); p.orientationZ.setValueAtTime(fz, t);
    } else {
      const lp = p as unknown as { setPosition(a: number, b: number, c: number): void; setOrientation(a: number, b: number, c: number): void };
      lp.setPosition(x, y + 1.6, z); lp.setOrientation(fx, 0, fz);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.get(line.id)!;
    src.playbackRate.value = line.rate * (0.96 + Math.random() * 0.08);
    const g = this.ctx.createGain();
    g.gain.value = 1.6; // крик: громче речи
    src.connect(g).connect(p).connect(this.out);
    this.active++;
    src.onended = () => { this.active--; src.disconnect(); g.disconnect(); p.disconnect(); };
    src.start(t + 0.05 + Math.random() * 0.25); // небольшая задержка реакции
  }
}
