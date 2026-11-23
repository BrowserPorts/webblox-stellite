'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Pin = require('../pin');
const Channels = require('../channels');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flagguard-pin-'));
}

test('a pin leaves out staged rollouts, sorts keys and keeps only experiment values', () => {
  const pin = Pin.makePin({
    engine: 'version-abc',
    settings: { FFlagB: 'True', FFlagA: 'False', FFlagC_Staged: 'True;SteadyState', FIntD: 5 },
    ixp: { FFlagA_IXPValue: 'true;1', junk: 'x', FFlagE_IXPValue: 3 },
    now: new Date('2026-01-02T03:04:05Z'),
  });
  assert.deepEqual(Object.keys(pin.applicationSettings), ['FFlagA', 'FFlagB', 'FIntD']);
  assert.equal(pin.applicationSettings.FIntD, '5');
  assert.deepEqual(pin.removed, { FFlagC_Staged: 'True;SteadyState' });
  assert.deepEqual(pin.ixp, { FFlagA_IXPValue: 'true;1' });
  assert.equal(pin.pinnedAt, '2026-01-02T03:04:05.000Z');
});

test('pins round trip with one key per line', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'PinnedFlags.json');
    const pin = Pin.makePin({ engine: 'version-abc', settings: { FFlagA: 'True', FFlagB: 'a "quoted" value' }, ixp: {} });
    Pin.writePin(file, pin);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\n {4}"FFlagA": "True",\n {4}"FFlagB": "a \\"quoted\\" value"\n/);
    assert.match(text, /"ixp": \{\}/);
    assert.deepEqual(Pin.readPin(file), JSON.parse(text));
    assert.equal(Pin.serialize(Pin.readPin(file)), text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('broken pins are refused with a reason', () => {
  assert.deepEqual(Pin.validate({ format: 1, engine: 'version-a', applicationSettings: {} }), []);
  assert.match(Pin.validate({ format: 2, engine: 'nope', applicationSettings: [] }).join('; '), /format 2.*no engine version.*no applicationSettings/);
  assert.match(Pin.validate({ format: 1, engine: 'version-a', applicationSettings: { A: 1 } }).join(), /not strings/);
  const dir = tempDir();
  try {
    assert.throws(() => Pin.writePin(path.join(dir, 'x.json'), { format: 1 }), /broken flag set/);
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ format: 1 }));
    assert.throws(() => Pin.readPin(path.join(dir, 'bad.json')), /not a valid flag set/);
    assert.equal(Pin.readPin(path.join(dir, 'missing.json')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('withChanges sets and removes keys and restamps the pin', () => {
  const pin = Pin.makePin({ engine: 'version-a', settings: { A: '1', B: '2' }, now: new Date(0) });
  const next = Pin.withChanges(pin, { settings: { A: null, C: '3' }, ixp: { X_IXPValue: 'true' } }, { now: new Date(1000), note: 'hand edit' });
  assert.deepEqual(next.applicationSettings, { B: '2', C: '3' });
  assert.deepEqual(next.ixp, { X_IXPValue: 'true' });
  assert.equal(next.pinnedAt, new Date(1000).toISOString());
  assert.equal(next.source.note, 'hand edit');
  assert.deepEqual(pin.applicationSettings, { A: '1', B: '2' });
});

test('set names are checked', () => {
  assert.match(Pin.setPath('/cache', 'parity'), /sets[\\/]parity\.json$/);
  assert.throws(() => Pin.setPath('/cache', '../escape'), /not a valid set name/);
  assert.throws(() => Pin.setPath('/cache', 'UPPER'), /not a valid set name/);
});

function fakeFetch(responses) {
  const calls = [];
  const impl = async url => {
    calls.push(url);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { ok: next.status === 200, status: next.status, json: async () => next.body };
  };
  return { impl, calls };
}

test('channel fetches retry and refuse small or broken answers', async () => {
  const big = Object.fromEntries(Array.from({ length: 5 }, (item, index) => [`FFlag${index}`, 'True']));
  const ok = fakeFetch([new Error('offline'), { status: 500, body: {} }, { status: 200, body: { applicationSettings: big } }]);
  assert.deepEqual(await Channels.fetchChannel('WebClientApp', { fetchImpl: ok.impl, minEntries: 5 }), big);
  assert.equal(ok.calls.length, 3);
  assert.match(ok.calls[0], /\/v2\/settings\/application\/WebClientApp$/);
  const small = fakeFetch([{ status: 200, body: { applicationSettings: { A: '1' } } }]);
  await assert.rejects(Channels.fetchChannel('WebClientApp', { fetchImpl: small.impl, retries: 1, minEntries: 5 }), /only 1 entries/);
  const broken = fakeFetch([{ status: 200, body: { nope: true } }]);
  await assert.rejects(Channels.fetchChannel('WebClientApp', { fetchImpl: broken.impl, retries: 1 }), /no applicationSettings/);
});

test('snapshots record what changed between fetches', () => {
  const dir = tempDir();
  try {
    assert.equal(Channels.recordSnapshot(dir, 'WebClientApp', { A: '1', B: '2' }, new Date(0)), null);
    const record = Channels.recordSnapshot(dir, 'WebClientApp', { A: '1', B: '3', C: '4' }, new Date(1000));
    assert.deepEqual(record.added, { C: '4' });
    assert.deepEqual(record.changed, { B: ['2', '3'] });
    assert.deepEqual(record.removed, {});
    assert.equal(Channels.recordSnapshot(dir, 'WebClientApp', { A: '1', B: '3', C: '4' }, new Date(2000)), null);
    Channels.recordSnapshot(dir, 'WebClientApp', { A: '1' }, new Date(3000));
    const history = Channels.readHistory(dir);
    assert.equal(history.length, 2);
    assert.deepEqual(history[1].removed, { B: '3', C: '4' });
    assert.equal(Channels.readSnapshot(dir, 'WebClientApp').fetchedAt, new Date(3000).toISOString());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
