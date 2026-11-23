'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WasmModule, uleb } = require('../wasm/module');
const { MemoryImage } = require('../wasm/image');
const { FunctionFeatures, SharedTables } = require('../match/features');
const { FunctionInference } = require('../match/infer');
const { AddressResolver } = require('../match/addresses');
const { buildModule, code, I32 } = require('./build');

const store = offset => [0x36, 2, ...uleb(offset)];
const TYPES = [{}, { params: [I32], results: [I32] }, { params: [I32, I32] }];

function features(buffer, shared) {
  const module = new WasmModule(buffer);
  return new FunctionFeatures(module, new MemoryImage(module), shared);
}

function identityAlignment(oldDecoded, newDecoded) {
  return {
    exact: new Uint8Array(oldDecoded.length).fill(1),
    newIndexFor: index => (index >= 0 && index < oldDecoded.length && index < newDecoded.length ? index : -1),
  };
}

function setup(oldSpec, newSpec, pairs) {
  const shared = new SharedTables();
  const from = features(buildModule(oldSpec), shared);
  const to = features(buildModule(newSpec), shared);
  const map = new Int32Array(from.total).fill(-1);
  const reverse = new Int32Array(to.total).fill(-1);
  for (const [a, b] of pairs) {
    map[a] = b;
    reverse[b] = a;
  }
  const matcher = { from, to, map, reverse, how: new Uint8Array(from.total), similarity: () => 0.9, addresses: { get: () => -1, best: new Map() } };
  const alignmentFor = (func, target) => {
    const oldDecoded = from.module.decode(func);
    const newDecoded = to.module.decode(target);
    return { alignment: identityAlignment(oldDecoded, newDecoded), oldDecoded, newDecoded };
  };
  return { from, to, matcher, alignmentFor, inference: new FunctionInference({ matcher, alignmentFor }) };
}

test('a helper with no match follows the calls of its matched callers', () => {
  const caller = [...code.get(0), ...code.call(1), ...code.drop, ...code.get(0), ...code.call(1), ...code.drop];
  const oldSpec = { types: TYPES, functions: [{ type: 1, code: [...caller, ...code.get(0)] }, { type: 1, code: [...code.get(0), ...code.i32(1), ...code.add] }] };
  const newSpec = { types: TYPES, functions: [{ type: 1, code: [...caller, ...code.get(0)] }, { type: 1, code: [...code.get(0), ...code.i32(2), ...code.add] }] };
  const { inference } = setup(oldSpec, newSpec, [[0, 0]]);
  const result = inference.resolve(1);
  assert.equal(result.value, 1);
  assert.equal(result.how, 'call sites');
});

test('store effects ignore instruction order and catch a weak match that does different stores', () => {
  const move = [...code.get(0), ...code.get(1), ...code.load(0), ...store(0), ...code.get(0), ...code.get(1), ...code.load(4), ...store(4), ...code.get(1), ...code.i32(0), ...store(4)];
  const reordered = [...code.get(0), ...code.get(1), ...code.load(4), ...store(4), ...code.get(1), ...code.i32(0), ...store(4), ...code.get(0), ...code.get(1), ...code.load(0), ...store(0)];
  const other = [...code.get(0), ...code.get(1), ...code.load(8), ...store(8)];
  const oldSpec = { types: TYPES, functions: [{ type: 2, code: move }] };
  const newSpec = { types: TYPES, functions: [{ type: 2, code: other }, { type: 2, code: reordered }] };
  const { inference } = setup(oldSpec, newSpec, []);
  assert.equal(inference.effectsOf(inference.from, 0), inference.effectsOf(inference.to, 1));
  assert.notEqual(inference.effectsOf(inference.from, 0), inference.effectsOf(inference.to, 0));
  const verdict = inference.reconsider(0, 0);
  assert.equal(verdict.keep, false);
  assert.equal(verdict.value, 1);
  assert.match(inference.confirm(0, 1), /store effects/);
});

test('an address the compiler moved to another statement is found by how the code uses it', () => {
  const OLD_OBJECT = 300000;
  const OLD_POINTER = 300100;
  const NEW_OBJECT = 310000;
  const NEW_POINTER = 310200;
  const oldCode = [...code.i32(OLD_POINTER), ...code.i32(OLD_OBJECT), ...store(0), ...code.i32(OLD_OBJECT), ...code.i32(7), ...store(0), ...code.i32(OLD_OBJECT), ...code.call(1), ...code.drop];
  const newCode = [...code.i32(NEW_OBJECT), ...code.i32(7), ...store(0), ...code.i32(NEW_POINTER), ...code.i32(NEW_OBJECT), ...store(0), ...code.i32(NEW_OBJECT), ...code.call(1), ...code.drop];
  const spec = body => ({ types: TYPES, memoryPages: 8, globals: [400000], data: [{ offset: 1024, bytes: [1, 2, 3, 4] }], functions: [{ type: 0, code: body }, { type: 1, code: code.get(0) }] });
  const { matcher, alignmentFor } = setup(spec(oldCode), spec(newCode), [[0, 0], [1, 1]]);
  const resolver = new AddressResolver(matcher, alignmentFor);
  assert.equal(resolver.byRole(OLD_OBJECT).value, NEW_OBJECT);
  assert.equal(resolver.byRole(OLD_POINTER).value, NEW_POINTER);
});
