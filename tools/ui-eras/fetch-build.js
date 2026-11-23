#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { readZipEntry, zipEntries } = require('../zip');
const { blake2b } = require('../blake2b');
const { encodeForRoblox, COMPILE_FLAGS, withEngineTrailer } = require('../luau-bytecode');
const { ENGINE_DIR } = require('../../server/config');

const BUILDS = require('./builds.json');
const ASSET_PACKAGES = [
  { name: 'extracontent-luapackages', root: 'ExtraContent/LuaPackages', keep: /\.png$/i },
  { name: 'extracontent-textures', root: 'ExtraContent/textures', keep: /\.png$/i },
  { name: 'content-textures2', root: 'content/textures', keep: /^ui\/.*\.png$/i },
];
const ROBLOX_PREFIX = '527a104a5b3209e0';
const OPCODE_INVERSE = 203;
const AUX = new Set([7, 8, 12, 15, 16, 20, 27, 28, 29, 30, 31, 32, 53, 55, 58, 60, 66, 74, 75, 77, 78, 79, 80]);
const OP_LOADK = 5;
const OP_LOADKX = 66;
const OP_NAMECALL = 20;
const FLAG_GETTERS = {
  GetFastFlag: 'flag',
  GetFFlag: 'flag',
  GetFastInt: 'int',
  GetFInt: 'int',
  GetFastString: 'string',
  GetFVariable: 'string',
};
const SETTINGS_GETTERS = new Set(['GetFFlag', 'GetFVariable']);
const WASM = path.join(ENGINE_DIR, 'WebClient.wasm');
const DEFINERS = new Set(['DefineFastFlag', 'DefineFastInt', 'DefineFastString']);
const REMOVED_API_MODULES = {
  VideoRecordConnector: 'return function() return nil end',
  RecordingPill: 'return function() return nil end',
};
const ENTRY_SCRIPTS =['StarterScript', 'LoadingScript', 'Connection'];
const SLOT_PATTERN = /^ServerCoreScripts\//;
const HASH_SIZE = 16;
const COMPRESSION_LEVEL = 9;

function lz4(src, size) {
  const out = Buffer.alloc(size);
  let s = 0;
  let d = 0;
  while (s < src.length) {
    const token = src[s++];
    let literal = token >> 4;
    if (literal === 15) {
      let b;
      do { b = src[s++]; literal += b; } while (b === 255);
    }
    src.copy(out, d, s, s + literal);
    s += literal;
    d += literal;
    if (s >= src.length) break;
    const offset = src.readUInt16LE(s);
    s += 2;
    let length = token & 15;
    if (length === 15) {
      let b;
      do { b = src[s++]; length += b; } while (b === 255);
    }
    length += 4;
    for (let i = 0; i < length; i++) {
      out[d] = out[d - offset];
      d++;
    }
  }
  return out;
}

function readChunks(data) {
  if (data.toString('latin1', 0, 8) !== '<roblox!') throw new Error('not a binary Roblox model');
  const chunks = [];
  let i = 32;
  while (i < data.length) {
    const name = data.toString('latin1', i, i + 4);
    const compressed = data.readUInt32LE(i + 4);
    const uncompressed = data.readUInt32LE(i + 8);
    const reserved = data.readUInt32LE(i + 12);
    const raw = data.subarray(i, i + 16 + (compressed || uncompressed));
    const payload = raw.subarray(16);
    let body = payload;
    if (compressed) body = payload[0] === 0x28 && payload[1] === 0xb5 ? zlib.zstdDecompressSync(payload) : lz4(payload, uncompressed);
    chunks.push({ name, reserved, raw, body, changed: false, compressed: compressed !== 0 });
    i += 16 + (compressed || uncompressed);
    if (name === 'END\0') break;
  }
  return chunks;
}

function encodeChunk(chunk) {
  if (!chunk.changed) return chunk.raw;
  const header = Buffer.alloc(16);
  header.write(chunk.name, 0, 'latin1');
  header.writeUInt32LE(chunk.reserved, 12);
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

function moduleTable(chunks) {
  let classId = null;
  let count = 0;
  for (const chunk of chunks.filter(c => c.name === 'INST')) {
    const nameLength = chunk.body.readUInt32LE(4);
    if (chunk.body.toString('latin1', 8, 8 + nameLength) === 'ModuleScript') {
      classId = chunk.body.readUInt32LE(0);
      count = chunk.body.readUInt32LE(9 + nameLength);
    }
  }
  const property = wanted => chunks.find(chunk => {
    if (chunk.name !== 'PROP') return false;
    const nameLength = chunk.body.readUInt32LE(4);
    return chunk.body.readUInt32LE(0) === classId && chunk.body.toString('latin1', 8, 8 + nameLength) === wanted;
  });
  const sourceChunk = property('Source');
  const nameChunk = property('Name');
  const prefixLength = 9 + sourceChunk.body.readUInt32LE(4);
  const { list, tail } = splitStrings(sourceChunk.body.subarray(prefixLength), count);
  const names = splitStrings(nameChunk.body.subarray(9 + nameChunk.body.readUInt32LE(4)), count).list.map(String);
  return { count, sourceChunk, prefixLength, list, tail, names };
}

function refs(body, at, count) {
  const values = [];
  let total = 0;
  for (let k = 0; k < count; k++) {
    const raw = ((body[at + k] * 2 ** 24) + (body[at + count + k] << 16) + (body[at + 2 * count + k] << 8) + body[at + 3 * count + k]) >>> 0;
    total += (raw >>> 1) ^ -(raw & 1);
    values.push(total);
  }
  return values;
}

function coreScriptIndexes(chunks) {
  const classes = new Map();
  const moduleIndex = new Map();
  const names = new Map();
  for (const chunk of chunks.filter(c => c.name === 'INST')) {
    const nameLength = chunk.body.readUInt32LE(4);
    const className = chunk.body.toString('latin1', 8, 8 + nameLength);
    const count = chunk.body.readUInt32LE(9 + nameLength);
    const ids = refs(chunk.body, 13 + nameLength, count);
    classes.set(chunk.body.readUInt32LE(0), ids);
    if (className === 'ModuleScript') ids.forEach((id, index) => moduleIndex.set(id, index));
  }
  for (const chunk of chunks.filter(c => c.name === 'PROP')) {
    const nameLength = chunk.body.readUInt32LE(4);
    if (chunk.body.toString('latin1', 8, 8 + nameLength) !== 'Name') continue;
    const ids = classes.get(chunk.body.readUInt32LE(0));
    splitStrings(chunk.body.subarray(9 + nameLength), ids.length).list.forEach((name, index) => names.set(ids[index], String(name)));
  }
  const parentChunk = chunks.find(c => c.name === 'PRNT');
  const count = parentChunk.body.readUInt32LE(1);
  const children = refs(parentChunk.body, 5, count);
  const parents = refs(parentChunk.body, 5 + 4 * count, count);
  const parentOf = new Map(children.map((child, index) => [child, parents[index]]));
  const found = new Map();
  for (const [id, index] of moduleIndex) {
    const parent = parentOf.get(id);
    if (names.get(parent) === 'CoreScripts' && names.get(parentOf.get(parent)) === 'PatchRoot') found.set(names.get(id), index);
  }
  return found;
}

function flagsIn(source, found, settingsNames) {
  let buf = source;
  if (buf.length < 9 || buf.toString('hex', 0, 8) !== ROBLOX_PREFIX) return false;
  buf = buf.subarray(8);
  let o = 0;
  const u8 = () => buf[o++];
  const varint = () => {
    let r = 0;
    let s = 0;
    for (;;) {
      const b = buf[o++];
      r += (b & 0x7f) * 2 ** s;
      s += 7;
      if (b < 0x80) return r;
    }
  };
  const version = u8();
  const typesVersion = version >= 4 ? u8() : 0;
  const strings = [null];
  const stringCount = varint();
  for (let k = 0; k < stringCount; k++) {
    const length = varint();
    strings.push(buf.toString('latin1', o, o + length));
    o += length;
  }
  if (typesVersion === 3) for (let idx = u8(); idx !== 0; idx = u8()) varint();
  const protoCount = varint();
  for (let p = 0; p < protoCount; p++) {
    o += 4;
    if (version >= 4) {
      o++;
      const typeSize = varint();
      o += typeSize;
    }
    const count = varint();
    const code = o;
    o += 4 * count;
    const constants = [];
    const sizek = varint();
    for (let k = 0; k < sizek; k++) {
      const t = u8();
      if (t === 0) constants.push(null);
      else if (t === 1) { o++; constants.push(null); }
      else if (t === 2) { o += 8; constants.push(null); }
      else if (t === 3) constants.push(strings[varint()]);
      else if (t === 4) { o += 4; constants.push(null); }
      else if (t === 5) { const c = varint(); for (let q = 0; q < c; q++) varint(); constants.push(null); }
      else if (t === 6) { varint(); constants.push(null); }
      else if (t === 7) { o += 16; constants.push(null); }
      else if (t === 8) { const c = varint(); for (let q = 0; q < c; q++) { varint(); o += 4; } constants.push(null); }
      else if (t === 9) { o++; while (buf[o++] >= 0x80); constants.push(null); }
      else throw new Error(`unknown constant type ${t}`);
    }
    const childCount = varint();
    for (let k = 0; k < childCount; k++) varint();
    varint();
    varint();
    if (u8()) {
      const gap = u8();
      o += count + 4 * (((count - 1) >> gap) + 1);
    }
    if (u8()) {
      const locals = varint();
      for (let k = 0; k < locals; k++) { varint(); varint(); varint(); o++; }
      const ups = varint();
      for (let k = 0; k < ups; k++) varint();
    }
    if (constants.some(value => DEFINERS.has(value))) {
      for (const value of constants) if (typeof value === 'string') found.defined.add(value);
    }
    const op = at => (buf[code + at * 4] * OPCODE_INVERSE) & 255;
    for (let pc = 0; pc < count; pc++) {
      const opcode = op(pc);
      if (opcode === OP_NAMECALL) {
        const key = constants[buf.readUInt32LE(code + (pc + 1) * 4)];
        const kind = typeof key === 'string' && Object.hasOwn(FLAG_GETTERS, key) ? FLAG_GETTERS[key] : null;
        if (kind && pc > 0) {
          let index = null;
          if (op(pc - 1) === OP_LOADK) index = buf.readInt16LE(code + (pc - 1) * 4 + 2);
          else if (pc > 1 && op(pc - 2) === OP_LOADKX) index = buf.readUInt32LE(code + (pc - 1) * 4);
          const name = index === null ? null : constants[index];
          if (typeof name === 'string') {
            found[kind].add(name);
            if (SETTINGS_GETTERS.has(key)) settingsNames.add(name);
          }
        }
      }
      if (AUX.has(opcode)) pc++;
    }
  }
  return true;
}

function renameMethods(source) {
  const buf = source.subarray(8);
  let o = 0;
  const varint = () => {
    let r = 0;
    let shift = 0;
    for (;;) {
      const b = buf[o++];
      r += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (b < 0x80) return r;
    }
  };
  const encode = value => {
    const out = [];
    let rest = value;
    do {
      let b = rest & 0x7f;
      rest = Math.floor(rest / 128);
      if (rest) b |= 0x80;
      out.push(b);
    } while (rest);
    return Buffer.from(out);
  };
  const version = buf[o++];
  if (version >= 4) o++;
  const head = buf.subarray(0, o);
  const count = varint();
  const parts = [source.subarray(0, 8), head, encode(count)];
  for (let k = 0; k < count; k++) {
    const length = varint();
    const text = buf.toString('latin1', o, o + length);
    o += length;
    const next = Buffer.from(SETTINGS_GETTERS.has(text) ? 'GetAttribute' : text, 'latin1');
    parts.push(encode(next.length), next);
  }
  parts.push(buf.subarray(o));
  return Buffer.concat(parts);
}

function luaString(text) {
  return JSON.stringify(text);
}

function joinStrings(prefix, list, tail) {
  const parts = [prefix];
  for (const item of list) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(item.length);
    parts.push(length, item);
  }
  parts.push(tail);
  return Buffer.concat(parts);
}

function hashChunk(sources) {
  const body = Buffer.alloc(6 + HASH_SIZE * sources.length + 1);
  body.writeUInt32LE(sources.length, 0);
  body.writeUInt16LE(HASH_SIZE, 4);
  sources.forEach((source, index) => blake2b(source, HASH_SIZE).copy(body, 6 + HASH_SIZE * index));
  return { name: 'HASH', reserved: 0, body, changed: true, compressed: true };
}

function prelude(flags, slot) {
  const list = kind => [...flags[kind]].filter(name => !flags.defined.has(name)).sort().map(luaString).join(',');
  return `local FLAGS = {${list('flag')}}
local INTS = {${list('int')}}
local STRINGS = {${list('string')}}
local config = settings()
local function define(names, owner, getter, setter, fallback)
	for _, name in ipairs(names) do
		if not pcall(owner[getter], owner, name) then
			pcall(game[setter], game, name, fallback)
		end
	end
end
define(FLAGS, config, "GetFFlag", "DefineFastFlag", false)
define(INTS, game, "GetFastInt", "DefineFastInt", 0)
define(STRINGS, config, "GetFVariable", "DefineFastString", "")
local CoreGui = game:GetService("CoreGui")
local parent = script and script.Parent or CoreGui:FindFirstChild("RobloxGui") or CoreGui
game:GetService("ScriptContext"):AddCoreScriptLocal(${luaString(slot)}, parent)
`;
}

function compile(source) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-era-'));
  const file = path.join(scratch, 'prelude.luau');
  fs.writeFileSync(file, source);
  try {
    return encodeForRoblox(execFileSync('luau-compile', ['--binary', '-O1', '-g1', `--fflags=${COMPILE_FLAGS.join(',')}`, file], { maxBuffer: 2 ** 28 }));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function patchModel(data, replace = {}) {
  const chunks = readChunks(data);
  const table = moduleTable(chunks);
  const found = { flag: new Set(), int: new Set(), string: new Set(), defined: new Set() };
  let readable = 0;
  const wasm = fs.readFileSync(WASM);
  const known = new Map();
  const isMissing = name => {
    if (!known.has(name)) known.set(name, !wasm.includes(name, 0, 'latin1'));
    return known.get(name);
  };
  const renamed = [];
  table.list.forEach((source, index) => {
    const settingsNames = new Set();
    if (flagsIn(source, found, settingsNames)) readable++;
    if ([...settingsNames].some(isMissing)) renamed.push(index);
  });
  const slots = table.names.map((name, index) => ({ name, index })).filter(item => SLOT_PATTERN.test(item.name));
  const coreScripts = coreScriptIndexes(chunks);
  const entries = ENTRY_SCRIPTS.map(name => coreScripts.get(name)).filter(index => index !== undefined);
  if (entries.length !== ENTRY_SCRIPTS.length) throw new Error('entry scripts not found under CoreScripts');
  if (slots.length < entries.length) throw new Error('not enough unused server script slots');
  const sources = table.list.map(source => (source.toString('hex', 0, 8) === ROBLOX_PREFIX ? withEngineTrailer(source) : source));
  for (const index of renamed) sources[index] = renameMethods(sources[index]);
  for (const [name, source] of Object.entries({ ...REMOVED_API_MODULES, ...replace })) {
    const compiled = compile(source);
    table.names.forEach((candidate, index) => {
      if (candidate === name) sources[index] = compiled;
    });
  }
  entries.forEach((index, k) => {
    const slot = slots[k];
    sources[slot.index] = sources[index];
    sources[index] = compile(prelude(found, slot.name));
  });
  table.sourceChunk.body = joinStrings(table.sourceChunk.body.subarray(0, table.prefixLength), sources, table.tail);
  table.sourceChunk.changed = true;
  const existing = chunks.findIndex(c => c.name === 'HASH');
  if (existing >= 0) chunks[existing] = hashChunk(sources);
  else chunks.splice(chunks.findLastIndex(c => c.name === 'INST') + 1, 0, hashChunk(sources));
  console.log(`  ${table.count} scripts, ${readable} readable, ${found.flag.size} flags, ${found.int.size} ints, ${found.string.size} strings, ${renamed.length} modules using removed flags`);
  return Buffer.concat([data.subarray(0, 32), ...chunks.map(encodeChunk)]);
}

async function download(version, name) {
  const url = `https://setup.rbxcdn.com/${version}-${name}.zip`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function modelFrom(zip) {
  const names = ['InExperience/InExperience.rbxm', 'DataModelPatch/DataModelPatch.rbxm'];
  for (const name of names) {
    try {
      return readZipEntry(zip, name);
    } catch {}
  }
  throw new Error('no in-game UI model in this package');
}

async function fetchAssets(era, version) {
  const target = path.join(__dirname, era, 'overlay');
  fs.rmSync(target, { recursive: true, force: true });
  let kept = 0;
  let bytes = 0;
  for (const { name, root, keep } of ASSET_PACKAGES) {
    const zip = await download(version, name);
    for (const entry of zipEntries(zip)) {
      if (!keep.test(entry.name)) continue;
      const data = entry.read();
      const relative = `${root}/${entry.name}`;
      const current = path.join(ENGINE_DIR, relative);
      if (fs.existsSync(current) && fs.readFileSync(current).equals(data)) continue;
      const output = path.join(target, relative);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, data);
      kept++;
      bytes += data.length;
    }
  }
  console.log(`  ${kept} era images, ${(bytes / 1048576).toFixed(1)}MB`);
}

async function main() {
  const eras = process.argv.slice(2);
  for (const era of eras.length ? eras : Object.keys(BUILDS).filter(id => BUILDS[id].version)) {
    const { version, replace } = BUILDS[era];
    const model = modelFrom(await download(version, 'extracontent-models'));
    console.log(`${era}: ${version}, ${(model.length / 1048576).toFixed(1)}MB`);
    fs.mkdirSync(path.join(__dirname, era), { recursive: true });
    fs.writeFileSync(path.join(__dirname, era, 'InExperience.rbxm'), patchModel(model, replace));
    await fetchAssets(era, version);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
