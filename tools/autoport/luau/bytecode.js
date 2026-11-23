'use strict';

const PREFIX = Buffer.from('527a104a5b3209e0', 'hex');
const OPCODE_KEY = 227;
const OPCODE_UNKEY = 203;
const AUX_OPS = new Set([7, 8, 12, 15, 16, 20, 27, 28, 29, 30, 31, 32, 53, 55, 58, 60, 66, 74, 75, 77, 78, 79, 80, 83, 84, 85, 86, 87, 88, 90, 91, 93, 94]);
const OP = { NOP: 0, LOADNIL: 2, LOADB: 3, LOADN: 4, LOADK: 5, MOVE: 6, GETGLOBAL: 7, GETUPVAL: 9, GETIMPORT: 12, GETTABLEKS: 15, SETTABLEKS: 16, NAMECALL: 20, CALL: 21, RETURN: 22, JUMP: 23, JUMPIF: 25, JUMPIFNOT: 26, DUPTABLE: 54 };

function readVarint(buf, at) {
  let result = 0;
  let scale = 1;
  for (;;) {
    const byte = buf[at++];
    result += (byte & 0x7f) * scale;
    scale *= 128;
    if (byte < 0x80) return [result, at];
  }
}

function readConstant(buf, at, strings) {
  const type = buf[at++];
  switch (type) {
    case 0: return [{ type: 'nil' }, at];
    case 1: return [{ type: 'boolean', value: buf[at] !== 0 }, at + 1];
    case 2: return [{ type: 'number', value: buf.readDoubleLE(at) }, at + 8];
    case 3: {
      const [index, next] = readVarint(buf, at);
      return [{ type: 'string', value: strings[index - 1] }, next];
    }
    case 4: return [{ type: 'import', id: buf.readUInt32LE(at) }, at + 4];
    case 5: {
      let [count, next] = readVarint(buf, at);
      for (let i = 0; i < count; i++) [, next] = readVarint(buf, next);
      return [{ type: 'table' }, next];
    }
    case 6: {
      const [index, next] = readVarint(buf, at);
      return [{ type: 'closure', index }, next];
    }
    case 7: return [{ type: 'vector', value: buf.subarray(at, at + 16).toString('hex') }, at + 16];
    case 8: {
      let [count, next] = readVarint(buf, at);
      const entries = [];
      for (let i = 0; i < count; i++) {
        let key;
        [key, next] = readVarint(buf, next);
        entries.push({ key, value: buf.readInt32LE(next) });
        next += 4;
      }
      return [{ type: 'tableWithConstants', entries }, next];
    }
    case 9: {
      let next = at + 1;
      while (buf[next++] >= 0x80);
      return [{ type: 'integer' }, next];
    }
    case 11: return [{ type: 'vector64' }, at + 32];
    default:
      throw new Error(`unknown Luau constant type ${type} at ${at}`);
  }
}

function parse(source) {
  if (!source.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error('not Roblox-encoded Luau bytecode');
  const buf = source.subarray(PREFIX.length);
  let at = 0;
  const version = buf[at++];
  const typesVersion = version >= 4 ? buf[at++] : 0;
  let stringCount;
  [stringCount, at] = readVarint(buf, at);
  const strings = [];
  for (let i = 0; i < stringCount; i++) {
    let length;
    [length, at] = readVarint(buf, at);
    strings.push(buf.toString('latin1', at, at + length));
    at += length;
  }
  if (typesVersion === 3) {
    for (let index = buf[at++]; index !== 0; index = buf[at++]) [, at] = readVarint(buf, at);
  }
  let protoCount;
  [protoCount, at] = readVarint(buf, at);
  const protos = [];
  for (let p = 0; p < protoCount; p++) {
    let size = 0;
    if (version >= 12) [size, at] = readVarint(buf, at);
    const start = at;
    const proto = { index: p, maxStack: buf[at], params: buf[at + 1], upvalues: buf[at + 2], vararg: buf[at + 3] };
    at += 4;
    if (version >= 4) {
      at++;
      let typeSize;
      [typeSize, at] = readVarint(buf, at);
      at += typeSize;
    }
    let count;
    [count, at] = readVarint(buf, at);
    proto.codeOffset = at + PREFIX.length;
    proto.count = count;
    at += 4 * count;
    let constantCount;
    [constantCount, at] = readVarint(buf, at);
    proto.constants = [];
    for (let k = 0; k < constantCount; k++) {
      let constant;
      [constant, at] = readConstant(buf, at, strings);
      proto.constants.push(constant);
    }
    let childCount;
    [childCount, at] = readVarint(buf, at);
    proto.children = [];
    for (let k = 0; k < childCount; k++) {
      let child;
      [child, at] = readVarint(buf, at);
      proto.children.push(child);
    }
    [, at] = readVarint(buf, at);
    let debugName;
    [debugName, at] = readVarint(buf, at);
    proto.debugName = debugName ? strings[debugName - 1] : '';
    if (buf[at++]) {
      const gap = buf[at++];
      at += count + 4 * (((count - 1) >> gap) + 1);
    }
    if (buf[at++]) {
      let locals;
      [locals, at] = readVarint(buf, at);
      for (let k = 0; k < locals; k++) {
        [, at] = readVarint(buf, at);
        [, at] = readVarint(buf, at);
        [, at] = readVarint(buf, at);
        at++;
      }
      let upvalues;
      [upvalues, at] = readVarint(buf, at);
      for (let k = 0; k < upvalues; k++) [, at] = readVarint(buf, at);
    }
    if (version >= 11) {
      let feedback;
      [feedback, at] = readVarint(buf, at);
    }
    if (version >= 12) at = start + size;
    protos.push(proto);
  }
  return { version, typesVersion, strings, protos, source };
}

function decodeOp(byte) {
  return (byte * OPCODE_UNKEY) & 0xff;
}

function encodeOp(op) {
  return (op * OPCODE_KEY) & 0xff;
}

function instructions(module, proto) {
  const { source } = module;
  const list = [];
  for (let pc = 0; pc < proto.count; pc++) {
    const at = proto.codeOffset + pc * 4;
    const op = decodeOp(source[at]);
    const instruction = { pc, at, op, a: source[at + 1], b: source[at + 2], c: source[at + 3], d: source.readInt16LE(at + 2), aux: null };
    if (AUX_OPS.has(op)) {
      instruction.aux = source.readUInt32LE(at + 4);
      pc++;
    }
    list.push(instruction);
  }
  return list;
}

function imageEntries(module, proto) {
  const list = instructions(module, proto);
  const images = new Map();
  let table = null;
  const stringAt = index => {
    const constant = proto.constants[index];
    return constant && constant.type === 'string' ? constant.value : null;
  };
  for (let i = 0; i < list.length; i++) {
    const instruction = list[i];
    if (instruction.op === OP.DUPTABLE) {
      table = { sheet: null };
      const template = proto.constants[instruction.d];
      if (template && template.type === 'tableWithConstants') {
        for (const entry of template.entries) {
          if (entry.value >= 0 && /^img_set_/.test(stringAt(entry.value) || '')) table.sheet = stringAt(entry.value);
        }
      }
    } else if (table && instruction.op === OP.LOADN && list[i + 1] && list[i + 1].op === OP.LOADN && list[i + 2] && list[i + 2].op === OP.CALL && list[i + 3] && list[i + 3].op === OP.SETTABLEKS) {
      const key = stringAt(list[i + 3].aux);
      if (key === 'ImageRectOffset') {
        table.x = instruction.d;
        table.y = list[i + 1].d;
        table.offsetAt = instruction.at;
      } else if (key === 'ImageRectSize') {
        table.w = instruction.d;
        table.h = list[i + 1].d;
        table.sizeAt = instruction.at;
      }
      i += 3;
    } else if (table && instruction.op === OP.SETTABLEKS && instruction.b === 0) {
      const name = stringAt(instruction.aux);
      if (name && table.x !== undefined && table.w !== undefined) images.set(name, table);
      table = null;
    } else if (table && instruction.op === OP.LOADK && list[i + 1] && list[i + 1].op === OP.SETTABLEKS && stringAt(list[i + 1].aux) === 'ImageSet') {
      table.sheet = stringAt(instruction.d);
    }
  }
  return images;
}

function describeConstant(proto, index) {
  const constant = proto.constants[index];
  if (!constant) return `K${index}?`;
  if (constant.type === 'string') return JSON.stringify(constant.value);
  if (constant.type === 'number') return String(constant.value);
  if (constant.type === 'boolean') return String(constant.value);
  return constant.type;
}

module.exports = { parse, instructions, imageEntries, decodeOp, encodeOp, describeConstant, PREFIX, OP, OPCODE_KEY, OPCODE_UNKEY, AUX_OPS };
