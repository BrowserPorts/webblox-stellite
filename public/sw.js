const NODE_MODE = new URL(self.location.href).searchParams.get('mode') === 'node';
// The folder this worker is served from. Every path below is relative to it
const BASE = new URL('./', self.location.href).pathname;
const ROOT = self.location.origin + BASE;
const local = name => BASE + name;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('webblox-assets-') && name !== 'webblox-assets-2') await caches.delete(name);
  await self.clients.claim();
})()));

const SETTINGS_URL = /^https:\/\/apis\.roblox\.com\/webblox\/settings(?:\?|$)/;

if (!NODE_MODE) {
  self.addEventListener('fetch', event => {
    if (!SETTINGS_URL.test(event.request.url)) return;
    event.stopImmediatePropagation();
    event.respondWith(settingsReply(event.request.url));
  });
}

async function settingsReply(url) {
  const pages = await self.clients.matchAll({ type: 'window' });
  const replies = await Promise.all(pages.map(page => new Promise(resolve => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 2000);
    ch.port1.onmessage = e => { clearTimeout(timer); resolve(e.data); };
    page.postMessage({ type: 'webblox-settings', url }, [ch.port2]);
  })));
  const body = replies.find(Boolean);
  return new Response(body || '{"error":"no page"}', {
    status: body ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

if (NODE_MODE) {
  self.addEventListener('fetch', event => {
    const url = event.request.url;
    if (!/^https?:\/\//.test(url) || new URL(url).origin === self.location.origin) return;
    event.respondWith(proxyRequest(event.request, url));
  });

  async function proxyRequest(request, originalUrl) {
    try {
      const proxyUrl = ROOT + '__proxy__/' + originalUrl;

      const headers = {};
      for (const [key, value] of request.headers) headers[key] = value;

      const init = { method: request.method, headers, credentials: 'same-origin' };

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        try {
          const body = await request.arrayBuffer();
          if (body.byteLength > 0) init.body = body;
        } catch {}
      }

      return await fetch(proxyUrl, init);
    } catch (err) {
      console.error('[sw] proxy failed for', originalUrl, err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}

if (!NODE_MODE) {
  const WEBCLIENT = local('engine/');
  const LAUNCHER_PATH = local('launcher/');
  const PAGE_WATCH_MS = 1000;
  const ENGINE_PARAMS = ['placeId', 'launcher', 'flag'];
  const ISOLATION = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };

  let routes = null;
  const loadRoutes = () => (routes ??= fetch(local('gen/routes.json')).then(r => r.json()));

  const FRAME_PREFIX = local('__frame__/');
  const PROXY_PREFIX = local('__proxy__/');
  const IN_APP_UA = ' RobloxApp/0.745.0.7451145 (GlobalDist; RobloxDirectDownload)';
  const FRAME_BLOCKING_HEADERS = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only'];
  const FRAME_SCRIPT = `<script>(function(){var P=location.origin+'${FRAME_PREFIX}';function w(u){try{var x=new URL(u,document.baseURI);if(x.origin===location.origin||!/^https?:$/.test(x.protocol))return null;return P+x.href}catch(e){return null}}document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a||e.defaultPrevented||a.target==='_blank')return;var u=w(a.href);if(u){e.preventDefault();location.href=u}},true);document.addEventListener('submit',function(e){var f=e.target;if(!f||(f.method||'get').toLowerCase()!=='get')return;var u=w(f.action);if(u){e.preventDefault();location.href=u+(u.indexOf('?')<0?'?':'&')+new URLSearchParams(new FormData(f))}},true);['pushState','replaceState'].forEach(function(k){var o=history[k];history[k]=function(s,t,u){if(u!=null){var p=w(u);if(p)u=p.slice(location.origin.length)}return o.call(this,s,t,u)}})})()<\/script>`;

  const QUICK_LOGIN = /^https:\/\/(?:apis\.roblox\.com\/auth-token-service\/v1\/login\/(create|status|cancel)|auth\.roblox\.com\/v2\/(login))(?:[?#]|$)/;
  let quickLoginChannel = null;

  function watchQuickLogin(target, response) {
    const match = QUICK_LOGIN.exec(target);
    if (!match) return response;
    response.clone().text().then(body => {
      let status = '';
      try { status = JSON.parse(body).status || ''; } catch {}
      if (!status && body.includes('CodeInvalid')) status = 'CodeInvalid';
      quickLoginChannel ??= new BroadcastChannel('webblox-quick-login');
      quickLoginChannel.postMessage({ step: match[1] || match[2], status, httpStatus: response.status });
    }).catch(() => {});
    return response;
  }

  function isolate(resp) {
    if (resp.type === 'opaque' || resp.type === 'opaqueredirect') return resp;
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(ISOLATION)) headers.set(k, v);
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
  }

  const ASSET_CACHE = 'webblox-assets-2';
  const ASSET_HOST = /(^|\.)rbxcdn\.com$/i;
  let assetCache = null;
  const assetKey = href => {
    const m = new URL(href).pathname.match(/\/([0-9a-f]{32})$/i);
    return m ? `https://rbxcdn.webblox/${m[1].toLowerCase()}` : href;
  };

  async function cachedAsset(request, target) {
    if (request.method !== 'GET' || request.headers.has('range')) return null;
    if (!ASSET_HOST.test(new URL(target).hostname)) return null;
    try {
      assetCache ??= caches.open(ASSET_CACHE);
      const cache = await assetCache;
      const key = assetKey(target);
      const hit = await cache.match(key);
      if (!hit) return null;
      if (Number(hit.headers.get('x-webblox-expires')) > Date.now()) return hit;
      cache.delete(key);
    } catch {}
    return null;
  }

  function text(status, body, extra = {}) {
    return isolate(new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...extra } }));
  }

  self.addEventListener('fetch', event => {
    const { request } = event;
    if (!/^https?:/.test(request.url)) return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) {
      event.respondWith(crossOrigin(request, event.clientId));
      return;
    }
    event.respondWith(serveLocal(request, url, event.clientId));
  });

  async function crossOrigin(request, clientId) {
    if (request.destination === 'image') {
      const client = clientId && await self.clients.get(clientId);
      if (client && new URL(client.url).pathname.startsWith(LAUNCHER_PATH)) {
        try {
          return await fetch(request.url, { mode: 'cors', credentials: 'omit' });
        } catch {}
      }
    }
    return relay(request, request.url, clientId);
  }

  async function serveLocal(request, url, clientId) {
    // A root path left in a page or in the engine still means a file in this folder
    if (!url.pathname.startsWith(BASE)) url = new URL(ROOT + url.pathname.slice(1) + url.search);
    const pathname = decodeURIComponent(url.pathname);
    const from = target => fetch(target, { headers: request.headers }).then(isolate);

    if (pathname.startsWith(FRAME_PREFIX)) return frame(request, url, clientId);
    if (pathname.startsWith(PROXY_PREFIX)) {
      const target = url.href.slice(self.location.origin.length + PROXY_PREFIX.length);
      return SETTINGS_URL.test(target) ? settingsReply(target).then(isolate) : relay(request, target, clientId);
    }
    if (pathname.startsWith(local('perf-collect/'))) {
      return isolate(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
    }
    if (pathname === BASE && !ENGINE_PARAMS.some(name => url.searchParams.has(name))) {
      return Response.redirect(`${LAUNCHER_PATH}${url.search}`, 302);
    }
    if (pathname === BASE || pathname === local('games/start')) return from(local('index.html'));
    if (request.mode === 'navigate' && pathname.startsWith(LAUNCHER_PATH)) {
      const page = await fetch(url.href);
      return new Response(page.body, { status: page.status, statusText: page.statusText, headers: page.headers });
    }

    if (pathname.startsWith(WEBCLIENT)) {
      const name = pathname.slice(WEBCLIENT.length);
      if (CJK_FONT.test(name) && !WANTS_CJK) return text(404, 'Left out for this language', { 'Cache-Control': 'no-store' });
      const early = !request.headers.has('range') && warmed.get(name);
      if (early) {
        warmed.delete(name);
        return early;
      }
      const served = (await loadRoutes())[name];
      return served
        ? from(local(served.replace(/^\//, '')))
        : text(404, `Not found: ${pathname}`, { 'Cache-Control': 'public, max-age=60' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return fetch(request).then(isolate);
    return from(url.href);
  }

  // The CJK font is 16 MB and the engine fetches it on every start. A browser whose languages include none of Chinese,
  // Japanese or Korean goes without it, at the cost of those scripts drawing as boxes in names and chat
  const CJK_FONT = /NotoSansCJK[^/]*\.otf$/i;
  const WANTS_CJK = (navigator.languages || [navigator.language || '']).some(tag => /^(zh|ja|ko)\b/i.test(tag));

  // Engine files the page asked for ahead of time. The page has the relay and the session to set up before the engine
  // starts, so the big downloads run beside that instead of after it. Each answer is handed out once
  const warmed = new Map();
  self.addEventListener('message', event => {
    const msg = event.data;
    if (!msg || msg.type !== 'webblox-warm' || !Array.isArray(msg.files)) return;
    event.waitUntil(loadRoutes().then(table => {
      for (const name of msg.files) {
        if (warmed.has(name) || !table[name]) continue;
        const answer = fetch(local(table[name].replace(/^\//, ''))).then(isolate);
        answer.catch(() => warmed.delete(name));
        warmed.set(name, answer);
      }
    }));
  });

  async function topPage(clientId) {
    // The page that owns the transport is the engine page or the launcher. Embedded in another site it is a frame, not
    // the top window, and a web view inside it is one of ours too but has no transport of its own
    const host = page => page.type === 'window' && !new URL(page.url).pathname.startsWith(FRAME_PREFIX);
    const own = clientId && await self.clients.get(clientId);
    if (own && host(own)) return own;
    for (let i = 0; i < 50; i++) {
      const pages = (await self.clients.matchAll({ type: 'window' })).filter(host);
      const page = pages.find(p => p.frameType === 'top-level') || pages[0];
      if (page) return page;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('no window to relay through');
  }

  async function upstream(url, method, headers, body, clientId) {
    const page = await topPage(clientId);
    const reply = await new Promise((resolve, reject) => {
      const ch = new MessageChannel();
      const stop = () => { clearTimeout(timer); clearInterval(watch); };
      const timer = setTimeout(() => { stop(); reject(new Error('upstream timed out')); }, 120000);
      const watch = setInterval(async () => {
        if (await self.clients.get(page.id)) return;
        stop();
        reject(new Error('the page closed'));
      }, PAGE_WATCH_MS);
      ch.port1.onmessage = e => { stop(); resolve(e.data); };
      page.postMessage(
        { type: 'webblox-fetch', url, method, headers, body },
        body && body.byteLength ? [ch.port2, body] : [ch.port2]
      );
    });
    if (!reply.ok) throw new Error(reply.error);
    return reply;
  }

  async function frame(request, url, clientId) {
    const target = url.href.slice(self.location.origin.length + FRAME_PREFIX.length);
    try {
      const headers = {};
      for (const [k, v] of request.headers) headers[k] = v;
      headers['user-agent'] = navigator.userAgent + IN_APP_UA;
      const reply = await upstream(target, 'GET', headers, null, clientId);
      const out = new Headers(reply.headers);
      for (const name of FRAME_BLOCKING_HEADERS) out.delete(name);
      let body = reply.body;
      if (/text\/html/i.test(out.get('content-type') || '')) {
        let html = new TextDecoder().decode(reply.body);
        const head = html.match(/<head[^>]*>/i);
        const inject = `<base href="${target.replace(/"/g, '&quot;')}">${FRAME_SCRIPT}`;
        html = head ? html.slice(0, head.index + head[0].length) + inject + html.slice(head.index + head[0].length) : inject + html;
        body = new TextEncoder().encode(html);
      }
      return isolate(new Response(body, { status: reply.status, statusText: reply.statusText, headers: out }));
    } catch (err) {
      return text(502, `Could not load ${target}: ${err.message || err}`);
    }
  }

  async function relay(request, target, clientId) {
    try {
      const hit = await cachedAsset(request, target);
      if (hit) return isolate(hit);
      const headers = {};
      for (const [k, v] of request.headers) headers[k] = v;
      const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
      const reply = await upstream(target, request.method, headers, body, clientId);
      const empty = [101, 204, 205, 304].includes(reply.status);
      return watchQuickLogin(target, isolate(new Response(empty ? null : reply.body, {
        status: reply.status, statusText: reply.statusText, headers: reply.headers,
      })));
    } catch (err) {
      console.error('[sw] upstream failed for', target, err);
      return isolate(new Response(JSON.stringify({ error: String(err.message || err) }), {
        status: 502, headers: { 'Content-Type': 'application/json' },
      }));
    }
  }
}
