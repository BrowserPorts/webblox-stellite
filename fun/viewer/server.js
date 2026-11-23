const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { encodePng } = require('../../tools/png');
const { readLevel, decode, textureRole, applyRole } = require('./lib/ktx2');
const { ASSETS_DIR } = require('../../server/config');
const lib = require('./lib/library');
const rig = require('./lib/rig');

const PORT = Number(process.env.VIEWER_PORT) || 3200;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TEX_DIR = path.join(lib.VIEWER_DIR, 'tex');
const BRAND_DIR = ASSETS_DIR;
const ICON_DIR = path.join(lib.VIEWER_DIR, 'icons');
const BRAND_FILES = {
  'BuilderSans-Regular.otf': path.join('loading', 'BuilderSans-Regular.otf'),
  'BuilderSans-Medium.otf': path.join('loading', 'BuilderSans-Medium.otf'),
  'BuilderSans-Bold.otf': path.join('loading', 'BuilderSans-Bold.otf'),
};
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.svg': 'image/svg+xml',
};

function sendJson(req, res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (body.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(status, headers);
    res.end(zlib.gzipSync(body, { level: 4 }));
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendFile(req, res, file, extra = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('File not found');
    return;
  }
  const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', ...extra };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(file).pipe(res);
}

function sendTexture(req, res, rel, size) {
  const file = lib.safePath(rel);
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Texture not found');
    return;
  }
  const cache = { 'Cache-Control': 'public, max-age=86400' };
  if (!file.endsWith('.ktx2')) return sendFile(req, res, file, cache);
  const stat = fs.statSync(file);
  const key = crypto.createHash('sha1').update(`2:${rel}:${stat.mtimeMs}:${size}`).digest('hex');
  const out = path.join(TEX_DIR, `${key}.png`);
  if (!fs.existsSync(out)) {
    const data = fs.readFileSync(file);
    const level = readLevel(data, size);
    const rgba = applyRole(decode(level), textureRole(data));
    fs.mkdirSync(TEX_DIR, { recursive: true });
    const temp = `${out}.${process.pid}.tmp`;
    fs.writeFileSync(temp, encodePng(level.width, level.height, rgba, { fast: true }));
    fs.renameSync(temp, out);
  }
  sendFile(req, res, out, cache);
}

async function sendIcon(req, res, place) {
  if (!/^\d+$/.test(place || '')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const file = path.join(ICON_DIR, `${place}.png`);
  if (!fs.existsSync(file)) {
    const lookup = await fetch(`https://thumbnails.roblox.com/v1/places/gameicons?placeIds=${place}&size=256x256&format=Png&isCircular=false`);
    const url = lookup.ok ? (await lookup.json()).data?.[0]?.imageUrl : null;
    const image = url ? await fetch(url) : null;
    if (!image || !image.ok) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('This game has no icon.');
      return;
    }
    fs.mkdirSync(ICON_DIR, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await image.arrayBuffer()));
  }
  sendFile(req, res, file, { 'Cache-Control': 'public, max-age=86400' });
}

function route(req, res) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const q = url.searchParams;
  switch (url.pathname) {
    case '/api/games': {
      const hasFiles = fs.existsSync(lib.FILES_DIR);
      return sendJson(req, res, 200, { games: lib.listGames(), folder: lib.FILES_DIR, hasFiles });
    }
    case '/api/assets': {
      const library = lib.library(q.get('game') || '');
      const items = library.items.filter(item => item.origin !== 'avatar');
      return sendJson(req, res, 200, { items: items.map(lib.publicItem), recorded: library.recorded });
    }
    case '/api/asset': {
      const detail = lib.assetDetail(q.get('game') || '', q.get('uid') || '');
      return detail ? sendJson(req, res, 200, detail) : sendJson(req, res, 404, { error: 'This asset is no longer in the cache.' });
    }
    case '/api/animation': {
      const data = lib.animationData(q.get('rel'));
      return data ? sendJson(req, res, 200, data) : sendJson(req, res, 404, { error: 'This file has no animation in it.' });
    }
    case '/api/model': {
      const data = lib.modelScene(q.get('game') || '', q.get('rel'));
      return data ? sendJson(req, res, 200, data) : sendJson(req, res, 404, { error: 'This model could not be read.' });
    }
    case '/api/rig-scene': {
      const data = lib.rigScene(q.get('game') || '', q.get('key') || '');
      return data ? sendJson(req, res, 200, data) : sendJson(req, res, 404, { error: 'This rig is no longer recorded.' });
    }
    case '/api/rig':
      return sendJson(req, res, 200, { status: rig.state.status, error: rig.state.error, version: rig.state.version, rigs: rig.state.rigs });
    case '/rig-file': {
      const name = path.basename(q.get('name') || '');
      if (!rig.state.dir || !name) break;
      return sendFile(req, res, path.join(rig.state.dir, name), { 'Cache-Control': 'public, max-age=86400' });
    }
    case '/file': {
      const file = lib.safePath(q.get('rel'));
      if (!file) break;
      return sendFile(req, res, file, { 'Cache-Control': 'public, max-age=3600' });
    }
    case '/icon':
      return void sendIcon(req, res, q.get('place')).catch(() => {
        if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('This game has no icon.');
      });
    case '/tex':
      return sendTexture(req, res, q.get('rel'), Number(q.get('size')) || 0);
    default: {
      if (url.pathname.startsWith('/brand/')) {
        const brand = BRAND_FILES[url.pathname.slice(7)];
        if (brand) return sendFile(req, res, path.join(BRAND_DIR, brand), { 'Cache-Control': 'public, max-age=86400' });
        break;
      }
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(PUBLIC_DIR, rel);
      if (file.startsWith(PUBLIC_DIR + path.sep)) return sendFile(req, res, file);
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

http.createServer((req, res) => {
  try {
    route(req, res);
  } catch (err) {
    console.error('[viewer]', req.url, err.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Could not read this asset: ${err.message}`);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\nAsset viewer running at http://localhost:${PORT}/\nReading ${lib.FILES_DIR}\n`);
  rig.ensureRig();
});
