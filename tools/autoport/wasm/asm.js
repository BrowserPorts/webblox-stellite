'use strict';

const { KIND, uleb, sleb } = require('./module');

class Hole {
  constructor(name) {
    this.name = name;
  }
}

const hole = name => new Hole(name);
const isHole = value => value instanceof Hole;

function instr(op, fields = {}) {
  return { op, sub: -1, ...fields };
}

const plain = op => [instr(op)];
const prefixed = (op, sub, fields = {}) => [instr(op, { sub, ...fields })];

const i32 = value => [instr(0x41, { a: value })];
const get = index => [instr(0x20, { a: index })];
const put = index => [instr(0x21, { a: index })];
const tee = index => [instr(0x22, { a: index })];
const call = func => [instr(0x10, { a: func })];
const globalGet = index => [instr(0x23, { a: index })];
const globalSet = index => [instr(0x24, { a: index })];
const load = (offset = 0, align = 2) => [instr(0x28, { a: offset, align })];
const load64 = (offset = 0, align = 3) => [instr(0x29, { a: offset, align })];
const loadf = (offset = 0, align = 2) => [instr(0x2a, { a: offset, align })];
const load8 = (offset = 0) => [instr(0x2d, { a: offset, align: 0 })];
const store = (offset = 0, align = 2) => [instr(0x36, { a: offset, align })];
const store64 = (offset = 0, align = 3) => [instr(0x37, { a: offset, align })];
const storef = (offset = 0, align = 2) => [instr(0x38, { a: offset, align })];
const store8 = (offset = 0) => [instr(0x3a, { a: offset, align: 0 })];
const block = (type = -64) => [instr(0x02, { a: type })];
const loop = (type = -64) => [instr(0x03, { a: type })];
const ifThen = (type = -64) => [instr(0x04, { a: type })];
const elseThen = plain(0x05);
const end = plain(0x0b);
const ret = plain(0x0f);
const br = depth => [instr(0x0c, { a: depth })];
const brIf = depth => [instr(0x0d, { a: depth })];
const drop = plain(0x1a);
const nop = plain(0x01);
const unreachable = plain(0x00);
const throwRef = plain(0x0a);
const f32Zero = [instr(0x43, { a: 0 })];

const OPS = {
  EQZ: plain(0x45), EQ: plain(0x46), NE: plain(0x47), LT_S: plain(0x48), LT_U: plain(0x49), GE_S: plain(0x4e), GE_U: plain(0x4f),
  I64_EQ: plain(0x51),
  ADD: plain(0x6a), SUB: plain(0x6b), MUL: plain(0x6c), DIV_S: plain(0x6d), AND: plain(0x71), OR: plain(0x72),
  F32_DIV: plain(0x95), F32_FROM_I32: plain(0xb2),
};

const atomicLoad = (offset = 0) => prefixed(0xfe, 0x10, { a: offset, align: 2 });
const atomicLoad8 = (offset = 0) => prefixed(0xfe, 0x12, { a: offset, align: 0 });
const atomicStore = (offset = 0) => prefixed(0xfe, 0x17, { a: offset, align: 2 });
const atomicCmpxchg = (offset = 0) => prefixed(0xfe, 0x48, { a: offset, align: 2 });
const tryTable = (type, clauses) => [instr(0x1f, { a: type, clauses })];
const raw = bytes => [{ raw: Buffer.from(bytes) }];

function seq(...parts) {
  return parts.flat();
}

const IMMEDIATE_KIND = {
  0x02: 'block', 0x03: 'block', 0x04: 'block', 0x0c: 'u', 0x0d: 'u', 0x10: 'u', 0x20: 'u', 0x21: 'u', 0x22: 'u', 0x23: 'u', 0x24: 'u', 0x41: 'i32', 0x43: 'f32',
};

function resolve(value, bindings) {
  if (!isHole(value)) return value;
  if (!bindings || !bindings.has(value.name)) throw new Error(`hole ${value.name} is not bound`);
  return bindings.get(value.name);
}

function encodeInstruction(item, bindings) {
  if (item.raw) return item.raw;
  const parts = [];
  if (item.op === 0xfe) {
    parts.push(Buffer.from([0xfe]), uleb(item.sub), uleb(item.align), uleb(resolve(item.a, bindings)));
    return Buffer.concat(parts);
  }
  if (item.op === 0x1f) {
    const clauses = item.clauses;
    return Buffer.concat([Buffer.from([0x1f]), sleb(resolve(item.a, bindings)).subarray(0, 1), uleb(clauses.length), ...clauses.map(clause => Buffer.concat([Buffer.from([clause.kind]), ...(clause.tag !== undefined ? [uleb(clause.tag)] : []), uleb(clause.label)]))]);
  }
  parts.push(Buffer.from([item.op]));
  if (item.op >= 0x28 && item.op <= 0x3e) {
    parts.push(uleb(item.align), uleb(resolve(item.a, bindings)));
    return Buffer.concat(parts);
  }
  const kind = IMMEDIATE_KIND[item.op];
  if (kind === 'block') parts.push(sleb(resolve(item.a, bindings)));
  else if (kind === 'u') parts.push(uleb(resolve(item.a, bindings)));
  else if (kind === 'i32') parts.push(sleb(resolve(item.a, bindings)));
  else if (kind === 'f32') {
    const value = Buffer.alloc(4);
    value.writeUInt32LE(resolve(item.a, bindings) >>> 0);
    parts.push(value);
  }
  return Buffer.concat(parts);
}

function encode(items, bindings) {
  return Buffer.concat(items.map(item => encodeInstruction(item, bindings)));
}

function matchField(expected, actual, bindings) {
  if (expected === undefined) return true;
  if (!isHole(expected)) return expected === actual;
  const known = bindings.get(expected.name);
  if (known !== undefined) return known === actual;
  bindings.set(expected.name, actual);
  return true;
}

const gap = max => [{ gap: max }];

function matchFrom(decoded, position, pattern, at, bindings) {
  for (let i = at; i < pattern.length; i++) {
    const want = pattern[i];
    if (want.gap !== undefined) {
      for (let skip = 0; skip <= want.gap; skip++) {
        const attempt = new Map(bindings);
        const result = matchFrom(decoded, position + skip, pattern, i + 1, attempt);
        if (result.ok) return result;
      }
      return { ok: false, reached: i, next: position, bindings };
    }
    const have = decoded[position];
    if (!have) return { ok: false, reached: i, next: position, bindings };
    if (want.op !== have.op || (want.sub !== undefined && want.sub !== -1 && want.sub !== have.sub)) return { ok: false, reached: i, next: position, bindings };
    if (want.op !== 0x1f && !want.raw && have.kind !== KIND.NONE && !matchField(want.a, have.a, bindings)) return { ok: false, reached: i, next: position, bindings };
    position++;
  }
  return { ok: true, reached: pattern.length, next: position, bindings };
}

function matchesAt(decoded, index, pattern, initial) {
  return matchFrom(decoded, index, pattern, 0, new Map(initial));
}

function findAll(decoded, pattern, initial = new Map()) {
  const hits = [];
  const first = pattern[0];
  for (let index = 0; index < decoded.length; index++) {
    if (decoded[index].op !== first.op) continue;
    const result = matchesAt(decoded, index, pattern, initial);
    if (result.ok) hits.push({ index, next: result.next, start: decoded[index].start, end: decoded[result.next - 1].end, bindings: result.bindings });
  }
  return hits;
}

function closest(decoded, pattern, initial = new Map()) {
  let best = { reached: 0, index: -1 };
  for (let index = 0; index < decoded.length; index++) {
    if (decoded[index].op !== pattern[0].op) continue;
    const { reached } = matchesAt(decoded, index, pattern, initial);
    if (reached > best.reached) best = { reached, index };
  }
  return best;
}

function afterLocals(body) {
  let at = 0;
  let groups = 0;
  let shift = 1;
  for (;;) {
    const byte = body[at++];
    groups += (byte & 0x7f) * shift;
    shift *= 128;
    if (byte < 0x80) break;
  }
  for (let i = 0; i < groups; i++) {
    while (body[at] & 0x80) at++;
    at += 2;
  }
  return at;
}

module.exports = {
  Hole, hole, isHole, instr, plain, prefixed,
  i32, get, put, tee, call, globalGet, globalSet, load, load64, loadf, load8, store, store64, storef, store8,
  block, loop, ifThen, elseThen, end, ret, br, brIf, drop, nop, unreachable, throwRef, f32Zero, OPS,
  atomicLoad, atomicLoad8, atomicStore, atomicCmpxchg, tryTable, raw, seq, gap,
  encode, encodeInstruction, findAll, closest, matchesAt, afterLocals,
};
