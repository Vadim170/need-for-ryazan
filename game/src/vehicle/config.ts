/**
 * All arcade-car tuning in one place. Exposed live in the lil-gui panel (src/debug). SI units.
 * Модель управляемости и как её настраивать — docs/stage3/handling.md. Пресеты: applyHandlingPreset (arcade | sim-lite | drift).
 */
export interface VehicleConfig {
  chassis: {
    mass: number; length: number; width: number; height: number;
    rollInertiaScale: number; // множитель инерции по крену (больше — медленнее и спокойнее крен)
    wheelbase: number; // m, между осями (модель Largus: 2.905)
    track: number; // m, колея (между центрами шин; модель: 1.501)
    comHeight: number; // m, физический центр масс над землёй в покое (нужен reset/новая машина)
    comOffsetZ: number; // m, смещение ЦМ вдоль кузова от середины базы (+ к корме, − к носу)
  };
  suspension: {
    wheelRadius: number;
    restLength: number; // m, free length below attach point
    travel: number; // m, max compression
    stiffness: number; // N/m per wheel
    damping: number; // N*s/m per wheel
    antiRoll: number; // N/m, anti-roll bar stiffness (per axle)
    bumpStop: number; // множитель жёсткости отбойника за пределом хода
    maxForce: number; // предел силы подвески колеса, × статической нагрузки (не «выстреливает» на бордюрах)
    probes: number; // лучей на колесо вдоль окружности шины: 1 или 3 (3 — колесо «накатывается» на ступеньку)
  };
  tires: {
    gripFront: number; // friction coefficient mu (боковое)
    gripRear: number;
    longGrip: number; // множитель mu для продольных сил (тяга/тормоз)
    lateralStiffness: number; // B in simplified Pacejka, higher = sharper (пик ≈ 1.86/B рад)
    lateralPeak: number; // C shape factor (после пика сцепление падает до sin(C·π/2))
    loadSensitivity: number; // 0..0.3: перегруженное колесо держит относительно хуже (меньше переноса — стабильнее)
    forceLever: number; // 0..1: высота приложения боковых сил шин: 0 — на высоте ЦМ (нет кренящего момента), 1 — в пятне контакта
    forceLeverLong: number; // то же для продольных сил (клевок/приседание)
    rollingResistance: number; // N per N of load
    handbrakeRearGrip: number; // rear grip multiplier while handbrake is held
    brakeForce: number; // N total brake force at all wheels
    brakeBias: number; // fraction of braking on front axle
    handbrakeForce: number; // N on rear axle
    abs: number; // 0..1: ограничение тормозной силы пределом сцепления + приоритет боковой силы (рулится при торможении)
    tractionControl: number; // 0..1: ограничение тяги пределом сцепления вне дрифта
  };
  engine: {
    idleRpm: number;
    redlineRpm: number;
    peakTorque: number; // Nm at the peak of the (normalised) curve
    /** Normalised torque curve [rpm, 0..1]. */
    torqueCurve: [number, number][];
    inertiaRpmRate: number; // rpm smoothing speed (1/s)
    gearRatios: number[]; // forward 1..N
    reverseRatio: number;
    finalDrive: number;
    drivetrainEfficiency: number;
    driveFrontShare: number; // 0 = RWD, 1 = FWD, 0.5 = AWD-ish
    shiftUpRpm: number; // upshift at held full throttle
    shiftDownRpm: number; // kickdown at held full throttle
    shiftUpEcoRpm: number; // upshift at light / no throttle
    shiftDownEcoRpm: number; // downshift when coasting
    shiftTime: number; // s of torque cut during a shift
    powerScale: number; // global arcade multiplier on drive force
  };
  steering: {
    maxAngle: number; // deg at standstill
    minAngle: number; // deg at high speed
    speedForMin: number; // m/s at which minAngle reached
    response: number; // 1/s steering rate (низкая скорость)
    responseHighSpeed: number; // 1/s steering rate на скорости speedForMin и выше
    returnResponse: number; // 1/s возврат к центру
    gripLimit: number; // 0..1: руль не выворачивает передние колёса дальше пика сцепления (0 — без ограничения)
  };
  assist: {
    yawGain: number; // 1/s: регулятор угловой скорости рыскания тянет к цели «руль + скорость»
    yawAccelMax: number; // rad/s²: предел помощи регулятора
    latGripUse: number; // доля сцепления для цели рыскания (полный руль = поворот на пределе × это)
    counterSteer: number; // gain on slip angle -> steer (вне дрифта)
    counterSteerMax: number; // max steer fraction added by assist
    slipLimit: number; // deg: мягкий предел угла увода кузова вне дрифта
    slipLimitGain: number; // rad/s² на рад сверх предела
  };
  drift: {
    enabled: number; // 0/1
    minSpeed: number; // m/s: ниже — дрифт не начинается и гаснет
    rearGrip: number; // множитель бокового сцепления задней оси в дрифте
    baseAngle: number; // deg: угол дрифта без газа
    throttleAngle: number; // deg: добавка угла от газа (газ = угол)
    steerAngle: number; // deg: добавка/убавка угла рулём (в сторону поворота / контрруль)
    handbrakeAngle: number; // deg: добавка, пока зажат ручник (разворот)
    maxAngle: number; // deg: предел угла
    angleGain: number; // 1/s²: жёсткость удержания угла
    angleDamping: number; // 1/s
    accelMax: number; // rad/s²: предел момента дрифта
    exitAngle: number; // deg: угол, ниже которого дрифт заканчивается
    blendIn: number; // 1/s
    blendOut: number; // 1/s: плавный возврат сцепления задней оси (выход без «пилы»)
    brakeArmTime: number; // s: окно «тормоз + руль → газ» для входа в дрифт
    powerOverSlip: number; // deg: вход по газу, если зад уже повело на столько
    speedKeep: number; // g: тяга вдоль скорости в дрифте (дрифт не «съедает» скорость)
  };
  stability: {
    rollStart: number; // deg: крен относительно дороги, после которого включается выпрямление
    rollStiffness: number; // rad/s² на рад сверх rollStart
    rollDamping: number; // 1/s: демпфер скорости крена
    pitchDamping: number; // 1/s: демпфер тангажа
    latCutStart: number; // deg: крен, с которого режется боковая сила (скольжение вместо опрокидывания)
    latCutRange: number; // deg
    airUpright: number; // 1/s²: в воздухе — выравнивание крена/тангажа (приземление на колёса)
    airPitch: number; // 0..1: доля выравнивания по тангажу (нос следует траектории)
    airDamping: number; // 1/s
    airYawDamping: number; // 1/s
    selfRight: number; // 0/1: машина на боку/крыше на малой скорости сама встаёт на колёса
  };
  aero: { dragCdA: number; downforce: number; airDensity: number };
  nitro: {
    forceMul: number; // multiplier on drive force
    extraForce: number; // N added along the forward axis
    capacity: number; // s of nitro in a full tank
    refillRate: number; // tank fraction/s when off
    drainRate: number; // tank fraction/s when on
    minSpeed: number;
  };
}

/** Базовый (arcade) конфиг Lada Largus. */
export const defaultVehicleConfig = (): VehicleConfig => ({
  // Размеры = реальный Lada Largus (4.47 x 1.75 м, база 2.905, колея ~1.50). Колёса/кузов в largus.glb подогнаны под wheelbase/track.
  // ЦМ 0.5 м (заниженный тюнинг); раньше ЦМ фактически был в центре коробки-коллайдера, 0.8 м над землёй.
  chassis: { mass: 1300, length: 4.47, width: 1.75, height: 1.5, rollInertiaScale: 2.2, wheelbase: 2.905, track: 1.501, comHeight: 0.5, comOffsetZ: -0.05 },
  // wheelRadius = наружный радиус шины 205/45 R17 (0.308 м), как в largus.glb
  suspension: { wheelRadius: 0.308, restLength: 0.32, travel: 0.22, stiffness: 42000, damping: 3600, antiRoll: 6000, bumpStop: 6, maxForce: 5, probes: 3 },
  tires: {
    gripFront: 1.6,
    gripRear: 1.65,
    longGrip: 0.85,
    lateralStiffness: 11,
    lateralPeak: 1.45,
    loadSensitivity: 0.1,
    forceLever: 0.5,
    forceLeverLong: 0.45,
    rollingResistance: 0.012,
    handbrakeRearGrip: 0.45,
    brakeForce: 21000,
    brakeBias: 0.62,
    handbrakeForce: 3500,
    abs: 1,
    tractionControl: 0.6,
  },
  engine: {
    idleRpm: 900,
    redlineRpm: 6800,
    peakTorque: 340,
    torqueCurve: [
      [0, 0.45], [900, 0.55], [2000, 0.78], [3500, 0.95], [4800, 1.0], [5800, 0.92], [6800, 0.78], [7500, 0.5],
    ],
    inertiaRpmRate: 14,
    gearRatios: [3.8, 2.4, 1.75, 1.35, 1.08, 0.88],
    reverseRatio: 3.6,
    finalDrive: 3.45, // = 3.7 * 0.308/0.33: передаточное по скорости как до смены радиуса колеса
    drivetrainEfficiency: 0.88,
    driveFrontShare: 0,
    shiftUpRpm: 6300,
    shiftDownRpm: 2600,
    shiftUpEcoRpm: 2300,
    shiftDownEcoRpm: 1250,
    shiftTime: 0.18,
    powerScale: 1.0,
  },
  steering: { maxAngle: 34, minAngle: 5, speedForMin: 50, response: 10, responseHighSpeed: 6, returnResponse: 12, gripLimit: 1 },
  assist: { yawGain: 7, yawAccelMax: 5, latGripUse: 0.95, counterSteer: 1.5, counterSteerMax: 0.5, slipLimit: 12, slipLimitGain: 12 },
  drift: {
    enabled: 1, minSpeed: 8, rearGrip: 0.62, baseAngle: 20, throttleAngle: 14, steerAngle: 10, handbrakeAngle: 30, maxAngle: 55,
    angleGain: 10, angleDamping: 4.5, accelMax: 6, exitAngle: 7, blendIn: 6, blendOut: 2.5, brakeArmTime: 0.6, powerOverSlip: 12, speedKeep: 0.25,
  },
  stability: {
    rollStart: 5, rollStiffness: 30, rollDamping: 4, pitchDamping: 2, latCutStart: 12, latCutRange: 16,
    airUpright: 10, airPitch: 0.6, airDamping: 3, airYawDamping: 0.8, selfRight: 1,
  },
  aero: { dragCdA: 0.72, downforce: 2.2, airDensity: 1.2 },
  nitro: { forceMul: 1.35, extraForce: 4500, capacity: 4, refillRate: 0.08, drainRate: 0.25, minSpeed: 0 },
});

/* ------------------------------------------------------------------ пресеты ------------------------------------------------------------------ */

export type HandlingPreset = 'arcade' | 'sim-lite' | 'drift';
export const HANDLING_PRESETS: HandlingPreset[] = ['arcade', 'sim-lite', 'drift'];
type Overrides = { [S in keyof VehicleConfig]?: Partial<VehicleConfig[S]> };

/** Отличия пресетов от базового arcade (только «ощущение»: шины, руль, помощники, дрифт, стабилизация). */
const PRESETS: Record<HandlingPreset, Overrides> = {
  arcade: {},
  'sim-lite': {
    chassis: { comHeight: 0.52 },
    suspension: { antiRoll: 12000 },
    tires: { gripFront: 1.2, gripRear: 1.22, longGrip: 0.9, forceLever: 0.65, forceLeverLong: 0.8, loadSensitivity: 0.12, handbrakeRearGrip: 0.5, tractionControl: 0.2 },
    steering: { response: 8, responseHighSpeed: 4.5, returnResponse: 9, gripLimit: 0.6 },
    assist: { yawGain: 2, yawAccelMax: 1.5, counterSteer: 0.6, counterSteerMax: 0.3, slipLimit: 20, slipLimitGain: 4 },
    drift: { rearGrip: 0.78, angleGain: 4, angleDamping: 2.5, accelMax: 2.5, speedKeep: 0.05, powerOverSlip: 18 },
    stability: { rollStart: 10, rollStiffness: 15, rollDamping: 2.5, airUpright: 4 },
  },
  drift: {
    tires: { gripRear: 1.45, handbrakeRearGrip: 0.35, tractionControl: 0 },
    steering: { maxAngle: 40 },
    assist: { counterSteer: 2.2, counterSteerMax: 0.6 },
    drift: { rearGrip: 0.5, baseAngle: 26, throttleAngle: 18, maxAngle: 55, powerOverSlip: 7, speedKeep: 0.35, blendOut: 2 },
  },
};

/** Текущий пресет (машины, которые игрок возьмёт в GTA-режиме, создаются с ним же — classes.ts). */
export const handlingState: { preset: HandlingPreset } = { preset: 'arcade' };

/**
 * Применить пресет к живому конфигу: ключи, которые меняет хоть один пресет, сначала возвращаются к базовым значениям
 * `base` (по умолчанию — arcade Largus), затем накладываются отличия пресета. Остальные поля не трогаются.
 */
export function applyHandlingPreset(cfg: VehicleConfig, name: HandlingPreset, base: VehicleConfig = defaultVehicleConfig()): VehicleConfig {
  const c = cfg as unknown as Record<string, Record<string, unknown>>;
  const b = base as unknown as Record<string, Record<string, unknown>>;
  for (const p of HANDLING_PRESETS) {
    for (const [sec, vals] of Object.entries(PRESETS[p])) for (const k of Object.keys(vals as object)) c[sec][k] = b[sec][k];
  }
  for (const [sec, vals] of Object.entries(PRESETS[name])) Object.assign(c[sec], vals);
  return cfg;
}

/** The live, mutable config instance (lil-gui edits this object). */
export const vehicleConfig: VehicleConfig = defaultVehicleConfig();

/** Высота земли под началом координат шасси в покое (м, отрицательная): сюда ставится нога модели (origin на земле). */
export function restGroundOffset(cfg: VehicleConfig, attachY = ATTACH_Y): number {
  const sag = (cfg.chassis.mass * 9.81) / 4 / cfg.suspension.stiffness;
  return attachY - (cfg.suspension.restLength - sag) - cfg.suspension.wheelRadius;
}

/** Y точки крепления подвески в системе шасси. */
export const ATTACH_Y = -0.05;
