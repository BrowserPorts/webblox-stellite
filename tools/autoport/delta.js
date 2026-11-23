'use strict';

const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const BLOCK = 64;
const TABLE_BITS = 24;
const MULTIPLIER = 0x01000193;
const HEADER_BYTES = 4;

function sha(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function blockPower() {
  let power = 1;
  for (let i = 1; i < BLOCK; i++) power = Math.imul(power, MULTIPLIER);
  return power;
}

function hashAt(data, at) {
  let hash = 0;
  for (let i = at; i < at + BLOCK; i++) hash = (Math.imul(hash, MULTIPLIER) + data[i]) | 0;
  return hash;
}

function slot(hash) {
  return ((hash ^ (hash >>> TABLE_BITS)) >>> 0) & ((1 << TABLE_BITS) - 1);
}

function varint(value) {
  const out = [];
  let rest = value;
  while (rest >= 128) {
    out.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return Buffer.from(out);
}

function readVarint(data, at) {
  let value = 0;
  let scale = 1;
  for (;;) {
    const byte = data[at++];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return [value, at];
    scale *= 128;
  }
}

function createDelta(source, target) {
  const table = new Int32Array(1 << TABLE_BITS).fill(-1);
  for (let at = 0; at + BLOCK <= source.length; at += BLOCK) table[slot(hashAt(source, at))] = at;
  const power = blockPower();
  const parts = [varint(target.length)];
  let literal = 0;
  const flushLiteral = end => {
    if (end > literal) parts.push(varint((end - literal) * 2), target.subarray(literal, end));
  };
  let position = 0;
  let hash = target.length >= BLOCK ? hashAt(target, 0) : 0;
  while (position + BLOCK <= target.length) {
    const candidate = table[slot(hash)];
    if (candidate >= 0 && source.compare(target, position, position + BLOCK, candidate, candidate + BLOCK) === 0) {
      let from = candidate;
      let start = position;
      while (start > literal && from > 0 && target[start - 1] === source[from - 1]) {
        start--;
        from--;
      }
      let end = position + BLOCK;
      let sourceEnd = candidate + BLOCK;
      while (end < target.length && sourceEnd < source.length && target[end] === source[sourceEnd]) {
        end++;
        sourceEnd++;
      }
      flushLiteral(start);
      parts.push(varint((end - start) * 2 + 1), varint(from));
      position = end;
      literal = end;
      if (position + BLOCK <= target.length) hash = hashAt(target, position);
    } else {
      if (position + BLOCK < target.length) {
        hash = (Math.imul((hash - Math.imul(target[position], power)) | 0, MULTIPLIER) + target[position + BLOCK]) | 0;
      }
      position++;
    }
  }
  flushLiteral(target.length);
  return Buffer.concat(parts);
}

function applyDelta(source, delta) {
  let [size, at] = readVarint(delta, 0);
  const out = Buffer.alloc(size);
  let written = 0;
  while (at < delta.length) {
    let head;
    [head, at] = readVarint(delta, at);
    const length = Math.floor(head / 2);
    if (head % 2) {
      let from;
      [from, at] = readVarint(delta, at);
      source.copy(out, written, from, from + length);
    } else {
      delta.copy(out, written, at, at + length);
      at += length;
    }
    written += length;
  }
  if (written !== size) throw new Error('the pristine delta did not produce the recorded size');
  return out;
}

function writeRecovery(file, { version, source, target }) {
  const head = Buffer.from(JSON.stringify({ version, sourceSha256: sha(source), targetSha256: sha(target), size: target.length }));
  const size = Buffer.alloc(HEADER_BYTES);
  size.writeUInt32LE(head.length);
  const body = zlib.gzipSync(createDelta(source, target), { level: 9 });
  fs.writeFileSync(file, Buffer.concat([size, head, body]));
  return { bytes: size.length + head.length + body.length };
}

function readRecoveryHead(file) {
  const data = fs.readFileSync(file);
  const size = data.readUInt32LE(0);
  return { head: JSON.parse(data.toString('utf8', HEADER_BYTES, HEADER_BYTES + size)), body: data.subarray(HEADER_BYTES + size) };
}

function recover(file, source) {
  const { head, body } = readRecoveryHead(file);
  if (sha(source) !== head.sourceSha256) throw new Error(`the patched engine does not match ${file}`);
  const target = applyDelta(source, zlib.gunzipSync(body));
  if (sha(target) !== head.targetSha256) throw new Error(`the recovered engine does not match the hash in ${file}`);
  return target;
}

module.exports = { createDelta, applyDelta, writeRecovery, readRecoveryHead, recover, sha };
