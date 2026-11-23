const { ISOLATION_HEADERS, readBody } = require('./shared');

const { noteScene } = require('./place-cache');
const { clientId } = require('./delivered');
const { SAVE_ASSETS } = require('./asset-files');

const SCENE_URL = /^https:\/\/apis\.roblox\.com\/webblox\/scene(?:\?|$)/;
const ENGINE_URL = /^https:\/\/apis\.roblox\.com\/webblox\/settings(?:\?|$)/;

const browsers = new Map();
const MAX_BROWSERS = 200;

function browserSettings(req) {
  const id = clientId(req) || '';
  let entry = browsers.get(id);
  if (!entry) {
    entry = { settings: {}, version: 0 };
    browsers.set(id, entry);
    if (browsers.size > MAX_BROWSERS) browsers.delete(browsers.keys().next().value);
  }
  return entry;
}

function send(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
  res.end(JSON.stringify(body));
}

function isEngineSettingsUrl(targetUrl) {
  return ENGINE_URL.test(targetUrl);
}

function isSceneUrl(targetUrl) {
  return SCENE_URL.test(targetUrl);
}

function handleScene(req, res, targetUrl) {
  if (SAVE_ASSETS) {
    const query = new URL(targetUrl).searchParams;
    let items = null;
    try { items = JSON.parse(query.get('items')); } catch {}
    if (Array.isArray(items)) noteScene(query.get('place'), items, clientId(req));
  }
  send(res, { enabled: SAVE_ASSETS });
}

function handleEngineSettings(req, res, targetUrl) {
  const entry = browserSettings(req);
  let update = null;
  try { update = JSON.parse(new URL(targetUrl).searchParams.get('set')); } catch {}
  if (update && typeof update === 'object' && !Array.isArray(update)) {
    let changed = false;
    for (const [key, value] of Object.entries(update)) {
      if (!['string', 'number', 'boolean'].includes(typeof value) || entry.settings[key] === value) continue;
      entry.settings[key] = value;
      changed = true;
    }
    if (changed) entry.version++;
  }
  send(res, entry.settings);
}

async function handlePageSettings(req, res, url) {
  if (url.searchParams.has('after')) {
    res.writeHead(410, ISOLATION_HEADERS);
    return res.end();
  }
  const entry = browserSettings(req);
  if (req.method === 'POST') {
    const body = await readBody(req);
    try {
      const posted = JSON.parse(body.toString('utf8'));
      if (posted && typeof posted === 'object' && !Array.isArray(posted)) entry.settings = posted;
    } catch {}
  }
  send(res, { version: entry.version, settings: entry.settings });
}

module.exports = { isEngineSettingsUrl, handleEngineSettings, isSceneUrl, handleScene, handlePageSettings };
