'use strict';

const { uleb, sleb } = require('../../autoport/wasm/module');
const { buildModule, I32 } = require('../../autoport/test/build');

const STRINGS_AT = 1024;
const FLAGS_AT = 0x8000;
const INTS_AT = 0xa000;
const LIST_AT = 0xc000;
const LIST_HEAD = 0xd000;
const STACK_TOP = 0x30000;

const op = {
  i32: value => [0x41, ...sleb(value)],
  i64: value => [0x42, ...sleb64(value)],
  get: index => [0x20, ...uleb(index)],
  tee: index => [0x22, ...uleb(index)],
  globalGet: index => [0x23, ...uleb(index)],
  globalSet: index => [0x24, ...uleb(index)],
  call: func => [0x10, ...uleb(func)],
  add: [0x6a],
  sub: [0x6b],
  load: offset => [0x28, 2, ...uleb(offset)],
  store: offset => [0x36, 2, ...uleb(offset)],
  store16: offset => [0x3b, 1, ...uleb(offset)],
  store8: offset => [0x3a, 0, ...uleb(offset)],
  store64: offset => [0x37, 3, ...uleb(offset)],
};

function sleb64(value) {
  const out = [];
  let rest = BigInt.asIntN(64, BigInt(value));
  for (;;) {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if ((rest === 0n && !(byte & 0x40)) || (rest === -1n && (byte & 0x40))) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

function littleEndian(text) {
  const bytes = Buffer.alloc(8);
  Buffer.from(text, 'latin1').copy(bytes, 0, 0, 8);
  return bytes.readBigInt64LE(0);
}

function buildEngine({ flags, ints, versioned, luau }) {
  const strings = [];
  const addressOf = new Map();
  let cursor = STRINGS_AT;
  const intern = text => {
    if (addressOf.has(text)) return addressOf.get(text);
    const address = cursor;
    addressOf.set(text, address);
    strings.push(Buffer.from(`${text}\0`, 'latin1'));
    cursor += text.length + 1;
    return address;
  };
  const flagData = Buffer.alloc(flags.length * 12);
  flags.forEach((flag, index) => {
    flagData.writeUInt32LE(flag.value ? 1 : 0, index * 12);
    flagData.writeUInt32LE(intern(flag.name), index * 12 + 4);
    flagData.writeUInt32LE(flag.name.length, index * 12 + 8);
  });
  const intData = Buffer.alloc(ints.length * 12);
  ints.forEach((entry, index) => {
    intData.writeInt32LE(entry.value, index * 12);
    intData.writeUInt32LE(intern(entry.name), index * 12 + 4);
    intData.writeUInt32LE(entry.name.length, index * 12 + 8);
  });
  for (const entry of luau) intern(entry.name);
  const types = [
    { params: [I32, I32, I32], results: [] },
    { params: [I32, I32], results: [] },
    { params: [], results: [] },
  ];
  const functions = [
    { type: 0, code: [] },
    { type: 1, code: [] },
    { type: 1, code: [] },
  ];
  const REGISTER = 0;
  const REGISTER_INT = 1;
  const VERSION = 2;
  flags.forEach((flag, index) => {
    functions.push({ type: 2, code: [...op.i32(intern(flag.name)), ...op.i32(FLAGS_AT + index * 12), ...op.i32(flag.kind || 1), ...op.call(REGISTER)] });
  });
  ints.forEach((entry, index) => {
    functions.push({ type: 2, code: [...op.i32(INTS_AT + index * 12), ...op.i32(entry.kind || 1), ...op.call(REGISTER_INT)] });
  });
  for (const [name, version] of Object.entries(versioned)) {
    if (name.length > 10) throw new Error(`the test engine only builds short version names: ${name}`);
    const code = [
      ...op.globalGet(0), ...op.i32(16), ...op.sub, ...op.tee(0), ...op.globalSet(0),
      ...op.get(0), ...op.i64(littleEndian(name)), ...op.store64(4),
      ...op.get(0), ...op.i32(Number(littleEndian(name.slice(8)) & 0xffffn)), ...op.store16(12),
      ...op.get(0), ...op.i32(name.length), ...op.store8(15),
      ...op.get(0), ...op.i32(4), ...op.add, ...op.i32(version), ...op.call(VERSION),
    ];
    functions.push({ type: 2, code, locals: 1 });
  }
  const ctor = [];
  luau.forEach((entry, index) => {
    const node = LIST_AT + index * 12;
    ctor.push(...op.i32(node + 4), ...op.i32(intern(entry.name)), ...op.store(0));
    ctor.push(...op.i32(node), ...op.i32((entry.value ? 1 : 0) | ((entry.dynamic ? 1 : 0) << 8)), ...op.store16(0));
    ctor.push(...op.i32(node + 8), ...op.i32(LIST_HEAD), ...op.load(0), ...op.store(0));
    ctor.push(...op.i32(LIST_HEAD), ...op.i32(node), ...op.store(0));
  });
  functions.push({ type: 2, code: ctor });
  const ctorIndex = functions.length - 1;
  const data = [
    { offset: STRINGS_AT, bytes: Buffer.concat(strings) },
    { offset: FLAGS_AT, bytes: flagData },
    { offset: INTS_AT, bytes: intData },
  ];
  if (cursor >= FLAGS_AT) throw new Error('the test strings overflow into the flag table');
  return buildModule({ types, functions, memoryPages: 4, globals: [STACK_TOP], exports: [['__wasm_call_ctors', ctorIndex]], data });
}

module.exports = { buildEngine, FLAGS_AT, INTS_AT, LIST_AT };
