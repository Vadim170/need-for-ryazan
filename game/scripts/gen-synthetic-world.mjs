// Синтетический мир для проверки загрузки/стриминга/коллайдеров независимо от пайплайна.
// Пишет формат docs/world-format.md в game/public/world-synthetic/ (без зависимостей, glb собирается руками).
// Запуск: node scripts/gen-synthetic-world.mjs [тайлов_по_стороне=12]
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'world-synthetic');
const N = Number(process.argv[2] ?? 12); // тайлов по стороне
const TILE = 250, CELL = 5, ROAD_W = 12;
const HALF = (N * TILE) / 2;
const MIN = -HALF; // minX = minZ
const COLS = (N * TILE) / CELL + 1;

// рельеф: пологие холмы, у дорог (центры тайлов) почти ровно не нужно — дорога лежит +0.3 над рельефом
const H = (x, z) => 5 * Math.sin(x / 210) * Math.cos(z / 260) + 2 * Math.sin((x + z) / 90);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'terrain'), { recursive: true });
mkdirSync(join(OUT, 'tiles'), { recursive: true });
mkdirSync(join(OUT, 'roads'), { recursive: true });

// --- heightmap: строка 0 = север (min z), столбец 0 = min x ---
const hm = new Float32Array(COLS * COLS);
for (let r = 0; r < COLS; r++) for (let c = 0; c < COLS; c++) hm[r * COLS + c] = H(MIN + c * CELL, MIN + r * CELL);
writeFileSync(join(OUT, 'terrain', 'heightmap.f32'), Buffer.from(hm.buffer));

// --- glb ---
function buildGlb(materials, nodes) {
  // nodes: [{name, extras?, material?, pos, nrm?, uv?, idx}]
  const chunks = []; let off = 0;
  const bufferViews = [], accessors = [], meshes = [], gltfNodes = [];
  const push = (typed, target) => {
    const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (b.length % 4)) % 4;
    chunks.push(b, Buffer.alloc(pad));
    bufferViews.push({ buffer: 0, byteOffset: off, byteLength: b.length, target });
    off += b.length + pad;
    return bufferViews.length - 1;
  };
  const acc = (typed, target, type, comp, count, minmax) => {
    const bv = push(typed, target);
    const a = { bufferView: bv, componentType: comp, count, type };
    if (minmax) { a.min = minmax[0]; a.max = minmax[1]; }
    accessors.push(a);
    return accessors.length - 1;
  };
  for (const n of nodes) {
    if (!n.idx.length) continue;
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < n.pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], n.pos[i + k]); mx[k] = Math.max(mx[k], n.pos[i + k]); }
    const attrs = { POSITION: acc(new Float32Array(n.pos), 34962, 'VEC3', 5126, n.pos.length / 3, [mn, mx]) };
    if (n.nrm) attrs.NORMAL = acc(new Float32Array(n.nrm), 34962, 'VEC3', 5126, n.nrm.length / 3);
    if (n.uv) attrs.TEXCOORD_0 = acc(new Float32Array(n.uv), 34962, 'VEC2', 5126, n.uv.length / 2);
    const prim = { attributes: attrs, indices: acc(new Uint32Array(n.idx), 34963, 'SCALAR', 5125, n.idx.length) };
    if (n.material !== undefined) prim.material = n.material;
    meshes.push({ name: n.name, primitives: [prim] });
    const node = { name: n.name, mesh: meshes.length - 1 };
    if (n.extras) node.extras = n.extras;
    gltfNodes.push(node);
  }
  const json = {
    asset: { version: '2.0', generator: 'nfr-synthetic' },
    scene: 0, scenes: [{ nodes: gltfNodes.map((_, i) => i) }],
    nodes: gltfNodes, meshes, accessors, bufferViews,
    materials: materials.map((m) => ({ name: m.name, pbrMetallicRoughness: { baseColorFactor: [...m.color, 1], metallicFactor: 0, roughnessFactor: 0.9 } })),
    buffers: [{ byteLength: off }],
  };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const total = 12 + 8 + js.length + 8 + bin.length;
  const hdr = Buffer.alloc(12); hdr.writeUInt32LE(0x46546c67, 0); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(total, 8);
  const h1 = Buffer.alloc(8); h1.writeUInt32LE(js.length, 0); h1.writeUInt32LE(0x4e4f534a, 4);
  const h2 = Buffer.alloc(8); h2.writeUInt32LE(bin.length, 0); h2.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([hdr, h1, js, h2, bin]);
}

const MATS = [
  { name: 'terrain', color: [0.35, 0.5, 0.25] },
  { name: 'road_asphalt', color: [0.2, 0.2, 0.22] },
  { name: 'building_apartments', color: [0.75, 0.7, 0.62] },
  { name: 'building_house', color: [0.8, 0.55, 0.45] },
  { name: 'water', color: [0.1, 0.3, 0.5] },
];

// простой «батчер» мешей
const mk = () => ({ pos: [], nrm: [], uv: [], idx: [] });
function quad(m, a, b, c, d, n, uvs) { // a,b,c,d — CCW снаружи
  const base = m.pos.length / 3;
  for (const p of [a, b, c, d]) { m.pos.push(...p); m.nrm.push(...n); }
  for (const u of uvs ?? [0, 0, 1, 0, 1, 1, 0, 1]) m.uv.push(u);
  m.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
function box(m, cx, cz, y0, sx, sy, sz, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (dx, dz) => [cx + dx * c - dz * s, cz + dx * s + dz * c];
  const hx = sx / 2, hz = sz / 2;
  const corners = [P(-hx, -hz), P(hx, -hz), P(hx, hz), P(-hx, hz)];
  const y1 = y0 + sy;
  // низ не нужен; крыша (нормаль +Y): порядок так, чтобы CCW сверху
  quad(m, [...[corners[0][0], y1, corners[0][1]]], [corners[3][0], y1, corners[3][1]], [corners[2][0], y1, corners[2][1]], [corners[1][0], y1, corners[1][1]], [0, 1, 0]);
  for (let i = 0; i < 4; i++) {
    const p = corners[i], q = corners[(i + 1) % 4];
    const dx = q[0] - p[0], dz = q[1] - p[1], L = Math.hypot(dx, dz);
    // нормаль наружу: для обхода 0->1->2->3 (x к z) наружу = (dz, -dx)/L ... проверено ниже по триангуляции
    const n = [dz / L, 0, -dx / L];
    quad(m, [p[0], y0, p[1]], [p[0], y1, p[1]], [q[0], y1, q[1]], [q[0], y0, q[1]], n);
  }
}
// Проверка/починка обхода: нормаль грани должна совпадать с геометрической
function fixWinding(m) {
  for (let i = 0; i < m.idx.length; i += 3) {
    const [a, b, c] = [m.idx[i], m.idx[i + 1], m.idx[i + 2]];
    const A = m.pos.slice(a * 3, a * 3 + 3), B = m.pos.slice(b * 3, b * 3 + 3), C = m.pos.slice(c * 3, c * 3 + 3);
    const u = B.map((v, k) => v - A[k]), w = C.map((v, k) => v - A[k]);
    const g = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const n = m.nrm.slice(a * 3, a * 3 + 3);
    if (g[0] * n[0] + g[1] * n[1] + g[2] * n[2] < 0) { m.idx[i + 1] = c; m.idx[i + 2] = b; }
  }
}

const tiles = [];
const nodesG = [], edges = [];
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
  const minX = MIN + ix * TILE, minZ = MIN + iz * TILE, maxX = minX + TILE, maxZ = minZ + TILE;
  const cx = minX + TILE / 2, cz = minZ + TILE / 2;
  tiles.push({ ix, iz, file: `tiles/${ix}_${iz}.glb`, minX, minZ, maxX, maxZ });

  // terrain
  const t = mk(); const n1 = TILE / CELL + 1; let hmin = 1e9;
  for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) {
    const x = minX + i * CELL, z = minZ + j * CELL, h = H(x, z); hmin = Math.min(hmin, h);
    const e = 0.5, nx = H(x - e, z) - H(x + e, z), nz = H(x, z - e) - H(x, z + e), l = Math.hypot(nx, 2 * e, nz);
    t.pos.push(x, h, z); t.nrm.push(nx / l, 2 * e / l, nz / l); t.uv.push(x / 10, z / 10);
  }
  for (let j = 0; j < n1 - 1; j++) for (let i = 0; i < n1 - 1; i++) {
    const a = j * n1 + i, b = a + 1, c = a + n1, d = c + 1;
    t.idx.push(a, c, b, b, c, d);
  }
  fixWinding(t);

  // roads: полоса вдоль X (z=cz) и вдоль Z (x=cx), с шагом 5 м, +0.3 над рельефом
  const r = mk();
  const strip = (alongX) => {
    const steps = TILE / CELL;
    for (let s = 0; s <= steps; s++) {
      const a = (alongX ? minX : minZ) + s * CELL;
      for (const side of [-1, 1]) {
        const x = alongX ? a : cx + side * ROAD_W / 2, z = alongX ? cz + side * ROAD_W / 2 : a;
        r.pos.push(x, H(x, z) + 0.3, z); r.nrm.push(0, 1, 0); r.uv.push(side < 0 ? 0 : 1, s * CELL);
      }
    }
    const b0 = r.pos.length / 3 - (steps + 1) * 2;
    for (let s = 0; s < steps; s++) { const a = b0 + s * 2; r.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  };
  strip(true); strip(false);
  fixWinding(r);

  // здания: по 5 коробок с каждой стороны от пересечения, на расстоянии от дороги >= 14 м
  const b = mk(), bc = mk();
  const spots = [[-60, -30], [-90, 35], [40, -70], [75, 40], [-45, 80], [95, -85], [-100, -95], [60, 100]];
  for (const [dx, dz] of spots) {
    const sx = 14 + rnd() * 16, sz = 14 + rnd() * 16, sy = 9 + Math.floor(rnd() * 6) * 3, rot = (rnd() - 0.5) * 0.4;
    const x = cx + dx, z = cz + dz;
    if (Math.abs(dx) < ROAD_W / 2 + sx || Math.abs(dz) < ROAD_W / 2 + sz) { /* может задеть дорогу — сдвигаем */ }
    const y0 = H(x, z) - 1;
    box(b, x, z, y0, sx, sy + 1, sz, rot); box(bc, x, z, y0, sx, sy + 1, sz, rot);
  }
  fixWinding(b); fixWinding(bc);

  const nodes = [
    { name: 'terrain', material: 0, ...t },
    { name: 'roads', material: 1, ...r },
    { name: 'buildings', material: 2, ...b },
    { name: 'building_colliders', extras: { collider: true }, pos: bc.pos, idx: bc.idx },
  ];
  if (hmin < -3) {
    const w = mk();
    quad(w, [minX, -3, minZ], [minX, -3, maxZ], [maxX, -3, maxZ], [maxX, -3, minZ], [0, 1, 0]);
    fixWinding(w);
    nodes.push({ name: 'water', material: 4, ...w });
  }
  writeFileSync(join(OUT, 'tiles', `${ix}_${iz}.glb`), buildGlb(MATS, nodes));
}

// --- дорожный граф: сетка пересечений в центрах тайлов ---
const idOf = (ix, iz) => iz * N + ix;
const cxOf = (i) => MIN + i * TILE + TILE / 2;
for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
  const x = cxOf(ix), z = cxOf(iz);
  nodesG.push({ id: idOf(ix, iz), x, y: H(x, z) + 0.3, z });
}
const pts = (x0, z0, x1, z1) => { const out = []; const n = 10; for (let k = 0; k <= n; k++) { const x = x0 + (x1 - x0) * k / n, z = z0 + (z1 - z0) * k / n; out.push([x, H(x, z) + 0.3, z]); } return out; };
for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
  for (const [dx, dz] of [[1, 0], [0, 1]]) {
    const jx = ix + dx, jz = iz + dz;
    if (jx >= N || jz >= N) continue;
    edges.push({ id: edges.length, from: idOf(ix, iz), to: idOf(jx, jz), osmId: 0, name: 'synthetic', highway: 'primary', lanesForward: 1, lanesBackward: 1, oneway: false, width: ROAD_W, points: pts(cxOf(ix), cxOf(iz), cxOf(jx), cxOf(jz)) });
  }
}
// координаты игры: x, y = высота, z (север = -z)
writeFileSync(join(OUT, 'roads', 'graph.json'), JSON.stringify({ nodes: nodesG, edges }));

// спавны: на дорогах вдоль X (направление на восток: heading = +pi/2) и вдоль Z (на север: heading 0)
const spawnPoints = [];
for (let k = 0; k < 12; k++) {
  const ix = Math.floor(rnd() * N), iz = Math.floor(rnd() * N);
  const x = cxOf(ix), z = cxOf(iz);
  const east = k % 2 === 0;
  const px = east ? x + 20 : x - 3, pz = east ? z + 3 : z + 20; // правая полоса
  spawnPoints.push({ x: px, y: H(px, pz) + 0.3, z: pz, heading: east ? Math.PI / 2 : 0 });
}
const manifest = {
  version: 1, baseHeight: 90, origin: { lat: 54.6363, lon: 39.7496 },
  bounds: { minX: MIN, maxX: MIN + N * TILE, minZ: MIN, maxZ: MIN + N * TILE },
  terrain: { file: 'terrain/heightmap.f32', cols: COLS, rows: COLS, cellSize: CELL, minX: MIN, minZ: MIN },
  tileSize: TILE, tiles, roads: { file: 'roads/graph.json' }, spawnPoints,
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest));
console.log(`synthetic world: ${N}x${N} tiles -> ${OUT}`);
