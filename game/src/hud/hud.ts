import type { Vehicle } from '../vehicle/vehicle';

/** Minimal DOM HUD (elements live in index.html). */
export class Hud {
  private el = (id: string) => document.getElementById(id)!;
  private speed = this.el('hud-speed');
  private gear = this.el('hud-gear');
  private rpm = this.el('hud-rpm');
  private rpmBar = this.el('hud-rpm-bar');
  private nitroBar = this.el('hud-nitro-bar');
  private flag = this.el('hud-flag');

  update(car: Vehicle, redline: number): void {
    this.speed.textContent = String(Math.round(car.speed * 3.6));
    this.gear.textContent = car.gear < 0 ? 'R' : String(car.gear);
    this.rpm.textContent = String(Math.round(car.rpm / 10) * 10);
    this.rpmBar.style.width = `${Math.min(100, (car.rpm / (redline + 400)) * 100)}%`;
    this.nitroBar.style.width = `${car.nitroFuel * 100}%`;
    this.flag.textContent = car.nitroActive ? 'NITRO' : car.drifting ? 'DRIFT' : '';
  }
}
