const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { BASE, ENGINE_DIR, ENGINE_URL } = require('./config');
const { blake2b } = require('../tools/blake2b');

const COOKIE = /(?:^|;\s*)webblox_ui_era=([a-z0-9-]+)/;
const ERA_DIR = path.join(BASE, 'tools', 'ui-eras');
const CACHE_DIR = path.join(BASE, '.cache', 'ui-eras');
const MODEL = path.join(ENGINE_DIR, 'ExtraContent', 'models', 'InExperience', 'InExperience.rbxm');
const WEB_FLAGS = path.join(ENGINE_DIR, 'WebFlags.json');
const BUILDS = path.join(ERA_DIR, 'builds.json');
const ENTRY = 'StarterScript';
const COMPRESSION_LEVEL = 9;
const HASH_SIZE = 16;
const ASSET_HOST = 'assetdelivery.roblox.com';
const ASSET_ROUTE = /^\/webblox\/era-asset\/([a-z0-9-]+)\/(\d+)$/;
const ASSET_TYPES = [
  { magic: 'version', type: 4, mime: 'application/octet-stream' },
  { magic: '<roblox', type: 10, mime: 'application/octet-stream' },
  { magic: 'OggS', type: 3, mime: 'audio/ogg' },
  { magic: 'ID3', type: 3, mime: 'audio/mpeg' },
  { magic: '\x89PNG', type: 1, mime: 'image/png' },
];
const IMAGE_ASSET = { type: 1, mime: 'application/octet-stream' };

function readChunks(data) {
  const chunks = [];
  let i = 32;
  while (i < data.length) {
    const name = data.toString('latin1', i, i + 4);
    const compressed = data.readUInt32LE(i + 4);
    const uncompressed = data.readUInt32LE(i + 8);
    const reserved = data.readUInt32LE(i + 12);
    const raw = data.subarray(i, i + 16 + (compressed || uncompressed));
    chunks.push({ name, compressed: compressed !== 0, reserved, raw, payload: raw.subarray(16), body: null });
    i += 16 + (compressed || uncompressed);
    if (name === 'END\0') break;
  }
  return chunks;
}

function chunkBody(chunk) {
  chunk.decoded ??= chunk.compressed ? zlib.zstdDecompressSync(chunk.payload) : chunk.payload;
  return chunk.decoded;
}

function encodeChunk(chunk) {
  if (!chunk.body) return chunk.raw;
  const header = Buffer.alloc(16);
  header.write(chunk.name, 0, 'latin1');
  header.writeUInt32LE(chunk.reserved, 12);
  if (!chunk.compressed) {
    header.writeUInt32LE(chunk.body.length, 8);
    return Buffer.concat([header, chunk.body]);
  }
  const packed = zlib.zstdCompressSync(chunk.body, { params: { [zlib.constants.ZSTD_c_compressionLevel]: COMPRESSION_LEVEL } });
  header.writeUInt32LE(packed.length, 4);
  header.writeUInt32LE(chunk.body.length, 8);
  return Buffer.concat([header, packed]);
}

function splitStrings(blob, count) {
  const list = [];
  let at = 0;
  for (let k = 0; k < count; k++) {
    const length = blob.readUInt32LE(at);
    list.push(blob.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return { list, tail: blob.subarray(at) };
}

function moduleProperty(chunks, classId, property) {
  return chunks.find(chunk => {
    if (chunk.name !== 'PROP') return false;
    const body = chunkBody(chunk);
    const nameLength = body.readUInt32LE(4);
    return body.readUInt32LE(0) === classId && body.toString('latin1', 8, 8 + nameLength) === property;
  });
}

function buildVariant(bytecode) {
  const data = fs.readFileSync(MODEL);
  const chunks = readChunks(data);
  let classId = null;
  let count = 0;
  for (const chunk of chunks.filter(c => c.name === 'INST')) {
    const body = chunkBody(chunk);
    const nameLength = body.readUInt32LE(4);
    if (body.toString('latin1', 8, 8 + nameLength) === 'ModuleScript') {
      classId = body.readUInt32LE(0);
      count = body.readUInt32LE(9 + nameLength);
    }
  }
  const sourceChunk = moduleProperty(chunks, classId, 'Source');
  const nameChunk = moduleProperty(chunks, classId, 'Name');
  const nameBody = chunkBody(nameChunk);
  const names = splitStrings(nameBody.subarray(9 + nameBody.readUInt32LE(4)), count).list.map(String);
  const index = names.indexOf(ENTRY);
  if (index < 0) throw new Error(`${ENTRY} not found in InExperience.rbxm`);
  const body = chunkBody(sourceChunk);
  const prefixLength = 9 + body.readUInt32LE(4);
  const { list, tail } = splitStrings(body.subarray(prefixLength), count);
  const parts = [body.subarray(0, prefixLength)];
  list.forEach((source, k) => {
    const next = k === index ? bytecode : source;
    const length = Buffer.alloc(4);
    length.writeUInt32LE(next.length);
    parts.push(length, next);
  });
  parts.push(tail);
  sourceChunk.body = Buffer.concat(parts);
  const hashChunk = chunks.find(c => c.name === 'HASH');
  if (hashChunk) {
    const hashes = Buffer.from(chunkBody(hashChunk));
    blake2b(bytecode, HASH_SIZE).copy(hashes, 6 + HASH_SIZE * index);
    hashChunk.body = hashes;
  }
  return Buffer.concat([data.subarray(0, 32), ...chunks.map(encodeChunk)]);
}

function readBuilds() {
  return JSON.parse(fs.readFileSync(BUILDS, 'utf8'));
}

function variantFile(era) {
  const full = path.join(ERA_DIR, era, 'InExperience.rbxm');
  if (fs.existsSync(full)) return full;
  const bytecode = path.join(ERA_DIR, era, 'StarterScript.bytecode');
  const output = path.join(CACHE_DIR, `${era}-InExperience.rbxm`);
  const built = fs.statSync(bytecode, { throwIfNoEntry: false });
  if (!built) return null;
  const current = fs.statSync(output, { throwIfNoEntry: false });
  const model = fs.statSync(MODEL);
  if (current && current.mtimeMs >= built.mtimeMs && current.mtimeMs >= model.mtimeMs) return output;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const temporary = `${output}.tmp`;
  fs.writeFileSync(temporary, buildVariant(fs.readFileSync(bytecode)));
  fs.renameSync(temporary, output);
  console.log(`[ui-era] built ${era} model`);
  return output;
}

function flagsFile(era) {
  const flags = readBuilds()[era]?.flags;
  if (!flags || !Object.keys(flags).length) return null;
  const base = JSON.parse(fs.readFileSync(WEB_FLAGS, 'utf8'));
  base.applicationSettings = { ...base.applicationSettings, ...flags };
  const output = path.join(CACHE_DIR, `${era}-WebFlags.json`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(output, JSON.stringify(base));
  return output;
}

const overlays = new Map();

function overlayRoot(era) {
  return path.join(ERA_DIR, era, 'overlay');
}

function eraOverlay(era) {
  if (overlays.has(era)) return overlays.get(era);
  const found = new Map();
  const root = overlayRoot(era);
  const scan = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else found.set(path.relative(root, full).split(path.sep).join('/').toLowerCase(), full);
    }
  };
  if (fs.existsSync(root)) scan(root);
  overlays.set(era, found);
  return found;
}

function eraAssetAtUrl(req, urlPath) {
  const era = requestEra(req);
  if (!era) return null;
  if (!urlPath.startsWith(ENGINE_URL)) return null;
  return eraOverlay(era).get(urlPath.slice(ENGINE_URL.length).toLowerCase()) || null;
}

function requestEra(req) {
  return (req.headers.cookie || '').match(COOKIE)?.[1] || null;
}

function eraFile(req, filePath) {
  const era = requestEra(req);
  if (!era) return filePath;
  const name = path.basename(filePath);
  if (name !== 'InExperience.rbxm' && name !== 'WebFlags.json') {
    const relative = path.relative(ENGINE_DIR, filePath).split(path.sep).join('/').toLowerCase();
    return eraOverlay(era).get(relative) || filePath;
  }
  try {
    return (name === 'WebFlags.json' ? flagsFile(era) : variantFile(era)) || filePath;
  } catch (err) {
    console.warn(`[ui-era] ${era} failed: ${err.message}`);
    return filePath;
  }
}

function eraAssetPath(era, id) {
  const file = path.join(ERA_DIR, era, 'images', String(id));
  return fs.existsSync(file) ? file : null;
}

function assetKind(data) {
  const head = data.toString('latin1', 0, 8);
  return ASSET_TYPES.find(kind => head.startsWith(kind.magic)) || IMAGE_ASSET;
}

function splitEraBatch(req, url, body) {
  const era = requestEra(req);
  if (!era || url.hostname !== ASSET_HOST || !body) return null;
  let asked;
  try {
    asked = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(asked)) return null;
  const local = [];
  const rest = [];
  for (const item of asked) {
    const file = item && item.assetId ? eraAssetPath(era, item.assetId) : null;
    if (!file) {
      rest.push(item);
      continue;
    }
    const head = Buffer.alloc(8);
    const handle = fs.openSync(file, 'r');
    fs.readSync(handle, head, 0, 8, 0);
    fs.closeSync(handle);
    local.push({
      location: `https://${ASSET_HOST}/webblox/era-asset/${era}/${item.assetId}`,
      requestId: item.requestId,
      isArchived: false,
      assetTypeId: assetKind(head).type,
      isRecordable: true,
    });
  }
  return local.length ? { local, rest } : null;
}

function eraAssetRequest(req, url) {
  if (url.hostname !== ASSET_HOST) return null;
  const route = url.pathname.match(ASSET_ROUTE);
  if (route) return eraAssetPath(route[1], route[2]);
  const era = requestEra(req);
  const id = url.searchParams.get('id');
  return era && id && /^\/v1\/asset\/?$/.test(url.pathname) && /^\d+$/.test(id) ? eraAssetPath(era, id) : null;
}

function readEraAsset(file) {
  const body = fs.readFileSync(file);
  return { body, mime: assetKind(body).mime };
}

const eraTables = new Map();

function eraList() {
  return Object.entries(readBuilds())
    .map(([id, { label }]) => ({ id, label }))
    .sort((left, right) => right.id.localeCompare(left.id));
}

function eraMetadata(req, metadata) {
  const model = eraFile(req, MODEL);
  const flags = eraFile(req, WEB_FLAGS);
  const era = requestEra(req);
  const overlay = era ? eraOverlay(era) : new Map();
  if (model === MODEL && flags === WEB_FLAGS && !overlay.size) return metadata;
  const modelSize = fs.statSync(model).size;
  const flagsSize = fs.statSync(flags).size;
  const key = `${modelSize}:${flagsSize}:${overlay.size}:${metadata.tag}`;
  const cached = eraTables.get(era);
  if (cached?.key === key) return cached.table;
  const list = JSON.parse(metadata.body);
  const entry = list.find(item => /\/ExtraContent\/models\/InExperience\/InExperience\.rbxm$/i.test(item.path || ''));
  if (entry) entry.size = modelSize;
  const flagsEntry = list.find(item => /\/WebFlags\.json$/i.test(item.path || ''));
  if (flagsEntry) flagsEntry.size = flagsSize;
  const known = new Map(list.map(item => [String(item.path || '').replace(/^\//, '').toLowerCase(), item]));
  for (const [relative, full] of overlay) {
    const size = fs.statSync(full).size;
    const item = known.get(relative);
    if (item) item.size = size;
    else list.push({ path: `/${path.relative(overlayRoot(era), full).split(path.sep).join('/')}`, size });
  }
  const body = Buffer.from(JSON.stringify(list));
  const table = {
    body,
    gzip: zlib.gzipSync(body, { level: 6 }),
    tag: `${metadata.tag}-${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 10)}`,
  };
  eraTables.set(era, { key, table });
  return table;
}

module.exports = { eraFile, eraMetadata, eraAssetAtUrl, requestEra, eraList, splitEraBatch, eraAssetRequest, readEraAsset };
