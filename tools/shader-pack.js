'use strict';

const crypto = require('crypto');

const GROUP_AT = 0x14;
const NAMES_AT = GROUP_AT + 64;
const NAME_SIZE = 64;
const SHADER_ENTRY = 68;
const FLAG_ENTRY = 64;
const CAP_ENTRY = 65;
const VARIANT_ENTRY = 64;

const TYPE = { vertex: 0x76, fragment: 0x70, compute: 0x63 };

function cstring(buf, at, size) {
  const slice = buf.subarray(at, at + size);
  const end = slice.indexOf(0);
  return slice.toString('latin1', 0, end < 0 ? size : end);
}

function fixedString(text, size) {
  if (Buffer.byteLength(text, 'latin1') >= size) throw new Error(`name too long for the shader pack: ${text}`);
  const out = Buffer.alloc(size);
  out.write(text, 'latin1');
  return out;
}

function readPack(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RBXS') throw new Error('not an RBXS shader pack');
  const pack = {
    version: buf.readUInt16LE(4),
    reserved: buf.readUInt16LE(6),
    tag: buf.readUInt32LE(16),
    group: Buffer.from(buf.subarray(GROUP_AT, NAMES_AT)),
    shaders: [],
    flags: [],
    caps: [],
    variants: [],
  };
  if (pack.version !== 11) throw new Error(`unsupported shader pack version ${pack.version}`);
  const flagCount = buf.readUInt16LE(8);
  const capCount = buf.readUInt16LE(10);
  const shaderCount = buf.readUInt16LE(12);
  const variantCount = buf.readUInt16LE(14);
  let at = NAMES_AT;
  for (let i = 0; i < shaderCount; i++, at += SHADER_ENTRY) {
    pack.shaders.push({ name: cstring(buf, at, NAME_SIZE), extra: Buffer.from(buf.subarray(at + NAME_SIZE, at + SHADER_ENTRY)) });
  }
  for (let i = 0; i < flagCount; i++, at += FLAG_ENTRY) pack.flags.push(cstring(buf, at, FLAG_ENTRY));
  for (let i = 0; i < capCount; i++, at += CAP_ENTRY) pack.caps.push({ name: cstring(buf, at, NAME_SIZE), value: buf[at + NAME_SIZE] });
  for (let i = 0; i < variantCount; i++, at += VARIANT_ENTRY) {
    const offset = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 20);
    if (offset + size > buf.length) throw new Error('shader pack variant points outside the file');
    pack.variants.push({
      hash: Buffer.from(buf.subarray(at, at + 16)),
      key: buf.readUInt32LE(at + 24),
      type: buf.readUInt16LE(at + 28),
      shader: buf.readUInt16LE(at + 30),
      flagMask: buf.readBigUInt64LE(at + 32),
      flagValue: buf.readBigUInt64LE(at + 40),
      capMask: buf.readBigUInt64LE(at + 48),
      capValue: buf.readBigUInt64LE(at + 56),
      source: Buffer.from(buf.subarray(offset, offset + size)),
    });
  }
  return pack;
}

function writePack(pack) {
  if (pack.shaders.length > 0xffff || pack.variants.length > 0xffff) throw new Error('too many shaders for the pack format');
  const tablesSize = NAMES_AT + pack.shaders.length * SHADER_ENTRY + pack.flags.length * FLAG_ENTRY + pack.caps.length * CAP_ENTRY + pack.variants.length * VARIANT_ENTRY;
  const offsets = new Map();
  const blobs = [];
  let dataSize = 0;
  const placed = pack.variants.map(v => {
    const id = crypto.createHash('sha1').update(v.source).digest('hex');
    if (!offsets.has(id)) {
      offsets.set(id, tablesSize + dataSize);
      blobs.push(v.source);
      dataSize += v.source.length;
    }
    return offsets.get(id);
  });
  const out = Buffer.alloc(tablesSize + dataSize);
  out.write('RBXS', 0, 'latin1');
  out.writeUInt16LE(pack.version, 4);
  out.writeUInt16LE(pack.reserved, 6);
  out.writeUInt16LE(pack.flags.length, 8);
  out.writeUInt16LE(pack.caps.length, 10);
  out.writeUInt16LE(pack.shaders.length, 12);
  out.writeUInt16LE(pack.variants.length, 14);
  out.writeUInt32LE(pack.tag, 16);
  pack.group.copy(out, GROUP_AT);
  let at = NAMES_AT;
  for (const s of pack.shaders) {
    fixedString(s.name, NAME_SIZE).copy(out, at);
    s.extra.copy(out, at + NAME_SIZE);
    at += SHADER_ENTRY;
  }
  for (const f of pack.flags) {
    fixedString(f, FLAG_ENTRY).copy(out, at);
    at += FLAG_ENTRY;
  }
  for (const c of pack.caps) {
    fixedString(c.name, NAME_SIZE).copy(out, at);
    out[at + NAME_SIZE] = c.value;
    at += CAP_ENTRY;
  }
  pack.variants.forEach((v, i) => {
    v.hash.copy(out, at);
    out.writeUInt32LE(placed[i], at + 16);
    out.writeUInt32LE(v.source.length, at + 20);
    out.writeUInt32LE(v.key, at + 24);
    out.writeUInt16LE(v.type, at + 28);
    out.writeUInt16LE(v.shader, at + 30);
    out.writeBigUInt64LE(v.flagMask, at + 32);
    out.writeBigUInt64LE(v.flagValue, at + 40);
    out.writeBigUInt64LE(v.capMask, at + 48);
    out.writeBigUInt64LE(v.capValue, at + 56);
    at += VARIANT_ENTRY;
  });
  let dataAt = tablesSize;
  for (const blob of blobs) {
    blob.copy(out, dataAt);
    dataAt += blob.length;
  }
  return out;
}

function bitNames(mask, names) {
  const out = [];
  for (let i = 0; i < names.length; i++) if (mask >> BigInt(i) & 1n) out.push(names[i]);
  if (mask >> BigInt(names.length)) throw new Error('mask refers to an entry the pack does not list');
  return out;
}

function namesToMask(list, names) {
  let mask = 0n;
  for (const n of list) {
    const i = names.indexOf(n);
    if (i < 0) throw new Error(`unknown pack entry ${n}`);
    mask |= 1n << BigInt(i);
  }
  return mask;
}

function gate(pack, v) {
  const flags = pack.flags;
  const caps = pack.caps.map(c => c.name);
  return {
    flagMask: bitNames(v.flagMask, flags).sort(),
    flagValue: bitNames(v.flagValue, flags).sort(),
    capMask: bitNames(v.capMask, caps).sort(),
    capValue: bitNames(v.capValue, caps).sort(),
  };
}

function variantId(pack, v) {
  const g = gate(pack, v);
  return [pack.shaders[v.shader].name, v.type, v.key, g.flagMask.join(','), g.flagValue.join(','), g.capMask.join(','), g.capValue.join(',')].join('|');
}

module.exports = { readPack, writePack, gate, variantId, namesToMask, TYPE };
