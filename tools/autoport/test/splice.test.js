'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WasmModule } = require('../wasm/module');
const { spliceSystemTheme, spliceRenderThreads, applyLightingGates } = require('../wasm/splice');
const { sleb } = require('../wasm/module');
const { buildModule, code, I32 } = require('./build');

const hex = bytes => Buffer.from(bytes).toString('hex');

function gateModule(address) {
  return buildModule({
    types: [{ results: [I32] }, {}, { params: [I32], results: [I32] }],
    memoryPages: 1,
    functions: [
      { type: 0, code: [...code.i32(1)] },
      { type: 0, code: [...code.i32(address), ...code.drop, ...code.i32(2)] },
    ],
  });
}

test('a gate edit of the same length keeps the module valid', () => {
  const module = gateModule(1000);
  const out = applyLightingGates(module, [{ func: 1, from: hex(code.i32(1000)), to: hex(code.i32(2000)) }], 0);
  assert.equal(WebAssembly.validate(out), true);
  assert.equal(out.length, module.length);
  assert.equal(new WasmModule(out).decode(1)[0].a, 2000);
});

test('a gate edit that grows the constant rewrites the sizes', () => {
  const module = gateModule(100000);
  const longer = 3000000;
  assert.ok(sleb(longer).length > sleb(100000).length);
  const out = applyLightingGates(module, [{ func: 1, from: hex(code.i32(100000)), to: hex(code.i32(longer)) }], 0);
  assert.equal(WebAssembly.validate(out), true);
  assert.equal(out.length, module.length + 1);
  const read = new WasmModule(out);
  assert.equal(read.decode(1)[0].a, longer);
  assert.equal(read.decode(0)[0].a, 1);
});

test('two edits to one function both apply', () => {
  const module = buildModule({ types: [{ results: [I32] }], functions: [{ type: 0, code: [...code.i32(5), ...code.drop, ...code.i32(6)] }] });
  const out = applyLightingGates(module, [{ func: 0, from: hex(code.i32(5)), to: hex(code.i32(50)) }, { func: 0, from: hex(code.i32(6)), to: hex(code.i32(60)) }], 0);
  assert.deepEqual(new WasmModule(out).decode(0).filter(entry => entry.op === 0x41).map(entry => entry.a), [50, 60]);
});

test('a gate that is not in the function fails', () => {
  assert.throws(() => applyLightingGates(gateModule(1000), [{ func: 1, from: hex(code.i32(1234)), to: hex(code.i32(1)) }], 0), /exactly once/);
});

test('a gate that appears twice fails', () => {
  const module = buildModule({ types: [{ results: [I32] }], functions: [{ type: 0, code: [...code.i32(9), ...code.drop, ...code.i32(9)] }] });
  assert.throws(() => applyLightingGates(module, [{ func: 0, from: hex(code.i32(9)), to: hex(code.i32(1)) }], 0), /exactly once/);
});

test('a gate on a missing function fails', () => {
  assert.throws(() => applyLightingGates(gateModule(1000), [{ func: 9, from: '41', to: '41' }], 0), /does not exist/);
});

function themeModule() {
  const functions = Array.from({ length: 4 }, (_, index) => ({ type: 1, code: [...code.i32(index)] }));
  const words = Buffer.alloc(16);
  [1, 2, 3, 4].forEach((slot, index) => words.writeUInt32LE(slot, index * 4));
  return buildModule({
    types: [{}, { params: [I32], results: [I32] }],
    memoryPages: 1,
    tableSize: 5,
    elements: { base: 1, functions: [0, 1, 2, 3] },
    functions,
    data: [{ offset: 2048, bytes: words }],
  });
}

test('the theme splice points the last two vtable slots at new functions', () => {
  const out = spliceSystemTheme(themeModule(), { vtableSlots: [1, 2, 3, 4], typeIndex: 1, valueOffset: 16 }, { dataBase: 4096, imports: 0 });
  assert.equal(WebAssembly.validate(out), true);
  const module = new WasmModule(out);
  assert.equal(module.functionCount, 6);
  assert.equal(module.slotFunctions.get(5), 4);
  assert.equal(module.slotFunctions.get(6), 5);
  const words = out.subarray(module.dataSegments[0].start, module.dataSegments[0].start + 16);
  assert.deepEqual([words.readUInt32LE(0), words.readUInt32LE(4), words.readUInt32LE(8), words.readUInt32LE(12)], [1, 2, 5, 6]);
  const read = module.decode(4);
  assert.equal(read[0].a, 4112);
  assert.equal(read[1].op, 0x28);
  assert.equal(module.decode(5)[0].a, 1);
});

test('the theme splice refuses a vtable it cannot find', () => {
  assert.throws(() => spliceSystemTheme(themeModule(), { vtableSlots: [9, 9, 9, 9], typeIndex: 1, valueOffset: 16 }, { dataBase: 4096, imports: 0 }), /not in the data section/);
});

test('the thread splice edits, moves, adds and exports functions', () => {
  const source = buildModule({
    types: [{ results: [I32] }],
    exports: [['first', 0]],
    functions: [{ type: 0, code: [...code.i32(1)] }, { type: 0, code: [...code.i32(2)] }],
  });
  const module = new WasmModule(source);
  const body = module.body(0);
  const plan = {
    imports: 0,
    edits: [{ func: 0, keepStart: 1, keepEnd: 1, hex: hex(code.i32(40)) }],
    added: [{ type: 0, moved: 1 }, { type: 0, hex: hex([0, ...code.i32(3), 0x0b]) }],
    exports: [['extra', 3]],
  };
  const out = spliceRenderThreads(source, plan);
  assert.equal(WebAssembly.validate(out), true);
  const read = new WasmModule(out);
  assert.equal(read.functionCount, 4);
  assert.equal(body.length, 4);
  assert.equal(read.decode(0)[0].a, 40);
  assert.equal(read.decode(2)[0].a, 2);
  assert.equal(read.decode(3)[0].a, 3);
  assert.equal(read.exports.get('extra').index, 3);
});
