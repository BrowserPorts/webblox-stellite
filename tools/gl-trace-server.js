'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TRACES = path.join(ROOT, '.cache', 'gl-traces');
const PORT = Number(process.env.GL_TRACE_PORT) || 3300;
const STATIC = {
  '/replay.html': path.join(__dirname, 'gl-replay.html'),
  '/replay.js': path.join(__dirname, 'gl-replay.js'),
  '/webgpu.js': path.join(ROOT, 'public', 'js', 'gl-webgpu.js'),
  '/gl-webgpu-key.js': path.join(ROOT, 'public', 'js', 'gl-webgpu-key.js'),
  '/wgsl-index.json': path.join(ROOT, 'public', 'gen', 'wgsl-index.json'),
  '/wgsl.txt': path.join(ROOT, 'public', 'gen', 'wgsl.txt'),
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const SAFE = /^[\w.-]+$/;
const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

const send = (res, file) => {
  res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'trace' && parts.length === 3 && SAFE.test(parts[1]) && SAFE.test(parts[2])) {
    const file = path.join(TRACES, parts[1], parts[2]);
    if (fs.existsSync(file)) return send(res, file);
  }
  const file = STATIC[url.pathname];
  if (file && fs.existsSync(file)) return send(res, file);
  res.writeHead(404, HEADERS);
  res.end('not found');
}).listen(PORT, '127.0.0.1', () => console.log(`[gl-trace] replay at http://localhost:${PORT}/replay.html?trace=<name>`));
