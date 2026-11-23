#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { BASE, PORT } = require('../../server/config');

const ERA_DIR = __dirname;
const TOKEN_FILE = path.join(BASE, '.cache', 'proxy-token');
const ASSET_URL = /(?:rbxassetid:\/\/|roblox\.com\/asset\/?\?id=|rbxthumb:\/\/type=Asset&id=)(\d{4,})/gi;
const CONCURRENCY = 6;
const SCRIPT_FILE = /\.(lua|luau|bytecode)$/;

function lz4(source, size) {
  const out = Buffer.alloc(size);
  let s = 0;
  let d = 0;
  while (s < source.length) {
    const token = source[s++];
    let literal = token >> 4;
    if (literal === 15) {
      let more;
      do { more = source[s++]; literal += more; } while (more === 255);
    }
    source.copy(out, d, s, s + literal);
    s += literal;
    d += literal;
    if (s >= source.length) break;
    const offset = source.readUInt16LE(s);
    s += 2;
    let length = token & 15;
    if (length === 15) {
      let more;
      do { more = source[s++]; length += more; } while (more === 255);
    }
    length += 4;
    for (let i = 0; i < length; i++) {
      out[d] = out[d - offset];
      d++;
    }
  }
  return out;
}

function modelText(file) {
  const data = fs.readFileSync(file);
  const parts = [];
  let at = 32;
  while (at < data.length) {
    const name = data.toString('latin1', at, at + 4);
    const compressed = data.readUInt32LE(at + 4);
    const size = data.readUInt32LE(at + 8);
    const payload = data.subarray(at + 16, at + 16 + (compressed || size));
    if (name === 'PROP' || name === 'SSTR') {
      const zstd = payload[0] === 0x28 && payload[1] === 0xb5;
      const body = !compressed ? payload : zstd ? zlib.zstdDecompressSync(payload) : lz4(payload, size);
      parts.push(body.toString('latin1'));
    }
    at += 16 + (compressed || size);
    if (name === 'END\0') break;
  }
  return parts.join('\n');
}

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

function eraText(era) {
  const root = path.join(ERA_DIR, era);
  const model = path.join(root, 'InExperience.rbxm');
  const scripts = filesUnder(root).filter(file => SCRIPT_FILE.test(file)).map(file => fs.readFileSync(file, 'latin1'));
  return [fs.existsSync(model) ? modelText(model) : '', ...scripts].join('\n');
}

const assetIds = text => [...new Set([...text.matchAll(ASSET_URL)].map(match => match[1]))];

async function download(id, cookie) {
  const url = `http://localhost:${PORT}/__proxy__/https://assetdelivery.roblox.com/v1/asset/?id=${id}`;
  const response = await fetch(url, { headers: { Cookie: cookie, 'Accept-Encoding': 'identity' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchEra(era, cookie) {
  const ids = assetIds(eraText(era));
  const dir = path.join(ERA_DIR, era, 'images');
  fs.mkdirSync(dir, { recursive: true });
  const queue = ids.filter(id => !fs.existsSync(path.join(dir, id)));
  const failed = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        fs.writeFileSync(path.join(dir, id), await download(id, cookie));
      } catch (err) {
        failed.push(`${id} (${err.message})`);
      }
    }
  }));
  const saved = fs.readdirSync(dir);
  const bytes = saved.reduce((total, name) => total + fs.statSync(path.join(dir, name)).size, 0);
  console.log(`${era}: ${saved.length} of ${ids.length} assets, ${(bytes / 1048576).toFixed(1)}MB`);
  if (failed.length) console.log(`  not available: ${failed.join(', ')}`);
}

async function main() {
  const cookie = `webblox_token=${fs.readFileSync(TOKEN_FILE, 'utf8').trim()}`;
  const builds = JSON.parse(fs.readFileSync(path.join(ERA_DIR, 'builds.json'), 'utf8'));
  for (const era of Object.keys(builds)) await fetchEra(era, cookie);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
