const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { BASE, PUBLIC_DIR, ASSETS_DIR, ENGINE_DIR, GEN_DIR, ENGINE_URL, INDEX_FILE } = require('./config');
const { ISOLATION_HEADERS, hasToken, tokenCookie } = require('./shared');
const { clientId, newClientCookie } = require('./delivered');
const { leavePlace } = require('./place-cache');
const { eraFile, eraMetadata, requestEra, eraList } = require('./ui-eras');

const WASM_URL = `${ENGINE_URL}WebClient.wasm`;

const SERVER_MARKER = '<script>window.WEBLOX_SERVER=!0<\/script>';
function injectServerMarker(buf) {
  const html = buf.toString('utf8');
  const at = html.indexOf('<head>');
  if (at < 0) return buf;
  const cut = at + '<head>'.length;
  return Buffer.from(html.slice(0, cut) + SERVER_MARKER + html.slice(cut));
}

let interceptorTag = null;
function bodyVariant(filePath) {
  if (filePath.endsWith('WebClient.js')) {
    interceptorTag ??= crypto.createHash('sha1').update(XHR_INTERCEPTOR).digest('hex').slice(0, 8);
    return `-x${interceptorTag}`;
  }
  if (filePath === INDEX_FILE) return '-s';
  return '';
}

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.otf':  'font/otf',
  '.ttf':  'font/ttf',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.rbxm': 'application/octet-stream',
  '.rbxl': 'application/octet-stream',
  '.mesh': 'application/octet-stream',
  '.tex':  'application/octet-stream',
};

function getMime(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const XHR_INTERCEPTOR = `
(function(){
  var origin = self.location ? self.location.origin : '';
  if (!origin) try { origin = new URL(self.location.href).origin; } catch {}
  var proxyPrefix = origin + '/__proxy__/';
  var eraTag = '';
  try {
    var eraRequest = new XMLHttpRequest();
    eraRequest.open('GET', origin + '/__uiera', false);
    eraRequest.send();
    if (eraRequest.status === 200 && eraRequest.responseText) eraTag = '?uiera=' + encodeURIComponent(eraRequest.responseText);
  } catch {}
  var eraAsset = /\\/(ExtraContent\\/LuaPackages|ExtraContent\\/textures|content\\/textures\\/ui)\\//i;
  function tagged(url) {
    if (!eraTag || typeof url !== 'string' || url.indexOf('?') >= 0 || !eraAsset.test(url)) return url;
    return url + eraTag;
  }
  function isCrossOrigin(url) {
    if (!url) return false;
    try {
      if (!/^https?:\\/\\//i.test(url)) return false;
      return new URL(url).origin !== origin;
    } catch { return false; }
  }
  var quickLogin = /^https:\\/\\/(?:apis\\.roblox\\.com\\/auth-token-service\\/v1\\/login\\/(create|status|cancel)|auth\\.roblox\\.com\\/v2\\/(login))(?:[?#]|$)/;
  var quickLoginChannel = null;
  function watchQuickLogin(xhr, url) {
    var match = quickLogin.exec(url);
    if (!match || typeof BroadcastChannel === 'undefined') return;
    xhr.addEventListener('load', function() {
      var body = '';
      try { body = typeof xhr.response === 'string' ? xhr.response : new TextDecoder().decode(xhr.response); } catch {}
      var status = '';
      try { status = JSON.parse(body).status || ''; } catch {}
      if (!status && body.indexOf('CodeInvalid') >= 0) status = 'CodeInvalid';
      quickLoginChannel = quickLoginChannel || new BroadcastChannel('webblox-quick-login');
      quickLoginChannel.postMessage({ step: match[1] || match[2], status: status, httpStatus: xhr.status });
    });
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    var _xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      if (typeof url === 'string' && isCrossOrigin(url)) {
        watchQuickLogin(this, url);
        arguments[1] = proxyPrefix + url;
      } else arguments[1] = tagged(url);
      return _xhrOpen.apply(this, arguments);
    };
  }
  if (typeof fetch === 'function') {
    var _fetch = self.fetch;
    self.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url);
      if (typeof url === 'string' && isCrossOrigin(url)) {
        var newUrl = proxyPrefix + url;
        if (typeof input === 'string') arguments[0] = newUrl;
        else if (input && typeof input === 'object') arguments[0] = new Request(newUrl, input);
      } else if (typeof input === 'string') {
        arguments[0] = tagged(input);
      }
      return _fetch.apply(self, arguments);
    };
  }
})();
`;

const ENC_DIR = path.join(BASE, '.cache', 'enc');
try { fs.mkdirSync(ENC_DIR, { recursive: true }); } catch {}

const ENC_BUDGET = 192 * 1024 * 1024;
function pruneEncodedCache() {
  let names;
  try { names = fs.readdirSync(ENC_DIR); } catch { return; }
  const files = [];
  let total = 0;
  for (const name of names) {
    const full = path.join(ENC_DIR, name);
    try {
      const st = fs.statSync(full);
      files.push({ full, size: st.size, mtime: st.mtimeMs });
      total += st.size;
    } catch {}
  }
  if (total <= ENC_BUDGET) return;
  files.sort((a, b) => a.mtime - b.mtime);
  let removed = 0;
  let freed = 0;
  for (const f of files) {
    if (total <= ENC_BUDGET) break;
    try { fs.unlinkSync(f.full); total -= f.size; freed += f.size; removed++; } catch {}
  }
  if (removed) console.log(`[encode] pruned ${removed} stale entries (${(freed / 1048576).toFixed(1)}MB)`);
}

const COMPRESSIBLE = /\.(js|mjs|json|svg|html|css|txt|xml|map)$/i;
const VOLATILE_ASSETS = /(WasmPlayer\.js|WebFlags\.json|PinnedFlags\.json|logo_white_1x\.png|img_set_1x_1\.png|img_set_2x_3\.png|img_set_3x_3\.png|UniversalApp\.rbxm|InExperience\.rbxm|favicon\.svg|webblox-wordmark\.png)$/i;

const fileCache = new Map();
const FILE_CACHE_LIMIT = 128 * 1024 * 1024;
const FILE_BODY_LIMIT = 4 * 1024 * 1024;
let fileCacheBytes = 0;
const fileLoads = new Map();
const assetStats = { served: 0, bytes: 0, notModified: 0, gzipHits: 0 };

const statCache = new Map();
const resolveCache = new Map();
let watching = false;

function statOf(filePath) {
  if (watching && statCache.has(filePath)) return statCache.get(filePath);
  let stat = null;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) stat = null;
  } catch {}
  if (watching) statCache.set(filePath, stat);
  return stat;
}

function etagFor(stat) {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function cacheableAsset(filePath) {
  return filePath.startsWith(ENGINE_DIR) || filePath.startsWith(ASSETS_DIR);
}

function transformBody(filePath, buf) {
  if (filePath.endsWith('WebClient.js')) return Buffer.concat([Buffer.from(XHR_INTERCEPTOR), buf]);
  if (filePath === INDEX_FILE) return injectServerMarker(buf);
  return buf;
}

function rememberBody(filePath, entry) {
  const old = fileCache.get(filePath);
  if (old) {
    fileCacheBytes -= old.buf.length;
    fileCache.delete(filePath);
  }
  fileCache.set(filePath, entry);
  fileCacheBytes += entry.buf.length;
  while (fileCacheBytes > FILE_CACHE_LIMIT && fileCache.size > 1) {
    const [oldPath, oldEntry] = fileCache.entries().next().value;
    fileCache.delete(oldPath);
    fileCacheBytes -= oldEntry.buf.length;
  }
}

async function readPayload(filePath, stat) {
  const etag = etagFor(stat) + bodyVariant(filePath);
  const cached = fileCache.get(filePath);
  if (cached && cached.etag === etag) {
    fileCache.delete(filePath);
    fileCache.set(filePath, cached);
    return cached;
  }
  const loadKey = `${filePath}\0${etag}`;
  let load = fileLoads.get(loadKey);
  if (!load) {
    load = fs.promises.readFile(filePath).then(raw => {
      const entry = { buf: transformBody(filePath, raw), etag, gzip: null, gzipPending: null };
      rememberBody(filePath, entry);
      return entry;
    }).finally(() => fileLoads.delete(loadKey));
    fileLoads.set(loadKey, load);
  }
  return load;
}

const gzipAsync = buf => new Promise((resolve, reject) => {
  zlib.gzip(buf, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)));
});

async function gzipFor(filePath, entry) {
  if (entry.gzip) return entry.gzip;
  if (entry.gzipPending) return entry.gzipPending;
  const key = crypto.createHash('sha1').update(`${filePath}:${entry.etag}`).digest('hex');
  const diskPath = path.join(ENC_DIR, `${key}.gz`);
  entry.gzipPending = fs.promises.readFile(diskPath).catch(async () => {
    const out = await gzipAsync(entry.buf);
    fs.promises.writeFile(diskPath, out).catch(() => {});
    return out;
  }).then(out => {
    entry.gzip = out;
    entry.gzipPending = null;
    return out;
  });
  return entry.gzipPending;
}

const BIG_COMPRESSIBLE = /\.wasm$/i;
const bigEncoded = new Map();
const bigPending = new Set();

function statKey(stat) {
  return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
}

function encodedPath(filePath, enc, key) {
  const hash = crypto.createHash('sha1').update(`${filePath}:${key}`).digest('hex');
  return path.join(ENC_DIR, `${hash}.${enc}`);
}

function bigEntry(filePath, stat) {
  const key = statKey(stat);
  let entry = bigEncoded.get(filePath);
  if (!entry || entry.key !== key) {
    entry = { key, zstd: null, zstdLoading: false };
    bigEncoded.set(filePath, entry);
  }
  return entry;
}

function compressBig(filePath, enc, entry, diskPath) {
  if (bigPending.has(diskPath)) return;
  bigPending.add(diskPath);
  const started = Date.now();
  fs.promises.readFile(filePath)
    .then(src => new Promise((resolve, reject) => {
      const done = (err, out) => (err ? reject(err) : resolve(out));
      if (enc === 'zstd') zlib.zstdCompress(src, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }, done);
      else zlib.gzip(src, { level: 6 }, done);
    }))
    .then(async out => {
      await fs.promises.writeFile(diskPath, out);
      const current = bigEncoded.get(filePath);
      if (enc === 'zstd' && current && current.key === entry.key) current.zstd = out;
      console.log(`[encode] ${path.basename(filePath)} ${enc} ${(out.length / 1048576).toFixed(1)}MB in ${Date.now() - started}ms`);
    })
    .catch(err => console.error(`[encode] ${enc} failed:`, err.message))
    .finally(() => bigPending.delete(diskPath));
}

function loadZstd(filePath, entry, diskPath) {
  if (entry.zstd || entry.zstdLoading) return;
  entry.zstdLoading = true;
  fs.promises.readFile(diskPath)
    .then(out => {
      const current = bigEncoded.get(filePath);
      if (current && current.key === entry.key) current.zstd = out;
    })
    .catch(() => {})
    .finally(() => { entry.zstdLoading = false; });
}

function ensureEncoded(filePath, enc, stat) {
  const entry = bigEntry(filePath, stat);
  if (enc === 'zstd' && entry.zstd) return { buf: entry.zstd };
  const diskPath = encodedPath(filePath, enc, entry.key);
  let size = 0;
  try { size = fs.statSync(diskPath).size; } catch {}
  if (size) {
    if (enc === 'zstd') loadZstd(filePath, entry, diskPath);
    return { path: diskPath, size };
  }
  compressBig(filePath, enc, entry, diskPath);
  return null;
}

function warmEncodedAssets() {
  const wasm = path.join(ENGINE_DIR, 'WebClient.wasm');
  const stat = statOf(wasm);
  if (!stat || stat.size <= FILE_BODY_LIMIT) return;
  setTimeout(() => {
    const zstd = typeof zlib.zstdCompress === 'function';
    for (const enc of zstd ? ['zstd', 'gzip'] : ['gzip']) {
      const body = ensureEncoded(wasm, enc, stat);
      if (body) console.log(`[encode] wasm ${enc} already built (${((body.size || body.buf.length) / 1048576).toFixed(1)}MB)`);
    }
  }, 250);
}

const SERVE_LOG = process.env.SERVE_LOG === '1';

function sendBody(req, res, status, headers, body) {
  headers['Content-Length'] = body.length;
  assetStats.served++;
  assetStats.bytes += body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// The CJK font is 16 MB and the engine fetches it on every start. A browser whose languages include none of Chinese,
// Japanese or Korean goes without it, at the cost of those scripts drawing as boxes in names and chat
const CJK_FONT = /NotoSansCJK[^/]*\.otf$/i;
const wantsCjk = req => /(?:^|[\s,])(?:zh|ja|ko)\b/i.test(req.headers['accept-language'] || '');

async function sendFile(req, res, requestedPath) {
  if (CJK_FONT.test(requestedPath) && !wantsCjk(req)) {
    res.writeHead(404, ISOLATION_HEADERS);
    res.end();
    return;
  }
  const filePath = eraFile(req, requestedPath);
  const stat = statOf(filePath);
  if (!stat) {
    res.writeHead(404, ISOLATION_HEADERS);
    res.end();
    return;
  }
  if (SERVE_LOG) console.log(`[serve] ${(stat.size / 1048576).toFixed(2)}MB ${path.relative(BASE, filePath)}`);
  const mime = getMime(filePath);
  const cacheable = cacheableAsset(filePath);
  const immutable = cacheable && !VOLATILE_ASSETS.test(filePath);
  const acceptsEncoding = req.headers['accept-encoding'] || '';
  const zstdOk = typeof zlib.zstdCompress === 'function';
  let encoding = null;
  if (BIG_COMPRESSIBLE.test(filePath) && stat.size > FILE_BODY_LIMIT) {
    if (zstdOk && /\bzstd\b/.test(acceptsEncoding)) encoding = 'zstd';
    else if (/\bgzip\b/.test(acceptsEncoding)) encoding = 'gzip';
  }
  const variant = bodyVariant(filePath) + (encoding ? `-${encoding}` : '');
  const headers = {
    'Content-Type': mime,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'ETag': `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${variant}"`,
    'Last-Modified': stat.mtime.toUTCString(),
    ...ISOLATION_HEADERS,
  };
  let staleBundle = false;
  if (filePath === INDEX_FILE) {
    headers.Link = `<${WASM_URL}>; rel=preload; as=fetch; crossorigin`;
    const epoch = currentBundleEpoch();
    const cookie = (req.headers.cookie || '').match(EPOCH_COOKIE_PATTERN);
    const cookies = [];
    if (!clientId(req)) cookies.push(newClientCookie());
    else leavePlace(clientId(req));
    if (!hasToken(req)) cookies.push(tokenCookie());
    if (!cookie || cookie[1] !== epoch) {
      staleBundle = true;
      headers['Clear-Site-Data'] = '"cache"';
      cookies.push(`${EPOCH_COOKIE}=${epoch}; Path=/; Max-Age=31536000; SameSite=Strict`);
      console.log(`[assets] bundle changed (${epoch}); telling the browser to drop its cache`);
    }
    if (cookies.length) headers['Set-Cookie'] = cookies;
  }

  if (!staleBundle && req.headers['if-none-match'] === headers.ETag) {
    assetStats.notModified++;
    delete headers['Content-Type'];
    if (encoding) headers.Vary = 'Accept-Encoding';
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (encoding) {
    const body = ensureEncoded(filePath, encoding, stat);
    if (body) {
      headers['Content-Encoding'] = encoding;
      headers.Vary = 'Accept-Encoding';
      headers['Accept-Ranges'] = 'none';
      headers['X-Decoded-Length'] = stat.size;
      assetStats.gzipHits++;
      if (body.buf) return sendBody(req, res, 200, headers, body.buf);
      headers['Content-Length'] = body.size;
      assetStats.served++;
      assetStats.bytes += body.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(body.path, { highWaterMark: 1024 * 1024 }).pipe(res);
      return;
    }
  }

  if (stat.size <= FILE_BODY_LIMIT) {
    const entry = await readPayload(filePath, stat);
    if (COMPRESSIBLE.test(filePath) && /\bgzip\b/.test(acceptsEncoding) && entry.buf.length > 1024) {
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
      assetStats.gzipHits++;
      return sendBody(req, res, 200, headers, await gzipFor(filePath, entry));
    }
    return sendBody(req, res, 200, headers, entry.buf);
  }

  const extra = filePath.endsWith('WebClient.js') ? XHR_INTERCEPTOR.length : 0;
  headers['Content-Length'] = stat.size + extra;
  headers['Accept-Ranges'] = 'bytes';
  assetStats.served++;
  assetStats.bytes += stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  if (extra) res.write(XHR_INTERCEPTOR);
  fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }).pipe(res);
}

const basenameIndex = new Map();
function indexBundle(dir, prefix = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      indexBundle(full, rel);
    } else if (entry.isFile()) {
      const key = entry.name.toLowerCase();
      const list = basenameIndex.get(key);
      const record = { full, rel };
      if (list) list.push(record); else basenameIndex.set(key, [record]);
    }
  }
}

function findBySuffix(urlPath) {
  const wanted = urlPath.split('/').filter(Boolean).map(s => s.toLowerCase());
  if (!wanted.length) return null;
  const candidates = basenameIndex.get(wanted[wanted.length - 1]);
  if (!candidates || !candidates.length) return null;
  let best = null;
  let bestScore = -1;
  for (const record of candidates) {
    const have = record.rel.split('/').map(s => s.toLowerCase());
    let score = 0;
    while (score < have.length && score < wanted.length &&
           have[have.length - 1 - score] === wanted[wanted.length - 1 - score]) score++;
    if (score > bestScore) { bestScore = score; best = record; }
  }
  if (bestScore >= 2 || (bestScore >= 1 && candidates.length === 1)) {
    if (basenameFallbacks.size < 200) basenameFallbacks.add(urlPath);
    return best.full;
  }
  return null;
}
function indexAll() {
  indexBundle(ENGINE_DIR);
}
indexAll();
const METADATA_FILE = path.join(ENGINE_DIR, 'WebClient.metadata.json');

const missingAssetLog = new Set();

let patchedMetadata = null;

let bundleEpoch = null;
function currentBundleEpoch() {
  if (bundleEpoch) return bundleEpoch;
  const hash = crypto.createHash('sha1');
  hash.update(XHR_INTERCEPTOR);
  for (const records of basenameIndex.values()) {
    for (const record of records) {
      const st = statOf(record.full);
      if (st) hash.update(`${record.rel}:${st.size}:${Math.floor(st.mtimeMs)}\n`);
    }
  }
  bundleEpoch = hash.digest('base64url').slice(0, 16);
  return bundleEpoch;
}
const EPOCH_COOKIE = 'webblox_bundle';
const EPOCH_COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)${EPOCH_COOKIE}=([^;]+)`);

let metadataStaleTimer = null;
function onPublicChange(event, name) {
  statCache.clear();
  resolveCache.clear();
  const rel = String(name || '');
  if (rel.startsWith('gen') && !rel.includes('metadata')) return;
  if (metadataStaleTimer) return;
  metadataStaleTimer = setTimeout(() => {
    metadataStaleTimer = null;
    patchedMetadata = null;
    bundleEpoch = null;
    basenameIndex.clear();
    indexAll();
    warmStatic();
  }, 250);
  metadataStaleTimer.unref?.();
}
try {
  fs.watch(PUBLIC_DIR, { recursive: true }, onPublicChange).unref?.();
  watching = true;
} catch (err) {
  console.warn(`[assets] cannot watch ${PUBLIC_DIR} (${err.message}); file lookups will not be cached`);
}

function warmStatic() {
  setImmediate(() => {
    currentBundleEpoch();
    patchedMetadata ??= buildPatchedMetadata(METADATA_FILE);
  });
}

function buildPatchedMetadata(filePath) {
  const sizes = new Map();
  for (const records of basenameIndex.values()) {
    for (const record of records) {
      const st = statOf(record.full);
      if (st) sizes.set(record.rel, st.size);
    }
  }
  const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let corrected = 0;
  for (const entry of list) {
    const actual = sizes.get(String(entry.path || '').replace(/^\//, ''));
    if (actual !== undefined && actual !== entry.size) {
      entry.size = actual;
      corrected++;
    }
  }

  const known = new Set(list.map(e => String(e.path || '').replace(/^\//, '').toLowerCase()));
  let added = 0;
  for (const records of basenameIndex.values()) {
    for (const record of records) {
      if (!/^(content|ExtraContent|PlatformContent|shaders)\//i.test(record.rel)) continue;
      if (known.has(record.rel.toLowerCase())) continue;
      const st = statOf(record.full);
      if (!st) continue;
      list.push({ path: `/${record.rel}`, size: st.size });
      known.add(record.rel.toLowerCase());
      added++;
    }
  }

  const body = Buffer.from(JSON.stringify(list));
  const tag = crypto.createHash('sha1').update(body).digest('base64url').slice(0, 22);
  console.log(`[assets] metadata reconciled: ${corrected} size(s) corrected, ${added} file(s) added, ${list.length} entries`);
  return { body, gzip: zlib.gzipSync(body, { level: 6 }), tag };
}

function serveUiEra(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
  res.end(requestEra(req) || '');
}

function serveUiEras(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
  res.end(JSON.stringify(eraList()));
}

function serveMetadata(req, res, filePath) {
  patchedMetadata ??= buildPatchedMetadata(filePath);
  const { body: metaBody, gzip: metaGzip, tag } = eraMetadata(req, patchedMetadata);
  const etag = `"meta-${tag}"`;
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    ETag: etag,
    ...ISOLATION_HEADERS,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const payload = acceptsGzip ? metaGzip : metaBody;
  if (acceptsGzip) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = payload.length;
  res.writeHead(200, headers);
  res.end(payload);
}

function serveLauncher(req, res) {
  const cookies = [];
  if (!clientId(req)) cookies.push(newClientCookie());
  else leavePlace(clientId(req));
  if (!hasToken(req)) cookies.push(tokenCookie());
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
  if (cookies.length) headers['Set-Cookie'] = cookies;
  fs.readFile(path.join(PUBLIC_DIR, 'launcher', 'index.html'), (err, page) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('The launcher page is missing.');
      return;
    }
    res.writeHead(200, headers);
    res.end(injectServerMarker(page));
  });
}

function tryFile(filePath) {
  return statOf(filePath) !== null;
}

function locateFile(urlPath) {
  if (urlPath === '/') {
    return INDEX_FILE;
  }

  if (urlPath.startsWith(ENGINE_URL)) {
    const rel = urlPath.slice(ENGINE_URL.length);
    const engineFile = path.join(ENGINE_DIR, rel);
    if (tryFile(engineFile)) return engineFile;
    return findBySuffix(rel);
  }

  if (urlPath.split('/').some(seg => seg.startsWith('.'))) return null;
  const localFile = urlPath.startsWith('/gen/') ? path.join(GEN_DIR, urlPath.slice(5)) : path.join(PUBLIC_DIR, urlPath.slice(1));
  if (tryFile(localFile)) return localFile;

  return findBySuffix(urlPath);
}

function resolveFile(urlPath) {
  if (!watching) return locateFile(urlPath);
  if (resolveCache.has(urlPath)) return resolveCache.get(urlPath);
  const found = locateFile(urlPath);
  if (resolveCache.size > 20000) resolveCache.clear();
  resolveCache.set(urlPath, found);
  return found;
}

const basenameFallbacks = new Set();

const fileCacheMB = () => +(fileCacheBytes / 1048576).toFixed(1);

module.exports = { serveLauncher,
  sendFile,
  serveUiEra,
  serveUiEras,
  serveMetadata,
  resolveFile,
  missingAssetLog,
  pruneEncodedCache,
  warmEncodedAssets,
  warmStatic,
  METADATA_FILE,
  assetStats,
  fileCacheMB,
};
