// Сборка game/public/assets/vehicles/vehicles.json из конфигов (assets/scripts/vehicles/configs/*.json)
// и результатов сборки (game/public/assets/vehicles/<id>/build.json). Модель попадает в манифест, только если собрана.
//   node assets/scripts/vehicles/make_manifest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const pub = path.join(root, 'game/public/assets/vehicles');
const models = [];
for (const f of fs.readdirSync(path.join(here, 'configs')).sort()) {
  if (!f.endsWith('.json')) continue;
  const c = JSON.parse(fs.readFileSync(path.join(here, 'configs', f), 'utf8'));
  if (c.enabled === false) continue;
  const bj = path.join(pub, c.id, 'build.json');
  if (!fs.existsSync(bj)) { console.log('skip (not built):', c.id); continue; }
  const b = JSON.parse(fs.readFileSync(bj, 'utf8'));
  const size = (p) => (fs.existsSync(path.join(pub, p)) ? fs.statSync(path.join(pub, p)).size : 0);
  const e = {
    id: c.id, name: c.name, kind: c.kind, roles: c.roles ?? ['traffic', 'parked'], weight: c.weight ?? 1, parkedWeight: c.parkedWeight ?? 1,
    file: `${c.id}/${c.id}.glb`, lod1: `${c.id}/${c.id}_lod1.glb`,
    dims: b.dims, bodyCenterZ: b.bodyCenterZ, wheelbase: b.wheelbase ?? null, track: b.track ?? null,
    wheelRadius: b.wheelRadius ?? null, wheelWidth: b.wheelWidth ?? null, wheels: b.wheels ?? null,
    tris: b.tris, roles3d: b.roles,
    paint: c.fixedPaint ? { fixed: c.fixedPaint } : { variants: c.paintVariants ?? null },
    license: c.license, author: c.author, authorUrl: c.authorUrl, url: c.url,
  };
  e.bytes = size(e.file) + size(e.lod1);
  models.push(e);
}
const out = { version: 1, generated: new Date().toISOString(), models };
fs.writeFileSync(path.join(pub, 'vehicles.json'), JSON.stringify(out, null, 1));
console.log('vehicles.json:', models.map((m) => `${m.id}(${m.kind}, ${m.tris.lod0}/${m.tris.lod1} tris, ${(m.bytes / 1024).toFixed(0)} KB)`).join(', '));
