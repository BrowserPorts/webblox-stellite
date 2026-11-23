'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { encodeForRoblox, COMPILE_FLAGS } = require('../../luau-bytecode');
const L = require('../luau/bytecode');
const { readModuleScripts } = require('../luau/rbxm');
const { portModels, portEdit, ModelSet } = require('../patches/models');

const HAS_COMPILER = !spawnSync('luau-compile', ['--help'], { stdio: 'ignore' }).error;
const skip = HAS_COMPILER ? false : 'luau-compile is not installed';
const WORD = 4;

function compile(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webblox-luau-'));
  try {
    const file = path.join(dir, 'script.luau');
    fs.writeFileSync(file, source);
    return encodeForRoblox(execFileSync('luau-compile', ['--binary', '-O2', '-g1', `--fflags=${COMPILE_FLAGS.join(',')}`, file], { stdio: ['ignore', 'pipe', 'pipe'] }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function chunk(name, body) {
  const head = Buffer.alloc(16);
  head.write(name, 0, 'latin1');
  head.writeUInt32LE(body.length, 8);
  return Buffer.concat([head, body]);
}

function strings(list) {
  return Buffer.concat(list.flatMap(item => {
    const bytes = Buffer.from(item);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    return [size, bytes];
  }));
}

function modelOf(scripts) {
  const names = Object.keys(scripts);
  const header = Buffer.alloc(32);
  header.write('<roblox!', 0, 'latin1');
  const className = Buffer.from('ModuleScript');
  const inst = Buffer.alloc(13 + className.length);
  inst.writeUInt32LE(0, 0);
  inst.writeUInt32LE(className.length, 4);
  className.copy(inst, 8);
  inst.writeUInt32LE(names.length, 9 + className.length);
  const prop = (name, values) => {
    const label = Buffer.from(name);
    const head = Buffer.alloc(9 + label.length);
    head.writeUInt32LE(0, 0);
    head.writeUInt32LE(label.length, 4);
    label.copy(head, 8);
    return Buffer.concat([head, strings(values)]);
  };
  return Buffer.concat([
    header,
    chunk('INST', inst),
    chunk('PROP', prop('Name', names)),
    chunk('PROP', prop('Source', names.map(name => scripts[name]))),
    chunk('END\0', Buffer.alloc(0)),
  ]);
}

const OLD_SCRIPT = `
local module = {}
local function pickTheme(settings, device)
  local name = settings.ThemeName
  if name == "the default theme name" then
    name = device.PreferredThemeForThisDevice
  end
  if settings.LockTheme then
    return "a locked theme name"
  end
  print("theme chosen for this session", name)
  return name
end
local function unrelated(value)
  print("an unrelated function with its own text", value)
  return value + 1
end
module.pickTheme = pickTheme
module.unrelated = unrelated
return module
`;

const NEW_SCRIPT = `
local module = {}
local first = "a brand new leading constant"
local function brandNew(a, b)
  print("a function that did not exist before", a, b, first)
  return a or b
end
local function pickTheme(settings, device)
  print("a new first line in this function")
  local name = settings.ThemeName
  if name == "the default theme name" then
    name = device.PreferredThemeForThisDevice
  end
  if settings.LockTheme then
    return "a locked theme name"
  end
  print("theme chosen for this session", name)
  return name
end
local function unrelated(value)
  print("an unrelated function with its own text", value)
  return value + 1
end
module.brandNew = brandNew
module.pickTheme = pickTheme
module.unrelated = unrelated
return module
`;

function fixture() {
  const oldSource = compile(OLD_SCRIPT);
  const newSource = compile(NEW_SCRIPT);
  const oldSet = new ModelSet({ Model: modelOf({ Theme: oldSource }) });
  const newSet = new ModelSet({ Model: modelOf({ Theme: newSource }) });
  const parse = source => L.parse(source);
  const oldModule = parse(oldSource);
  const newModule = parse(newSource);
  const proto = (module, name) => module.protos.find(entry => entry.debugName === name);
  return { oldSource, newSource, oldSet, newSet, oldModule, newModule, oldProto: proto(oldModule, 'pickTheme'), newProto: proto(newModule, 'pickTheme') };
}

function constantIndex(protoEntry, text) {
  return protoEntry.constants.findIndex(constant => constant.type === 'string' && constant.value === text);
}

function wordsAround(module, protoEntry, predicate, count) {
  const list = L.instructions(module, protoEntry);
  const index = list.findIndex(predicate);
  assert.ok(index >= 0, 'the test needs this instruction');
  const start = list[index].at;
  return { index, start, bytes: module.source.subarray(start, start + count * WORD), instruction: list[index] };
}

test('the fake model reads back', { skip }, () => {
  const source = compile('return 1');
  const { names, sources, count } = readModuleScripts(modelOf({ One: source }));
  assert.equal(count, 1);
  assert.deepEqual(names, ['One']);
  assert.ok(sources[0].equals(source));
});

test('the parser finds functions, constants and code', { skip }, () => {
  const { oldProto, oldModule } = fixture();
  assert.equal(oldProto.params, 2);
  assert.ok(constantIndex(oldProto, 'the default theme name') >= 0);
  assert.ok(L.instructions(oldModule, oldProto).length > 5);
});

test('a NOP edit follows its instruction into a function that grew', { skip }, () => {
  const { oldSet, newSet, oldModule, newModule, oldProto, newProto } = fixture();
  const loadk = wordsAround(oldModule, oldProto, item => item.op === L.OP.LOADK && item.d === constantIndex(oldProto, 'a locked theme name'), 2);
  const to = Buffer.from(loadk.bytes);
  to.writeUInt32LE(0, 0);
  to[0] = L.encodeOp(L.OP.NOP);
  const result = portEdit(oldSet, newSet, { from: loadk.bytes.toString('hex'), to: to.toString('hex') });
  assert.notEqual(result.status, 'failed', result.reason);
  assert.equal(result.status, 'moved');
  const expected = wordsAround(newModule, newProto, item => item.op === L.OP.LOADK && item.d === constantIndex(newProto, 'a locked theme name'), 2);
  assert.equal(result.from, expected.bytes.toString('hex'));
  const nextTo = Buffer.from(result.to, 'hex');
  assert.equal(L.decodeOp(nextTo[0]), L.OP.NOP);
  assert.ok(nextTo.subarray(WORD).equals(expected.bytes.subarray(WORD)));
});

test('a LOADK edit finds the same constant at its new index', { skip }, () => {
  const { oldSet, newSet, oldModule, oldProto, newProto, newModule } = fixture();
  const original = wordsAround(oldModule, oldProto, item => item.op === L.OP.LOADK && item.d === constantIndex(oldProto, 'a locked theme name'), 1);
  const to = Buffer.from(original.bytes);
  to.writeInt16LE(constantIndex(oldProto, 'theme chosen for this session'), 2);
  const result = portEdit(oldSet, newSet, { from: original.bytes.toString('hex'), to: to.toString('hex') });
  assert.notEqual(result.status, 'failed', result.reason);
  const nextTo = Buffer.from(result.to, 'hex');
  assert.equal(L.decodeOp(nextTo[0]), L.OP.LOADK);
  assert.equal(nextTo.readInt16LE(2), constantIndex(newProto, 'theme chosen for this session'));
  assert.notEqual(constantIndex(newProto, 'theme chosen for this session'), constantIndex(oldProto, 'theme chosen for this session'));
  assert.ok(newModule.source.includes(Buffer.from(result.from, 'hex')));
});

test('a JUMP edit points at the same instruction after the code moved', { skip }, () => {
  const { oldSet, newSet, oldModule, newModule, oldProto, newProto } = fixture();
  const oldList = L.instructions(oldModule, oldProto);
  const newList = L.instructions(newModule, newProto);
  const targetOld = oldList.findIndex(item => item.op === L.OP.LOADK && item.d === constantIndex(oldProto, 'theme chosen for this session'));
  const targetNew = newList.findIndex(item => item.op === L.OP.LOADK && item.d === constantIndex(newProto, 'theme chosen for this session'));
  assert.ok(targetOld > 0 && targetNew > 0);
  const edited = wordsAround(oldModule, oldProto, item => item.op === L.OP.LOADK && item.d === constantIndex(oldProto, 'a locked theme name'), 1);
  const to = Buffer.alloc(WORD);
  to[0] = L.encodeOp(L.OP.JUMP);
  to.writeInt16LE(oldList[targetOld].pc - (edited.instruction.pc + 1), 2);
  const result = portEdit(oldSet, newSet, { from: edited.bytes.toString('hex'), to: to.toString('hex') });
  assert.notEqual(result.status, 'failed', result.reason);
  const nextTo = Buffer.from(result.to, 'hex');
  const newEdited = wordsAround(newModule, newProto, item => item.op === L.OP.LOADK && item.d === constantIndex(newProto, 'a locked theme name'), 1);
  assert.equal(newEdited.instruction.pc + 1 + nextTo.readInt16LE(2), newList[targetNew].pc);
});

test('an edit the old model does not hold fails', { skip }, () => {
  const { oldSet, newSet } = fixture();
  assert.match(portEdit(oldSet, newSet, { from: 'deadbeefdeadbeef', to: 'deadbeefdeadbeef' }).reason, /does not contain this edit/);
});

test('an edit in a function that vanished fails instead of guessing', { skip }, () => {
  const { oldSet, oldModule, oldProto } = fixture();
  const gone = new ModelSet({ Model: modelOf({ Other: compile('print("something else entirely, with long text")\nreturn 1') }) });
  const words = wordsAround(oldModule, oldProto, item => item.op === L.OP.LOADK && item.d === constantIndex(oldProto, 'a locked theme name'), 1);
  const result = portEdit(oldSet, gone, { from: words.bytes.toString('hex'), to: words.bytes.toString('hex') });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /no function in the new model matches/);
});

test('an edit whose text now appears twice fails', { skip }, () => {
  const { oldSet, oldModule, oldProto } = fixture();
  const twice = new ModelSet({ Model: modelOf({ Theme: compile(OLD_SCRIPT), Copy: compile(OLD_SCRIPT) }) });
  const words = wordsAround(oldModule, oldProto, item => item.op === L.OP.LOADK && item.d === constantIndex(oldProto, 'a locked theme name'), 2);
  const result = portEdit(oldSet, twice, { from: words.bytes.toString('hex'), to: words.bytes.toString('hex') });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /2 places/);
});

test('portModels reports each edit and missing pieces', { skip }, () => {
  const { oldSource, newSource, oldModule, oldProto } = fixture();
  const words = wordsAround(oldModule, oldProto, item => item.op === L.OP.LOADK && item.d === constantIndex(oldProto, 'a locked theme name'), 2);
  const to = Buffer.from(words.bytes);
  to.writeUInt32LE(0, 0);
  to[0] = L.encodeOp(L.OP.NOP);
  const profile = {
    wordmarkInsets: [],
    bytecodeEdits: [{ title: 'Skip the lock', from: words.bytes.toString('hex'), to: to.toString('hex') }, { title: 'Gone already', from: 'deadbeef', to: 'deadbeef' }],
    scriptReplacements: { Theme: 'Replacement', Missing: 'Replacement' },
    settingsAnchors: ['ThemeName', 'NotAnywhereAtAll'],
    bytecodeVersion: L.parse(newSource).version,
  };
  const { next, results } = portModels({ oldModels: { InExperience: modelOf({ Theme: oldSource }) }, newModels: { InExperience: modelOf({ Theme: newSource }) }, profile, bundles: null });
  const byId = id => results.find(result => result.id === id);
  assert.equal(byId('wordmark').status, 'failed');
  assert.equal(byId('wordmark').required, false);
  assert.equal(byId('bytecode-0').status, 'moved');
  assert.equal(byId('bytecode-1').status, 'failed');
  assert.equal(byId('script-Theme').status, 'ported');
  assert.equal(byId('script-Missing').status, 'failed');
  assert.equal(byId('script-Missing').required, true);
  assert.equal(byId('anchor-NotAnywhereAtAll').status, 'failed');
  assert.equal(byId('anchor-ThemeName'), undefined);
  assert.equal(next.bytecodeEdits.length, 1);
  assert.equal(next.bytecodeEdits[0].title, 'Skip the lock');
  assert.equal(next.rectEdits, undefined);
  assert.equal(next.bytecodeVersion, profile.bytecodeVersion);
});

test('a newer bytecode version is reported', { skip }, () => {
  const { oldSource, newSource } = fixture();
  const version = L.parse(newSource).version;
  const profile = { wordmarkInsets: [], bytecodeEdits: [], scriptReplacements: {}, settingsAnchors: [], bytecodeVersion: version - 1 };
  const { results } = portModels({ oldModels: { InExperience: modelOf({ Theme: oldSource }) }, newModels: { InExperience: modelOf({ Theme: newSource }) }, profile, bundles: null });
  assert.equal(results.find(result => result.id === 'bytecode-version').status, 'failed');
});
