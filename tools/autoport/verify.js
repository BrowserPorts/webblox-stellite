'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readModuleScripts } = require('./luau/rbxm');

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function deepDifferences(before, after, where = '', out = []) {
  if (out.length >= 200) return out;
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) out.push(`${where || 'value'} has ${after.length} entries, and it had ${before.length}`);
    const shared = Math.min(before.length, after.length);
    for (let i = 0; i < shared; i++) deepDifferences(before[i], after[i], `${where}[${i}]`, out);
    return out;
  }
  if (isObject(before) && isObject(after) && !Array.isArray(before) && !Array.isArray(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const place = where ? `${where}.${key}` : key;
      if (!(key in after)) out.push(`${place} is gone`);
      else if (!(key in before)) out.push(`${place} is new`);
      else deepDifferences(before[key], after[key], place, out);
    }
    return out;
  }
  if (before !== after) {
    const show = value => {
      const text = JSON.stringify(value);
      return text && text.length > 60 ? `${text.slice(0, 57)}...` : text;
    };
    out.push(`${where || 'value'} is ${show(after)}, and it was ${show(before)}`);
  }
  return out;
}

function listFiles(dir, prefix = '', out = new Map()) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, rel, out);
    else if (entry.isFile()) out.set(rel, full);
  }
  return out;
}

function sameFile(a, b) {
  const sizeA = fs.statSync(a).size;
  if (sizeA !== fs.statSync(b).size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

function compareTrees(expected, actual, ignore = () => false) {
  const left = listFiles(expected);
  const right = listFiles(actual);
  const differs = [];
  const missing = [];
  const extra = [];
  let compared = 0;
  for (const [rel, file] of left) {
    if (ignore(rel)) continue;
    const other = right.get(rel);
    if (!other) {
      missing.push(rel);
      continue;
    }
    compared++;
    if (!sameFile(file, other)) differs.push(rel);
  }
  for (const rel of right.keys()) if (!left.has(rel) && !ignore(rel)) extra.push(rel);
  return { compared, differs, missing, extra };
}

function scriptKeys(model) {
  const { names, sources } = readModuleScripts(model);
  return names.map((name, index) => `${name}:${crypto.createHash('sha256').update(sources[index]).digest('hex')}`).sort();
}

function modelsEquivalent(a, b) {
  const left = scriptKeys(a);
  const right = scriptKeys(b);
  if (left.length !== right.length) return { equivalent: false, detail: `${left.length} scripts against ${right.length}` };
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  const changed = left.filter(key => !rightSet.has(key)).map(key => key.split(':')[0]);
  const extra = right.filter(key => !leftSet.has(key)).map(key => key.split(':')[0]);
  const same = changed.slice().sort().join() === extra.slice().sort().join();
  const bundledOnly = same && changed.every(name => name === 'bundled');
  return { equivalent: bundledOnly, detail: changed.length ? `Only the compiled bundle (${changed.join(', ')}) differs, which means another Windows upload with the same checksum.` : 'Only the script order differs.' };
}

function wgslSlices(dir) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'wgsl-index.json'), 'utf8'));
  return { index, text: fs.readFileSync(path.join(dir, 'wgsl.txt')) };
}

function wgslEquivalent(a, b) {
  const left = wgslSlices(a);
  const right = wgslSlices(b);
  const keys = Object.keys(left.index);
  if (keys.length !== Object.keys(right.index).length) return false;
  return keys.every(key => {
    const other = right.index[key];
    if (!other) return false;
    const [at, size] = left.index[key];
    return size === other[1] && left.text.compare(right.text, other[0], other[0] + other[1], at, at + size) === 0;
  });
}

function metadataEquivalent(a, b, allowed) {
  const read = file => new Map(JSON.parse(fs.readFileSync(file, 'utf8')).map(entry => [entry.path, entry.size]));
  const left = read(a);
  const right = read(b);
  if (left.size !== right.size) return false;
  for (const [file, size] of left) {
    if (!right.has(file)) return false;
    if (right.get(file) !== size && !allowed.has(file.replace(/^\//, ''))) return false;
  }
  return true;
}

module.exports = { deepDifferences, compareTrees, listFiles, modelsEquivalent, wgslEquivalent, metadataEquivalent };
