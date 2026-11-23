'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WasmModule, KIND, readInstruction, readU, readS32, readS64, uleb, sleb, readLocals, describeType } = require('../wasm/module');
const { MemoryImage } = require('../wasm/image');
const { listing, formatInstruction } = require('../wasm/print');
const { readLeb, writeLeb } = require('../wasm/splice');
const { buildModule, code, I32 } = require('./build');

test('unsigned LEB round trips across byte boundaries', () => {
  for (const value of [0, 1, 127, 128, 16383, 16384, 2097151, 2097152, 268435455, 268435456, 4294967295]) {
    const [read, end] = readU(uleb(value), 0);
    assert.equal(read, value);
    assert.equal(end, uleb(value).length);
    assert.deepEqual(writeLeb(value), uleb(value));
    assert.equal(readLeb(uleb(value), 0)[0], value);
  }
});

test('signed LEB round trips across sign boundaries', () => {
  for (const value of [0, 1, -1, 63, 64, -64, -65, 8191, 8192, -8192, -8193, 1048575, 1048576, 2147483647, -2147483648]) {
    const [read, end] = readS32(sleb(value), 0);
    assert.equal(read, value);
    assert.equal(end, sleb(value).length);
    assert.deepEqual(writeLeb(value, true), sleb(value));
    assert.equal(readLeb(sleb(value), 0, true)[0], value);
  }
});

test('64 bit LEB keeps every bit', () => {
  for (const value of [0n, -1n, 9007199254740993n, -9223372036854775808n, 9223372036854775807n]) {
    const bytes = sleb(value);
    assert.equal(readS64(bytes, 0)[0], value);
  }
});

test('the decoder reads every operand form the engine uses', () => {
  const cases = [
    [[0x02, 0x40], KIND.BLOCK, -64],
    [[0x41, 0x7f], KIND.CONST_I32, -1],
    [[0x28, 0x02, 0x84, 0x01], KIND.MEMARG, 132],
    [[0x10, 0x05], KIND.CALL, 5],
    [[0x11, 0x03, 0x00], KIND.CALL_INDIRECT, 3],
    [[0x20, 0x07], KIND.LOCAL, 7],
    [[0x23, 0x00], KIND.GLOBAL, 0],
    [[0x0e, 0x02, 0x00, 0x01, 0x02], KIND.BR_TABLE, 2],
    [[0x1f, 0x40, 0x01, 0x02, 0x00], KIND.TRY_TABLE, -64],
    [[0xfd, 0x00, 0x04, 0x10], KIND.MEMARG, 16],
    [[0xfe, 0x10, 0x02, 0x08], KIND.MEMARG, 8],
    [[0xfc, 0x08, 0x09, 0x00], KIND.TWO_INDEXES, 9],
  ];
  for (const [bytes, kind, a] of cases) {
    const instruction = readInstruction(Buffer.from(bytes), 0, {});
    assert.equal(instruction.kind, kind);
    assert.equal(instruction.a, a);
    assert.equal(instruction.end, bytes.length);
  }
  const f32 = readInstruction(Buffer.from([0x43, 1, 2, 3, 4]), 0, {});
  assert.equal(f32.end, 5);
  const f64 = readInstruction(Buffer.from([0x44, 1, 2, 3, 4, 5, 6, 7, 8]), 0, {});
  assert.equal(f64.end, 9);
  const v128 = readInstruction(Buffer.from([0xfd, 0x0c, ...new Array(16).fill(9)]), 0, {});
  assert.equal(v128.end, 18);
});

test('the module reader finds every section', () => {
  const buffer = buildModule({
    types: [{}, { params: [I32], results: [I32] }],
    imports: [{ name: 'first', type: 1 }, { name: 'second' }],
    functions: [
      { type: 1, code: [...code.get(0), ...code.call(0)] },
      { locals: 2, code: [...code.i32(1), ...code.put(0)] },
    ],
    tableSize: 4,
    elements: { base: 1, functions: [2, 3] },
    memoryPages: 1,
    globals: [4096],
    exports: [['run', 2]],
    data: [{ offset: 1024, bytes: Buffer.from('hello there\0') }],
  });
  assert.equal(WebAssembly.validate(buffer), true);
  const module = new WasmModule(buffer);
  assert.equal(module.importCount, 2);
  assert.equal(module.definedCount, 2);
  assert.equal(module.functionCount, 4);
  assert.equal(module.importIndex('second'), 1);
  assert.throws(() => module.importIndex('third'), /does not import third/);
  assert.equal(module.exports.get('run').index, 2);
  assert.equal(module.slotFunctions.get(2), 3);
  assert.equal(module.tableSlots.get(2), 1);
  assert.equal(module.globals[0].value, 4096);
  assert.equal(module.typeIndex('127>127'), 1);
  assert.equal(module.signature(2).params.length, 1);
  assert.equal(module.funcAt(module.bodyBounds(3).start + 1), 3);
  assert.equal(readLocals(module.buffer, module.bodyBounds(3).start).groups[0].count, 2);
  assert.equal(describeType(module.signature(2)), '(i32) -> (i32)');
  assert.deepEqual(module.decode(2).map(entry => entry.op), [0x20, 0x10, 0x0b]);
  const image = new MemoryImage(module);
  assert.equal(image.low, 1024);
  assert.equal(image.stringAt(1024), 'hello there');
  assert.equal(image.wholeStringAt(1030).text, 'hello there');
  assert.equal(image.wholeStringAt(1030).offset, 6);
  assert.equal(image.word(1024), Buffer.from('hell').readUInt32LE(0));
  assert.equal(image.word(99999), null);
});

test('the module reader rejects bad input with a message', () => {
  assert.throws(() => new WasmModule(Buffer.from('not wasm at all!')), /not a WebAssembly module/);
  const good = buildModule({ functions: [{ code: [] }] });
  assert.throws(() => new WasmModule(good.subarray(0, good.length - 2)));
});

test('the printer shows operands', () => {
  const module = new WasmModule(buildModule({ functions: [{ locals: 1, code: [...code.i32(7), ...code.put(0)] }] }));
  const decoded = module.decode(0);
  assert.match(formatInstruction(decoded[0]), /7/);
  assert.equal(listing(decoded, 0, 3).split('\n').length, 3);
});
