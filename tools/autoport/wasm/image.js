'use strict';

const { PREFIX_MISC, MISC_MEMORY_INIT, readInstruction, bodyStart } = require('./module');

const MIN_STRING = 4;
const MAX_STRING = 4096;

function memoryInitOffsets(module) {
  const buf = module.buffer;
  const code = module.section(10);
  const offsets = new Map();
  const seen = new Set();
  const marker = Buffer.from([PREFIX_MISC, MISC_MEMORY_INIT]);
  for (let at = buf.indexOf(marker, code.start); at >= 0 && at < code.end; at = buf.indexOf(marker, at + 2)) {
    const func = module.funcAt(at);
    if (seen.has(func)) continue;
    seen.add(func);
    const { start, end } = module.bodyBounds(func);
    let position = bodyStart(buf, start);
    const constants = [];
    while (position < end) {
      const instruction = readInstruction(buf, position);
      position = instruction.end;
      if (instruction.op === 0x41) constants.push(instruction.a);
      else if (instruction.op === PREFIX_MISC && instruction.sub === MISC_MEMORY_INIT) {
        if (constants.length >= 3) offsets.set(instruction.a, constants[constants.length - 3]);
        constants.length = 0;
      } else if (instruction.op !== 0x20 && instruction.op !== 0x6a) {
        constants.length = 0;
      }
    }
  }
  return offsets;
}

class MemoryImage {
  constructor(module) {
    this.module = module;
    const initOffsets = memoryInitOffsets(module);
    const placed = [];
    module.dataSegments.forEach((segment, index) => {
      const offset = segment.offset !== null ? segment.offset : initOffsets.get(index);
      if (offset === undefined || offset === null) return;
      placed.push({ offset, start: segment.start, size: segment.size, index });
    });
    this.segments = placed.sort((a, b) => a.offset - b.offset);
    this.unresolvedSegments = module.dataSegments.length - placed.length;
    this.low = placed.length ? this.segments[0].offset : 0;
    this.high = placed.reduce((top, segment) => Math.max(top, segment.offset + segment.size), 0);
    this.bytes = Buffer.alloc(Math.max(0, this.high - this.low));
    for (const segment of this.segments) {
      module.buffer.copy(this.bytes, segment.offset - this.low, segment.start, segment.start + segment.size);
    }
    this.tableLow = Infinity;
    this.tableHigh = -1;
    for (const segment of module.elementSegments) {
      this.tableLow = Math.min(this.tableLow, segment.base);
      this.tableHigh = Math.max(this.tableHigh, segment.base + segment.functions.length);
    }
  }

  contains(address) {
    return address >= this.low && address < this.high;
  }

  word(address) {
    const at = address - this.low;
    return at >= 0 && at + 4 <= this.bytes.length ? this.bytes.readUInt32LE(at) : null;
  }

  stringAt(address) {
    const at = address - this.low;
    if (at < 0 || at >= this.bytes.length) return null;
    const end = this.bytes.indexOf(0, at);
    if (end < 0) return null;
    const length = end - at;
    if (length < MIN_STRING || length > MAX_STRING) return null;
    for (let i = at; i < end; i++) {
      const byte = this.bytes[i];
      if ((byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte >= 127) return null;
    }
    return this.bytes.toString('latin1', at, end);
  }

  wholeStringAt(address) {
    const at = address - this.low;
    if (at < 0 || at >= this.bytes.length) return null;
    let start = at;
    while (start > 0 && start > at - MAX_STRING) {
      const byte = this.bytes[start - 1];
      if (byte === 0 || byte < 9 || byte >= 127) break;
      start--;
    }
    const end = this.bytes.indexOf(0, at);
    if (end < 0 || end - start < MIN_STRING || end - start > MAX_STRING) return null;
    return { text: this.bytes.toString('latin1', start, end), start: start + this.low, offset: at - start };
  }

  findString(text) {
    const needle = Buffer.from(`\0${text}\0`, 'latin1');
    const hits = [];
    if (this.bytes.subarray(0, needle.length - 1).equals(needle.subarray(1))) hits.push(this.low);
    for (let at = this.bytes.indexOf(needle); at >= 0 && hits.length < 8; at = this.bytes.indexOf(needle, at + 1)) hits.push(at + 1 + this.low);
    return hits;
  }

  isTableSlot(value) {
    return value >= this.tableLow && value < this.tableHigh && this.module.slotFunctions.has(value);
  }

  allStrings() {
    const strings = new Map();
    const bytes = this.bytes;
    let start = -1;
    for (let at = 0; at < bytes.length; at++) {
      const byte = bytes[at];
      if (byte === 0) {
        if (start >= 0) {
          const length = at - start;
          if (length >= MIN_STRING && length <= MAX_STRING) {
            const text = bytes.toString('latin1', start, at);
            const address = start + this.low;
            const known = strings.get(text);
            if (known === undefined) strings.set(text, address);
            else if (known >= 0) strings.set(text, -2);
          }
          start = -1;
        }
      } else if ((byte >= 32 && byte < 127) || byte === 9 || byte === 10 || byte === 13) {
        if (start < 0) start = at;
      } else {
        start = -1;
      }
    }
    return strings;
  }
}

module.exports = { MemoryImage, memoryInitOffsets };
