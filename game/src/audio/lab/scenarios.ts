/**
 * Scripted test drives for the audio lab: the real Vehicle (physics + automatic gearbox) on a flat ground plane,
 * driven by scripted inputs; records telemetry at the physics rate (60 Hz) for offline audio rendering.
 */
import * as THREE from 'three';
import { PhysicsWorld, RAPIER } from '../../physics/world';
import { Vehicle } from '../../vehicle/vehicle';
import { defaultVehicleConfig } from '../../vehicle/config';
import type { DriveInput } from '../../core/input';

export interface TelemetryFrame {
  t: number;
  rpm: number; throttle: number; load: number; gear: number;
  speed: number; forwardSpeed: number; nitro: boolean; skid: number; handbrake: boolean; drifting: boolean;
  slipAngle: number; grounded: number; impact: number; bump: number; brake: number;
}

type Driver = (t: number, car: Vehicle, dt: number) => Partial<DriveInput> & { done?: boolean };

const kmh = (v: number) => v * 3.6;

/** Simple speed controller (P + feed-forward) producing analog throttle/brake. */
function cruiseTo(target: number, car: Vehicle, maxThr = 0.5): Partial<DriveInput> {
  const e = target - kmh(car.forwardSpeed);
  if (e > 0) return { throttle: Math.min(maxThr, 0.12 + e * 0.06), brake: 0 };
  if (e < -4) return { throttle: 0, brake: Math.min(0.6, -e * 0.05) };
  return { throttle: Math.max(0, 0.1 + e * 0.03), brake: 0 };
}

/** Keyboard-style (binary) speed holding: tap W when below target (the way most players crawl). */
function keyTapTo(target: number, car: Vehicle, state: { on: boolean }): Partial<DriveInput> {
  const v = kmh(car.forwardSpeed);
  if (state.on && v > target + 1.5) state.on = false;
  else if (!state.on && v < target - 2.5) state.on = true;
  return { throttle: state.on ? 1 : 0, brake: v > target + 8 ? 1 : 0 };
}

export interface Scenario { name: string; title: string; duration: number; driver: () => Driver; env?: string }

export const SCENARIOS: Scenario[] = [
  {
    name: 'drive',
    title: 'Холостой → газ в пол 1–4 передачи (нитро 6–9.5 с разгона) → сброс (хлопки) → круиз → торможение',
    duration: 38,
    driver: () => {
      let phase = 0, tPhase = 0;
      return (t, car) => {
        tPhase += 1 / 60;
        if (phase === 0) { if (t > 3) { phase = 1; tPhase = 0; } return { throttle: 0 }; }
        if (phase === 1) { if (car.gear >= 5 || tPhase > 16) { phase = 2; tPhase = 0; } return { throttle: 1, nitro: tPhase > 6 && tPhase < 9.5 }; }
        if (phase === 2) { if (tPhase > 3.5) { phase = 3; tPhase = 0; } return { throttle: 0 }; }
        if (phase === 3) { if (tPhase > 7) { phase = 4; tPhase = 0; } return cruiseTo(80, car, 0.45); }
        if (phase === 4) { if (car.speed < 0.3 && tPhase > 1) { phase = 5; tPhase = 0; } return { throttle: 0, brake: 0.55 }; }
        return { throttle: 0, brake: 0.2, done: tPhase > 2.5 };
      };
    },
  },
  {
    name: 'lowspeed',
    title: 'Холостой 5 с → плавное трогание → 10–25 км/ч с малым газом → стоп → задний ход',
    duration: 42,
    driver: () => {
      let phase = 0, tPhase = 0;
      return (t, car) => {
        tPhase += 1 / 60;
        if (phase === 0) { if (t > 5) { phase = 1; tPhase = 0; } return { throttle: 0 }; }
        if (phase === 1) { // gentle pull-away: throttle ramps to 0.25
          if (tPhase > 3) { phase = 2; tPhase = 0; }
          return { throttle: Math.min(0.25, tPhase * 0.12) };
        }
        if (phase === 2) { // crawl: 15 → 25 → 12 → 20 km/h
          const tgt = tPhase < 5 ? 15 : tPhase < 10 ? 25 : tPhase < 15 ? 12 : 20;
          if (tPhase > 19) { phase = 3; tPhase = 0; }
          return cruiseTo(tgt, car, 0.35);
        }
        if (phase === 3) { if (car.speed < 0.2 && tPhase > 0.5) { phase = 4; tPhase = 0; } return { throttle: 0, brake: 0.4 }; }
        if (phase === 4) { if (tPhase > 1.5) { phase = 5; tPhase = 0; } return { throttle: 0, brake: 0 }; }
        if (phase === 5) { // reverse: S held (brake input = reverse drive)
          if (tPhase > 4.5) { phase = 6; tPhase = 0; }
          return { throttle: 0, brake: tPhase < 0.3 ? 1 : 0.45 };
        }
        if (phase === 6) { if (car.speed < 0.2 && tPhase > 0.6) { phase = 7; tPhase = 0; } return { throttle: 0.6, brake: 0 }; }
        return { throttle: 0, brake: 0, done: tPhase > 2.5 };
      };
    },
  },
  {
    name: 'lowspeed_keys',
    title: 'Как с клавиатуры: холостой → трогание с W → 15–25 км/ч «постукиванием» W → стоп',
    duration: 34,
    driver: () => {
      let phase = 0, tPhase = 0;
      const st = { on: false };
      return (t, car) => {
        tPhase += 1 / 60;
        if (phase === 0) { if (t > 3) { phase = 1; tPhase = 0; } return { throttle: 0 }; }
        if (phase === 1) {
          const tgt = tPhase < 8 ? 15 : tPhase < 16 ? 25 : 18;
          if (tPhase > 24) { phase = 2; tPhase = 0; }
          return keyTapTo(tgt, car, st);
        }
        if (phase === 2) { if (car.speed < 0.6 && tPhase > 0.5) { phase = 3; tPhase = 0; } return { throttle: 0, brake: 1 }; }
        return { throttle: 0, brake: 0, done: tPhase > 3 };
      };
    },
  },
  {
    name: 'nitro_long',
    title: 'Газ в пол + нитро зажато 25 с до максималки на прямой (на высшей передаче), затем сброс',
    duration: 34,
    driver: () => (t) => (t < 2 ? { throttle: 0 } : t < 29 ? { throttle: 1, nitro: t > 4 } : { throttle: 0, done: t > 33 }),
  },
  {
    name: 'crash',
    title: 'Разгон ~60 км/ч → удар в стену → откат, холостой',
    duration: 10,
    driver: () => (t) => (t < 5.5 ? { throttle: 1 } : { throttle: 0, brake: 0, done: t > 9 }),
  },
  {
    name: 'drift',
    title: 'Разгон → ручник/занос (визг шин) → торможение',
    duration: 16,
    driver: () => {
      let tPhase = 0;
      return (t, car) => {
        tPhase += 1 / 60;
        void car;
        if (t < 5) return { throttle: 1 };
        if (t < 6.2) return { throttle: 0.6, steer: 1, handbrake: true };
        if (t < 9) return { throttle: 1, steer: -0.6 };
        if (t < 10) return { throttle: 0, brake: car.speed > 1 ? 1 : 0, steer: 0.3 };
        return { throttle: 0, brake: 0, done: tPhase > 13 };
      };
    },
  },
];

/** Run the vehicle through a scenario; returns telemetry at 60 Hz (t starts at 0 after a settle period). */
export async function simulate(sc: Scenario): Promise<TelemetryFrame[]> {
  const physics = await PhysicsWorld.create();
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setFriction(1));
  // a wall far ahead on the drift scenario's path (impact test)
  if (sc.name === 'crash') physics.world.createCollider(RAPIER.ColliderDesc.cuboid(30, 3, 1).setTranslation(0, 3, -45));
  const cfg = defaultVehicleConfig();
  const car = new Vehicle(physics, cfg, new THREE.Vector3(0, 1.0, 0));
  const dt = 1 / 60;
  for (let i = 0; i < 90; i++) physics.update(dt); // settle on the suspension
  const drive = sc.driver();
  const out: TelemetryFrame[] = [];
  let prevV = new THREE.Vector3();
  const lv0 = car.body.linvel();
  prevV.set(lv0.x, lv0.y, lv0.z);
  for (let i = 0; i < sc.duration * 60; i++) {
    const t = i * dt;
    const inp = drive(t, car, dt);
    Object.assign(car.input, { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false }, inp);
    physics.update(dt);
    const lv = car.body.linvel();
    const v = new THREE.Vector3(lv.x, lv.y, lv.z);
    const dvv = v.clone().sub(prevV);
    const dv = dvv.length();
    const bump = Math.abs(dvv.y) > 0.6 && car.groundedWheels >= 2 ? Math.abs(dvv.y) * 1.5 : 0;
    prevV = v;
    out.push({
      t, rpm: car.rpm, throttle: car.throttleOut, load: car.engineLoad, gear: car.gear,
      speed: car.speed, forwardSpeed: car.forwardSpeed, nitro: car.nitroActive, skid: car.skid,
      handbrake: !!car.input.handbrake, drifting: car.drifting, slipAngle: car.slipAngle, grounded: car.groundedWheels,
      impact: dv > 1.5 ? dv : 0, bump, brake: car.input.brake,
    });
    if (inp.done) break;
  }
  return out;
}
