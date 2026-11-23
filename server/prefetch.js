const { PROXY_LOG } = require('./config');
const { SKIP_RESPONSE_HEADERS, COOKIE_HOST } = require('./shared');
const { proxyCache, proxyStats, inflight, CACHEABLE_HOST, proxyCacheTtl, browserCacheControl, proxyCacheSet } = require('./proxy-cache');
const upstream = require('./upstream');
const { wasDelivered } = require('./delivered');

const PREFETCH = process.env.PREFETCH !== '0';
const PREFETCH_CONCURRENCY = 32;
const prefetchQueue = [];
const prefetchJobs = new Map();
let prefetchActive = 0;

function prefetchHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!/^(content-type|content-length|content-encoding|cookie)$/i.test(k)) out[k] = v;
  }
  return out;
}

function prefetchLocations(list, headers, client) {
  if (!PREFETCH || !Array.isArray(list)) return;
  let base = null;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const urls = [];
    if (typeof item.location === 'string') urls.push(item.location);
    if (Array.isArray(item.locations)) {
      for (const loc of item.locations) if (loc && typeof loc.location === 'string') urls.push(loc.location);
    }
    for (const href of urls) {
      let url;
      try { url = new URL(href); } catch { continue; }
      if (!CACHEABLE_HOST.test(url.hostname) || wasDelivered(client, url)) {
        if (CACHEABLE_HOST.test(url.hostname)) proxyStats.prefetchSkipped++;
        continue;
      }
      const key = `G ${href}`;
      if (proxyCache.has(key) || inflight.has(key)) continue;
      base ??= prefetchHeaders(headers);
      let done;
      inflight.set(key, new Promise(resolve => { done = resolve; }));
      const job = { url, key, headers: COOKIE_HOST.test(url.hostname) && headers.cookie ? { ...base, cookie: headers.cookie } : base, done, started: false };
      prefetchJobs.set(key, job);
      prefetchQueue.push(job);
    }
  }
  pumpPrefetch();
}

async function fetchJob(job) {
  const up = await upstream.request(job.url, { headers: job.headers });
  const headers = {};
  for (const [k, v] of Object.entries(up.headers)) if (!SKIP_RESPONSE_HEADERS.has(k)) headers[k] = v;
  if (up.status === 200) headers['cache-control'] = browserCacheControl(job.url.hostname);
  proxyCacheSet(job.key, { status: up.status, headers, body: up.body, encoding: upstream.contentEncoding(up.headers) }, proxyCacheTtl('GET', up.headers));
  proxyStats.prefetched++;
  if (PROXY_LOG) console.log(`[prefetch] ${up.status} ${job.url.hostname} ${up.body.length}B @${(performance.now() / 1000).toFixed(2)}s`);
}

function runPrefetch(job) {
  job.started = true;
  prefetchActive++;
  fetchJob(job).catch(() => {}).finally(() => {
    prefetchActive--;
    prefetchJobs.delete(job.key);
    inflight.delete(job.key);
    job.done();
    pumpPrefetch();
  });
}

function pumpPrefetch() {
  while (prefetchActive < PREFETCH_CONCURRENCY && prefetchQueue.length) {
    const job = prefetchQueue.shift();
    if (!job.started) runPrefetch(job);
  }
}

function promotePrefetch(key) {
  const job = prefetchJobs.get(key);
  if (job && !job.started) runPrefetch(job);
}

module.exports = {
  prefetchLocations,
  promotePrefetch,
};
