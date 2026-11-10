/**
 * Audio lab (dev page /audio-lab.html): renders scripted test drives offline with the game's audio graph for every
 * engine preset, lets you listen in the browser, and (if assets/scripts/audio/upload_server.mjs runs) saves WAV +
 * telemetry JSON to assets/audio/test_renders/.  window.__lab.renderAll() is used by automated checks.
 */
import { ENGINE_PRESETS } from '../engine-audio';
import { SCENARIOS, simulate, type TelemetryFrame } from './scenarios';
import { encodeWav, renderScenario, upload } from './render';
import { OPEN_ENV, type EnvState } from '../environment';

const ENVS: Record<string, EnvState> = {
  open: OPEN_ENV,
  street: { canyon: 0.85, covered: 0, wallDist: 14 },
  tunnel: { canyon: 0.9, covered: 1, wallDist: 5 },
};

const log = (s: string) => { const el = document.getElementById('log')!; el.textContent += s + '\n'; console.info('[lab]', s); };
const telCache = new Map<string, TelemetryFrame[]>();

async function telemetry(name: string): Promise<TelemetryFrame[]> {
  let t = telCache.get(name);
  if (!t) {
    const sc = SCENARIOS.find((s) => s.name === name)!;
    t = await simulate(sc);
    telCache.set(name, t);
  }
  return t;
}

export async function renderOne(preset: string, scenario: string, env = 'open', save = true, world = false) {
  const tel = await telemetry(scenario);
  const r = await renderScenario(preset, tel, ENVS[env], 48000, world);
  const suffix = scenario === 'drive' ? '' : `_${scenario}`;
  const envs = env === 'open' ? '' : `_${env}`;
  const name = `${preset}${suffix}${envs}`;
  const wav = encodeWav(r.buffer);
  const row = document.createElement('div');
  row.className = 'row';
  const a = document.createElement('audio');
  a.controls = true; a.src = URL.createObjectURL(wav);
  row.append(`${name}  (${r.audioSeconds.toFixed(1)} s audio in ${r.renderMs.toFixed(0)} ms, ×${(r.audioSeconds * 1000 / r.renderMs).toFixed(1)} realtime)  `, a);
  document.getElementById('out')!.append(row);
  let saved = false;
  if (save) {
    saved = await upload(`${name}.wav`, wav);
    const json = JSON.stringify({ name, preset, scenario, env, fps: 60, lead: 0.1, sampleRate: r.buffer.sampleRate, renderMs: r.renderMs,
      audioSeconds: r.audioSeconds, tel: tel.map((f, i) => ({ ...f, soundRpm: r.soundRpm[i] })) });
    await upload(`${name}.json`, json);
  }
  log(`${name}: ${r.renderMs.toFixed(0)} ms for ${r.audioSeconds.toFixed(1)} s${save ? (saved ? ' → saved' : ' (upload server not running)') : ''}`);
  return { name, renderMs: r.renderMs, audioSeconds: r.audioSeconds, saved };
}

export async function renderAll(presets = Object.keys(ENGINE_PRESETS), scenarios = SCENARIOS.map((s) => s.name), envs = ['open']) {
  const res = [];
  for (const p of presets) for (const s of scenarios) for (const e of envs) res.push(await renderOne(p, s, e));
  return res;
}

function ui() {
  const c = document.getElementById('controls')!;
  const sel = (opts: string[]) => { const s = document.createElement('select'); for (const o of opts) s.add(new Option(o, o)); return s; };
  const ps = sel(Object.keys(ENGINE_PRESETS)), ss = sel(SCENARIOS.map((s) => s.name)), es = sel(Object.keys(ENVS));
  const b = document.createElement('button'); b.textContent = 'Render';
  b.onclick = () => void renderOne(ps.value, ss.value, es.value);
  const all = document.createElement('button'); all.textContent = 'Render all presets × scenarios';
  all.onclick = () => void renderAll();
  c.append(ps, ss, es, b, all);
  const d = document.getElementById('scen')!;
  for (const s of SCENARIOS) d.append(`${s.name}: ${s.title}\n`);
}

ui();
(window as unknown as Record<string, unknown>).__lab = { renderOne, renderAll, telemetry, SCENARIOS };

/** CPU estimate: offline-render 20 s of the full in-game graph (engine + car sfx + street reverb + ambience beds +
 * 6 positional traffic voices) and return the fraction of one core it needs in real time. */
export async function cpuEstimate(seconds = 20) {
  const { AudioSystem } = await import('../audio-system');
  const sr = 48000;
  const ctx = new OfflineAudioContext(2, sr * seconds, sr);
  const sys = await AudioSystem.create(ctx, { preset: 'velvet', world: true });
  sys.updateEnv({ canyon: 0.7, covered: 0, wallDist: 15 }, 0);
  const cars = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, kind: i === 0 ? 'trolleybus' : i === 1 ? 'paz' : 'sedan', x: 10 + i * 8, y: 0, z: -5 + i, fx: 1, fz: 0, v: 8 }));
  for (let i = 0; i < seconds * 60; i++) {
    const t = i / 60;
    sys.updatePlayer({ rpm: 900 + (i % 600) * 8, throttle: 1, load: 1, gear: 2, speed: 15, nitro: false, skid: 0.3, handbrake: false, drifting: false,
      grounded: 4, impact: 0, bump: 0, idleRpm: 900, redlineRpm: 6800 }, 1 / 60, t);
    for (const c of cars) c.x -= 8 / 60;
    sys.updateWorld({ listener: { x: 0, y: 1.5, z: 6, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0, vx: 0, vz: 0 }, hour: 12, traffic: cars,
      trafficDensity: 1, pedestrians: 20, pedDensity: 1, trainRumble: 0.5, trainPos: { x: 50, y: 0, z: 50 }, inCity: true }, 1 / 60, t);
  }
  const t0 = performance.now();
  await ctx.startRendering();
  const ms = performance.now() - t0;
  return { seconds, renderMs: Math.round(ms), coreFraction: +(ms / 1000 / seconds).toFixed(3) };
}
(window as unknown as Record<string, unknown>).__cpu = cpuEstimate;

/**
 * City ambience render: listener (idling car) placed in the zone-map cell where `channel` is strongest
 * (crowd = Почтовая/Театральная/stops, green = parks/лесопарк, industrial, yards, playground), at `hour`, with weather.
 * A few synthetic traffic cars pass by (Doppler). Saves city_<channel>_<hour>[_rain|_snow].wav.
 */
export async function renderCity(channel = 'crowd', hour = 13, weather: { rain?: number; snow?: number; wind?: number } = {}, seconds = 40, season: 'summer' | 'winter' = 'summer', at?: { x: number; z: number; label: string }) {
  const { AudioSystem } = await import('../audio-system');
  const { CityZones } = await import('../city-zones');
  const zones = await CityZones.load();
  if (!zones) throw new Error('zones not built');
  const m = zones.meta;
  // brute-force the best cell for the channel (with some traffic nearby for realism)
  let best = { v: -1, x: 0, z: 0 };
  for (let r = 0; r < m.rows; r += 2) for (let c = 0; c < m.cols; c += 2) {
    const x = m.x0 + (c + 0.5) * m.cell, z = -(m.y0 + (r + 0.5) * m.cell);
    const s = zones.sample(x, z) as unknown as Record<string, number>;
    const v = s[channel] - (channel === 'green' ? 0.6 * s.traffic : 0);
    if (v > best.v) best = { v, x, z };
  }
  if (at) best = { v: 1, x: at.x, z: at.z };
  const sr = 48000;
  const ctx = new OfflineAudioContext(2, sr * seconds, sr);
  const sys = await AudioSystem.create(ctx, { preset: 'velvet', world: true, waitWorld: true });
  sys.setVolume(1);
  sys.setWeather({ rain: 0, snow: 0, wind: 0.2, ...weather });
  sys.setSeason(season);
  // zone map is loaded asynchronously by Ambience; give it a moment
  await new Promise((r) => setTimeout(r, 500));
  sys.updateEnv(channel === 'crowd' ? { canyon: 0.7, covered: 0, wallDist: 14 } : { canyon: 0.1, covered: 0, wallDist: 50 }, 0);
  const cars = [0, 1, 2, 3].map((i) => ({ id: 100 + i, kind: i === 2 ? 'trolleybus' : i === 3 ? 'paz' : 'sedan', x: best.x - 120 - i * 70, y: 0, z: best.z + 8, fx: 1, fz: 0, v: i === 3 ? 9 : 13 }));
  for (let i = 0; i < seconds * 60; i++) {
    const t = i / 60;
    sys.updatePlayer({ rpm: 900, throttle: 0, load: 0, gear: 1, speed: 0, nitro: false, skid: 0, handbrake: false, drifting: false,
      grounded: 4, impact: 0, bump: 0, idleRpm: 900, redlineRpm: 6800 }, 1 / 60, t);
    for (const c of cars) {
      // the bus stops for 6 s in front of the listener (air brakes), others just pass
      if (c.kind === 'paz' && Math.abs(c.x - best.x) < 3 && t < 30) c.v = Math.max(0, c.v - 4 / 60);
      else if (c.kind === 'paz' && c.v < 9 && t >= 30) c.v = Math.min(9, c.v + 1.5 / 60);
      c.x += (c.v * 1) / 60;
    }
    sys.updateWorld({ listener: { x: best.x, y: 1.5, z: best.z, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0, vx: 0, vz: 0 }, hour: hour + t / 3600,
      traffic: cars, trafficDensity: 0.9, pedestrians: channel === 'crowd' ? 30 : 3, pedDensity: 1, trainRumble: 0, trainPos: null, inCity: true }, 1 / 60, t);
  }
  sys.engine.output.gain.value = 0.35; // idling player car stays in the background
  const buf = await ctx.startRendering();
  const tag = `${weather.rain ? '_rain' : ''}${weather.snow ? '_snow' : ''}${season === 'winter' ? '_winter' : ''}`;
  const name = `city_${at?.label ?? channel}_${hour}h${tag}`;
  const wav = encodeWav(buf);
  const ok = await upload(`${name}.wav`, wav);
  log(`${name} @ (${best.x.toFixed(0)}, ${best.z.toFixed(0)}) zone=${JSON.stringify(zones.sample(best.x, best.z))} ${ok ? 'saved' : ''}`);
  return { name, at: best, zone: zones.sample(best.x, best.z), saved: ok };
}
(window as unknown as Record<string, unknown>).__city = renderCity;

/** GTA-mode sound check: footsteps → car door → pistol / AKS-74U burst / shotgun in a street canyon, then the same in the open,
 * a police car passing with siren (Doppler), an explosion. Saves gta_events.wav. */
export async function renderGta(seconds = 34) {
  const { AudioSystem } = await import('../audio-system');
  const sr = 48000;
  const ctx = new OfflineAudioContext(2, sr * seconds, sr);
  const sys = await AudioSystem.create(ctx, { preset: 'velvet', world: true, waitWorld: true });
  sys.setVolume(1);
  const g = sys.gta!;
  const street = { canyon: 0.8, covered: 0, wallDist: 16 }, open = { canyon: 0, covered: 0, wallDist: 60 };
  sys.updateEnv(street, 0);
  g.setListener(0, 1.6, 0, 0, 0);
  // the parked car idles 6 m away (player on foot)
  for (let i = 0; i < seconds * 60; i++) {
    const t = i / 60;
    sys.updatePlayer({ rpm: 900, throttle: 0, load: 0, gear: 1, speed: 0, nitro: false, skid: 0, handbrake: false, drifting: false,
      grounded: 4, impact: 0, bump: 0, idleRpm: 900, redlineRpm: 6800 }, 1 / 60, t);
    sys.setPlayerSpatial(true, -6, 0, 2, t);
    if (t > 17 && t < 17 + 1 / 60) sys.updateEnv(open, t);
    // police car passing at 20 m/s, 8 m from the listener, between 24 and 32 s
    const px = -160 + (t - 24) * 20;
    g.updateSirens(t > 24 && t < 32 ? [{ id: 1, x: px, y: 0.5, z: -8, vx: 20, vz: 0 }] : [], t);
  }
  for (let k = 0; k < 8; k++) g.footstep(0, 0, 0, 1.5, 1, 0.5 + k * 0.5, true);
  g.play('door_handle', -5, 1, 2, 4.6, 0.6, 3); g.play('door_open', -5, 1, 2, 4.75, 0.7, 4); g.play('door_close', -5, 1, 2, 6.0, 0.9, 5);
  const shots = (t0: number) => {
    g.gunshot('pistol', 1, 1.4, -1, t0, true); g.gunshot('pistol', 1, 1.4, -1, t0 + 0.6, true);
    for (let k = 0; k < 6; k++) g.gunshot('rifle', 1, 1.4, -1, t0 + 2 + k * 0.1, true);
    g.impact('vehicle', 20, 1, -15, t0 + 2.1); g.impact('world', 25, 1, -5, t0 + 2.3); g.impact('glass', 18, 1.5, -12, t0 + 2.5);
    g.gunshot('shotgun', 1, 1.4, -1, t0 + 4.5, true);
    g.gunshot('pistol', 150, 1.4, -80, t0 + 6.5, false); // distant shooter
  };
  shots(8); shots(18);
  g.play('explosion_1', 40, 1, -30, 31.5, 1.2, 30);
  g.wanted(2, 1, 26);
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  const ok = await upload('gta_events.wav', encodeWav(buf));
  log(`gta_events ${ok ? 'saved' : ''} (${(performance.now() - t0).toFixed(0)} ms)`);
  return { saved: ok };
}
(window as unknown as Record<string, unknown>).__gta = renderGta;
