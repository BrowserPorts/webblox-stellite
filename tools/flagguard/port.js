'use strict';

function engineKey(table, key) {
  return table.keys[key] || null;
}

function successor(table, entry, prefix) {
  const matches = Object.entries(table.keys).filter(([key, candidate]) => candidate.name === entry.name && candidate.type === entry.type && key.startsWith(prefix + entry.type));
  if (matches.length !== 1) return null;
  return matches[0][0];
}

function prefixOf(key, entry) {
  const at = key.indexOf(entry.type);
  return at > 0 ? key.slice(0, at) : null;
}

function portOverrides(required, oldTable, newTable) {
  const flags = {};
  const renamed = [];
  const lost = [];
  const unchecked = [];
  for (const [key, value] of Object.entries(required)) {
    const before = engineKey(oldTable, key);
    if (!before) {
      flags[key] = value;
      unchecked.push(key);
      continue;
    }
    if (engineKey(newTable, key)) {
      flags[key] = value;
      continue;
    }
    const prefix = prefixOf(key, before);
    const next = prefix ? successor(newTable, before, prefix) : null;
    if (next) {
      flags[next] = value;
      renamed.push({ from: key, to: next });
    } else {
      flags[key] = value;
      lost.push(key);
    }
  }
  return { flags, renamed, lost, unchecked };
}

module.exports = { portOverrides };
