import { applyHandlingPreset, defaultVehicleConfig, handlingState, type VehicleConfig } from './config';

/**
 * Конфиги физики для любых машин, которые может взять игрок (GTA-режим, docs/stage3/gta-mode.md): из конфига Largus
 * масштабированием по массе (пружины, демпферы, тормоза, моменты помощи — пропорционально массе/инерции), с
 * поправками класса: мощность на тонну, коробка, аэродинамика, руль. Размеры и колёса — из модели.
 */

export type VehicleClass = 'car' | 'police' | 'suv' | 'van' | 'bus' | 'trolleybus';

/** Вид машины трафика / парковки → класс. */
export function classOfKind(kind: string): VehicleClass {
  switch (kind) {
    case 'police': return 'police';
    case 'suv': return 'suv';
    case 'gazelle': return 'van';
    case 'paz': case 'liaz': return 'bus';
    case 'trolleybus': return 'trolleybus';
    default: return 'car';
  }
}

const MASS: Record<string, number> = {
  sedan: 1250, hatch: 1150, wagon: 1300, taxi: 1250, police: 1350, suv: 1800, gazelle: 2700, paz: 6500, liaz: 10500, trolleybus: 11000, largus: 1300,
};

export interface ModelGeom { length: number; width: number; height: number; wheelbase: number; track: number; wheelRadius: number }

export function vehicleConfigFor(kind: string, g: ModelGeom): VehicleConfig {
  // та же модель управляемости и тот же пресет, что у машины игрока (docs/stage3/handling.md); помощники заданы
  // угловыми ускорениями и сами масштабируются инерцией — по массе масштабируются только силы (пружины, тормоза)
  const cfg = applyHandlingPreset(defaultVehicleConfig(), handlingState.preset);
  const cls = classOfKind(kind);
  const m = MASS[kind] ?? 1300;
  const k = m / cfg.chassis.mass;
  const c = cfg.chassis, s = cfg.suspension, t = cfg.tires, e = cfg.engine, a = cfg.assist, d = cfg.drift, st = cfg.stability;
  Object.assign(c, { mass: m, length: g.length, width: g.width, height: g.height, wheelbase: g.wheelbase, track: g.track });
  const rK = g.wheelRadius / s.wheelRadius;
  s.wheelRadius = g.wheelRadius;
  s.stiffness *= k; s.damping *= k; s.antiRoll *= k;
  t.brakeForce *= k; t.handbrakeForce *= k;
  e.finalDrive *= rK;
  const grip = (f: number) => { t.gripFront *= f; t.gripRear *= f; };
  let pw = 0.9;
  switch (cls) {
    case 'car': c.comHeight = 0.52; break;
    case 'police': pw = 1.15; c.comHeight = 0.5; grip(1.05); break;
    case 'suv':
      // выше ЦМ и рычаг шин — заметный крен, но стабилизация не даёт перевернуться
      pw = 1.0; s.restLength = 0.36; s.travel = 0.26; c.comHeight = 0.68; t.forceLever = Math.min(1, t.forceLever * 1.35); grip(0.94);
      c.rollInertiaScale = 2.4; cfg.aero.dragCdA = 0.9; st.rollStart = 6;
      break;
    case 'van':
      pw = 0.6; c.comHeight = 0.8; grip(0.88); t.forceLever = Math.min(1, t.forceLever * 1.3); cfg.aero.dragCdA = 1.2; c.rollInertiaScale = 2.6;
      cfg.nitro.extraForce *= 0.5; s.restLength = 0.34; d.rearGrip = 0.75; d.maxAngle = 35;
      break;
    case 'bus': case 'trolleybus': {
      // тяжёлые и устойчивые: низкое сцепление, медленный руль, без дрифта
      pw = cls === 'bus' ? 0.3 : 0.38;
      c.comHeight = cls === 'bus' ? 1.05 : 1.1; grip(0.78); t.brakeForce *= 0.7; t.handbrakeRearGrip = 0.85; t.forceLever = 0.25;
      s.restLength = 0.4; s.travel = 0.25;
      cfg.aero.dragCdA = 2.6; cfg.aero.downforce = 0;
      cfg.nitro.extraForce = 0; cfg.nitro.forceMul = 1;
      c.rollInertiaScale = 3;
      Object.assign(cfg.steering, { maxAngle: 40, minAngle: 9, speedForMin: 22, response: 4, responseHighSpeed: 3, returnResponse: 6 });
      a.counterSteer = 1.2; a.yawGain = 4; a.yawAccelMax = 2; a.slipLimit = 8;
      d.enabled = 0;
      if (cls === 'bus') {
        Object.assign(e, { idleRpm: 600, redlineRpm: 2800, gearRatios: [5.0, 3.0, 1.9, 1.3, 1.0], reverseRatio: 5, finalDrive: 6.6 * (g.wheelRadius / 0.5),
          shiftUpRpm: 2500, shiftDownRpm: 1200, shiftUpEcoRpm: 1600, shiftDownEcoRpm: 800, shiftTime: 0.35,
          torqueCurve: [[0, 0.7], [600, 0.8], [1200, 1.0], [2000, 0.95], [2800, 0.7], [3200, 0.4]] });
      } else {
        // троллейбус: электромотор, одна ступень, тяга с места
        Object.assign(e, { idleRpm: 0, redlineRpm: 3000, gearRatios: [1.0], reverseRatio: 1, finalDrive: 8.1 * (g.wheelRadius / 0.5),
          shiftUpRpm: 9999, shiftDownRpm: 0, shiftUpEcoRpm: 9999, shiftDownEcoRpm: 0, shiftTime: 0,
          torqueCurve: [[0, 1], [1500, 1], [2500, 0.8], [3000, 0.5], [3400, 0.2]] });
      }
      break;
    }
  }
  e.peakTorque = 340 * k * pw;
  return cfg;
}
