'use strict';

const { readInstruction, bodyStart } = require('../autoport/wasm/module');

const OP = {
  UNREACHABLE: 0x00, NOP: 0x01, BLOCK: 0x02, LOOP: 0x03, IF: 0x04, ELSE: 0x05, END: 0x0b, BR: 0x0c, BR_IF: 0x0d, BR_TABLE: 0x0e, RETURN: 0x0f,
  CALL: 0x10, CALL_INDIRECT: 0x11, RETURN_CALL: 0x12, DROP: 0x1a, SELECT: 0x1b, SELECT_TYPED: 0x1c,
  LOCAL_GET: 0x20, LOCAL_SET: 0x21, LOCAL_TEE: 0x22, GLOBAL_GET: 0x23, GLOBAL_SET: 0x24,
  MEMORY_SIZE: 0x3f, MEMORY_GROW: 0x40, I32_CONST: 0x41, I64_CONST: 0x42, F32_CONST: 0x43, F64_CONST: 0x44,
  I32_ADD: 0x6a, I32_SUB: 0x6b, I32_MUL: 0x6c, I32_AND: 0x71, I32_OR: 0x72, I32_SHL: 0x74, I32_SHR_U: 0x76,
  MISC: 0xfc, SIMD: 0xfd,
};
const LOADS = {
  0x28: { size: 4 }, 0x29: { size: 8, wide: true }, 0x2a: { size: 4, opaque: true }, 0x2b: { size: 8, opaque: true },
  0x2c: { size: 1, signed: true }, 0x2d: { size: 1 }, 0x2e: { size: 2, signed: true }, 0x2f: { size: 2 },
  0x30: { size: 1, opaque: true }, 0x31: { size: 1, opaque: true }, 0x32: { size: 2, opaque: true }, 0x33: { size: 2, opaque: true }, 0x34: { size: 4, opaque: true }, 0x35: { size: 4, opaque: true },
};
const STORES = { 0x36: 4, 0x37: 8, 0x38: 4, 0x39: 8, 0x3a: 1, 0x3b: 2, 0x3c: 1, 0x3d: 2, 0x3e: 4 };
const SIMD_LOAD = 0;
const SIMD_STORE = 11;
const SIMD_CONST = 12;
const MISC_MEMORY_COPY = 10;
const MISC_MEMORY_FILL = 11;
const SSO_LONG_BIT = 0x80;
const SSO_SIZE_BYTE = 11;
const MAX_STRING = 4096;
const UNKNOWN_BYTE = -1;

const CONSTANT = value => ({ kind: 'constant', value: value | 0 });
const WIDE = value => ({ kind: 'wide', value });
const RAW = bytes => ({ kind: 'raw', bytes });
const POINTER = (base, offset) => ({ kind: 'pointer', base, offset });
const UNKNOWN = Object.freeze({ kind: 'unknown' });

function isUnary(op) {
  return op === 0x45 || op === 0x50 || (op >= 0x67 && op <= 0x69) || (op >= 0x79 && op <= 0x7b) || (op >= 0x8b && op <= 0x91) || (op >= 0x99 && op <= 0x9f) || (op >= 0xa7 && op <= 0xc4);
}

function isBinary(op) {
  return (op >= 0x46 && op <= 0x4f) || (op >= 0x51 && op <= 0x66) || (op >= 0x6a && op <= 0x78) || (op >= 0x7c && op <= 0x8a) || (op >= 0x92 && op <= 0x98) || (op >= 0xa0 && op <= 0xa6);
}

function bytesOf(value, size) {
  if (value.kind === 'constant') {
    const out = Buffer.alloc(Math.max(4, size));
    out.writeInt32LE(value.value);
    return out.subarray(0, size);
  }
  if (value.kind === 'wide') {
    const out = Buffer.alloc(Math.max(8, size));
    out.writeBigInt64LE(BigInt.asIntN(64, value.value));
    return out.subarray(0, size);
  }
  if (value.kind === 'raw') {
    const out = Buffer.alloc(size);
    value.bytes.copy(out, 0, 0, Math.min(size, value.bytes.length));
    return out;
  }
  return null;
}

class Memory {
  constructor(image) {
    this.image = image;
    this.bytes = new Map();
    this.pointers = new Map();
  }

  key(base, offset) {
    return base === null ? offset : `${base}:${offset}`;
  }

  write(base, offset, value, size) {
    if (value.kind === 'pointer' && size === 4) {
      for (let i = 0; i < 4; i++) this.bytes.set(this.key(base, offset + i), UNKNOWN_BYTE);
      this.pointers.set(this.key(base, offset), value);
      return;
    }
    const data = bytesOf(value, size);
    for (let i = 0; i < size; i++) {
      const key = this.key(base, offset + i);
      this.pointers.delete(key);
      this.bytes.set(key, data ? data[i] : UNKNOWN_BYTE);
    }
  }

  writeBuffer(base, offset, data) {
    for (let i = 0; i < data.length; i++) {
      const key = this.key(base, offset + i);
      this.pointers.delete(key);
      this.bytes.set(key, data[i]);
    }
  }

  byte(base, offset) {
    const known = this.bytes.get(this.key(base, offset));
    if (known !== undefined) return known === UNKNOWN_BYTE ? null : known;
    if (base !== null) return null;
    const at = offset - this.image.low;
    return at >= 0 && at < this.image.bytes.length ? this.image.bytes[at] : null;
  }

  slice(base, offset, size) {
    const out = Buffer.alloc(size);
    for (let i = 0; i < size; i++) {
      const byte = this.byte(base, offset + i);
      if (byte === null) return null;
      out[i] = byte;
    }
    return out;
  }

  read(base, offset, size, { signed = false, wide = false } = {}) {
    if (size === 4) {
      const pointer = this.pointers.get(this.key(base, offset));
      if (pointer) return pointer;
    }
    const data = this.slice(base, offset, size);
    if (!data) return UNKNOWN;
    if (size === 16) return RAW(data);
    if (size === 8) return wide ? WIDE(data.readBigInt64LE(0)) : RAW(data);
    if (size === 4) return CONSTANT(data.readInt32LE(0));
    if (size === 2) return CONSTANT(signed ? data.readInt16LE(0) : data.readUInt16LE(0));
    return CONSTANT(signed ? data.readInt8(0) : data[0]);
  }

  word(base, offset) {
    const value = this.read(base, offset, 4);
    return value.kind === 'constant' ? value.value >>> 0 : null;
  }

  cString(address) {
    const chars = [];
    for (let i = 0; i < MAX_STRING; i++) {
      const byte = this.byte(null, address + i);
      if (byte === null) return null;
      if (byte === 0) return Buffer.from(chars).toString('latin1');
      chars.push(byte);
    }
    return null;
  }

  stdString(location) {
    if (!location || (location.kind !== 'pointer' && location.kind !== 'constant')) return null;
    const base = location.kind === 'pointer' ? location.base : null;
    const offset = location.kind === 'pointer' ? location.offset : location.value >>> 0;
    const flag = this.byte(base, offset + SSO_SIZE_BYTE);
    if (flag === null) return null;
    if (!(flag & SSO_LONG_BIT)) {
      const data = this.slice(base, offset, flag);
      return data ? data.toString('latin1') : null;
    }
    const size = this.word(base, offset + 4);
    if (size === null || size > MAX_STRING) return null;
    const data = this.read(base, offset, 4);
    if (data.kind === 'pointer') {
      const text = this.slice(data.base, data.offset, size);
      return text ? text.toString('latin1') : null;
    }
    if (data.kind === 'constant') {
      const text = this.slice(null, data.value >>> 0, size);
      return text ? text.toString('latin1') : null;
    }
    return null;
  }
}

class Machine {
  constructor(module, image, { maxSteps = 50e6, maxDepth = 3 } = {}) {
    this.module = module;
    this.memory = new Memory(image);
    this.maxSteps = maxSteps;
    this.maxDepth = maxDepth;
    this.steps = 0;
    this.frames = 0;
    this.regions = 0;
    this.exhausted = false;
  }

  locate(address, offset) {
    if (address.kind === 'pointer') return { base: address.base, offset: address.offset + offset };
    if (address.kind === 'constant') return { base: null, offset: (address.value >>> 0) + offset };
    return null;
  }

  run(func, args = [], hooks = {}, depth = 0) {
    const module = this.module;
    const buf = module.buffer;
    if (func < module.importCount) return;
    const { start, end } = module.bodyBounds(func);
    const frame = `f${this.frames++}`;
    const locals = new Map();
    args.forEach((value, index) => locals.set(index, value));
    const stack = [];
    const pop = () => (stack.length ? stack.pop() : UNKNOWN);
    const popMany = count => {
      const values = new Array(count);
      for (let i = count - 1; i >= 0; i--) values[i] = pop();
      return values;
    };
    let at = bodyStart(buf, start);
    while (at < end) {
      if (++this.steps > this.maxSteps) {
        this.exhausted = true;
        return;
      }
      const instruction = readInstruction(buf, at, {});
      at = instruction.end;
      const { op, sub } = instruction;
      if (op === OP.I32_CONST) {
        stack.push(CONSTANT(instruction.a));
        continue;
      }
      if (op === OP.I64_CONST) {
        stack.push(WIDE(instruction.wide));
        continue;
      }
      if (op === OP.F32_CONST || op === OP.F64_CONST) {
        stack.push(UNKNOWN);
        continue;
      }
      if (op === OP.LOCAL_GET) {
        stack.push(locals.get(instruction.a) || UNKNOWN);
        continue;
      }
      if (op === OP.LOCAL_SET) {
        locals.set(instruction.a, pop());
        continue;
      }
      if (op === OP.LOCAL_TEE) {
        const value = pop();
        locals.set(instruction.a, value);
        stack.push(value);
        continue;
      }
      if (op === OP.GLOBAL_GET) {
        stack.push(instruction.a === 0 ? POINTER(frame, 0) : UNKNOWN);
        continue;
      }
      if (op === OP.GLOBAL_SET || op === OP.DROP || op === OP.IF || op === OP.BR_IF || op === OP.BR_TABLE) {
        pop();
        continue;
      }
      if (op === OP.SELECT || op === OP.SELECT_TYPED) {
        popMany(3);
        stack.push(UNKNOWN);
        continue;
      }
      if (op === OP.MEMORY_SIZE) {
        stack.push(UNKNOWN);
        continue;
      }
      if (op === OP.MEMORY_GROW) {
        pop();
        stack.push(UNKNOWN);
        continue;
      }
      if (op === OP.CALL || op === OP.RETURN_CALL || op === OP.CALL_INDIRECT) {
        const type = op === OP.CALL_INDIRECT ? module.types[instruction.a] : module.signature(instruction.a);
        if (op === OP.CALL_INDIRECT) pop();
        const passed = popMany(type.params.length);
        if (op !== OP.CALL_INDIRECT) {
          const decision = hooks.call ? hooks.call(instruction.a, passed, depth, this) : null;
          if (decision === 'descend' && depth < this.maxDepth) this.run(instruction.a, passed, hooks, depth + 1);
        }
        for (const result of type.results) stack.push(result === 0x7f ? POINTER(`r${this.regions++}`, 0) : UNKNOWN);
        continue;
      }
      if (LOADS[op]) {
        const spec = LOADS[op];
        const place = this.locate(pop(), instruction.a);
        stack.push(place && !spec.opaque ? this.memory.read(place.base, place.offset, spec.size, spec) : UNKNOWN);
        continue;
      }
      if (STORES[op]) {
        const value = pop();
        const place = this.locate(pop(), instruction.a);
        if (place) {
          this.memory.write(place.base, place.offset, value, STORES[op]);
          if (hooks.store) hooks.store(place, value, STORES[op], this);
        }
        continue;
      }
      if (op === OP.I32_ADD || op === OP.I32_SUB || op === OP.I32_MUL || op === OP.I32_AND || op === OP.I32_OR || op === OP.I32_SHL || op === OP.I32_SHR_U) {
        const right = pop();
        const left = pop();
        if (left.kind === 'constant' && right.kind === 'constant') {
          const a = left.value;
          const b = right.value;
          const result = op === OP.I32_ADD ? a + b : op === OP.I32_SUB ? a - b : op === OP.I32_MUL ? Math.imul(a, b) : op === OP.I32_AND ? a & b : op === OP.I32_OR ? a | b : op === OP.I32_SHL ? a << (b & 31) : a >>> (b & 31);
          stack.push(CONSTANT(result));
        } else if (left.kind === 'pointer' && right.kind === 'constant' && (op === OP.I32_ADD || op === OP.I32_SUB)) {
          stack.push(POINTER(left.base, left.offset + (op === OP.I32_ADD ? right.value : -right.value)));
        } else if (left.kind === 'constant' && right.kind === 'pointer' && op === OP.I32_ADD) {
          stack.push(POINTER(right.base, right.offset + left.value));
        } else {
          stack.push(UNKNOWN);
        }
        continue;
      }
      if (isBinary(op)) {
        popMany(2);
        stack.push(UNKNOWN);
        continue;
      }
      if (isUnary(op)) {
        pop();
        stack.push(UNKNOWN);
        continue;
      }
      if (op === OP.SIMD) {
        if (sub === SIMD_CONST) {
          stack.push(RAW(Buffer.from(buf.subarray(at - 16, at))));
          continue;
        }
        if (sub === SIMD_LOAD) {
          const place = this.locate(pop(), instruction.a);
          stack.push(place ? this.memory.read(place.base, place.offset, 16) : UNKNOWN);
          continue;
        }
        if (sub === SIMD_STORE) {
          const value = pop();
          const place = this.locate(pop(), instruction.a);
          if (place) this.memory.write(place.base, place.offset, value, 16);
          continue;
        }
        stack.length = 0;
        continue;
      }
      if (op === OP.MISC) {
        if (sub === MISC_MEMORY_COPY) {
          const [target, source, size] = popMany(3);
          const to = this.locate(target, 0);
          const from = this.locate(source, 0);
          if (to && from && size.kind === 'constant' && size.value >= 0 && size.value <= MAX_STRING) {
            const data = this.memory.slice(from.base, from.offset, size.value);
            if (data) this.memory.writeBuffer(to.base, to.offset, data);
            else for (let i = 0; i < size.value; i++) this.memory.write(to.base, to.offset + i, UNKNOWN, 1);
          }
          continue;
        }
        if (sub === MISC_MEMORY_FILL) {
          const [target, value, size] = popMany(3);
          const to = this.locate(target, 0);
          if (to && value.kind === 'constant' && size.kind === 'constant' && size.value >= 0 && size.value <= MAX_STRING) {
            this.memory.writeBuffer(to.base, to.offset, Buffer.alloc(size.value, value.value & 0xff));
          }
          continue;
        }
        if (sub <= 7) {
          pop();
          stack.push(UNKNOWN);
          continue;
        }
        stack.length = 0;
        continue;
      }
      if (op === OP.UNREACHABLE || op === OP.NOP || op === OP.BLOCK || op === OP.LOOP || op === OP.ELSE || op === OP.END || op === OP.BR || op === OP.RETURN) continue;
      stack.length = 0;
    }
  }
}

module.exports = { Machine, Memory, CONSTANT, POINTER, UNKNOWN };
