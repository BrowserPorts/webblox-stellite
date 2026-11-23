'use strict';

const SECTION = { CUSTOM: 0, TYPE: 1, IMPORT: 2, FUNCTION: 3, TABLE: 4, MEMORY: 5, GLOBAL: 6, EXPORT: 7, START: 8, ELEMENT: 9, CODE: 10, DATA: 11, DATA_COUNT: 12, TAG: 13 };
const EXTERNAL = { FUNCTION: 0, TABLE: 1, MEMORY: 2, GLOBAL: 3, TAG: 4 };
const VALUE_NAMES = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128', 0x70: 'funcref', 0x6f: 'externref', 0x69: 'exnref' };

const KIND = {
  NONE: 0,
  BLOCK: 1,
  INDEX: 2,
  LOCAL: 3,
  GLOBAL: 4,
  CALL: 5,
  CALL_INDIRECT: 6,
  BR_TABLE: 7,
  TRY_TABLE: 8,
  MEMARG: 9,
  CONST_I32: 10,
  CONST_I64: 11,
  CONST_F32: 12,
  CONST_F64: 13,
  SELECT_TYPED: 14,
  BYTE: 15,
  MEMARG_LANE: 16,
  BYTES16: 17,
  LANE: 18,
  TWO_INDEXES: 19,
  HEAP_TYPE: 20,
  REF_FUNC: 21,
};

const OPCODE_KIND = new Uint8Array(256);
for (const op of [0x02, 0x03, 0x04, 0x06]) OPCODE_KIND[op] = KIND.BLOCK;
for (const op of [0x07, 0x08, 0x09, 0x0c, 0x0d, 0x14, 0x15, 0x18, 0x25, 0x26]) OPCODE_KIND[op] = KIND.INDEX;
OPCODE_KIND[0x0e] = KIND.BR_TABLE;
OPCODE_KIND[0x10] = KIND.CALL;
OPCODE_KIND[0x12] = KIND.CALL;
OPCODE_KIND[0x11] = KIND.CALL_INDIRECT;
OPCODE_KIND[0x13] = KIND.CALL_INDIRECT;
OPCODE_KIND[0x1c] = KIND.SELECT_TYPED;
OPCODE_KIND[0x1f] = KIND.TRY_TABLE;
for (const op of [0x20, 0x21, 0x22]) OPCODE_KIND[op] = KIND.LOCAL;
for (const op of [0x23, 0x24]) OPCODE_KIND[op] = KIND.GLOBAL;
for (let op = 0x28; op <= 0x3e; op++) OPCODE_KIND[op] = KIND.MEMARG;
OPCODE_KIND[0x3f] = KIND.BYTE;
OPCODE_KIND[0x40] = KIND.BYTE;
OPCODE_KIND[0x41] = KIND.CONST_I32;
OPCODE_KIND[0x42] = KIND.CONST_I64;
OPCODE_KIND[0x43] = KIND.CONST_F32;
OPCODE_KIND[0x44] = KIND.CONST_F64;
OPCODE_KIND[0xd0] = KIND.HEAP_TYPE;
OPCODE_KIND[0xd2] = KIND.REF_FUNC;

const PREFIX_MISC = 0xfc;
const PREFIX_SIMD = 0xfd;
const PREFIX_ATOMIC = 0xfe;
const MISC_MEMORY_INIT = 8;

function miscKind(sub) {
  if (sub <= 7) return KIND.NONE;
  if (sub === 8) return KIND.TWO_INDEXES;
  if (sub === 9) return KIND.INDEX;
  if (sub === 10) return KIND.TWO_INDEXES;
  if (sub === 11) return KIND.INDEX;
  if (sub === 12) return KIND.TWO_INDEXES;
  if (sub === 13) return KIND.INDEX;
  if (sub === 14) return KIND.TWO_INDEXES;
  if (sub <= 17) return KIND.INDEX;
  throw new Error(`unknown 0xfc instruction ${sub}`);
}

function simdKind(sub) {
  if (sub <= 11 || sub === 92 || sub === 93) return KIND.MEMARG;
  if (sub === 12 || sub === 13) return KIND.BYTES16;
  if (sub >= 21 && sub <= 34) return KIND.LANE;
  if (sub >= 84 && sub <= 91) return KIND.MEMARG_LANE;
  return KIND.NONE;
}

function atomicKind(sub) {
  return sub === 3 ? KIND.BYTE : KIND.MEMARG;
}

function readU(buf, at) {
  let result = 0;
  let shift = 1;
  for (;;) {
    const byte = buf[at++];
    result += (byte & 0x7f) * shift;
    shift *= 128;
    if (byte < 0x80) return [result, at];
  }
}

function readS32(buf, at) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[at++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  if (shift < 32 && byte & 0x40) result |= -1 << shift;
  return [result, at];
}

function readS64(buf, at) {
  let result = 0n;
  let shift = 0n;
  let byte;
  do {
    byte = buf[at++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  if (byte & 0x40) result -= 1n << shift;
  return [result, at];
}

function uleb(value) {
  const out = [];
  let rest = value;
  for (;;) {
    const byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest) out.push(byte | 0x80);
    else {
      out.push(byte);
      return Buffer.from(out);
    }
  }
}

function sleb(value) {
  const out = [];
  let rest = BigInt(value);
  for (;;) {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    const done = (rest === 0n && !(byte & 0x40)) || (rest === -1n && byte & 0x40);
    if (done) {
      out.push(byte);
      return Buffer.from(out);
    }
    out.push(byte | 0x80);
  }
}

function skipLeb(buf, at) {
  while (buf[at] & 0x80) at++;
  return at + 1;
}

function readMemarg(buf, at, instruction) {
  let align;
  [align, at] = readU(buf, at);
  if (align & 0x40) at = skipLeb(buf, at);
  let offset;
  [offset, at] = readU(buf, at);
  instruction.align = align;
  instruction.a = offset;
  return at;
}

const scratch = { op: 0, sub: 0, kind: 0, a: 0, b: 0, align: 0, start: 0, end: 0, wide: 0n };

function readInstruction(buf, at, instruction = scratch) {
  instruction.start = at;
  const op = buf[at++];
  instruction.op = op;
  instruction.sub = -1;
  let kind;
  if (op < PREFIX_MISC) kind = OPCODE_KIND[op];
  else {
    let sub;
    [sub, at] = readU(buf, at);
    instruction.sub = sub;
    if (op === PREFIX_MISC) kind = miscKind(sub);
    else if (op === PREFIX_SIMD) kind = simdKind(sub);
    else if (op === PREFIX_ATOMIC) kind = atomicKind(sub);
    else throw new Error(`unknown instruction prefix 0x${op.toString(16)} at ${at}`);
  }
  instruction.kind = kind;
  switch (kind) {
    case KIND.NONE:
      break;
    case KIND.BLOCK: {
      let type;
      [type, at] = readS32(buf, at);
      instruction.a = type;
      break;
    }
    case KIND.INDEX:
    case KIND.LOCAL:
    case KIND.GLOBAL:
    case KIND.CALL:
    case KIND.HEAP_TYPE:
    case KIND.REF_FUNC:
      [instruction.a, at] = readU(buf, at);
      break;
    case KIND.CALL_INDIRECT:
    case KIND.TWO_INDEXES:
      [instruction.a, at] = readU(buf, at);
      [instruction.b, at] = readU(buf, at);
      break;
    case KIND.BR_TABLE: {
      let count;
      [count, at] = readU(buf, at);
      instruction.a = count;
      for (let i = 0; i <= count; i++) at = skipLeb(buf, at);
      break;
    }
    case KIND.TRY_TABLE: {
      let type;
      [type, at] = readS32(buf, at);
      instruction.a = type;
      let count;
      [count, at] = readU(buf, at);
      instruction.b = count;
      for (let i = 0; i < count; i++) {
        const clause = buf[at++];
        if (clause === 0 || clause === 1) at = skipLeb(buf, at);
        at = skipLeb(buf, at);
      }
      break;
    }
    case KIND.MEMARG:
      at = readMemarg(buf, at, instruction);
      break;
    case KIND.MEMARG_LANE:
      at = readMemarg(buf, at, instruction);
      instruction.b = buf[at++];
      break;
    case KIND.CONST_I32:
      [instruction.a, at] = readS32(buf, at);
      break;
    case KIND.CONST_I64:
      [instruction.wide, at] = readS64(buf, at);
      break;
    case KIND.CONST_F32:
      instruction.a = buf.readUInt32LE(at);
      at += 4;
      break;
    case KIND.CONST_F64:
      instruction.a = buf.readUInt32LE(at);
      instruction.b = buf.readUInt32LE(at + 4);
      at += 8;
      break;
    case KIND.SELECT_TYPED: {
      let count;
      [count, at] = readU(buf, at);
      at += count;
      break;
    }
    case KIND.BYTE:
    case KIND.LANE:
      instruction.a = buf[at++];
      break;
    case KIND.BYTES16:
      at += 16;
      break;
    default:
      throw new Error(`unhandled instruction kind ${kind}`);
  }
  instruction.end = at;
  return instruction;
}

function bodyStart(buf, start) {
  let groups;
  let at;
  [groups, at] = readU(buf, start);
  for (let i = 0; i < groups; i++) {
    at = skipLeb(buf, at);
    at++;
  }
  return at;
}

function readLocals(buf, start) {
  let groups;
  let at;
  [groups, at] = readU(buf, start);
  const list = [];
  for (let i = 0; i < groups; i++) {
    let count;
    [count, at] = readU(buf, at);
    list.push({ count, type: buf[at++] });
  }
  return { groups: list, code: at };
}

function readInitExpression(buf, at) {
  let value = null;
  let global = null;
  for (;;) {
    const instruction = readInstruction(buf, at, {});
    at = instruction.end;
    if (instruction.op === 0x0b) return { value, global, end: at };
    if (instruction.op === 0x41) value = instruction.a;
    else if (instruction.op === 0x23) global = instruction.a;
  }
}

class WasmModule {
  constructor(buffer) {
    if (buffer.readUInt32LE(0) !== 0x6d736100) throw new Error('not a WebAssembly module');
    this.buffer = buffer;
    this.sections = [];
    this.parseSections();
    this.parseTypes();
    this.parseImports();
    this.parseFunctions();
    this.parseTables();
    this.parseGlobals();
    this.parseExports();
    this.parseStart();
    this.parseElements();
    this.parseCode();
    this.parseData();
  }

  parseSections() {
    const buf = this.buffer;
    let at = 8;
    while (at < buf.length) {
      const id = buf[at];
      const [size, start] = readU(buf, at + 1);
      this.sections.push({ id, start, size, end: start + size, header: at });
      at = start + size;
    }
    if (at !== buf.length) throw new Error('the last section runs past the end of the file');
  }

  section(id) {
    return this.sections.find(section => section.id === id) || null;
  }

  parseTypes() {
    const buf = this.buffer;
    const section = this.section(SECTION.TYPE);
    this.types = [];
    if (!section) return;
    let [count, at] = readU(buf, section.start);
    for (let i = 0; i < count; i++) {
      const form = buf[at++];
      if (form !== 0x60) throw new Error(`type ${i} is not a function type (0x${form.toString(16)})`);
      let params;
      [params, at] = readU(buf, at);
      const paramTypes = [...buf.subarray(at, at + params)];
      at += params;
      let results;
      [results, at] = readU(buf, at);
      const resultTypes = [...buf.subarray(at, at + results)];
      at += results;
      this.types.push({ params: paramTypes, results: resultTypes, key: `${paramTypes.join(',')}>${resultTypes.join(',')}` });
    }
    this.typeIndexByKey = new Map();
    this.types.forEach((type, index) => {
      if (!this.typeIndexByKey.has(type.key)) this.typeIndexByKey.set(type.key, index);
    });
  }

  parseImports() {
    const buf = this.buffer;
    const section = this.section(SECTION.IMPORT);
    this.functionImports = [];
    this.importedTables = 0;
    this.importedMemories = [];
    this.importedGlobals = [];
    this.importedTags = 0;
    if (!section) {
      this.importCount = 0;
      return;
    }
    let [count, at] = readU(buf, section.start);
    const readName = () => {
      let size;
      [size, at] = readU(buf, at);
      const name = buf.toString('utf8', at, at + size);
      at += size;
      return name;
    };
    for (let i = 0; i < count; i++) {
      const module = readName();
      const name = readName();
      const kind = buf[at++];
      if (kind === EXTERNAL.FUNCTION) {
        let type;
        [type, at] = readU(buf, at);
        this.functionImports.push({ module, name, type });
      } else if (kind === EXTERNAL.TABLE) {
        at++;
        const flags = buf[at++];
        at = skipLeb(buf, at);
        if (flags & 1) at = skipLeb(buf, at);
        this.importedTables++;
      } else if (kind === EXTERNAL.MEMORY) {
        const flags = buf[at++];
        let minimum;
        [minimum, at] = readU(buf, at);
        let maximum = null;
        if (flags & 1) [maximum, at] = readU(buf, at);
        this.importedMemories.push({ module, name, flags, minimum, maximum });
      } else if (kind === EXTERNAL.GLOBAL) {
        const type = buf[at++];
        const mutable = buf[at++] === 1;
        this.importedGlobals.push({ module, name, type, mutable });
      } else if (kind === EXTERNAL.TAG) {
        at++;
        at = skipLeb(buf, at);
        this.importedTags++;
      } else {
        throw new Error(`unknown import kind ${kind}`);
      }
    }
    this.importCount = this.functionImports.length;
    this.importIndexByName = new Map(this.functionImports.map((entry, index) => [entry.name, index]));
  }

  parseFunctions() {
    const buf = this.buffer;
    const section = this.section(SECTION.FUNCTION);
    let [count, at] = readU(buf, section.start);
    this.functionTypes = new Int32Array(count);
    for (let i = 0; i < count; i++) [this.functionTypes[i], at] = readU(buf, at);
    this.definedCount = count;
    this.functionCount = this.importCount + count;
  }

  parseTables() {
    const buf = this.buffer;
    const section = this.section(SECTION.TABLE);
    this.tables = [];
    if (!section) return;
    let [count, at] = readU(buf, section.start);
    for (let i = 0; i < count; i++) {
      const type = buf[at++];
      const flags = buf[at++];
      let minimum;
      [minimum, at] = readU(buf, at);
      let maximum = null;
      if (flags & 1) [maximum, at] = readU(buf, at);
      this.tables.push({ type, flags, minimum, maximum });
    }
  }

  parseGlobals() {
    const buf = this.buffer;
    const section = this.section(SECTION.GLOBAL);
    this.globals = this.importedGlobals.map(entry => ({ type: entry.type, mutable: entry.mutable, imported: true, value: null }));
    if (!section) return;
    let [count, at] = readU(buf, section.start);
    for (let i = 0; i < count; i++) {
      const type = buf[at++];
      const mutable = buf[at++] === 1;
      const init = readInitExpression(buf, at);
      at = init.end;
      this.globals.push({ type, mutable, imported: false, value: init.value });
    }
  }

  parseExports() {
    const buf = this.buffer;
    const section = this.section(SECTION.EXPORT);
    this.exports = new Map();
    if (!section) return;
    let [count, at] = readU(buf, section.start);
    for (let i = 0; i < count; i++) {
      let size;
      [size, at] = readU(buf, at);
      const name = buf.toString('utf8', at, at + size);
      at += size;
      const kind = buf[at++];
      let index;
      [index, at] = readU(buf, at);
      this.exports.set(name, { kind, index });
    }
  }

  parseStart() {
    const section = this.section(SECTION.START);
    this.start = section ? readU(this.buffer, section.start)[0] : null;
  }

  parseElements() {
    const buf = this.buffer;
    const section = this.section(SECTION.ELEMENT);
    this.elementSegments = [];
    this.tableSlots = new Map();
    this.slotFunctions = new Map();
    if (!section) return;
    let [count, at] = readU(buf, section.start);
    for (let i = 0; i < count; i++) {
      let flags;
      [flags, at] = readU(buf, at);
      if (flags !== 0) throw new Error(`element segment ${i} uses flags ${flags}, which this tool does not read`);
      const offset = readInitExpression(buf, at);
      at = offset.end;
      let size;
      [size, at] = readU(buf, at);
      const functions = new Int32Array(size);
      for (let k = 0; k < size; k++) [functions[k], at] = readU(buf, at);
      this.elementSegments.push({ base: offset.value, functions });
      functions.forEach((func, k) => {
        const slot = offset.value + k;
        this.slotFunctions.set(slot, func);
        if (!this.tableSlots.has(func)) this.tableSlots.set(func, slot);
      });
    }
  }

  parseCode() {
    const buf = this.buffer;
    const section = this.section(SECTION.CODE);
    let [count, at] = readU(buf, section.start);
    if (count !== this.definedCount) throw new Error('the code and function sections disagree');
    this.bodyStarts = new Uint32Array(count);
    this.bodySizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      let size;
      [size, at] = readU(buf, at);
      this.bodyStarts[i] = at;
      this.bodySizes[i] = size;
      at += size;
    }
  }

  parseData() {
    const buf = this.buffer;
    const section = this.section(SECTION.DATA);
    this.dataSegments = [];
    if (!section) return;
    let [count, at] = readU(buf, section.start);
    for (let i = 0; i < count; i++) {
      let flags;
      [flags, at] = readU(buf, at);
      let offset = null;
      if (flags === 2) at = skipLeb(buf, at);
      if (flags === 0 || flags === 2) {
        const init = readInitExpression(buf, at);
        at = init.end;
        offset = init.value;
      }
      let size;
      [size, at] = readU(buf, at);
      this.dataSegments.push({ flags, offset, start: at, size });
      at += size;
    }
  }

  isImport(func) {
    return func < this.importCount;
  }

  typeOf(func) {
    return func < this.importCount ? this.functionImports[func].type : this.functionTypes[func - this.importCount];
  }

  signature(func) {
    return this.types[this.typeOf(func)];
  }

  paramCount(func) {
    return this.signature(func).params.length;
  }

  bodyBounds(func) {
    const index = func - this.importCount;
    const start = this.bodyStarts[index];
    return { start, end: start + this.bodySizes[index] };
  }

  body(func) {
    const { start, end } = this.bodyBounds(func);
    return this.buffer.subarray(start, end);
  }

  funcAt(position) {
    const starts = this.bodyStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= position) lo = mid;
      else hi = mid - 1;
    }
    return this.importCount + lo;
  }

  importIndex(name) {
    const index = this.importIndexByName.get(name);
    if (index === undefined) throw new Error(`the module does not import ${name}`);
    return index;
  }

  typeIndex(key) {
    const index = this.typeIndexByKey.get(key);
    if (index === undefined) throw new Error(`the module has no function type ${key}`);
    return index;
  }

  *instructions(func) {
    const { start, end } = this.bodyBounds(func);
    let at = bodyStart(this.buffer, start);
    while (at < end) {
      const instruction = readInstruction(this.buffer, at, {});
      at = instruction.end;
      yield instruction;
    }
  }

  decode(func) {
    return [...this.instructions(func)];
  }
}

function describeType(type) {
  const names = list => list.map(value => VALUE_NAMES[value] || value).join(' ');
  return `(${names(type.params)}) -> (${names(type.results)})`;
}

module.exports = {
  WasmModule,
  SECTION,
  EXTERNAL,
  KIND,
  PREFIX_MISC,
  PREFIX_SIMD,
  PREFIX_ATOMIC,
  MISC_MEMORY_INIT,
  VALUE_NAMES,
  readU,
  readS32,
  readS64,
  readInstruction,
  readLocals,
  bodyStart,
  skipLeb,
  uleb,
  sleb,
  describeType,
};
