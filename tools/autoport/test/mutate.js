'use strict';

const { WasmModule, KIND, readInstruction, readU, bodyStart, readLocals, uleb, sleb, SECTION } = require('../wasm/module');
const { memoryInitOffsets } = require('../wasm/image');

const OP = { CALL: 0x10, RETURN_CALL: 0x12, LOCAL_GET: 0x20, LOCAL_SET: 0x21, LOCAL_TEE: 0x22, I32_CONST: 0x41, REF_FUNC: 0xd2, DROP: 0x1a, NOP: 0x01 };
const NOISE_MAGIC = 0x5a17e5;

function randomSource(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function shuffle(list, random) {
  for (let i = list.length - 1; i > 0; i--) {
    const k = Math.floor(random() * (i + 1));
    [list[i], list[k]] = [list[k], list[i]];
  }
  return list;
}

class Output {
  constructor(size) {
    this.buffer = Buffer.allocUnsafe(Math.max(64, size));
    this.size = 0;
  }

  reserve(extra) {
    if (this.size + extra <= this.buffer.length) return;
    const next = Buffer.allocUnsafe(Math.max(this.buffer.length * 2, this.size + extra));
    this.buffer.copy(next, 0, 0, this.size);
    this.buffer = next;
  }

  range(source, start, end) {
    this.reserve(end - start);
    source.copy(this.buffer, this.size, start, end);
    this.size += end - start;
  }

  bytes(bytes) {
    this.reserve(bytes.length);
    bytes.copy(this.buffer, this.size);
    this.size += bytes.length;
  }

  byte(value) {
    this.reserve(1);
    this.buffer[this.size++] = value;
  }

  result() {
    return this.buffer.subarray(0, this.size);
  }
}

function rawSections(buffer) {
  const list = [];
  let at = 8;
  while (at < buffer.length) {
    const id = buffer[at];
    const [size, start] = readU(buffer, at + 1);
    list.push({ id, start, end: start + size });
    at = start + size;
  }
  return list;
}

function sectionBytes(id, body) {
  return Buffer.concat([Buffer.from([id]), uleb(body.length), body]);
}

function mutateBody(module, func, plan, random) {
  const buf = module.buffer;
  const { start, end } = module.bodyBounds(func);
  const out = new Output(end - start + 64);
  const locals = plan.locals ? localShuffle(module, func, random) : null;
  const code = bodyStart(buf, start);
  out.range(buf, start, code);
  const noisy = plan.noiseFunctions && plan.noiseFunctions.has(func);
  const instruction = {};
  let at = code;
  let copied = at;
  const flush = upTo => {
    if (upTo > copied) out.range(buf, copied, upTo);
  };
  while (at < end) {
    readInstruction(buf, at, instruction);
    const here = at;
    at = instruction.end;
    if (noisy && random() < plan.noiseRate) {
      flush(here);
      copied = here;
      out.byte(OP.I32_CONST);
      out.bytes(sleb(NOISE_MAGIC));
      out.byte(OP.DROP);
    }
    const op = instruction.op;
    if (op === OP.CALL || op === OP.RETURN_CALL || op === OP.REF_FUNC) {
      const mapped = plan.functionMap[instruction.a];
      if (mapped !== instruction.a) {
        flush(here);
        out.byte(op);
        out.bytes(uleb(mapped));
        copied = at;
      }
    } else if (locals && (op === OP.LOCAL_GET || op === OP.LOCAL_SET || op === OP.LOCAL_TEE)) {
      const mapped = locals[instruction.a];
      if (mapped !== instruction.a) {
        flush(here);
        out.byte(op);
        out.bytes(uleb(mapped));
        copied = at;
      }
    } else if (op === OP.I32_CONST && plan.mapConstant) {
      const mapped = plan.mapConstant(instruction.a, func);
      if (mapped !== instruction.a) {
        flush(here);
        out.byte(op);
        out.bytes(sleb(mapped));
        copied = at;
      }
    } else if (instruction.kind === KIND.MEMARG && plan.mapOffset && op >= 0x28 && op <= 0x3e) {
      const mapped = plan.mapOffset(instruction.a, func);
      if (mapped !== instruction.a) {
        flush(here);
        out.byte(op);
        out.bytes(uleb(instruction.align));
        out.bytes(uleb(mapped));
        copied = at;
      }
    }
  }
  flush(end);
  return out.result();
}

function localShuffle(module, func, random) {
  const buf = module.buffer;
  const { start } = module.bodyBounds(func);
  const { groups } = readLocals(buf, start);
  const params = module.paramCount(func);
  const total = groups.reduce((sum, group) => sum + group.count, params);
  const map = new Int32Array(total);
  for (let i = 0; i < total; i++) map[i] = i;
  const byType = new Map();
  let index = params;
  for (const group of groups) {
    if (!byType.has(group.type)) byType.set(group.type, []);
    const list = byType.get(group.type);
    for (let k = 0; k < group.count; k++) list.push(index++);
  }
  for (const list of byType.values()) {
    const moved = shuffle([...list], random);
    list.forEach((local, position) => { map[local] = moved[position]; });
  }
  return map;
}

function rewriteElements(module, map) {
  const parts = [uleb(module.elementSegments.length)];
  for (const segment of module.elementSegments) {
    parts.push(uleb(0), Buffer.from([OP.I32_CONST]), sleb(segment.base), Buffer.from([0x0b]), uleb(segment.functions.length));
    for (const func of segment.functions) parts.push(uleb(map[func]));
  }
  return Buffer.concat(parts);
}

function rewriteExports(module, map) {
  const parts = [uleb(module.exports.size)];
  for (const [name, entry] of module.exports) {
    const bytes = Buffer.from(name);
    parts.push(uleb(bytes.length), bytes, Buffer.from([entry.kind]), uleb(entry.kind === 0 ? map[entry.index] : entry.index));
  }
  return Buffer.concat(parts);
}

function dataPlan(module, options, random) {
  if (!options.dataShifts) return null;
  const heapBase = module.globals[0].value;
  const active = module.dataSegments.map((segment, index) => ({ ...segment, index }));
  const initOffsets = memoryInitOffsets(module);
  for (const segment of active) if (segment.offset === null && initOffsets.has(segment.index)) segment.offset = initOffsets.get(segment.index);
  const located = active.filter(segment => segment.offset !== null).sort((a, b) => a.offset - b.offset);
  const breakpoints = shuffle(located.slice(1).map(segment => segment.offset), random).slice(0, options.dataShifts).sort((a, b) => a - b);
  const steps = breakpoints.map((at, index) => ({ at, by: (index + 1) * 16 * options.dataStep }));
  const low = located[0].offset;
  const map = value => {
    if (value < low || value > heapBase) return value;
    let by = 0;
    for (const step of steps) {
      if (value >= step.at) by = step.by;
      else break;
    }
    return value + by;
  };
  return { map, heapBase, low, steps };
}

function looksLikeText(bytes, at) {
  const printable = position => position >= 0 && position < bytes.length && bytes[position] >= 32 && bytes[position] < 127;
  return printable(at) && printable(at + 1);
}

function rewriteData(module, data) {
  const buf = module.buffer;
  const parts = [uleb(module.dataSegments.length)];
  for (const segment of module.dataSegments) {
    const bytes = Buffer.from(buf.subarray(segment.start, segment.start + segment.size));
    if (data) {
      for (let at = 0; at + 4 <= bytes.length; at += 4) {
        if (looksLikeText(bytes, at)) continue;
        const value = bytes.readUInt32LE(at);
        const mapped = data.map(value);
        if (mapped !== value) bytes.writeUInt32LE(mapped, at);
      }
    }
    if (segment.flags === 1) {
      parts.push(uleb(1));
    } else {
      const offset = data ? data.map(segment.offset) : segment.offset;
      parts.push(uleb(0), Buffer.from([OP.I32_CONST]), sleb(offset), Buffer.from([0x0b]));
    }
    parts.push(uleb(bytes.length), bytes);
  }
  return Buffer.concat(parts);
}

function rewriteGlobals(module, data) {
  const parts = [];
  let count = 0;
  for (const global of module.globals) {
    if (global.imported) continue;
    count++;
    parts.push(Buffer.from([global.type, global.mutable ? 1 : 0]));
    if (global.value === null) throw new Error('the mutator only reads constant globals');
    const value = data ? data.map(global.value) : global.value;
    if (global.type !== 0x7f) throw new Error('the mutator only reads i32 globals');
    parts.push(Buffer.from([OP.I32_CONST]), sleb(value), Buffer.from([0x0b]));
  }
  return Buffer.concat([uleb(count), ...parts]);
}

function mutate(buffer, options = {}) {
  const module = new WasmModule(buffer);
  const random = randomSource(options.seed || 1);
  const imports = module.importCount;
  const defined = module.definedCount;
  const order = Array.from({ length: defined }, (_, index) => index);
  if (options.permute) shuffle(order, random);
  const importShift = options.extraImport ? 1 : 0;
  const functionMap = new Int32Array(imports + defined);
  for (let i = 0; i < imports; i++) functionMap[i] = options.extraImport && i >= options.extraImport.at ? i + 1 : i;
  order.forEach((oldIndex, position) => { functionMap[imports + oldIndex] = imports + importShift + position; });

  let noiseFunctions = null;
  if (options.noiseShare) {
    noiseFunctions = new Set();
    const protect = new Set(options.noiseProtect || []);
    for (let func = imports; func < imports + defined; func++) if (!protect.has(func) && random() < options.noiseShare) noiseFunctions.add(func);
  }
  const data = dataPlan(module, options, random);
  const fieldEdits = new Map();
  for (const edit of options.fields || []) {
    for (const func of edit.functions) {
      if (!fieldEdits.has(func)) fieldEdits.set(func, new Map());
      fieldEdits.get(func).set(edit.offset, edit.offset + edit.by);
    }
  }
  const constantEdits = new Map();
  for (const edit of options.constants || []) {
    for (const func of edit.functions) {
      if (!constantEdits.has(func)) constantEdits.set(func, new Map());
      constantEdits.get(func).set(edit.value, edit.to);
    }
  }
  const plan = {
    functionMap,
    locals: Boolean(options.locals),
    noiseFunctions,
    noiseRate: options.noiseRate || 0.05,
    mapConstant: data || constantEdits.size ? (value, func) => {
      const edit = constantEdits.get(func);
      if (edit && edit.has(value)) return edit.get(value);
      return data ? data.map(value) : value;
    } : null,
    mapOffset: data || fieldEdits.size ? (value, func) => {
      const edit = fieldEdits.get(func);
      if (edit && edit.has(value)) return edit.get(value);
      return data ? data.map(value) : value;
    } : null,
  };

  const bodies = order.map(oldIndex => mutateBody(module, imports + oldIndex, plan, random));
  const functionTypes = [uleb(defined), ...order.map(oldIndex => uleb(module.functionTypes[oldIndex]))];
  const codeParts = [uleb(defined)];
  for (const body of bodies) codeParts.push(uleb(body.length), body);

  const sections = rawSections(buffer);
  const out = [buffer.subarray(0, 8)];
  for (const section of sections) {
    const body = buffer.subarray(section.start, section.end);
    switch (section.id) {
      case SECTION.IMPORT: {
        if (!options.extraImport) {
          out.push(sectionBytes(section.id, body));
          break;
        }
        const [count, first] = readU(body, 0);
        const name = Buffer.from(options.extraImport.name);
        const moduleName = Buffer.from(module.functionImports[0].module);
        const entry = Buffer.concat([uleb(moduleName.length), moduleName, uleb(name.length), name, Buffer.from([0]), uleb(module.typeIndex('>'))]);
        const at = importOffset(body, first, options.extraImport.at, module);
        out.push(sectionBytes(section.id, Buffer.concat([uleb(count + 1), body.subarray(first, at), entry, body.subarray(at)])));
        break;
      }
      case SECTION.FUNCTION:
        out.push(sectionBytes(section.id, Buffer.concat(functionTypes)));
        break;
      case SECTION.GLOBAL:
        out.push(sectionBytes(section.id, data ? rewriteGlobals(module, data) : body));
        break;
      case SECTION.EXPORT:
        out.push(sectionBytes(section.id, rewriteExports(module, functionMap)));
        break;
      case SECTION.START:
        out.push(sectionBytes(section.id, uleb(functionMap[module.start])));
        break;
      case SECTION.ELEMENT:
        out.push(sectionBytes(section.id, rewriteElements(module, functionMap)));
        break;
      case SECTION.CODE:
        out.push(sectionBytes(section.id, Buffer.concat(codeParts)));
        break;
      case SECTION.DATA:
        out.push(sectionBytes(section.id, data ? rewriteData(module, data) : body));
        break;
      default:
        out.push(sectionBytes(section.id, body));
    }
  }
  return { buffer: Buffer.concat(out), truth: { functionMap, order, imports, defined, data, importShift } };
}

function importOffset(body, first, wanted, module) {
  let at = first;
  let functions = 0;
  const readName = () => {
    const [size, next] = readU(body, at);
    at = next + size;
  };
  for (;;) {
    const start = at;
    readName();
    readName();
    const kind = body[at++];
    if (kind === 0) {
      if (functions === wanted) return start;
      functions++;
      at = readU(body, at)[1];
    } else if (kind === 1) {
      at++;
      const flags = body[at++];
      at = readU(body, at)[1];
      if (flags & 1) at = readU(body, at)[1];
    } else if (kind === 2) {
      const flags = body[at++];
      at = readU(body, at)[1];
      if (flags & 1) at = readU(body, at)[1];
    } else if (kind === 3) {
      at += 2;
    } else {
      at++;
      at = readU(body, at)[1];
    }
    if (at >= body.length) throw new Error(`import ${wanted} of ${module.functionImports.length} is past the end`);
  }
}

function undoPermutation(buffer, truth) {
  const module = new WasmModule(buffer);
  const { functionMap, order, imports, defined } = truth;
  const total = module.functionCount;
  const inverse = new Int32Array(total);
  for (let i = 0; i < functionMap.length; i++) inverse[functionMap[i]] = i;
  for (let i = imports + defined; i < total; i++) inverse[i] = i;
  const plan = { functionMap: inverse, locals: false };
  const random = randomSource(1);
  const originalOrder = new Int32Array(defined);
  order.forEach((oldIndex, position) => { originalOrder[oldIndex] = position; });
  const bodyOf = position => mutateBody(module, imports + position, plan, random);
  const types = [uleb(module.definedCount)];
  const codeParts = [uleb(module.definedCount)];
  const pushFunction = position => {
    types.push(uleb(module.functionTypes[position]));
    const body = bodyOf(position);
    codeParts.push(uleb(body.length), body);
  };
  for (let oldIndex = 0; oldIndex < defined; oldIndex++) pushFunction(originalOrder[oldIndex]);
  for (let position = defined; position < module.definedCount; position++) pushFunction(position);
  const sections = rawSections(buffer);
  const out = [buffer.subarray(0, 8)];
  for (const section of sections) {
    const body = buffer.subarray(section.start, section.end);
    if (section.id === SECTION.FUNCTION) out.push(sectionBytes(section.id, Buffer.concat(types)));
    else if (section.id === SECTION.CODE) out.push(sectionBytes(section.id, Buffer.concat(codeParts)));
    else if (section.id === SECTION.EXPORT) out.push(sectionBytes(section.id, rewriteExports(module, inverse)));
    else if (section.id === SECTION.ELEMENT) out.push(sectionBytes(section.id, rewriteElements(module, inverse)));
    else if (section.id === SECTION.START) out.push(sectionBytes(section.id, uleb(inverse[module.start])));
    else out.push(sectionBytes(section.id, body));
  }
  return Buffer.concat(out);
}

function renameIdentifiers(text, renames) {
  let out = text;
  for (const [from, to] of renames) {
    out = out.replace(new RegExp(`(?<![\\w$.])${from.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'), to);
  }
  return out;
}

module.exports = { mutate, undoPermutation, renameIdentifiers, randomSource, shuffle, NOISE_MAGIC };
