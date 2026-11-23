const { PROXY_LOG } = require('./config');
const { ISOLATION_HEADERS, SKIP_RESPONSE_HEADERS, ROBLOX_HOST, COOKIE_HOST, CDN_ASSET_HOST, readBody } = require('./shared');
const { clientId, markDelivered } = require('./delivered');
const { cookieHeader, storeCookies, sessionKey } = require('./session');
const { handleGameJoin, launcherJoin } = require('./join');
const { proxyStats, inflight, CACHEABLE_HOST, BATCH_PATH, USERS_PATH, THUMBNAIL_TTL_MS, steadyApiTtl, isThumbnailBatch, proxyCacheKey, proxyCacheTtl, proxyCacheGet, browserCacheControl, sendProxied, proxyCacheSet, retireServed } = require('./proxy-cache');
const { prefetchLocations, promotePrefetch } = require('./prefetch');
const { noteBatch, noteAsset } = require('./place-cache');
const upstream = require('./upstream');
const { splitEraBatch, eraAssetRequest, readEraAsset } = require('./ui-eras');

const PROXY_PREFIX = '/__proxy__/';

const ASSET_LOG = process.env.ASSET_LOG === '1';
const refusedAssets = new Map();
const requestedAssets = [];
function auditBatch(request, response) {
  if (!Array.isArray(request) || !Array.isArray(response)) return;
  const byRequestId = new Map(request.map(item => [String(item.requestId), item]));
  for (const item of response) {
    if (item && !item.errors && requestedAssets.length < 20000) {
      const asked = byRequestId.get(String(item.requestId)) || {};
      const { requestId, ...fields } = asked;
      const location = item.locations?.[0] || {};
      requestedAssets.push({ ...fields, assetTypeId: item.assetTypeId, assetFormat: location.assetFormat, metadata: location.assetMetadatas || item.assetMetadatas, contentRepresentation: item.contentRepresentationSpecifier });
    }
    if (!item || !Array.isArray(item.errors) || !item.errors.length) continue;
    const asked = byRequestId.get(String(item.requestId)) || {};
    const id = asked.assetId ?? asked.assetVersionId ?? asked.contentRepresentation ?? '?';
    const error = item.errors[0];
    const key = `${id}:${error.code}`;
    const entry = refusedAssets.get(key) || { id, type: asked.assetType || item.assetTypeId || null, code: error.code, message: error.message, count: 0 };
    entry.count++;
    refusedAssets.set(key, entry);
    if (entry.count === 1) console.log(`[assets] refused id=${id} type=${entry.type} code=${error.code} ${error.message}`);
  }
}

const SKIP_REQUEST_HEADERS = new Set([
  'host', 'origin', 'referer', 'connection', 'accept-encoding', 'cookie',
  'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'sec-ch-ua',
  'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'service-worker',
  'content-length', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
]);

function buildProxyHeaders(req, url, isRoblox) {
  const headers = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (!SKIP_REQUEST_HEADERS.has(key)) headers[key] = val;
  }
  if (isRoblox) {
    headers.origin = 'https://play.roblox.com';
    headers.referer = 'https://play.roblox.com/';
    const cookies = COOKIE_HOST.test(url.hostname) && cookieHeader(req);
    if (cookies) headers.cookie = cookies;
    if (headers['user-agent']) headers['user-agent'] = headers['user-agent'].replace(/Claude\/[\d.]+\s*/, '');
  } else {
    headers.origin = url.origin;
    headers.referer = url.origin + '/';
  }
  return headers;
}

function responseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!SKIP_RESPONSE_HEADERS.has(k)) out[k] = v;
  }
  return out;
}

const elapsed = () => `@${(performance.now() / 1000).toFixed(2)}s`;

const APP_POLICY_URL = /^https:\/\/apis\.roblox\.com\/guac-v2\/v1\/bundles\/app-policy(?:[?#]|$)/;
const APP_POLICY_OVERRIDES = { EnableWebViewSupport: true };

async function patchAppPolicy(response) {
  try {
    const policy = JSON.parse((await upstream.decode(response.body, response.encoding)).toString('utf8'));
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return response;
    Object.assign(policy, APP_POLICY_OVERRIDES);
    const headers = { ...response.headers };
    delete headers.etag;
    return { ...response, headers, body: Buffer.from(JSON.stringify(policy)), encoding: '' };
  } catch {
    return response;
  }
}

async function readText(response) {
  try {
    return (await upstream.decode(response.body, response.encoding)).toString('utf8');
  } catch {
    return null;
  }
}

const IN_APP_UA = ' RobloxApp/0.745.0.7451145 (GlobalDist; RobloxDirectDownload)';
const FRAME_BLOCKING_HEADERS = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only'];
const FRAME_SCRIPT = `<script>(function(){var P=location.origin+'/__proxy__/';function w(u){try{var x=new URL(u,document.baseURI);if(x.origin===location.origin||!/^https?:$/.test(x.protocol))return null;return P+x.href}catch(e){return null}}document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a||e.defaultPrevented||a.target==='_blank')return;var u=w(a.href);if(u){e.preventDefault();location.href=u}},true);document.addEventListener('submit',function(e){var f=e.target;if(!f||(f.method||'get').toLowerCase()!=='get')return;var u=w(f.action);if(u){e.preventDefault();location.href=u+(u.indexOf('?')<0?'?':'&')+new URLSearchParams(new FormData(f))}},true);['pushState','replaceState'].forEach(function(k){var o=history[k];history[k]=function(s,t,u){if(u!=null){var p=w(u);if(p)u=p.slice(location.origin.length)}return o.call(this,s,t,u)}})})()</script>`;

async function framePage(response, finalUrl) {
  try {
    let html = (await upstream.decode(response.body, response.encoding)).toString('utf8');
    const head = html.match(/<head[^>]*>/i);
    const inject = `<base href="${finalUrl.href.replace(/"/g, '&quot;')}">${FRAME_SCRIPT}`;
    html = head ? html.slice(0, head.index + head[0].length) + inject + html.slice(head.index + head[0].length) : inject + html;
    const headers = { ...response.headers };
    for (const name of FRAME_BLOCKING_HEADERS) delete headers[name];
    delete headers.etag;
    return { ...response, headers, body: Buffer.from(html), encoding: '' };
  } catch {
    return response;
  }
}

function delivered(client, url, entry, response) {
  markDelivered(client, url);
  noteAsset(client, url, response);
  if (entry) retireServed(entry);
}

async function recordBatch(client, body, response) {
  const text = await readText(response);
  if (!text) return;
  try { noteBatch(client, JSON.parse(String(body || '[]')), JSON.parse(text)); } catch {}
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const THUMBNAIL_NOT_READY = /"state":"(?!Completed")/;
const FIRE_AND_FORGET = [
  [/^ecsv2\.roblox\.com\/(client|timespent)\/pbe$/, 202],
  [/^ephemeralcounters\.api\.roblox\.com\//, 200],
];
const csrfTokens = new Map();
const CSRF_SESSIONS = 200;

const ERA_ASSET_CACHE = 'public, max-age=604800';

function sendEraAsset(res, file) {
  const { body, mime } = readEraAsset(file);
  if (ASSET_LOG) console.log(`[ui-era] served ${file}`);
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': body.length, 'Cache-Control': ERA_ASSET_CACHE, ...ISOLATION_HEADERS });
  res.end(body);
}

function sendEraBatch(res, answers) {
  const body = Buffer.from(JSON.stringify(answers));
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length, ...ISOLATION_HEADERS });
  res.end(body);
}

async function mergeEraBatch(res, local, response) {
  const text = await readText(response);
  let answers = [];
  try { answers = JSON.parse(text); } catch {}
  sendEraBatch(res, local.concat(Array.isArray(answers) ? answers : []));
}

async function handleProxy(req, res, targetUrl) {
  let url;
  try { url = new URL(targetUrl); } catch {
    res.writeHead(400, ISOLATION_HEADERS);
    res.end('Invalid proxy target URL');
    return;
  }
  if (/(^|\.)localhost$/i.test(url.hostname)) {
    res.writeHead(204, ISOLATION_HEADERS);
    res.end();
    return;
  }
  const eraAsset = req.method === 'GET' ? eraAssetRequest(req, url) : null;
  if (eraAsset) {
    sendEraAsset(res, eraAsset);
    return;
  }
  const isRoblox = ROBLOX_HOST.test(url.hostname);
  const headers = buildProxyHeaders(req, url, isRoblox);
  const dest = req.headers['sec-fetch-dest'];
  const framed = dest === 'iframe' || dest === 'document';
  if (framed && isRoblox && headers['user-agent'] && !headers['user-agent'].includes('RobloxApp/')) headers['user-agent'] += IN_APP_UA;
  const route = `${req.method} ${url.hostname}${url.pathname}`;
  const client = clientId(req);
  const isAsset = req.method === 'GET' && CDN_ASSET_HOST.test(url.hostname);
  const tracksBatch = req.method === 'POST' && BATCH_PATH.test(url.pathname);

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await readBody(req);
    if (!body.length) body = undefined;
  }

  let eraLocal = null;
  if (req.method === 'POST' && BATCH_PATH.test(url.pathname)) {
    const split = splitEraBatch(req, url, body);
    if (split) {
      if (!split.rest.length) {
        sendEraBatch(res, split.local);
        return;
      }
      eraLocal = split.local;
      body = Buffer.from(JSON.stringify(split.rest));
    }
  }
  const routeKey = url.hostname + url.pathname;
  const quick = req.method === 'POST' && FIRE_AND_FORGET.find(([pattern]) => pattern.test(routeKey));
  if (quick) {
    res.writeHead(quick[1], { 'Content-Length': 0, ...ISOLATION_HEADERS });
    res.end();
    upstream.request(url, { method: req.method, headers, body }).catch(() => {});
    return;
  }
  const session = sessionKey(req);
  const writes = WRITE_METHODS.has(req.method) && COOKIE_HOST.test(url.hostname);
  if (writes && csrfTokens.has(session) && !headers['x-csrf-token']) headers['x-csrf-token'] = csrfTokens.get(session);
  const sendResponse = (response, entry, label) => (eraLocal ? mergeEraBatch(res, eraLocal, response) : sendProxied(req, res, response, entry, label));

  if (PROXY_LOG) console.log(`[proxy] ${route}`);

  const cacheKey = proxyCacheKey(req.method, url, targetUrl, body, session);
  if (cacheKey) {
    const hit = proxyCacheGet(cacheKey);
    if (hit) {
      await sendResponse(hit, hit, 'hit');
      if (isAsset) delivered(client, url, hit, hit);
      if (tracksBatch) recordBatch(client, body, hit);
      if (PROXY_LOG) console.log(`[proxy] ⇒ hit ${route} ${elapsed()}`);
      return;
    }
  }

  if (isRoblox && url.hostname === 'gamejoin.roblox.com' && req.method === 'POST') {
    try {
      const join = launcherJoin(req, targetUrl, body);
      await handleGameJoin(req, res, join.targetUrl, headers, join.body);
    } catch (err) {
      console.error('[gamejoin] error:', err.message);
      if (!res.headersSent) res.writeHead(502, ISOLATION_HEADERS);
      res.end('Proxy error');
    }
    return;
  }

  let release = null;
  if (cacheKey) {
    const pending = inflight.get(cacheKey);
    if (pending) {
      proxyStats.coalesced++;
      promotePrefetch(cacheKey);
      await pending;
      const shared = proxyCacheGet(cacheKey);
      if (shared) {
        await sendResponse(shared, shared, 'coalesced');
        if (isAsset) delivered(client, url, shared, shared);
        if (tracksBatch) recordBatch(client, body, shared);
        if (PROXY_LOG) console.log(`[proxy] ⇒ coalesced ${route} ${elapsed()}`);
        return;
      }
    } else {
      let done;
      inflight.set(cacheKey, new Promise(resolve => { done = resolve; }));
      release = () => { inflight.delete(cacheKey); done(); };
    }
  }

  const started = performance.now();
  try {
    let up = await upstream.request(url, { method: req.method, headers, body });
    if (up.cookies.length) storeCookies(res, up.cookies);
    if (writes && up.status === 403 && up.headers['x-csrf-token']) {
      csrfTokens.delete(session);
      csrfTokens.set(session, up.headers['x-csrf-token']);
      if (csrfTokens.size > CSRF_SESSIONS) csrfTokens.delete(csrfTokens.keys().next().value);
      headers['x-csrf-token'] = up.headers['x-csrf-token'];
      up = await upstream.request(url, { method: req.method, headers, body });
      if (up.cookies.length) storeCookies(res, up.cookies);
    }

    const encoding = upstream.contentEncoding(up.headers);
    const data = up.body;
    const resHeaders = responseHeaders(up.headers);
    const json = /json/i.test(String(up.headers['content-type'] || ''));
    if (isRoblox && req.method === 'GET' && up.status === 200 && CACHEABLE_HOST.test(url.hostname) && !json) {
      resHeaders['cache-control'] = browserCacheControl(url.hostname);
    } else if (json || !resHeaders['cache-control']) resHeaders['cache-control'] = 'no-cache';

    if (PROXY_LOG || up.status >= 400) {
      console.log(`[proxy] → ${up.status} ${route} ${Math.round(performance.now() - started)}ms ${data.length}B ${encoding || '-'} ${up.headers['content-type'] || '-'} ${elapsed()}`);
    }

    let response = { status: up.status, headers: resHeaders, body: data, encoding };
    if (up.status === 200 && APP_POLICY_URL.test(targetUrl)) response = await patchAppPolicy(response);
    if (framed && /text\/html/i.test(String(up.headers['content-type'] || ''))) {
      response = await framePage(response, up.url);
    }
    const isBatch = up.status === 200 && req.method === 'POST' && BATCH_PATH.test(url.pathname);
    const isUsers = up.status === 200 && USERS_PATH.test(url.pathname);
    const isThumbnails = up.status === 200 && isThumbnailBatch(req.method, url, body);
    const text = isBatch || isThumbnails || (cacheKey && isUsers) ? await readText(response) : null;
    let entry = null;
    if (cacheKey) {
      let ttl = steadyApiTtl(req.method, url) || proxyCacheTtl(req.method, up.headers);
      if (isThumbnails) ttl = THUMBNAIL_NOT_READY.test(text || '"state":"') ? 0 : THUMBNAIL_TTL_MS;
      if (text && text.includes('"errors"')) ttl = Math.min(ttl, 60 * 1000);
      entry = proxyCacheSet(cacheKey, response, ttl);
    }
    if (isBatch && text) {
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (json) {
        let asked = null;
        try { asked = JSON.parse(String(body || '[]')); } catch {}
        if (ASSET_LOG) auditBatch(asked, json);
        noteBatch(client, asked, json);
        prefetchLocations(json, headers, client);
      }
    }

    await sendResponse(response, entry, null);
    if (isAsset && up.status === 200) delivered(client, url, entry, response);
  } catch (err) {
    console.error('[proxy]', route, '-', err.message);
    if (!res.headersSent) res.writeHead(502, ISOLATION_HEADERS);
    res.end('Proxy error');
  } finally {
    if (release) release();
  }
}

module.exports = {
  PROXY_PREFIX,
  handleProxy,
  ASSET_LOG,
  requestedAssets,
  refusedAssets,
};
