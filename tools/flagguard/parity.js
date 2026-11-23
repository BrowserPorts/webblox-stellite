'use strict';

const fs = require('fs');
const { effective, sameValue, displayValue, parseValue } = require('./flags');
const { subsystemOf, noiseOf } = require('./classify');

const DECISIONS_FORMAT = 1;

function parityRows(table, channels, { overrides = {} } = {}) {
  const web = { applicationSettings: channels.web };
  const mac = { applicationSettings: channels.mac };
  const pc = { applicationSettings: channels.pc };
  const rows = [];
  const keys = Object.keys(table.keys).filter(key => ['Flag', 'Int'].includes(table.keys[key].type));
  for (const key of keys) {
    const onWeb = effective(table, web, key);
    const onMac = effective(table, mac, key);
    const onPc = effective(table, pc, key);
    if (onMac.value === null || !sameValue(onMac.value, onPc.value) || sameValue(onWeb.value, onMac.value)) continue;
    rows.push({
      key,
      web: onWeb.value,
      desktop: onMac.value,
      webSource: onWeb.source,
      raw: channels.mac[key] !== undefined ? channels.mac[key] : channels.pc[key],
      subsystem: subsystemOf(key),
      noise: noiseOf(key),
      overridden: Object.prototype.hasOwnProperty.call(overrides, key),
    });
  }
  return rows.sort((a, b) => a.subsystem.localeCompare(b.subsystem) || a.key.localeCompare(b.key));
}

function readDecisions(file) {
  if (!fs.existsSync(file)) return { format: DECISIONS_FORMAT, adopt: {}, keep: {} };
  const decisions = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { format: DECISIONS_FORMAT, adopt: decisions.adopt || {}, keep: decisions.keep || {} };
}

function writeDecisions(file, decisions) {
  const sorted = section => Object.fromEntries(Object.keys(section).sort().map(key => [key, section[key]]));
  fs.writeFileSync(file, JSON.stringify({ format: DECISIONS_FORMAT, adopt: sorted(decisions.adopt), keep: sorted(decisions.keep) }, null, 2) + '\n');
}

function classifyRows(rows, decisions) {
  const groups = { adopted: [], kept: [], open: [], noise: [], overridden: [] };
  for (const row of rows) {
    if (row.overridden) groups.overridden.push(row);
    else if (decisions.adopt[row.key]) groups.adopted.push({ ...row, why: decisions.adopt[row.key].why });
    else if (decisions.keep[row.key]) groups.kept.push({ ...row, why: decisions.keep[row.key] });
    else if (row.noise) groups.noise.push(row);
    else groups.open.push(row);
  }
  return groups;
}

function adoptedSettings(decisions) {
  const out = {};
  for (const [key, decision] of Object.entries(decisions.adopt)) out[key] = String(decision.value);
  return out;
}

function staleDecisions(table, rows, decisions) {
  const live = new Map(rows.map(row => [row.key, row]));
  const stale = [];
  for (const [key, decision] of Object.entries(decisions.adopt)) {
    const entry = table.keys[key];
    const row = live.get(key);
    if (!entry) stale.push(`${key}: this build no longer reads it`);
    else if (!row) stale.push(`${key}: the web channel now matches desktop, so the override can go`);
    else if (!sameValue(parseValue(entry.type, decision.value), row.desktop)) stale.push(`${key}: desktop now uses ${displayValue(row.desktop)}, and the decision says ${decision.value}`);
  }
  return stale;
}

module.exports = { parityRows, readDecisions, writeDecisions, classifyRows, adoptedSettings, staleDecisions };
