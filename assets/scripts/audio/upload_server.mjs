// Tiny local upload sink for the audio lab (game/audio-lab.html): POST /save?name=<file> body=bytes
// -> assets/audio/test_renders/<file>. Listens on 127.0.0.1:5199 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../audio/test_renders');
fs.mkdirSync(OUT, { recursive: true });
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  const u = new URL(req.url, 'http://x');
  const name = path.basename(u.searchParams.get('name') || '');
  if (req.method !== 'POST' || u.pathname !== '/save' || !/^[\w.-]+$/.test(name)) { res.statusCode = 400; res.end('bad'); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    fs.writeFileSync(path.join(OUT, name), buf);
    console.log('saved', name, buf.length);
    res.end('ok');
  });
}).listen(5199, '127.0.0.1', () => console.log('upload sink on http://127.0.0.1:5199 ->', OUT));
