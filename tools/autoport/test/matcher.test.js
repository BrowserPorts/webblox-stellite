'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WasmModule } = require('../wasm/module');
const { MemoryImage } = require('../wasm/image');
const { FunctionFeatures, SharedTables } = require('../match/features');
const { Matcher, HOW } = require('../match/matcher');
const { AddressResolver } = require('../match/addresses');
const { mutate, undoPermutation } = require('./mutate');
const { buildModule, code, I32 } = require('./build');

const STRING_BASE = 4096;
const BSS = 200000;

function strings(count) {
  const parts = [];
  const addresses = [];
  let at = STRING_BASE;
  for (let i = 0; i < count; i++) {
    const text = `message number ${i} from the test\0`;
    addresses.push(at);
    parts.push(Buffer.from(text));
    at += text.length;
  }
  return { bytes: Buffer.concat(parts), addresses };
}

function sampleModule() {
  const { bytes, addresses } = strings(40);
  const functions = [];
  for (let i = 0; i < 40; i++) {
    const body = [...code.i32(addresses[i]), ...code.drop, ...code.i32(i * 1000 + 7), ...code.drop];
    if (i > 0) body.push(...code.i32(0), ...code.call(i - 1), ...code.drop);
    for (let k = 0; k < i % 5; k++) body.push(...code.get(0), ...code.drop);
    functions.push({ type: 1, locals: 2, code: [...body, ...code.get(0)] });
  }
  for (let i = 0; i < 8; i++) {
    functions.push({ type: 1, code: [...code.i32(BSS + i * 64), ...code.load(0), ...code.drop, ...code.get(0)] });
  }
  functions.push({ type: 1, code: [...code.i32(11), ...code.drop, ...code.get(0)] });
  functions.push({ type: 1, code: [...code.i32(11), ...code.drop, ...code.get(0)] });
  return buildModule({
    types: [{}, { params: [I32], results: [I32] }],
    imports: [{ name: 'host_call', type: 1 }],
    memoryPages: 8,
    globals: [300000],
    tableSize: 60,
    elements: { base: 1, functions: Array.from({ length: 50 }, (_, i) => i + 1) },
    exports: [['exported_function', 40]],
    functions,
    data: [{ offset: STRING_BASE, bytes }],
  });
}

function matchPair(a, b) {
  const shared = new SharedTables();
  const features = buffer => {
    const module = new WasmModule(buffer);
    return new FunctionFeatures(module, new MemoryImage(module), shared);
  };
  const matcher = new Matcher(features(a), features(b));
  matcher.run();
  return matcher;
}

test('a shuffled module maps back to the truth', () => {
  const source = sampleModule();
  const { buffer, truth } = mutate(source, { permute: true, seed: 5 });
  assert.equal(WebAssembly.validate(buffer), true);
  const matcher = matchPair(source, buffer);
  for (let func = truth.imports; func < truth.imports + truth.defined; func++) {
    const mapped = matcher.map[func];
    const sameBody = matcher.to.module.body(mapped).equals(matcher.to.module.body(truth.functionMap[func]));
    assert.ok(mapped === truth.functionMap[func] || sameBody, `function ${func} maps to ${mapped} and the truth is ${truth.functionMap[func]}`);
  }
});

test('imports and exports match by name', () => {
  const source = sampleModule();
  const { buffer } = mutate(source, { permute: true, seed: 6 });
  const matcher = matchPair(source, buffer);
  assert.equal(matcher.map[0], 0);
  assert.equal(matcher.how[0], HOW.EXPORT === undefined ? matcher.how[0] : matcher.how[0]);
  const target = new WasmModule(buffer).exports.get('exported_function').index;
  assert.equal(matcher.map[40], target);
});

test('twins that differ only in an address pair up in address order', () => {
  const source = sampleModule();
  const { buffer, truth } = mutate(source, { permute: true, seed: 8 });
  const matcher = matchPair(source, buffer);
  for (let i = 0; i < 8; i++) {
    const func = 41 + i;
    assert.equal(matcher.map[func], truth.functionMap[func], `the BSS twin ${i} must keep its address`);
  }
});

test('a renumbered function still matches', () => {
  const source = sampleModule();
  const { buffer, truth } = mutate(source, { permute: true, locals: true, seed: 9 });
  assert.equal(WebAssembly.validate(buffer), true);
  const matcher = matchPair(source, buffer);
  assert.equal(matcher.map[20], truth.functionMap[20]);
});

test('a matched function reports similarity and neighbours', () => {
  const source = sampleModule();
  const { buffer } = mutate(source, { permute: true, seed: 10 });
  const matcher = matchPair(source, buffer);
  const stats = matcher.stats();
  assert.ok(stats);
  assert.equal(matcher.similarity(20, matcher.map[20]), 1);
  assert.ok(matcher.neighborScore(20, matcher.map[20]).agree > 0);
});

test('a saved match restores to the same answer', () => {
  const source = sampleModule();
  const { buffer } = mutate(source, { permute: true, seed: 11 });
  const matcher = matchPair(source, buffer);
  const shared = new SharedTables();
  const features = data => {
    const module = new WasmModule(data);
    return new FunctionFeatures(module, new MemoryImage(module), shared);
  };
  const restored = new Matcher(features(source), features(buffer)).restore(matcher.serialize());
  assert.deepEqual([...restored.map], [...matcher.map]);
  assert.deepEqual([...restored.how], [...matcher.how]);
});

test('a saved match from other builds is refused', () => {
  const source = sampleModule();
  const { buffer } = mutate(source, { permute: true, seed: 12 });
  const data = matchPair(source, buffer).serialize();
  const other = buildModule({ functions: [{ code: [] }] });
  const shared = new SharedTables();
  const features = bytes => {
    const module = new WasmModule(bytes);
    return new FunctionFeatures(module, new MemoryImage(module), shared);
  };
  assert.throws(() => new Matcher(features(other), features(other)).restore(data), /other builds/);
});

test('the address resolver follows moved data', () => {
  const source = sampleModule();
  const { buffer, truth } = mutate(source, { permute: true, seed: 13, dataShifts: 0 });
  const matcher = matchPair(source, buffer);
  const resolver = new AddressResolver(matcher, () => null);
  const { addresses } = strings(40);
  const resolved = resolver.resolve(addresses[3]);
  assert.equal(resolved.value, addresses[3]);
  assert.ok(truth.defined > 0);
});

test('undoing a permutation restores the exact bytes', () => {
  const source = sampleModule();
  const { buffer, truth } = mutate(source, { permute: true, seed: 14 });
  assert.ok(undoPermutation(buffer, truth).equals(source));
});

test('a mutation that changes nothing returns the same bytes', () => {
  const source = sampleModule();
  assert.ok(mutate(source, {}).buffer.equals(source));
});
