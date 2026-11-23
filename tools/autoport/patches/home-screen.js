'use strict';

const crypto = require('crypto');
const { uleb, sleb, readInstruction, bodyStart, KIND, SECTION } = require('../wasm/module');
const { wasmSections, vecEntries, readLeb, codeBodies, spliceBackport } = require('../wasm/splice');
const { MemoryImage } = require('../wasm/image');
const { encode, seq, i32, call, store8, hole: v, findAll } = require('../wasm/asm');
const { PortError, value } = require('../context');
const { HOW, HOW_NAMES } = require('../match/matcher');

const MAIN_EXIT_TEXT = '[LIFECYCLE] no startup place id; exiting\n';
const ASYNC_JS_IMPORT = 'emscripten_asm_const_async_on_main_thread';
const NOP = 0x01;
const LOCAL_GET = 0x20;
const LOCAL_SET = 0x21;
const LOCAL_TEE = 0x22;
const I32_LOAD = 0x28;
const I32_STORE = 0x36;
const I32_CONST = 0x41;
const MAX_VTABLE_BYTES = 1024;
const WEAK_MATCHES = new Set([HOW.FUZZY, HOW.TWIN]);

function sha(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function parseBodies(bin) {
  const sections = wasmSections(bin);
  const code = codeBodies(sections.find(section => section.id === SECTION.CODE).body);
  const functionSection = sections.find(section => section.id === SECTION.FUNCTION).body;
  const types = [];
  const { count, start } = vecEntries(functionSection);
  for (let n = 0, at = start; n < count; n++) {
    const [type, next] = readLeb(functionSection, at);
    types.push(type);
    at = next;
  }
  const bodies = code.map((entry, index) => {
    const [size, begin] = readLeb(entry, 0);
    return { bytes: entry.subarray(begin, begin + size), type: types[index] };
  });
  return { bodies, typeSection: sections.find(section => section.id === SECTION.TYPE).body };
}

function encodeType(type) {
  return Buffer.concat([uleb(type)]);
}

class HomeScreenPort {
  constructor(ctx, plan, bodiesBin) {
    this.ctx = ctx;
    this.plan = plan;
    this.parsed = parseBodies(bodiesBin);
    this.oldModule = ctx.oldModule;
    this.module = ctx.newModule;
    this.oldImage = ctx.identity ? new MemoryImage(this.oldModule) : ctx.matcher.from.image;
    this.newImage = ctx.identity ? this.oldImage : ctx.matcher.to.image;
    this.problems = [];
    this.warnings = [];
    this.extraStrings = new Map();
    this.extraTable = [];
    this.heapBase = this.findHeapBase();
    this.oldTableEnd = this.tableEnd(this.oldModule);
    this.newTableEnd = this.tableEnd(this.module);
    this.oldFunctionEnd = this.oldModule.functionCount;
    this.newFunctionEnd = this.module.functionCount;
    this.strings = new Map();
  }

  tableEnd(module) {
    return Math.max(...module.elementSegments.map(segment => segment.base + segment.functions.length));
  }

  findHeapBase() {
    const candidate = this.module.globals[0] && this.module.globals[0].value;
    if (!candidate) throw new PortError('the first global no longer holds the heap start');
    return candidate;
  }

  problem(kind, detail) {
    this.problems.push({ kind, ...detail });
  }

  noteInferred(oldFunc, inferred) {
    if (!this.inferred) this.inferred = new Set();
    if (this.inferred.has(oldFunc)) return;
    this.inferred.add(oldFunc);
    this.warnings.push(`function ${oldFunc} has no direct match, so it maps to ${inferred.value} from ${inferred.how} (${inferred.detail})`);
  }

  mapFunction(oldFunc, where) {
    if (oldFunc >= this.oldFunctionEnd) return this.newFunctionEnd + (oldFunc - this.oldFunctionEnd);
    if (oldFunc < this.oldModule.importCount) {
      const name = this.oldModule.functionImports[oldFunc].name;
      const index = this.module.importIndexByName.get(name);
      if (index === undefined) this.problem('import', { name, where });
      return index === undefined ? 0 : index;
    }
    if (this.ctx.identity) return oldFunc;
    const target = this.ctx.matcher.map[oldFunc];
    if (target < 0) {
      const inferred = this.ctx.inferFunction(oldFunc);
      if (inferred) {
        this.noteInferred(oldFunc, inferred);
        return inferred.value;
      }
      this.problem('function', { old: oldFunc, where, size: this.ctx.matcher.from.sizes[oldFunc] });
      return 0;
    }
    if (!WEAK_MATCHES.has(this.ctx.matcher.how[oldFunc])) return target;
    if (!this.weakChecked) this.weakChecked = new Map();
    if (!this.weakChecked.has(oldFunc)) {
      const how = HOW_NAMES[this.ctx.matcher.how[oldFunc]];
      const unchanged = this.ctx.matcher.from.canon[oldFunc] === this.ctx.matcher.to.canon[target];
      const verdict = unchanged ? { keep: true, detail: 'same code' } : this.ctx.reconsiderFunction(oldFunc, target);
      if (!verdict.keep) this.warnings.push(`function ${oldFunc} (${where}) had a ${how} match to ${target}, but ${verdict.detail}, so it maps to ${verdict.value}`);
      else if (!verdict.detail) this.warnings.push(`function ${oldFunc} (${where}) maps to ${target} by a ${how} match that nothing else confirms`);
      this.weakChecked.set(oldFunc, verdict.keep ? target : verdict.value);
    }
    return this.weakChecked.get(oldFunc);
  }

  mapType(oldType, where) {
    const type = this.oldModule.types[oldType];
    const index = this.module.typeIndexByKey.get(type.key);
    if (index === undefined) {
      this.problem('type', { key: type.key, where });
      return 0;
    }
    return index;
  }

  mapSlot(oldSlot, where) {
    if (oldSlot >= this.oldTableEnd) {
      const offset = oldSlot - this.oldTableEnd;
      if (offset >= this.plan.tableAdd.length) throw new PortError(`slot ${oldSlot} is past the backport's own table entries`);
      return this.newTableEnd + offset;
    }
    const func = this.oldModule.slotFunctions.get(oldSlot);
    if (func === undefined) {
      this.problem('slot', { old: oldSlot, where });
      return 0;
    }
    const target = this.mapFunction(func, `slot ${oldSlot} in ${where}`);
    const slot = this.module.tableSlots.get(target);
    if (slot !== undefined) return slot;
    let position = this.extraTable.indexOf(target);
    if (position < 0) {
      position = this.extraTable.length;
      this.extraTable.push(target);
    }
    return this.newTableEnd + this.plan.tableAdd.length + position;
  }

  mapOwn(address) {
    return address - this.plan.dataBase + this.heapBase;
  }

  mapString(address, where) {
    const whole = this.oldImage.wholeStringAt(address);
    if (!whole) {
      this.problem('string', { old: address, where, reason: 'the old address no longer reads as text' });
      return 0;
    }
    const cached = this.strings.get(whole.text);
    if (cached !== undefined) return cached + whole.offset;
    if (this.ctx.identity) {
      this.strings.set(whole.text, whole.start);
      return address;
    }
    const hits = this.newImage.findString(whole.text);
    if (hits.length) {
      this.strings.set(whole.text, hits[0]);
      return hits[0] + whole.offset;
    }
    this.extraStrings.set(whole.text, null);
    return { pendingString: whole.text, offset: whole.offset };
  }

  mapAddress(address, where) {
    const resolved = this.ctx.resolveAddress(address);
    if (!resolved) {
      this.problem('address', { old: address, where });
      return 0;
    }
    if (resolved.how.includes('layout')) this.warnings.push(`address ${address} (${where}) was placed at ${resolved.value} from the ${resolved.how}`);
    else if (resolved.how === 'code roles' && !this.roleNoted?.has(address)) {
      (this.roleNoted || (this.roleNoted = new Set())).add(address);
      this.warnings.push(`address ${address} maps to ${resolved.value} by matching how the code uses it (${resolved.votes} vote(s)), because the compiler reordered the instructions around it`);
    }
    return resolved.value;
  }

  translateConstant(constant, kind, where) {
    if (constant >= this.plan.dataBase && constant < this.plan.dataBase + this.plan.reserve) return this.mapOwn(constant);
    switch (kind) {
      case 'own': return this.mapOwn(constant);
      case 'slot': return this.mapSlot(constant, where);
      case 'string': return this.mapString(constant, where);
      case 'address': return this.mapAddress(constant, where);
      default: throw new PortError(`unknown relocation kind ${kind}`);
    }
  }

  singletonVtable(module, image, func) {
    if (func < module.importCount || func >= module.functionCount) return null;
    const decoded = module.decode(func);
    const result = decoded[decoded.length - 2];
    if (!result || result.op !== I32_CONST) return null;
    for (let i = 0; i + 2 < decoded.length; i++) {
      const [object, value, write] = [decoded[i], decoded[i + 1], decoded[i + 2]];
      if (object.op === I32_CONST && object.a === result.a && value.op === I32_CONST && write.op === I32_STORE && write.a === 0 && image.contains(value.a)) return value.a;
    }
    return null;
  }

  vtableMethods(module, image, vtable) {
    const methods = [];
    for (let offset = 0; offset < MAX_VTABLE_BYTES; offset += 4) {
      const word = image.word(vtable + offset);
      if (word === null) break;
      const func = module.slotFunctions.get(word);
      if (func === undefined && word !== 0) break;
      methods.push(func === undefined ? -1 : func);
    }
    return methods;
  }

  translateVtableOffset(oldGetter, offset, where) {
    const oldVtable = this.singletonVtable(this.oldModule, this.oldImage, oldGetter);
    if (oldVtable === null) return offset;
    const newGetter = this.mapFunction(oldGetter, where);
    const newVtable = this.singletonVtable(this.module, this.newImage, newGetter);
    const label = `the virtual call at offset ${offset} on the object from function ${oldGetter} (${where})`;
    if (newVtable === null) {
      this.problem('vtable', { old: offset, where: label, reason: `function ${newGetter} no longer stores a vtable this tool can read` });
      return offset;
    }
    const oldMethod = this.oldModule.slotFunctions.get(this.oldImage.word(oldVtable + offset));
    if (oldMethod === undefined) {
      this.problem('vtable', { old: offset, where: label, reason: 'the old vtable has no function there' });
      return offset;
    }
    const target = this.mapFunction(oldMethod, label);
    const hits = [];
    this.vtableMethods(this.module, this.newImage, newVtable).forEach((func, index) => {
      if (func === target) hits.push(index * 4);
    });
    if (hits.length === 1) {
      if (hits[0] !== offset) this.warnings.push(`Roblox changed the vtable of the object from function ${oldGetter}, so ${label} now calls offset ${hits[0]}`);
      return hits[0];
    }
    if (hits.includes(offset)) return offset;
    this.problem('vtable', { old: offset, where: label, reason: `the new vtable holds the method ${target} in ${hits.length} places` });
    return offset;
  }

  receiversOf(list) {
    const receivers = new Map();
    const writes = new Map();
    list.forEach((instruction, index) => {
      if (instruction.op !== LOCAL_SET && instruction.op !== LOCAL_TEE) return;
      writes.set(instruction.a, (writes.get(instruction.a) || 0) + 1);
      const previous = list[index - 1];
      if (previous && previous.op === 0x10) receivers.set(instruction.a, previous.a);
    });
    for (const local of [...receivers.keys()]) if (writes.get(local) !== 1) receivers.delete(local);
    return receivers;
  }

  translateBody(index) {
    const { bytes } = this.parsed.bodies[index];
    const relocations = new Map(this.plan.relocations.bodies[index]);
    const code = bodyStart(bytes, 0);
    const parts = [bytes.subarray(0, code)];
    const list = [];
    for (let at = code; at < bytes.length;) {
      const decoded = {};
      readInstruction(bytes, at, decoded);
      list.push(decoded);
      at = decoded.end;
    }
    const receivers = this.receiversOf(list);
    let at = code;
    let position = 0;
    const where = `backport function ${index}`;
    const instruction = {};
    while (at < bytes.length) {
      readInstruction(bytes, at, instruction);
      const start = at;
      at = instruction.end;
      const raw = bytes.subarray(start, at);
      const op = instruction.op;
      const next = list[position + 1];
      const vptr = list[position - 1];
      const receiver = list[position - 2];
      if (op === I32_LOAD && next && next.op === 0x11 && vptr && vptr.op === I32_LOAD && vptr.a === 0 && receiver && receiver.op === LOCAL_GET && receivers.has(receiver.a)) {
        const offset = this.translateVtableOffset(receivers.get(receiver.a), instruction.a, where);
        parts.push(Buffer.from([op]), uleb(instruction.align), uleb(offset));
      } else if (op === 0x10 || op === 0x12) {
        parts.push(Buffer.from([op]), uleb(this.mapFunction(instruction.a, where)));
      } else if (op === 0x11 || op === 0x13) {
        parts.push(Buffer.from([op]), uleb(this.mapType(instruction.a, where)), uleb(instruction.b));
      } else if (instruction.kind === KIND.BLOCK || instruction.kind === KIND.TRY_TABLE) {
        if (instruction.a >= 0) {
          parts.push(Buffer.from([op]), sleb(this.mapType(instruction.a, where)));
          parts.push(bytes.subarray(start + 1 + this.blockTypeSize(bytes, start + 1), at));
        } else {
          parts.push(raw);
        }
      } else if (op === 0x41 && relocations.has(position)) {
        const translated = this.translateConstant(instruction.a, relocations.get(position), where);
        if (translated && translated.pendingString !== undefined) parts.push({ pending: translated });
        else parts.push(Buffer.from([0x41]), sleb(translated));
      } else if (instruction.kind === KIND.GLOBAL && instruction.a !== 0) {
        this.problem('global', { index: instruction.a, where });
        parts.push(raw);
      } else if (instruction.kind === KIND.REF_FUNC) {
        throw new PortError('the backport uses ref.func, which this tool does not translate');
      } else {
        parts.push(raw);
      }
      position++;
    }
    return parts;
  }

  blockTypeSize(bytes, at) {
    let size = 1;
    while (bytes[at + size - 1] & 0x80) size++;
    return size;
  }

  buildBlob() {
    const blob = Buffer.from(this.plan.dataHex, 'hex');
    for (const at of this.plan.relocations.dataSlots) {
      blob.writeUInt32LE(this.mapSlot(blob.readUInt32LE(at), `backport data at ${at}`), at);
    }
    const parts = [blob];
    let size = blob.length;
    for (const text of this.extraStrings.keys()) {
      const bytes = Buffer.from(`${text}\0`, 'latin1');
      this.extraStrings.set(text, this.heapBase + size);
      this.strings.set(text, this.heapBase + size);
      parts.push(bytes);
      size += bytes.length;
    }
    if (size > this.plan.ownDataLimit) throw new PortError(`the backport data grew to ${size} bytes, past the ${this.plan.ownDataLimit} byte area it has`);
    return Buffer.concat(parts);
  }

  mainPatch() {
    const { ctx, plan, module } = this;
    const main = ctx.identity ? plan.mainIndex : ctx.matcher.map[plan.mainIndex];
    if (main === undefined || main < 0) throw new PortError('no match for main');
    const messages = this.newImage.findString(MAIN_EXIT_TEXT);
    const decoded = module.decode(main);
    const asyncCall = module.importIndexByName.get(ASYNC_JS_IMPORT);
    if (asyncCall === undefined) throw new PortError(`the engine no longer imports ${ASYNC_JS_IMPORT}`);
    const pattern = seq(i32(v('message')), i32(0), call(v('print')), i32(v('code')), i32(v('signature')), i32(0), call(asyncCall), i32(v('exitFlag')), i32(1), store8());
    let hits = findAll(decoded, pattern);
    if (messages.length) hits = hits.filter(hit => messages.includes(value(hit.bindings, 'message')));
    if (hits.length !== 1) throw new PortError(`the "no startup place" exit in main matched ${hits.length} places`, { symbol: 'MAIN' });
    const hit = hits[0];
    const base = module.bodyBounds(main).start;
    const body = module.body(main);
    const patternBytes = body.subarray(hit.start - base, hit.end - base);
    const replacement = Buffer.concat([encode(call(this.homeIndex))]);
    if (replacement.length > patternBytes.length) throw new PortError('the home screen call does not fit in place of the main exit');
    const padded = Buffer.alloc(patternBytes.length, NOP);
    replacement.copy(padded);
    return { main, patternHex: patternBytes.toString('hex'), replacementHex: padded.toString('hex') };
  }

  run() {
    const { plan, module } = this;
    const count = this.parsed.bodies.length;
    const order = plan.order.map((target, index) => {
      if (target >= this.oldFunctionEnd) return this.newFunctionEnd + (target - this.oldFunctionEnd);
      let mapped = this.ctx.identity ? target : this.ctx.matcher.map[target];
      if ((mapped === undefined || mapped < 0) && !this.ctx.identity) {
        const inferred = this.ctx.inferFunction(target);
        if (inferred) {
          this.noteInferred(target, inferred);
          mapped = inferred.value;
        }
      }
      if (mapped === undefined || mapped < 0) {
        this.problem('stub', { old: target, index });
        return -1;
      }
      return mapped;
    });
    this.homeIndex = order[count - 1];
    const translated = [];
    for (let index = 0; index < count; index++) translated.push(this.translateBody(index));
    const blob = this.buildBlob();
    const tableAdd = plan.tableAdd.map(func => (func >= this.oldFunctionEnd ? this.newFunctionEnd + (func - this.oldFunctionEnd) : this.mapFunction(func, 'table entry')));
    if (this.problems.length) return { ok: false, problems: this.problems, warnings: this.warnings };
    const bodies = translated.map(parts => Buffer.concat(parts.map(part => {
      if (!part.pending) return part;
      return Buffer.concat([Buffer.from([0x41]), sleb(this.strings.get(part.pending.pendingString) + part.pending.offset)]);
    })));
    const types = this.parsed.bodies.map(({ type }) => this.mapType(type, 'backport function type'));
    if (this.problems.length) return { ok: false, problems: this.problems, warnings: this.warnings };
    const typeSection = module.section(SECTION.TYPE);
    const typeBytes = module.buffer.subarray(typeSection.start, typeSection.end);
    const functionSection = Buffer.concat([uleb(count), ...types.map(encodeType)]);
    const codeSection = Buffer.concat([uleb(count), ...bodies.flatMap(body => [uleb(body.length), body])]);
    const section = (id, body) => Buffer.concat([Buffer.from([id]), uleb(body.length), body]);
    const bodiesBin = Buffer.concat([module.buffer.subarray(0, 8), section(SECTION.TYPE, typeBytes), section(SECTION.FUNCTION, functionSection), section(SECTION.CODE, codeSection)]);
    const main = this.mainPatch();
    const nextPlan = {
      ...plan,
      sourceSha256: sha(module.buffer),
      imports: module.importCount,
      order,
      tableAdd: [...tableAdd, ...this.extraTable],
      dataBase: this.heapBase,
      dataHex: blob.toString('hex'),
      mainIndex: main.main,
      mainPatternHex: main.patternHex,
      mainReplacementHex: main.replacementHex,
    };
    const result = spliceBackport(module.buffer, bodiesBin, nextPlan);
    nextPlan.patchedSha256 = sha(result);
    return { ok: true, plan: nextPlan, bodiesBin, result, warnings: this.warnings };
  }
}

function port(ctx, plan, bodiesBin) {
  return new HomeScreenPort(ctx, plan, bodiesBin).run();
}

module.exports = { port, parseBodies, sha };
