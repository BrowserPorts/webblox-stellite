'use strict';

const fs = require('fs');
const path = require('path');
const L = require('../luau/bytecode');
const { readModuleScripts } = require('../luau/rbxm');
const { alignTokens } = require('../match/align');
const { hashString } = require('../match/features');
const { decodePng } = require('../../png');

const WORDMARK_IMAGE = 'icons/logo/letterform';
const IMAGE_TABLE = 'GetImageSetData';
const SHEET_DIR = ['ExtraContent', 'LuaPackages', 'Packages', '_Index', 'FoundationImages', 'FoundationImages', 'SpriteSheets'];
const VISIBLE_NUMERATOR = 26;
const VISIBLE_DENOMINATOR = 36;
const MIN_PROTO_SIMILARITY = 0.8;
const MIN_PROTO_MARGIN = 0.05;
const MIN_SPRITE_MATCH = 0.6;
const WORD = 4;
const SCALES = 3;

function constantKey(proto, index) {
  const constant = proto.constants[index];
  if (!constant) return `?${index}`;
  if (constant.type === 'string') return `s:${constant.value}`;
  if (constant.type === 'number') return `n:${constant.value}`;
  if (constant.type === 'boolean') return `b:${constant.value}`;
  if (constant.type === 'import') return `i:${importPath(proto, constant.id)}`;
  return constant.type;
}

function importPath(proto, id) {
  const count = id >>> 30;
  const parts = [];
  for (let i = 0; i < count; i++) parts.push(constantKey(proto, (id >>> (20 - i * 10)) & 1023));
  return parts.join('.');
}

const K_AUX_OPS = new Set([7, 8, 15, 16, 20]);
const K_D_OPS = new Set([5, 12, 54]);

function normalize(module, proto) {
  return L.instructions(module, proto).map(instruction => {
    const { op, a, b, c, d, aux } = instruction;
    if (K_AUX_OPS.has(op)) return `${op}:${a}:${b}:${constantKey(proto, aux)}`;
    if (K_D_OPS.has(op)) return `${op}:${a}:${constantKey(proto, d)}`;
    if (aux !== null) return `${op}:${a}:${b}:${c}:${aux}`;
    return `${op}:${a}:${b}:${c}`;
  });
}

function hashList(tokens) {
  return tokens.map(hashString);
}

function protoAt(module, at) {
  return module.protos.find(proto => at >= proto.codeOffset && at < proto.codeOffset + proto.count * WORD) || null;
}

function rareStrings(proto, limit = 4) {
  return proto.constants.filter(constant => constant.type === 'string' && constant.value.length >= 8).map(constant => constant.value).sort((a, b) => b.length - a.length).slice(0, limit);
}

class ModelSet {
  constructor(models) {
    this.models = models;
    this.scripts = new Map(Object.entries(models).map(([name, data]) => [name, readModuleScripts(data)]));
    this.parsed = new Map();
  }

  parse(source) {
    let module = this.parsed.get(source);
    if (!module) {
      module = L.parse(source);
      this.parsed.set(source, module);
    }
    return module;
  }

  modulesNamed(name) {
    const out = [];
    for (const [model, scripts] of this.scripts) {
      scripts.names.forEach((scriptName, index) => {
        if (scriptName === name) out.push({ model, name, source: scripts.sources[index] });
      });
    }
    return out;
  }

  modulesContaining(strings) {
    const needles = strings.map(text => Buffer.from(text, 'latin1'));
    const out = [];
    for (const [model, scripts] of this.scripts) {
      scripts.sources.forEach((source, index) => {
        if (needles.every(needle => source.includes(needle))) out.push({ model, name: scripts.names[index], source });
      });
    }
    return out;
  }

  count(bytes) {
    let total = 0;
    for (const scripts of this.scripts.values()) {
      for (const source of scripts.sources) {
        for (let at = source.indexOf(bytes); at >= 0; at = source.indexOf(bytes, at + bytes.length)) total++;
      }
    }
    return total;
  }

  images() {
    for (const { source } of this.modulesNamed(IMAGE_TABLE)) {
      const module = this.parse(source);
      const tables = module.protos.slice(0, SCALES).map(proto => L.imageEntries(module, proto));
      if (tables.every(table => table.has(WORDMARK_IMAGE))) return tables;
    }
    return null;
  }

  moduleUnchanged(other, name) {
    const mine = this.modulesNamed(name);
    const theirs = other.modulesNamed(name);
    if (mine.length !== theirs.length || !mine.length) return false;
    const signature = source => this.parse(source).protos.map(proto => normalize(this.parse(source), proto).join('|')).join('||');
    return mine.every((entry, index) => signature(entry.source) === signature(theirs[index].source));
  }
}

function findProtoMatch(oldSet, oldEntry, oldProto, newSet) {
  const oldModule = oldSet.parse(oldEntry.source);
  const oldTokens = normalize(oldModule, oldProto);
  const anchors = rareStrings(oldProto);
  const sameName = newSet.modulesNamed(oldEntry.name);
  const candidates = sameName.length ? sameName : [];
  if (anchors.length) for (const entry of newSet.modulesContaining(anchors.slice(0, 2))) if (!candidates.some(known => known.source === entry.source)) candidates.push(entry);
  const signature = oldTokens.join('|');
  const scored = [];
  for (const entry of candidates) {
    const module = newSet.parse(entry.source);
    for (const proto of module.protos) {
      if (proto.params !== oldProto.params) continue;
      const hasAnchor = !anchors.length || anchors.some(text => proto.constants.some(constant => constant.type === 'string' && constant.value === text));
      if (!hasAnchor) continue;
      const tokens = normalize(module, proto);
      if (tokens.join('|') === signature) return { entry, module, proto, tokens, similarity: 1, exact: true };
      const pairs = alignTokens(Int32Array.from(hashList(oldTokens)), Int32Array.from(hashList(tokens)));
      scored.push({ entry, module, proto, tokens, pairs, similarity: pairs.length / (oldTokens.length + tokens.length) });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  if (!scored.length || scored[0].similarity < MIN_PROTO_SIMILARITY) return null;
  if (scored[1] && scored[0].similarity - scored[1].similarity < MIN_PROTO_MARGIN) return null;
  return scored[0];
}

function wordMap(oldList, newList, match) {
  const map = new Map();
  if (match.exact) {
    oldList.forEach((instruction, index) => map.set(instruction.pc, newList[index].pc));
    return map;
  }
  for (let i = 0; i < match.pairs.length; i += 2) map.set(oldList[match.pairs[i]].pc, newList[match.pairs[i + 1]].pc);
  return map;
}

function portEdit(oldSet, newSet, edit) {
  const from = Buffer.from(edit.from, 'hex');
  const to = Buffer.from(edit.to, 'hex');
  const owners = [];
  for (const [model, scripts] of oldSet.scripts) {
    scripts.sources.forEach((source, index) => {
      if (source.includes(from)) owners.push({ model, name: scripts.names[index], source });
    });
  }
  if (!owners.length) return { status: 'failed', reason: 'the old model does not contain this edit' };
  const oldEntry = owners[0];
  const oldModule = oldSet.parse(oldEntry.source);
  const at = oldEntry.source.indexOf(from);
  const oldProto = protoAt(oldModule, at);
  if (!oldProto) return { status: 'failed', reason: 'the edit is not inside a function' };
  const match = findProtoMatch(oldSet, oldEntry, oldProto, newSet);
  if (!match) return { status: 'failed', reason: `no function in the new model matches ${oldEntry.name}`, anchors: rareStrings(oldProto) };
  const oldList = L.instructions(oldModule, oldProto);
  const newList = L.instructions(match.module, match.proto);
  const map = wordMap(oldList, newList, match);
  const firstWord = (at - oldProto.codeOffset) / WORD;
  const words = from.length / WORD;
  const mapWord = word => {
    if (map.has(word)) return map.get(word);
    const instruction = oldList.find(item => item.pc === word - 1 && item.aux !== null);
    return instruction && map.has(instruction.pc) ? map.get(instruction.pc) + 1 : -1;
  };
  const newFirst = mapWord(firstWord);
  if (newFirst < 0) return { status: 'failed', reason: 'the edited instructions are gone from the new function' };
  for (let word = 0; word < words; word++) {
    if (mapWord(firstWord + word) !== newFirst + word) return { status: 'failed', reason: 'the edited instructions are no longer next to each other' };
  }
  const newStart = match.proto.codeOffset + newFirst * WORD;
  const newFrom = Buffer.from(match.entry.source.subarray(newStart, newStart + from.length));
  const newTo = Buffer.from(newFrom);
  for (let word = 0; word < words; word++) {
    const offset = word * WORD;
    if (from.readUInt32LE(offset) === to.readUInt32LE(offset)) continue;
    const translated = translateWord(to.subarray(offset, offset + WORD), oldProto, match.proto, firstWord + word, newFirst + word, mapWord);
    if (!translated) return { status: 'failed', reason: `can't translate the replacement at word ${word}` };
    translated.copy(newTo, offset);
  }
  const uses = newSet.count(newFrom);
  if (uses !== 1) return { status: 'failed', reason: `the edit matched ${uses} places in the new model` };
  return {
    status: edit.from === newFrom.toString('hex') ? 'unchanged' : 'moved',
    from: newFrom.toString('hex'),
    to: newTo.toString('hex'),
    module: match.entry.name,
    exactFunction: Boolean(match.exact),
    similarity: +match.similarity.toFixed(3),
  };
}

function translateWord(word, oldProto, newProto, oldPc, newPc, mapWord) {
  const op = L.decodeOp(word[0]);
  const out = Buffer.from(word);
  if (op === L.OP.NOP) return out;
  if (op === L.OP.LOADK) {
    const key = constantKey(oldProto, word.readInt16LE(2));
    const index = newProto.constants.findIndex((_, position) => constantKey(newProto, position) === key);
    if (index < 0) return null;
    out.writeInt16LE(index, 2);
    return out;
  }
  if (op === L.OP.JUMP) {
    const target = mapWord(oldPc + 1 + word.readInt16LE(2));
    if (target < 0) return null;
    out.writeInt16LE(target - (newPc + 1), 2);
    return out;
  }
  return null;
}

function spritePixels(file) {
  return decodePng(fs.readFileSync(file));
}

function spriteAgreement(oldBundle, newBundle, oldEntry, newEntry) {
  const oldFile = path.join(oldBundle, ...SHEET_DIR, `${oldEntry.sheet}.png`);
  const newFile = path.join(newBundle, ...SHEET_DIR, `${newEntry.sheet}.png`);
  if (!fs.existsSync(oldFile) || !fs.existsSync(newFile)) return null;
  const a = spritePixels(oldFile);
  const b = spritePixels(newFile);
  if (oldEntry.w !== newEntry.w || oldEntry.h !== newEntry.h) return 0;
  let both = 0;
  let either = 0;
  for (let y = 0; y < oldEntry.h; y++) {
    for (let x = 0; x < oldEntry.w; x++) {
      const alphaA = a.rgba[((oldEntry.y + y) * a.width + oldEntry.x + x) * 4 + 3] > 64;
      const alphaB = b.rgba[((newEntry.y + y) * b.width + newEntry.x + x) * 4 + 3] > 64;
      if (alphaA || alphaB) either++;
      if (alphaA && alphaB) both++;
    }
  }
  return either ? both / either : 1;
}

function portWordmark(oldSet, newSet, profile, bundles) {
  const newTables = newSet.images();
  if (!newTables) return { status: 'failed', reason: `${WORDMARK_IMAGE} is not in ${IMAGE_TABLE} any more` };
  const oldTables = oldSet.images();
  const rectEdits = [];
  const wordmarkBoxes = [];
  const agreements = [];
  for (let scale = 0; scale < SCALES; scale++) {
    const entry = newTables[scale].get(WORDMARK_IMAGE);
    if (!entry || !entry.sheet) return { status: 'failed', reason: `${WORDMARK_IMAGE} has no ${scale + 1}x sprite sheet entry` };
    const visible = Math.round(entry.h * VISIBLE_NUMERATOR / VISIBLE_DENOMINATOR);
    const visibleY = entry.y + ((entry.h - visible) >> 1);
    rectEdits.push({ offset: [[entry.x, entry.y], [entry.x, visibleY]], size: [[entry.w, entry.h], [entry.w, visible]] });
    const inset = profile.wordmarkInsets[scale];
    wordmarkBoxes.push({ sheet: `${entry.sheet}.png`, x: entry.x, y: entry.y + inset.y, w: entry.w, h: entry.h + inset.h, visibleY, visible });
    if (oldTables && bundles) agreements.push(spriteAgreement(bundles.old, bundles.new, oldTables[scale].get(WORDMARK_IMAGE), entry));
  }
  const weak = agreements.some(score => score !== null && score < MIN_SPRITE_MATCH);
  const base = newTables[0].get(WORDMARK_IMAGE);
  return {
    status: 'ported',
    rectEdits,
    wordmarkBoxes,
    aspect: [[base.w, base.h], [base.w, rectEdits[0].size[1][1]]],
    agreements,
    warning: weak ? `the sprite at the new ${WORDMARK_IMAGE} rect looks different from the old one (${agreements.map(score => (score === null ? '?' : score.toFixed(2))).join(', ')})` : null,
  };
}

function portModels({ oldModels, newModels, profile, bundles }) {
  const oldSet = new ModelSet(oldModels);
  const newSet = new ModelSet(newModels);
  const results = [];
  const next = {};
  const wordmark = portWordmark(oldSet, newSet, profile, bundles);
  results.push({ id: 'wordmark', title: 'Home header wordmark sprites', required: false, status: wordmark.status, reason: wordmark.reason, warning: wordmark.warning, agreements: wordmark.agreements });
  if (wordmark.status === 'ported') Object.assign(next, { rectEdits: wordmark.rectEdits, wordmarkBoxes: wordmark.wordmarkBoxes, aspect: wordmark.aspect });
  next.bytecodeEdits = [];
  profile.bytecodeEdits.forEach((edit, index) => {
    const ported = portEdit(oldSet, newSet, edit);
    results.push({ id: `bytecode-${index}`, title: edit.title || `Bytecode edit ${index}`, required: false, ...ported, from: undefined, to: undefined });
    if (ported.from) next.bytecodeEdits.push({ title: edit.title, from: ported.from, to: ported.to });
  });
  for (const [script] of Object.entries(profile.scriptReplacements)) {
    const present = newSet.modulesNamed(script).length > 0;
    const unchanged = present && oldSet.moduleUnchanged(newSet, script);
    results.push({ id: `script-${script}`, title: `Replacement of ${script}`, required: true, status: present ? 'ported' : 'failed', reason: present ? undefined : 'the script is gone from the model', warning: present && !unchanged ? `${script} changed in the new model, so check that the replacement still fits` : null });
  }
  for (const name of profile.settingsAnchors || []) {
    const owners = newSet.modulesContaining([name]);
    if (!owners.length) results.push({ id: `anchor-${name}`, title: `Settings page field ${name}`, required: false, status: 'failed', reason: `no in-game script mentions ${name}, so the WebBlox settings rows may not appear` });
  }
  const scripts = newSet.scripts.get('InExperience');
  if (scripts && scripts.sources.length) {
    const bytecodeVersion = scripts.sources[0][L.PREFIX.length];
    next.bytecodeVersion = bytecodeVersion;
    if (bytecodeVersion !== profile.bytecodeVersion) results.push({ id: 'bytecode-version', title: 'Luau bytecode version', required: false, status: 'failed', reason: `the models use bytecode version ${bytecodeVersion}, and tools/luau-bytecode.js targets ${profile.bytecodeVersion}` });
  }
  return { next, results };
}

module.exports = { portModels, portEdit, ModelSet, normalize, WORDMARK_IMAGE };
