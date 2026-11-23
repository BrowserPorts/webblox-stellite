'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { apply, rollback } = require('../apply');
const { sha } = require('../delta');
const { compareTrees } = require('../verify');

const OLD = 'version-aaaa';
const NEW = 'version-bbbb';
const OLD_ADDRESS = 111;
const NEW_ADDRESS = 222;

function write(root, rel, data) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function plansFor(version, address, wasm) {
  return {
    'profile.json': JSON.stringify({ version, themeAddress: address }),
    'luaapp-plan.json': JSON.stringify({ sourceSha256: 'x' }),
    'render-threads-plan.json': JSON.stringify({ patchedSha256: sha(wasm) }),
    'luaapp-bodies.wasm': 'bodies',
  };
}

function indexPage(version, address) {
  return `heap[${address} >> 2] = scheme.matches ? 2 : 1;\nvar version = '${version}';\n`;
}

function fixture({ outcome = 'ready' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webblox-apply-'));
  const oldWasm = Buffer.from('old engine');
  const newWasm = Buffer.from('new engine');
  write(root, 'public/engine/WebClient.wasm', oldWasm);
  write(root, 'public/engine/only-old.txt', 'old');
  write(root, 'public/gen/routes.json', '{"old":1}');
  write(root, 'public/index.html', indexPage(OLD, OLD_ADDRESS));
  write(root, 'server/config.js', `const ENGINE_VERSION = process.env.WEBBLOX_ENGINE_VERSION || '${OLD}';\n`);
  write(root, 'TODO.md', `## Open, engine build \`${OLD}\`\n`);
  for (const [name, data] of Object.entries(plansFor(OLD, OLD_ADDRESS, oldWasm))) write(root, `tools/backport/${name}`, data);
  const stage = `.cache/engine-update/${NEW}`;
  write(root, `${stage}/public/engine/WebClient.wasm`, newWasm);
  write(root, `${stage}/public/engine/only-new.txt`, 'new');
  write(root, `${stage}/public/gen/routes.json`, '{"new":1}');
  write(root, `${stage}/public/index.html`, indexPage(NEW, NEW_ADDRESS));
  for (const [name, data] of Object.entries(plansFor(NEW, NEW_ADDRESS, newWasm))) write(root, `${stage}/plans/${name}`, data);
  write(root, `${stage}/plans/pristine.delta`, 'delta');
  write(root, `${stage}/report.json`, JSON.stringify({ outcome, to: { version: NEW } }));
  write(root, `${stage}/report.md`, '# report');
  return root;
}

function snapshot(root) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'webblox-snapshot-'));
  for (const rel of ['public', 'server', 'tools']) fs.cpSync(path.join(root, rel), path.join(copy, rel), { recursive: true });
  fs.copyFileSync(path.join(root, 'TODO.md'), path.join(copy, 'TODO.md'));
  return copy;
}

function assertSame(a, b) {
  for (const rel of ['public', 'server', 'tools']) {
    const tree = compareTrees(path.join(a, rel), path.join(b, rel));
    assert.deepEqual([tree.differs, tree.missing, tree.extra], [[], [], []], rel);
  }
  assert.equal(fs.readFileSync(path.join(a, 'TODO.md'), 'utf8'), fs.readFileSync(path.join(b, 'TODO.md'), 'utf8'));
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

test('apply swaps the engine and every version reference', () => {
  const root = fixture();
  try {
    assert.deepEqual(apply(NEW, { root }), { from: OLD, to: NEW });
    assert.equal(fs.readFileSync(path.join(root, 'public/engine/WebClient.wasm'), 'utf8'), 'new engine');
    assert.equal(fs.existsSync(path.join(root, 'public/engine/only-old.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'public/engine/only-new.txt')), true);
    assert.equal(fs.readFileSync(path.join(root, 'public/gen/routes.json'), 'utf8'), '{"new":1}');
    assert.equal(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), indexPage(NEW, NEW_ADDRESS));
    assert.match(fs.readFileSync(path.join(root, 'server/config.js'), 'utf8'), new RegExp(NEW));
    assert.match(fs.readFileSync(path.join(root, 'TODO.md'), 'utf8'), new RegExp(NEW));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'tools/backport/profile.json'), 'utf8')).version, NEW);
    assert.equal(fs.readFileSync(path.join(root, 'tools/backport/pristine.delta'), 'utf8'), 'delta');
  } finally {
    cleanup(root);
  }
});

test('rollback restores the tree exactly and allows a second apply', () => {
  const root = fixture();
  const before = snapshot(root);
  try {
    apply(NEW, { root });
    rollback({ root });
    assertSame(before, root);
    assert.equal(fs.existsSync(path.join(root, 'tools/backport/pristine.delta')), false);
    assert.throws(() => rollback({ root }), /nothing to roll back/);
    apply(NEW, { root });
    assert.equal(fs.readFileSync(path.join(root, 'public/engine/WebClient.wasm'), 'utf8'), 'new engine');
  } finally {
    cleanup(root, before);
  }
});

test('a failure part way through restores everything', () => {
  const root = fixture();
  const before = snapshot(root);
  try {
    const blocked = path.join(root, 'blocker');
    fs.writeFileSync(blocked, 'a file, so nothing can go inside it');
    assert.throws(() => apply(NEW, { root, testFailure: { file: path.join(blocked, 'child'), data: 'x', previous: null } }), /public\/ is back as it was/);
    assertSame(before, root);
  } finally {
    cleanup(root, before);
  }
});

test('a failed stage is refused', () => {
  const root = fixture({ outcome: 'failed' });
  const before = snapshot(root);
  try {
    assert.throws(() => apply(NEW, { root }), /failed its checks/);
    assertSame(before, root);
  } finally {
    cleanup(root, before);
  }
});

test('a partial stage needs a flag', () => {
  const root = fixture({ outcome: 'partial' });
  try {
    assert.throws(() => apply(NEW, { root }), /--allow-partial/);
    assert.deepEqual(apply(NEW, { root, allowPartial: true }).to, NEW);
  } finally {
    cleanup(root);
  }
});

test('a changed stage engine is refused', () => {
  const root = fixture();
  try {
    write(root, `.cache/engine-update/${NEW}/public/engine/WebClient.wasm`, 'edited by hand');
    assert.throws(() => apply(NEW, { root }), /no longer matches its plan/);
  } finally {
    cleanup(root);
  }
});

test('a missing stage is explained', () => {
  const root = fixture();
  try {
    assert.throws(() => apply('version-none', { root }), /no stage for version-none/);
  } finally {
    cleanup(root);
  }
});

test('a config file it cannot update stops the install', () => {
  const root = fixture();
  const before = snapshot(root);
  try {
    write(root, 'server/config.js', 'const ENGINE_VERSION = 1;\n');
    const edited = snapshot(root);
    assert.throws(() => apply(NEW, { root }), /expected one match/);
    assertSame(edited, root);
    cleanup(edited);
  } finally {
    cleanup(root, before);
  }
});
