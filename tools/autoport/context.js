'use strict';

const { KIND } = require('./wasm/module');
const { findAll, closest, afterLocals } = require('./wasm/asm');
const { listing } = require('./wasm/print');
const { alignTokens, gaps } = require('./match/align');
const { HOW_NAMES } = require('./match/matcher');
const { AddressResolver } = require('./match/addresses');
const { FunctionInference } = require('./match/infer');

class PortError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

function instructionToken(instruction) {
  return instruction.sub >= 0 ? (instruction.op << 12) | instruction.sub : instruction.op;
}

class FunctionEdits {
  constructor(module, func) {
    this.module = module;
    this.func = func;
    this.base = module.bodyBounds(func).start;
    this.body = module.body(func);
    this.splices = [];
  }

  relative(position) {
    return position - this.base;
  }

  replace(start, end, bytes) {
    this.splices.push({ start: this.relative(start), end: this.relative(end), bytes, order: this.splices.length });
  }

  insertAt(position, bytes) {
    this.replace(position, position, bytes);
  }

  insertHead(bytes) {
    const head = afterLocals(this.body);
    this.splices.push({ start: head, end: head, bytes, order: this.splices.length });
  }

  build() {
    const isReplacement = splice => (splice.end > splice.start ? 1 : 0);
    const sorted = [...this.splices].sort((a, b) => a.start - b.start || isReplacement(a) - isReplacement(b) || a.order - b.order);
    const parts = [];
    let at = 0;
    for (const splice of sorted) {
      if (splice.start < at) throw new PortError(`overlapping edits in function ${this.func}`);
      parts.push(this.body.subarray(at, splice.start), splice.bytes);
      at = splice.end;
    }
    parts.push(this.body.subarray(at));
    return Buffer.concat(parts);
  }
}

class PortContext {
  constructor({ oldModule, newModule, matcher, profile, identity = false }) {
    this.oldModule = oldModule;
    this.newModule = newModule;
    this.matcher = matcher;
    this.profile = profile;
    this.identity = identity;
    this.decodedCache = new Map();
    this.alignmentCache = new Map();
    this.notes = [];
    this.symbolEvidence = new Map();
    this.boundFunctions = new Map();
    this.witnessed = new Set();
  }

  note(message) {
    this.notes.push(message);
  }

  decoded(side, func) {
    const key = `${side}:${func}`;
    let list = this.decodedCache.get(key);
    if (!list) {
      list = (side === 'old' ? this.oldModule : this.newModule).decode(func);
      this.decodedCache.set(key, list);
    }
    return list;
  }

  oldFunc(name) {
    const value = this.profile.wasm.functions[name];
    if (value === undefined) throw new PortError(`the profile has no function called ${name}`);
    return value;
  }

  mapFunction(oldIndex) {
    if (this.identity) return oldIndex;
    return this.matcher.map[oldIndex];
  }

  inferenceEngine() {
    if (!this.inference) {
      this.inference = new FunctionInference({
        matcher: this.matcher,
        alignmentFor: (func, target) => ({ alignment: this.alignment(func, target), oldDecoded: this.decoded('old', func), newDecoded: this.decoded('new', target) }),
      });
    }
    return this.inference;
  }

  inferFunction(oldIndex) {
    if (this.identity) return { value: oldIndex, how: 'identity', detail: '' };
    return this.inferenceEngine().resolve(oldIndex);
  }

  confirmFunction(oldIndex, target) {
    if (this.identity) return 'identity';
    return this.inferenceEngine().confirm(oldIndex, target);
  }

  reconsiderFunction(oldIndex, target) {
    if (this.identity) return { keep: true, detail: 'identity' };
    return this.inferenceEngine().reconsider(oldIndex, target);
  }

  func(name) {
    if (this.boundFunctions.has(name)) return this.boundFunctions.get(name);
    const oldIndex = this.oldFunc(name);
    let target = this.mapFunction(oldIndex);
    let inferred = null;
    if (target === undefined || target < 0) {
      inferred = this.inferFunction(oldIndex);
      if (inferred) target = inferred.value;
    }
    if (target === undefined || target < 0) throw new PortError(`no match for ${name} (function ${oldIndex} in the old build)`, { symbol: name });
    this.boundFunctions.set(name, target);
    this.recordEvidence(name, oldIndex, target, inferred);
    return target;
  }

  recordEvidence(name, oldIndex, target, inferred = null) {
    if (this.symbolEvidence.has(name)) return;
    if (this.identity) {
      this.symbolEvidence.set(name, { old: oldIndex, target, how: 'identity', similarity: 1, witness: this.witnessed.has(name) });
      return;
    }
    const matcher = this.matcher;
    const entry = { old: oldIndex, target, how: inferred ? inferred.how : HOW_NAMES[matcher.how[oldIndex]], witness: this.witnessed.has(name) };
    if (inferred) {
      entry.inferred = true;
      entry.detail = inferred.detail;
    }
    if (oldIndex >= this.oldModule.importCount && target >= this.newModule.importCount) {
      entry.similarity = +matcher.similarity(oldIndex, target).toFixed(4);
      entry.unchanged = matcher.from.canon[oldIndex] === matcher.to.canon[target];
      const neighbors = matcher.neighborScore(oldIndex, target);
      entry.neighbors = `${neighbors.agree}/${neighbors.known}`;
      entry.neighborRatio = neighbors.known ? neighbors.agree / neighbors.known : 1;
    }
    this.symbolEvidence.set(name, entry);
  }

  bindFunction(name, target, source) {
    const known = this.boundFunctions.get(name);
    if (known !== undefined && known !== target) throw new PortError(`${source} says ${name} is function ${target}, but it was already resolved to ${known}`, { symbol: name });
    const oldIndex = this.profile.wasm.functions[name];
    if (oldIndex !== undefined && !this.identity) {
      const matched = this.matcher.map[oldIndex];
      if (matched >= 0 && matched !== target) {
        this.note(`${name}: the code at ${source} calls function ${target}, but the function matcher said ${matched}. Using the call site.`);
      }
    }
    this.boundFunctions.set(name, target);
    if (oldIndex !== undefined) this.recordEvidence(name, oldIndex, target);
    this.witness(name);
    return target;
  }

  unchanged(name) {
    if (this.identity) return true;
    const oldIndex = this.oldFunc(name);
    const target = this.func(name);
    return this.matcher.from.canon[oldIndex] === this.matcher.to.canon[target];
  }

  requireUnchanged(names, reason) {
    const changed = names.filter(name => !this.unchanged(name));
    if (changed.length) throw new PortError(`${changed.join(', ')} changed, and ${reason}`, { changed });
  }

  site(name, builder, options = {}) {
    const target = options.func !== undefined ? options.func : this.func(name);
    const decoded = this.decoded('new', target);
    const pattern = builder(symbol => this.func(symbol));
    const initial = options.bindings || new Map();
    const hits = findAll(decoded, pattern, initial);
    const describe = () => {
      const best = closest(decoded, pattern, initial);
      return {
        symbol: name,
        func: target,
        site: options.label || '',
        closestMatch: best.index >= 0 ? `${best.reached} of ${pattern.length} instructions matched at instruction ${best.index}` : 'the first instruction never appears',
        nearby: best.index >= 0 ? listing(decoded, Math.max(0, best.index - 4), best.index + pattern.length + 8) : '',
      };
    };
    if (!hits.length) throw new PortError(`${options.label || 'a site'} in ${name} was not found`, describe());
    this.witness(name);
    if (hits.length === 1 || options.first) return hits[0];
    const chosen = this.disambiguate(name, target, builder, hits, options);
    if (!chosen) throw new PortError(`${options.label || 'a site'} in ${name} matched ${hits.length} places and the old build does not say which one`, describe());
    return chosen;
  }

  witness(name) {
    this.witnessed.add(name);
    const entry = this.symbolEvidence.get(name);
    if (entry) entry.witness = true;
  }

  disambiguate(name, target, builder, hits, options) {
    const oldIndex = options.oldFunc !== undefined ? options.oldFunc : this.profile.wasm.functions[name];
    if (!options.expect || oldIndex === undefined) return null;
    const pattern = builder(symbol => this.oldFunc(symbol));
    const oldDecoded = this.decoded('old', oldIndex);
    const oldHits = findAll(oldDecoded, pattern, options.bindings || new Map());
    const wanted = oldHits.findIndex(hit => Object.entries(options.expect).every(([key, value]) => hit.bindings.get(key) === value));
    if (wanted < 0) return null;
    if (this.identity) return hits[wanted] || null;
    if (oldHits.length === hits.length) return hits[wanted];
    const alignment = this.alignment(oldIndex, target);
    const mapped = alignment.newIndexFor(oldHits[wanted].index);
    if (mapped < 0) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const hit of hits) {
      const distance = Math.abs(hit.index - mapped);
      if (distance < bestDistance) {
        best = hit;
        bestDistance = distance;
      }
    }
    return bestDistance <= 8 ? best : null;
  }

  alignment(oldIndex, target) {
    const key = `${oldIndex}:${target}`;
    let result = this.alignmentCache.get(key);
    if (result) return result;
    const oldDecoded = this.decoded('old', oldIndex);
    const newDecoded = this.decoded('new', target);
    let pairs;
    if (this.identity) {
      pairs = [];
      for (let i = 0; i < oldDecoded.length; i++) pairs.push(i, i);
    } else {
      pairs = alignTokens(this.matcher.tokensFor(0, oldIndex), this.matcher.tokensFor(1, target));
    }
    const newByOld = new Int32Array(oldDecoded.length).fill(-1);
    const exact = new Uint8Array(oldDecoded.length);
    for (let i = 0; i < pairs.length; i += 2) {
      newByOld[pairs[i]] = pairs[i + 1];
      exact[pairs[i]] = 1;
    }
    for (const gap of gaps(pairs, oldDecoded.length, newDecoded.length)) {
      const oldTokens = Int32Array.from(oldDecoded.slice(gap.aStart, gap.aEnd), instructionToken);
      const newTokens = Int32Array.from(newDecoded.slice(gap.bStart, gap.bEnd), instructionToken);
      const inner = alignTokens(oldTokens, newTokens);
      for (let i = 0; i < inner.length; i += 2) newByOld[gap.aStart + inner[i]] = gap.bStart + inner[i + 1];
    }
    result = {
      newByOld,
      exact,
      similarity: oldDecoded.length + newDecoded.length ? pairs.length / (oldDecoded.length + newDecoded.length) : 1,
      newIndexFor: index => (index >= 0 && index < newByOld.length ? newByOld[index] : -1),
    };
    this.alignmentCache.set(key, result);
    return result;
  }

  translateImmediate(name, oldValue, isCandidate) {
    const oldIndex = this.oldFunc(name);
    const target = this.func(name);
    if (this.identity) return oldValue;
    const oldDecoded = this.decoded('old', oldIndex);
    const newDecoded = this.decoded('new', target);
    const alignment = this.alignment(oldIndex, target);
    const votes = new Map();
    let total = 0;
    for (let i = 0; i < oldDecoded.length; i++) {
      const instruction = oldDecoded[i];
      if (!isCandidate(instruction) || instruction.a !== oldValue) continue;
      const mapped = alignment.newIndexFor(i);
      if (mapped < 0) continue;
      const other = newDecoded[mapped];
      if (other.op !== instruction.op || other.sub !== instruction.sub) continue;
      votes.set(other.a, (votes.get(other.a) || 0) + (alignment.exact[i] ? 4 : 1));
      total++;
    }
    if (!total) throw new PortError(`no aligned instruction in ${name} carries the value ${oldValue}`, { symbol: name, value: oldValue });
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length > 1 && ranked[0][1] < 3 * ranked[1][1]) throw new PortError(`${name}: the value ${oldValue} maps to ${ranked.map(([value, count]) => `${value} (${count})`).join(' and ')}`, { symbol: name, value: oldValue });
    return ranked[0][0];
  }

  translateOffset(name, oldValue) {
    return this.translateImmediate(name, oldValue, instruction => instruction.kind === KIND.MEMARG && instruction.op >= 0x28 && instruction.op <= 0x3e);
  }

  translateConstant(name, oldValue) {
    return this.translateImmediate(name, oldValue, instruction => instruction.op === 0x41);
  }

  resolveAddress(oldValue) {
    if (this.identity) return { value: oldValue, how: 'identity' };
    if (!this.addressResolver) {
      this.addressResolver = new AddressResolver(this.matcher, (func, target) => ({
        alignment: this.alignment(func, target),
        oldDecoded: this.decoded('old', func),
        newDecoded: this.decoded('new', target),
      }));
    }
    return this.addressResolver.resolve(oldValue);
  }

  edits(func) {
    return new FunctionEdits(this.newModule, func);
  }
}

function value(bindings, name) {
  const found = bindings.get(name);
  if (found === undefined) throw new PortError(`the pattern did not bind ${name}`);
  return found;
}

module.exports = { PortContext, PortError, FunctionEdits, value };
