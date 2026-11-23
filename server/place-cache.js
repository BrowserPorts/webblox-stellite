const fs = require('fs');
const path = require('path');
const { BASE } = require('./config');
const files = require('./asset-files');

const DIR = path.join(BASE, '.cache', 'places');
const INDEX_FILE = path.join(DIR, 'index.json');
const NAME_URL = id => `https://economy.roblox.com/v2/assets/${id}/details`;

const ASSET_TYPES = {
  1: 'Image', 2: 'TShirt', 3: 'Audio', 4: 'Mesh', 5: 'Lua', 8: 'Hat', 9: 'Place', 10: 'Model', 11: 'Shirt', 12: 'Pants',
  13: 'Decal', 17: 'Head', 18: 'Face', 19: 'Gear', 24: 'Animation', 27: 'Torso', 28: 'RightArm', 29: 'LeftArm',
  30: 'LeftLeg', 31: 'RightLeg', 32: 'Package', 38: 'Plugin', 39: 'SolidModel', 40: 'MeshPart', 41: 'HairAccessory',
  42: 'FaceAccessory', 43: 'NeckAccessory', 44: 'ShoulderAccessory', 45: 'FrontAccessory', 46: 'BackAccessory',
  47: 'WaistAccessory', 48: 'ClimbAnimation', 49: 'DeathAnimation', 50: 'FallAnimation', 51: 'IdleAnimation',
  52: 'JumpAnimation', 53: 'RunAnimation', 54: 'SwimAnimation', 55: 'WalkAnimation', 56: 'PoseAnimation',
  59: 'LocalizationTableManifest', 61: 'EmoteAnimation', 62: 'Video', 63: 'TexturePack', 64: 'TShirtAccessory',
  65: 'ShirtAccessory', 66: 'PantsAccessory', 67: 'JacketAccessory', 68: 'SweaterAccessory', 69: 'ShortsAccessory',
  70: 'LeftShoeAccessory', 71: 'RightShoeAccessory', 72: 'DressSkirtAccessory', 73: 'FontFamily', 76: 'EyebrowAccessory',
  77: 'EyelashAccessory', 78: 'MoodAnimation', 79: 'DynamicHead', 88: 'FaceMakeup', 89: 'LipMakeup', 90: 'EyeMakeup',
};

const places = new Map();
const clients = new Map();
const lookups = new Map();
const AVATAR_TYPES = new Set([
  'Hat', 'HairAccessory', 'FaceAccessory', 'NeckAccessory', 'ShoulderAccessory', 'FrontAccessory', 'BackAccessory', 'WaistAccessory',
  'TShirtAccessory', 'ShirtAccessory', 'PantsAccessory', 'JacketAccessory', 'SweaterAccessory', 'ShortsAccessory', 'LeftShoeAccessory',
  'RightShoeAccessory', 'DressSkirtAccessory', 'EyebrowAccessory', 'EyelashAccessory', 'FaceMakeup', 'LipMakeup', 'EyeMakeup',
  'TShirt', 'Shirt', 'Pants', 'Head', 'Face', 'Torso', 'LeftArm', 'RightArm', 'LeftLeg', 'RightLeg', 'DynamicHead', 'Package',
  'ClimbAnimation', 'DeathAnimation', 'FallAnimation', 'IdleAnimation', 'JumpAnimation', 'RunAnimation', 'SwimAnimation', 'WalkAnimation',
  'PoseAnimation', 'MoodAnimation', 'EmoteAnimation', 'MeshHiddenSurfaceRemoval',
]);
const RECOVERABLE_TYPES = new Set(['Audio', 'Mesh', 'Image', 'Animation', 'SolidModel', 'FontFile', 'FontFamily', 'LocalizationTableTranslation']);
const BATCH_URL = 'https://assetdelivery.roblox.com/v1/assets/batch';
const NAME_DELAY_MS = 1000;
const NAME_BACKOFF_MS = 30 * 1000;
const RECOVER_BATCH = 50;
const CREATORS_FILE = path.join(DIR, 'creators.json');
const CREATOR_URL = ids => `https://develop.roblox.com/v1/assets?assetIds=${ids.join(',')}`;
const CREATOR_CHECKED_TYPES = new Set(['Image', 'Decal', 'Mesh', 'MeshPart', 'Model', 'SolidModel', 'Animation', 'TexturePack']);
const ROBLOX_CREATOR = 'User:1';
const CREATOR_BATCH = 50;
const CREATOR_DELAY_MS = 300;
const CREATOR_BACKOFF_MS = 30 * 1000;
const CREATOR_ATTEMPTS = 5;
const REVIEW_DELAY_MS = 3000;
const assetIdOf = text => (/[?&]id=(\d+)/i.exec(text || '') || /rbxassetid:\/\/(\d+)/i.exec(text || '') || /^(\d{4,})$/.exec(text || '') || [])[1] || null;
const creators = new Map();
const creatorQueue = new Set();
let creatorRun = null;
let creatorsFailed = false;
let creatorsTimer = null;
let reviewTimer = null;
let indexTimer = null;

const placeFile = id => path.join(DIR, `${id}.jsonl`);

function place(id) {
  let p = places.get(id);
  if (!p) {
    p = { id, name: null, universeId: null, joins: 0, firstJoin: null, lastJoin: null, assets: new Map(), pending: [], writing: false, gameIds: null, avatarIds: null, gameCreators: null, sceneLines: null, hrefs: new Map() };
    places.set(id, p);
  }
  return p;
}

function merge(p, line) {
  const old = p.assets.get(line.k);
  if (old) {
    for (const field of ['id', 'type', 'format', 'bytes', 'file']) if (line[field] != null) old[field] = line[field];
    return;
  }
  p.assets.set(line.k, { key: line.k, id: line.id ?? null, type: line.type ?? null, format: line.format ?? null, bytes: line.bytes ?? null, file: line.file ?? null, firstSeen: line.t });
}

function load() {
  try { for (const [id, creator] of Object.entries(JSON.parse(fs.readFileSync(CREATORS_FILE, 'utf8')))) creators.set(id, creator); } catch {}
  let index = {};
  try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch {}
  for (const [id, meta] of Object.entries(index)) Object.assign(place(id), meta, { id });
  let records = [];
  try { records = fs.readdirSync(DIR).filter(name => name.endsWith('.jsonl')); } catch {}
  for (const name of records) {
    const p = place(name.slice(0, -6));
    for (const text of fs.readFileSync(path.join(DIR, name), 'utf8').split('\n')) {
      if (!text) continue;
      try { merge(p, JSON.parse(text)); } catch {}
    }
    for (const asset of p.assets.values()) {
      files.known(asset);
      remember(asset.key, asset);
    }
  }
}

function saveIndex() {
  clearTimeout(indexTimer);
  indexTimer = setTimeout(() => {
    const out = {};
    for (const p of places.values()) {
      if (p.joins) out[p.id] = { name: p.name, universeId: p.universeId, dir: p.dir || null, joins: p.joins, firstJoin: p.firstJoin, lastJoin: p.lastJoin };
    }
    fs.promises.mkdir(DIR, { recursive: true })
      .then(() => fs.promises.writeFile(INDEX_FILE, JSON.stringify(out, null, 1)))
      .catch(() => {});
  }, 1000);
  indexTimer.unref();
}

function flush(p) {
  if (p.writing || !p.pending.length) return;
  p.writing = true;
  const lines = p.pending.splice(0).map(line => JSON.stringify(line)).join('\n') + '\n';
  fs.promises.mkdir(DIR, { recursive: true })
    .then(() => fs.promises.appendFile(placeFile(p.id), lines))
    .catch(() => {})
    .finally(() => {
      p.writing = false;
      flush(p);
    });
}

function record(p, key, fields) {
  const old = p.assets.get(key);
  const changed = {};
  let any = !old;
  for (const [field, value] of Object.entries(fields)) {
    if (value == null || (old && old[field] === value)) continue;
    changed[field] = value;
    any = true;
  }
  if (!any) return;
  const line = { k: key, t: Date.now(), ...changed };
  merge(p, line);
  p.pending.push(line);
  flush(p);
}

async function lookupName(p) {
  try {
    const res = await fetch(NAME_URL(p.id));
    if (!res.ok) return;
    const json = await res.json();
    if (json && typeof json.Name === 'string') {
      p.name = json.Name;
      saveIndex();
    }
  } catch {}
}

function noteJoin(client, joinScript) {
  const id = joinScript && joinScript.PlaceId != null ? String(joinScript.PlaceId) : null;
  if (!id) return;
  const p = place(id);
  const now = Date.now();
  p.joins++;
  p.firstJoin ??= now;
  p.lastJoin = now;
  if (joinScript.UniverseId != null) p.universeId = String(joinScript.UniverseId);
  clients.set(client || '', id);
  saveIndex();
  if (!p.name) p.nameLookup = lookupName(p);
}

const leavePlace = client => clients.delete(client || '');

const currentPlace = client => {
  const id = clients.get(client || '');
  return id ? place(id) : null;
};

const assetKey = url => url.hostname + url.pathname;

function remember(key, meta) {
  if ((meta.id || meta.type) && !lookups.has(key)) lookups.set(key, { id: meta.id, type: meta.type, format: meta.format });
}

function noteBatch(client, asked, answered) {
  const p = currentPlace(client);
  if (!Array.isArray(asked) || !Array.isArray(answered)) return;
  const byRequestId = new Map(asked.map(item => [String(item && item.requestId), item]));
  for (const item of answered) {
    if (!item) continue;
    const locations = Array.isArray(item.locations) ? [...item.locations] : [];
    if (typeof item.location === 'string') locations.push({ location: item.location });
    const ask = byRequestId.get(String(item.requestId)) || {};
    const id = ask.assetId ?? ask.assetVersionId ?? null;
    const type = ASSET_TYPES[item.assetTypeId] || ask.assetType || (item.assetTypeId != null ? String(item.assetTypeId) : null);
    for (const location of locations) {
      if (!location || typeof location.location !== 'string') continue;
      let url;
      try { url = new URL(location.location); } catch { continue; }
      const key = assetKey(url);
      const meta = { id: id == null ? null : String(id), type, format: location.assetFormat || null };
      remember(key, meta);
      if (!p) continue;
      if (meta.type === 'Audio') queueAudioName(p, meta.id);
      const known = p.assets.get(key);
      if (!known || (!known.id && !known.type)) record(p, key, meta);
      const asset = p.assets.get(key);
      if (files.hasFile(asset)) files.relocate(p, asset);
      else {
        p.hrefs.set(key, location.location);
        if (isGameAsset(p, asset)) files.saveLater(p, asset, location.location);
      }
    }
  }
}

function noteAsset(client, url, response) {
  const p = currentPlace(client);
  if (!p) return;
  const key = assetKey(url);
  const known = p.assets.get(key);
  const meta = !known || (!known.id && !known.type) ? lookups.get(key) : null;
  record(p, key, { ...meta, bytes: response && response.body ? response.body.length : null });
  const asset = p.assets.get(key);
  if (isGameAsset(p, asset)) files.saveResponse(p, asset, response);
}

function sceneGameIds(item) {
  const texts = item.k === 'mesh' || item.k === 'rp'
    ? [item.m, item.t, item.sa && item.sa.c, item.sa && item.sa.n, item.sa && item.sa.m, item.sa && item.sa.r, item.sa && item.sa.p]
    : item.k === 'image' || item.k === 'sound' || item.k === 'animation' || item.k === 'play' ? [item.id] : [];
  return texts.map(assetIdOf).filter(Boolean);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms).unref());

function saveCreators() {
  clearTimeout(creatorsTimer);
  creatorsTimer = setTimeout(() => {
    fs.promises.mkdir(DIR, { recursive: true })
      .then(() => fs.promises.writeFile(CREATORS_FILE, JSON.stringify(Object.fromEntries(creators))))
      .catch(() => {});
  }, 1000);
  creatorsTimer.unref();
}

async function fetchCreators(ids) {
  const res = await fetch(CREATOR_URL(ids), { headers: { 'user-agent': 'Roblox/WinInet' } });
  if (res.status === 400) {
    if (ids.length === 1) creators.set(ids[0], '');
    else {
      const half = Math.ceil(ids.length / 2);
      await fetchCreators(ids.slice(0, half));
      await fetchCreators(ids.slice(half));
    }
    return;
  }
  if (!res.ok) throw new Error(`creator lookup returned ${res.status}`);
  const json = await res.json();
  const found = new Map();
  for (const item of json.data || []) if (item.creator) found.set(String(item.id), `${item.creator.type}:${item.creator.targetId}`);
  for (const id of ids) creators.set(id, found.get(id) || '');
  saveCreators();
}

function pumpCreators() {
  if (creatorRun) return creatorRun;
  creatorRun = (async () => {
    let failures = 0;
    while (creatorQueue.size && failures < CREATOR_ATTEMPTS) {
      await wait(failures ? CREATOR_BACKOFF_MS : CREATOR_DELAY_MS);
      const ids = [...creatorQueue].slice(0, CREATOR_BATCH);
      try {
        await fetchCreators(ids);
        for (const id of ids) creatorQueue.delete(id);
        failures = 0;
      } catch (err) {
        failures++;
        if (failures === CREATOR_ATTEMPTS) console.error('[assets] creator lookup failed:', err.message);
      }
    }
    creatorsFailed = failures >= CREATOR_ATTEMPTS;
    creatorQueue.clear();
    creatorRun = null;
    for (const p of places.values()) if (p.gameIds) for (const id of p.gameIds) learnCreator(p, id);
    reviewLater();
  })();
  return creatorRun;
}

function queueCreator(id) {
  if (!files.SAVE_ASSETS || creators.has(id) || creatorQueue.has(id) || creatorsFailed) return;
  creatorQueue.add(id);
  pumpCreators();
}

function learnCreator(p, id) {
  const creator = creators.get(id);
  if (creator === undefined) queueCreator(id);
  else if (creator && creator !== ROBLOX_CREATOR && !p.gameCreators.has(creator)) p.gameCreators.add(creator);
}

function reviewLater() {
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(() => {
    if (creatorRun || creatorsFailed) return;
    for (const id of new Set(clients.values())) review(place(id));
  }, REVIEW_DELAY_MS);
  reviewTimer.unref();
}

const creatorPending = (p, asset) => CREATOR_CHECKED_TYPES.has(asset.type) && !p.gameIds.has(asset.id) && !p.avatarIds.has(asset.id) && !creators.has(asset.id);

function review(p) {
  for (const asset of p.assets.values()) {
    if (!asset.id) continue;
    if (isGameAsset(p, asset)) {
      const href = p.hrefs.get(asset.key);
      if (href) files.saveLater(p, asset, href);
    } else if (asset.file && !creatorPending(p, asset)) {
      files.removeFile(asset.file);
      record(p, asset.key, { file: '' });
    }
  }
}

function loadScene(p) {
  if (p.gameIds) return;
  p.gameIds = new Set();
  p.avatarIds = new Set();
  p.gameCreators = new Set();
  p.sceneLines = new Set();
  let text = '';
  try { text = fs.readFileSync(path.join(DIR, `${p.id}.scene.jsonl`), 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    p.sceneLines.add(line);
    try {
      const item = JSON.parse(line);
      for (const id of sceneGameIds(item)) {
        p.gameIds.add(id);
        if (item.k !== 'sound') learnCreator(p, id);
      }
      if (item.k === 'avatar' && assetIdOf(item.id)) p.avatarIds.add(assetIdOf(item.id));
    } catch {}
  }
}

function isGameAsset(p, asset) {
  if (!asset || !asset.id || AVATAR_TYPES.has(asset.type)) return false;
  loadScene(p);
  if (p.gameIds.has(asset.id)) return true;
  if (p.avatarIds.has(asset.id)) return false;
  if (!CREATOR_CHECKED_TYPES.has(asset.type)) return true;
  const creator = creators.get(asset.id);
  if (creator === undefined) queueCreator(asset.id);
  return Boolean(creator) && p.gameCreators.has(creator);
}

function noteScene(placeId, items, client) {
  const id = String(placeId || '');
  if (!/^\d+$/.test(id)) return;
  const p = place(id);
  loadScene(p);
  clients.set(client || '', id);
  const fresh = [];
  const confirmed = new Set();
  const flagged = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const text = JSON.stringify(item);
    if (p.sceneLines.has(text)) continue;
    p.sceneLines.add(text);
    fresh.push(text);
    if (item.k === 'avatar') {
      const assetId = assetIdOf(item.id);
      if (assetId) {
        p.avatarIds.add(assetId);
        flagged.add(assetId);
      }
    }
    for (const assetId of sceneGameIds(item)) {
      if (!p.gameIds.has(assetId)) confirmed.add(assetId);
      p.gameIds.add(assetId);
      if (item.k !== 'sound') learnCreator(p, assetId);
    }
  }
  if (confirmed.size || flagged.size) {
    for (const asset of p.assets.values()) {
      if (!asset.id) continue;
      if (asset.file && flagged.has(asset.id) && !isGameAsset(p, asset)) {
        files.removeFile(asset.file);
        record(p, asset.key, { file: '' });
      } else if (!files.hasFile(asset) && confirmed.has(asset.id)) {
        const href = p.hrefs.get(asset.key);
        if (href) files.saveLater(p, asset, href);
      }
    }
    reviewLater();
  }
  if (!fresh.length) return;
  fs.promises.mkdir(DIR, { recursive: true })
    .then(() => fs.promises.appendFile(path.join(DIR, `${id}.scene.jsonl`), fresh.join('\n') + '\n'))
    .catch(() => {});
}

const audioNames = [];
const audioNamesSeen = new Set();
let audioNamesRunning = false;

function queueAudioName(p, id) {
  if (!files.SAVE_ASSETS || !id || audioNamesSeen.has(`${p.id} ${id}`)) return;
  loadScene(p);
  audioNamesSeen.add(`${p.id} ${id}`);
  if (p.gameIds.has(id)) return;
  audioNames.push({ p, id });
  pumpAudioNames();
}

async function pumpAudioNames() {
  if (audioNamesRunning) return;
  audioNamesRunning = true;
  while (audioNames.length) {
    const { p, id } = audioNames.shift();
    let wait = NAME_DELAY_MS;
    try {
      const res = await fetch(NAME_URL(id));
      if (res.status === 429) {
        audioNames.unshift({ p, id });
        wait = NAME_BACKOFF_MS;
      } else if (res.ok) {
        const json = await res.json();
        if (json && typeof json.Name === 'string') noteScene(p.id, [{ k: 'sound', id: `rbxassetid://${id}`, n: json.Name }], [...clients].find(([, place]) => place === p.id)?.[0]);
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, wait).unref());
  }
  audioNamesRunning = false;
}

async function recoverMissing() {
  if (!files.SAVE_ASSETS) return;
  let queued = 0;
  for (const p of places.values()) {
    const saved = new Set();
    const missing = new Map();
    for (const asset of p.assets.values()) {
      if (asset.file) saved.add(asset.id);
      else if (RECOVERABLE_TYPES.has(asset.type) && isGameAsset(p, asset)) missing.set(asset.id, asset.type);
    }
    const ids = [...missing.keys()].filter(id => !saved.has(id));
    for (let at = 0; at < ids.length; at += RECOVER_BATCH) {
      const chunk = ids.slice(at, at + RECOVER_BATCH);
      try {
        const res = await fetch(BATCH_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'Roblox/WinInet', 'roblox-place-id': p.id },
          body: JSON.stringify(chunk.map((id, i) => ({ assetId: Number(id), assetType: missing.get(id), requestId: String(i) }))),
        });
        if (!res.ok) continue;
        for (const answer of await res.json()) {
          const id = chunk[Number(answer.requestId)];
          if (!answer.location || !id) continue;
          const key = assetKey(new URL(answer.location));
          record(p, key, { id, type: missing.get(id) });
          files.saveLater(p, p.assets.get(key), answer.location);
          queued++;
        }
      } catch (err) {
        console.error('[assets] recovery failed:', err.message);
      }
    }
    for (const asset of p.assets.values()) if (asset.type === 'Audio') queueAudioName(p, asset.id);
  }
  if (queued) console.log(`[assets] recovering ${queued} asset(s) that were looked up but not saved`);
}

async function checkCreators() {
  if (!files.SAVE_ASSETS) return;
  for (const p of places.values()) {
    loadScene(p);
    for (const asset of p.assets.values()) if (asset.id) isGameAsset(p, asset);
  }
  if (creatorRun) await creatorRun;
}

async function pruneSaved() {
  if (!files.SAVE_ASSETS || creatorsFailed) return;
  let removed = 0;
  for (const p of places.values()) {
    loadScene(p);
    for (const asset of [...p.assets.values()]) {
      if (!asset.file || isGameAsset(p, asset) || creatorPending(p, asset)) continue;
      if (await files.removeFile(asset.file)) removed++;
      record(p, asset.key, { file: '' });
    }
  }
  if (removed) console.log(`[assets] removed ${removed} saved file(s) that are not game assets`);
}

function summary(p, inMemory) {
  let bytes = 0;
  let resident = 0;
  let saved = 0;
  for (const asset of p.assets.values()) {
    bytes += asset.bytes || 0;
    if (asset.file) saved++;
    if (inMemory(asset.key)) resident++;
  }
  return { placeId: p.id, universeId: p.universeId, name: p.name, joins: p.joins, firstJoin: p.firstJoin, lastJoin: p.lastJoin,
           assetCount: p.assets.size, bytes, inMemory: resident, saved, folder: files.folderOf(p) };
}

function search({ place: id, q, type, limit } = {}, inMemory = () => false) {
  const max = Math.max(1, Math.min(Number(limit) || 500, 100000));
  const typeMatch = asset => !type || String(asset.type || '').toLowerCase() === String(type).toLowerCase();
  if (id) {
    const p = places.get(String(id));
    if (!p) return { error: `no cache records for place ${id}` };
    const needle = q ? String(q).toLowerCase() : null;
    const assets = [];
    for (const asset of p.assets.values()) {
      if (!typeMatch(asset)) continue;
      if (needle && !`${asset.id || ''} ${asset.key} ${asset.type || ''}`.toLowerCase().includes(needle)) continue;
      assets.push({ ...asset, path: asset.file ? files.absolute(asset.file) : null, inMemory: inMemory(asset.key) });
    }
    assets.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    return { ...summary(p, inMemory), matched: assets.length, assets: assets.slice(0, max) };
  }
  const needle = q ? String(q).toLowerCase() : null;
  const out = [];
  for (const p of places.values()) {
    const meta = `${p.id} ${p.universeId || ''} ${p.name || ''}`.toLowerCase();
    let assetHits = [];
    if (needle) {
      for (const asset of p.assets.values()) {
        if (typeMatch(asset) && (asset.id === needle || asset.key.toLowerCase().includes(needle))) assetHits.push(asset);
      }
      if (!meta.includes(needle) && !assetHits.length) continue;
    }
    const row = summary(p, inMemory);
    if (assetHits.length) row.assetMatches = assetHits.slice(0, 20).map(asset => ({ ...asset, inMemory: inMemory(asset.key) }));
    out.push(row);
  }
  out.sort((a, b) => (b.lastJoin || 0) - (a.lastJoin || 0));
  return { places: out.slice(0, max) };
}

files.init({ record, saveIndex, allowed: isGameAsset });
load();
files.repair([...places.values()]).then(checkCreators).then(pruneSaved).then(recoverMissing);

module.exports = { noteJoin, leavePlace, noteBatch, noteAsset, noteScene, search, DIR };
