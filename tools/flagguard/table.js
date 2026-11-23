'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WasmModule, readInstruction, bodyStart } = require('../autoport/wasm/module');
const { MemoryImage } = require('../autoport/wasm/image');
const { readModuleScripts } = require('../autoport/luau/rbxm');
const Luau = require('../autoport/luau/bytecode');
const { Machine } = require('./machine');

const FORMAT = 3;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{2,}$/;
const KIND_PREFIX = { 1: 'F', 2: 'DF', 4: 'SF' };
const TYPES = ['Flag', 'Int', 'Log', 'String'];
const KEY_PREFIX = /^(DF|SF|F)(Flag|Int|Log|String)/;
const KEY_SCOPE = /_(PlaceFilter|UniverseFilter|DataCenterFilter|IXP|IXPValue|Staged)$/;
const OP_CALL = 0x10;
const OP_I32_CONST = 0x41;
const MIN_REGISTRATION_SITES = 20;
const MIN_LIST_STORES = 3;
const MIN_LIST_LENGTH = 8;
const MIN_LIST_KNOWN_SHARE = 0.1;
const MIN_LIST_KNOWN = 2;
const MIN_VERSION_SITES = 50;
const MAX_VERSION = 1000;
const SAMPLED_CALLERS = 40;
const MIN_VERSION_SCORE = 0.8;
const MIN_ENGINE_KEYS = 500;
const MAX_WRAPPER_SIZE = 40;
const MAX_HELPER_SIZE = 600;
const MAX_LIST_LENGTH = 100000;
const MAX_NODE_ADDRESS = 0x7fffffff;
const MAX_UNRESOLVED_SHARE = 0.01;
const STARTUP_DEPTH = 2;
const LIST_SAMPLES = 32;
const LIST_NAMED_SHARE = 0.9;
const STARTUP_STEPS = 20e6;
const STARTUP_HELPER_SIZE = 120;
const ROOT_STEPS = 2e6;
const LIST_LAYOUTS = [
  { type: 'Flag', name: 4, next: 8, dynamic: 1 },
  { type: 'Int', name: 8, next: 12, dynamic: 4 },
];
const LUA_DEFINE = { DefineFastFlag: 'Flag', DefineFastInt: 'Int', DefineFastString: 'String' };
const LUA_READ = new Set(['GetFastFlag', 'GetFastInt', 'GetFastString', 'GetFFlag', 'GetFVariable']);
const LUA_ARGUMENT_WINDOW = 6;
const MODEL_DIR = path.join('ExtraContent', 'models');
const MENTION = /^[A-Za-z][A-Za-z0-9_]+$/;
const LOWERCASE = /[a-z]/;
const MIN_MENTION_LENGTH = 5;
const MAX_MENTION_LENGTH = 120;

function splitKey(key) {
  const prefix = key.match(KEY_PREFIX);
  if (!prefix) return null;
  const rest = key.slice(prefix[0].length);
  const scope = rest.match(KEY_SCOPE);
  return { prefix: prefix[0], kind: prefix[1], type: prefix[2], name: scope ? rest.slice(0, -scope[0].length) : rest, scope: scope ? scope[1] : null };
}

function baseKey(key) {
  const scope = key.match(KEY_SCOPE);
  return scope ? key.slice(0, -scope[0].length) : key;
}

function channelNames(channels) {
  const names = new Map();
  const note = (name, prefix) => {
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(prefix);
  };
  for (const channel of channels) {
    for (const key of Object.keys(channel)) {
      const parts = splitKey(key);
      if (!parts) continue;
      note(parts.name, parts.prefix);
      const unversioned = parts.name.match(/^(.*?)\d+$/);
      if (unversioned && unversioned[1]) note(unversioned[1], parts.prefix);
    }
  }
  return names;
}

function readStruct(image, address) {
  const pointer = image.word(address + 4);
  const length = image.word(address + 8);
  if (!pointer || !length || length > 255 || !image.contains(pointer)) return null;
  const name = image.stringAt(pointer);
  return name && name.length === length && IDENTIFIER.test(name) ? name : null;
}

function identifierStrings(image) {
  const addresses = new Map();
  const bytes = image.bytes;
  let start = 0;
  let valid = true;
  for (let at = 0; at < bytes.length; at++) {
    const byte = bytes[at];
    if (byte === 0) {
      const length = at - start;
      if (valid && length >= 3 && length <= 255) addresses.set(start + image.low, bytes.toString('latin1', start, at));
      start = at + 1;
      valid = true;
    } else if (valid) {
      const word = (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f;
      if (!word || (at === start && byte <= 0x39)) valid = false;
    }
  }
  return addresses;
}

function scanRegistrations(module, image) {
  const buf = module.buffer;
  const named = new Map();
  const structured = new Map();
  const versionSites = new Map();
  const strings = identifierStrings(image);
  const referenced = new Set();
  const add = (map, callee, entry) => {
    if (!map.has(callee)) map.set(callee, []);
    map.get(callee).push(entry);
  };
  for (let func = module.importCount; func < module.functionCount; func++) {
    const { start, end } = module.bodyBounds(func);
    let at = bodyStart(buf, start);
    let run = 0;
    let last = 0;
    let second = 0;
    let third = 0;
    while (at < end) {
      const instruction = readInstruction(buf, at);
      at = instruction.end;
      if (instruction.op === OP_I32_CONST) {
        third = second;
        second = last;
        last = instruction.a;
        run++;
        const text = strings.get(last);
        if (text !== undefined) referenced.add(text);
        continue;
      }
      if (instruction.op === OP_CALL) {
        const callee = instruction.a;
        if (run >= 2 && KIND_PREFIX[last]) {
          const direct = run >= 3 && third > 0 && second > 0 ? image.stringAt(third) : null;
          if (direct && IDENTIFIER.test(direct)) {
            add(named, callee, { name: direct, address: second, kind: last });
          } else if (second > 0) {
            const name = readStruct(image, second);
            if (name) add(structured, callee, { name, address: second, kind: last });
          }
        }
        if (run >= 1 && last > 0 && last <= MAX_VERSION) versionSites.set(callee, (versionSites.get(callee) || 0) + 1);
      }
      run = 0;
    }
  }
  return { named, structured, versionSites, referenced };
}

function typeOfCallee(entries, names) {
  const votes = new Map(TYPES.map(type => [type, 0]));
  for (const entry of entries) {
    const prefixes = names.get(entry.name);
    if (!prefixes) continue;
    for (const type of TYPES) {
      if (prefixes.has(KIND_PREFIX[entry.kind] + type)) votes.set(type, votes.get(type) + 1);
    }
  }
  let best = null;
  let bestVotes = 0;
  for (const [type, count] of votes) {
    if (count > bestVotes) {
      best = type;
      bestVotes = count;
    }
  }
  return best;
}

function wrappedCallee(module, func) {
  if (func < module.importCount || module.bodySizes[func - module.importCount] > MAX_WRAPPER_SIZE) return null;
  const calls = module.decode(func).filter(instruction => instruction.op === OP_CALL);
  return calls.length === 1 ? calls[0].a : null;
}

function encodeCall(func) {
  const bytes = [OP_CALL];
  let value = func;
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

function callersOf(module, callee) {
  const buf = module.buffer;
  const code = module.section(10);
  const marker = encodeCall(callee);
  const callers = new Set();
  for (let at = buf.indexOf(marker, code.start); at >= 0 && at < code.end; at = buf.indexOf(marker, at + 1)) {
    const func = module.funcAt(at);
    if (callers.has(func)) continue;
    const { start, end } = module.bodyBounds(func);
    let position = bodyStart(buf, start);
    while (position < end) {
      const instruction = readInstruction(buf, position);
      position = instruction.end;
      if (instruction.op === OP_CALL && instruction.a === callee) {
        callers.add(func);
        break;
      }
    }
  }
  return [...callers];
}

function isSmall(module, func, limit = MAX_HELPER_SIZE) {
  return func >= module.importCount && module.bodySizes[func - module.importCount] <= limit;
}

function knownArguments(values) {
  return values.every(value => value.kind === 'constant' || value.kind === 'pointer');
}

function versionHooks(module, target, onVersion) {
  return {
    call(callee, args, depth, machine) {
      if (callee === target) {
        const name = machine.memory.stdString(args[0]);
        onVersion(name, args[1] && args[1].kind === 'constant' ? args[1].value : null);
        return 'skip';
      }
      return isSmall(module, callee) && knownArguments(args) ? 'descend' : 'skip';
    },
  };
}

function findVersionFunction(module, image, versionSites, registered) {
  const candidates = [...versionSites.entries()]
    .filter(([callee, count]) => {
      if (count < MIN_VERSION_SITES || callee < module.importCount) return false;
      const type = module.signature(callee);
      return type.params.length === 2 && type.results.length === 0;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  let best = null;
  let bestScore = 0;
  for (const [callee] of candidates) {
    const callers = callersOf(module, callee).filter(func => isSmall(module, func) && module.paramCount(func) === 0).slice(0, SAMPLED_CALLERS);
    let known = 0;
    let seen = 0;
    const machine = new Machine(module, image);
    for (const func of callers) {
      machine.run(func, [], versionHooks(module, callee, name => {
        seen++;
        if (name && registered.has(name)) known++;
      }));
    }
    const score = seen ? known / Math.max(seen, callers.length) : 0;
    if (score > bestScore) {
      best = callee;
      bestScore = score;
    }
  }
  return bestScore >= MIN_VERSION_SCORE ? best : null;
}

function startupFunctions(module) {
  const roots = [];
  const ctors = module.exports.get('__wasm_call_ctors');
  if (ctors && ctors.kind === 0) roots.push(ctors.index);
  if (module.start !== null && module.start !== undefined && !roots.includes(module.start)) roots.push(module.start);
  return roots;
}

function runStartup(module, image, target, names) {
  const machine = new Machine(module, image, { maxDepth: STARTUP_DEPTH, maxSteps: STARTUP_STEPS });
  const versions = new Map();
  let unresolved = 0;
  const listStores = new Map();
  const onVersion = (name, version) => {
    if (name && IDENTIFIER.test(name) && version !== null) versions.set(name, version);
    else unresolved++;
  };
  const hooks = {
    call(callee, args, depth, active) {
      if (callee === target) {
        onVersion(active.memory.stdString(args[0]), args[1] && args[1].kind === 'constant' ? args[1].value : null);
        return 'skip';
      }
      return isSmall(module, callee, STARTUP_HELPER_SIZE) && knownArguments(args) ? 'descend' : 'skip';
    },
    store(place, value, size) {
      if (size !== 4 || place.base !== null || value.kind !== 'constant') return;
      const node = value.value >>> 0;
      if (node < image.low || node > MAX_NODE_ADDRESS) return;
      const entry = listStores.get(place.offset) || { count: 0, samples: [] };
      entry.count++;
      if (entry.samples.length < LIST_SAMPLES) entry.samples.push(node);
      listStores.set(place.offset, entry);
    },
  };
  for (const root of startupFunctions(module)) machine.run(root, [], hooks);
  const roots = new Set();
  if (target !== null) {
    const direct = callersOf(module, target);
    const helpers = new Set(direct.filter(func => module.paramCount(func) > 0));
    for (const func of direct) if (!helpers.has(func)) roots.add(func);
    for (const helper of helpers) for (const func of callersOf(module, helper)) roots.add(func);
    for (const root of startupFunctions(module)) roots.delete(root);
    const calls = versionHooks(module, target, onVersion);
    for (const root of roots) new Machine(module, image, { maxSteps: ROOT_STEPS }).run(root, [], calls);
  }
  const nameAt = address => {
    const pointer = machine.memory.word(null, address);
    const name = pointer === null ? null : machine.memory.cString(pointer);
    return name && IDENTIFIER.test(name) ? name : null;
  };
  const heads = [];
  for (const [head, { count, samples }] of listStores) {
    if (count < MIN_LIST_STORES) continue;
    for (const layout of LIST_LAYOUTS) {
      const named = samples.filter(node => nameAt(node + layout.name)).length;
      if (named >= samples.length * LIST_NAMED_SHARE) heads.push({ head, layout });
    }
  }
  const entries = [];
  const seen = new Set();
  for (const { head, layout } of heads) {
    const list = [];
    const visited = new Set();
    let node = machine.memory.word(null, head);
    while (node && !visited.has(node) && list.length < MAX_LIST_LENGTH) {
      visited.add(node);
      const name = nameAt(node + layout.name);
      if (!name) break;
      const dynamic = machine.memory.byte(null, node + layout.dynamic);
      const value = layout.type === 'Flag' ? machine.memory.byte(null, node) : machine.memory.word(null, node);
      const valid = dynamic !== null && dynamic <= 1 && value !== null && (layout.type !== 'Flag' || value <= 1);
      list.push({ name, node, dynamic, value, valid });
      node = machine.memory.word(null, node + layout.next);
    }
    const valid = list.filter(item => item.valid);
    const known = valid.filter(item => names.has(item.name)).length;
    if (valid.length < MIN_LIST_LENGTH || valid.length < list.length * LIST_NAMED_SHARE || known < Math.max(MIN_LIST_KNOWN, valid.length * MIN_LIST_KNOWN_SHARE)) continue;
    for (const item of valid) {
      if (seen.has(item.node)) continue;
      seen.add(item.node);
      entries.push({ name: item.name, address: item.node, kind: item.dynamic ? 2 : 1, type: layout.type, default: layout.type === 'Flag' ? item.value !== 0 : item.value | 0, list: true });
    }
  }
  return { versions, unresolved, listFlags: entries, exhausted: machine.exhausted, steps: machine.steps, versionCallers: target === null ? 0 : callersOf(module, target).length };
}

function defaultOf(image, address, type) {
  if (type === 'Flag') {
    const at = address - image.low;
    if (at < 0 || at >= image.bytes.length) return false;
    return image.bytes[at] !== 0;
  }
  if (type === 'Int') {
    const word = image.word(address);
    return word === null ? 0 : word | 0;
  }
  return null;
}

function buildEngineTable(wasm, channels, { time = () => {} } = {}) {
  const module = new WasmModule(wasm);
  const image = new MemoryImage(module);
  const names = channelNames(channels);
  time('parse');
  const { named, structured, versionSites, referenced } = scanRegistrations(module, image);
  time('scan');
  const registrations = [];
  const callees = [];
  const accept = (callee, shape, type, entries) => {
    callees.push({ callee, shape, type, sites: entries.length });
    for (const entry of entries) registrations.push({ ...entry, type });
  };
  for (const [map, shape] of [[named, 'named'], [structured, 'structured']]) {
    for (const [callee, entries] of map) {
      if (entries.length < MIN_REGISTRATION_SITES) continue;
      const type = typeOfCallee(entries, names);
      if (!type) continue;
      accept(callee, shape, type, entries);
      const inner = wrappedCallee(module, callee);
      if (inner !== null && map.has(inner) && !callees.some(item => item.callee === inner)) accept(inner, shape, type, map.get(inner));
    }
  }
  const registeredNames = new Set(registrations.map(entry => entry.name));
  const target = findVersionFunction(module, image, versionSites, registeredNames);
  time('version function');
  const startup = runStartup(module, image, target, names);
  time('startup');
  const listed = new Set(registrations.map(entry => `${entry.kind}:${entry.type}:${entry.name}`));
  for (const entry of startup.listFlags) if (!listed.has(`${entry.kind}:${entry.type}:${entry.name}`)) registrations.push(entry);
  const keys = {};
  for (const entry of registrations) {
    const version = startup.versions.has(entry.name) && !entry.list ? startup.versions.get(entry.name) : null;
    const key = `${KIND_PREFIX[entry.kind]}${entry.type}${entry.name}${version === null ? '' : version}`;
    const value = { name: entry.name, address: entry.address, type: entry.type, version, default: entry.list ? entry.default : defaultOf(image, entry.address, entry.type) };
    if (entry.list) value.list = true;
    keys[key] = value;
  }
  const registeredAny = new Set(registrations.map(entry => entry.name));
  const byName = [...referenced].filter(name => !registeredAny.has(name) && names.has(name)).sort();
  return {
    keys,
    byName,
    callees,
    listFlags: startup.listFlags.length,
    versionFunction: target,
    versionedNames: startup.versions.size,
    versionCallers: startup.versionCallers,
    unresolvedVersions: startup.unresolved,
    startupSteps: startup.steps,
    startupExhausted: startup.exhausted,
  };
}

function modelFiles(engineDir) {
  const root = path.join(engineDir, MODEL_DIR);
  if (!fs.existsSync(root)) return [];
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.rbxm')) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

function scanScript(source, define, mention) {
  let module;
  try {
    module = Luau.parse(source);
  } catch {
    return false;
  }
  const stringConstant = (proto, index) => {
    const constant = proto.constants[index];
    return constant && constant.type === 'string' ? constant.value : null;
  };
  for (const proto of module.protos) {
    const list = Luau.instructions(module, proto);
    for (let i = 0; i < list.length; i++) {
      const instruction = list[i];
      if (instruction.op !== Luau.OP.NAMECALL) continue;
      const method = stringConstant(proto, instruction.aux);
      if (!method) continue;
      const type = LUA_DEFINE[method];
      if (!type && !LUA_READ.has(method)) continue;
      let name = null;
      let value;
      for (let k = i - 1; k >= 0 && k >= i - LUA_ARGUMENT_WINDOW; k--) {
        const earlier = list[k];
        if (earlier.a === instruction.a + 2 && name === null && earlier.op === Luau.OP.LOADK) name = stringConstant(proto, earlier.d);
        if (earlier.a === instruction.a + 3 && value === undefined) {
          if (earlier.op === Luau.OP.LOADB) value = earlier.b !== 0;
          else if (earlier.op === Luau.OP.LOADN) value = earlier.d;
          else if (earlier.op === Luau.OP.LOADK) {
            const constant = proto.constants[earlier.d];
            if (constant && ['string', 'number', 'boolean'].includes(constant.type)) value = constant.value;
          }
        }
      }
      if (name) define(name, type || null, value);
    }
  }
  for (const text of module.strings) {
    if (text.length >= MIN_MENTION_LENGTH && text.length <= MAX_MENTION_LENGTH && MENTION.test(text) && LOWERCASE.test(text)) mention(text.replace(KEY_PREFIX, ''));
  }
  return true;
}

function buildLuaTable(engineDir) {
  const lua = {};
  const mentions = new Set();
  let scripts = 0;
  let failed = 0;
  const define = (name, type, value) => {
    const entry = lua[name] || (lua[name] = { type: null, default: null });
    if (type) {
      entry.type = type;
      if (value !== undefined && entry.default === null) entry.default = value;
    }
  };
  for (const file of modelFiles(engineDir)) {
    let model;
    try {
      model = readModuleScripts(fs.readFileSync(file));
    } catch {
      continue;
    }
    for (const source of model.sources) {
      scripts++;
      if (!scanScript(source, define, text => mentions.add(text))) failed++;
    }
  }
  return { lua, mentions: [...mentions].sort(), scripts, failed };
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function modelSignature(engineDir) {
  const hash = crypto.createHash('sha256');
  for (const file of modelFiles(engineDir)) {
    const stat = fs.statSync(file);
    hash.update(`${path.relative(engineDir, file)}:${stat.size}:${Math.round(stat.mtimeMs)}\n`);
  }
  return hash.digest('hex');
}

function buildTable(engineDir, channels) {
  const wasm = fs.readFileSync(path.join(engineDir, 'WebClient.wasm'));
  const engine = buildEngineTable(wasm, channels);
  const lua = buildLuaTable(engineDir);
  return { format: FORMAT, wasm: sha256(wasm), models: modelSignature(engineDir), ...engine, lua: lua.lua, mentions: lua.mentions, scripts: lua.scripts, scriptsFailed: lua.failed };
}

function checkTable(table) {
  const problems = [];
  const count = Object.keys(table.keys).length;
  if (count < MIN_ENGINE_KEYS) problems.push(`Only ${count} engine flags were found, so the registration code changed shape.`);
  if (table.versionFunction === null) problems.push('The function that registers flag versions was not found, so versioned keys cannot be told apart from dead ones.');
  if (table.unresolvedVersions > table.versionCallers * MAX_UNRESOLVED_SHARE) problems.push(`${table.unresolvedVersions} flag version registrations could not be read.`);
  if (!table.listFlags) problems.push('No Luau flag list was found, so Luau flags look dead.');
  if (table.startupExhausted) problems.push('The startup code ran past the step limit, so some flags may be missing.');
  return problems;
}

function lookupSet(table, field) {
  const hidden = `${field}Set`;
  if (!table[hidden]) Object.defineProperty(table, hidden, { value: new Set(table[field] || []), enumerable: false });
  return table[hidden];
}

function resolve(table, key) {
  const parts = splitKey(key);
  const base = parts && parts.scope ? baseKey(key) : key;
  const engine = table.keys[base] || null;
  const luaEntry = parts ? table.lua[parts.name] || null : null;
  const mentioned = parts ? lookupSet(table, 'mentions').has(parts.name) : false;
  const byName = !engine && parts ? lookupSet(table, 'byName').has(parts.name) : false;
  const reader = engine ? 'engine' : byName ? 'engine-name' : luaEntry || mentioned ? 'lua' : null;
  return { key, base, parts, scope: parts ? parts.scope : null, engine, lua: luaEntry, mentioned, byName, reader };
}

function cacheFile(cacheDir, hash) {
  return path.join(cacheDir, `table-${hash.slice(0, 16)}.json`);
}

function loadCached(cacheDir, hash, models) {
  const file = cacheFile(cacheDir, hash);
  if (!fs.existsSync(file)) return null;
  try {
    const table = JSON.parse(fs.readFileSync(file, 'utf8'));
    return table.format === FORMAT && table.wasm === hash && table.models === models ? table : null;
  } catch {
    return null;
  }
}

function tableFor(engineDir, channels, { cacheDir, log = () => {} } = {}) {
  const hash = sha256(fs.readFileSync(path.join(engineDir, 'WebClient.wasm')));
  if (cacheDir) {
    const cached = loadCached(cacheDir, hash, modelSignature(engineDir));
    if (cached) return cached;
  }
  log('Reading every flag out of the engine. This runs once per build.');
  const table = buildTable(engineDir, channels);
  if (cacheDir) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = cacheFile(cacheDir, hash);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(table));
    fs.renameSync(`${file}.tmp`, file);
  }
  return table;
}

module.exports = { buildTable, buildEngineTable, buildLuaTable, checkTable, resolve, splitKey, baseKey, tableFor, sha256, channelNames, runStartup, scanRegistrations, KEY_PREFIX, KEY_SCOPE, FORMAT };
