#!/usr/bin/env node
/**
 * Сборка PBR-текстур игры (docs/stage3/realism.md).
 *
 *   node scripts/build-textures.mjs [--size 1024] [--force]
 *
 * 1) Скачивает CC0-материалы Poly Haven (api.polyhaven.com, без логина) в кэш ../data/raw/textures/<id>/ (1k JPG:
 *    diffuse, normal GL, rough, AO, displacement).
 * 2) ImageMagick (`magick`): приводит к size×size, пакует ORM = (R: AO, G: roughness, B: высота).
 * 3) basisu (npm-пакет `basisu`, бинарь ставится во временный каталог через npx) — три KTX2-массива (2D array,
 *    UASTC + RDO + Zstandard, мипмапы): albedo (sRGB), normal (linear, -normal_map), orm (linear).
 * 4) public/assets/textures/manifest.json: слои, физический размер (м) и средний цвет (linear) каждого альбедо —
 *    шейдер нормирует текстуру на средний цвет и умножает на «настоящий» цвет (фасады из панорам, тон асфальта…).
 *
 * Лицензии — game/CREDITS.md (всё CC0).
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const CACHE = path.resolve(GAME, '../data/raw/textures');
const OUT = path.join(GAME, 'public/assets/textures');
const args = process.argv.slice(2);
const SIZE = Number(args[args.indexOf('--size') + 1]) || 1024;
const FORCE = args.includes('--force');

/** Слои массивов (порядок = индекс слоя в шейдере, см. src/render/textures.ts → LAYER). */
export const LAYERS = [
  ['asphalt', 'asphalt_02'],             // старый асфальт с трещинами (основной для дорог)
  ['asphalt_fresh', 'clean_asphalt'],    // свежий мелкозернистый
  ['asphalt_patch', 'tarred_gravel'],    // заплаты / крупный щебень в битуме; рубероид плоских крыш
  ['concrete', 'rough_concrete'],        // бордюры, плитка (поверхность), цоколи
  ['concrete_stained', 'concrete_wall_006'], // панели, мосты, подпорные стенки
  ['grass', 'forrest_ground_01'],        // газон
  ['meadow', 'leafy_grass'],             // рельеф/пустыри
  ['dirt', 'park_dirt'],                 // грунт, вытоптанные места
  ['gravel', 'gravel_stones'],           // щебень, балласт
  ['brick_red', 'red_brick_03'],
  ['brick_white', 'white_bricks'],       // силикатный кирпич
  ['plaster', 'painted_plaster_wall'],   // гладкая окрашенная штукатурка (сталинки, центр)
  ['stucco', 'white_stucco_02'],         // «шуба» / грубая штукатурка
  ['roof_galv', 'corrugated_iron'],      // оцинковка
  ['roof_slate', 'asbestos_sheet_02'],   // шифер
  ['roof_profile', 'box_profile_metal_sheet'], // крашеный профлист
  ['metal_painted', 'green_metal_rust'], // крашеный металл с износом
  ['metal_rust', 'rusty_metal_02'],
  ['shutter', 'painted_metal_shutter'],  // гаражные ворота, рольставни
  ['wood', 'wood_plank_wall'],           // деревянные дома, сараи
  ['bark', 'bark_willow'],               // кора лиственных
  ['bark_pine', 'pine_bark'],
];

const sh = (cmd, a) => execFileSync(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

async function fetchRetry(url, tries = 5) {
  for (let k = 0; ; k++) {
    try { return await fetch(url); } catch (e) { if (k >= tries - 1) throw e; await new Promise((r) => setTimeout(r, 2000 * (k + 1))); }
  }
}
async function getJson(url) {
  const r = await fetchRetry(url);
  if (!r.ok) throw new Error(url + ': ' + r.status);
  return r.json();
}
async function download(url, file) {
  if (fs.existsSync(file) && !FORCE) return;
  const r = await fetchRetry(url);
  if (!r.ok) throw new Error(url + ': ' + r.status);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

function basisuBin() {
  const dir = path.join(os.tmpdir(), 'nfr-basisu');
  const bin = path.join(dir, 'node_modules/basisu/bin', process.platform, process.arch, process.platform === 'win32' ? 'basisu.exe' : 'basisu');
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(dir, { recursive: true });
    execSync('npm init -y >/dev/null && npm i basisu@1.16.3 --no-audit --no-fund', { cwd: dir, stdio: 'inherit' });
  }
  fs.chmodSync(bin, 0o755);
  return bin;
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nfr-tex-'));
  const credits = [];
  const layers = [];
  for (const [name, id] of LAYERS) {
    const dir = path.join(CACHE, id);
    fs.mkdirSync(dir, { recursive: true });
    const infoFile = path.join(dir, 'info.json');
    let info;
    if (fs.existsSync(infoFile) && !FORCE) info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    else { info = await getJson('https://api.polyhaven.com/info/' + id); fs.writeFileSync(infoFile, JSON.stringify(info)); }
    const filesFile = path.join(dir, 'files.json');
    let files;
    if (fs.existsSync(filesFile) && !FORCE) files = JSON.parse(fs.readFileSync(filesFile, 'utf8'));
    else { files = await getJson('https://api.polyhaven.com/files/' + id); fs.writeFileSync(filesFile, JSON.stringify(files)); }
    const res = SIZE > 1024 ? '2k' : '1k';
    const pick = (k) => files[k]?.[res]?.jpg?.url ?? files[k]?.['1k']?.jpg?.url;
    const src = {};
    for (const [k, key] of [['diff', 'Diffuse'], ['nor', 'nor_gl'], ['rough', 'Rough'], ['ao', 'AO'], ['disp', 'Displacement']]) {
      const url = pick(key);
      if (!url) continue;
      src[k] = path.join(dir, `${k}_${res}.jpg`);
      await download(url, src[k]);
    }
    if (!src.diff || !src.nor || !src.rough) throw new Error('нет карт у ' + id);
    const R = `${SIZE}x${SIZE}!`;
    const a = path.join(work, `a_${name}.png`), n = path.join(work, `n_${name}.png`), o = path.join(work, `o_${name}.png`);
    sh('magick', [src.diff, '-resize', R, '-alpha', 'off', '-type', 'TrueColor', a]);
    sh('magick', [src.nor, '-resize', R, '-alpha', 'off', '-type', 'TrueColor', n]);
    sh('magick', [
      '(', src.ao ?? 'xc:white', '-resize', R, '-colorspace', 'gray', ')',
      '(', src.rough, '-resize', R, '-colorspace', 'gray', ')',
      '(', src.disp ?? 'xc:gray50', '-resize', R, '-colorspace', 'gray', ')',
      '-combine', '-alpha', 'off', '-type', 'TrueColor', o,
    ]);
    // средний цвет альбедо (linear) и средняя шероховатость
    const avg = sh('magick', [a, '-colorspace', 'RGB', '-resize', '1x1!', '-format', '%[fx:r] %[fx:g] %[fx:b]', 'info:']).trim().split(/\s+/).map(Number);
    const rough = Number(sh('magick', [src.rough, '-colorspace', 'gray', '-resize', '1x1!', '-format', '%[fx:r]', 'info:']).trim());
    const dims = info.dimensions?.[0] > 100 ? info.dimensions : [2000, 2000]; // у части ассетов размер не указан
    layers.push({ name, id, size: [dims[0] / 1000, dims[1] / 1000], avg: avg.map((v) => +v.toFixed(4)), rough: +rough.toFixed(3) });
    credits.push({ id, name: info.name, authors: Object.keys(info.authors ?? {}) });
    console.log(`${name.padEnd(18)} ${id.padEnd(26)} ${(dims[0] / 1000).toFixed(2)} м  avg ${avg.map((v) => v.toFixed(3)).join(' ')}`);
  }

  const bin = basisuBin();
  const arr = (prefix) => layers.flatMap((l) => ['-file', path.join(work, `${prefix}_${l.name}.png`)]);
  const common = ['-ktx2', '-uastc', '-uastc_level', '2', '-mipmap', '-tex_type', '2darray', '-y_flip', '-ktx2_zstandard_level', '18'];
  const run = (out, extra, prefix) => {
    const file = path.join(OUT, out);
    console.log('basisu →', out);
    execFileSync(bin, [...common, ...extra, ...arr(prefix), '-output_file', file], { stdio: ['ignore', 'ignore', 'inherit'] });
    return fs.statSync(file).size;
  };
  const sizes = {
    albedo: run('albedo.ktx2', ['-uastc_rdo_l', '1.5', '-mip_srgb'], 'a'),
    normal: run('normal.ktx2', ['-normal_map', '-uastc_rdo_l', '0.75'], 'n'),
    orm: run('orm.ktx2', ['-linear', '-mip_linear', '-uastc_rdo_l', '2.0'], 'o'),
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ version: 1, size: SIZE, layers, files: { albedo: 'albedo.ktx2', normal: 'normal.ktx2', orm: 'orm.ktx2' } }, null, 1));
  fs.writeFileSync(path.join(OUT, 'credits.json'), JSON.stringify(credits, null, 1));
  const mb = (b) => (b / 1048576).toFixed(1) + ' МБ';
  console.log('готово:', Object.entries(sizes).map(([k, v]) => `${k} ${mb(v)}`).join(', '), '— всего', mb(Object.values(sizes).reduce((s, v) => s + v, 0)));
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
