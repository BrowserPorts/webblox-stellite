const http = require('http');
const http2 = require('http2');
const https = require('https');
const zlib = require('zlib');
const { COOKIE_HOST } = require('./shared');

const agentOptions = { keepAlive: true, maxSockets: 64, maxFreeSockets: 32, scheduling: 'lifo' };
const agents = { 'http:': new http.Agent(agentOptions), 'https:': new https.Agent(agentOptions) };
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const TIMEOUT_MS = 60 * 1000;
const MAX_HOPS = 5;

const USE_H2 = process.env.UPSTREAM_H2 !== '0';
const H2_STREAM_WINDOW = 16 * 1024 * 1024;
const H2_SESSION_WINDOW = 64 * 1024 * 1024;
const H2_SESSION_MEMORY_MB = 256;
const H2_RETRY_AFTER_MS = 5 * 60 * 1000;
const H2_SKIP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'host', 'http2-settings']);
const WARM_INTERVAL_MS = 30 * 1000;
const WARM_IDLE_LIMIT_MS = 10 * 60 * 1000;
const WARM_ORIGINS = [
  'games', 'thumbnails', 'catalog', 'avatar', 'friends', 'apis', 'users', 'assetdelivery', 'inventory', 'economy', 'contentdelivery',
].map(name => `https://${name}.roblox.com`).concat('https://fts.rbxcdn.com');
const sessions = new Map();
const h2Blocked = new Map();
let lastUsed = 0;

function h2Session(origin) {
  const known = sessions.get(origin);
  if (known) return known;
  const pending = new Promise((resolve, reject) => {
    const forget = () => {
      if (sessions.get(origin) === pending) sessions.delete(origin);
    };
    const session = http2.connect(origin, {
      settings: { enablePush: false, initialWindowSize: H2_STREAM_WINDOW },
      maxSessionMemory: H2_SESSION_MEMORY_MB,
    });
    session.on('error', err => {
      forget();
      reject(err);
    });
    session.on('goaway', forget);
    session.on('close', forget);
    session.once('connect', () => {
      session.setLocalWindowSize(H2_SESSION_WINDOW);
      session.unref();
      resolve(session);
    });
  });
  pending.catch(() => {});
  sessions.set(origin, pending);
  return pending;
}

function h2Once(session, url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const out = { ':method': method, ':scheme': 'https', ':authority': url.host, ':path': url.pathname + url.search };
    for (const [name, value] of Object.entries(headers)) {
      const key = name.toLowerCase();
      if (value !== undefined && !H2_SKIP_HEADERS.has(key)) out[key] = value;
    }
    const stream = session.request(out, { endStream: !body });
    const chunks = [];
    let size = 0;
    let answer = null;
    stream.on('response', responseHeaders => {
      const { ':status': status, ...rest } = responseHeaders;
      answer = { status, headers: rest };
    });
    stream.on('data', chunk => {
      chunks.push(chunk);
      size += chunk.length;
    });
    stream.on('end', () => {
      if (answer) resolve({ ...answer, body: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size) });
    });
    stream.on('error', err => {
      err.unanswered = !answer;
      reject(err);
    });
    stream.on('close', () => {
      if (answer && stream.readableEnded) return;
      const err = new Error(`upstream stream closed (${stream.rstCode})`);
      err.unanswered = !answer;
      err.refused = stream.rstCode === http2.constants.NGHTTP2_REFUSED_STREAM;
      reject(err);
    });
    stream.setTimeout(TIMEOUT_MS, () => stream.destroy(new Error(`upstream timeout after ${TIMEOUT_MS} ms`)));
    if (body) stream.end(body);
  });
}

function h1Once(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method, headers, agent: agents[url.protocol] }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => { chunks.push(chunk); size += chunk.length; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size),
      }));
      res.on('error', reject);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`upstream timeout after ${TIMEOUT_MS} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

function warm() {
  for (const origin of WARM_ORIGINS) h2Session(origin).catch(() => {});
}

function noteUse() {
  const now = Date.now();
  if (USE_H2 && now - lastUsed > WARM_IDLE_LIMIT_MS) warm();
  lastUsed = now;
}

async function once(url, method, headers, body) {
  noteUse();
  const origin = url.origin;
  if (!USE_H2 || url.protocol !== 'https:' || h2Blocked.get(origin) > Date.now()) return h1Once(url, method, headers, body);
  let session = null;
  try {
    session = await h2Session(origin);
  } catch {
    h2Blocked.set(origin, Date.now() + H2_RETRY_AFTER_MS);
  }
  if (!session) return h1Once(url, method, headers, body);
  try {
    return await h2Once(session, url, method, headers, body);
  } catch (err) {
    const idempotent = method === 'GET' || method === 'HEAD';
    const unsent = err.refused || err.code === 'ERR_HTTP2_INVALID_SESSION' || err.code === 'ERR_HTTP2_GOAWAY_SESSION';
    if (!unsent && !(idempotent && err.unanswered)) throw err;
    return h1Once(url, method, headers, body);
  }
}

function startWarming() {
  if (!USE_H2) return;
  lastUsed = Date.now();
  warm();
  setInterval(() => {
    if (Date.now() - lastUsed > WARM_IDLE_LIMIT_MS) return;
    warm();
    for (const pending of sessions.values()) {
      pending.then(session => {
        if (!session.destroyed && !session.closed) session.ping(() => {});
      }).catch(() => {});
    }
  }, WARM_INTERVAL_MS).unref();
}

async function request(target, { method = 'GET', headers = {}, body } = {}) {
  let url = typeof target === 'string' ? new URL(target) : target;
  const out = { ...headers, 'accept-encoding': 'gzip, br' };
  const cookies = [];
  for (let hop = 0; ; hop++) {
    if (body && body.length) out['content-length'] = String(body.length);
    else delete out['content-length'];
    const res = await once(url, method, out, body && body.length ? body : undefined);
    const set = res.headers['set-cookie'];
    if (set && COOKIE_HOST.test(url.hostname)) cookies.push(...set);
    if (!REDIRECT.has(res.status) || !res.headers.location || hop >= MAX_HOPS) return { ...res, url, cookies };
    url = new URL(res.headers.location, url);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      delete out['content-type'];
    }
    if (!COOKIE_HOST.test(url.hostname)) delete out.cookie;
  }
}

const DECODERS = {
  gzip: zlib.gunzip,
  'x-gzip': zlib.gunzip,
  deflate: zlib.inflate,
  br: zlib.brotliDecompress,
};

function contentEncoding(headers) {
  const value = String(headers['content-encoding'] || '').trim().toLowerCase();
  return value && value !== 'identity' ? value : '';
}

function decode(body, encoding) {
  const decoder = DECODERS[encoding];
  if (!encoding || !decoder) return Promise.resolve(body);
  return new Promise((resolve, reject) => decoder(body, (err, out) => (err ? reject(err) : resolve(out))));
}

function accepts(req, encoding) {
  if (!encoding) return true;
  for (const part of String(req.headers['accept-encoding'] || '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map(s => s.trim());
    if (name !== encoding && name !== '*') continue;
    const q = params.find(p => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

module.exports = { request, decode, contentEncoding, accepts, startWarming };
