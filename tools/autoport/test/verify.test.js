'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deepDifferences, compareTrees, wgslEquivalent, metadataEquivalent } = require('../verify');
const { replaceOnce, indexHtmlFor, MatchCache, ownedFiles } = require('../pipeline');
const { renderReport, printSummary } = require('../report');
const L = require('../luau/bytecode');
const { doubtfulSymbols } = require('../patches/engine-wasm');

test('deepDifferences names each change', () => {
  assert.deepEqual(deepDifferences({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), []);
  assert.match(deepDifferences({ a: 1 }, { a: 2 })[0], /a is 2, and it was 1/);
  assert.match(deepDifferences({ a: 1 }, {})[0], /a is gone/);
  assert.match(deepDifferences({}, { a: 1 })[0], /a is new/);
  assert.match(deepDifferences({ list: [1] }, { list: [1, 2] })[0], /list has 2 entries/);
  assert.match(deepDifferences({ deep: { value: [{ x: 1 }] } }, { deep: { value: [{ x: 2 }] } })[0], /deep\.value\[0\]\.x/);
  assert.deepEqual(deepDifferences({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
});

function tempTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webblox-tree-'));
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  return dir;
}

test('compareTrees finds changed, missing and extra files', () => {
  const a = tempTree({ 'same.txt': 'x', 'changed.txt': 'one', 'gone.txt': 'y', 'deep/file.txt': 'z' });
  const b = tempTree({ 'same.txt': 'x', 'changed.txt': 'two', 'added.txt': 'y', 'deep/file.txt': 'z' });
  try {
    const tree = compareTrees(a, b);
    assert.deepEqual(tree.differs, ['changed.txt']);
    assert.deepEqual(tree.missing, ['gone.txt']);
    assert.deepEqual(tree.extra, ['added.txt']);
    assert.equal(tree.compared, 3);
    assert.deepEqual(compareTrees(a, b, rel => rel === 'changed.txt').differs, []);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('WGSL tables compare by shader, not by file order', () => {
  const a = tempTree({ 'wgsl.txt': 'AAABB', 'wgsl-index.json': JSON.stringify({ one: [0, 3], two: [3, 2] }) });
  const b = tempTree({ 'wgsl.txt': 'BBAAA', 'wgsl-index.json': JSON.stringify({ one: [2, 3], two: [0, 2] }) });
  const c = tempTree({ 'wgsl.txt': 'BBAAC', 'wgsl-index.json': JSON.stringify({ one: [2, 3], two: [0, 2] }) });
  try {
    assert.equal(wgslEquivalent(a, b), true);
    assert.equal(wgslEquivalent(a, c), false);
  } finally {
    for (const dir of [a, b, c]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metadata may differ only in the sizes of explained files', () => {
  const a = tempTree({ 'm.json': JSON.stringify([{ path: '/x', size: 1 }, { path: '/y', size: 2 }]) });
  const b = tempTree({ 'm.json': JSON.stringify([{ path: '/y', size: 2 }, { path: '/x', size: 5 }]) });
  try {
    assert.equal(metadataEquivalent(path.join(a, 'm.json'), path.join(b, 'm.json'), new Set(['x'])), true);
    assert.equal(metadataEquivalent(path.join(a, 'm.json'), path.join(b, 'm.json'), new Set()), false);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('replaceOnce refuses zero or several matches', () => {
  assert.equal(replaceOnce('a=1', /a=\d/, 'a=2', 'label'), 'a=2');
  assert.throws(() => replaceOnce('b', /a/, 'c', 'the label'), /the label: expected one match, found 0/);
  assert.throws(() => replaceOnce('a a', /a/, 'c', 'the label'), /found 2/);
});

test('the page gets the new version and theme address', () => {
  const page = "heap[1 >> 2] = scheme.matches ? 2 : 1;\nvar version = 'version-abc';\n";
  const next = indexHtmlFor(page, 'version-def', 42);
  assert.match(next, /heap\[42 >> 2\]/);
  assert.match(next, /var version = 'version-def';/);
  assert.throws(() => indexHtmlFor('nothing', 'version-def', 42), /expected one match/);
});

test('files Roblox does not list count as owned by WebBlox', () => {
  const dir = tempTree({
    'WebClient.metadata.json': JSON.stringify([{ path: '/content/a.png', size: 1 }, { path: '/shaders/s.pack', size: 1 }]),
    'content/a.png': 'x',
    'shaders/s.pack': 'x',
    'WebClient.wasm': 'x',
    'WebClient.js': 'x',
    'stub.js': 'ours',
    'content/textures/eras/one.png': 'ours',
  });
  try {
    assert.deepEqual(ownedFiles(dir).sort(), ['content/textures/eras/one.png', 'stub.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the match cache keeps one matcher version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webblox-cache-'));
  try {
    const cache = new MatchCache(dir);
    assert.equal(cache.load('a'.repeat(64), 'b'.repeat(64)), null);
    fs.writeFileSync(path.join(dir, 'stale.match'), 'old');
    cache.save('a'.repeat(64), 'b'.repeat(64), Buffer.from('data'));
    assert.equal(cache.load('a'.repeat(64), 'b'.repeat(64)).toString(), 'data');
    assert.equal(fs.existsSync(path.join(dir, 'stale.match')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sampleReport(overrides) {
  return {
    from: { version: 'version-a', windows: 'version-w' },
    to: { version: 'version-b', windows: 'version-w' },
    units: [
      { id: 'one', group: 'wasm', title: 'First unit', required: true, status: 'ported' },
      { id: 'two', group: 'wasm', title: 'Second unit', required: true, status: 'failed', reason: 'it broke', details: { func: 5, site: 'the check', closestMatch: '1 of 2', nearby: 'code here' } },
      { id: 'three', group: 'loader', title: 'Third | unit', required: false, status: 'failed', reason: 'gone', details: { closest: 'near text' } },
    ],
    contracts: [{ id: 'hash', ok: false, severity: 'error', detail: 'bad' }, { id: 'fine', ok: true, severity: 'error', detail: 'good' }],
    warnings: ['look at this'],
    notes: ['a note'],
    steps: [{ id: 'resolve', seconds: 1 }],
    seconds: 1,
    outcome: 'failed',
    match: { matched: 1, functions: 2, matchedInstructions: 0.5, callEdgesKept: 0.5, counts: { exact: 1 } },
    symbols: { NAME: { old: 1, target: 2, how: 'fuzzy', unchanged: false, similarity: 0.7, neighbors: '1/2' } },
    missingSymbols: ['OTHER'],
    ...overrides,
  };
}

test('the report carries failures, diagnostics and evidence', () => {
  const text = renderReport(sampleReport());
  for (const part of ['version-a', 'version-b', 'it broke', 'code here', 'near text', 'look at this', 'a note', 'NAME', 'OTHER', 'weak match']) assert.ok(text.includes(part), part);
  assert.ok(text.includes('Third \\| unit'));
  assert.match(text, /Nothing changed in `public\/`/);
  assert.match(renderReport(sampleReport({ outcome: 'ready', units: [], contracts: [] })), /--apply/);
  assert.match(renderReport(sampleReport({ outcome: 'partial', units: [], contracts: [] })), /--allow-partial/);
  assert.match(renderReport(sampleReport({ outcome: 'ready', selftest: true, units: [], contracts: [], identity: { same: true, differences: [] } })), /Every file, plan and profile entry matched/);
});

test('a run that stops early says why', () => {
  const lines = [];
  const report = sampleReport({ units: [], contracts: [], fatal: 'the last section runs past the end of the file' });
  printSummary(report, line => lines.push(line));
  assert.match(lines.join('\n'), /stopped early: the last section/);
  assert.match(renderReport(report), /stopped early: the last section/);
});

test('the console summary lists every failure', () => {
  const lines = [];
  printSummary(sampleReport(), line => lines.push(line));
  const text = lines.join('\n');
  assert.match(text, /FAILED: Second unit/);
  assert.match(text, /FAILED \(optional\): Third/);
  assert.match(text, /FAILED: hash/);
});

test('weak answers without a pattern get flagged', () => {
  const doubts = doubtfulSymbols({
    FINE: { target: 1, how: 'exact', unchanged: true },
    WITNESSED: { target: 2, how: 'fuzzy', unchanged: false, witness: true },
    WEAK: { target: 3, how: 'twin', unchanged: false, neighborRatio: 1 },
    LONELY: { target: 4, how: 'propagated', unchanged: false, neighborRatio: 0.2, neighbors: '1/5' },
    CHANGED: { target: 5, how: 'evidence', unchanged: false, neighborRatio: 0.9, neighbors: '9/10' },
  });
  assert.equal(doubts.length, 2);
  assert.match(doubts[0], /WEAK is function 3 from a twin match/);
  assert.match(doubts[1], /only 1\/5 of its neighbours/);
});

test('Luau opcode encoding round trips every byte', () => {
  for (let op = 0; op < 256; op++) assert.equal(L.decodeOp(L.encodeOp(op)), op);
});
