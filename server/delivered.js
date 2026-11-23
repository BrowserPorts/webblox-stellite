const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BASE } = require('./config');
const { CDN_ASSET_HOST, readCookie } = require('./shared');

const DIR = path.join(BASE, '.cache', 'delivered');
const CLIENT_COOKIE = 'webblox_client';
const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_KEYS = 200000;
const clients = new Map();

function clientId(req) {
  const id = readCookie(req, CLIENT_COOKIE);
  return id && CLIENT_ID.test(id) ? id : null;
}

function newClientCookie() {
  const id = crypto.randomBytes(18).toString('base64url');
  return `${CLIENT_COOKIE}=${id}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly`;
}

function assetKey(url) {
  return CDN_ASSET_HOST.test(url.hostname) ? url.hostname + url.pathname : null;
}

function store(id) {
  let entry = clients.get(id);
  if (entry) return entry;
  const file = path.join(DIR, `${id}.txt`);
  const keys = new Set();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line) keys.add(line);
  } catch {}
  entry = { file, keys, pending: [], flushing: false };
  clients.set(id, entry);
  return entry;
}

function flush(entry) {
  if (entry.flushing || !entry.pending.length) return;
  entry.flushing = true;
  const lines = entry.pending.splice(0).join('\n') + '\n';
  fs.promises.mkdir(DIR, { recursive: true })
    .then(() => fs.promises.appendFile(entry.file, lines))
    .catch(() => {})
    .finally(() => {
      entry.flushing = false;
      flush(entry);
    });
}

function wasDelivered(id, url) {
  const key = id && assetKey(url);
  return Boolean(key && store(id).keys.has(key));
}

function markDelivered(id, url) {
  const key = id && assetKey(url);
  if (!key) return;
  const entry = store(id);
  if (entry.keys.has(key) || entry.keys.size >= MAX_KEYS) return;
  entry.keys.add(key);
  entry.pending.push(key);
  flush(entry);
}

module.exports = { clientId, newClientCookie, wasDelivered, markDelivered };
