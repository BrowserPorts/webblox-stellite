'use strict';

const { KIND, PREFIX_SIMD, PREFIX_ATOMIC, PREFIX_MISC, readInstruction, readU, bodyStart } = require('../wasm/module');

const SMALL_CONSTANT = 1024;
const STRICT_CONSTANT = 65536;
const SKELETON_CONSTANT = 16;
const MIN_HASH_BANDS = 12;
const MIN_HASH_MIN_SIZE = 12;
const SHINGLE = 4;
const SEED_A = 0x9747b28c;
const SEED_B = 0x2545f491;
const TWO_21 = 2097152;

function mix(h, value) {
  let k = Math.imul(value, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

function finish(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function combine(a, b) {
  return finish(a) * TWO_21 + (finish(b) & (TWO_21 - 1));
}

class Hash2 {
  constructor(seedA = SEED_A, seedB = SEED_B) {
    this.a = seedA;
    this.b = seedB;
  }

  add(value) {
    this.a = mix(this.a, value | 0);
    this.b = mix(this.b, (value | 0) ^ 0x5bd1e995);
  }

  addNumber(value) {
    const hi = Math.floor(value / 4294967296);
    this.add(value | 0);
    this.add(hi | 0);
  }

  value() {
    return combine(this.a, this.b);
  }
}

function hashString(text) {
  let a = SEED_A;
  let b = SEED_B;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = mix(a, code);
    b = mix(b, code ^ 0x5bd1e995);
  }
  return combine(a, b);
}

class Interner {
  constructor() {
    this.ids = new Map();
    this.values = [];
  }

  id(value) {
    let id = this.ids.get(value);
    if (id === undefined) {
      id = this.values.length;
      this.ids.set(value, id);
      this.values.push(value);
    }
    return id;
  }
}

class Csr {
  constructor(count) {
    this.offsets = new Uint32Array(count + 1);
    this.values = new Int32Array(1 << 16);
    this.length = 0;
    this.next = 0;
  }

  push(value) {
    if (this.length === this.values.length) {
      const grown = new Int32Array(this.values.length * 2);
      grown.set(this.values);
      this.values = grown;
    }
    this.values[this.length++] = value;
  }

  close(index) {
    this.offsets[index + 1] = this.length;
  }

  size(index) {
    return this.offsets[index + 1] - this.offsets[index];
  }

  list(index) {
    return this.values.subarray(this.offsets[index], this.offsets[index + 1]);
  }
}

function invert(count, targetCount, csr, importCount) {
  const totals = new Uint32Array(targetCount + 1);
  for (let i = 0; i < csr.length; i++) totals[csr.values[i] + 1]++;
  for (let i = 0; i < targetCount; i++) totals[i + 1] += totals[i];
  const out = new Csr(targetCount);
  out.offsets = totals;
  out.values = new Int32Array(csr.length);
  out.length = csr.length;
  const cursor = totals.slice();
  for (let index = 0; index < count; index++) {
    const start = csr.offsets[index];
    const end = csr.offsets[index + 1];
    for (let i = start; i < end; i++) out.values[cursor[csr.values[i]]++] = index + importCount;
  }
  return out;
}

const MIN_HASH_A = new Int32Array(MIN_HASH_BANDS);
const MIN_HASH_B = new Int32Array(MIN_HASH_BANDS);
{
  let state = 0x12345678;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state | 1;
  };
  for (let i = 0; i < MIN_HASH_BANDS; i++) {
    MIN_HASH_A[i] = next();
    MIN_HASH_B[i] = next();
  }
}

class FunctionFeatures {
  constructor(module, image, shared) {
    this.module = module;
    this.image = image;
    this.shared = shared;
    const count = module.definedCount;
    this.count = count;
    this.importCount = module.importCount;
    this.total = module.functionCount;
    this.strict = new Float64Array(this.total);
    this.canon = new Float64Array(this.total);
    this.skeleton = new Float64Array(this.total);
    this.sizes = new Uint32Array(this.total);
    this.signatures = new Int32Array(this.total);
    this.callees = new Csr(count);
    this.addresses = new Csr(count);
    this.strings = new Csr(count);
    this.minHash = new Int32Array(count * MIN_HASH_BANDS);
    this.heapBase = module.globals.length && module.globals[0].value ? module.globals[0].value : image.high;
    this.stringCache = new Map();
    this.typeSignatures = module.types.map(type => shared.signatures.id(type.key));
    for (let func = 0; func < this.total; func++) this.signatures[func] = this.typeSignatures[module.typeOf(func)];
    this.extract();
    this.callers = invert(count, this.total, this.callees, this.importCount);
  }

  stringId(address) {
    let id = this.stringCache.get(address);
    if (id === undefined) {
      const text = this.image.stringAt(address);
      id = text === null ? -1 : this.shared.strings.id(text);
      this.stringCache.set(address, id);
    }
    return id;
  }

  extract() {
    const { module, heapBase } = this;
    const buf = module.buffer;
    const paramCounts = module.types.map(type => type.params.length);
    const signatures = this.typeSignatures;
    const instruction = { op: 0, sub: 0, kind: 0, a: 0, b: 0, align: 0, start: 0, end: 0, wide: 0n };
    const canonicalLocals = new Int32Array(65536);
    const touched = [];
    const shingle = new Int32Array(SHINGLE);
    const minima = new Int32Array(MIN_HASH_BANDS);
    const seenStrings = new Set();
    for (let index = 0; index < this.count; index++) {
      const func = index + this.importCount;
      const start = module.bodyStarts[index];
      const end = start + module.bodySizes[index];
      const params = paramCounts[module.functionTypes[index]];
      let at = bodyStart(buf, start);
      let strictA = SEED_A, strictB = SEED_B;
      let canonA = SEED_A, canonB = SEED_B;
      let skeletonA = SEED_A, skeletonB = SEED_B;
      let size = 0;
      let nextLocal = params;
      minima.fill(0x7fffffff);
      let shingleFill = 0;
      seenStrings.clear();
      while (at < end) {
        readInstruction(buf, at, instruction);
        const opStart = at;
        at = instruction.end;
        size++;
        const op = instruction.op;
        const code = instruction.sub >= 0 ? (op << 12) | instruction.sub : op;
        strictA = mix(strictA, code); strictB = mix(strictB, code ^ 0x5bd1e995);
        canonA = mix(canonA, code); canonB = mix(canonB, code ^ 0x5bd1e995);
        skeletonA = mix(skeletonA, code); skeletonB = mix(skeletonB, code ^ 0x5bd1e995);
        let strictValue = 0, canonValue = 0, skeletonValue = 0, hasValue = false, hasSkeleton = false;
        switch (instruction.kind) {
          case KIND.NONE:
            break;
          case KIND.LOCAL: {
            const raw = instruction.a;
            strictValue = raw;
            if (raw < params) canonValue = raw;
            else {
              let mapped = canonicalLocals[raw];
              if (mapped === 0) {
                nextLocal++;
                mapped = nextLocal;
                canonicalLocals[raw] = mapped;
                touched.push(raw);
              }
              canonValue = mapped - 1;
            }
            hasValue = true;
            break;
          }
          case KIND.BLOCK:
          case KIND.TRY_TABLE: {
            const type = instruction.a >= 0 ? signatures[instruction.a] + 1000 : instruction.a;
            strictValue = canonValue = skeletonValue = type;
            hasValue = hasSkeleton = true;
            break;
          }
          case KIND.CALL_INDIRECT: {
            const type = signatures[instruction.a] + 1000;
            strictValue = canonValue = skeletonValue = type;
            hasValue = hasSkeleton = true;
            break;
          }
          case KIND.CALL: {
            this.callees.push(instruction.a);
            const callee = instruction.a;
            const signature = callee < this.importCount ? this.signatures[callee] + 1000 : this.signatures[callee] + 1000;
            strictValue = canonValue = skeletonValue = signature;
            hasValue = hasSkeleton = true;
            break;
          }
          case KIND.MEMARG:
          case KIND.MEMARG_LANE:
            strictValue = canonValue = instruction.a;
            hasValue = true;
            break;
          case KIND.CONST_I32: {
            const value = instruction.a;
            const magnitude = value < 0 ? -value : value;
            const inRange = value >= SMALL_CONSTANT && value < heapBase;
            strictValue = magnitude < STRICT_CONSTANT || !inRange ? value : 0x41444452;
            canonValue = inRange ? 0x4b4b4b4b : value;
            skeletonValue = magnitude < SKELETON_CONSTANT ? value : 0x4b4b4b4b;
            hasValue = hasSkeleton = true;
            if (inRange) {
              if (value >= STRICT_CONSTANT) this.addresses.push(value);
              const stringId = this.stringId(value);
              if (stringId >= 0 && !seenStrings.has(stringId)) {
                seenStrings.add(stringId);
                this.strings.push(stringId);
              }
            }
            break;
          }
          case KIND.CONST_I64: {
            const wide = instruction.wide;
            strictValue = canonValue = mix(Number(BigInt.asIntN(32, wide)), Number(BigInt.asIntN(32, wide >> 32n)));
            skeletonValue = 0x4b4b4b4c;
            hasValue = hasSkeleton = true;
            break;
          }
          case KIND.CONST_F32:
            strictValue = canonValue = instruction.a;
            skeletonValue = 0x4b4b4b4d;
            hasValue = hasSkeleton = true;
            break;
          case KIND.CONST_F64:
            strictValue = canonValue = mix(instruction.a, instruction.b);
            skeletonValue = 0x4b4b4b4e;
            hasValue = hasSkeleton = true;
            break;
          case KIND.BR_TABLE:
          case KIND.SELECT_TYPED:
          case KIND.BYTES16:
            for (let i = opStart; i < at; i++) {
              strictA = mix(strictA, buf[i]); strictB = mix(strictB, buf[i] ^ 0x5bd1e995);
              canonA = mix(canonA, buf[i]); canonB = mix(canonB, buf[i] ^ 0x5bd1e995);
            }
            break;
          case KIND.INDEX:
          case KIND.GLOBAL:
          case KIND.HEAP_TYPE:
          case KIND.BYTE:
          case KIND.LANE:
            strictValue = canonValue = skeletonValue = instruction.a;
            hasValue = hasSkeleton = true;
            break;
          case KIND.TWO_INDEXES:
            strictValue = canonValue = skeletonValue = (instruction.a * 31 + instruction.b) | 0;
            hasValue = hasSkeleton = true;
            break;
          case KIND.REF_FUNC:
            strictValue = canonValue = skeletonValue = 0x52454646;
            hasValue = hasSkeleton = true;
            break;
          default:
            break;
        }
        if (hasValue) {
          strictA = mix(strictA, strictValue); strictB = mix(strictB, strictValue ^ 0x5bd1e995);
          canonA = mix(canonA, canonValue); canonB = mix(canonB, canonValue ^ 0x5bd1e995);
        }
        if (hasSkeleton) {
          skeletonA = mix(skeletonA, skeletonValue); skeletonB = mix(skeletonB, skeletonValue ^ 0x5bd1e995);
        }
        const token = mix(code, hasSkeleton ? skeletonValue : 0);
        shingle[shingleFill % SHINGLE] = token;
        shingleFill++;
        if (shingleFill >= SHINGLE) {
          let gram = 0;
          for (let i = 0; i < SHINGLE; i++) gram = mix(gram, shingle[(shingleFill + i) % SHINGLE]);
          for (let band = 0; band < MIN_HASH_BANDS; band++) {
            const value = (Math.imul(gram, MIN_HASH_A[band]) + MIN_HASH_B[band]) >>> 1;
            if (value < minima[band]) minima[band] = value;
          }
        }
      }
      for (let i = 0; i < touched.length; i++) canonicalLocals[touched[i]] = 0;
      touched.length = 0;
      this.strict[func] = combine(strictA, strictB);
      this.canon[func] = combine(canonA, canonB);
      this.skeleton[func] = combine(skeletonA, skeletonB);
      this.sizes[func] = size;
      this.minHash.set(minima, index * MIN_HASH_BANDS);
      this.callees.close(index);
      this.addresses.close(index);
      this.strings.close(index);
    }
  }

  calleesOf(func) {
    return func < this.importCount ? EMPTY : this.callees.list(func - this.importCount);
  }

  callersOf(func) {
    return this.callers.list(func);
  }

  addressesOf(func) {
    return func < this.importCount ? EMPTY : this.addresses.list(func - this.importCount);
  }

  stringsOf(func) {
    return func < this.importCount ? EMPTY : this.strings.list(func - this.importCount);
  }

  minHashOf(func) {
    const at = (func - this.importCount) * MIN_HASH_BANDS;
    return this.minHash.subarray(at, at + MIN_HASH_BANDS);
  }
}

const EMPTY = new Int32Array(0);

class SharedTables {
  constructor() {
    this.signatures = new Interner();
    this.strings = new Interner();
  }
}

function minHashSimilarity(a, b) {
  let same = 0;
  for (let i = 0; i < MIN_HASH_BANDS; i++) if (a[i] === b[i]) same++;
  return same / MIN_HASH_BANDS;
}

module.exports = {
  FunctionFeatures,
  SharedTables,
  Hash2,
  Interner,
  Csr,
  hashString,
  mix,
  finish,
  combine,
  minHashSimilarity,
  MIN_HASH_BANDS,
  MIN_HASH_MIN_SIZE,
  SMALL_CONSTANT,
  STRICT_CONSTANT,
  PREFIX_MISC,
  PREFIX_SIMD,
  PREFIX_ATOMIC,
  readU,
};
