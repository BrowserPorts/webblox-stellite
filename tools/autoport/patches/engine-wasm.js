'use strict';

const crypto = require('crypto');
const { WasmModule } = require('../wasm/module');
const { MemoryImage } = require('../wasm/image');
const { FunctionFeatures, SharedTables } = require('../match/features');
const { Matcher } = require('../match/matcher');
const { PortContext, PortError, value } = require('../context');
const { spliceSystemTheme, applyLightingGates } = require('../wasm/splice');
const { seq, i32, call, load8, hole: v, encode, OPS, brIf } = require('../wasm/asm');
const HomeScreen = require('./home-screen');
const RenderThreads = require('./render-threads');

const { EQ, NE } = OPS;
const THEME_WORDS = 4;
const THEME_REPLACED_SLOTS = [2, 3];
const THEME_SIGNATURE = '127>127';
const CALL_OPCODE = 0x10;
const WEAK_MATCHES = new Set(['fuzzy', 'twin']);
const MIN_NEIGHBOR_RATIO = 0.5;

function sha(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function isExpected(error) {
  return error instanceof PortError || error.constructor === Error;
}

function loadFeatures(buffer, shared) {
  const module = new WasmModule(buffer);
  return new FunctionFeatures(module, new MemoryImage(module), shared);
}

function matchBuilds(oldBuffer, newBuffer, { cache, log }) {
  const shared = new SharedTables();
  log('Reading both engine builds');
  const from = loadFeatures(oldBuffer, shared);
  const to = loadFeatures(newBuffer, shared);
  const matcher = new Matcher(from, to, log);
  const saved = cache && cache.load(sha(oldBuffer), sha(newBuffer));
  if (saved) {
    log('Using the saved function match');
    return matcher.restore(saved);
  }
  log('Matching functions between the builds');
  matcher.run();
  if (cache) cache.save(sha(oldBuffer), sha(newBuffer), matcher.serialize());
  return matcher;
}

function vtableFunctions(module, slots) {
  return slots.map(slot => module.slotFunctions.get(slot));
}

function searchThemeVtable(image, module, wanted) {
  const hits = [];
  const bytes = image.bytes;
  for (let at = 0; at + THEME_WORDS * 4 <= bytes.length; at += 4) {
    if (module.slotFunctions.get(bytes.readUInt32LE(at)) !== wanted[0]) continue;
    const slots = wanted.map((_, index) => bytes.readUInt32LE(at + index * 4));
    if (vtableFunctions(module, slots).every((func, index) => func === wanted[index])) hits.push({ address: at + image.low, slots });
  }
  return hits;
}

function portSystemTheme(ctx, profile) {
  const theme = profile.systemTheme;
  const module = ctx.newModule;
  const typeIndex = module.typeIndexByKey.get(THEME_SIGNATURE);
  if (typeIndex === undefined) throw new PortError('the engine has no (i32) -> i32 function type');
  if (ctx.identity) return { ...theme, typeIndex };
  const image = ctx.matcher.to.image;
  const wanted = theme.vtableSlots.map(slot => ctx.mapFunction(ctx.oldModule.slotFunctions.get(slot)));
  let found = null;
  const resolved = ctx.resolveAddress(theme.vtableAddress);
  if (resolved && resolved.value % 4 === 0) {
    const slots = wanted.map((_, index) => image.word(resolved.value + index * 4));
    const functions = vtableFunctions(module, slots);
    if (functions.every((func, index) => func === wanted[index] || (func !== undefined && wanted[index] < 0))) found = { address: resolved.value, slots };
  }
  if (!found) {
    if (wanted.some(func => func < 0)) throw new PortError('the functions of the system theme provider have no match', { wanted });
    const hits = searchThemeVtable(image, module, wanted);
    if (hits.length !== 1) throw new PortError(`a search for the system theme provider vtable found ${hits.length} places`, { wanted });
    found = hits[0];
  }
  for (const position of THEME_REPLACED_SLOTS) {
    const func = module.slotFunctions.get(found.slots[position]);
    if (module.typeOf(func) !== typeIndex) throw new PortError(`system theme vtable slot ${position} no longer holds an (i32) -> i32 function`, { func });
  }
  return { vtableSlots: found.slots, typeIndex, valueOffset: theme.valueOffset, vtableAddress: found.address };
}

function stringAddress(image, text) {
  const hits = image.findString(text);
  if (!hits.length) throw new PortError(`the engine no longer contains the shader pack name ${text}`);
  return hits;
}

function portLightingGates(ctx, profile) {
  const constants = profile.gateConstants;
  const image = ctx.matcher ? ctx.matcher.to.image : new MemoryImage(ctx.newModule);
  const web = stringAddress(image, constants.webPackName)[0];
  const vulkanHits = new Set(stringAddress(image, constants.vulkanName));
  const gates = [];
  const functions = [];
  const flags = new Set();
  const allowlist = flag => seq(i32(flag), load8(0), i32(1), EQ);
  const callPrefix = address => Buffer.concat([encode(i32(address)), Buffer.from([CALL_OPCODE])]);
  for (const oldFunc of constants.functions) {
    const target = ctx.mapFunction(oldFunc);
    if (target === undefined || target < 0) throw new PortError(`no match for lighting gate function ${oldFunc}`);
    functions.push(target);
    const label = `lighting gate function ${target}`;
    const allow = ctx.site(label, () => allowlist(v('flag')), { func: target, oldFunc, label: 'the API allowlist check', expect: { flag: constants.apiAllowlistFlag } });
    const flag = value(allow.bindings, 'flag');
    flags.add(flag);
    gates.push({ func: target, from: encode(allowlist(flag)).toString('hex'), to: encode(seq(i32(flag), load8(0), i32(2), EQ)).toString('hex') });
    const names = ctx.decoded('new', target).filter(instruction => instruction.op === 0x41 && vulkanHits.has(instruction.a));
    if (names.length !== 1) throw new PortError(`function ${target} mentions the name ${constants.vulkanName} ${names.length} times`, { func: target });
    const vulkan = names[0].a;
    ctx.site(label, () => seq(i32(vulkan), call(v('compare'))), { func: target, label: 'the shader pack name check' });
    gates.push({ func: target, from: callPrefix(vulkan).toString('hex'), to: callPrefix(web).toString('hex') });
  }
  if (flags.size !== 1) throw new PortError(`the lighting gate functions read different allowlist flags: ${[...flags].join(', ')}`);
  const last = constants.functions.length - 1;
  const computeCheck = field => seq(load8(field), i32(1), NE, brIf(0));
  const compute = ctx.site(`lighting gate function ${functions[last]}`, () => computeCheck(v('capability')), { func: functions[last], oldFunc: constants.functions[last], label: 'the compute capability check', expect: { capability: constants.computeCapability } });
  const capability = value(compute.bindings, 'capability');
  gates.push({ func: functions[last], from: encode(computeCheck(capability)).toString('hex'), to: encode(seq(load8(capability), i32(1), EQ, brIf(0))).toString('hex') });
  return {
    gates,
    constants: { functions, apiAllowlistFlag: [...flags][0], vulkanName: constants.vulkanName, webPackName: constants.webPackName, computeCapability: capability },
  };
}

function nextSymbols(ctx, profile) {
  const functions = {};
  const missing = [];
  for (const name of Object.keys(profile.wasm.functions)) {
    try {
      functions[name] = ctx.func(name);
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      missing.push(name);
    }
  }
  return { functions, missing };
}

function nextConstants(profile, threads) {
  const constants = { ...profile.wasm.constants };
  const { clusterFields, batchVector } = threads.values;
  if (clusterFields) constants.CLUSTER_FIELDS = clusterFields;
  else delete constants.CLUSTER_FIELDS;
  if (batchVector) constants.BATCH_VECTOR = batchVector;
  else delete constants.BATCH_VECTOR;
  return constants;
}

function doubtfulSymbols(evidence) {
  const doubts = [];
  for (const [name, entry] of Object.entries(evidence)) {
    if (entry.witness || entry.confirmed || entry.unchanged !== false) continue;
    if (entry.inferred) doubts.push(`${name} is function ${entry.target}, inferred from ${entry.how} (${entry.detail}), and no code pattern confirmed it.`);
    else if (WEAK_MATCHES.has(entry.how)) doubts.push(`${name} is function ${entry.target} from a ${entry.how} match, and no code pattern confirmed it.`);
    else if (entry.neighborRatio < MIN_NEIGHBOR_RATIO) doubts.push(`${name} is function ${entry.target}, but only ${entry.neighbors} of its neighbours agree, and no code pattern confirmed it.`);
  }
  return doubts;
}

function portWasm({ oldPristine, newPristine, profile, homePlan, homeBodies, cache, log = () => {} }) {
  const identity = oldPristine.equals(newPristine);
  const oldModule = new WasmModule(oldPristine);
  const matcher = identity ? null : matchBuilds(oldPristine, newPristine, { cache, log });
  const pristineModule = identity ? oldModule : matcher.to.module;
  const context = newModule => new PortContext({ oldModule, newModule, matcher, profile, identity });
  const base = context(pristineModule);
  const units = [];
  const failed = (id, title, required, error) => {
    if (!isExpected(error)) throw error;
    units.push({ id, group: 'wasm', title, required, status: 'failed', reason: error.message, details: error.details });
  };

  log('Porting the home screen backport');
  let home = null;
  try {
    home = HomeScreen.port(base, homePlan, homeBodies);
    if (!home.ok) {
      units.push({ id: 'home-screen', group: 'wasm', title: 'Home screen backport', required: true, status: 'failed', reason: `${home.problems.length} reference(s) could not be translated`, details: { problems: home.problems } });
      home = null;
    } else {
      units.push({ id: 'home-screen', group: 'wasm', title: 'Home screen backport', required: true, status: 'ported', warnings: home.warnings });
    }
  } catch (error) {
    failed('home-screen', 'Home screen backport', true, error);
  }
  const homeLayout = home ? home.plan : { dataBase: pristineModule.globals[0].value, imports: pristineModule.importCount };
  let current = home ? home.result : newPristine;

  log('Porting the system theme provider');
  let systemTheme = null;
  if (!profile.systemTheme) {
    units.push({ id: 'system-theme', group: 'wasm', title: 'System theme provider', required: false, status: 'skipped', reason: 'an earlier update lost this patch, so it needs measuring again' });
  } else {
    try {
      systemTheme = portSystemTheme(base, profile);
      current = spliceSystemTheme(current, systemTheme, homeLayout);
      systemTheme.patchedSha256 = sha(current);
      units.push({ id: 'system-theme', group: 'wasm', title: 'System theme provider', required: false, status: 'ported' });
    } catch (error) {
      systemTheme = null;
      failed('system-theme', 'System theme provider', false, error);
    }
  }

  log('Porting the future lighting gates');
  let gates = null;
  if (!profile.lightingGates) {
    units.push({ id: 'lighting-gates', group: 'wasm', title: 'Future lighting gates', required: false, status: 'skipped', reason: 'an earlier update lost this patch, so it needs measuring again' });
  } else {
    try {
      gates = portLightingGates(base, profile);
      current = applyLightingGates(current, gates.gates, homeLayout.imports);
      units.push({ id: 'lighting-gates', group: 'wasm', title: 'Future lighting gates', required: false, status: 'ported' });
    } catch (error) {
      gates = null;
      failed('lighting-gates', 'Future lighting gates', false, error);
    }
  }

  log('Generating the render thread patches');
  const threadContext = context(new WasmModule(current));
  let threads = null;
  try {
    threads = RenderThreads.generate(threadContext);
    units.push(...threads.units.map(unit => ({ ...unit, group: 'wasm' })));
  } catch (error) {
    failed('render-threads', 'Render thread patches', true, error);
  }

  const { functions, missing } = nextSymbols(threadContext, profile);
  const failedRequired = units.some(unit => unit.required && unit.status !== 'ported');
  const evidence = Object.fromEntries(threadContext.symbolEvidence);
  if (!identity) {
    for (const entry of Object.values(evidence)) {
      if (entry.witness || entry.unchanged !== false || !(WEAK_MATCHES.has(entry.how) || entry.inferred)) continue;
      const confirmed = threadContext.confirmFunction(entry.old, entry.target);
      if (confirmed) entry.confirmed = confirmed;
    }
  }
  const result = {
    ok: !failedRequired && Boolean(home),
    units,
    stats: matcher ? matcher.stats() : null,
    notes: [...base.notes, ...threadContext.notes],
    doubts: doubtfulSymbols(evidence),
    evidence,
    missingSymbols: missing,
    matcher,
    layout: threads ? threads.values : null,
  };
  if (!home || !threads) return result;
  return {
    ...result,
    final: threads.result,
    homePlan: home.plan,
    homeBodies: home.bodiesBin,
    threadPlan: threads.plan,
    stages: [sha(newPristine), home.plan.patchedSha256, ...(systemTheme ? [systemTheme.patchedSha256] : []), ...(gates ? [threads.plan.sourceSha256] : []), threads.plan.patchedSha256],
    profile: {
      wasm: { functions, constants: nextConstants(profile, threads) },
      systemTheme,
      gateConstants: gates ? gates.constants : profile.gateConstants,
      lightingGates: gates ? gates.gates : null,
      themeAddress: home.plan.dataBase + (systemTheme ? systemTheme.valueOffset : (profile.systemTheme ? profile.systemTheme.valueOffset : 0)),
    },
  };
}

module.exports = { portWasm, matchBuilds, portSystemTheme, portLightingGates, doubtfulSymbols, sha };
