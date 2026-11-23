'use strict';

const CALL = 0x10;
const LOCAL_GET = 0x20;
const I32_CONST = 0x41;
const END = 0x0b;
const MAX_CALLERS = 64;
const MIN_CALL_SITE_VOTES = 2;
const MIN_CALL_SITE_SHARE = 0.75;
const MAX_THUNK_INSTRUCTIONS = 8;
const MAX_CANDIDATES = 512;
const MIN_EQUIVALENT_SIMILARITY = 0.7;
const MIN_CALLEE_OVERLAP = 0.6;
const CLOSE_SCORE = 0.05;
const TABLE_RADIUS = 3;
const MIN_TABLE_AGREEMENT = 2;
const MIN_TABLE_SIMILARITY = 0.6;
const TABLE_WORDS = 2;
const MAX_EFFECT_INSTRUCTIONS = 64;
const LOCAL_SET = 0x21;
const LOCAL_TEE = 0x22;
const FIRST_LOAD = 0x28;
const LAST_LOAD = 0x35;
const FIRST_STORE = 0x36;
const LAST_STORE = 0x3e;

class FunctionInference {
  constructor({ matcher, alignmentFor }) {
    this.matcher = matcher;
    this.alignmentFor = alignmentFor;
    this.from = matcher.from;
    this.to = matcher.to;
    this.results = new Map();
    this.wordIndex = new Map();
    this.newUsers = null;
    this.newSlots = null;
  }

  resolve(oldFunc) {
    if (this.results.has(oldFunc)) return this.results.get(oldFunc);
    let result = null;
    if (oldFunc >= this.from.importCount && oldFunc < this.from.total) {
      result = this.byCallSites(oldFunc) || this.byEquivalentCode(oldFunc) || this.byEffects(oldFunc) || this.byTablePosition(oldFunc);
    }
    this.results.set(oldFunc, result);
    return result;
  }

  confirm(oldFunc, target) {
    const effects = this.effectsOf(this.from, oldFunc);
    if (effects !== null && effects === this.effectsOf(this.to, target)) return 'store effects: the same stores from the same fields';
    for (const check of [() => this.byCallSites(oldFunc), () => this.byTablePosition(oldFunc), () => this.byEquivalentCode(oldFunc)]) {
      const result = check();
      if (result && result.value === target) return `${result.how}: ${result.detail}`;
    }
    return null;
  }

  reconsider(oldFunc, target) {
    const confirmed = this.confirm(oldFunc, target);
    if (confirmed) return { keep: true, detail: confirmed };
    const effects = this.effectsOf(this.from, oldFunc);
    if (effects === null) return { keep: true, detail: null };
    const same = (this.effectIndex().get(effects) || []).filter(func => this.to.signatures[func] === this.from.signatures[oldFunc]);
    if (!same.length) return { keep: true, detail: null };
    return { keep: false, value: same[0], how: 'store effects', detail: `${target} does different stores, and ${same.length} function(s) such as ${same[0]} do the same stores from the same fields` };
  }

  effectsOf(features, func) {
    const cache = this.effectCache || (this.effectCache = new Map());
    const key = `${features === this.from ? 'o' : 'n'}${func}`;
    if (cache.has(key)) return cache.get(key);
    let result = null;
    if (func >= features.importCount && func < features.total) {
      const decoded = features.module.decode(func);
      if (decoded.length <= MAX_EFFECT_INSTRUCTIONS) result = this.storeEffects(decoded);
    }
    cache.set(key, result);
    return result;
  }

  storeEffects(decoded) {
    const stack = [];
    const locals = new Map();
    const stores = [];
    for (const instruction of decoded) {
      const { op, a } = instruction;
      if (op === LOCAL_GET) stack.push(locals.has(a) ? locals.get(a) : `arg${a}`);
      else if (op === LOCAL_SET || op === LOCAL_TEE) {
        const value = stack.pop();
        locals.set(a, value);
        if (op === LOCAL_TEE) stack.push(value);
      } else if (op === I32_CONST) stack.push(`#${a}`);
      else if (op >= FIRST_LOAD && op <= LAST_LOAD) stack.push(`load${op}(${stack.pop()}+${a})`);
      else if (op >= FIRST_STORE && op <= LAST_STORE) {
        const value = stack.pop();
        const base = stack.pop();
        stores.push(`${base}+${a}:${op}=${value}`);
      } else if (op !== END) return null;
    }
    if (!stores.length || stack.length) return null;
    return stores.sort().join(';');
  }

  effectIndex() {
    if (!this.effects) {
      this.effects = new Map();
      const { to } = this;
      for (let func = to.importCount; func < to.total; func++) {
        if (to.sizes[func] > MAX_EFFECT_INSTRUCTIONS) continue;
        const effects = this.effectsOf(to, func);
        if (effects === null) continue;
        if (!this.effects.has(effects)) this.effects.set(effects, []);
        this.effects.get(effects).push(func);
      }
    }
    return this.effects;
  }

  byEffects(oldFunc) {
    const effects = this.effectsOf(this.from, oldFunc);
    if (effects === null) return null;
    const same = (this.effectIndex().get(effects) || []).filter(func => this.to.signatures[func] === this.from.signatures[oldFunc]);
    if (!same.length) return null;
    return { value: same[0], how: 'store effects', detail: `${same.length} function(s) do the same stores from the same fields` };
  }

  byCallSites(oldFunc) {
    const { from, to, matcher } = this;
    const votes = new Map();
    let total = 0;
    for (const caller of [...new Set(from.callersOf(oldFunc))].slice(0, MAX_CALLERS)) {
      const target = matcher.map[caller];
      if (!(target >= to.importCount)) continue;
      const { alignment, oldDecoded, newDecoded } = this.alignmentFor(caller, target);
      for (let i = 0; i < oldDecoded.length; i++) {
        if (oldDecoded[i].op !== CALL || oldDecoded[i].a !== oldFunc) continue;
        const mapped = alignment.newIndexFor(i);
        if (mapped < 0 || newDecoded[mapped].op !== CALL) continue;
        const weight = alignment.exact[i] ? 2 : 1;
        votes.set(newDecoded[mapped].a, (votes.get(newDecoded[mapped].a) || 0) + weight);
        total += weight;
      }
    }
    if (!total) return null;
    const [target, count] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (count < MIN_CALL_SITE_VOTES || count / total < MIN_CALL_SITE_SHARE) return null;
    if (target < to.importCount || to.signatures[target] !== from.signatures[oldFunc]) return null;
    return { value: target, how: 'call sites', detail: `${count} of ${total} call site votes` };
  }

  slotsOf(module, func) {
    if (module === this.to.module) {
      if (!this.newSlots) {
        this.newSlots = new Map();
        for (const [slot, target] of module.slotFunctions) {
          if (!this.newSlots.has(target)) this.newSlots.set(target, []);
          this.newSlots.get(target).push(slot);
        }
      }
      return this.newSlots.get(func) || [];
    }
    const slots = [];
    for (const [slot, target] of module.slotFunctions) if (target === func) slots.push(slot);
    return slots;
  }

  wordsIn(features) {
    let index = this.wordIndex.get(features);
    if (!index) {
      index = new Map();
      const { image, module } = features;
      const bytes = image.bytes;
      for (let at = 0; at + 4 <= bytes.length; at += 4) {
        const word = bytes.readUInt32LE(at);
        if (!module.slotFunctions.has(word)) continue;
        if (!index.has(word)) index.set(word, []);
        index.get(word).push(at + image.low);
      }
      this.wordIndex.set(features, index);
    }
    return index;
  }

  usersOfNew(address) {
    if (!this.newUsers) {
      this.newUsers = new Map();
      const { to } = this;
      for (let func = to.importCount; func < to.total; func++) {
        for (const value of to.addressesOf(func)) {
          if (!this.newUsers.has(value)) this.newUsers.set(value, []);
          const list = this.newUsers.get(value);
          if (list[list.length - 1] !== func) list.push(func);
        }
      }
    }
    return this.newUsers.get(address) || [];
  }

  mappedWord(word) {
    if (word === 0) return { zero: true };
    const func = this.from.module.slotFunctions.get(word);
    if (func === undefined) return null;
    const target = this.matcher.map[func];
    if (!(target >= 0)) return null;
    return { target };
  }

  newWordIs(word, wanted) {
    if (wanted.zero) return word === 0;
    return this.to.module.slotFunctions.get(word) === wanted.target;
  }

  oldTables(oldFunc) {
    const tables = [];
    for (const address of new Set(this.from.addressesOf(oldFunc))) {
      if (!this.from.image.contains(address)) continue;
      const base = address & ~3;
      const words = [];
      for (let k = 0; k < TABLE_WORDS; k++) {
        const mapped = this.mappedWord(this.from.image.word(base + k * 4));
        if (!mapped) break;
        words.push(mapped);
      }
      if (words.length === TABLE_WORDS && !words[0].zero) tables.push({ tag: address - base, words });
    }
    return tables;
  }

  tableMatches(table, address) {
    if (!this.to.image.contains(address) || (address & 3) !== table.tag) return false;
    const base = address - table.tag;
    return table.words.every((wanted, k) => this.newWordIs(this.to.image.word(base + k * 4), wanted));
  }

  thunk(func) {
    const decoded = this.to.module.decode(func);
    if (decoded.length > MAX_THUNK_INSTRUCTIONS) return null;
    const constants = [];
    let callee = -1;
    for (let i = 0; i < decoded.length; i++) {
      const { op, a } = decoded[i];
      if (op === LOCAL_GET) continue;
      if (op === I32_CONST) constants.push(a);
      else if (op === CALL && callee < 0) callee = a;
      else if (op === END && i === decoded.length - 1) break;
      else return null;
    }
    return callee >= this.to.importCount ? { body: callee, constants } : null;
  }

  expanded(func) {
    const thunk = this.thunk(func);
    if (thunk) return { body: thunk.body, constants: [...thunk.constants, ...this.to.addressesOf(thunk.body)] };
    return { body: func, constants: [...this.to.addressesOf(func)] };
  }

  candidatesFor(oldFunc, tables, callees) {
    const { to } = this;
    const found = new Set();
    const wordIndex = this.wordsIn(to);
    for (const table of tables) {
      for (const slot of this.slotsOf(to.module, table.words[0].target)) {
        for (const at of wordIndex.get(slot) || []) {
          for (const user of this.usersOfNew(at + table.tag)) {
            found.add(user);
            for (const caller of to.callersOf(user)) if (found.size < MAX_CANDIDATES) found.add(caller);
          }
        }
      }
    }
    if (!found.size && callees.length) {
      const rarest = callees.slice().sort((a, b) => to.callersOf(a).length - to.callersOf(b).length)[0];
      for (const caller of to.callersOf(rarest)) {
        if (found.size >= MAX_CANDIDATES) break;
        found.add(caller);
        for (const thunkCaller of to.callersOf(caller)) if (to.sizes[thunkCaller] <= MAX_THUNK_INSTRUCTIONS * 3) found.add(thunkCaller);
      }
    }
    return [...found].filter(func => func >= to.importCount && to.signatures[func] === this.from.signatures[oldFunc]);
  }

  byEquivalentCode(oldFunc) {
    const { from, to, matcher } = this;
    const oldCallees = [...new Set(from.calleesOf(oldFunc))];
    const callees = oldCallees.map(callee => matcher.map[callee]).filter(target => target >= to.importCount);
    const tables = this.oldTables(oldFunc);
    if (!tables.length && !callees.length) return null;
    const wanted = new Set(callees);
    const scored = [];
    for (const candidate of this.candidatesFor(oldFunc, tables, callees)) {
      const { body, constants } = this.expanded(candidate);
      if (tables.length && !tables.every(table => constants.some(address => this.tableMatches(table, address)))) continue;
      const got = new Set(to.calleesOf(body));
      let shared = 0;
      for (const callee of wanted) if (got.has(callee)) shared++;
      const overlap = wanted.size ? shared / (wanted.size + got.size - shared) : 1;
      if (overlap < MIN_CALLEE_OVERLAP) continue;
      const similarity = matcher.similarity(oldFunc, body);
      if (similarity < MIN_EQUIVALENT_SIMILARITY) continue;
      scored.push({ candidate, body, similarity, overlap });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.similarity - a.similarity || a.candidate - b.candidate);
    const best = scored[0];
    const close = scored.filter(entry => best.similarity - entry.similarity < CLOSE_SCORE);
    const thunked = best.body !== best.candidate ? `, a thunk for ${best.body}` : '';
    const alternatives = close.length > 1 ? `; ${close.length - 1} equivalent alternative(s): ${close.slice(1, 4).map(entry => entry.candidate).join(', ')}` : '';
    return { value: best.candidate, how: 'equivalent code', detail: `similarity ${best.similarity.toFixed(3)}, callee overlap ${best.overlap.toFixed(2)}${tables.length ? ', same table contents' : ''}${thunked}${alternatives}` };
  }

  tableAgreement(oldEntry, newEntry) {
    let agree = 0;
    for (const step of [-1, 1]) {
      for (let k = 1; k <= TABLE_RADIUS; k++) {
        const oldWord = this.from.image.word(oldEntry + step * k * 4);
        const newWord = this.to.image.word(newEntry + step * k * 4);
        if (oldWord === null || newWord === null) break;
        const mapped = this.mappedWord(oldWord);
        if (!mapped || !this.newWordIs(newWord, mapped)) break;
        if (!mapped.zero) agree++;
      }
    }
    return agree;
  }

  byTablePosition(oldFunc) {
    const { from, to, matcher } = this;
    const oldIndex = this.wordsIn(from);
    const newIndex = this.wordsIn(to);
    const scores = new Map();
    for (const slot of this.slotsOf(from.module, oldFunc)) {
      for (const entry of oldIndex.get(slot) || []) {
        for (let k = -TABLE_RADIUS; k <= TABLE_RADIUS; k++) {
          if (!k) continue;
          const mapped = this.mappedWord(from.image.word(entry + k * 4));
          if (!mapped || mapped.zero) continue;
          for (const newSlot of this.slotsOf(to.module, mapped.target)) {
            for (const at of newIndex.get(newSlot) || []) {
              const position = at - k * 4;
              const func = to.module.slotFunctions.get(to.image.word(position));
              if (func === undefined || to.signatures[func] !== from.signatures[oldFunc]) continue;
              const agree = this.tableAgreement(entry, position);
              const known = scores.get(func);
              if (!known || agree > known.agree) scores.set(func, { func, agree, position });
            }
          }
        }
      }
    }
    const ranked = [...scores.values()].sort((a, b) => b.agree - a.agree);
    if (!ranked.length || ranked[0].agree < MIN_TABLE_AGREEMENT) return null;
    if (ranked[1] && ranked[1].agree === ranked[0].agree) return null;
    const best = ranked[0];
    const similarity = matcher.similarity(oldFunc, best.func);
    if (similarity < MIN_TABLE_SIMILARITY) return null;
    return { value: best.func, how: 'table position', detail: `${best.agree} neighbouring table entries agree, similarity ${similarity.toFixed(3)}` };
  }
}

module.exports = { FunctionInference };
