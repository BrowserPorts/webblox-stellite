const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { BASE, GEN_DIR } = require('./config');
const { ISOLATION_HEADERS, readBody } = require('./shared');

const SHIPPED_FILE = path.join(GEN_DIR, 'shader-warmup.json');
const LOCAL_FILE = path.join(BASE, '.cache', 'shader-warmup.json');
const SHADER_LIMIT = 4000;
const SHADER_SOURCE_MAX = 256 * 1024;
const BODY_LIMIT = 32 * 1024 * 1024;

let programs = null;
let local = null;
let saving = false;
let dirty = false;
let served = null;

function readPrograms(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.programs && typeof data.programs === 'object') return data.programs;
  } catch {}
  return {};
}

function load() {
  if (programs) return;
  programs = new Map(Object.entries(readPrograms(SHIPPED_FILE)));
  local = new Map();
  for (const [key, rec] of Object.entries(readPrograms(LOCAL_FILE))) {
    if (programs.has(key)) continue;
    programs.set(key, rec);
    local.set(key, rec);
  }
}

function sortedObject(map) {
  const out = {};
  for (const key of [...map.keys()].sort()) out[key] = map.get(key);
  return out;
}

async function save() {
  if (saving) {
    dirty = true;
    return;
  }
  saving = true;
  try {
    do {
      dirty = false;
      await fs.promises.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
      const tmp = LOCAL_FILE + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, programs: sortedObject(local) }));
      await fs.promises.rename(tmp, LOCAL_FILE);
    } while (dirty);
  } catch (err) {
    console.error('[shaders] could not save the local warm-up list:', err.message);
  } finally {
    saving = false;
  }
}

function gzipAsync(buf) {
  return new Promise((resolve, reject) => zlib.gzip(buf, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out))));
}

async function serveShaderList(req, res) {
  load();
  if (!served) {
    const body = Buffer.from(JSON.stringify({ version: 1, programs: sortedObject(programs) }));
    served = { body, gzip: gzipAsync(body), etag: `"shaders-${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16)}"` };
  }
  const { body, etag } = served;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ETag: etag, ...ISOLATION_HEADERS };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  let payload = body;
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    payload = await served.gzip;
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = payload.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

async function handleShaderPost(req, res) {
  const body = await readBody(req, BODY_LIMIT);
  if (!body) {
    if (!res.headersSent) res.writeHead(413, ISOLATION_HEADERS);
    res.end();
    return;
  }
  const incoming = JSON.parse(body.toString('utf8'));
  load();
  let added = 0;
  for (const rec of Array.isArray(incoming) ? incoming : []) {
    if (programs.size >= SHADER_LIMIT) break;
    if (!rec || typeof rec.key !== 'string' || !/^[0-9a-f]{16}$/.test(rec.key) || programs.has(rec.key)) continue;
    if (typeof rec.vs !== 'string' || typeof rec.fs !== 'string') continue;
    if (rec.vs.length > SHADER_SOURCE_MAX || rec.fs.length > SHADER_SOURCE_MAX) continue;
    const attribs = Array.isArray(rec.attribs) ? rec.attribs.filter(a => typeof a === 'string' && a.length < 256) : [];
    const entry = { vs: rec.vs, fs: rec.fs, attribs };
    programs.set(rec.key, entry);
    local.set(rec.key, entry);
    added++;
  }
  if (added) {
    served = null;
    console.log(`[shaders] added ${added} program(s) to the warm-up list (${programs.size} total)`);
    save();
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
  res.end(JSON.stringify({ added, total: programs.size }));
}

module.exports = {
  handleShaderPost,
  serveShaderList,
};
