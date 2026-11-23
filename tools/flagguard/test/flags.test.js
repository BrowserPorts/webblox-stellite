'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Flags = require('../flags');
const Bisect = require('../bisect');
const Parity = require('../parity');
const Report = require('../report');
const { statusLine, parseArgs } = require('../cli');

const table = {
  keys: {
    FFlagRenderThing: { name: 'RenderThing', type: 'Flag', version: null, default: false, address: 8 },
    FFlagPhysicsFix2: { name: 'PhysicsFix', type: 'Flag', version: 2, default: false, address: 12 },
    FIntTextureBudget: { name: 'TextureBudget', type: 'Int', version: null, default: 256, address: 16 },
    DFIntTelemetryHundredthsPercent: { name: 'TelemetryHundredthsPercent', type: 'Int', version: null, default: 0, address: 20 },
    FFlagOverridden: { name: 'Overridden', type: 'Flag', version: null, default: false, address: 24 },
  },
  lua: { LuaFeature: { type: 'Flag', default: true }, LuaNoDefault: { type: null, default: null } },
  mentions: [],
  byName: ['NamedGate'],
};

const set = (applicationSettings, ixp = {}) => ({ applicationSettings, ixp });

test('values parse by type', () => {
  assert.equal(Flags.parseValue('Flag', 'True'), true);
  assert.equal(Flags.parseValue('Flag', 'false'), false);
  assert.equal(Flags.parseValue('Flag', 'True;123;456'), true);
  assert.equal(Flags.parseValue('Flag', 'yes'), null);
  assert.equal(Flags.parseValue('Int', '9999999999'), '9999999999');
  assert.equal(Flags.parseValue('Int', 'abc'), null);
  assert.equal(Flags.parseValue('String', 'a;b'), 'a;b');
});

test('the effective value prefers experiments, then staged rollouts, then the set, then the default', () => {
  assert.equal(Flags.effective(table, set({}), 'FFlagRenderThing').value, false);
  assert.equal(Flags.effective(table, set({ FFlagRenderThing: 'True' }), 'FFlagRenderThing').value, true);
  assert.equal(Flags.effective(table, set({ FFlagRenderThing: 'True', FFlagRenderThing_Staged: 'False;SteadyState' }), 'FFlagRenderThing').source, 'staged');
  const experiment = Flags.effective(table, set({ FFlagRenderThing: 'True' }, { FFlagRenderThing_IXPValue: 'false;1;Layer' }), 'FFlagRenderThing');
  assert.equal(experiment.value, false);
  assert.equal(experiment.source, 'experiment');
  const unreadable = Flags.effective(table, set({ FFlagRenderThing: 'maybe' }), 'FFlagRenderThing');
  assert.equal(unreadable.value, false);
  assert.equal(unreadable.source, 'unreadable');
  assert.equal(Flags.effective(table, set({}), 'FIntTextureBudget').value, '256');
  assert.equal(Flags.effective(table, set({}), 'FFlagLuaFeature').value, true);
});

test('changes are classified by what they do to this build', () => {
  const before = set({ FFlagRenderThing: 'False', FIntTextureBudget: '256', FFlagUnknownToBuild: 'False', FFlagOverridden: 'False' });
  const after = set({
    FFlagRenderThing: 'True',
    FIntTextureBudget: '256',
    FFlagUnknownToBuild: 'True',
    FFlagPhysicsFix: 'True',
    FFlagPhysicsFix2: 'False',
    FFlagOverridden: 'True',
    FFlagRenderThing_PlaceFilter: 'True;1;2',
    FFlagRenderThing_IXP: '1;Layer;Param;1;flagbank',
    FIntTextureBudget_Staged: '512;SteadyState;10',
    DFFlagNamedGate: 'True',
    FFlagLuaNoDefault: 'True',
  });
  const changes = Flags.compareSets(table, before, after, { overrides: { FFlagOverridden: 'True' } });
  const effect = key => changes.find(change => change.key === key).effect;
  assert.equal(effect('FFlagRenderThing'), 'changes');
  assert.equal(effect('FFlagUnknownToBuild'), 'dead');
  assert.equal(effect('FFlagPhysicsFix'), 'dead');
  assert.equal(effect('FFlagPhysicsFix2'), 'none');
  assert.equal(effect('FFlagOverridden'), 'overridden');
  assert.equal(effect('FFlagRenderThing_PlaceFilter'), 'scoped');
  assert.equal(effect('FFlagRenderThing_IXP'), 'experiment');
  assert.equal(effect('FIntTextureBudget_Staged'), 'staged');
  assert.equal(effect('DFFlagNamedGate'), 'unknown');
  assert.equal(effect('FFlagLuaNoDefault'), 'unknown');
  assert.equal(changes.some(change => change.key === 'FIntTextureBudget'), false);
});

test('experiment value changes show up under the flag they set', () => {
  const changes = Flags.compareSets(table, set({}, { FFlagRenderThing_IXPValue: 'false;1' }), set({}, { FFlagRenderThing_IXPValue: 'true;1' }));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].flag, 'FFlagRenderThing');
  assert.equal(changes[0].experiment, true);
  assert.equal(changes[0].effect, 'changes');
});

test('the summary separates telemetry from real changes', () => {
  const changes = Flags.compareSets(table, set({}), set({ FFlagRenderThing: 'True', DFIntTelemetryHundredthsPercent: '100' }));
  const groups = Report.summarize(changes);
  assert.deepEqual(groups.changes.map(change => change.key), ['FFlagRenderThing']);
  assert.deepEqual(groups.noisy.map(change => change.key), ['DFIntTelemetryHundredthsPercent']);
  const lines = [];
  Report.printChanges(changes, line => lines.push(line));
  assert.match(lines.join('\n'), /1 of them change what this build does/);
  assert.match(lines.join('\n'), /FFlagRenderThing\s+false -> true/);
  assert.match(lines.join('\n'), /1 telemetry, logging, bookkeeping or other-platform flags/);
  assert.match(Report.renderChanges('Title', ['intro'], changes), /## Changes what this build does \(1\)/);
});

function runBisect(count, isBad) {
  const changes = Array.from({ length: count }, (item, index) => ({ key: `FFlagChange${index}`, value: 'True', ixp: false }));
  const state = Bisect.startBisect({ good: 'pinned', bad: 'live', changes, base: set({}) });
  let tests = 0;
  while (!state.result) {
    const indices = Bisect.candidate(state);
    Bisect.answer(state, isBad(new Set(indices)) ? 'bad' : 'good');
    tests++;
    if (tests > 200) throw new Error('the bisect did not finish');
  }
  return { result: state.result.slice().sort((a, b) => a - b), tests };
}

test('bisect finds one bad change in about log2 steps', () => {
  for (const culprit of [0, 17, 63, 99]) {
    const { result, tests } = runBisect(100, indices => indices.has(culprit));
    assert.deepEqual(result, [culprit]);
    assert.ok(tests <= 2 * Math.ceil(Math.log2(100)), `${tests} tests`);
  }
});

test('bisect finds two changes that only break things together', () => {
  const { result } = runBisect(40, indices => indices.has(3) && indices.has(31));
  assert.deepEqual(result, [3, 31]);
});

test('bisect treats skipped sets as not bad and still finishes', () => {
  const changes = Array.from({ length: 8 }, (item, index) => ({ key: `K${index}`, value: 'True' }));
  const state = Bisect.startBisect({ good: 'a', bad: 'b', changes, base: set({}) });
  let first = true;
  while (!state.result) {
    const indices = new Set(Bisect.candidate(state));
    if (first) {
      Bisect.answer(state, 'skip');
      first = false;
    } else {
      Bisect.answer(state, indices.has(5) ? 'bad' : 'good');
    }
  }
  assert.deepEqual(state.result, [5]);
  assert.throws(() => Bisect.answer(state, 'bad'), /already finished/);
  assert.throws(() => Bisect.answer(Bisect.startBisect({ good: 'a', bad: 'b', changes, base: set({}) }), 'maybe'), /good, bad or skip/);
});

test('a single change needs no test, and applying changes adds and removes keys', () => {
  const state = Bisect.startBisect({ good: 'a', bad: 'b', changes: [{ key: 'Only', value: 'True' }], base: set({}) });
  assert.deepEqual(state.result, [0]);
  const applied = Bisect.applyChanges(set({ Keep: '1', Drop: '2' }, { Old_IXPValue: 'x' }), [{ key: 'Drop', value: null }, { key: 'Add', value: '3' }, { key: 'New_IXPValue', value: 'y', ixp: true }], [0, 1, 2]);
  assert.deepEqual(applied.applicationSettings, { Keep: '1', Add: '3' });
  assert.deepEqual(applied.ixp, { Old_IXPValue: 'x', New_IXPValue: 'y' });
});

test('parity rows keep flags where Mac and PC agree and web differs', () => {
  const channels = {
    web: { FFlagRenderThing: 'False', FIntTextureBudget: '256' },
    mac: { FFlagRenderThing: 'True', FIntTextureBudget: '512', FFlagPhysicsFix2: 'True' },
    pc: { FFlagRenderThing: 'True', FIntTextureBudget: '128', FFlagPhysicsFix2: 'True' },
  };
  const rows = Parity.parityRows(table, channels, { overrides: {} });
  assert.deepEqual(rows.map(row => row.key).sort(), ['FFlagPhysicsFix2', 'FFlagRenderThing']);
  const decisions = { adopt: { FFlagRenderThing: { value: 'True', why: 'fix' } }, keep: { FFlagPhysicsFix2: 'reason' } };
  const groups = Parity.classifyRows(rows, decisions);
  assert.equal(groups.adopted.length, 1);
  assert.equal(groups.kept.length, 1);
  assert.deepEqual(Parity.adoptedSettings(decisions), { FFlagRenderThing: 'True' });
  assert.deepEqual(Parity.staleDecisions(table, rows, decisions), []);
  assert.match(Parity.staleDecisions(table, [], decisions)[0], /now matches desktop/);
  assert.match(Parity.staleDecisions(table, rows, { adopt: { FFlagRenderThing: { value: 'False' } } })[0], /desktop now uses true/);
});

test('the hourly check prints only when something changed', () => {
  const quiet = { engine: 'version-a', pinEngine: 'version-a', pinnedAt: new Date().toISOString(), changes: [], staged: [], unknown: [] };
  assert.equal(statusLine(quiet, quiet), null);
  assert.match(statusLine({ ...quiet, changes: ['FFlagA'] }, quiet), /Roblox changed 1 flags this build reads \(FFlagA\)/);
  assert.equal(statusLine({ ...quiet, changes: ['FFlagA'] }, { ...quiet, changes: ['FFlagA'] }), null);
  assert.match(statusLine(quiet, { ...quiet, changes: ['FFlagA'] }), /match the pin/);
  assert.match(statusLine({ ...quiet, pinEngine: 'version-b' }, quiet), /for version-b/);
  assert.match(statusLine({ ...quiet, error: 'offline' }, quiet), /Could not check/);
  assert.equal(statusLine({ ...quiet, error: 'offline' }, { error: 'offline' }), null);
});

test('arguments parse into a command, values and switches', () => {
  assert.deepEqual(parseArgs(['test', '--set', 'live', '--all']), { _: ['test'], set: 'live', all: true });
  assert.throws(() => parseArgs(['test', '--set']), /needs a value/);
});
