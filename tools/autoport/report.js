'use strict';

const STATUS_ORDER = { failed: 0, skipped: 1, ported: 2, unchanged: 3 };
const GROUP_TITLES = { wasm: 'Engine wasm', models: 'Lua models', webclient: 'WebClient.js', loader: 'WasmPlayer.js', shaders: 'Shaders', patcher: 'Patcher' };
const WEAK = new Set(['fuzzy', 'twin']);
const PROBLEM_KINDS = { stub: 'Function the backport replaces', function: 'Function', address: 'Data address', string: 'String', slot: 'Table slot', type: 'Function type', import: 'Import', global: 'Global', vtable: 'Virtual call offset' };

function cell(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function table(headers, rows) {
  if (!rows.length) return '';
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n');
}

function outcomeSentence(report) {
  switch (report.outcome) {
    case 'ready': return report.selftest ? 'The self test passed. The tool rebuilt the live engine from its pristine download.' : `The stage is ready. Run \`npm run autoport -- --apply ${report.to.version}\` to install it.`;
    case 'partial': return `The stage works without some optional patches. Read the failed units, then run \`npm run autoport -- --apply ${report.to.version} --allow-partial\` to install it anyway.`;
    case 'up to date': return 'WebBlox already runs the live web client.';
    default: return report.selftest ? 'The self test failed.' : 'The update stopped. Fix the failed units below and run the tool again. Nothing changed in `public/`.';
  }
}

function groupUnits(units) {
  const groups = new Map();
  for (const unit of units) {
    if (!groups.has(unit.group)) groups.set(unit.group, []);
    groups.get(unit.group).push(unit);
  }
  return groups;
}

function renderFailure(unit) {
  const lines = [`### ${unit.title}`, '', unit.reason || 'No reason recorded.'];
  const details = unit.details || {};
  if (details.func !== undefined) lines.push('', `Function ${details.func}${details.site ? `, looking for ${details.site}` : ''}.`);
  if (details.closestMatch) lines.push('', `Closest match: ${details.closestMatch}.`);
  if (details.nearby) lines.push('', '```', details.nearby, '```');
  if (typeof details.closest === 'string') lines.push('', `Closest text in the new file: \`${details.closest.slice(0, 300)}\``);
  else if (details.closest && details.closest.text) lines.push('', `Closest text in the new file: \`${details.closest.text.slice(0, 300)}\``);
  else if (details.closest && details.closest.totalTokens) {
    const { matchedTokens, totalTokens, continuesWith, found } = details.closest;
    lines.push('', `The first ${matchedTokens} of ${totalTokens} tokens still match. The patch expects \`${continuesWith}\` next, and the new file has \`${found.slice(0, 120)}\`.`);
  }
  if (details.problems) {
    const rows = details.problems.slice(0, 40).map(problem => [PROBLEM_KINDS[problem.kind] || problem.kind, problem.old !== undefined ? problem.old : problem.name, problem.where || problem.reason || '']);
    lines.push('', table(['Kind', 'Old value', 'Where'], rows));
    if (details.problems.length > 40) lines.push('', `${details.problems.length - 40} more not shown.`);
  }
  return lines.join('\n');
}

function renderReport(report) {
  const out = [`# Engine update report`, ''];
  out.push(`From \`${report.from.version}\` to \`${report.to.version}\`${report.selftest ? ' (self test)' : ''}.`, '');
  out.push(`**Outcome: ${report.outcome}.** ${outcomeSentence(report)}`, '');
  if (report.from.windows) out.push(`Windows models and shaders: \`${report.from.windows}\` to \`${report.to.windows}\`.`, '');

  const failures = report.units.filter(unit => unit.status === 'failed');
  const required = failures.filter(unit => unit.required);
  const contractFailures = report.contracts.filter(contract => !contract.ok);
  if (failures.length || contractFailures.length || report.fatal) {
    out.push('## Problems', '');
    if (report.fatal) out.push(`The tool stopped early: ${report.fatal}`, '');
    if (required.length) out.push(`${required.length} required unit(s) failed. WebBlox cannot move to this build until they are fixed.`, '');
    for (const unit of [...required, ...failures.filter(entry => !entry.required)]) out.push(renderFailure(unit), '');
    if (contractFailures.length) {
      out.push('### Contract checks', '');
      for (const contract of contractFailures) out.push(`- **${contract.id}** (${contract.severity}): ${contract.detail}`);
      out.push('');
    }
  }

  if (report.warnings.length) {
    out.push('## Worth checking by hand', '');
    for (const warning of report.warnings) out.push(`- ${warning}`);
    out.push('');
  }

  out.push('## Units', '');
  for (const [group, units] of groupUnits(report.units)) {
    const sorted = [...units].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    out.push(`### ${GROUP_TITLES[group] || group}`, '');
    out.push(table(['Unit', 'Required', 'Status', 'Detail'], sorted.map(unit => [unit.title, unit.required ? 'yes' : 'no', unit.status, unit.reason || unit.summary || (unit.renames && unit.renames.length ? `renamed ${unit.renames.join(', ')}` : '')])), '');
  }

  if (report.match) {
    const match = report.match;
    const share = value => `${(value * 100).toFixed(1)}%`;
    out.push('## Function matching', '');
    out.push(`${match.matched} of ${match.functions} functions matched, covering ${share(match.matchedInstructions)} of the old build's code. ${share(match.callEdgesKept)} of call edges between matched functions still exist in the new build.`, '');
    out.push(table(['How', 'Functions'], Object.entries(match.counts).sort((a, b) => b[1] - a[1])), '');
  }

  if (report.symbols && Object.keys(report.symbols).length) {
    const confirmation = entry => (entry.witness ? 'code pattern' : entry.confirmed || '');
    const entries = Object.entries(report.symbols);
    const rows = entries.map(([name, entry]) => [name, entry.old, entry.target, entry.how, entry.unchanged === undefined ? '' : entry.unchanged ? 'yes' : 'no', entry.similarity === undefined ? '' : entry.similarity, entry.neighbors || '', confirmation(entry)]);
    const weak = entries.filter(([, entry]) => WEAK.has(entry.how) || entry.inferred);
    const unconfirmed = weak.filter(([, entry]) => entry.unchanged === false && !confirmation(entry));
    out.push('## Named functions', '');
    if (weak.length) out.push(`${weak.length} of these came from a weak match or were inferred. ${unconfirmed.length ? `${unconfirmed.length} of them have no independent confirmation and are listed under the checks above.` : 'A code pattern, the call sites or the table position confirmed each one that changed.'}`, '');
    out.push(table(['Name', 'Old', 'New', 'Match', 'Same code', 'Similarity', 'Neighbours', 'Confirmed by'], rows), '');
    if (report.missingSymbols && report.missingSymbols.length) out.push(`No match for: ${report.missingSymbols.join(', ')}.`, '');
  }

  if (report.contracts.length) {
    out.push('## Contract checks', '');
    out.push(table(['Check', 'Result', 'Detail'], report.contracts.map(contract => [contract.id, contract.ok ? 'pass' : contract.severity === 'error' ? 'FAIL' : 'warn', contract.detail])), '');
  }

  if (report.identity) {
    out.push('## Self test comparison', '');
    if (report.identity.same) out.push('Every file, plan and profile entry matched.', '');
    else for (const difference of report.identity.differences) out.push(`- ${difference}`);
    out.push('');
  }

  if (report.notes.length) {
    out.push('## Notes', '');
    for (const note of report.notes) out.push(`- ${note}`);
    out.push('');
  }

  out.push('## Timing', '');
  out.push(table(['Step', 'Seconds'], report.steps.map(step => [step.id, step.seconds])), '');
  out.push(`Total: ${report.seconds} seconds.`, '');
  return out.join('\n');
}

function printSummary(report, log = console.log) {
  log('');
  log(`Outcome: ${report.outcome}. ${outcomeSentence(report).replace(/`/g, '')}`);
  if (report.fatal) log(`  The tool stopped early: ${report.fatal}`);
  const counts = {};
  for (const unit of report.units) counts[unit.status] = (counts[unit.status] || 0) + 1;
  if (report.units.length) log(`Units: ${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ')}.`);
  for (const unit of report.units.filter(entry => entry.status === 'failed')) log(`  FAILED${unit.required ? '' : ' (optional)'}: ${unit.title}: ${String(unit.reason).split('\n')[0].slice(0, 200)}`);
  for (const contract of report.contracts.filter(entry => !entry.ok)) log(`  ${contract.severity === 'error' ? 'FAILED' : 'warning'}: ${contract.id}: ${contract.detail.slice(0, 300)}`);
  if (report.warnings.length) log(`  ${report.warnings.length} warning(s) worth reading in the report.`);
  if (report.identity && !report.identity.same) for (const difference of report.identity.differences.slice(0, 20)) log(`  differs: ${difference}`);
  if (report.stage) log(`Report: ${report.stage}/report.md`);
}

module.exports = { renderReport, printSummary };
