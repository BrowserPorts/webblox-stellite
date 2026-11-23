const zlib = require('zlib');
const crypto = require('crypto');
const { ISOLATION_HEADERS } = require('./shared');
const { decode, accepts } = require('./upstream');

const proxyCache = new Map();
const PROXY_CACHE_LIMIT = 256 * 1024 * 1024;
const SERVED_GRACE_MS = 30 * 1000;
const PROXY_ENTRY_LIMIT = 64 * 1024 * 1024;
let proxyCacheBytes = 0;
const proxyStats = { hits: 0, misses: 0, coalesced: 0, bytesServed: 0, prefetched: 0, prefetchSkipped: 0, retired: 0 };
const inflight = new Map();

const CACHEABLE_HOST = /(^|\.)(rbxcdn\.com|assetdelivery\.roblox\.com|contentdelivery\.roblox\.com|thumbnails\.roblox\.com|assetgame\.roblox\.com|clientsettingscdn\.roblox\.com|clientsettings\.roblox\.com|users\.roblox\.com)$/i;
const PROXY_CACHE_ALL = process.env.PROXY_CACHE_ALL === '1';
const BATCH_PATH = /\/v1\/assets\/batch$/;
const USERS_PATH = /\/v1\/users$/;
const THUMBNAIL_BATCH = /^thumbnails\.roblox\.com\/v1\/batch$/;
const PERSONAL_THUMBNAIL = /Avatar|Outfit/;
const THUMBNAIL_TTL_MS = 5 * 60 * 1000;
const LIVE_THUMBNAIL = /^thumbnails\.roblox\.com\/v1\/.*-3d$/;
const SHARED_HOST = /(^|\.)(rbxcdn\.com|contentdelivery\.roblox\.com|thumbnails\.roblox\.com)$/i;
const STEADY_API = [
  [/^avatar\.roblox\.com\/v1\/avatar-rules$/, 60 * 60 * 1000],
  [/^catalog\.roblox\.com\/v1\/(categories|subcategories)$/, 60 * 60 * 1000],
  [/^games\.roblox\.com\/v2\/games\/\d+\/media$/, 10 * 60 * 1000],
  [/^games\.roblox\.com\/v1\/games\/recommendations\/game\/\d+$/, 5 * 60 * 1000],
  [/^catalog\.roblox\.com\/v2\/recommendations\/assets$/, 5 * 60 * 1000],
  [/^voice\.roblox\.com\/v1\/settings\/universe\/\d+$/, 5 * 60 * 1000],
  [/^apis\.roblox\.com\/virtual-events\/v1\/universes\/\d+\/virtual-events$/, 5 * 60 * 1000],
];

function steadyApiTtl(method, url) {
  if (method !== 'GET') return 0;
  const route = url.hostname + url.pathname;
  return STEADY_API.find(([pattern]) => pattern.test(route))?.[1] || 0;
}

function isThumbnailBatch(method, url, body) {
  return method === 'POST' && THUMBNAIL_BATCH.test(url.hostname + url.pathname) && !PERSONAL_THUMBNAIL.test(String(body || ''));
}

function proxyCacheKey(method, url, targetUrl, body, session) {
  if (LIVE_THUMBNAIL.test(url.hostname + url.pathname)) return null;
  if (steadyApiTtl(method, url)) return `G ${targetUrl}`;
  if (!PROXY_CACHE_ALL && !CACHEABLE_HOST.test(url.hostname)) return null;
  const digest = () => crypto.createHash('sha1').update(body || Buffer.alloc(0)).digest('hex');
  if (isThumbnailBatch(method, url, body)) return `P ${targetUrl} ${digest()}`;
  const scope = SHARED_HOST.test(url.hostname) ? '' : ` ${session}`;
  if (method === 'GET' || method === 'HEAD') return `G ${targetUrl}${scope}`;
  if (method === 'POST' && (BATCH_PATH.test(url.pathname) || USERS_PATH.test(url.pathname))) return `P ${targetUrl} ${digest()}${scope}`;
  return null;
}

function proxyCacheTtl(method, headers) {
  const cc = String(headers['cache-control'] || '');
  const m = cc.match(/max-age=(\d+)/i);
  if (m) return Math.min(Number(m[1]), 30 * 24 * 3600) * 1000;
  if (/no-store/i.test(cc)) return 0;
  if (method === 'POST') return 10 * 60 * 1000;
  if (/no-cache/i.test(cc)) return 60 * 1000;
  return 60 * 60 * 1000;
}

const gzipAsync = data => new Promise((resolve, reject) => {
  zlib.gzip(data, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)));
});

const ENCODE_MIN = 64 * 1024;
const ENCODE_MAX = 512 * 1024;
const TEXTUAL = /json|javascript|text|xml|svg/i;

async function gzipOnce(entry, data) {
  if (entry && entry.gz) return entry.gz;
  if (entry && entry.gzPending) return entry.gzPending.catch(() => null);
  const pending = gzipAsync(data).catch(err => {
    console.error('[proxy] gzip failed:', err.message);
    return null;
  });
  if (entry) entry.gzPending = pending;
  const gz = await pending;
  if (entry) {
    entry.gzPending = null;
    if (gz) entry.gz = gz;
  }
  return gz;
}

async function sendProxied(req, res, { status, headers, body, encoding }, entry, label) {
  const out = { ...headers, ...ISOLATION_HEADERS };
  if (label) out['X-Local-Cache'] = label;
  let payload = body;
  if (encoding) {
    out.Vary = 'Accept-Encoding';
    if (accepts(req, encoding)) out['Content-Encoding'] = encoding;
    else payload = await decode(body, encoding);
  } else if (body.length > ENCODE_MIN && body.length <= ENCODE_MAX &&
             TEXTUAL.test(String(headers['content-type'] || '')) && accepts(req, 'gzip')) {
    const gz = await gzipOnce(entry, body);
    if (gz) {
      payload = gz;
      out['Content-Encoding'] = 'gzip';
      out.Vary = 'Accept-Encoding';
    }
  }
  out['Content-Length'] = payload.length;
  res.writeHead(status, out);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

function proxyCacheGet(key) {
  const hit = proxyCache.get(key);
  if (!hit) { proxyStats.misses++; return null; }
  if (hit.expires <= Date.now()) {
    proxyCache.delete(key);
    proxyCacheBytes -= hit.body.length;
    proxyStats.misses++;
    return null;
  }
  proxyCache.delete(key);
  proxyCache.set(key, hit);
  proxyStats.hits++;
  proxyStats.bytesServed += hit.body.length;
  return hit;
}

const PROXY_BROWSER_CACHE = process.env.PROXY_BROWSER_CACHE !== '0';
function browserCacheControl(hostname) {
  if (!PROXY_BROWSER_CACHE) return 'no-store';
  if (/(^|\.)rbxcdn\.com$/i.test(hostname)) return 'public, max-age=604800, immutable';
  return 'public, max-age=86400';
}

function proxyCacheSet(key, response, ttlMs) {
  const { status, headers, body, encoding } = response;
  if (!ttlMs || status !== 200 || !body || body.length > PROXY_ENTRY_LIMIT) return null;
  const old = proxyCache.get(key);
  if (old) {
    proxyCacheBytes -= old.body.length;
    proxyCache.delete(key);
  }
  const entry = { status, headers: { ...headers }, body, encoding, expires: Date.now() + ttlMs, gz: null, gzPending: null };
  proxyCache.set(key, entry);
  proxyCacheBytes += body.length;
  while (proxyCacheBytes > PROXY_CACHE_LIMIT && proxyCache.size > 1) {
    const [oldKey, oldEntry] = proxyCache.entries().next().value;
    proxyCache.delete(oldKey);
    proxyCacheBytes -= oldEntry.body.length;
  }
  return entry;
}

function retireServed(entry) {
  entry.expires = Math.min(entry.expires, Date.now() + SERVED_GRACE_MS);
}

function sweepExpired() {
  const now = Date.now();
  for (const [key, entry] of proxyCache) {
    if (entry.expires > now) continue;
    proxyCache.delete(key);
    proxyCacheBytes -= entry.body.length;
    proxyStats.retired++;
  }
}
setInterval(sweepExpired, 10 * 1000).unref();

const residentMB = () => +(proxyCacheBytes / 1048576).toFixed(1);

module.exports = {
  proxyCache,
  proxyStats,
  inflight,
  CACHEABLE_HOST,
  BATCH_PATH,
  USERS_PATH,
  THUMBNAIL_TTL_MS,
  steadyApiTtl,
  isThumbnailBatch,
  proxyCacheKey,
  proxyCacheTtl,
  proxyCacheGet,
  browserCacheControl,
  sendProxied,
  proxyCacheSet,
  retireServed,
  residentMB,
};
