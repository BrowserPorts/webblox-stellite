#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = path.join(__dirname, '..');
const OUT_DIR = path.join(BASE, '.cache', 'bench');
const ENGINE_DIR = path.join(BASE, 'public', 'engine');
const WASM_URL = '/engine/WebClient.wasm';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = name => args.includes(`--${name}`);
const PORT = Number(flag('port', 3000));
const LABEL = flag('label', 'baseline');
const SPAWN = has('spawn');
const SERVER = flag('server', 'server');
const ENV = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--env' && args[i + 1]) {
    const [k, ...v] = args[i + 1].split('=');
    ENV[k] = v.join('=');
  }
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

let proxyToken = null;
function tokenCookie() {
  if (proxyToken === null) {
    try { proxyToken = fs.readFileSync(path.join(BASE, '.cache', 'proxy-token'), 'utf8').trim(); } catch { proxyToken = ''; }
  }
  return proxyToken ? `webblox_token=${proxyToken}` : '';
}

function requestPath(pathname) {
  if (pathname.startsWith('/__proxy__/')) return pathname;
  return '/' + pathname.split('/').slice(1).map(encodeURIComponent).join('/');
}

function request(pathname, { method = 'GET', headers = {}, body = null, timeout = 120000, collect = false } = {}) {
  const target = requestPath(pathname);
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: target, method, agent,
      headers: { 'Accept-Encoding': 'gzip, zstd', Cookie: tokenCookie(), ...headers },
    }, res => {
      let bytes = 0;
      const chunks = [];
      res.on('data', c => { bytes += c.length; if (collect) chunks.push(c); });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          bytes,
          body: collect ? Buffer.concat(chunks).toString('utf8') : null,
          ms: Number(process.hrtime.bigint() - started) / 1e6,
        });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: +pct(s, 0.5).toFixed(1),
    p95: +pct(s, 0.95).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1),
  };
}

async function pool(items, concurrency, fn) {
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function assetList(limit) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), rel); continue; }
      if (!e.isFile() || e.name === 'WebClient.wasm') continue;
      let size = 0;
      try { size = fs.statSync(path.join(dir, e.name)).size; } catch { continue; }
      if (size > 2 * 1024 * 1024) continue;
      out.push(`/engine/${rel}`);
    }
  };
  walk(ENGINE_DIR, '');
  out.sort();
  const stride = Math.max(1, Math.floor(out.length / limit));
  return out.filter((_, i) => i % stride === 0).slice(0, limit);
}

function table(rows) {
  const head = ['case', 'n', 'p50 ms', 'p95 ms', 'max ms', 'notes'];
  const body = rows.map(r => [r.case, String(r.n), String(r.p50), String(r.p95), String(r.max), r.note || '']);
  const w = head.map((h, i) => Math.max(h.length, ...body.map(r => r[i].length)));
  const line = cells => cells.map((c, i) => c.padEnd(w[i])).join('  ');
  console.log(line(head));
  console.log(w.map(x => '-'.repeat(x)).join('  '));
  for (const r of body) console.log(line(r));
}

async function caseAssets(assets) {
  const seq = [];
  for (const p of assets.slice(0, 250)) {
    const r = await request(p);
    if (r.status !== 200) throw new Error(`asset ${p} -> ${r.status}`);
    seq.push(r.ms);
  }
  const par = [];
  await pool(assets, 48, async p => {
    const r = await request(p);
    if (r.status !== 200) throw new Error(`asset ${p} -> ${r.status}`);
    par.push(r.ms);
  });
  return { seq: stats(seq), par: stats(par) };
}

async function caseWasm() {
  const cold = await request(WASM_URL, { headers: { 'Accept-Encoding': 'zstd' } });
  const warm = await request(WASM_URL, { headers: { 'Accept-Encoding': 'zstd' } });
  return {
    coldMs: +cold.ms.toFixed(1),
    warmMs: +warm.ms.toFixed(1),
    encoding: cold.headers['content-encoding'] || 'identity',
    transferMB: +(cold.bytes / 1048576).toFixed(1),
    cache: warm.headers['x-local-cache'] || (warm.status === 304 ? '304' : 'server'),
  };
}

const upstream = { hits: 0, started: 0 };
let downstream;
let bigBody = null;
let assetBody = null;

function startUpstream() {
  return new Promise(resolve => {
    downstream = http.createServer(async (req, res) => {
      upstream.hits++;
      const url = new URL(req.url, 'http://local');
      if (url.pathname === '/slow') {
        await new Promise(r => setTimeout(r, Number(url.searchParams.get('ms') || 120)));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, n: upstream.hits }));
        return;
      }
      if (url.pathname === '/asset') {
        assetBody ??= crypto.randomBytes(24 * 1024);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': assetBody.length, 'Cache-Control': 'public, max-age=86400' });
        res.end(assetBody);
        return;
      }
      if (url.pathname === '/big') {
        if (!bigBody) {
          const row = { id: 0, name: 'x'.repeat(120), flags: Array.from({ length: 24 }, (_, i) => i) };
          const rows = Array.from({ length: 11000 }, (_, i) => ({ ...row, id: i }));
          bigBody = JSON.stringify({ rows });
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bigBody) });
        res.end(bigBody);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    downstream.listen(0, '127.0.0.1', () => resolve(downstream.address().port));
  });
}

const proxyPath = target => `/__proxy__/${target}`;

async function caseCoalesce(port) {
  const target = `http://127.0.0.1:${port}/slow?ms=120`;
  upstream.hits = 0;
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 40 }, () => request(proxyPath(target))));
  const wallMs = Date.now() - started;
  const statuses = results.filter(r => r.status === 200).length;
  const wave1Hits = upstream.hits;

  upstream.hits = 0;
  const repeat = await Promise.all(Array.from({ length: 10 }, () => request(proxyPath(target))));
  const wave2Hits = upstream.hits;
  const cached = repeat.filter(r => r.headers['x-local-cache'] === 'hit').length;

  return {
    concurrent: 40,
    ok: statuses,
    upstreamHitsWave1: wave1Hits,
    wallMs,
    p95: stats(results.map(r => r.ms)).p95,
    repeat: 10,
    upstreamHitsWave2: wave2Hits,
    servedFromCache: cached,
  };
}

async function caseLoopLag(upstreamPort) {
  const warm = await request(proxyPath(`http://127.0.0.1:${upstreamPort}/big?id=warm`));
  const big = request(proxyPath(`http://127.0.0.1:${upstreamPort}/big?id=live`));
  await new Promise(r => setTimeout(r, 5));
  const samples = [];
  let biggestGap = 0;
  let last = process.hrtime.bigint();
  const until = Date.now() + 300;
  while (Date.now() < until) {
    const [a, b] = await Promise.all([request('/__stats'), request('/__stats'), request('/__stats')]);
    const now = process.hrtime.bigint();
    biggestGap = Math.max(biggestGap, Number(now - last) / 1e6);
    last = now;
    samples.push(a.ms, b.ms);
  }
  await big;
  const s = stats(samples);
  return { p50: s.p50, p95: s.p95, max: s.max, stallMs: +biggestGap.toFixed(1), n: s.n, bigMB: +(warm.bytes / 1048576).toFixed(2) };
}

async function caseLoopBlock(assets, upstreamPort) {
  const idle = [];
  for (const p of assets.slice(0, 60)) idle.push((await request(p)).ms);

  upstream.hits = 0;
  const big = request(proxyPath(`http://127.0.0.1:${upstreamPort}/big?id=${Date.now()}`));
  const during = [];
  await pool(assets.slice(0, 60), 6, async p => { during.push((await request(p)).ms); });
  const bigRes = await big;

  return {
    idleP95: stats(idle).p95,
    busyP95: stats(during).p95,
    bigMs: +bigRes.ms.toFixed(1),
    bigMB: +(bigRes.bytes / 1048576).toFixed(2),
    bigEncoding: bigRes.headers['content-encoding'] || 'identity',
  };
}

async function serverCpuMs() {
  const r = await request('/__stats', { collect: true });
  return JSON.parse(r.body).cpuMs;
}

async function caseProxyAssets(upstreamPort, count, concurrency) {
  const run = `${Date.now()}-${concurrency}`;
  const cpu0 = await serverCpuMs();
  const started = process.hrtime.bigint();
  const samples = [];
  await pool(Array.from({ length: count }, (_, i) => i), concurrency, async i => {
    const r = await request(proxyPath(`http://127.0.0.1:${upstreamPort}/asset?run=${run}&id=${i}`));
    if (r.status !== 200) throw new Error(`proxy asset -> ${r.status}`);
    samples.push(r.ms);
  });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const cpuMs = (await serverCpuMs()) - cpu0;
  return { ...stats(samples), wallMs: +wallMs.toFixed(1), cpuMs, cpuPerReq: +(cpuMs / count * 1000).toFixed(0) };
}

async function caseColdStart() {
  const page = await request('/?launcher=roblox', { headers: { 'Accept-Encoding': 'gzip' } });
  const meta = await request('/engine/WebClient.metadata.json', { headers: { 'Accept-Encoding': 'gzip' } });
  return { pageMs: +page.ms.toFixed(1), metadataMs: +meta.ms.toFixed(1) };
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await request('/__stats', { timeout: 2000 });
      if (r.status === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not become ready');
}

(async () => {
  let child = null;
  if (SPAWN) {
    child = spawn(process.execPath, [SERVER], {
      cwd: BASE,
      env: { ...process.env, ...ENV, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = path.join(OUT_DIR, `server-${LABEL}.log`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const stream = fs.createWriteStream(log);
    child.stdout.pipe(stream);
    child.stderr.pipe(stream);
    child.on('exit', code => { if (code) console.error(`server exited (${code}), see ${log}`); });
  }

  try {
    await waitForServer();
    const coldRes = await caseColdStart();
    const assets = assetList(400);
    if (assets.length < 50) throw new Error(`only ${assets.length} assets found — is the bundle present?`);
    console.log(`\nport ${PORT} · ${assets.length} assets sampled · label "${LABEL}"${Object.keys(ENV).length ? ' · env ' + JSON.stringify(ENV) : ''}\n`);

    const upstreamPort = await startUpstream();
    const assetsRes = await caseAssets(assets);
    const wasmRes = await caseWasm();
    const coalesceRes = await caseCoalesce(upstreamPort);
    const lagRes = await caseLoopLag(upstreamPort);
    const loopRes = await caseLoopBlock(assets.slice(0, 60), upstreamPort);
    const proxy6 = await caseProxyAssets(upstreamPort, 600, 6);
    const proxy48 = await caseProxyAssets(upstreamPort, 1200, 48);
    const mem = process.memoryUsage();

    const rows = [
      { case: 'first page load', n: 1, p50: coldRes.pageMs, p95: '', max: '', note: 'fresh server' },
      { case: 'first metadata', n: 1, p50: coldRes.metadataMs, p95: '', max: '', note: 'fresh server' },
      { case: 'asset (sequential)', n: assetsRes.seq.n, ...pick(assetsRes.seq), note: 'engine asks one at a time' },
      { case: 'asset (48 concurrent)', n: assetsRes.par.n, ...pick(assetsRes.par), note: 'join burst' },
      { case: 'wasm cold', n: 1, p50: wasmRes.coldMs, p95: wasmRes.coldMs, max: wasmRes.coldMs, note: `${wasmRes.transferMB} MB ${wasmRes.encoding}` },
      { case: 'wasm warm', n: 1, p50: wasmRes.warmMs, p95: wasmRes.warmMs, max: wasmRes.warmMs, note: wasmRes.cache },
      { case: 'proxy 40x same url', n: 40, p50: '', p95: coalesceRes.p95, max: coalesceRes.wallMs, note: `upstream hits ${coalesceRes.upstreamHitsWave1}` },
      { case: 'proxy repeat', n: 10, p50: '', p95: '', max: '', note: `${coalesceRes.servedFromCache}/10 cache hits, upstream ${coalesceRes.upstreamHitsWave2}` },
      { case: 'loop stall during 2 MB', n: lagRes.n, p50: lagRes.p50, p95: lagRes.p95, max: lagRes.stallMs, note: 'longest silence on a trivial endpoint' },
      { case: 'proxy assets (6 conc)', n: proxy6.n, ...pick(proxy6), note: `${proxy6.wallMs} ms wall · server cpu ${proxy6.cpuMs} ms (${proxy6.cpuPerReq} us/req)` },
      { case: 'proxy assets (48 conc)', n: proxy48.n, ...pick(proxy48), note: `${proxy48.wallMs} ms wall · server cpu ${proxy48.cpuMs} ms (${proxy48.cpuPerReq} us/req)` },
      { case: 'asset during 2 MB', n: 60, p50: '', p95: loopRes.busyP95, max: '', note: `idle p95 ${loopRes.idleP95} · big ${loopRes.bigMB} MB ${loopRes.bigEncoding} in ${loopRes.bigMs} ms` },
    ];
    table(rows);

    const out = {
      label: LABEL,
      when: new Date().toISOString(),
      port: PORT,
      env: ENV,
      node: process.version,
      parentRssMB: +(mem.rss / 1048576).toFixed(1),
      assets: assetsRes,
      wasm: wasmRes,
      coalesce: coalesceRes,
      loopLag: lagRes,
      loopBlock: loopRes,
      coldStart: coldRes,
      proxyAssets: { conc6: proxy6, conc48: proxy48 },
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `results-${LABEL}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`\nwrote ${path.relative(BASE, file)}\n`);
  } finally {
    if (child) {
      child.kill();
      await new Promise(r => setTimeout(r, 300));
      if (!child.killed) child.kill('SIGKILL');
    }
    if (downstream) downstream.close();
    agent.destroy();
  }
})().catch(err => {
  console.error('\nbench failed:', err.message);
  process.exitCode = 1;
});

function pick(s) {
  return { p50: s.p50, p95: s.p95, max: s.max };
}
