'use strict';

const { displayValue } = require('./flags');
const { subsystemOf, noiseOf } = require('./classify');

const LISTED_EFFECTS = ['changes', 'staged', 'unknown'];
const EFFECT_TITLES = {
  changes: 'Changes what this build does',
  staged: 'Roblox is rolling these out over time',
  unknown: 'Read by name or by Lua with no known default, so the effect is unclear',
  scoped: 'Only apply to certain places, experiences or data centers',
  experiment: 'Tie a flag to an experiment',
  overridden: 'WebBlox overrides these, so the change does nothing',
  none: 'Same value as before in practice',
  dead: 'Nothing in this build reads them',
};

function cell(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function table(headers, rows) {
  if (!rows.length) return '';
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n');
}

function summarize(changes) {
  const groups = { changes: [], noisy: [], staged: [], unknown: [], scoped: [], experiment: [], overridden: [], none: [], dead: [] };
  for (const change of changes) {
    const noise = noiseOf(change.flag || change.key);
    if (change.effect === 'changes' && noise) groups.noisy.push({ ...change, noise });
    else groups[change.effect].push(change);
  }
  return groups;
}

function valueText(change) {
  if (change.effect === 'changes' || change.effect === 'staged' || change.effect === 'unknown') return `${displayValue(change.from)} -> ${displayValue(change.to)}`;
  if (change.kind === 'added') return `added ${displayValue(change.after)}`;
  if (change.kind === 'removed') return `removed (was ${displayValue(change.before)})`;
  return `${displayValue(change.before)} -> ${displayValue(change.after)}`;
}

function bySubsystem(changes) {
  const groups = new Map();
  for (const change of changes) {
    const label = subsystemOf(change.flag || change.key);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(change);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function countLine(groups) {
  const parts = [];
  if (groups.noisy.length) parts.push(`${groups.noisy.length} telemetry, logging, bookkeeping or other-platform flags`);
  if (groups.scoped.length) parts.push(`${groups.scoped.length} for certain places or data centers`);
  if (groups.experiment.length) parts.push(`${groups.experiment.length} experiment links`);
  if (groups.overridden.length) parts.push(`${groups.overridden.length} that WebBlox overrides`);
  if (groups.none.length) parts.push(`${groups.none.length} with the same value in practice`);
  if (groups.dead.length) parts.push(`${groups.dead.length} that nothing in this build reads`);
  return parts.join(', ');
}

function printChanges(changes, log, { all = false, limit = 40 } = {}) {
  const groups = summarize(changes);
  const listed = LISTED_EFFECTS.reduce((sum, effect) => sum + groups[effect].length, 0);
  const headline = groups.changes.length ? `${groups.changes.length} of them change what this build does.` : listed ? 'None of them change what this build does today.' : 'None of them change what this build does.';
  log(`${changes.length} ${changes.length === 1 ? 'entry' : 'entries'} changed. ${headline}`);
  for (const effect of LISTED_EFFECTS) {
    if (!groups[effect].length) continue;
    log('');
    log(`${EFFECT_TITLES[effect]}:`);
    let shown = 0;
    for (const [label, items] of bySubsystem(groups[effect])) {
      log(`  ${label}`);
      for (const change of items) {
        if (!all && shown >= limit) break;
        log(`    ${change.key.padEnd(56)} ${valueText(change)}`);
        shown++;
      }
    }
    if (!all && groups[effect].length > limit) log(`  ${groups[effect].length - limit} more in the report.`);
  }
  if (all) {
    for (const effect of ['scoped', 'experiment', 'overridden', 'none', 'dead']) {
      if (!groups[effect].length) continue;
      log('');
      log(`${EFFECT_TITLES[effect]}:`);
      for (const change of groups[effect]) log(`    ${change.key.padEnd(56)} ${valueText(change)}`);
    }
    if (groups.noisy.length) {
      log('');
      log('Telemetry, logging, bookkeeping and other platforms:');
      for (const change of groups.noisy) log(`    ${change.key.padEnd(56)} ${valueText(change)}`);
    }
  } else {
    const rest = countLine(groups);
    if (rest) {
      log('');
      log(`Also changed: ${rest}.`);
    }
  }
  return groups;
}

function renderChanges(title, intro, changes) {
  const groups = summarize(changes);
  const out = [`# ${title}`, '', ...intro, ''];
  const sections = [...LISTED_EFFECTS, 'noisy', 'scoped', 'experiment', 'overridden', 'none', 'dead'];
  for (const section of sections) {
    const items = groups[section];
    if (!items.length) continue;
    out.push(`## ${section === 'noisy' ? 'Telemetry, logging, bookkeeping and other platforms' : EFFECT_TITLES[section]} (${items.length})`, '');
    out.push(table(['Key', 'Area', 'Change', 'Read by'], items.map(change => [`\`${change.key}\``, subsystemOf(change.flag || change.key), valueText(change), change.reader || 'nothing'])), '');
  }
  if (!changes.length) out.push('Nothing changed.', '');
  return out.join('\n');
}

function renderParity(groups, stale, intro) {
  const out = ['# Desktop parity', '', ...intro, ''];
  const rows = items => items.map(row => [`\`${row.key}\``, row.subsystem, displayValue(row.web), displayValue(row.desktop), row.why || row.noise || '']);
  const sections = [
    ['Undecided', groups.open],
    ['Adopted, waiting for a test', groups.adopted],
    ['Kept as web has them', groups.kept],
    ['Already overridden by WebBlox', groups.overridden],
    ['Telemetry, logging and other platforms', groups.noise],
  ];
  for (const [title, items] of sections) {
    if (!items.length) continue;
    out.push(`## ${title} (${items.length})`, '', table(['Key', 'Area', 'Web', 'Desktop', 'Note'], rows(items)), '');
  }
  if (stale.length) out.push('## Decisions to revisit', '', ...stale.map(line => `- ${line}`), '');
  return out.join('\n');
}

module.exports = { summarize, printChanges, renderChanges, renderParity, valueText, bySubsystem, countLine, EFFECT_TITLES };
