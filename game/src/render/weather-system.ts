import * as THREE from 'three';
import type GUI from 'lil-gui';
import { weatherUniforms, weatherGrip, playerCarWeather, applySurfaceWeather, setVehicleSnowCap, vehicleSnowCap } from './weather';
import { TrailMap, type LaneSource } from './trail-map';
import { Precipitation } from './precip';
import { GameClock, timeUniforms } from './time-of-day';
import type { RenderContext } from './renderer';
import type { Palette } from './day-night';

/**
 * Погода и сезоны (docs/stage3/weather-seasons.md): состояния, плавные переходы, случайный цикл по климату Рязани,
 * сезон (лето/осень/зима, по умолчанию — по игровой дате), геймплейные множители (сцепление, трафик, пешеходы),
 * осадки, следы шин, снежные шапки, пар из выхлопа, молнии. Пишет `weatherUniforms` (render/weather.ts).
 *
 * URL: ?weather=clear|cloudy|overcast|rain|storm|fog|snowfall (фиксировано) | random (цикл, по умолчанию),
 *      ?season=summer|autumn|winter|auto (auto — по дате), ?snow=0..1, ?slush=0..1 (переопределить покров/кашу).
 * Клавиши: O — следующая погода, I — следующий сезон (лето → осень → зима). Debug GUI — папка «weather / season».
 */

export type WeatherState = 'clear' | 'cloudy' | 'overcast' | 'rain' | 'storm' | 'fog' | 'snowfall';
export const WEATHER_STATES: WeatherState[] = ['clear', 'cloudy', 'overcast', 'rain', 'storm', 'fog', 'snowfall'];
export type SeasonName = 'summer' | 'autumn' | 'winter';

interface Preset { cloud: number; overcast: number; rain: number; snow: number; fog: number; wind: number; lightning: number; damp: number }
const PRESETS: Record<WeatherState, Preset> = {
  clear: { cloud: 0.1, overcast: 0, rain: 0, snow: 0, fog: 0, wind: 0.18, lightning: 0, damp: 0 },
  cloudy: { cloud: 0.55, overcast: 0.25, rain: 0, snow: 0, fog: 0.03, wind: 0.35, lightning: 0, damp: 0 },
  overcast: { cloud: 0.97, overcast: 0.8, rain: 0, snow: 0, fog: 0.15, wind: 0.4, lightning: 0, damp: 0.1 },
  rain: { cloud: 1, overcast: 0.92, rain: 0.6, snow: 0, fog: 0.3, wind: 0.5, lightning: 0, damp: 0 },
  storm: { cloud: 1, overcast: 1, rain: 1, snow: 0, fog: 0.38, wind: 1, lightning: 1, damp: 0 },
  fog: { cloud: 0.75, overcast: 0.65, rain: 0, snow: 0, fog: 1, wind: 0.04, lightning: 0, damp: 0.4 },
  snowfall: { cloud: 1, overcast: 0.9, rain: 0, snow: 0.8, fog: 0.4, wind: 0.4, lightning: 0, damp: 0 },
};

/**
 * Климат Рязани (нормы 1991–2020, Рязань/Дягилево): по месяцам — состояние листвы (season), снежный покров, каша
 * (оттепели, реагенты), мокрость дорог и веса погод для случайного цикла. Устойчивый снежный покров — ~с 5–10 декабря до
 * начала апреля, максимум высоты в феврале; дней с осадками: летом 12–14/мес (гроз в июле ~6), зимой 15–18 (снег);
 * пасмурно (облачность ≥ 8 баллов) в ноябре–январе ~75–80 % дней, туманы — осень/начало зимы утром.
 * Недавние зимы теплее нормы (панорамы Яндекса: 24.12.2025 — тонкий покров пятнами, мокрые чёрные дороги;
 * 03.02.2025 — снега нет совсем, сухая бурая трава; 14–18.03.2026 — грязные валы у бордюров, мокрый асфальт).
 */
interface Month { season: number; snow: number; slush: number; wet: number; w: Partial<Record<WeatherState, number>> }
const CLIMATE: Month[] = [
  /* янв */ { season: 1, snow: 0.8, slush: 0.45, wet: 0.3, w: { clear: 8, cloudy: 14, overcast: 40, snowfall: 30, fog: 6, rain: 2 } },
  /* фев */ { season: 1, snow: 0.85, slush: 0.4, wet: 0.3, w: { clear: 12, cloudy: 18, overcast: 34, snowfall: 30, fog: 5, rain: 1 } },
  /* мар */ { season: 0.95, snow: 0.5, slush: 0.85, wet: 0.6, w: { clear: 16, cloudy: 24, overcast: 32, snowfall: 14, fog: 6, rain: 8 } },
  /* апр */ { season: 0.85, snow: 0.04, slush: 0.15, wet: 0.25, w: { clear: 24, cloudy: 30, overcast: 22, rain: 18, fog: 4, snowfall: 2 } },
  /* май */ { season: 0.08, snow: 0, slush: 0, wet: 0, w: { clear: 34, cloudy: 32, overcast: 12, rain: 16, storm: 4, fog: 2 } },
  /* июн */ { season: 0, snow: 0, slush: 0, wet: 0, w: { clear: 34, cloudy: 30, overcast: 10, rain: 16, storm: 8, fog: 2 } },
  /* июл */ { season: 0, snow: 0, slush: 0, wet: 0, w: { clear: 34, cloudy: 28, overcast: 10, rain: 17, storm: 9, fog: 2 } },
  /* авг */ { season: 0.05, snow: 0, slush: 0, wet: 0, w: { clear: 36, cloudy: 28, overcast: 11, rain: 15, storm: 6, fog: 4 } },
  /* сен */ { season: 0.3, snow: 0, slush: 0, wet: 0.05, w: { clear: 26, cloudy: 30, overcast: 20, rain: 17, storm: 1, fog: 6 } },
  /* окт */ { season: 0.5, snow: 0, slush: 0, wet: 0.2, w: { clear: 14, cloudy: 24, overcast: 36, rain: 18, fog: 8 } },
  /* ноя */ { season: 0.82, snow: 0.12, slush: 0.35, wet: 0.45, w: { clear: 6, cloudy: 14, overcast: 46, rain: 12, snowfall: 12, fog: 10 } },
  /* дек */ { season: 1, snow: 0.4, slush: 0.6, wet: 0.45, w: { clear: 5, cloudy: 13, overcast: 44, snowfall: 26, rain: 4, fog: 8 } },
];
const SEASON_DATE: Record<SeasonName, [number, number]> = { summer: [7, 15], autumn: [10, 10], winter: [1, 20] };

/** Климат на дату (линейно между серединами месяцев). */
function climateAt(ms: number): Month {
  const d = new Date(ms + 3 * 3600000);
  const m = d.getUTCMonth(), day = d.getUTCDate();
  const t = (day - 15) / 30;
  const a = CLIMATE[(m + (t < 0 ? 11 : 0)) % 12], b = CLIMATE[(m + (t < 0 ? 0 : 1)) % 12];
  const k = t < 0 ? 1 + t : t;
  const L = (x: number, y: number) => x + (y - x) * k;
  return { season: L(a.season, b.season), snow: L(a.snow, b.snow), slush: L(a.slush, b.slush), wet: L(a.wet, b.wet), w: k < 0.5 ? a.w : b.w };
}

export interface WeatherPlayer {
  position: THREE.Vector3;
  visual: THREE.Object3D;
  speed: number;
  groundedWheels: number;
  cfg: { chassis: { track: number; wheelbase: number; length: number } };
  body: { linvel(): { x: number; y: number; z: number } };
}
interface SimVehicleLike { id: number; x: number; y: number; z: number; fx: number; fz: number; v: number; len: number; halfW: number; track: number; wb: number; zr: number; dFront: number; crashed: boolean; vf: number; T: number; b: number; kind: string }
interface TrafficLike { sim: { vehicles: readonly SimVehicleLike[] }; net: { lanesNear(x: number, z: number, r: number): Set<number>; segP0: Int32Array; segPn: Int32Array; pts: Float32Array } }
interface AudioLike { setWeather?: (w: { rain: number; snow: number; wind: number; storm?: number }) => void; thunder?: (delaySec: number, intensity: number) => void }

export interface WeatherDeps {
  rc: RenderContext;
  /** Машина игрока (может смениться: on-foot режим и т.п.). */
  player: () => WeatherPlayer | null;
  heightAt?: (x: number, z: number) => number;
  audio?: unknown;
  /** Пятна фонарей (night-lights.ts): на мокром асфальте ярче. */
  nightLights?: { poolMat: THREE.ShaderMaterial };
}

const v3 = new THREE.Vector3();
const col = new THREE.Color();

export class WeatherSystem {
  state: WeatherState = 'clear';
  /** Случайная смена погоды. */
  autoCycle = true;
  /** Длительность перехода, с. */
  transition = 10;
  /** Сезон: 'auto' — по игровой дате. */
  seasonMode: SeasonName | 'auto' = 'auto';
  /** Переключение сезона переставляет дату (зима → 20 января, лето → 15 июля, осень → 10 октября). */
  seasonSetsDate = true;
  /** Ручные переопределения (NaN — нет). */
  snowOverride = NaN;
  slushOverride = NaN;
  readonly trail = new TrailMap();
  readonly precip: Precipitation;
  traffic: TrafficLike | null = null;
  /** Множитель плотности пешеходов (main.ts умножает на кривую времени суток). */
  pedestrianFactor = 1;
  /** Множители для трафика (скорость, дистанция) — применяются к машинам напрямую (sim.vehicles vf/T/b). */
  trafficSpeed = 1;
  trafficGap = 1;
  readonly stats = { ms: 0, stamps: 0, trafficCaps: 0 };

  private cur: Preset = { ...PRESETS.clear };
  private nextChange = 240;
  private wet = 0;
  private puddles = 0;
  private extraSnow = 0;
  private seasonCur = -1;
  private lightningT = 30;
  private flash = 0;
  private seasonClimate: Month = CLIMATE[6];
  private wheelPrev: THREE.Vector3[] = [0, 1, 2, 3].map(() => new THREE.Vector3(NaN, 0, 0));
  private trafPrev = new Map<number, Float32Array>();
  private trafBase = new WeakMap<object, [number, number, number]>();
  private playerCap = 0;
  private puffAcc = { exhaust: 0, spray: 0, cap: 0 };
  private patched = new WeakSet<THREE.Material>();
  private patchTimer = 0;
  private audioTimer = 0;
  private time = 0;
  private dn: RenderContext['dayNight'];

  constructor(private deps: WeatherDeps) {
    this.precip = new Precipitation(deps.rc.scene);
    this.precip.heightAt = deps.heightAt ?? null;
    this.dn = deps.rc.dayNight;
    const params = new URLSearchParams(location.search);
    const w = params.get('weather') as WeatherState | 'random' | null;
    if (w && w !== 'random' && WEATHER_STATES.includes(w)) { this.state = w; this.autoCycle = params.get('weathercycle') === '1'; }
    const s = params.get('season');
    if (s === 'summer' || s === 'autumn' || s === 'winter') this.setSeason(s, !params.get('date'));
    if (params.get('snow') !== null) this.snowOverride = +params.get('snow')!;
    if (params.get('slush') !== null) this.slushOverride = +params.get('slush')!;
    if (!w || w === 'random') this.state = this.pickRandom(true);
    this.cur = { ...PRESETS[this.state] };
    this.seasonClimate = this.climateNow();
    this.applySeasonInstant();
    this.wet = this.state === 'rain' || this.state === 'storm' ? 1 : 0;
    this.puddles = this.state === 'storm' ? 0.9 : this.state === 'rain' ? 0.6 : 0;
    this.playerCap = this.capStart();
    // палитра неба/света под облачность, туман и молнии (day-night.ts вызывает хук после расчёта палитры)
    (this.dn as unknown as { paletteHook: ((p: Palette, el: number) => void) | null }).paletteHook = (p) => this.palette(p);
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.repeat) return;
      if (e.code === 'KeyO') this.next();
      if (e.code === 'KeyI') this.nextSeason();
    });
  }

  // ------------------------------------------------------------------ API

  /** Сменить погоду (плавно; instant — сразу). */
  set(state: WeatherState, instant = false): void {
    // из консоли (__game.weather.set) может прийти что угодно: 'snow' → 'snowfall', неизвестное — игнор
    if ((state as string) === 'snow') state = 'snowfall';
    if (!WEATHER_STATES.includes(state)) { console.warn('[weather] неизвестное состояние:', state, '— есть:', WEATHER_STATES.join(', ')); return; }
    this.state = state;
    this.nextChange = 180 + Math.random() * 300;
    if (instant) {
      this.cur = { ...PRESETS[state] };
      if (state === 'rain' || state === 'storm') { this.wet = 1; this.puddles = state === 'storm' ? 0.9 : 0.6; }
    }
  }
  next(): void { this.set(WEATHER_STATES[(WEATHER_STATES.indexOf(this.state) + 1) % WEATHER_STATES.length]); console.info('[weather]', this.state); }

  /** Сезон (лето/осень/зима) или 'auto' (по дате). setDate — перевести игровую дату на середину сезона. */
  setSeason(s: SeasonName | 'auto', setDate = this.seasonSetsDate): void {
    this.seasonMode = s;
    if (s !== 'auto' && setDate) {
      const clock = this.dn.clock;
      const [m, d] = SEASON_DATE[s];
      const y = new Date(clock.ms).getUTCFullYear();
      clock.ms = new GameClock(clock.hour, new Date(y, m - 1, d)).ms;
    }
    this.seasonClimate = this.climateNow();
    this.playerCap = this.capStart();
  }
  nextSeason(): void {
    const order: SeasonName[] = ['summer', 'autumn', 'winter'];
    const cur = this.seasonMode === 'auto' ? this.nameOf(weatherUniforms.season.value) : this.seasonMode;
    const n = order[(order.indexOf(cur) + 1) % 3];
    this.setSeason(n);
    if (n !== 'winter' && this.state === 'snowfall') this.set('overcast');
    console.info('[weather] season', n);
  }
  get seasonName(): SeasonName { return this.nameOf(weatherUniforms.season.value); }
  /** Доля людей в зимней одежде (people.setWinter): ноябрь — часть, декабрь–март — все; шаг 0.1 (переодевание дорогое). */
  get winterClothes(): number { return Math.round(THREE.MathUtils.smoothstep(weatherUniforms.season.value, 0.55, 0.95) * 10) / 10; }
  private nameOf(v: number): SeasonName { return v < 0.25 ? 'summer' : v < 0.7 ? 'autumn' : 'winter'; }

  /** Трафик: машины тормозят мягче и держат дистанцию; колеи полос для карты следов. */
  attachTraffic(t: TrafficLike): void {
    this.traffic = t;
    const net = t.net;
    const src: LaneSource = {
      segments(x, z, r, out) {
        let n = 0;
        for (const l of net.lanesNear(x, z, r)) {
          const p0 = net.segP0[l], pn = net.segPn[l], P = net.pts;
          for (let k = 0; k + 1 < pn; k++) {
            const a = (p0 + k) * 3, b = a + 3;
            out.push(P[a], P[a + 2], P[b], P[b + 2]); n++;
          }
        }
        return n;
      },
    };
    this.trail.lanes = src;
  }

  /** Подмешать погоду в материалы машины игрока (после загрузки модели; повторный вызов безопасен). */
  patchPlayerCar(root: THREE.Object3D): void {
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) {
        if (this.patched.has(mm) || !(mm as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
        this.patched.add(mm);
        applySurfaceWeather(mm, 'player_car');
      }
    });
  }

  // ------------------------------------------------------------------ кадр

  /** Вызывать после rc.update (палитра/туман уже посчитаны) и до rc.render. */
  update(dt: number): void {
    const t0 = performance.now();
    this.time += dt;
    const W = weatherUniforms;
    // случайный цикл
    if (this.autoCycle) {
      this.nextChange -= dt;
      if (this.nextChange <= 0) this.set(this.pickRandom(false));
    }
    // плавный переход параметров
    const target = PRESETS[this.state];
    const k = 1 - Math.exp(-dt / Math.max(0.1, this.transition / 3));
    for (const key of Object.keys(target) as (keyof Preset)[]) this.cur[key] += (target[key] - this.cur[key]) * k;
    const c = this.cur;
    // сезон (по дате или выбранный) — медленно
    this.seasonClimate = this.climateNow();
    const sc = this.seasonClimate;
    const ks = this.seasonCur < 0 ? 1 : 1 - Math.exp(-dt / 2);
    this.seasonCur = this.seasonCur < 0 ? sc.season : this.seasonCur + (sc.season - this.seasonCur) * ks;
    // мокрость: дождь мочит за ~20 с, сохнет ~2 мин (солнце быстрее); лужи — медленнее; зимой дороги мокрые от реагентов
    const sunny = (1 - c.overcast) * (1 - timeUniforms.nightFactor.value);
    if (c.rain > 0.05) this.wet = Math.min(1, this.wet + dt * c.rain / 15);
    else this.wet = Math.max(0, this.wet - dt / (150 - 90 * sunny));
    if (c.rain > 0.3) this.puddles = Math.min(c.rain, this.puddles + dt * c.rain / 50);
    else this.puddles = Math.max(0, this.puddles - dt / 260);
    // снегопад досыпает покров (до +0.3), без него — медленно оседает
    if (c.snow > 0.05) this.extraSnow = Math.min(0.3, this.extraSnow + dt * c.snow / 240);
    else this.extraSnow = Math.max(0, this.extraSnow - dt / 900);
    const winter = THREE.MathUtils.smoothstep(this.seasonCur, 0.6, 0.9);
    const baseSnow = Number.isFinite(this.snowOverride) ? this.snowOverride : sc.snow;
    const snowCover = Math.min(1, baseSnow + this.extraSnow * Math.max(winter, 0.3));
    const slush = Number.isFinite(this.slushOverride) ? this.slushOverride : sc.slush * (0.8 + 0.2 * Math.max(this.wet, c.snow));

    W.time.value = this.time;
    W.wetness.value = Math.max(this.wet, c.damp, sc.wet * (0.6 + 0.4 * c.overcast));
    W.puddles.value = this.puddles;
    W.rainIntensity.value = c.rain;
    W.snowIntensity.value = c.snow;
    W.snowCover.value = snowCover;
    W.slush.value = slush;
    W.fog.value = c.fog;
    W.windStrength.value = c.wind;
    W.season.value = this.seasonCur;
    W.cloudCover.value = c.cloud;
    // ветер медленно меняет направление
    const ang = 0.6 + Math.sin(this.time * 0.013) * 0.8 + Math.sin(this.time * 0.051) * 0.2;
    W.windDir.value.set(Math.cos(ang), Math.sin(ang));
    this.dn.cloudCover = c.cloud;

    this.updateLightning(dt);
    W.lightning.value = this.flash;
    this.updateFog();
    const nl = this.deps.nightLights;
    if (nl) nl.poolMat.uniforms.uOn.value *= 1 + 0.6 * W.wetness.value + 0.5 * this.puddles;
    // цвета неба для отражений в мокром асфальте
    W.skyHorizon.value.copy(this.dn.palette.horizon);
    W.skyZenith.value.copy(this.dn.palette.zenith).lerp(this.dn.palette.horizon, 0.3);

    // геймплей
    const roadSnow = Math.max(slush * 0.7, snowCover * 0.8);
    weatherGrip.value = (1 - 0.2 * W.wetness.value - 0.08 * this.puddles) * (1 - 0.48 * roadSnow);
    this.trafficSpeed = 1 - 0.1 * W.wetness.value - 0.22 * roadSnow - 0.15 * c.fog - 0.08 * c.rain;
    this.trafficGap = 1 + 0.35 * W.wetness.value + 0.7 * roadSnow + 0.4 * c.fog;
    this.pedestrianFactor = (1 - 0.65 * c.rain - 0.2 * c.lightning) * (1 - 0.3 * c.snow) * (1 - 0.1 * c.fog) * (1 - 0.2 * winter);

    const rc = this.deps.rc;
    const player = this.deps.player();
    this.precip.update(dt, rc.camera, this.lightColor());
    // карта следов: только когда есть снег/каша (летом не тратим кадр)
    this.trail.enabled = snowCover > 0.02 || slush > 0.02;
    this.trail.tau = 90 / (1 + c.snow * 2);
    if (this.trail.enabled) this.stampTracks(player);
    this.trail.update(rc.renderer, rc.camera.position.x, rc.camera.position.z, dt);
    this.updateCaps(dt, player, snowCover, winter);
    this.updatePuffs(dt, player, winter);
    this.updateTraffic(snowCover, winter);
    this.patchSceneLater(dt);
    this.updateAudio(dt);
    this.stats.ms = performance.now() - t0;
  }

  // ------------------------------------------------------------------ небо, свет, туман

  /** Хук палитры DayNight: облачность гасит солнце и закат, небо серое; молния — вспышка; снег — светлее отражённый свет. */
  private palette(p: Palette): void {
    const W = weatherUniforms;
    const o = this.cur.overcast, f = this.cur.fog, L = this.flash;
    const lum = (cc: THREE.Color) => cc.r * 0.3 + cc.g * 0.59 + cc.b * 0.11;
    const hl = lum(p.horizon);
    p.horizon.lerp(col.setRGB(hl, hl * 1.01, hl * 1.04).multiplyScalar(1 - 0.12 * o), o * 0.85);
    const zl = lum(p.zenith);
    p.zenith.lerp(col.setRGB(zl, zl, zl * 1.03), o * 0.8).lerp(p.horizon, o * 0.75);
    p.glow.multiplyScalar(1 - 0.85 * o);
    p.sun.multiplyScalar(1 - 0.75 * o);
    p.sunI *= 1 - 0.82 * o;
    const sl = lum(p.hemiSky);
    p.hemiSky.lerp(col.setRGB(sl, sl, sl * 1.05), o * 0.7);
    p.hemiI *= 1 - 0.1 * o;
    p.exposure *= 1 + 0.22 * o + 0.1 * f;
    // ночью под сплошными облаками — подсветка города снизу (буро-серое небо)
    const nk = timeUniforms.nightFactor.value * o;
    if (nk > 0) { const lp = col.setRGB(0.045, 0.04, 0.036); p.horizon.lerp(lp, nk * 0.7); p.zenith.lerp(lp.multiplyScalar(0.6), nk * 0.8); }
    // туман: горизонт и зенит сливаются
    p.zenith.lerp(p.horizon, f * 0.8);
    p.fogFar = THREE.MathUtils.lerp(p.fogFar * (1 - 0.15 * o), 130, f);
    // снег на земле: отражённый свет снизу светлее и холоднее
    const sn = W.snowCover.value * 0.7;
    if (sn > 0) p.hemiGround.lerp(col.setRGB(0.55, 0.58, 0.64).multiplyScalar(0.3 + 0.7 * (1 - timeUniforms.nightFactor.value)), sn);
    if (L > 0) {
      const add = col.setRGB(0.55, 0.58, 0.75).multiplyScalar(L * 0.7);
      p.horizon.add(add); p.zenith.add(add);
      p.hemiI += L * 1.6;
      p.hemiSky.lerp(col.setRGB(0.8, 0.85, 1), L * 0.5);
    }
  }

  private updateFog(): void {
    const fog = this.deps.rc.scene.fog as THREE.Fog | null;
    if (!fog) return;
    const f = this.cur.fog;
    fog.near = THREE.MathUtils.lerp(150, 0, Math.min(1, f * 1.4));
    // fog.far уже выставлен DayNight по палитре (p.fogFar), здесь только подстраховка
    fog.far = Math.max(fog.near + 60, fog.far);
  }

  private lightColor(): THREE.Color {
    const p = this.dn.palette;
    const night = timeUniforms.nightFactor.value;
    return col.copy(p.hemiSky).multiplyScalar(p.hemiI * 0.55).add(v3c.copy(p.sun).multiplyScalar(p.sunI * 0.12)).multiplyScalar(1 - 0.5 * night).addScalar(0.02 + 0.03 * night);
  }

  private updateLightning(dt: number): void {
    this.flash = Math.max(0, this.flash - dt * 7);
    if (this.cur.lightning < 0.3) return;
    this.lightningT -= dt * this.cur.lightning;
    if (this.lightningT > 0) return;
    this.lightningT = 6 + Math.random() * 18;
    const dist = 900 + Math.random() * 2600;
    this.flash = 0.6 + 0.4 * Math.random() * (1 - dist / 4000);
    // двойная вспышка
    setTimeout(() => { this.flash = Math.max(this.flash, 0.5 + Math.random() * 0.4); }, 90 + Math.random() * 120);
    if (dist < 2800) this.precip.strike(this.deps.rc.camera, Math.random() * Math.PI * 2, dist);
    const a = this.deps.audio as AudioLike | undefined;
    a?.thunder?.(dist / 340, 1 - dist / 4000);
  }

  // ------------------------------------------------------------------ следы

  private stampTracks(player: WeatherPlayer | null): void {
    const tr = this.trail;
    let n = 0;
    if (player && player.groundedWheels >= 3) {
      const ch = player.cfg.chassis;
      player.visual.updateMatrixWorld();
      const m = player.visual.matrixWorld;
      const loc = [[-ch.track / 2, -ch.wheelbase / 2], [ch.track / 2, -ch.wheelbase / 2], [-ch.track / 2, ch.wheelbase / 2], [ch.track / 2, ch.wheelbase / 2]];
      for (let i = 0; i < 4; i++) {
        v3.set(loc[i][0], 0, loc[i][1]).applyMatrix4(m);
        const p = this.wheelPrev[i];
        const d = Number.isNaN(p.x) ? 1e9 : Math.hypot(v3.x - p.x, v3.z - p.z);
        if (d > 4) p.copy(v3);
        else if (d > 0.08) { tr.stamp(p.x, p.z, v3.x, v3.z, 0.105, 1); p.copy(v3); n++; }
      }
    } else for (const p of this.wheelPrev) p.x = NaN;
    const t = this.traffic;
    if (t) {
      const cam = this.deps.rc.camera.position;
      const seen = this.trafPrev;
      for (const v of t.sim.vehicles) {
        const dx = v.x - cam.x, dz = v.z - cam.z;
        if (dx * dx + dz * dz > 110 * 110 || v.crashed) { seen.delete(v.id); continue; }
        // задние колёса: ось на zr (вперёд — f), правый вектор (−fz, fx)
        const rx = -v.fz, rz = v.fx, ht = v.track / 2;
        const ax = v.x - v.fx * v.zr, az = v.z - v.fz * v.zr;
        let pr = seen.get(v.id);
        const lx = ax - rx * ht, lz = az - rz * ht, qx = ax + rx * ht, qz = az + rz * ht;
        if (!pr) { seen.set(v.id, (pr = new Float32Array([lx, lz, qx, qz]))); continue; }
        const d = Math.hypot(lx - pr[0], lz - pr[1]);
        if (d > 4) { pr.set([lx, lz, qx, qz]); continue; }
        if (d < 0.15) continue;
        tr.stamp(pr[0], pr[1], lx, lz, 0.11, 0.75);
        tr.stamp(pr[2], pr[3], qx, qz, 0.11, 0.75);
        pr.set([lx, lz, qx, qz]);
        n += 2;
      }
      if (seen.size > 2000) seen.clear();
    }
    this.stats.stamps = n;
  }

  // ------------------------------------------------------------------ снежные шапки

  private capStart(): number {
    const c = this.climateNow();
    return c.season > 0.8 && c.snow > 0.25 ? Math.min(1, 0.4 + c.snow) : 0;
  }

  private updateCaps(dt: number, player: WeatherPlayer | null, snowCover: number, winter: number): void {
    const P = this.precip;
    // игрок: сдувает с 45 км/ч, быстрее с ростом скорости; в снегопад на стоянке медленно нарастает
    if (player) {
      const kmh = player.speed * 3.6;
      const before = this.playerCap;
      if (kmh > 45) this.playerCap = Math.max(0, this.playerCap - dt * Math.min(0.5, (kmh - 45) / 40 * 0.22));
      if (this.cur.snow > 0.1 && kmh < 15 && winter > 0.5) this.playerCap = Math.min(1, this.playerCap + dt * this.cur.snow * 0.004);
      if (winter < 0.3) this.playerCap = 0;
      playerCarWeather.wxCap.value = this.playerCap;
      player.visual.updateMatrixWorld();
      playerCarWeather.wxCarInv.value.copy(player.visual.matrixWorld).invert();
      const lost = before - this.playerCap;
      if (lost > 0) {
        this.puffAcc.cap += lost * 260;
        const m = player.visual.matrixWorld;
        const lv = player.body.linvel();
        const zFront = THREE.MathUtils.lerp(-0.9, 1.4, 1 - this.playerCap); // фронт сдувания: спереди назад
        while (this.puffAcc.cap >= 1) {
          this.puffAcc.cap -= 1;
          v3.set((Math.random() - 0.5) * 1.4, 1.05 + Math.random() * 0.12, zFront + (Math.random() - 0.5) * 0.5).applyMatrix4(m);
          const big = Math.random() < 0.35;
          P.puff({
            x: v3.x, y: v3.y, z: v3.z,
            vx: lv.x * 0.75 + (Math.random() - 0.5) * 2, vy: 1.2 + Math.random() * 1.8, vz: lv.z * 0.75 + (Math.random() - 0.5) * 2,
            life: big ? 1.3 : 1.0, size0: big ? 0.15 : 0.05, size1: big ? 0.9 : 0.09, alpha: big ? 0.22 : 0.9, gravity: big ? 1.5 : 9.8,
            r: 0.85, g: 0.87, b: 0.9,
          });
        }
      }
    }
    // трафик (дёшево): шапка у части машин (стояли во дворе), сдувает с 50 км/ч; без частиц дальше 60 м
    const t = this.traffic;
    let nc = 0;
    if (t) {
      const capOn = snowCover > 0.25 && winter > 0.5;
      const cam = this.deps.rc.camera.position;
      for (const v of t.sim.vehicles) {
        let cap = vehicleSnowCap(v);
        if (!capOn) { if (cap) setVehicleSnowCap(v, 0); continue; }
        if (cap === 0 && !this.capInit.has(v)) {
          this.capInit.add(v);
          const h = ((Math.imul(v.id, 2654435761) >>> 0) / 4294967296);
          cap = h < 0.45 && v.kind !== 'liaz' && v.kind !== 'trolleybus' ? 0.5 + h : 0;
        }
        if (cap > 0) {
          const kmh = v.v * 3.6;
          if (kmh > 50) {
            const nc2 = Math.max(0, cap - dt * (kmh - 50) / 40 * 0.2);
            const dx = v.x - cam.x, dz = v.z - cam.z;
            if (dx * dx + dz * dz < 3600 && Math.random() < (cap - nc2) * 60) {
              P.puff({ x: v.x + (Math.random() - 0.5), y: v.y + 1.55, z: v.z + (Math.random() - 0.5), vx: v.fx * v.v * 0.7, vy: 1.5, vz: v.fz * v.v * 0.7,
                life: 1.3, size0: 0.15, size1: 0.9, alpha: 0.22, gravity: 1.5, r: 0.85, g: 0.87, b: 0.9 });
            }
            cap = nc2;
          }
          nc++;
        }
        setVehicleSnowCap(v, cap);
      }
    }
    this.stats.trafficCaps = nc;
  }
  private capInit = new WeakSet<object>();

  // ------------------------------------------------------------------ пар, брызги

  private updatePuffs(dt: number, player: WeatherPlayer | null, winter: number): void {
    const P = this.precip;
    const cold = winter;
    if (!player) return;
    const m = player.visual.matrixWorld;
    const lv = player.body.linvel();
    const ch = player.cfg.chassis;
    // пар из выхлопа в мороз (сзади слева, у бампера)
    if (cold > 0.3) {
      this.puffAcc.exhaust += dt * 10 * cold;
      while (this.puffAcc.exhaust >= 1) {
        this.puffAcc.exhaust -= 1;
        v3.set(-0.45, -0.32, ch.length / 2 + 0.05).applyMatrix4(m);
        const lc = this.lightColor(), l = Math.min(0.9, (lc.r + lc.g + lc.b) * 0.45 + 0.1);
        P.puff({ x: v3.x, y: v3.y, z: v3.z, vx: lv.x * 0.6 + (Math.random() - 0.5) * 1.2, vy: 0.5 + Math.random() * 0.5, vz: lv.z * 0.6 + (Math.random() - 0.5) * 1.2,
          life: 1.5, size0: 0.08, size1: 1.0, alpha: 0.035 * cold, gravity: -0.3, r: l, g: l, b: l * 1.03 });
      }
    }
    // водяная пыль/снежная взвесь из-под задних колёс
    const wet = weatherUniforms.wetness.value, sl = weatherUniforms.slush.value;
    const spray = Math.max(wet * 0.8 + this.puddles * 0.5, sl * 0.6);
    const kmh = player.speed * 3.6;
    if (spray > 0.2 && kmh > 25 && player.groundedWheels >= 3) {
      this.puffAcc.spray += dt * Math.min(70, (kmh - 25) * 1.2) * spray;
      const lit = this.lightColor();
      const snowy = sl > wet;
      while (this.puffAcc.spray >= 1) {
        this.puffAcc.spray -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        v3.set(side * ch.track / 2, -0.5, ch.wheelbase / 2 + 0.35).applyMatrix4(m);
        P.puff({ x: v3.x, y: v3.y, z: v3.z, vx: lv.x * 0.55 + side * (Math.random()) * 0.8, vy: 0.6 + Math.random() * 0.8, vz: lv.z * 0.55,
          life: 0.9, size0: 0.25, size1: 1.6, alpha: 0.13 * spray, gravity: 0.5,
          r: snowy ? 0.55 : lit.r * 1.2, g: snowy ? 0.53 : lit.g * 1.2, b: snowy ? 0.5 : lit.b * 1.25 });
      }
    }
  }

  // ------------------------------------------------------------------ трафик, материалы, звук

  private updateTraffic(snowCover: number, winter: number): void {
    const t = this.traffic;
    if (!t) return;
    void snowCover; void winter;
    const sk = this.trafficSpeed, gk = this.trafficGap;
    for (const v of t.sim.vehicles) {
      let b = this.trafBase.get(v);
      if (!b) this.trafBase.set(v, (b = [v.vf, v.T, v.b]));
      v.vf = b[0] * sk; v.T = b[1] * gk; v.b = b[2] * (0.75 + 0.25 * sk);
    }
  }

  /** Раз в 2 с: материалы сцены, ещё не знающие о погоде (машина игрока после загрузки модели и т.п.). */
  private patchSceneLater(dt: number): void {
    this.patchTimer -= dt;
    if (this.patchTimer > 0) return;
    this.patchTimer = 2;
    const p = this.deps.player();
    if (p) this.patchPlayerCar(p.visual);
    // голые деревья зимой не отбрасывают тень кроной (тень — от полного «шара» кроны, шейдер глубины веток не знает)
    const leafy = weatherUniforms.season.value < 0.75;
    this.deps.rc.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !Array.isArray(m) && m.userData.wxKind === 'vegetation' && (o as THREE.Mesh).isMesh) {
        if (o.userData.wxShadow === undefined) o.userData.wxShadow = o.castShadow;
        o.castShadow = leafy && o.userData.wxShadow;
      }
    });
  }

  private updateAudio(dt: number): void {
    this.audioTimer -= dt;
    if (this.audioTimer > 0) return;
    this.audioTimer = 0.25;
    const a = this.deps.audio as AudioLike | undefined;
    a?.setWeather?.({ rain: this.cur.rain, snow: this.cur.snow, wind: this.cur.wind, storm: this.cur.lightning });
  }

  // ------------------------------------------------------------------ сезон и случайный цикл

  private climateNow(): Month {
    if (this.seasonMode === 'auto') return climateAt(this.dn.clock.ms);
    const [m, d] = SEASON_DATE[this.seasonMode];
    return climateAt(Date.UTC(2026, m - 1, d, 12));
  }

  private applySeasonInstant(): void {
    this.seasonCur = this.seasonClimate.season;
  }

  private pickRandom(initial: boolean): WeatherState {
    const sc = this.climateNow();
    const w = { ...sc.w };
    // утренний туман (4–9 ч) втрое вероятнее; при старте — без гроз
    const h = this.dn.clock.hour;
    if (h > 4 && h < 9 && w.fog) w.fog *= 3;
    if (initial) delete w.storm;
    const keys = Object.keys(w) as WeatherState[];
    let sum = 0;
    for (const k of keys) sum += w[k]!;
    let r = Math.random() * sum;
    for (const k of keys) { r -= w[k]!; if (r <= 0) return k === this.state && !initial ? this.pickRandom(false) : k; }
    return 'clear';
  }

  // ------------------------------------------------------------------ GUI / отладка

  addGui(gui: GUI): void {
    const f = gui.addFolder('weather / season  (O, I)');
    const st = { state: this.state, season: this.seasonMode as string, snow: 0, slush: 0 };
    f.add(st, 'state', WEATHER_STATES).name('weather').onChange((s: WeatherState) => this.set(s)).listen();
    f.add(this, 'autoCycle').name('random cycle');
    f.add(this, 'transition', 0.5, 60, 0.5).name('transition, s');
    f.add(st, 'season', ['auto', 'summer', 'autumn', 'winter']).onChange((s: SeasonName | 'auto') => this.setSeason(s));
    f.add(this, 'seasonSetsDate').name('season sets date');
    f.add(st, 'snow', -0.01, 1, 0.01).name('snow cover (−=auto)').onChange((v: number) => { this.snowOverride = v < 0 ? NaN : v; });
    f.add(st, 'slush', -0.01, 1, 0.01).name('slush (−=auto)').onChange((v: number) => { this.slushOverride = v < 0 ? NaN : v; });
    f.add({ strike: () => { this.lightningT = 0; this.cur.lightning = Math.max(this.cur.lightning, 1); } }, 'strike').name('lightning now');
    f.add({ cap: () => { this.playerCap = 1; } }, 'cap').name('snow cap on car');
    f.add(this.trail, 'enabled').name('tire tracks map').listen();
    f.close();
    setInterval(() => { st.state = this.state; }, 500);
  }

  debug(): Record<string, unknown> {
    return {
      system: this,
      set: (s: WeatherState, instant = true) => this.set(s, instant),
      season: (s: SeasonName | 'auto', setDate = true) => this.setSeason(s, setDate),
      cap: (v = 1) => { this.playerCap = v; },
      strike: () => { this.lightningT = 0; this.cur.lightning = 1; },
      stats: () => ({
        state: this.state, season: this.seasonName, ...Object.fromEntries(Object.entries(weatherUniforms)
          .filter(([, u]) => typeof u.value === 'number').map(([k, u]) => [k, +(u.value as number).toFixed(3)])),
        grip: +weatherGrip.value.toFixed(3), peds: +this.pedestrianFactor.toFixed(2), trafficSpeed: +this.trafficSpeed.toFixed(2),
        trafficGap: +this.trafficGap.toFixed(2), playerCap: +this.playerCap.toFixed(2), ...this.stats, ...this.precip.stats,
      }),
    };
  }
}

const v3c = new THREE.Color();
