const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { BASE } = require('./config');
const { proxyCache } = require('./proxy-cache');
const upstream = require('./upstream');

const SAVE_ASSETS = process.env.SAVE_ASSETS === '1';
const FILES_DIR = path.resolve(BASE, process.env.SAVE_ASSETS_DIR || 'game-cache');
const FETCH_DELAY_MS = 15 * 1000;
const FETCH_CONCURRENCY = 4;
const NAME_WAIT_MS = 5000;

const byKey = new Map();
const busy = new Set();
const queued = new Set();
const reserved = new Set();
const queue = [];
let active = 0;
let timer = null;
let hooks = { record: () => {}, saveIndex: () => {}, allowed: () => true };

const absolute = rel => path.join(FILES_DIR, ...rel.split('/'));
const exists = file => fs.promises.access(file).then(() => true, () => false);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms).unref());

const startsWith = (b, text, at = 0) => b.length >= at + text.length && b.toString('latin1', at, at + text.length) === text;

function sniff(b) {
  if (startsWith(b, '\x89PNG')) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (startsWith(b, 'GIF8')) return 'gif';
  if (startsWith(b, 'RIFF') && startsWith(b, 'WEBP', 8)) return 'webp';
  if (startsWith(b, 'RIFF') && startsWith(b, 'WAVE', 8)) return 'wav';
  if (startsWith(b, '\xabKTX 11')) return 'ktx';
  if (startsWith(b, '\xabKTX 20')) return 'ktx2';
  if (startsWith(b, 'DDS ')) return 'dds';
  if (startsWith(b, 'OggS')) return 'ogg';
  if (startsWith(b, 'fLaC')) return 'flac';
  if (startsWith(b, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (startsWith(b, 'ftyp', 4)) return 'mp4';
  if (startsWith(b, '<roblox!')) return 'rbxm';
  if (startsWith(b, '<roblox')) return 'rbxmx';
  if (startsWith(b, 'version ')) return 'mesh';
  if (startsWith(b, 'OTTO')) return 'otf';
  if (startsWith(b, '\x00\x01\x00\x00')) return 'ttf';
  if (startsWith(b, 'wOFF')) return 'woff';
  if (startsWith(b, 'wOF2')) return 'woff2';
  if (startsWith(b, '\x28\xb5\x2f\xfd')) return 'zst';
  const head = b.toString('utf8', 0, 64).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return 'bin';
}

const zstdDecompress = zlib.zstdDecompress ? promisify(zlib.zstdDecompress) : null;

async function unpack(body) {
  return zstdDecompress && startsWith(body, '\x28\xb5\x2f\xfd') ? zstdDecompress(body) : body;
}

function hashOf(key) {
  const hashes = key.match(/[0-9a-f]{32}/gi);
  return hashes ? hashes[hashes.length - 1].toLowerCase() : crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

const safeName = text => String(text || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80);

const CONTENT_FOLDERS = {
  png: 'Image', jpg: 'Image', gif: 'Image', webp: 'Image', ktx: 'Image', ktx2: 'Image', dds: 'Image',
  ogg: 'Audio', mp3: 'Audio', wav: 'Audio', flac: 'Audio',
  mesh: 'Mesh',
  ttf: 'FontFile', otf: 'FontFile', woff: 'FontFile', woff2: 'FontFile',
  webm: 'Video', mp4: 'Video',
  rbxm: 'Model', rbxmx: 'Model',
  json: 'Data',
};
const IMAGE_TYPES = new Set(['Image', 'Decal', 'Face', 'TexturePack']);
const THUMBNAIL_KEY = /^(tr|t\d)\.rbxcdn\.com\/|^thumbnails\./i;

function typeFolder(asset, ext) {
  const byContent = CONTENT_FOLDERS[ext.slice(1)] || 'Other';
  if (byContent === 'Image' && THUMBNAIL_KEY.test(asset.key)) return 'Thumbnails';
  const type = safeName(asset.type);
  if (!type || /^\d+$/.test(type)) return byContent;
  if (byContent === 'Audio' || (byContent === 'Image' && !IMAGE_TYPES.has(type)) || (byContent === 'Mesh' && !type.startsWith('Mesh'))) return byContent;
  return type;
}

const baseName = asset => (asset.id ? String(asset.id) : hashOf(asset.key));

async function placeDir(p) {
  if (p.dir) return p.dir;
  if (!p.name && p.nameLookup) await Promise.race([p.nameLookup, sleep(NAME_WAIT_MS)]);
  if (p.dir) return p.dir;
  const name = safeName(p.name);
  p.dir = name ? `${name} (${p.id})` : p.id;
  hooks.saveIndex();
  return p.dir;
}

async function target(p, asset, ext) {
  const folder = `${await placeDir(p)}/${typeFolder(asset, ext)}`;
  const base = baseName(asset);
  let rel = `${folder}/${base}${ext}`;
  if (reserved.has(rel) || await exists(absolute(rel))) rel = `${folder}/${base}-${hashOf(asset.key).slice(0, 8)}${ext}`;
  reserved.add(rel);
  return rel;
}

async function writeFile(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(temp, data);
  await fs.promises.rename(temp, file);
}

async function linkFile(source, file) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  try { await fs.promises.link(source, file); } catch { await fs.promises.copyFile(source, file); }
}

async function ensure(p, asset, getBody) {
  const tag = `${p.id} ${asset.key}`;
  if (busy.has(tag) || !hooks.allowed(p, asset)) return;
  busy.add(tag);
  try {
    if (asset.file && await exists(absolute(asset.file))) return;
    const source = byKey.get(asset.key);
    let rel;
    let bytes;
    if (source && await exists(source)) {
      rel = await target(p, asset, path.extname(source));
      await linkFile(source, absolute(rel));
      bytes = (await fs.promises.stat(absolute(rel))).size;
    } else {
      const fetched = await getBody();
      if (!fetched || !fetched.length) return;
      const body = await unpack(fetched);
      rel = await target(p, asset, `.${sniff(body)}`);
      await writeFile(absolute(rel), body);
      bytes = body.length;
    }
    if (!byKey.has(asset.key)) byKey.set(asset.key, absolute(rel));
    hooks.record(p, asset.key, { file: rel, bytes });
  } catch (err) {
    console.error('[assets] save failed:', asset.key, err.message);
  } finally {
    busy.delete(tag);
  }
}

async function relocate(p, asset) {
  if (!SAVE_ASSETS || !asset || !asset.file) return false;
  const ext = path.posix.extname(asset.file);
  const parts = asset.file.split('/');
  const name = parts[parts.length - 1];
  const base = baseName(asset);
  if (parts[parts.length - 2] === typeFolder(asset, ext) && (name === `${base}${ext}` || name.startsWith(`${base}-`))) return false;
  const tag = `${p.id} ${asset.key}`;
  if (busy.has(tag)) return false;
  busy.add(tag);
  try {
    const old = absolute(asset.file);
    if (!await exists(old)) return false;
    const rel = await target(p, asset, ext);
    const next = absolute(rel);
    await fs.promises.mkdir(path.dirname(next), { recursive: true });
    await fs.promises.rename(old, next);
    await fs.promises.rename(`${old}.png`, `${next}.png`).catch(() => {});
    if (byKey.get(asset.key) === old) byKey.set(asset.key, next);
    await fs.promises.rmdir(path.dirname(old)).catch(() => {});
    hooks.record(p, asset.key, { file: rel });
    return true;
  } catch (err) {
    console.error('[assets] move failed:', asset.key, err.message);
    return false;
  } finally {
    busy.delete(tag);
  }
}

async function unpackSaved(p, asset) {
  if (!zstdDecompress || !asset.file || path.posix.extname(asset.file) !== '.zst') return false;
  const tag = `${p.id} ${asset.key}`;
  if (busy.has(tag)) return false;
  busy.add(tag);
  try {
    const old = absolute(asset.file);
    if (!await exists(old)) return false;
    const source = byKey.get(asset.key);
    let rel;
    let bytes;
    if (source && path.extname(source) !== '.zst' && await exists(source)) {
      rel = await target(p, asset, path.extname(source));
      await linkFile(source, absolute(rel));
      bytes = (await fs.promises.stat(absolute(rel))).size;
    } else {
      const body = await unpack(await fs.promises.readFile(old));
      rel = await target(p, asset, `.${sniff(body)}`);
      await writeFile(absolute(rel), body);
      bytes = body.length;
      byKey.set(asset.key, absolute(rel));
    }
    await fs.promises.rm(old, { force: true });
    reserved.delete(asset.file);
    await fs.promises.rmdir(path.dirname(old)).catch(() => {});
    hooks.record(p, asset.key, { file: rel, bytes });
    return true;
  } catch (err) {
    console.error('[assets] unpack failed:', asset.key, err.message);
    return false;
  } finally {
    busy.delete(tag);
  }
}

async function repair(places) {
  if (!SAVE_ASSETS) return;
  let moved = 0;
  let unpacked = 0;
  for (const p of places) {
    for (const asset of [...p.assets.values()]) {
      if (await unpackSaved(p, asset)) unpacked++;
      else if (await relocate(p, asset)) moved++;
    }
  }
  if (unpacked) console.log(`[assets] unpacked ${unpacked} compressed file(s)`);
  if (moved) console.log(`[assets] moved ${moved} saved file(s) to their type folders`);
}

async function removeFile(rel) {
  const file = absolute(rel);
  try {
    await fs.promises.rm(file, { force: true });
    await fs.promises.rm(`${file}.png`, { force: true });
    reserved.delete(rel);
    await fs.promises.rmdir(path.dirname(file)).catch(() => {});
    if ([...byKey.values()].includes(file)) {
      for (const [key, value] of byKey) if (value === file) byKey.delete(key);
    }
    return true;
  } catch {
    return false;
  }
}

function saveResponse(p, asset, response) {
  if (!SAVE_ASSETS || !p || !asset || !response || !response.body) return;
  ensure(p, asset, () => upstream.decode(response.body, response.encoding));
}

async function download(href) {
  const hit = proxyCache.get(`G ${href}`);
  if (hit) return upstream.decode(hit.body, hit.encoding);
  const url = new URL(href);
  const up = await upstream.request(url);
  if (up.status !== 200) return null;
  return upstream.decode(up.body, upstream.contentEncoding(up.headers));
}

function pump() {
  while (active < FETCH_CONCURRENCY && queue.length) {
    const wait = queue[0].due - Date.now();
    if (wait > 0) {
      if (!timer) {
        timer = setTimeout(() => { timer = null; pump(); }, wait);
        timer.unref();
      }
      return;
    }
    const job = queue.shift();
    queued.delete(`${job.p.id} ${job.asset.key}`);
    active++;
    ensure(job.p, job.asset, () => download(job.href)).finally(() => {
      active--;
      pump();
    });
  }
}

const hasFile = asset => Boolean(asset.file) && fs.existsSync(absolute(asset.file));

function saveLater(p, asset, href) {
  if (!SAVE_ASSETS || !p || !asset || hasFile(asset)) return;
  const tag = `${p.id} ${asset.key}`;
  if (queued.has(tag)) return;
  queued.add(tag);
  queue.push({ p, asset, href, due: Date.now() + FETCH_DELAY_MS });
  pump();
}

function known(asset) {
  if (asset.file && !byKey.has(asset.key)) byKey.set(asset.key, absolute(asset.file));
}

const folderOf = p => (p.dir ? path.join(FILES_DIR, p.dir) : null);

function init(next) {
  hooks = next;
}

module.exports = { SAVE_ASSETS, FILES_DIR, init, known, hasFile, saveResponse, saveLater, relocate, repair, removeFile, folderOf, absolute };
