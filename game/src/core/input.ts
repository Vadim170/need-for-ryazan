import { clamp } from './time';

/** Normalised driver input. steer: -1 left .. +1 right. */
export interface DriveInput {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1..1
  handbrake: boolean;
  nitro: boolean;
}

/** Keyboard + Gamepad API input. Call update(dt) once per frame. */
export class Input {
  readonly state: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };
  lookBack = false;
  gamepadActive = false;
  /** Активный геймпад этого кадра (GTA-режим: пешком читает стики/кнопки сам). */
  pad: Gamepad | null = null;
  private padPrev: boolean[] = [];
  /** One-shot actions, consumed with consume(). */
  private pressed = new Set<string>();
  private keys = new Set<string>();
  private steerKb = 0;
  private onFirstGesture: (() => void)[] = [];

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
      this.gesture();
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('pointerdown', () => this.gesture());
    window.addEventListener('gamepadconnected', () => this.gesture());
  }

  /** Register callback fired once on first user interaction (for AudioContext). */
  onGesture(cb: () => void): void {
    this.onFirstGesture.push(cb);
  }
  private gesture() {
    for (const cb of this.onFirstGesture) cb();
    this.onFirstGesture.length = 0;
  }

  private down(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  /** Клавиша зажата (GTA-режим: управление пешком). */
  isDown(code: string): boolean { return this.keys.has(code); }

  /** Кнопка геймпада нажата в этом кадре (фронт). */
  padPressed(i: number): boolean { return !!this.pad?.buttons[i]?.pressed && !this.padPrev[i]; }

  /** Сбросить накопленные одиночные нажатия (пока игра на паузе под картой). */
  flush(): void { this.pressed.clear(); }

  /** True once per key press. */
  consume(code: string): boolean {
    return this.pressed.delete(code);
  }

  update(dt: number): void {
    const s = this.state;
    // keyboard
    const target = (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
    // ramp the keyboard steering so it is not binary; return to centre faster
    const rate = target === 0 || Math.sign(target) !== Math.sign(this.steerKb) ? 8 : 4.5;
    this.steerKb += clamp(target - this.steerKb, -rate * dt, rate * dt);
    let steer = this.steerKb;
    let throttle = this.down('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = this.down('KeyS', 'ArrowDown') ? 1 : 0;
    let handbrake = this.down('Space');
    let nitro = this.down('ShiftLeft', 'ShiftRight');
    this.lookBack = this.down('KeyC');

    // gamepad (standard mapping)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected);
    this.gamepadActive = !!pad;
    if (this.pad) this.padPrev = this.pad.buttons.map((b) => b.pressed);
    this.pad = pad ?? null;
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      const ax = dz(pad.axes[0] ?? 0);
      if (ax !== 0) steer = Math.sign(ax) * Math.pow(Math.abs(ax), 1.4);
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      throttle = Math.max(throttle, rt);
      brake = Math.max(brake, lt);
      handbrake ||= !!pad.buttons[0]?.pressed || !!pad.buttons[1]?.pressed; // A / B
      nitro ||= !!pad.buttons[2]?.pressed || !!pad.buttons[5]?.pressed; // X / RB
      if (this.padPressed(8)) this.pressed.add('KeyR'); // Back/View = сброс (Y — сесть/выйти из машины, GTA-режим)
      this.lookBack ||= !!pad.buttons[4]?.pressed; // LB
    }
    s.steer = clamp(steer, -1, 1);
    s.throttle = throttle;
    s.brake = brake;
    s.handbrake = handbrake;
    s.nitro = nitro;
  }
}
