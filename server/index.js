const http = require('http');
const { PORT, ENGINE_VERSION } = require('./config');
const { ISOLATION_HEADERS, isTrustedRequest, hasToken } = require('./shared');
const { eraAssetAtUrl } = require('./ui-eras');
const { serveLauncher, sendFile, serveMetadata, serveUiEra, serveUiEras, resolveFile, missingAssetLog, pruneEncodedCache, warmEncodedAssets, warmStatic, METADATA_FILE, assetStats, fileCacheMB } = require('./static');
const { proxyStats, inflight, residentMB, proxyCache } = require('./proxy-cache');
const placeCache = require('./place-cache');
const upstream = require('./upstream');
const assetFiles = require('./asset-files');
const { PROXY_PREFIX, handleProxy, ASSET_LOG, refusedAssets, requestedAssets } = require('./proxy');
const { handleShaderPost, serveShaderList } = require('./shader-list');
const { isEngineSettingsUrl, handleEngineSettings, isSceneUrl, handleScene, handlePageSettings } = require('./settings');
const { startLauncherUpdates } = require('./launcher-updates');
const { startFlagWatch, flagSetName, serveFlagSet } = require('./flag-watch');
const { lastGameJoin } = require('./join');
const { handleGlTrace } = require('./gl-trace');

const ENGINE_PARAMS = ['placeId', 'launcher', 'flag'];

function handle(req, res) {
  if (!isTrustedRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...ISOLATION_HEADERS, 'Access-Control-Max-Age': '86400' });
    res.end();
    return;
  }

  if (/^\/(__proxy__\/|__settings|__shaders|__assets)/.test(req.url) && !hasToken(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain', ...ISOLATION_HEADERS });
    res.end('Missing WebBlox token: reload the page served by this server');
    return;
  }

  if (req.url.startsWith(PROXY_PREFIX)) {
    const targetUrl = req.url.slice(PROXY_PREFIX.length);
    if (isEngineSettingsUrl(targetUrl)) {
      handleEngineSettings(req, res, targetUrl);
      return;
    }
    if (isSceneUrl(targetUrl)) {
      handleScene(req, res, targetUrl);
      return;
    }
    handleProxy(req, res, targetUrl).catch(err => {
      console.error('[proxy] unhandled:', err.message);
      if (!res.headersSent) res.writeHead(502, ISOLATION_HEADERS);
      try { res.end('Proxy error'); } catch {}
    });
    return;
  }

  let url;
  let urlPath;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
    urlPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, ISOLATION_HEADERS);
    res.end('Bad request');
    return;
  }

  if (urlPath.includes('..')) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (urlPath === '/games/start' || urlPath === '/games/start/') {
    res.writeHead(302, { Location: '/' + url.search, 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
    res.end();
    return;
  }

  if (urlPath === '/roblox') {
    res.writeHead(302, { Location: '/?launcher=roblox', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
    res.end();
    return;
  }

  if (urlPath === '/' && !ENGINE_PARAMS.some(name => url.searchParams.has(name))) {
    if (url.searchParams.get('mode') === 'wisp') {
      res.writeHead(302, { Location: `/launcher/${url.search}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    serveLauncher(req, res);
    return;
  }

  if (urlPath === '/launcher/' || urlPath === '/launcher/index.html') {
    serveLauncher(req, res);
    return;
  }

  if (urlPath === '/perf-collect/ingest' || urlPath.startsWith('/perf-collect/')) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...ISOLATION_HEADERS });
    res.end('{}');
    return;
  }

  if (urlPath === '/__assets') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
    res.end(JSON.stringify({ enabled: ASSET_LOG, refused: [...refusedAssets.values()], requested: requestedAssets }, null, 2));
    return;
  }

  if (urlPath === '/__cache') {
    const query = Object.fromEntries(url.searchParams);
    const result = placeCache.search(query, key => proxyCache.has(`G https://${key}`));
    res.writeHead(result.error ? 404 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  if (urlPath === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
    res.end(JSON.stringify({
      proxy: { ...proxyStats, inflight: inflight.size, residentMB: residentMB() },
      assets: { ...assetStats, fileCacheMB: fileCacheMB() },
      rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
      cpuMs: (({ user, system }) => Math.round((user + system) / 1000))(process.cpuUsage()),
      uptimeS: Math.round(process.uptime()),
      lastGameJoin: lastGameJoin(),
    }));
    return;
  }

  const flagSet = flagSetName(urlPath);
  if (flagSet && (req.method === 'GET' || req.method === 'HEAD')) {
    serveFlagSet(res, flagSet);
    return;
  }

  if (urlPath === '/__uiera') {
    serveUiEra(req, res);
    return;
  }
  if (urlPath === '/__uieras') {
    serveUiEras(req, res);
    return;
  }
  if (urlPath === '/__settings' && (req.method === 'GET' || req.method === 'POST')) {
    handlePageSettings(req, res, url).catch(err => {
      console.error('[settings] failed:', err.message);
      if (!res.headersSent) res.writeHead(500, ISOLATION_HEADERS);
      res.end();
    });
    return;
  }

  if (urlPath === '/gen/shader-warmup.json' && (req.method === 'GET' || req.method === 'HEAD')) {
    serveShaderList(req, res).catch(err => {
      console.error('[shaders] serve failed:', err.message);
      if (!res.headersSent) res.writeHead(500, ISOLATION_HEADERS);
      res.end();
    });
    return;
  }

  if (handleGlTrace(req, res, urlPath)) return;

  if (urlPath === '/__shaders' && req.method === 'POST') {
    handleShaderPost(req, res).catch(err => {
      console.error('[shaders] merge failed:', err.message);
      if (!res.headersSent) res.writeHead(500, ISOLATION_HEADERS);
      res.end();
    });
    return;
  }

  const filePath = eraAssetAtUrl(req, urlPath) || resolveFile(urlPath);
  if (!filePath) {
    if (!missingAssetLog.has(urlPath)) {
      missingAssetLog.add(urlPath);
      console.log(`[404] ${req.method} ${urlPath}`);
    }
    res.writeHead(404, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'public, max-age=60',
      ...ISOLATION_HEADERS,
    });
    res.end(`Not found: ${urlPath}`);
    return;
  }

  const failed = err => {
    console.error('Error serving', urlPath, err);
    if (!res.headersSent) res.writeHead(500, ISOLATION_HEADERS);
    res.end();
  };
  try {
    if (filePath === METADATA_FILE) {
      serveMetadata(req, res, filePath);
      return;
    }
    sendFile(req, res, filePath).catch(failed);
  } catch (err) {
    failed(err);
  }
}

const server = http.createServer(handle);
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 70 * 1000;
server.on('connection', (socket) => { try { socket.setNoDelay(true); } catch {} });

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nWebBlox server running at:\n`);
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  http://localhost:${PORT}/?placeId=YOUR_PLACE_ID`);
  console.log(`  http://localhost:${PORT}/roblox (the Roblox launcher)\n`);
  console.log(`Engine: ${ENGINE_VERSION}\n`);
  if (assetFiles.SAVE_ASSETS) console.log(`Saving game assets to ${assetFiles.FILES_DIR}\n`);
  warmStatic();
  pruneEncodedCache();
  warmEncodedAssets();
  startLauncherUpdates();
  startFlagWatch();
  upstream.startWarming();

  setInterval(() => {
    if (proxyStats.hits || proxyStats.misses) {
      console.log(`[cache] proxy ${proxyStats.hits} hit / ${proxyStats.misses} miss / ${proxyStats.coalesced} coalesced, ${residentMB()}MB resident, ${(proxyStats.bytesServed / 1048576).toFixed(1)}MB served locally`);
    }
    if (assetStats.served) {
      console.log(`[cache] assets ${assetStats.served} sent (${(assetStats.bytes / 1048576).toFixed(1)}MB), ${assetStats.notModified} not-modified`);
    }
  }, 60000);
});
