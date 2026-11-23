'use strict';

const fs = require('fs');
const path = require('path');

const SETTINGS_URL = 'https://clientsettingscdn.roblox.com/v2/settings/application/';
const CHANNELS = { web: 'WebClientApp', mac: 'MacDesktopClient', pc: 'PCDesktopClient' };
const TIMEOUT_MS = 30000;
const RETRIES = 3;
const MIN_ENTRIES = 1000;
const HISTORY_FILE = 'history.jsonl';
const HISTORY_LIMIT = 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchChannel(name, { fetchImpl = fetch, retries = RETRIES, minEntries = MIN_ENTRIES } = {}) {
  let failure = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(SETTINGS_URL + name, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body || typeof body.applicationSettings !== 'object' || Array.isArray(body.applicationSettings)) throw new Error('the answer has no applicationSettings');
      const count = Object.keys(body.applicationSettings).length;
      if (count < minEntries) throw new Error(`the answer has only ${count} entries`);
      return body.applicationSettings;
    } catch (error) {
      failure = error;
      if (attempt < retries) await sleep(1000 * attempt);
    }
  }
  throw new Error(`Could not fetch the ${name} flags: ${failure.message}`);
}

function snapshotFile(cacheDir, name) {
  return path.join(cacheDir, 'channels', `${name}.json`);
}

function readSnapshot(cacheDir, name) {
  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile(cacheDir, name), 'utf8'));
    return snapshot && snapshot.applicationSettings ? snapshot : null;
  } catch {
    return null;
  }
}

function difference(before, after) {
  const added = {};
  const removed = {};
  const changed = {};
  for (const [key, value] of Object.entries(after)) {
    if (!(key in before)) added[key] = value;
    else if (before[key] !== value) changed[key] = [before[key], value];
  }
  for (const [key, value] of Object.entries(before)) if (!(key in after)) removed[key] = value;
  return { added, removed, changed, count: Object.keys(added).length + Object.keys(removed).length + Object.keys(changed).length };
}

function appendHistory(cacheDir, record) {
  const file = path.join(cacheDir, HISTORY_FILE);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length > HISTORY_LIMIT) fs.writeFileSync(file, lines.slice(-HISTORY_LIMIT).join('\n') + '\n');
}

function readHistory(cacheDir) {
  const file = path.join(cacheDir, HISTORY_FILE);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function recordSnapshot(cacheDir, name, settings, now = new Date()) {
  const previous = readSnapshot(cacheDir, name);
  const file = snapshotFile(cacheDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ fetchedAt: now.toISOString(), applicationSettings: settings }));
  fs.renameSync(`${file}.tmp`, file);
  if (!previous) return null;
  const change = difference(previous.applicationSettings, settings);
  if (!change.count) return null;
  const record = { at: now.toISOString(), since: previous.fetchedAt, channel: name, added: change.added, removed: change.removed, changed: change.changed };
  appendHistory(cacheDir, record);
  return record;
}

async function fetchAll(names, options) {
  const out = {};
  await Promise.all(names.map(async name => {
    out[name] = await fetchChannel(name, options);
  }));
  return out;
}

module.exports = { fetchChannel, fetchAll, recordSnapshot, readSnapshot, readHistory, difference, CHANNELS, SETTINGS_URL };
