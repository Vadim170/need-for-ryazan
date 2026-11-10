#!/usr/bin/env node
/**
 * Стенд управляемости в Node (без браузера): грузит scripts/handling/harness.ts через vite SSR и гоняет сценарии.
 *
 *   node scripts/handling/run.mjs                       # полный набор, текущий код (src/vehicle), пресет arcade
 *   node scripts/handling/run.mjs --quick --only step   # фильтр по имени сценария
 *   node scripts/handling/run.mjs --preset drift        # другой пресет (arcade | sim-lite | drift)
 *   node scripts/handling/run.mjs --vehicle-dir <dir>   # другая копия vehicle/ (vehicle.ts, config.ts, classes.ts) — «до»
 *   node scripts/handling/run.mjs --out a.json          # сохранить результаты
 *   node scripts/handling/run.mjs --set tires.gripFront=1.5 --set assist.yawGain=9   # подбор параметров без правки config.ts
 *   node scripts/handling/run.mjs --compare before.json after.json   # таблица «до/после» (markdown)
 */
import { createServer } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(k);

if (flag('--compare')) {
  const [a, b] = [opt('--compare'), args[args.indexOf('--compare') + 2]].map((f) => JSON.parse(readFileSync(f, 'utf8')));
  console.log(compareTable(a, b));
  process.exit(0);
}

const server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
try {
  const H = await server.ssrLoadModule('/scripts/handling/harness.ts');
  const vdir = opt('--vehicle-dir');
  const load = (f) => server.ssrLoadModule(vdir ? path.resolve(vdir, f) : `/src/vehicle/${f}`);
  const [V, C, K, W] = await Promise.all([load('vehicle.ts'), load('config.ts'), load('classes.ts'), server.ssrLoadModule('/src/render/weather.ts')]);
  const preset = opt('--preset', 'arcade');
  const sets = args.map((a, i) => (a === '--set' ? args[i + 1].split('=') : null)).filter(Boolean);
  if (C.handlingState) C.handlingState.preset = preset;
  const makeConfig = (kind) => {
    const cfg = kind === 'largus' ? C.defaultVehicleConfig() : K.vehicleConfigFor(kind, H.KIND_GEOM[kind]);
    if (C.applyHandlingPreset && kind === 'largus') C.applyHandlingPreset(cfg, preset);
    if (kind === 'largus') for (const [k, v] of sets) { const [sec, key] = k.split('.'); cfg[sec][key] = +v; }
    return cfg;
  };
  const mods = { label: vdir ? 'baseline' : `current/${preset}`, Vehicle: V.Vehicle, makeConfig, weatherGrip: W.weatherGrip };
  const t = performance.now();
  const res = await H.runSuite(mods, { quick: flag('--quick'), only: opt('--only') ?? undefined }, (s) => console.log(s));
  console.log(`done in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  const out = opt('--out');
  if (out) writeFileSync(out, JSON.stringify({ label: mods.label, results: res }, null, 1));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await server.close();
}

/** Таблица «до/после» по ключевым метрикам. */
function compareTable(A, B) {
  const a = A.results, b = B.results;
  const g = (r, sc, k) => { const v = r[sc]?.[k]; return v === undefined || v === null ? '—' : typeof v === 'boolean' ? (v ? 'да' : 'нет') : String(v); };
  const rows = [];
  const add = (name, sc, k) => rows.push(`| ${name} | ${g(a, sc, k)} | ${g(b, sc, k)} |`);
  const rolls = (r) => Object.values(r).reduce((n, x) => n + (x.rollover === true ? 1 : 0) + (typeof x.rollovers === 'number' ? x.rollovers : 0), 0);
  rows.push(`| Опрокидывания (все сценарии) | ${rolls(a)} | ${rolls(b)} |`);
  for (const sc of Object.keys({ ...a, ...b })) {
    if ((sc.startsWith('step') || sc.startsWith('wetStep') || sc.startsWith('snowStep') || sc.startsWith('cls_')) && !sc.endsWith('_laneChange')) {
      add(`${sc}: опрокид / занос (spin)`, sc, 'rollover');
      rows[rows.length - 1] = rows[rows.length - 1].replace(/\| ([^|]+) \| ([^|]+) \|$/, `| ${g(a, sc, 'rollover')}/${g(a, sc, 'spun')} | ${g(b, sc, 'rollover')}/${g(b, sc, 'spun')} |`);
      add(`${sc}: max крен, °`, sc, 'maxRoll');
      add(`${sc}: max боковое, g`, sc, 'maxLatG');
      if (!sc.startsWith('cls_')) { add(`${sc}: отклик T63 рыскания, с`, sc, 'yawT63'); add(`${sc}: заброс рыскания`, sc, 'overshoot'); add(`${sc}: отрыв колеса`, sc, 'wheelLift'); }
    }
  }
  for (const [sc, ks] of Object.entries({
    slalom: ['maxKmh', 'pass80', 'pass120', 'maxRoll120'], laneChange: ['maxKmh', 'pass90', 'pass130', 'maxRoll130'], wetSlalom: ['maxKmh'], snowLaneChange: ['maxKmh'],
    circle40: ['maxKmh', 'maxLatG', 'rollGradient', 'maxRoll'], launch: ['t0_60', 't0_100'], brake100: ['dist', 'maxDecelG'], brakeTurn100: ['dist', 'maxSlip', 'headingChange'],
    snowBrake100: ['dist'], curbAngle60: ['maxRoll', 'airTime', 'maxVy'], curbAngle100: ['maxRoll', 'airTime', 'maxVy'], curbSlide40: ['maxRoll', 'rollover'], curbSlide70: ['maxRoll', 'rollover'],
    bumps100: ['maxPitch', 'airTime', 'maxVy'], kicker100: ['longestAir', 'landPitch', 'uprightEnd'], kickerSide100: ['maxRoll', 'landRoll', 'uprightEnd'], kickerSide140: ['maxRoll', 'landRoll', 'uprightEnd'],
    handbrake60: ['rotAt1_5s', 'rotAt3s', 'maxRoll'], driftHB: ['timeInDrift', 'maxSlip', 'spun', 'exitTime'], driftBrake: ['timeInDrift', 'maxSlip', 'spun', 'exitTime'],
  })) for (const k of ks) add(`${sc}: ${k}`, sc, k);
  for (const sc of Object.keys({ ...a, ...b })) if (sc.endsWith('_laneChange')) add(`${sc}: maxKmh`, sc, 'maxKmh');
  return `| Метрика | ${A.label} | ${B.label} |\n|---|---|---|\n${rows.join('\n')}`;
}
