'use strict';

const { resolve } = require('./table');

const IXP_VALUE = '_IXPValue';
const STAGED = '_Staged';
const INTEGER = /^-?\d+$/;
const SCOPED = new Set(['PlaceFilter', 'UniverseFilter', 'DataCenterFilter']);

function firstField(value) {
  return String(value).split(';')[0].trim();
}

function parseValue(type, raw) {
  if (raw === undefined || raw === null) return null;
  const text = firstField(raw);
  if (type === 'Flag') {
    const lower = text.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    return null;
  }
  if (type === 'Int' || type === 'Log') return INTEGER.test(text) ? BigInt(text).toString() : null;
  return String(raw);
}

function normalizeDefault(type, value) {
  if (value === null || value === undefined) return null;
  if (type === 'Flag') return Boolean(value);
  if (type === 'Int' || type === 'Log') return String(value);
  return String(value);
}

function typeOf(resolved) {
  if (resolved.engine) return resolved.engine.type;
  if (resolved.lua && resolved.lua.type) return resolved.lua.type;
  return resolved.parts ? resolved.parts.type : null;
}

function defaultOf(resolved) {
  const type = typeOf(resolved);
  if (resolved.engine) return normalizeDefault(type, resolved.engine.default);
  if (resolved.lua && resolved.lua.type) return normalizeDefault(type, resolved.lua.default);
  return null;
}

function emptySet() {
  return { applicationSettings: {}, ixp: {} };
}

function settingsOf(set) {
  return (set && set.applicationSettings) || {};
}

function ixpOf(set) {
  return (set && set.ixp) || {};
}

function effective(table, set, key) {
  const resolved = resolve(table, key);
  const type = typeOf(resolved);
  const settings = settingsOf(set);
  const experiment = ixpOf(set)[key + IXP_VALUE];
  if (experiment !== undefined) return { value: parseValue(type, experiment), raw: experiment, source: 'experiment', type, resolved };
  if (settings[key + STAGED] !== undefined) return { value: parseValue(type, settings[key + STAGED]), raw: settings[key + STAGED], source: 'staged', type, resolved };
  if (Object.prototype.hasOwnProperty.call(settings, key)) {
    const value = parseValue(type, settings[key]);
    if (value !== null || type === 'String') return { value, raw: settings[key], source: 'set', type, resolved };
    return { value: defaultOf(resolved), raw: settings[key], source: 'unreadable', type, resolved };
  }
  return { value: defaultOf(resolved), raw: null, source: 'default', type, resolved };
}

function sameValue(a, b) {
  return a === b || (a !== null && b !== null && String(a) === String(b));
}

function displayValue(value) {
  if (value === undefined) return 'unset';
  if (value === null) return 'unknown';
  return String(value);
}

function sortedObject(object) {
  const out = {};
  for (const key of Object.keys(object).sort()) out[key] = object[key];
  return out;
}

function compareSets(table, before, after, { overrides = {} } = {}) {
  const changes = [];
  const oldSettings = settingsOf(before);
  const newSettings = settingsOf(after);
  const keys = new Set([...Object.keys(oldSettings), ...Object.keys(newSettings)]);
  for (const key of keys) {
    const was = oldSettings[key];
    const now = newSettings[key];
    if (was === now) continue;
    changes.push(describeChange(table, before, after, key, was, now, overrides));
  }
  const oldIxp = ixpOf(before);
  const newIxp = ixpOf(after);
  for (const key of new Set([...Object.keys(oldIxp), ...Object.keys(newIxp)])) {
    if (oldIxp[key] === newIxp[key] || !key.endsWith(IXP_VALUE)) continue;
    const flag = key.slice(0, -IXP_VALUE.length);
    const change = describeChange(table, before, after, flag, oldIxp[key], newIxp[key], overrides);
    change.key = key;
    change.flag = flag;
    change.experiment = true;
    changes.push(change);
  }
  return changes.sort((a, b) => a.key.localeCompare(b.key));
}

function describeChange(table, before, after, key, was, now, overrides) {
  const resolved = resolve(table, key);
  const change = {
    key,
    flag: resolved.base,
    kind: was === undefined ? 'added' : now === undefined ? 'removed' : 'changed',
    before: was,
    after: now,
    reader: null,
    effect: 'none',
    from: null,
    to: null,
  };
  const target = resolve(table, resolved.base);
  change.reader = target.reader;
  if (!target.reader) {
    change.effect = 'dead';
    return change;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, resolved.base)) {
    change.effect = 'overridden';
    return change;
  }
  if (resolved.scope && SCOPED.has(resolved.scope)) {
    change.effect = 'scoped';
    change.scope = resolved.scope;
    return change;
  }
  if (resolved.scope === 'IXP') {
    change.effect = 'experiment';
    return change;
  }
  const old = effective(table, before, resolved.base);
  const next = effective(table, after, resolved.base);
  change.from = old.value;
  change.to = next.value;
  change.type = next.type || old.type;
  if (resolved.scope === 'Staged') {
    change.effect = sameValue(old.value, next.value) ? 'none' : 'staged';
    return change;
  }
  if (target.reader === 'engine-name' || (target.reader === 'lua' && !(target.lua && target.lua.type))) {
    change.effect = sameValue(old.value, next.value) && old.value !== null ? 'none' : 'unknown';
    return change;
  }
  change.effect = sameValue(old.value, next.value) ? 'none' : 'changes';
  return change;
}

module.exports = { parseValue, effective, compareSets, sameValue, displayValue, sortedObject, emptySet, settingsOf, ixpOf, firstField, IXP_VALUE, STAGED };
