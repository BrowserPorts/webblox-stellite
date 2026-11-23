'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { portOverrides } = require('../port');

const entry = (name, type, version = null) => ({ name, type, version, default: false, address: 1 });

test('overrides follow a flag to its new version and report the ones that are gone', () => {
  const oldTable = { keys: { FFlagUIGpuGradient12: entry('UIGpuGradient', 'Flag', 12), FIntSame: entry('Same', 'Int'), DFFlagGone: entry('Gone', 'Flag'), FFlagWasF: entry('WasF', 'Flag') } };
  const newTable = { keys: { FFlagUIGpuGradient13: entry('UIGpuGradient', 'Flag', 13), FIntSame: entry('Same', 'Int'), DFFlagWasF: entry('WasF', 'Flag') } };
  const port = portOverrides({ FFlagUIGpuGradient12: 'False', FIntSame: '5', DFFlagGone: 'True', FFlagWasF: 'True', FFlagLuaOnly: 'True' }, oldTable, newTable);
  assert.deepEqual(port.flags, { FFlagUIGpuGradient13: 'False', FIntSame: '5', DFFlagGone: 'True', FFlagWasF: 'True', FFlagLuaOnly: 'True' });
  assert.deepEqual(port.renamed, [{ from: 'FFlagUIGpuGradient12', to: 'FFlagUIGpuGradient13' }]);
  assert.deepEqual(port.lost, ['DFFlagGone', 'FFlagWasF']);
  assert.deepEqual(port.unchecked, ['FFlagLuaOnly']);
});

test('an ambiguous successor is not guessed', () => {
  const oldTable = { keys: { FFlagThing2: entry('Thing', 'Flag', 2) } };
  const newTable = { keys: { FFlagThing3: entry('Thing', 'Flag', 3), FFlagThing4: { ...entry('Thing', 'Flag', 4) } } };
  const port = portOverrides({ FFlagThing2: 'True' }, oldTable, newTable);
  assert.deepEqual(port.renamed, []);
  assert.deepEqual(port.lost, ['FFlagThing2']);
});
