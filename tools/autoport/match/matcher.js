'use strict';

const { KIND, bodyStart, readInstruction, EXTERNAL } = require('../wasm/module');
const { Hash2, mix, minHashSimilarity, MIN_HASH_BANDS, MIN_HASH_MIN_SIZE } = require('./features');
const { alignTokens } = require('./align');

const HOW = {
  NONE: 0,
  IMPORT: 1,
  EXPORT: 2,
  EXACT: 3,
  EVIDENCE: 4,
  PROPAGATED: 5,
  VTABLE: 6,
  FUZZY: 7,
  TWIN: 8,
};
const HOW_NAMES = ['none', 'import', 'export', 'exact', 'evidence', 'propagated', 'vtable', 'fuzzy', 'twin'];

const UNKNOWN_CALLEE = 0x7fffff01;
const UNKNOWN_ADDRESS = 0x7fffff02;
const NO_KEY = -1;
const MIN_LONE_SIZE = 24;
const MIN_SKELETON_SIZE = 12;
const MIN_FUZZY_SIZE = 8;
const FUZZY_ACCEPT = 0.62;
const FUZZY_MARGIN = 0.08;
const MAX_FUZZY_CANDIDATES = 24;
const MAX_BUCKET = 64;
const MAX_VTABLE_SLOTS = 1024;
const TWO_28 = 268435456;

const TWIN_ROUNDS = 4;
const TWIN_ORDER_ROUNDS = 12;

class AddressMap {
  constructor() {
    this.votes = new Map();
    this.best = new Map();
    this.fixed = new Map();
  }

  vote(oldAddress, newAddress, weight = 1) {
    if (this.fixed.has(oldAddress)) return;
    const key = oldAddress * TWO_28 + newAddress;
    this.votes.set(key, (this.votes.get(key) || 0) + weight);
  }

  fix(oldAddress, newAddress) {
    this.fixed.set(oldAddress, newAddress);
  }

  settle() {
    const totals = new Map();
    const tops = new Map();
    for (const [key, votes] of this.votes) {
      const oldAddress = Math.floor(key / TWO_28);
      const newAddress = key - oldAddress * TWO_28;
      totals.set(oldAddress, (totals.get(oldAddress) || 0) + votes);
      const top = tops.get(oldAddress);
      if (!top || votes > top.votes) tops.set(oldAddress, { value: newAddress, votes });
    }
    this.best = new Map();
    this.confidence = new Map();
    for (const [oldAddress, top] of tops) {
      const share = top.votes / totals.get(oldAddress);
      if (share >= 0.75) {
        this.best.set(oldAddress, top.value);
        this.confidence.set(oldAddress, { votes: top.votes, share });
      }
    }
    for (const [oldAddress, value] of this.fixed) {
      this.best.set(oldAddress, value);
      this.confidence.set(oldAddress, { votes: Infinity, share: 1 });
    }
  }

  get(oldAddress) {
    const value = this.best.get(oldAddress);
    return value === undefined ? -1 : value;
  }
}

class Matcher {
  constructor(from, to, log = () => {}) {
    this.from = from;
    this.to = to;
    this.log = log;
    this.map = new Int32Array(from.total).fill(-1);
    this.reverse = new Int32Array(to.total).fill(-1);
    this.how = new Uint8Array(from.total);
    this.addresses = new AddressMap();
    this.tokenCache = new Map();
  }

  link(oldFunc, newFunc, how) {
    this.map[oldFunc] = newFunc;
    this.reverse[newFunc] = oldFunc;
    this.how[oldFunc] = how;
  }

  unlink(oldFunc) {
    const newFunc = this.map[oldFunc];
    if (newFunc >= 0 && this.reverse[newFunc] === oldFunc) this.reverse[newFunc] = -1;
    this.map[oldFunc] = -1;
    this.how[oldFunc] = HOW.NONE;
  }

  matchedCount() {
    let count = 0;
    for (let func = this.from.importCount; func < this.from.total; func++) if (this.map[func] >= 0) count++;
    return count;
  }

  matchImports() {
    const { from, to } = this;
    const byName = new Map(to.module.functionImports.map((entry, index) => [`${entry.module}\0${entry.name}`, index]));
    from.module.functionImports.forEach((entry, index) => {
      const target = byName.get(`${entry.module}\0${entry.name}`);
      if (target !== undefined && from.signatures[index] === to.signatures[target]) this.link(index, target, HOW.IMPORT);
    });
  }

  matchExports() {
    const { from, to } = this;
    for (const [name, entry] of from.module.exports) {
      if (entry.kind !== EXTERNAL.FUNCTION || entry.index < from.importCount) continue;
      const other = to.module.exports.get(name);
      if (!other || other.kind !== EXTERNAL.FUNCTION || other.index < to.importCount) continue;
      if (from.signatures[entry.index] !== to.signatures[other.index]) continue;
      if (this.map[entry.index] < 0 && this.reverse[other.index] < 0) this.link(entry.index, other.index, HOW.EXPORT);
    }
  }

  stringsSignature(features, func) {
    const list = features.stringsOf(func);
    if (!list.length) return 0;
    const sorted = Array.from(list).sort((a, b) => a - b);
    const hash = new Hash2();
    for (const id of sorted) hash.add(id);
    return hash.value();
  }

  calleeIdentity(side, func, callee) {
    if (side === 0) {
      const target = this.map[callee];
      return target >= 0 ? target : UNKNOWN_CALLEE;
    }
    return this.reverse[callee] >= 0 ? callee : UNKNOWN_CALLEE;
  }

  calleesSignature(side, features, func) {
    const list = features.calleesOf(func);
    if (!list.length) return { value: 0, known: 0 };
    const hash = new Hash2();
    let known = 0;
    for (const callee of list) {
      const identity = this.calleeIdentity(side, func, callee);
      if (identity !== UNKNOWN_CALLEE) known++;
      hash.add(identity);
    }
    return { value: hash.value(), known };
  }

  callersSignature(side, features, func) {
    const list = features.callersOf(func);
    if (!list.length) return { value: 0, known: 0 };
    const ids = [];
    for (const caller of list) {
      const identity = side === 0 ? this.map[caller] : (this.reverse[caller] >= 0 ? caller : -1);
      if (identity >= 0) ids.push(identity);
    }
    if (!ids.length) return { value: 0, known: 0 };
    ids.sort((a, b) => a - b);
    const hash = new Hash2();
    for (const id of ids) hash.add(id);
    return { value: hash.value(), known: ids.length };
  }

  addressesSignature(side, features, func) {
    const list = features.addressesOf(func);
    if (!list.length) return { value: 0, known: 0 };
    const hash = new Hash2();
    let known = 0;
    for (const address of list) {
      const identity = side === 0 ? this.addresses.get(address) : (this.newAddressKnown.has(address) ? address : -1);
      if (identity >= 0) {
        known++;
        hash.add(identity);
      } else {
        hash.add(UNKNOWN_ADDRESS);
      }
    }
    return { value: hash.value(), known };
  }

  sweep(name, keyOf, how = HOW.EVIDENCE) {
    const { from, to } = this;
    const buckets = new Map();
    for (let func = from.importCount; func < from.total; func++) {
      if (this.map[func] >= 0) continue;
      const key = keyOf(0, from, func);
      if (key === NO_KEY) continue;
      const entry = buckets.get(key);
      if (entry === undefined) buckets.set(key, { old: func, oldCount: 1, target: -1, newCount: 0 });
      else entry.oldCount++;
    }
    for (let func = to.importCount; func < to.total; func++) {
      if (this.reverse[func] >= 0) continue;
      const key = keyOf(1, to, func);
      if (key === NO_KEY) continue;
      const entry = buckets.get(key);
      if (entry === undefined) continue;
      entry.target = func;
      entry.newCount++;
    }
    let linked = 0;
    for (const entry of buckets.values()) {
      if (entry.oldCount === 1 && entry.newCount === 1 && from.signatures[entry.old] === to.signatures[entry.target]) {
        this.link(entry.old, entry.target, how);
        linked++;
      }
    }
    if (linked) this.log(`  ${name}: ${linked}`);
    return linked;
  }

  buildKeys() {
    const combine = (...parts) => {
      const hash = new Hash2();
      for (const part of parts) hash.addNumber(part);
      return hash.value();
    };
    const evidence = (side, features, func) => ({
      strings: this.stringsSignature(features, func),
      callees: this.calleesSignature(side, features, func),
      addresses: this.addressesSignature(side, features, func),
      callers: this.callersSignature(side, features, func),
    });
    return [
      ['strict+strings+callees+addresses', HOW.EXACT, (s, f, x) => { const e = evidence(s, f, x); return combine(f.strict[x], f.signatures[x], e.strings, e.callees.value, e.addresses.value); }],
      ['strict+strings+callees', HOW.EXACT, (s, f, x) => { const e = evidence(s, f, x); return combine(f.strict[x], f.signatures[x], e.strings, e.callees.value); }],
      ['strict+callees', HOW.EXACT, (s, f, x) => { const e = this.calleesSignature(s, f, x); return e.known ? combine(f.strict[x], f.signatures[x], e.value) : NO_KEY; }],
      ['strict+strings', HOW.EXACT, (s, f, x) => { const e = this.stringsSignature(f, x); return e ? combine(f.strict[x], f.signatures[x], e) : NO_KEY; }],
      ['strict+addresses', HOW.EXACT, (s, f, x) => { const e = this.addressesSignature(s, f, x); return e.known ? combine(f.strict[x], f.signatures[x], e.value) : NO_KEY; }],
      ['strict+callers', HOW.EVIDENCE, (s, f, x) => { const e = this.callersSignature(s, f, x); return e.known ? combine(f.strict[x], f.signatures[x], e.value) : NO_KEY; }],
      ['canon+strings+callees', HOW.EVIDENCE, (s, f, x) => { const e = this.calleesSignature(s, f, x); return combine(f.canon[x], f.signatures[x], this.stringsSignature(f, x), e.value); }],
      ['canon+callees', HOW.EVIDENCE, (s, f, x) => { const e = this.calleesSignature(s, f, x); return e.known ? combine(f.canon[x], f.signatures[x], e.value) : NO_KEY; }],
      ['canon+strings', HOW.EVIDENCE, (s, f, x) => { const e = this.stringsSignature(f, x); return e ? combine(f.canon[x], f.signatures[x], e) : NO_KEY; }],
      ['canon+addresses', HOW.EVIDENCE, (s, f, x) => { const e = this.addressesSignature(s, f, x); return e.known ? combine(f.canon[x], f.signatures[x], e.value) : NO_KEY; }],
      ['canon+callers', HOW.EVIDENCE, (s, f, x) => { const e = this.callersSignature(s, f, x); return e.known ? combine(f.canon[x], f.signatures[x], e.value) : NO_KEY; }],
      ['strict alone', HOW.EXACT, (s, f, x) => (f.sizes[x] >= MIN_LONE_SIZE ? combine(f.strict[x], f.signatures[x]) : NO_KEY)],
      ['canon alone', HOW.EXACT, (s, f, x) => (f.sizes[x] >= MIN_LONE_SIZE ? combine(f.canon[x], f.signatures[x]) : NO_KEY)],
      ['skeleton+strings+callees', HOW.EVIDENCE, (s, f, x) => { const e = this.calleesSignature(s, f, x); const t = this.stringsSignature(f, x); return e.known || t ? combine(f.skeleton[x], f.signatures[x], t, e.value) : NO_KEY; }],
      ['skeleton+callees', HOW.EVIDENCE, (s, f, x) => { const e = this.calleesSignature(s, f, x); return e.known && f.sizes[x] >= MIN_SKELETON_SIZE ? combine(f.skeleton[x], f.signatures[x], e.value) : NO_KEY; }],
      ['skeleton+strings', HOW.EVIDENCE, (s, f, x) => { const e = this.stringsSignature(f, x); return e && f.sizes[x] >= MIN_SKELETON_SIZE ? combine(f.skeleton[x], f.signatures[x], e) : NO_KEY; }],
      ['skeleton+addresses', HOW.EVIDENCE, (s, f, x) => { const e = this.addressesSignature(s, f, x); return e.known && f.sizes[x] >= MIN_SKELETON_SIZE ? combine(f.skeleton[x], f.signatures[x], e.value) : NO_KEY; }],
      ['skeleton+callers', HOW.EVIDENCE, (s, f, x) => { const e = this.callersSignature(s, f, x); return e.known && f.sizes[x] >= MIN_SKELETON_SIZE ? combine(f.skeleton[x], f.signatures[x], e.value) : NO_KEY; }],
      ['skeleton alone', HOW.EVIDENCE, (s, f, x) => (f.sizes[x] >= MIN_LONE_SIZE * 2 ? combine(f.skeleton[x], f.signatures[x]) : NO_KEY)],
      ['strings alone', HOW.EVIDENCE, (s, f, x) => { const list = f.stringsOf(x); return list.length >= 2 ? combine(this.stringsSignature(f, x), f.signatures[x]) : NO_KEY; }],
    ];
  }

  seedStringAddresses() {
    const oldStrings = this.from.image.allStrings();
    const newStrings = this.to.image.allStrings();
    let count = 0;
    for (const [text, address] of oldStrings) {
      if (address < 0) continue;
      const other = newStrings.get(text);
      if (other !== undefined && other >= 0) {
        this.addresses.vote(address, other, 3);
        count++;
      }
    }
    this.log(`  strings present once in both builds: ${count}`);
  }

  voteAddresses() {
    const { from, to } = this;
    for (let func = from.importCount; func < from.total; func++) {
      const target = this.map[func];
      if (target < to.importCount) continue;
      if (from.canon[func] !== to.canon[target]) continue;
      const oldList = from.addressesOf(func);
      const newList = to.addressesOf(target);
      if (oldList.length !== newList.length) continue;
      for (let i = 0; i < oldList.length; i++) this.addresses.vote(oldList[i], newList[i]);
    }
    this.addresses.settle();
    this.newAddressKnown = new Set(this.addresses.best.values());
  }

  propagate() {
    const { from, to } = this;
    const votes = new Map();
    const vote = (a, b, weight) => {
      if (a < from.importCount || b < to.importCount) return;
      if (this.map[a] >= 0 || this.reverse[b] >= 0) return;
      if (from.signatures[a] !== to.signatures[b]) return;
      let entry = votes.get(a);
      if (entry === undefined) {
        entry = new Map();
        votes.set(a, entry);
      }
      entry.set(b, (entry.get(b) || 0) + weight);
    };
    for (let func = from.importCount; func < from.total; func++) {
      const target = this.map[func];
      if (target < to.importCount) continue;
      const oldList = from.calleesOf(func);
      const newList = to.calleesOf(target);
      if (!oldList.length || !newList.length) continue;
      if (oldList.length === newList.length) {
        for (let i = 0; i < oldList.length; i++) vote(oldList[i], newList[i], 2);
      } else {
        const oldTokens = Int32Array.from(oldList, callee => (this.map[callee] >= 0 ? this.map[callee] : -1 - from.signatures[callee]));
        const newTokens = Int32Array.from(newList, callee => (this.reverse[callee] >= 0 ? callee : -1 - to.signatures[callee]));
        const pairs = alignTokens(oldTokens, newTokens);
        for (let i = 0; i < pairs.length; i += 2) vote(oldList[pairs[i]], newList[pairs[i + 1]], 1);
      }
    }
    return this.acceptVotes(votes, HOW.PROPAGATED);
  }

  acceptVotes(votes, how) {
    const { from, to } = this;
    const bestForNew = new Map();
    const top = new Map();
    for (const [a, entry] of votes) {
      let bestB = -1;
      let bestVotes = 0;
      let second = 0;
      for (const [b, count] of entry) {
        if (count > bestVotes) {
          second = bestVotes;
          bestVotes = count;
          bestB = b;
        } else if (count > second) {
          second = count;
        }
      }
      if (bestVotes <= second) continue;
      top.set(a, bestB);
      const current = bestForNew.get(bestB);
      if (!current || current.votes < bestVotes) bestForNew.set(bestB, { old: a, votes: bestVotes, tie: current ? current.votes === bestVotes : false });
      else if (current.votes === bestVotes) current.tie = true;
    }
    let linked = 0;
    for (const [a, b] of top) {
      const owner = bestForNew.get(b);
      if (!owner || owner.old !== a || owner.tie) continue;
      if (!this.compatible(a, b)) continue;
      this.link(a, b, how);
      linked++;
    }
    return linked;
  }

  compatible(a, b) {
    const { from, to } = this;
    if (from.canon[a] === to.canon[b] || from.skeleton[a] === to.skeleton[b]) return true;
    const sizeA = from.sizes[a];
    const sizeB = to.sizes[b];
    const ratio = Math.min(sizeA, sizeB) / Math.max(sizeA, sizeB);
    if (ratio < 0.35) return false;
    if (sizeA < MIN_HASH_MIN_SIZE || sizeB < MIN_HASH_MIN_SIZE) return ratio >= 0.5;
    return minHashSimilarity(from.minHashOf(a), to.minHashOf(b)) >= 0.2 || this.similarity(a, b) >= 0.5;
  }

  propagateVtables() {
    const { from, to } = this;
    const votes = new Map();
    const oldImage = from.image;
    const newImage = to.image;
    for (const [oldAddress, newAddress] of this.addresses.best) {
      if (oldAddress % 4 || newAddress % 4) continue;
      for (let slot = 0; slot < MAX_VTABLE_SLOTS; slot++) {
        const oldWord = oldImage.word(oldAddress + slot * 4);
        const newWord = newImage.word(newAddress + slot * 4);
        if (oldWord === null || newWord === null) break;
        if (!oldImage.isTableSlot(oldWord) || !newImage.isTableSlot(newWord)) break;
        const a = from.module.slotFunctions.get(oldWord);
        const b = to.module.slotFunctions.get(newWord);
        if (this.map[a] >= 0 || this.reverse[b] >= 0 || from.signatures[a] !== to.signatures[b]) continue;
        let entry = votes.get(a);
        if (entry === undefined) {
          entry = new Map();
          votes.set(a, entry);
        }
        entry.set(b, (entry.get(b) || 0) + 1);
      }
    }
    return this.acceptVotes(votes, HOW.VTABLE);
  }

  tokensFor(side, func) {
    const cacheKey = side * 2 ** 32 + func;
    let tokens = this.tokenCache.get(cacheKey);
    if (tokens) return tokens;
    const features = side === 0 ? this.from : this.to;
    const module = features.module;
    const buf = module.buffer;
    const { start, end } = module.bodyBounds(func);
    let at = bodyStart(buf, start);
    const list = [];
    const instruction = {};
    while (at < end) {
      readInstruction(buf, at, instruction);
      at = instruction.end;
      const code = instruction.sub >= 0 ? (instruction.op << 12) | instruction.sub : instruction.op;
      let token = mix(0x1234, code);
      switch (instruction.kind) {
        case KIND.CALL: {
          const identity = side === 0 ? this.map[instruction.a] : (this.reverse[instruction.a] >= 0 ? instruction.a : -1);
          token = mix(token, identity >= 0 ? identity : features.signatures[instruction.a] + 0x100000);
          break;
        }
        case KIND.CALL_INDIRECT:
          token = mix(token, features.typeSignatures[instruction.a]);
          break;
        case KIND.BLOCK:
        case KIND.TRY_TABLE:
          token = mix(token, instruction.a >= 0 ? features.typeSignatures[instruction.a] + 1000 : instruction.a);
          break;
        case KIND.MEMARG:
        case KIND.MEMARG_LANE:
          token = mix(token, instruction.a);
          break;
        case KIND.CONST_I32: {
          const value = instruction.a;
          if (value >= 1024 && value < features.heapBase) {
            const identity = side === 0 ? this.addresses.get(value) : (this.newAddressKnown && this.newAddressKnown.has(value) ? value : -1);
            token = mix(token, identity >= 0 ? identity : 0x4b4b4b4b);
          } else {
            token = mix(token, value);
          }
          break;
        }
        case KIND.CONST_F32:
          token = mix(token, instruction.a);
          break;
        case KIND.CONST_F64:
          token = mix(token, instruction.a ^ instruction.b);
          break;
        case KIND.GLOBAL:
        case KIND.INDEX:
        case KIND.BYTE:
        case KIND.LANE:
          token = mix(token, instruction.a);
          break;
        default:
          break;
      }
      list.push(token);
    }
    tokens = Int32Array.from(list);
    if (this.tokenCache.size > 4096) this.tokenCache.clear();
    this.tokenCache.set(cacheKey, tokens);
    return tokens;
  }

  similarity(a, b) {
    const oldTokens = this.tokensFor(0, a);
    const newTokens = this.tokensFor(1, b);
    if (!oldTokens.length && !newTokens.length) return 1;
    const pairs = alignTokens(oldTokens, newTokens);
    return pairs.length / (oldTokens.length + newTokens.length);
  }

  neighborScore(a, b) {
    const { from, to } = this;
    const oldCallees = from.calleesOf(a);
    const newCallees = to.calleesOf(b);
    let agree = 0;
    let known = 0;
    if (oldCallees.length) {
      const targets = new Map();
      for (const callee of newCallees) targets.set(callee, (targets.get(callee) || 0) + 1);
      for (const callee of oldCallees) {
        const mapped = this.map[callee];
        if (mapped < 0) continue;
        known++;
        const left = targets.get(mapped);
        if (left) {
          agree++;
          targets.set(mapped, left - 1);
        }
      }
    }
    const oldStrings = from.stringsOf(a);
    if (oldStrings.length) {
      const set = new Set(to.stringsOf(b));
      for (const id of oldStrings) {
        known++;
        if (set.has(id)) agree++;
      }
    }
    return known ? { agree, known, ratio: agree / known } : { agree: 0, known: 0, ratio: 0.5 };
  }

  fuzzy() {
    const { from, to } = this;
    const buckets = new Map();
    const band = MIN_HASH_BANDS;
    for (let func = to.importCount; func < to.total; func++) {
      if (this.reverse[func] >= 0 || to.sizes[func] < MIN_FUZZY_SIZE) continue;
      const hashes = to.minHashOf(func);
      for (let i = 0; i < band; i++) {
        const key = hashes[i] * 16 + i;
        const list = buckets.get(key);
        if (list === undefined) buckets.set(key, [func]);
        else if (list.length < MAX_BUCKET) list.push(func);
      }
    }
    const byString = new Map();
    for (let func = to.importCount; func < to.total; func++) {
      if (this.reverse[func] >= 0) continue;
      for (const id of to.stringsOf(func)) {
        const list = byString.get(id);
        if (list === undefined) byString.set(id, [func]);
        else if (list.length < MAX_BUCKET) list.push(func);
      }
    }
    const proposals = [];
    for (let func = from.importCount; func < from.total; func++) {
      if (this.map[func] >= 0 || from.sizes[func] < MIN_FUZZY_SIZE) continue;
      const signature = from.signatures[func];
      const candidates = new Map();
      const add = (target, weight) => {
        if (to.signatures[target] !== signature || this.reverse[target] >= 0) return;
        candidates.set(target, (candidates.get(target) || 0) + weight);
      };
      const hashes = from.minHashOf(func);
      for (let i = 0; i < band; i++) {
        const list = buckets.get(hashes[i] * 16 + i);
        if (list) for (const target of list) add(target, 1);
      }
      for (const id of from.stringsOf(func)) {
        const list = byString.get(id);
        if (list) for (const target of list) add(target, 2);
      }
      for (const callee of from.calleesOf(func)) {
        const mapped = this.map[callee];
        if (mapped < 0) continue;
        const callers = to.callersOf(mapped);
        if (callers.length > MAX_BUCKET) continue;
        for (const target of callers) add(target, 1);
      }
      if (!candidates.size) continue;
      const ranked = [...candidates.entries()].sort((x, y) => y[1] - x[1]).slice(0, MAX_FUZZY_CANDIDATES);
      let best = -1;
      let bestScore = 0;
      let secondScore = 0;
      for (const [target] of ranked) {
        const score = this.pairScore(func, target);
        if (score > bestScore) {
          secondScore = bestScore;
          bestScore = score;
          best = target;
        } else if (score > secondScore) {
          secondScore = score;
        }
      }
      if (best >= 0 && bestScore >= FUZZY_ACCEPT && bestScore - secondScore >= FUZZY_MARGIN) proposals.push({ func, target: best, score: bestScore });
    }
    proposals.sort((x, y) => y.score - x.score);
    let linked = 0;
    for (const { func, target, score } of proposals) {
      if (this.map[func] >= 0 || this.reverse[target] >= 0) continue;
      this.link(func, target, HOW.FUZZY);
      (this.fuzzyScores || (this.fuzzyScores = new Map())).set(func, score);
      linked++;
    }
    return linked;
  }

  pairScore(a, b) {
    const sizeA = this.from.sizes[a];
    const sizeB = this.to.sizes[b];
    const ratio = Math.min(sizeA, sizeB) / Math.max(sizeA, sizeB);
    if (ratio < 0.3) return 0;
    const textual = this.similarity(a, b);
    const neighbors = this.neighborScore(a, b);
    const weight = Math.min(1, neighbors.known / 4);
    return textual * (1 - 0.4 * weight) + neighbors.ratio * 0.4 * weight;
  }

  verify() {
    const { from, to } = this;
    let removed = 0;
    for (let func = from.importCount; func < from.total; func++) {
      const target = this.map[func];
      if (target < to.importCount || this.how[func] === HOW.EXPORT) continue;
      if (from.strict[func] === to.strict[target] && from.sizes[func] >= MIN_LONE_SIZE) continue;
      const neighbors = this.neighborScore(func, target);
      if (neighbors.known >= 3 && neighbors.ratio < 0.2) {
        this.unlink(func);
        removed++;
        continue;
      }
      const callers = from.callersOf(func);
      if (callers.length >= 2) {
        let known = 0;
        let agree = 0;
        const expected = new Set(to.callersOf(target));
        for (const caller of callers) {
          const mapped = this.map[caller];
          if (mapped < 0) continue;
          known++;
          if (expected.has(mapped)) agree++;
        }
        if (known >= 3 && agree === 0 && from.sizes[func] < MIN_LONE_SIZE) {
          this.unlink(func);
          removed++;
        }
      }
    }
    return removed;
  }

  twinGroups() {
    const { from, to } = this;
    const groups = new Map();
    const keyOf = (side, features, func) => {
      const callees = this.calleesSignature(side, features, func);
      const hash = new Hash2();
      hash.addNumber(features.canon[func]);
      hash.add(features.signatures[func]);
      hash.addNumber(callees.value);
      hash.addNumber(this.stringsSignature(features, func));
      return hash.value();
    };
    for (let func = from.importCount; func < from.total; func++) {
      if (this.map[func] >= 0) continue;
      const key = keyOf(0, from, func);
      const entry = groups.get(key);
      if (entry) entry.old.push(func);
      else groups.set(key, { old: [func], target: [] });
    }
    for (let func = to.importCount; func < to.total; func++) {
      if (this.reverse[func] >= 0) continue;
      const entry = groups.get(keyOf(1, to, func));
      if (entry) entry.target.push(func);
    }
    return groups;
  }

  twinAgrees(oldFunc, target) {
    const oldList = this.from.addressesOf(oldFunc);
    const newList = this.to.addressesOf(target);
    if (oldList.length !== newList.length) return false;
    for (let i = 0; i < oldList.length; i++) {
      const known = this.addresses.get(oldList[i]);
      if (known >= 0 && known !== newList[i]) return false;
    }
    return true;
  }

  twinsByAddress(old, target) {
    let linked = 0;
    const free = new Set(target);
    for (const oldFunc of old) {
      const fitting = target.filter(func => free.has(func) && this.twinAgrees(oldFunc, func));
      if (fitting.length !== 1) continue;
      const others = old.filter(other => other !== oldFunc && this.map[other] < 0 && this.twinAgrees(other, fitting[0]));
      if (others.length) continue;
      this.link(oldFunc, fitting[0], HOW.TWIN);
      free.delete(fitting[0]);
      linked++;
    }
    return linked;
  }

  layoutPredictor() {
    const known = [...this.addresses.best.keys()].sort((a, b) => a - b);
    return address => {
      let low = 0;
      let high = known.length - 1;
      let found = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (known[middle] <= address) {
          found = known[middle];
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return found < 0 ? -1 : address + this.addresses.best.get(found) - found;
    };
  }

  twinsByLayout(old, target, predict) {
    const byList = new Map();
    for (const func of target) {
      const key = this.to.addressesOf(func).join();
      if (!byList.has(key)) byList.set(key, []);
      byList.get(key).push(func);
    }
    const wanted = new Map();
    for (const func of old) {
      const list = this.from.addressesOf(func);
      if (!list.length) continue;
      const key = Array.from(list, predict).join();
      if (!wanted.has(key)) wanted.set(key, []);
      wanted.get(key).push(func);
    }
    let linked = 0;
    for (const [key, funcs] of wanted) {
      const fitting = byList.get(key);
      if (funcs.length === 1 && fitting && fitting.length === 1) {
        this.link(funcs[0], fitting[0], HOW.TWIN);
        linked++;
      }
    }
    return linked;
  }

  twinsByOrder(old, target) {
    const compare = features => (a, b) => {
      const listA = features.addressesOf(a);
      const listB = features.addressesOf(b);
      const shared = Math.min(listA.length, listB.length);
      for (let i = 0; i < shared; i++) if (listA[i] !== listB[i]) return listA[i] - listB[i];
      return listA.length - listB.length || a - b;
    };
    const sortedOld = old.slice().sort(compare(this.from));
    const sortedNew = target.slice().sort(compare(this.to));
    const sameLists = (features, list) => list.every(func => {
      const first = features.addressesOf(list[0]);
      const other = features.addressesOf(func);
      return first.length === other.length && first.every((value, index) => value === other[index]);
    });
    if (sortedOld.length !== sortedNew.length && !(sameLists(this.from, sortedOld) && sameLists(this.to, sortedNew))) return 0;
    const pairs = Math.min(sortedOld.length, sortedNew.length);
    for (let i = 0; i < pairs; i++) this.link(sortedOld[i], sortedNew[i], HOW.TWIN);
    return pairs;
  }

  twins() {
    let total = 0;
    for (let round = 0; round < TWIN_ROUNDS; round++) {
      let linked = 0;
      for (const { old, target } of this.twinGroups().values()) {
        if (target.length) linked += this.twinsByAddress(old, target);
      }
      total += linked;
      if (!linked) break;
      this.voteAddresses();
    }
    const predict = this.layoutPredictor();
    for (const { old, target } of this.twinGroups().values()) {
      if (target.length) total += this.twinsByLayout(old, target, predict);
    }
    this.voteAddresses();
    const calleesKnown = (side, features, func) => {
      const signature = this.calleesSignature(side, features, func);
      return signature.known === features.calleesOf(func).length;
    };
    for (let round = 0; round < TWIN_ORDER_ROUNDS; round++) {
      let linked = 0;
      for (const { old, target } of this.twinGroups().values()) {
        if (!target.length) continue;
        if (old.every(func => calleesKnown(0, this.from, func)) && target.every(func => calleesKnown(1, this.to, func))) linked += this.twinsByOrder(old, target);
      }
      total += linked;
      if (!linked) break;
    }
    for (const { old, target } of this.twinGroups().values()) {
      if (target.length) total += this.twinsByOrder(old, target);
    }
    return total;
  }

  run() {
    const { log } = this;
    this.matchImports();
    this.matchExports();
    this.seedStringAddresses();
    this.addresses.settle();
    this.newAddressKnown = new Set(this.addresses.best.values());
    const keys = this.buildKeys();
    for (let round = 0; round < 12; round++) {
      let linked = 0;
      for (const [name, how, keyOf] of keys) {
        linked += this.sweep(`round ${round} ${name}`, keyOf, how);
      }
      this.voteAddresses();
      for (let pass = 0; pass < 8; pass++) {
        const propagated = this.propagate();
        const vtables = this.propagateVtables();
        linked += propagated + vtables;
        if (propagated || vtables) log(`  round ${round} propagate ${propagated}, vtables ${vtables}`);
        if (!propagated && !vtables) break;
        this.voteAddresses();
      }
      log(`round ${round}: ${linked} new, ${this.matchedCount()} of ${this.from.count} matched`);
      if (!linked) break;
    }
    for (let round = 0; round < 3; round++) {
      const fuzzy = this.fuzzy();
      this.voteAddresses();
      let extra = 0;
      for (const [name, how, keyOf] of keys) extra += this.sweep(`fuzzy ${name}`, keyOf, how);
      for (let pass = 0; pass < 4; pass++) {
        const added = this.propagate() + this.propagateVtables();
        extra += added;
        if (!added) break;
      }
      this.voteAddresses();
      log(`fuzzy round ${round}: ${fuzzy} fuzzy, ${extra} follow-up, ${this.matchedCount()} matched`);
      if (!fuzzy && !extra) break;
    }
    const removed = this.verify();
    if (removed) log(`verification removed ${removed} weak match(es)`);
    const twins = this.twins();
    if (twins) log(`twins: ${twins}`);
    this.voteAddresses();
    return this;
  }

  serialize() {
    const addresses = [...this.addresses.best.entries()].flat();
    const fuzzy = this.fuzzyScores ? [...this.fuzzyScores.entries()].flat() : [];
    const head = Buffer.from(JSON.stringify({ oldTotal: this.from.total, newTotal: this.to.total, addresses: addresses.length, fuzzy: fuzzy.length }));
    const size = Buffer.alloc(4);
    size.writeUInt32LE(head.length);
    return Buffer.concat([
      size, head,
      Buffer.from(this.map.buffer, this.map.byteOffset, this.map.byteLength),
      Buffer.from(this.how.buffer, this.how.byteOffset, this.how.byteLength),
      Buffer.from(Float64Array.from(addresses).buffer),
      Buffer.from(Float64Array.from(fuzzy).buffer),
    ]);
  }

  restore(data) {
    const headSize = data.readUInt32LE(0);
    const head = JSON.parse(data.toString('utf8', 4, 4 + headSize));
    if (head.oldTotal !== this.from.total || head.newTotal !== this.to.total) throw new Error('the cached match belongs to other builds');
    let at = 4 + headSize;
    const copy = (Type, count) => {
      const bytes = count * Type.BYTES_PER_ELEMENT;
      const out = new Type(data.buffer.slice(data.byteOffset + at, data.byteOffset + at + bytes));
      at += bytes;
      return out;
    };
    this.map = copy(Int32Array, head.oldTotal);
    this.how = copy(Uint8Array, head.oldTotal);
    const addresses = copy(Float64Array, head.addresses);
    const fuzzy = copy(Float64Array, head.fuzzy);
    this.reverse = new Int32Array(this.to.total).fill(-1);
    for (let func = 0; func < this.map.length; func++) if (this.map[func] >= 0 && this.reverse[this.map[func]] < 0) this.reverse[this.map[func]] = func;
    this.addresses.best = new Map();
    this.addresses.confidence = new Map();
    for (let i = 0; i < addresses.length; i += 2) {
      this.addresses.best.set(addresses[i], addresses[i + 1]);
      this.addresses.confidence.set(addresses[i], { votes: 1, share: 1 });
    }
    this.newAddressKnown = new Set(this.addresses.best.values());
    this.fuzzyScores = new Map();
    for (let i = 0; i < fuzzy.length; i += 2) this.fuzzyScores.set(fuzzy[i], fuzzy[i + 1]);
    return this;
  }

  stats() {
    const { from } = this;
    const counts = {};
    let matchedSize = 0;
    let totalSize = 0;
    for (let func = from.importCount; func < from.total; func++) {
      const name = HOW_NAMES[this.how[func]];
      counts[name] = (counts[name] || 0) + 1;
      totalSize += from.sizes[func];
      if (this.map[func] >= 0) matchedSize += from.sizes[func];
    }
    let edges = 0;
    let keptEdges = 0;
    const targets = new Map();
    for (let func = from.importCount; func < from.total; func++) {
      const mapped = this.map[func];
      if (mapped < this.to.importCount) continue;
      targets.clear();
      for (const callee of this.to.calleesOf(mapped)) targets.set(callee, (targets.get(callee) || 0) + 1);
      for (const callee of from.calleesOf(func)) {
        const target = this.map[callee];
        if (target < 0) continue;
        edges++;
        const left = targets.get(target);
        if (left) {
          keptEdges++;
          targets.set(target, left - 1);
        }
      }
    }
    return { counts, functions: from.count, matched: this.matchedCount(), matchedInstructions: matchedSize / totalSize, callEdges: edges, callEdgesKept: edges ? keptEdges / edges : 1, addresses: this.addresses.best.size };
  }
}

module.exports = { Matcher, AddressMap, HOW, HOW_NAMES };
