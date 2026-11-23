'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WasmModule } = require('../wasm/module');
const { PortContext, PortError, FunctionEdits, value } = require('../context');
const { seq, i32, hole: v, drop, encode } = require('../wasm/asm');
const { buildModule, code } = require('./build');

function moduleWith(functions) {
  return new WasmModule(buildModule({ memoryPages: 1, functions }));
}

function identityContext(module, functions = {}) {
  return new PortContext({ oldModule: module, newModule: module, matcher: null, profile: { wasm: { functions, constants: {} } }, identity: true });
}

test('a site that exists returns its bindings', () => {
  const module = moduleWith([{ code: [...code.i32(42), ...code.drop] }]);
  const ctx = identityContext(module, { TARGET: 0 });
  const hit = ctx.site('TARGET', () => seq(i32(v('n')), drop));
  assert.equal(value(hit.bindings, 'n'), 42);
});

test('a missing site explains itself', () => {
  const module = moduleWith([{ code: [...code.i32(42), ...code.drop] }]);
  const ctx = identityContext(module, { TARGET: 0 });
  assert.throws(() => ctx.site('TARGET', () => seq(i32(42), i32(43)), { label: 'the check' }), error => {
    assert.ok(error instanceof PortError);
    assert.match(error.message, /the check in TARGET was not found/);
    assert.equal(error.details.func, 0);
    assert.match(error.details.closestMatch, /1 of 2 instructions/);
    assert.ok(error.details.nearby.length > 0);
    return true;
  });
});

test('several hits need the old build to choose', () => {
  const module = moduleWith([{ code: [...code.i32(1), ...code.drop, ...code.i32(2), ...code.drop] }]);
  const ctx = identityContext(module, { TARGET: 0 });
  const pattern = () => seq(i32(v('n')), drop);
  assert.throws(() => ctx.site('TARGET', pattern), /matched 2 places/);
  assert.equal(value(ctx.site('TARGET', pattern, { expect: { n: 2 } }).bindings, 'n'), 2);
  assert.equal(value(ctx.site('TARGET', pattern, { first: true }).bindings, 'n'), 1);
});

test('a site can name its function directly', () => {
  const module = moduleWith([{ code: [...code.i32(1), ...code.drop] }, { code: [...code.i32(5), ...code.drop, ...code.i32(6), ...code.drop] }]);
  const ctx = identityContext(module);
  const pattern = () => seq(i32(v('n')), drop);
  assert.equal(value(ctx.site('free text', pattern, { func: 0 }).bindings, 'n'), 1);
  assert.equal(value(ctx.site('free text', pattern, { func: 1, oldFunc: 1, expect: { n: 6 } }).bindings, 'n'), 6);
});

test('symbols must be known', () => {
  const ctx = identityContext(moduleWith([{ code: [] }]), { KNOWN: 0 });
  assert.equal(ctx.func('KNOWN'), 0);
  assert.throws(() => ctx.func('UNKNOWN'), /has no function called UNKNOWN/);
});

test('a binding that disagrees with an earlier one fails', () => {
  const ctx = identityContext(moduleWith([{ code: [] }, { code: [] }]), { KNOWN: 0 });
  ctx.bindFunction('KNOWN', 0, 'a call site');
  assert.throws(() => ctx.bindFunction('KNOWN', 1, 'another call site'), /already resolved to 0/);
});

test('value refuses a name the pattern did not bind', () => {
  assert.throws(() => value(new Map(), 'absent'), /did not bind absent/);
});

test('edits apply in position order', () => {
  const module = moduleWith([{ locals: 1, code: [...code.i32(1), ...code.drop, ...code.i32(2), ...code.drop] }]);
  const decoded = module.decode(0);
  const edits = new FunctionEdits(module, 0);
  edits.replace(decoded[2].start, decoded[2].end, encode(i32(20)));
  edits.replace(decoded[0].start, decoded[0].end, encode(i32(10)));
  edits.insertHead(encode(seq(i32(99), drop)));
  const body = edits.build();
  assert.equal(body.toString('hex').includes(encode(i32(10)).toString('hex')), true);
  assert.equal(body.toString('hex').indexOf(encode(i32(99)).toString('hex')) < body.toString('hex').indexOf(encode(i32(10)).toString('hex')), true);
});

test('overlapping edits fail', () => {
  const module = moduleWith([{ code: [...code.i32(1), ...code.drop, ...code.i32(2), ...code.drop] }]);
  const decoded = module.decode(0);
  const edits = new FunctionEdits(module, 0);
  edits.replace(decoded[0].start, decoded[1].end, encode(i32(1)));
  edits.replace(decoded[0].start, decoded[0].end, encode(i32(2)));
  assert.throws(() => edits.build(), /overlapping edits/);
});
