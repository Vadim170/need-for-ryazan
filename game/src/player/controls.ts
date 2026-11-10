import type { Input } from '../core/input';

/**
 * Управление пешком (GTA-режим): клавиатура + мышь (pointer lock по клику на канвас) + геймпад (стандартная раскладка).
 * Пешком: WASD — идти (относительно камеры), Shift — бег/спринт, Alt — шагом, Пробел — прыжок, ЛКМ — удар/выстрел,
 * ПКМ — прицел, V — пинок, R — перезарядка, колесо/Q/1–4 — оружие, Tab (удерживать) — колесо оружия, F (или Y) — сесть
 * в машину / угнать / выйти, E — ограбить / открыть багажник ДПС, G — сирена (в машине ДПС).
 * Геймпад: левый стик — идти, правый — камера, A — прыжок, X — бег (удерживать), B — удар, RT — огонь, LT — прицел,
 * Y — машина, LB/RB — оружие, крестовина вниз — пинок, вверх — ограбить/багажник, R3 — сирена.
 */
export interface FootControls {
  mx: number; my: number;
  sprint: boolean; walk: boolean;
  jump: boolean;
  fire: boolean; firePressed: boolean;
  aim: boolean;
  punch: boolean;
  kick: boolean;
  enter: boolean;
  interact: boolean;
  reload: boolean;
  weaponDelta: number;
  weaponSelect: number;
  wheel: boolean;
  lookX: number; lookY: number;
  siren: boolean;
}

export function emptyControls(): FootControls {
  return { mx: 0, my: 0, sprint: false, walk: false, jump: false, fire: false, firePressed: false, aim: false, punch: false, kick: false,
    enter: false, interact: false, reload: false, weaponDelta: 0, weaponSelect: -1, wheel: false, lookX: 0, lookY: 0, siren: false };
}

export class ControlReader {
  readonly c: FootControls = emptyControls();
  /** Внешнее управление (тесты, window.__game.gta.ctl): поля перекрывают ввод на один кадр (one-shot сбрасываются). */
  override: Partial<FootControls> | null = null;
  private mdx = 0; private mdy = 0;
  private lmb = false; private rmb = false; private lmbEdge = false;
  private wheelD = 0;
  locked = false;
  /** Включено (GTA-режим). */
  enabled = true;

  constructor(private input: Input, canvas: HTMLCanvasElement) {
    canvas.addEventListener('click', () => { if (this.enabled && document.pointerLockElement !== canvas) canvas.requestPointerLock?.(); });
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === canvas; if (!this.locked) { this.lmb = false; this.rmb = false; } });
    document.addEventListener('mousemove', (e) => { if (this.locked) { this.mdx += e.movementX; this.mdy += e.movementY; } });
    window.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.lmb = true; this.lmbEdge = true; }
      if (e.button === 2) this.rmb = true;
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.lmb = false; if (e.button === 2) this.rmb = false; });
    window.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });
    window.addEventListener('wheel', (e) => { if (this.locked) this.wheelD += Math.sign(e.deltaY); }, { passive: true });
    window.addEventListener('keydown', (e) => { if (this.enabled && (e.code === 'Tab' || e.code === 'AltLeft')) e.preventDefault(); });
  }

  /** Вызвать раз в кадр после input.update(). */
  read(dt: number): FootControls {
    const I = this.input, c = this.c, pad = I.pad;
    const k = (code: string) => I.isDown(code);
    let mx = (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0);
    let my = (k('KeyW') ? 1 : 0) - (k('KeyS') ? 1 : 0);
    let lookX = this.mdx, lookY = this.mdy;
    this.mdx = 0; this.mdy = 0;
    c.sprint = k('ShiftLeft') || k('ShiftRight');
    c.walk = k('AltLeft');
    c.jump = I.consume('Space');
    c.firePressed = this.lmbEdge; this.lmbEdge = false;
    c.fire = this.lmb;
    c.aim = this.rmb;
    c.punch = false;
    c.kick = I.consume('KeyV');
    c.enter = I.consume('KeyF');
    c.interact = I.consume('KeyE');
    c.reload = false; // R — в main (сброс машины / перезарядка пешком)
    c.weaponDelta = this.wheelD + (I.consume('KeyQ') ? -1 : 0);
    this.wheelD = 0;
    c.weaponSelect = I.consume('Digit1') ? 0 : I.consume('Digit2') ? 1 : I.consume('Digit3') ? 2 : I.consume('Digit4') ? 3 : -1;
    c.wheel = k('Tab');
    c.siren = I.consume('KeyG');
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
      const lx = dz(pad.axes[0] ?? 0), ly = dz(pad.axes[1] ?? 0), rx = dz(pad.axes[2] ?? 0), ry = dz(pad.axes[3] ?? 0);
      if (lx || ly) { mx = lx; my = -ly; }
      lookX += rx * Math.abs(rx) * 900 * dt; lookY += ry * Math.abs(ry) * 650 * dt;
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      c.sprint ||= b(2);
      if (I.padPressed(0)) c.jump = true;
      if (I.padPressed(1)) c.punch = true;
      c.fire ||= (pad.buttons[7]?.value ?? 0) > 0.4;
      if (I.padPressed(7)) c.firePressed = true;
      c.aim ||= (pad.buttons[6]?.value ?? 0) > 0.4;
      if (I.padPressed(3)) c.enter = true;
      if (I.padPressed(12)) c.interact = true;
      if (I.padPressed(13)) c.kick = true;
      if (I.padPressed(4)) c.weaponDelta -= 1;
      if (I.padPressed(5)) c.weaponDelta += 1;
      if (I.padPressed(11)) c.siren = true;
    }
    c.mx = mx; c.my = my; c.lookX = lookX; c.lookY = lookY;
    if (this.override) {
      Object.assign(c, this.override);
      // одноразовые нажатия — сбросить
      for (const key of ['jump', 'firePressed', 'punch', 'kick', 'enter', 'interact', 'reload', 'siren'] as const) if (this.override[key]) delete this.override[key];
      if (this.override.weaponDelta) delete this.override.weaponDelta;
      if (this.override.weaponSelect !== undefined) delete this.override.weaponSelect;
    }
    return c;
  }
}
