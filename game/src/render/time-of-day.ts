import * as THREE from 'three';

/**
 * Игровые часы и астрономия для центра Рязани (54.636 N, 39.750 E, UTC+3).
 * Глобальные uniform-ы `timeUniforms` читают материалы (окна, фонари, трафик): см. docs/stage2/day-night.md.
 */

export const LAT = 54.636;
export const LON = 39.75;
export const TZ_HOURS = 3;

const D2R = Math.PI / 180;
const DAY_MS = 86400000;

/** Глобальные uniform-ы ночи (объекты `{value}` можно напрямую класть в `shader.uniforms`). */
export const timeUniforms = {
  /** 0 — день, 1 — глубокая ночь (плавно: солнце от +6° до −6°). Фары/фонари включаем по этому значению. */
  nightFactor: { value: 0 },
  /** Доля светящихся окон 0..1 (зависит от часа и темноты). */
  windowLit: { value: 0 },
  /** Направление НА солнце (мировые координаты, единичный вектор). */
  sunDir: { value: new THREE.Vector3(0, 1, 0) },
  /** Направление НА луну. */
  moonDir: { value: new THREE.Vector3(0, -1, 0) },
  /** Цвет горизонта/тумана (линейный RGB). */
  skyColor: { value: new THREE.Color(0xbcd0e4) },
  /** Часы суток 0..24 (местное время, дробные). */
  hour: { value: 12 },
};

/** Юлианская дата из epoch ms (UTC). */
const julian = (ms: number) => ms / DAY_MS + 2440587.5;

/** Местное звёздное время, рад. */
export function localSiderealRad(ms: number): number {
  const d = julian(ms) - 2451545.0;
  const gmstH = 18.697374558 + 24.06570982441908 * d;
  return ((((gmstH * 15 + LON) % 360) + 360) % 360) * D2R;
}

/** Экваториальные координаты (рад) → мировой единичный вектор (x=восток, y=вверх, −z=север). */
export function equatorialToWorld(ra: number, dec: number, lst: number, out = new THREE.Vector3()): THREE.Vector3 {
  const ex = Math.cos(dec) * Math.cos(ra), ey = Math.cos(dec) * Math.sin(ra), ez = Math.sin(dec);
  const s = Math.sin(lst), c = Math.cos(lst), sp = Math.sin(LAT * D2R), cp = Math.cos(LAT * D2R);
  const a = ex * c + ey * s;
  return out.set(-ex * s + ey * c, a * cp + ez * sp, a * sp - ez * cp);
}

/** Матрица «экваториальные оси → мир» (для вращения звёздной сферы). */
export function equatorialMatrix(lst: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  const s = Math.sin(lst), c = Math.cos(lst), sp = Math.sin(LAT * D2R), cp = Math.cos(LAT * D2R);
  return out.set(
    -s, c, 0, 0,
    c * cp, s * cp, sp, 0,
    c * sp, s * sp, -cp, 0,
    0, 0, 0, 1,
  );
}

export interface SunState { dir: THREE.Vector3; elevationDeg: number; azimuthDeg: number; lambdaRad: number }

/** Положение Солнца (низкоточный алгоритм Meeus/Astronomical Almanac, ошибка < 0.1°). */
export function solarPosition(ms: number, out: SunState = { dir: new THREE.Vector3(), elevationDeg: 0, azimuthDeg: 0, lambdaRad: 0 }): SunState {
  const n = julian(ms) - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * D2R;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  equatorialToWorld(ra, dec, localSiderealRad(ms), out.dir);
  out.elevationDeg = Math.asin(THREE.MathUtils.clamp(out.dir.y, -1, 1)) / D2R;
  out.azimuthDeg = ((Math.atan2(out.dir.x, -out.dir.z) / D2R) + 360) % 360; // от севера по часовой
  out.lambdaRad = lam;
  return out;
}

export interface MoonState { dir: THREE.Vector3; elevationDeg: number; /** освещённая доля диска 0..1 */ illumination: number }

/** Простая луна: основные члены эфемерид (точность ~0.5°), фаза по элонгации от Солнца. */
export function moonPosition(ms: number, sunLambda: number, out: MoonState = { dir: new THREE.Vector3(), elevationDeg: 0, illumination: 0 }): MoonState {
  const d = julian(ms) - 2451545.0;
  const Lm = (218.316 + 13.176396 * d) % 360;
  const M = ((134.963 + 13.064993 * d) % 360) * D2R;
  const F = ((93.272 + 13.22935 * d) % 360) * D2R;
  const lon = (Lm + 6.289 * Math.sin(M)) * D2R;
  const lat = 5.128 * Math.sin(F) * D2R;
  const eps = 23.439 * D2R;
  const ra = Math.atan2(Math.sin(lon) * Math.cos(eps) - Math.tan(lat) * Math.sin(eps), Math.cos(lon));
  const dec = Math.asin(Math.sin(lat) * Math.cos(eps) + Math.cos(lat) * Math.sin(eps) * Math.sin(lon));
  equatorialToWorld(ra, dec, localSiderealRad(ms), out.dir);
  out.elevationDeg = Math.asin(THREE.MathUtils.clamp(out.dir.y, -1, 1)) / D2R;
  out.illumination = (1 - Math.cos(lon - sunLambda)) / 2;
  return out;
}

// ------------------------------------------------------------ игровые часы

export type HourListener = (hour: number, clock: GameClock) => void;

/**
 * Игровое время. 1 игровые сутки = `dayMinutes` реальных минут (по умолчанию 24 → 1 игровой час = 1 реальная минута).
 * Дата — сегодняшняя (или `?date=YYYY-MM-DD`): от неё зависит высота солнца и длина ночи.
 */
export class GameClock {
  /** Игровое время, epoch ms (UTC). */
  ms: number;
  paused = false;
  /** Реальных минут на игровые сутки. */
  dayMinutes = 24;
  private listeners: HourListener[] = [];
  private lastHour = -1;

  constructor(startHour = 10, date?: Date) {
    const d = date ?? new Date();
    // полночь местного времени (UTC+3) этой даты, затем + startHour
    const localMidnightUtc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - TZ_HOURS * 3600000;
    this.ms = localMidnightUtc + startHour * 3600000;
  }

  /** Парсит `?time=HH:MM` (или `?time=18.5`) и `?date=YYYY-MM-DD`. */
  static fromQuery(params: URLSearchParams): GameClock {
    let h = 10;
    const t = params.get('time');
    if (t) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(t);
      if (m) h = +m[1] + +m[2] / 60;
      else if (Number.isFinite(+t)) h = +t;
    }
    let date: Date | undefined;
    const ds = params.get('date');
    const dm = ds && /^(\d{4})-(\d{2})-(\d{2})$/.exec(ds);
    if (dm) date = new Date(+dm[1], +dm[2] - 1, +dm[3]);
    const c = new GameClock(((h % 24) + 24) % 24, date);
    const spd = params.get('daymin');
    if (spd && +spd > 0) c.dayMinutes = +spd;
    return c;
  }

  /** Местный час 0..24 (дробный). */
  get hour(): number {
    return ((((this.ms + TZ_HOURS * 3600000) % DAY_MS) + DAY_MS) % DAY_MS) / 3600000;
  }

  /** Игровых секунд в реальную секунду. */
  get speed(): number { return 86400 / (this.dayMinutes * 60); }

  update(dt: number): void {
    if (!this.paused) this.ms += dt * this.speed * 1000;
    this.fire();
  }

  /** Установить местный час текущих суток (0..24). */
  setHour(h: number): void {
    const cur = this.hour;
    this.ms += (h - cur) * 3600000;
    this.fire();
  }

  /** Сдвиг времени в часах (клавиши [ и ]). */
  shift(hours: number): void {
    this.ms += hours * 3600000;
    this.fire();
  }

  /** Подписка на смену целого часа (вызывается и сразу — с текущим значением). Возвращает функцию отписки. */
  onHourChanged(cb: HourListener): () => void {
    this.listeners.push(cb);
    cb(Math.floor(this.hour), this);
    return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
  }

  private fire(): void {
    const h = Math.floor(this.hour);
    if (h === this.lastHour) return;
    this.lastHour = h;
    for (const l of this.listeners) l(h, this);
  }

  get label(): string {
    const h = this.hour, hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
}

// ------------------------------------------------------------ кривые плотности по времени суток

/** Кусочно-линейная кривая по часу (циклическая, 24 ч). pts — [час, значение] по возрастанию часа. */
function curve(pts: [number, number][]): (hour: number) => number {
  return (hour) => {
    const h = ((hour % 24) + 24) % 24;
    const first = pts[0], last = pts[pts.length - 1];
    if (h <= first[0]) { const t = (h + 24 - last[0]) / (first[0] + 24 - last[0]); return last[1] + (first[1] - last[1]) * t; }
    if (h >= last[0]) { const t = (h - last[0]) / (first[0] + 24 - last[0]); return last[1] + (first[1] - last[1]) * t; }
    for (let i = 1; i < pts.length; i++) {
      if (h <= pts[i][0]) { const a = pts[i - 1], b = pts[i]; return a[1] + (b[1] - a[1]) * ((h - a[0]) / (b[0] - a[0])); }
    }
    return last[1];
  };
}

/** Множитель плотности трафика (1 = расчётная плотность, часы пик ≈ 1.15). Передавать в traffic.setDensityFactor. */
export const trafficDensityCurve = curve([[0, 0.12], [4, 0.1], [6, 0.3], [7.5, 0.85], [8.5, 1.15], [10, 0.8], [13, 0.85], [15, 0.9], [17, 1.1], [18.5, 1.15], [20, 0.7], [22, 0.35], [24, 0.12]]);
/** Множитель плотности пешеходов (вечером прогулки, ночью почти нет). Передавать в people.setDensityFactor. */
export const pedestrianDensityCurve = curve([[0, 0.08], [5, 0.05], [7, 0.4], [9, 0.9], [12, 1.0], [15, 0.9], [18, 1.15], [20, 0.8], [22, 0.3], [24, 0.08]]);
/** Доля светящихся окон по часу (до умножения на темноту): утром и вечером, к ночи падает. */
export const windowLitCurve = curve([[0, 0.3], [1, 0.18], [2, 0.1], [4, 0.07], [5.5, 0.14], [6.5, 0.4], [8, 0.3], [10, 0.1], [16, 0.12], [18, 0.4], [20, 0.62], [22, 0.62], [24, 0.3]]);

/** Плавный переход 1→0 при x от a (→1) до b (→0); a>b допустимо. */
export function smooth(a: number, b: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Фары включать, когда nightFactor выше порога (с гистерезисом — используйте headlightsWanted). */
export function headlightsWanted(prev: boolean): boolean {
  const n = timeUniforms.nightFactor.value;
  return prev ? n > 0.25 : n > 0.4;
}
