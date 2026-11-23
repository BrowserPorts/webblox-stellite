(() => {
  const JAR_KEY = 'cobalt-cookies';
  const SESSION_DOMAINS = ['roblox.com', 'rbxcdn.com', 'robloxlabs.com'];
  const SESSION_CHECK_URL = 'https://users.roblox.com/v1/users/authenticated';
  const ROBLOX_HOST = /(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com)$/;
  const SKIP_RESPONSE_HEADERS = new Set([
    'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie',
    'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-headers',
    'access-control-allow-methods', 'access-control-expose-headers', 'cross-origin-opener-policy',
    'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'strict-transport-security',
  ]);

  function hasSession() {
    try { return JSON.parse(localStorage.getItem(JAR_KEY) || '[]').some(c => c.n === '.ROBLOSECURITY'); } catch { return false; }
  }

  function storeSession(value) {
    let all = [];
    try { all = JSON.parse(localStorage.getItem(JAR_KEY) || '[]'); } catch {}
    all = all.filter(c => c.n !== '.ROBLOSECURITY');
    for (const d of SESSION_DOMAINS) {
      all.push({ n: '.ROBLOSECURITY', v: value, d, h: false, p: '/', s: true, o: true, e: 0, ss: 'none' });
    }
    localStorage.setItem(JAR_KEY, JSON.stringify(all));
  }

  const ROBLOSECURITY_PREFIX = '_|WARNING:-DO-NOT-SHARE-THIS.';
  const MARK = '<svg viewBox="157 157 710 710" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M307.201 157.281L157.281 716.799L716.799 866.719L866.719 307.201L307.201 157.281ZM569.242 611.157L412.893 569.242L454.807 412.893L611.219 454.807L569.242 611.157Z"/></svg>';

  function forgetSession() {
    try {
      const kept = JSON.parse(localStorage.getItem(JAR_KEY) || '[]').filter(c => c.n !== '.ROBLOSECURITY');
      localStorage.setItem(JAR_KEY, JSON.stringify(kept));
    } catch {}
  }

  async function sessionAccepted() {
    try {
      const r = await cb_fetch(SESSION_CHECK_URL, {
        method: 'GET',
        headers: { origin: 'https://www.roblox.com', referer: 'https://www.roblox.com/' },
        redirect: 'follow',
      });
      return r.status !== 401;
    } catch {
      return true;
    }
  }

  const askForSession = expired => new Promise(resolve => {
    const form = document.createElement('form');
    form.className = 'session-prompt';
    form.noValidate = true;
    form.setAttribute('aria-labelledby', 'session-title');
    form.innerHTML =
      '<header class="session-top">' +
        '<div class="session-logo" role="img" aria-label="WebBlox">' + MARK + '</div>' +
        (window.WEBLOX_SERVER ? '<a class="session-switch" href="' + WEBBLOX_BASE + '?mode=node">Use local server</a>' : '') +
      '</header>' +
      '<div class="session-body">' +
        '<h1 id="session-title">' + (expired ? 'Your session expired' : 'Sign in') + '</h1>' +
        '<div class="session-field">' +
          '<label for="session-cookie">.ROBLOSECURITY</label>' +
          '<input id="session-cookie" name="cookie" type="password" autocomplete="off" spellcheck="false" aria-describedby="session-error">' +
          '<p class="session-error" id="session-error" role="alert"></p>' +
        '</div>' +
        '<button class="session-submit" type="submit">Sign in</button>' +
      '</div>';
    const input = form.querySelector('input');
    const error = form.querySelector('.session-error');
    const fail = message => {
      error.textContent = message;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    };
    input.addEventListener('input', () => {
      error.textContent = '';
      input.removeAttribute('aria-invalid');
    });
    const submit = form.querySelector('.session-submit');
    form.onsubmit = async e => {
      e.preventDefault();
      const v = input.value.trim().replace(/^\.ROBLOSECURITY=/, '');
      if (!v) return fail('Paste your .ROBLOSECURITY value.');
      if (!v.startsWith(ROBLOSECURITY_PREFIX)) return fail("That isn't a .ROBLOSECURITY value.");
      submit.disabled = true;
      storeSession(v);
      const accepted = await sessionAccepted();
      submit.disabled = false;
      if (!accepted) {
        forgetSession();
        return fail('Roblox rejected that session.');
      }
      try {
        Object.keys(localStorage).filter(key => /^webblox\.launcher\.(home|shell)/.test(key)).forEach(key => localStorage.removeItem(key));
      } catch {}
      form.remove();
      resolve();
    };
    const mount = () => {
      document.body.appendChild(form);
      input.focus();
    };
    const sheet = document.createElement('link');
    sheet.rel = 'stylesheet';
    sheet.href = `${WEBBLOX_BASE}launcher/session.css`;
    sheet.onload = sheet.onerror = () => document.body ? mount() : addEventListener('DOMContentLoaded', mount);
    document.head.appendChild(sheet);
  });

  const sessionReady = (async () => {
    const saved = hasSession();
    if (saved && await sessionAccepted()) return;
    if (saved) forgetSession();
    await askForSession(saved);
  })();

  window.webbloxSessionReady = sessionReady;

  const spoofNativeUa = headers => {
    const copy = { ...headers };
    if (copy['rbx-user-agent']) {
      copy['rbx-user-agent'] = copy['rbx-user-agent']
        .replace(/Roblox\/Web\s+\w+\s+Desktop/, 'Roblox/WinInet')
        .replace(/\s*Browser\/\S+/, '');
    }
    return copy;
  };

  const cache = new Map();
  const CACHE_LIMIT = 512 * 1024 * 1024;
  const ENTRY_LIMIT = 64 * 1024 * 1024;
  let cacheBytes = 0;
  const CACHEABLE_HOST = /(^|\.)(rbxcdn\.com|assetdelivery\.roblox\.com|contentdelivery\.roblox\.com|thumbnails\.roblox\.com|assetgame\.roblox\.com|clientsettingscdn\.roblox\.com|clientsettings\.roblox\.com|users\.roblox\.com)$/i;

  async function cacheKey(method, url, body) {
    const u = new URL(url);
    if (!CACHEABLE_HOST.test(u.hostname)) return null;
    if (method === 'GET' && ASSET_HOST.test(u.hostname)) return null;
    if (method === 'GET' || method === 'HEAD') return `G ${url}`;
    if (method === 'POST' && (/\/v1\/assets\/batch$/.test(u.pathname) || /\/v1\/users$/.test(u.pathname))) {
      const digest = await crypto.subtle.digest('SHA-1', body || new ArrayBuffer(0));
      return `P ${url} ${[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')}`;
    }
    return null;
  }

  function cacheTtl(method, headers) {
    const cc = headers.get('cache-control') || '';
    const m = cc.match(/max-age=(\d+)/i);
    if (m) return Math.min(Number(m[1]), 30 * 24 * 3600) * 1000;
    if (/no-store/i.test(cc)) return 0;
    if (method === 'POST') return 10 * 60 * 1000;
    if (/no-cache/i.test(cc)) return 60 * 1000;
    return 60 * 60 * 1000;
  }

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expires <= Date.now()) { cache.delete(key); cacheBytes -= hit.body.byteLength; return null; }
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  function cacheSet(key, entry, ttl) {
    if (!ttl || entry.status !== 200 || entry.body.byteLength > ENTRY_LIMIT) return;
    if (cache.has(key)) { cacheBytes -= cache.get(key).body.byteLength; cache.delete(key); }
    cache.set(key, { ...entry, expires: Date.now() + ttl });
    cacheBytes += entry.body.byteLength;
    while (cacheBytes > CACHE_LIMIT && cache.size > 1) {
      const [k, v] = cache.entries().next().value;
      cache.delete(k);
      cacheBytes -= v.body.byteLength;
    }
  }

  const ASSET_CACHE = 'webblox-assets-2';
  const ASSET_HOST = /(^|\.)rbxcdn\.com$/i;
  const ASSET_MAX_AGE = 7 * 24 * 3600 * 1000;
  const ASSET_ENTRIES = 5000;
  const PREFETCH_CONCURRENCY = 16;
  let assetCache = null;
  let assetWrites = 0;
  const openAssets = () => (assetCache ??= caches.open(ASSET_CACHE));
  const isAsset = (method, target, headers) => method === 'GET' && ASSET_HOST.test(target.hostname) && !headers.range;
  const assetKey = href => {
    const m = new URL(href).pathname.match(/\/([0-9a-f]{32})$/i);
    return m ? `https://rbxcdn.webblox/${m[1].toLowerCase()}` : href;
  };

  function responseHeaders(headers) {
    const out = [];
    for (const [k, v] of headers) if (!SKIP_RESPONSE_HEADERS.has(k)) out.push([k, v]);
    return out;
  }

  async function storeAsset(href, r, resHeaders) {
    const key = assetKey(href);
    const ttl = key !== href ? ASSET_MAX_AGE : Math.min(cacheTtl('GET', r.headers), ASSET_MAX_AGE);
    if (r.status !== 200 || !ttl || r.body.byteLength > ENTRY_LIMIT) return;
    const body = r.body.slice(0);
    try {
      const cache = await openAssets();
      await cache.put(key, new Response(body, { status: 200, headers: [...resHeaders, ['x-webblox-expires', String(Date.now() + ttl)]] }));
      if (++assetWrites % 250 === 0) {
        const keys = await cache.keys();
        for (const req of keys.slice(0, Math.max(0, keys.length - ASSET_ENTRIES))) cache.delete(req);
      }
    } catch {}
  }

  async function cachedAsset(key) {
    try {
      const hit = await (await openAssets()).match(key);
      if (!hit || !(Number(hit.headers.get('x-webblox-expires')) > Date.now())) return null;
      return { status: hit.status, statusText: hit.statusText, headers: [...hit.headers], body: await hit.arrayBuffer() };
    } catch {
      return null;
    }
  }

  const prefetchQueue = [];
  const prefetchJobs = new Map();
  let prefetchActive = 0;

  function prefetchLocations(list) {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const urls = [];
      if (typeof item.location === 'string') urls.push(item.location);
      if (Array.isArray(item.locations)) {
        for (const loc of item.locations) if (loc && typeof loc.location === 'string') urls.push(loc.location);
      }
      for (const href of urls) {
        let host;
        try { host = new URL(href).hostname; } catch { continue; }
        const key = assetKey(href);
        if (!ASSET_HOST.test(host) || prefetchJobs.has(key)) continue;
        const job = { href, key, started: false };
        job.promise = new Promise(resolve => { job.resolve = resolve; });
        prefetchJobs.set(key, job);
        prefetchQueue.push(job);
      }
    }
    pumpPrefetch();
  }

  async function prefetchJob(job) {
    try {
      const hit = await cachedAsset(job.key);
      if (hit) return hit;
      const r = await wisp(job.href, { method: 'GET', headers: {} });
      const resHeaders = responseHeaders(r.headers);
      await storeAsset(job.href, r, resHeaders);
      return { status: r.status, statusText: r.statusText, headers: resHeaders, body: r.body };
    } catch {
      return null;
    }
  }

  function runPrefetch(job) {
    job.started = true;
    prefetchActive++;
    prefetchJob(job).then(job.resolve).finally(() => {
      prefetchActive--;
      prefetchJobs.delete(job.key);
      pumpPrefetch();
    });
  }

  function pumpPrefetch() {
    while (prefetchActive < PREFETCH_CONCURRENCY && prefetchQueue.length) {
      const job = prefetchQueue.shift();
      if (!job.started) runPrefetch(job);
    }
  }

  async function localAsset(href) {
    const key = assetKey(href);
    const job = prefetchJobs.get(key);
    if (!job) return cachedAsset(key);
    if (!job.started) runPrefetch(job);
    const r = await job.promise;
    return r && { status: r.status, statusText: r.statusText, headers: r.headers, body: r.body.slice(0) };
  }

  const ERROR_TTL_MS = 60 * 1000;
  const refused = new Map();

  // One line for each asset Roblox refuses, the first time it does, with the running count. The ids pair up with the
  // request by position
  function noteRefused(requestBody, answers) {
    if (!Array.isArray(answers)) return;
    let asked = [];
    try { asked = JSON.parse(new TextDecoder().decode(requestBody)); } catch {}
    answers.forEach((answer, i) => {
      const error = answer && Array.isArray(answer.errors) && answer.errors[0];
      if (!error) return;
      const id = String((asked[i] && asked[i].assetId) || answer.requestId || '?');
      if (refused.has(id)) return;
      refused.set(id, error.code);
      console.warn(`[assets] Roblox refused asset ${id} (code ${error.code}${error.message ? ', ' + error.message : ''}), ${refused.size} refused so far`);
    });
  }
  window.webbloxRefusedAssets = () => Object.fromEntries(refused);

  // Roblox answers a blocked thumbnail with its "unapproved" picture, which the engine draws as a black pill. An
  // empty picture leaves the slot empty instead
  const UNAPPROVED_IMAGE = /UnapprovedImage/i;
  const EMPTY_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  const emptyImage = () => ({ status: 200, statusText: 'OK', headers: [['content-type', 'image/png'], ['cache-control', 'max-age=3600']], body: EMPTY_PNG.slice().buffer });

  // How often each host was answered from the in-page cache, for reviewing the lifetimes above
  const hostStats = new Map();
  const countHost = (host, hit) => {
    const stat = hostStats.get(host) || { hits: 0, misses: 0 };
    stat[hit ? 'hits' : 'misses']++;
    hostStats.set(host, stat);
  };
  window.webbloxCacheStats = () => Object.fromEntries([...hostStats].map(([host, s]) => [host, { ...s, rate: +(s.hits / (s.hits + s.misses)).toFixed(3) }]));

  function qdmuxFqdn(joinScript) {
    const udmux = joinScript.UdmuxEndpoints && joinScript.UdmuxEndpoints[0];
    const nst = String(joinScript.NetStackTokenValue || '');
    if (!udmux || !nst || !joinScript.MachineAddress || !joinScript.NetStackPort) return null;
    let token = nst.toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(token)) {
      try { token = [...atob(nst)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''); } catch { return null; }
    }
    if (token.length !== 32) return null;
    const octets = udmux.Address.split('.').map(Number);
    if (octets.length !== 4 || octets.some(n => !(n >= 0 && n <= 255))) return null;
    octets[3] += 1;
    const hex = list => list.map(n => n.toString(16).padStart(2, '0')).join('');
    const machine = joinScript.MachineAddress.split('.').map(Number);
    return `${token}-${hex(machine)}-${Number(joinScript.NetStackPort).toString(16)}.${hex(octets)}.qdmux.roblox.com`;
  }

  // Retry policy: only a request that is safe to repeat is retried, only when the answer says to come back (429 or a
  // server error) or none arrived, at most RETRY_LIMIT times with a jittered, doubling wait. A refusal such as 403 or
  // 404 is final and is never asked again
  const RETRY_LIMIT = 3;
  const RETRY_BASE_MS = 300;
  const retryable = status => status === 429 || (status >= 500 && status <= 599);
  const retryWait = attempt => new Promise(resolve => setTimeout(resolve, RETRY_BASE_MS * 2 ** attempt * (0.5 + Math.random())));

  async function wisp(url, init) {
    const repeatable = init.method === 'GET' || init.method === 'HEAD';
    for (let attempt = 0; ; attempt++) {
      const last = !repeatable || attempt >= RETRY_LIMIT - 1;
      try {
        const r = await cb_fetch(url, { ...init, redirect: 'follow' });
        if (last || !retryable(r.status)) return { status: r.status, statusText: r.statusText, headers: r.headers, body: await r.arrayBuffer() };
      } catch (err) {
        if (last) throw err;
      }
      await retryWait(attempt);
    }
  }

  function jarNames(host) {
    try {
      return JSON.parse(localStorage.getItem(JAR_KEY) || '[]')
        .filter(c => host === c.d || (!c.h && host.endsWith('.' + c.d)))
        .map(c => c.n + '@' + c.d);
    } catch {
      return [];
    }
  }

  const LAUNCHER_JOIN = /(?:^|;\s*)launcher_join=(\d+):([gp]):([A-Za-z0-9-]+)/;

  function launcherJoin(url, body) {
    const match = /\/v1\/join-game$/.test(url) && LAUNCHER_JOIN.exec(document.cookie);
    if (!match) return { url, body };
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body));
      if (String(parsed.placeId) !== match[1] || parsed.isTeleport) return { url, body };
      const server = match[2] === 'g' ? { gameId: match[3] } : { accessCode: match[3] };
      return {
        url: url.replace(/\/join-game$/, match[2] === 'g' ? '/join-game-instance' : '/join-private-game'),
        body: new TextEncoder().encode(JSON.stringify({ ...parsed, ...server })).buffer,
      };
    } catch {
      return { url, body };
    }
  }

  async function handleGameJoin(url, method, headers, body) {
    ({ url, body } = launcherJoin(url, body));
    const r = await wisp(url, { method, headers: spoofNativeUa(headers), body });
    let json = null;
    try { json = JSON.parse(new TextDecoder().decode(r.body)); } catch {}
    console.log('[gamejoin]', url, r.status, JSON.stringify({
      status: json && json.status,
      message: json && json.message,
      hasJoinScript: !!(json && json.joinScript),
      cookies: jarNames(new URL(url).hostname),
    }));
    if (r.status === 200 && json && json.joinScript && !json.joinScript.gameFqdn) {
      const fqdn = qdmuxFqdn(json.joinScript);
      const edge = json.joinScript.UdmuxEndpoints && json.joinScript.UdmuxEndpoints[0];
      // The host is built from the edge address plus one. A datacenter that breaks that rule fails with
      // "Opening handshake failed", and this line is where to read the pattern it used
      console.log('[gamejoin] game host', fqdn || 'could not be built', 'from edge', edge ? `${edge.Address}:${edge.Port}` : 'none');
      if (fqdn) {
        json.joinScript.gameFqdn = fqdn;
        r.body = new TextEncoder().encode(JSON.stringify(json)).buffer;
      }
    }
    return r;
  }

  const APP_POLICY_URL = /^https:\/\/apis\.roblox\.com\/guac-v2\/v1\/bundles\/app-policy(?:[?#]|$)/;
  const APP_POLICY_OVERRIDES = { EnableWebViewSupport: true };
  function patchAppPolicy(r) {
    try {
      const policy = JSON.parse(new TextDecoder().decode(r.body));
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return r;
      Object.assign(policy, APP_POLICY_OVERRIDES);
      return { ...r, body: new TextEncoder().encode(JSON.stringify(policy)).buffer };
    } catch {
      return r;
    }
  }

  async function upstream({ url, method, headers, body }) {
    await sessionReady;
    const target = new URL(url);
    headers = { ...headers };
    delete headers.cookie;
    delete headers['content-length'];
    delete headers.referer;
    delete headers.origin;
    const isRoblox = ROBLOX_HOST.test(target.hostname);
    if (isRoblox) {
      headers.origin = 'https://www.roblox.com';
      headers.referer = 'https://www.roblox.com/';
      Object.assign(headers, spoofNativeUa(headers));
    } else {
      headers.origin = target.origin;
      headers.referer = target.origin + '/';
    }
    if (body && !body.byteLength) body = null;

    if (method === 'GET' && UNAPPROVED_IMAGE.test(url)) return emptyImage();

    const asset = isAsset(method, target, headers);
    if (asset) {
      const ready = await localAsset(url);
      countHost(target.hostname, !!ready);
      if (ready) return ready;
    }

    const key = await cacheKey(method, url, body);
    if (key) {
      const hit = cacheGet(key);
      countHost(target.hostname, !!hit);
      if (hit) return { status: hit.status, statusText: hit.statusText, headers: hit.headers, body: hit.body.slice(0) };
    }

    let r = (isRoblox && target.hostname === 'gamejoin.roblox.com' && method === 'POST')
      ? await handleGameJoin(url, method, headers, body)
      : await wisp(url, { method, headers, body });
    if (r.status === 200 && APP_POLICY_URL.test(url)) r = patchAppPolicy(r);

    const resHeaders = responseHeaders(r.headers);
    if (asset) storeAsset(url, r, resHeaders);
    if (r.status === 200 && method === 'POST' && /\/v1\/assets\/batch$/.test(target.pathname)) {
      try {
        const answers = JSON.parse(new TextDecoder().decode(r.body));
        noteRefused(body, answers);
        prefetchLocations(answers);
      } catch {}
    }
    if (r.status >= 400) console.log(`[proxy] → ${r.status} ${method} ${target.hostname}${target.pathname}`);

    if (key) {
      let ttl = cacheTtl(method, r.headers);
      if (/\/v1\/(assets\/batch|users)$/.test(target.pathname) &&
          new TextDecoder().decode(r.body).includes('"errors"')) {
        ttl = Math.min(ttl, ERROR_TTL_MS);
        console.log(`[cache] ${target.pathname} answered with errors, kept for ${ttl / 1000} s`);
      }
      cacheSet(key, { status: r.status, statusText: r.statusText, headers: resHeaders, body: r.body.slice(0) }, ttl);
    }
    return { status: r.status, statusText: r.statusText, headers: resHeaders, body: r.body };
  }

  navigator.serviceWorker.addEventListener('message', async event => {
    const msg = event.data;
    if (!msg || msg.type !== 'webblox-fetch') return;
    const port = event.ports[0];
    try {
      const r = await upstream(msg);
      port.postMessage({ ok: true, ...r }, [r.body]);
    } catch (err) {
      console.error('[proxy]', msg.method, msg.url, '-', err.message || err);
      port.postMessage({ ok: false, error: String(err.message || err) });
    }
  });
  navigator.serviceWorker.startMessages();
})();
