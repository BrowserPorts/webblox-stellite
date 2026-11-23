'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildEngine, FLAGS_AT, INTS_AT, LIST_AT } = require('./engine');
const Table = require('../table');
const { Machine } = require('../machine');
const { WasmModule } = require('../../autoport/wasm/module');
const { MemoryImage } = require('../../autoport/wasm/image');

const versionedNames = Array.from({ length: 60 }, (item, index) => `Ver${String(index).padStart(2, '0')}`);
const plainFlags = Array.from({ length: 24 }, (item, index) => ({ name: `PlainFlag${index}`, value: index % 3 === 0 }));
const dynamicFlags = [{ name: 'DynamicOne', value: true, kind: 2 }, { name: 'DynamicTwo', value: false, kind: 2 }];
const flags = [...plainFlags, ...dynamicFlags, ...versionedNames.map(name => ({ name, value: false }))];
const ints = Array.from({ length: 22 }, (item, index) => ({ name: `SomeLimit${index}`, value: 100 + index, kind: index === 0 ? 2 : 1 }));
const versioned = Object.fromEntries(versionedNames.map((name, index) => [name, 2 + (index % 4)]));
const luau = Array.from({ length: 10 }, (item, index) => ({ name: `LuauThing${index}`, value: index === 1, dynamic: index === 2 }));

const channel = {};
for (const flag of plainFlags) channel[`FFlag${flag.name}`] = 'True';
channel.DFFlagDynamicOne = 'False';
for (const name of versionedNames) channel[`FFlag${name}${versioned[name]}`] = 'True';
for (const entry of ints) channel[`${entry.kind === 2 ? 'DF' : 'F'}Int${entry.name}`] = '5';
for (const entry of luau.slice(0, 4)) channel[`${entry.dynamic ? 'DF' : 'F'}Flag${entry.name}`] = 'True';

const wasm = buildEngine({ flags, ints, versioned, luau });

test('the synthetic engine is valid wasm', () => {
  assert.equal(WebAssembly.validate(wasm), true);
});

test('registered flags resolve with their compiled defaults', () => {
  const table = Table.buildEngineTable(wasm, [channel]);
  assert.equal(table.keys.FFlagPlainFlag0.default, true);
  assert.equal(table.keys.FFlagPlainFlag1.default, false);
  assert.equal(table.keys.FFlagPlainFlag1.address, FLAGS_AT + 12);
  assert.equal(table.keys.DFFlagDynamicOne.default, true);
  assert.equal(table.keys.FFlagDynamicOne, undefined);
  assert.equal(table.keys.FIntSomeLimit3.default, 103);
  assert.equal(table.keys.FIntSomeLimit3.address, INTS_AT + 36);
  assert.equal(table.keys.DFIntSomeLimit0.default, 100);
  assert.equal(table.keys.FIntSomeLimit0, undefined);
});

test('versioned flags only answer to their versioned key', () => {
  const table = Table.buildEngineTable(wasm, [channel]);
  assert.ok(table.versionFunction !== null);
  assert.equal(table.versionedNames, versionedNames.length);
  assert.equal(table.unresolvedVersions, 0);
  assert.equal(table.keys.FFlagVer013.version, 3);
  assert.equal(table.keys.FFlagVer01, undefined);
  const full = { ...table, lua: {}, mentions: [] };
  assert.equal(Table.resolve(full, 'FFlagVer013').reader, 'engine');
  assert.equal(Table.resolve(full, 'FFlagVer01').reader, null);
  assert.equal(Table.resolve(full, 'FFlagVer012').reader, null);
});

test('the Luau value list is read by running the start-up code', () => {
  const table = Table.buildEngineTable(wasm, [channel]);
  assert.equal(table.listFlags, luau.length);
  assert.equal(table.keys.FFlagLuauThing0.list, true);
  assert.equal(table.keys.FFlagLuauThing0.address, LIST_AT);
  assert.equal(table.keys.FFlagLuauThing1.default, true);
  assert.equal(table.keys.DFFlagLuauThing2.default, false);
  assert.equal(table.keys.FFlagLuauThing2, undefined);
});

test('a healthy table has no problems, and a broken one says why', () => {
  const table = { ...Table.buildEngineTable(wasm, [channel]), lua: {}, mentions: [] };
  assert.equal(table.keys.FFlagPlainFlag0.type, 'Flag');
  const problems = Table.checkTable(table);
  assert.deepEqual(problems.filter(problem => !/Only \d+ engine flags/.test(problem)), []);
  assert.match(Table.checkTable({ ...table, keys: {}, versionFunction: null, listFlags: 0 }).join(' '), /registration code changed shape.*versioned keys.*Luau/);
});

test('keys split into prefix, name and scope', () => {
  assert.deepEqual(Table.splitKey('DFIntFooBar_PlaceFilter'), { prefix: 'DFInt', kind: 'DF', type: 'Int', name: 'FooBar', scope: 'PlaceFilter' });
  assert.deepEqual(Table.splitKey('FFlagX2'), { prefix: 'FFlag', kind: 'F', type: 'Flag', name: 'X2', scope: null });
  assert.equal(Table.splitKey('NotAFlag'), null);
  assert.equal(Table.baseKey('FFlagThing_IXP'), 'FFlagThing');
});

test('resolve sorts keys into engine, by name, Lua and nothing', () => {
  const table = {
    keys: { FFlagEngineOne: { name: 'EngineOne', type: 'Flag', version: null, default: false, address: 1 } },
    lua: { LuaOnly: { type: 'Flag', default: true } },
    mentions: ['Mentioned'],
    byName: ['LookedUp'],
  };
  assert.equal(Table.resolve(table, 'FFlagEngineOne').reader, 'engine');
  assert.equal(Table.resolve(table, 'FFlagEngineOne_PlaceFilter').reader, 'engine');
  assert.equal(Table.resolve(table, 'FFlagEngineOne_PlaceFilter').scope, 'PlaceFilter');
  assert.equal(Table.resolve(table, 'DFFlagLookedUp').reader, 'engine-name');
  assert.equal(Table.resolve(table, 'FFlagLuaOnly').reader, 'lua');
  assert.equal(Table.resolve(table, 'FFlagMentioned').reader, 'lua');
  assert.equal(Table.resolve(table, 'FFlagNobody').reader, null);
});

test('the table cache is keyed by the wasm hash', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'flagguard-cache-'));
  const engineDir = path.join(dir, 'engine');
  fs.mkdirSync(engineDir);
  fs.writeFileSync(path.join(engineDir, 'WebClient.wasm'), wasm);
  try {
    const messages = [];
    const first = Table.tableFor(engineDir, [channel], { cacheDir: path.join(dir, 'cache'), log: line => messages.push(line) });
    const second = Table.tableFor(engineDir, [channel], { cacheDir: path.join(dir, 'cache'), log: line => messages.push(line) });
    assert.equal(messages.length, 1);
    assert.equal(second.wasm, first.wasm);
    assert.deepEqual(Object.keys(second.keys).sort(), Object.keys(first.keys).sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the machine follows a std::string built on the stack into a call', () => {
  const module = new WasmModule(wasm);
  const image = new MemoryImage(module);
  const names = [];
  const machine = new Machine(module, image);
  const thunk = module.functionCount - 2;
  machine.run(thunk, [], { call: (callee, args, depth, active) => { names.push(active.memory.stdString(args[0]), args[1].value); return 'skip'; } });
  assert.deepEqual(names, [versionedNames[versionedNames.length - 1], versioned[versionedNames[versionedNames.length - 1]]]);
});
