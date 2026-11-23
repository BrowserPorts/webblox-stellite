'use strict';

const fs = require('fs');
const path = require('path');
const { sortedObject, IXP_VALUE, STAGED } = require('./flags');

const PIN_FILE = 'PinnedFlags.json';
const FORMAT = 1;
const SET_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

function pinPath(engineDir) {
  return path.join(engineDir, PIN_FILE);
}

function cleanIxp(ixp) {
  const out = {};
  for (const [key, value] of Object.entries(ixp || {})) {
    if (key.endsWith(IXP_VALUE) && typeof value === 'string') out[key] = value;
  }
  return sortedObject(out);
}

function makePin({ engine, settings, ixp = {}, source = {}, now = new Date(), keepStaged = false }) {
  const applicationSettings = {};
  const removed = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!keepStaged && key.endsWith(STAGED)) removed[key] = value;
    else applicationSettings[key] = String(value);
  }
  return {
    format: FORMAT,
    engine,
    pinnedAt: now.toISOString(),
    source,
    removed: sortedObject(removed),
    ixp: cleanIxp(ixp),
    applicationSettings: sortedObject(applicationSettings),
  };
}

function serialize(pin) {
  const lines = ['{'];
  const fields = Object.keys(pin);
  fields.forEach((field, index) => {
    const value = pin[field];
    const comma = index < fields.length - 1 ? ',' : '';
    if (value && typeof value === 'object' && !Array.isArray(value) && (field === 'applicationSettings' || field === 'ixp' || field === 'removed')) {
      const entries = Object.entries(value);
      if (!entries.length) {
        lines.push(`  ${JSON.stringify(field)}: {}${comma}`);
        return;
      }
      lines.push(`  ${JSON.stringify(field)}: {`);
      entries.forEach(([key, item], position) => lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(item)}${position < entries.length - 1 ? ',' : ''}`));
      lines.push(`  }${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(field)}: ${JSON.stringify(value)}${comma}`);
    }
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}

function validate(pin) {
  const problems = [];
  if (!pin || typeof pin !== 'object') return ['the file is not a JSON object'];
  if (pin.format !== FORMAT) problems.push(`format ${pin.format} is not ${FORMAT}`);
  if (typeof pin.engine !== 'string' || !/^version-[0-9a-z-]+$/.test(pin.engine)) problems.push('it names no engine version');
  if (!pin.applicationSettings || typeof pin.applicationSettings !== 'object' || Array.isArray(pin.applicationSettings)) problems.push('it has no applicationSettings');
  else if (Object.values(pin.applicationSettings).some(value => typeof value !== 'string')) problems.push('some values are not strings');
  if (pin.ixp && (typeof pin.ixp !== 'object' || Array.isArray(pin.ixp))) problems.push('ixp is not an object');
  return problems;
}

function readPin(file) {
  if (!fs.existsSync(file)) return null;
  const pin = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = validate(pin);
  if (problems.length) throw new Error(`${path.basename(file)} is not a valid flag set: ${problems.join('; ')}`);
  return pin;
}

function writePin(file, pin) {
  const problems = validate(pin);
  if (problems.length) throw new Error(`Refusing to write a broken flag set: ${problems.join('; ')}`);
  const text = serialize(pin);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
  return Buffer.byteLength(text);
}

function withChanges(pin, changes, { now = new Date(), note = null } = {}) {
  const settings = { ...pin.applicationSettings };
  const ixp = { ...(pin.ixp || {}) };
  for (const [key, value] of Object.entries(changes.settings || {})) {
    if (value === null) delete settings[key];
    else settings[key] = String(value);
  }
  for (const [key, value] of Object.entries(changes.ixp || {})) {
    if (value === null) delete ixp[key];
    else ixp[key] = value;
  }
  const next = { ...pin, pinnedAt: now.toISOString(), ixp: sortedObject(ixp), applicationSettings: sortedObject(settings) };
  if (note) next.source = { ...(pin.source || {}), note };
  return next;
}

function setsDir(cacheDir) {
  return path.join(cacheDir, 'sets');
}

function setPath(cacheDir, name) {
  if (!SET_NAME.test(name)) throw new Error(`"${name}" is not a valid set name. Use lowercase letters, digits and dashes.`);
  return path.join(setsDir(cacheDir), `${name}.json`);
}

module.exports = { makePin, serialize, validate, readPin, writePin, withChanges, pinPath, setPath, setsDir, PIN_FILE, FORMAT, SET_NAME };
