'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../wasm/asm');
const { WasmModule } = require('../wasm/module');
const { buildModule, code } = require('./build');

const { seq, i32, get, put, load, store8, call, hole: v, gap, encode, findAll, closest, matchesAt, afterLocals, OPS } = A;

function decodedOf(bytes, locals = 2) {
  const module = new WasmModule(buildModule({ memoryPages: 1, functions: [{ locals, code: bytes }] }));
  return module.decode(0);
}

test('encode writes the bytes the assembler would', () => {
  assert.equal(encode(i32(8196232)).toString('hex'), '4188a1f403');
  assert.equal(encode(seq(i32(1), OPS.EQ)).toString('hex'), '410146');
  assert.equal(encode(A.load8(94)).toString('hex'), '2d005e');
  assert.equal(encode(get(3)).toString('hex'), '2003');
  assert.equal(encode(store8()).toString('hex'), '3a0000');
});

test('encode substitutes bound holes and refuses unbound ones', () => {
  const pattern = seq(i32(v('x')), put(v('y')));
  const bound = encode(pattern, new Map([['x', 5], ['y', 1]]));
  assert.equal(bound.toString('hex'), '41052101');
  assert.throws(() => encode(pattern, new Map()));
});

test('a pattern binds holes to the values it finds', () => {
  const decoded = decodedOf([...code.i32(77), ...code.put(1), ...code.get(1), ...code.drop]);
  const hits = findAll(decoded, seq(i32(v('value')), put(v('slot'))));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].bindings.get('value'), 77);
  assert.equal(hits[0].bindings.get('slot'), 1);
});

test('a repeated hole must match the same value', () => {
  const same = decodedOf([...code.i32(1), ...code.put(0), ...code.get(0), ...code.drop]);
  assert.equal(findAll(same, seq(put(v('l')), get(v('l')))).length, 1);
  const different = decodedOf([...code.i32(1), ...code.put(0), ...code.get(1), ...code.drop]);
  assert.equal(findAll(different, seq(put(v('l')), get(v('l')))).length, 0);
});

test('initial bindings narrow a pattern', () => {
  const decoded = decodedOf([...code.i32(5), ...code.drop, ...code.i32(6), ...code.drop]);
  assert.equal(findAll(decoded, seq(i32(v('n')), A.drop)).length, 2);
  const narrowed = findAll(decoded, seq(i32(v('n')), A.drop), new Map([['n', 6]]));
  assert.equal(narrowed.length, 1);
  assert.equal(narrowed[0].bindings.get('n'), 6);
});

test('a gap skips harmless instructions up to its limit', () => {
  const decoded = decodedOf([...code.i32(1), ...code.drop, ...code.i32(2), ...code.drop, ...code.i32(3), ...code.drop]);
  const near = seq(i32(1), gap(2), i32(2));
  assert.equal(findAll(decoded, near).length, 1);
  const far = seq(i32(1), gap(2), i32(3));
  assert.equal(findAll(decoded, far).length, 0);
  assert.equal(findAll(decoded, seq(i32(1), gap(3), i32(3))).length, 1);
});

test('a failed gap attempt does not leave bindings behind', () => {
  const decoded = decodedOf([...code.i32(1), ...code.i32(2), ...code.drop, ...code.drop]);
  const hits = findAll(decoded, seq(i32(1), gap(2), i32(v('n')), A.drop));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].bindings.get('n'), 2);
});

test('hits report byte ranges inside the module', () => {
  const module = new WasmModule(buildModule({ functions: [{ locals: 1, code: [...code.i32(300), ...code.put(0)] }] }));
  const decoded = module.decode(0);
  const [hit] = findAll(decoded, seq(i32(300), put(0)));
  assert.equal(module.buffer.subarray(hit.start, hit.end).toString('hex'), encode(seq(i32(300), put(0))).toString('hex'));
});

test('closest reports how far the best attempt got', () => {
  const decoded = decodedOf([...code.i32(1), ...code.put(0), ...code.get(1), ...code.drop]);
  const best = closest(decoded, seq(i32(1), put(0), get(0)));
  assert.equal(best.reached, 2);
  assert.equal(best.index, 0);
  assert.equal(closest(decoded, seq(call(4))).index, -1);
});

test('matchesAt only tries one position', () => {
  const decoded = decodedOf([...code.i32(1), ...code.drop]);
  assert.equal(matchesAt(decoded, 0, seq(i32(1))).ok, true);
  assert.equal(matchesAt(decoded, 1, seq(i32(1))).ok, false);
});

test('afterLocals skips the local declarations', () => {
  assert.equal(afterLocals(Buffer.from([0x00, 0x0b])), 1);
  assert.equal(afterLocals(Buffer.from([0x02, 0x01, 0x7f, 0x81, 0x01, 0x7e, 0x0b])), 6);
});

test('alignment is not part of a pattern match', () => {
  const decoded = decodedOf([...code.i32(0), 0x28, 0x00, ...code.load(0).slice(2), ...code.drop]);
  assert.equal(findAll(decoded, seq(load(0))).length, 1);
});
