'use strict';

const MAX_WITNESS_FUNCTIONS = 64;
const MIN_WITNESS_SHARE = 0.75;
const DATA_BRACKET_SPAN = 65536;
const BSS_BRACKET_SPAN = 4096;
const CONTENT_RADIUS_WORDS = 8;
const MIN_CONTENT_AGREEMENT = 0.9;
const MIN_INFORMATIVE_WORDS = 2;
const ROLE_WINDOW = 16;
const ROLE_ANCHOR_REACH = 8;
const ROLE_DEPTHS = [2, 1];
const I32_CONST = 0x41;
const CALL = 0x10;
const MEMORY_KINDS = new Set([9, 16]);
const INDEX_KINDS = new Set([2, 4]);

class AddressResolver {
  constructor(matcher, alignmentFor) {
    this.matcher = matcher;
    this.alignmentFor = alignmentFor;
    this.from = matcher.from;
    this.to = matcher.to;
    this.oldImage = matcher.from.image;
    this.newImage = matcher.to.image;
    this.known = null;
    this.users = null;
    this.results = new Map();
  }

  knownPairs() {
    if (!this.known) {
      this.known = [...this.matcher.addresses.best.entries()].sort((a, b) => a[0] - b[0]);
      this.knownOld = Float64Array.from(this.known, pair => pair[0]);
    }
    return this.known;
  }

  usersOf(address) {
    if (!this.users) {
      this.users = new Map();
      const { addresses, importCount, count } = this.from;
      for (let index = 0; index < count; index++) {
        const list = addresses.list(index);
        for (let i = 0; i < list.length; i++) {
          let entry = this.users.get(list[i]);
          if (!entry) {
            entry = [];
            this.users.set(list[i], entry);
          }
          if (entry[entry.length - 1] !== index + importCount) entry.push(index + importCount);
        }
      }
    }
    return this.users.get(address) || [];
  }

  byWitness(address) {
    const votes = new Map();
    let total = 0;
    for (const func of this.usersOf(address).slice(0, MAX_WITNESS_FUNCTIONS)) {
      const target = this.matcher.map[func];
      if (target < this.to.importCount) continue;
      const { alignment, oldDecoded, newDecoded } = this.alignmentFor(func, target);
      for (let i = 0; i < oldDecoded.length; i++) {
        const instruction = oldDecoded[i];
        if (instruction.op !== 0x41 || instruction.a !== address) continue;
        const mapped = alignment.newIndexFor(i);
        if (mapped < 0) continue;
        const other = newDecoded[mapped];
        if (other.op !== 0x41) continue;
        const weight = alignment.exact[i] ? 4 : 1;
        votes.set(other.a, (votes.get(other.a) || 0) + weight);
        total += weight;
      }
    }
    if (!total) return null;
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] / total < MIN_WITNESS_SHARE) return null;
    return { value: ranked[0][0], how: 'aligned code', votes: ranked[0][1] };
  }

  regionOf(features, value) {
    if (features.image.contains(value)) return 'data';
    if (value >= features.image.high && value < features.heapBase) return 'bss';
    return null;
  }

  roleToken(side, instruction) {
    if (!instruction) return '|';
    const features = side ? this.to : this.from;
    if (instruction.op === I32_CONST) return `const:${this.regionOf(features, instruction.a) || 'number'}`;
    if (instruction.op === CALL) return `call:${side ? instruction.a : this.matcher.map[instruction.a]}`;
    const sub = instruction.sub >= 0 ? `.${instruction.sub}` : '';
    if (MEMORY_KINDS.has(instruction.kind) || INDEX_KINDS.has(instruction.kind)) return `${instruction.op}${sub}:${instruction.a}`;
    return `${instruction.op}${sub}`;
  }

  roleKey(side, decoded, index, step, depth) {
    const parts = [];
    for (let k = 1; k <= depth; k++) parts.push(this.roleToken(side, decoded[index + step * k]));
    return parts.join(' ');
  }

  nearestAligned(alignment, index) {
    const direct = alignment.newIndexFor(index);
    if (direct >= 0) return direct;
    for (let distance = 1; distance <= ROLE_ANCHOR_REACH; distance++) {
      const before = alignment.newIndexFor(index - distance);
      if (before >= 0) return before + distance;
      const after = alignment.newIndexFor(index + distance);
      if (after >= 0) return Math.max(0, after - distance);
    }
    return -1;
  }

  roleCandidate(oldDecoded, newDecoded, index, center, region) {
    const before = this.roleKey(0, oldDecoded, index, -1, 1);
    for (const depth of ROLE_DEPTHS) {
      const after = this.roleKey(0, oldDecoded, index, 1, depth);
      const found = [];
      for (let k = Math.max(0, center - ROLE_WINDOW); k < Math.min(newDecoded.length, center + ROLE_WINDOW + 1); k++) {
        const instruction = newDecoded[k];
        if (instruction.op !== I32_CONST || this.regionOf(this.to, instruction.a) !== region) continue;
        if (this.roleKey(1, newDecoded, k, 1, depth) !== after) continue;
        found.push({ value: instruction.a, sameBefore: this.roleKey(1, newDecoded, k, -1, 1) === before });
      }
      if (!found.length) continue;
      const strong = found.filter(entry => entry.sameBefore);
      const values = new Set((strong.length ? strong : found).map(entry => entry.value));
      return values.size === 1 ? [...values][0] : null;
    }
    return null;
  }

  byRole(address) {
    const region = this.regionOf(this.from, address);
    if (!region) return null;
    const votes = new Map();
    let total = 0;
    for (const func of this.usersOf(address).slice(0, MAX_WITNESS_FUNCTIONS)) {
      const target = this.matcher.map[func];
      if (target < this.to.importCount) continue;
      const { alignment, oldDecoded, newDecoded } = this.alignmentFor(func, target);
      for (let i = 0; i < oldDecoded.length; i++) {
        if (oldDecoded[i].op !== I32_CONST || oldDecoded[i].a !== address) continue;
        const center = this.nearestAligned(alignment, i);
        if (center < 0) continue;
        const value = this.roleCandidate(oldDecoded, newDecoded, i, center, region);
        if (value === null) continue;
        votes.set(value, (votes.get(value) || 0) + 1);
        total++;
      }
    }
    if (!total) return null;
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] / total < MIN_WITNESS_SHARE) return null;
    return { value: ranked[0][0], how: 'code roles', votes: ranked[0][1] };
  }

  byString(address) {
    const whole = this.oldImage.wholeStringAt(address);
    if (!whole) return null;
    const hits = this.newImage.findString(whole.text);
    if (!hits.length) return null;
    return { value: hits[0] + whole.offset, how: 'same text', hits: hits.length };
  }

  bracket(address) {
    const pairs = this.knownPairs();
    const keys = this.knownOld;
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] <= address) lo = mid + 1;
      else hi = mid;
    }
    return { below: pairs[lo - 1] || null, above: pairs[lo] || null };
  }

  wordAgrees(oldWord, newWord) {
    if (oldWord === newWord) return true;
    const mapped = this.matcher.addresses.get(oldWord);
    if (mapped === newWord) return true;
    const oldSlot = this.from.module.slotFunctions.get(oldWord);
    if (oldSlot !== undefined) {
      const target = this.matcher.map[oldSlot];
      if (target >= 0 && this.to.module.slotFunctions.get(newWord) === target) return true;
    }
    return false;
  }

  contentScore(oldAddress, newAddress) {
    let informative = 0;
    let agree = 0;
    let exactAtCenter = true;
    const oldBase = oldAddress & ~3;
    const shift = newAddress - oldAddress;
    if (shift % 4 !== 0) return { score: 0, informative: 0 };
    for (let k = -CONTENT_RADIUS_WORDS; k <= CONTENT_RADIUS_WORDS; k++) {
      const oldWord = this.oldImage.word(oldBase + k * 4);
      const newWord = this.newImage.word(oldBase + shift + k * 4);
      if (oldWord === null || newWord === null) continue;
      const matches = this.wordAgrees(oldWord, newWord);
      if (k === 0 && !matches) exactAtCenter = false;
      if (oldWord === 0 && newWord === 0) continue;
      informative++;
      if (matches) agree++;
    }
    if (!exactAtCenter) return { score: 0, informative };
    return { score: informative ? agree / informative : 0, informative };
  }

  looksLikeText(address) {
    const at = address - this.oldImage.low;
    const bytes = this.oldImage.bytes;
    let printable = 0;
    for (let i = Math.max(0, at - 16); i < Math.min(bytes.length, at + 16); i++) {
      if (bytes[i] >= 32 && bytes[i] < 127) printable++;
    }
    return printable >= 12;
  }

  byInterpolation(address) {
    const { below, above } = this.bracket(address);
    if (!below || !above) return null;
    const lowShift = below[1] - below[0];
    const highShift = above[1] - above[0];
    const inImage = this.oldImage.contains(address);
    if (lowShift === highShift) {
      const span = above[0] - below[0];
      const value = address + lowShift;
      if (!inImage && !this.newImage.contains(value) && span <= BSS_BRACKET_SPAN) return { value, how: 'bss layout between two known addresses', span };
      if (inImage && this.newImage.contains(value) && span <= DATA_BRACKET_SPAN && !this.looksLikeText(address)) {
        const content = this.contentScore(address, value);
        if (content.score >= MIN_CONTENT_AGREEMENT && content.informative >= MIN_INFORMATIVE_WORDS) return { value, how: 'data layout between two known addresses', span, content };
      }
    }
    return null;
  }

  resolve(address) {
    if (this.results.has(address)) return this.results.get(address);
    const direct = this.matcher.addresses.get(address);
    let result;
    if (direct >= 0) result = { value: direct, how: 'code votes' };
    else result = this.byWitness(address) || this.byString(address) || this.byInterpolation(address) || this.byRole(address);
    this.results.set(address, result || null);
    return result || null;
  }
}

module.exports = { AddressResolver };
