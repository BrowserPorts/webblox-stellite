#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { mutate, undoPermutation, renameIdentifiers } = require('./mutate');
const { portWasm } = require('../patches/engine-wasm');
const { Pipeline, readPlans, ROOT } = require('../pipeline');
const { WasmModule, KIND } = require('../wasm/module');
const { applyLightingGates } = require('../wasm/splice');
const { HOW_NAMES } = require('../match/matcher');
const { sha } = require('../delta');
const { compareTrees } = require('../verify');

const PLANS_DIR = path.join(ROOT, 'tools', 'backport');
const WORK = path.join(ROOT, '.cache', 'autoport-test');
const LIVE_PUBLIC = path.join(ROOT, 'public');
const BUILDS = path.join(ROOT, '.cache', 'engine-builds');

const plans = readPlans(PLANS_DIR);
const pristineDir = path.join(BUILDS, plans.profile.version);
const pristine = fs.readFileSync(path.join(pristineDir, 'WebClient.wasm'));
const liveFinalSha = plans.threads.patchedSha256;
const log = process.argv.includes('--verbose') ? message => console.log(`    ${message}`) : () => {};

const results = [];
let current = '';

function check(name, ok, detail = '') {
  results.push({ scenario: current, name, ok, detail });
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function port(newPristine, overrides = {}) {
  return portWasm({ oldPristine: pristine, newPristine, profile: plans.profile, homePlan: plans.home, homeBodies: plans.bodies, cache: null, log, ...overrides });
}

function unit(wasm, id) {
  return wasm.units.find(entry => entry.id === id);
}

function allPorted(wasm) {
  return wasm.units.every(entry => entry.status === 'ported');
}

function statusLine(wasm) {
  return wasm.units.filter(entry => entry.status !== 'ported').map(entry => `${entry.id}: ${entry.reason}`).join('; ') || 'every unit ported';
}

function matcherAccuracy(wasm, truth) {
  const { matcher } = wasm;
  const imports = truth.imports;
  const total = imports + truth.defined;
  let wrong = 0;
  let missing = 0;
  let harmless = 0;
  const wrongByHow = {};
  const newModule = matcher.to.module;
  for (let func = imports; func < total; func++) {
    const mapped = matcher.map[func];
    if (mapped < 0) {
      missing++;
      continue;
    }
    if (mapped === truth.functionMap[func]) continue;
    wrong++;
    if (sameBehavior(newModule, mapped, truth.functionMap[func], 6)) {
      harmless++;
      continue;
    }
    const how = HOW_NAMES[matcher.how[func]];
    wrongByHow[how] = (wrongByHow[how] || 0) + 1;
  }
  return { wrong, missing, harmless, wrongByHow, total: truth.defined };
}

function sameBehavior(module, a, b, depth) {
  if (a === b) return true;
  if (a < module.importCount || b < module.importCount) return false;
  if (module.body(a).equals(module.body(b))) return true;
  if (!depth) return false;
  const left = module.decode(a);
  const right = module.decode(b);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const x = left[i];
    const y = right[i];
    if (x.op !== y.op || x.sub !== y.sub) return false;
    if (x.op === 0x10 || x.op === 0x12) {
      if (!sameBehavior(module, x.a, y.a, depth - 1)) return false;
    } else if (x.kind === KIND.MEMARG) {
      if (x.a !== y.a) return false;
    } else if (!module.buffer.subarray(x.start, x.end).equals(module.buffer.subarray(y.start, y.end))) {
      return false;
    }
  }
  return true;
}

function symbolsCorrect(wasm, truth) {
  const wrong = [];
  for (const [name, oldFunc] of Object.entries(plans.profile.wasm.functions)) {
    const mapped = wasm.profile ? wasm.profile.wasm.functions[name] : undefined;
    if (mapped !== truth.functionMap[oldFunc]) wrong.push(`${name}: ${mapped} and the truth is ${truth.functionMap[oldFunc]}`);
  }
  return wrong;
}

function protectedFunctions() {
  const names = Object.values(plans.profile.wasm.functions);
  const stubs = plans.home.order.filter(func => func < pristineModuleEnd());
  return [...names, ...plans.profile.gateConstants.functions, ...stubs, plans.home.mainIndex];
}

let moduleEnd = 0;
function pristineModuleEnd() {
  if (!moduleEnd) moduleEnd = new WasmModule(pristine).functionCount;
  return moduleEnd;
}

function breakFunction(buffer, func, fromHex, toHex) {
  const imports = new WasmModule(buffer).importCount;
  return applyLightingGates(buffer, [{ func, from: fromHex, to: toHex }], imports);
}

const scenarios = {
  permute() {
    const { buffer, truth } = mutate(pristine, { permute: true, seed: 101 });
    check('the mutated build is valid', WebAssembly.validate(buffer));
    const wasm = port(buffer);
    check('every unit ports', wasm.ok && allPorted(wasm), statusLine(wasm));
    const accuracy = matcherAccuracy(wasm, truth);
    check('the matcher finds the true function for almost every function', accuracy.wrong - accuracy.harmless === 0, `${accuracy.wrong} wrong of ${accuracy.total}, ${accuracy.harmless} of those identical twins, ${accuracy.missing} unmatched, ${JSON.stringify(accuracy.wrongByHow)}`);
    const wrongSymbols = symbolsCorrect(wasm, truth);
    check('every named function resolves to the truth', !wrongSymbols.length, wrongSymbols.slice(0, 5).join('; '));
    check('the ported module is valid', WebAssembly.validate(wasm.final));
    const undone = undoPermutation(wasm.final, truth);
    const same = sha(undone) === liveFinalSha;
    check('undoing the mutation gives the live patched engine, byte for byte', same, same ? '' : sha(undone).slice(0, 16));
    if (!same) reportFunctionDifferences(undone, fs.readFileSync(path.join(LIVE_PUBLIC, 'engine', 'WebClient.wasm')));
  },

  importShift() {
    const { buffer, truth } = mutate(pristine, { permute: true, seed: 202, extraImport: { at: 100, name: 'emscripten_new_runtime_call' } });
    check('the mutated build is valid', WebAssembly.validate(buffer));
    const wasm = port(buffer);
    check('every unit ports', wasm.ok && allPorted(wasm), statusLine(wasm));
    const wrongSymbols = symbolsCorrect(wasm, truth);
    check('every named function resolves to the truth', !wrongSymbols.length, wrongSymbols.slice(0, 5).join('; '));
    const plan = wasm.homePlan;
    check('the home plan moved past the new import', plan && plan.imports === plans.home.imports + 1, plan ? `${plan.imports} imports` : '');
    check('the ported module is valid', wasm.final && WebAssembly.validate(wasm.final));
  },

  locals() {
    const { buffer, truth } = mutate(pristine, { permute: true, locals: true, seed: 303 });
    check('the mutated build is valid', WebAssembly.validate(buffer));
    const wasm = port(buffer);
    check('every unit ports', wasm.ok && allPorted(wasm), statusLine(wasm));
    const accuracy = matcherAccuracy(wasm, truth);
    check('renumbered locals do not confuse the matcher', accuracy.wrong - accuracy.harmless === 0, `${accuracy.wrong} wrong of ${accuracy.total}, ${accuracy.harmless} identical twins, ${accuracy.missing} unmatched`);
    const wrongSymbols = symbolsCorrect(wasm, truth);
    check('every named function resolves to the truth', !wrongSymbols.length, wrongSymbols.slice(0, 5).join('; '));
    check('the ported module is valid', wasm.final && WebAssembly.validate(wasm.final));
  },

  changedFunctions() {
    const { buffer, truth } = mutate(pristine, { permute: true, locals: true, seed: 404, noiseShare: 0.15, noiseRate: 0.03, noiseProtect: protectedFunctions() });
    check('the mutated build is valid', WebAssembly.validate(buffer));
    const wasm = port(buffer);
    check('every unit ports with 15% of the other functions changed', wasm.ok && allPorted(wasm), statusLine(wasm));
    const accuracy = matcherAccuracy(wasm, truth);
    const precision = 1 - (accuracy.wrong - accuracy.harmless) / Math.max(1, accuracy.total - accuracy.missing);
    check('matcher precision stays above 99.9%', precision > 0.999, `${(precision * 100).toFixed(3)}%, ${accuracy.wrong} wrong of ${accuracy.total}, ${accuracy.harmless} identical twins, ${accuracy.missing} unmatched, ${JSON.stringify(accuracy.wrongByHow)}`);
    check('matcher recall stays above 95%', accuracy.missing / accuracy.total < 0.05, `${accuracy.missing} unmatched`);
    const wrongSymbols = symbolsCorrect(wasm, truth);
    check('every named function resolves to the truth', !wrongSymbols.length, wrongSymbols.slice(0, 5).join('; '));
    check('the ported module is valid', wasm.final && WebAssembly.validate(wasm.final));
  },

  noisyPatchSites() {
    const { buffer } = mutate(pristine, { permute: true, seed: 505, noiseShare: 1, noiseRate: 0.01 });
    check('the mutated build is valid', WebAssembly.validate(buffer));
    const wasm = port(buffer);
    const statuses = wasm.units.map(entry => `${entry.id}=${entry.status}`).join(' ');
    check('the tool finishes when every function changed', Array.isArray(wasm.units) && wasm.units.length > 0, statuses);
    const failures = wasm.units.filter(entry => entry.status === 'failed');
    check('each failed unit says why', failures.every(entry => entry.reason), `${failures.length} failed`);
    if (wasm.final) check('whatever ported is still a valid module', WebAssembly.validate(wasm.final));
  },

  layoutShift() {
    const { buffer, truth } = mutate(pristine, { permute: true, seed: 606, dataShifts: 24, dataStep: 3 });
    check('the mutated build is valid', WebAssembly.validate(buffer));
    const wasm = port(buffer);
    check('every unit ports after data moved', wasm.ok && allPorted(wasm), statusLine(wasm));
    const map = truth.data.map;
    if (!wasm.profile) return;
    check('the heap start follows the data', wasm.homePlan.dataBase === map(plans.home.dataBase), `${wasm.homePlan.dataBase}`);
    check('the theme address follows the heap start', wasm.profile.themeAddress === wasm.homePlan.dataBase + plans.profile.systemTheme.valueOffset);
    check('the theme vtable address is right', wasm.profile.systemTheme.vtableAddress === map(plans.profile.systemTheme.vtableAddress), `${wasm.profile.systemTheme.vtableAddress} and the truth is ${map(plans.profile.systemTheme.vtableAddress)}`);
    check('the allowlist flag address is right', wasm.profile.gateConstants.apiAllowlistFlag === map(plans.profile.gateConstants.apiAllowlistFlag));
    check('the batch vector addresses are right', JSON.stringify(wasm.profile.wasm.constants.BATCH_VECTOR) === JSON.stringify(plans.profile.wasm.constants.BATCH_VECTOR.map(map)), JSON.stringify(wasm.profile.wasm.constants.BATCH_VECTOR));
    const parseBodies = require('../patches/home-screen').parseBodies;
    const before = parseBodies(plans.bodies).bodies;
    const after = parseBodies(wasm.homeBodies).bodies;
    const { readInstruction, bodyStart } = require('../wasm/module');
    let wrong = 0;
    let checked = 0;
    const mistakes = [];
    before.forEach(({ bytes }, index) => {
      const relocations = new Map(plans.home.relocations.bodies[index]);
      const oldDecoded = decodeAll(bytes, readInstruction, bodyStart);
      const newDecoded = decodeAll(after[index].bytes, readInstruction, bodyStart);
      for (const [position, kind] of relocations) {
        if (kind !== 'address' && kind !== 'string') continue;
        checked++;
        const expected = map(oldDecoded[position].a);
        if (newDecoded[position].a !== expected) {
          wrong++;
          mistakes.push(`${kind} ${oldDecoded[position].a} became ${newDecoded[position].a}, truth ${expected}`);
        }
      }
    });
    check('every address the home screen uses moved to the truth', !wrong, `${checked} checked, ${wrong} wrong${mistakes.length ? `: ${mistakes.slice(0, 4).join('; ')}` : ''}`);
    check('the ported module is valid', wasm.final && WebAssembly.validate(wasm.final));
  },

  structFields() {
    const functions = plans.profile.wasm.functions;
    const { buffer, truth } = mutate(pristine, {
      permute: true,
      seed: 707,
      constants: [{ functions: [functions.CLUSTER_NEW], value: 340, to: 372 }],
      fields: plans.profile.wasm.constants.CLUSTER_FIELDS.map(offset => ({ functions: [functions.CLUSTER_PREPARE, functions.CLUSTER_DRAW], offset, by: 32 })),
    });
    check('the mutated build is valid', WebAssembly.validate(buffer));
    const wasm = port(buffer);
    check('every unit ports after struct fields moved', wasm.ok && allPorted(wasm), statusLine(wasm));
    if (!wasm.layout) return;
    check('the cluster allocation size follows the source', wasm.layout.clusterBytes === 372, `${wasm.layout.clusterBytes}`);
    check('the cluster fields follow the source', JSON.stringify(wasm.layout.clusterFields) === JSON.stringify(plans.profile.wasm.constants.CLUSTER_FIELDS.map(offset => offset + 32)), JSON.stringify(wasm.layout.clusterFields));
    const wrongSymbols = symbolsCorrect(wasm, truth);
    check('every named function still resolves to the truth', !wrongSymbols.length, wrongSymbols.slice(0, 5).join('; '));
    check('the ported module is valid', wasm.final && WebAssembly.validate(wasm.final));
  },

  brokenOptionalGate() {
    const gate = plans.profile.lightingGates[0];
    const broken = breakFunction(pristine, gate.func, gate.from, gate.from.replace(/410146$/, '410346'));
    const { buffer } = mutate(broken, { permute: true, seed: 808 });
    const wasm = port(buffer);
    check('the broken gate fails', unit(wasm, 'lighting-gates').status === 'failed', unit(wasm, 'lighting-gates').reason);
    check('the failure names the site', Boolean(unit(wasm, 'lighting-gates').details && unit(wasm, 'lighting-gates').details.site), JSON.stringify(unit(wasm, 'lighting-gates').details && unit(wasm, 'lighting-gates').details.site));
    check('the other units still port', wasm.units.filter(entry => entry.id !== 'lighting-gates').every(entry => entry.status === 'ported'), statusLine(wasm));
    check('the update can still go ahead without it', wasm.ok);
    check('the next profile records the gap', wasm.profile && wasm.profile.lightingGates === null);
    check('the result is valid', wasm.final && WebAssembly.validate(wasm.final));
  },

  brokenRequiredSite() {
    const func = plans.profile.wasm.functions.LIGHT_UPLOAD;
    const module = new WasmModule(pristine);
    const decoded = module.decode(func);
    const at = decoded.findIndex((entry, index) => entry.op === 0x6b && decoded[index + 1].op === 0x41 && decoded[index + 1].a === 2 && decoded[index + 2].op === 0x75 && decoded[index + 3].op === 0x22);
    check('the test finds the light list site', at >= 0);
    const bytes = pristine.subarray(decoded[at - 2].start, decoded[at + 3].end);
    const changed = Buffer.from(bytes);
    changed[decoded[at + 1].start - decoded[at - 2].start + 1] = 3;
    const broken = breakFunction(pristine, func, bytes.toString('hex'), changed.toString('hex'));
    const { buffer } = mutate(broken, { permute: true, seed: 909 });
    const wasm = port(buffer);
    const lightUnit = unit(wasm, 'light-list-end');
    check('the required unit fails', lightUnit.status === 'failed', lightUnit.reason);
    check('a failed required unit stops the update', wasm.ok === false);
    check('the failure carries a code listing', Boolean(lightUnit.details && lightUnit.details.nearby));
    check('the failure names the closest match', Boolean(lightUnit.details && lightUnit.details.closestMatch), lightUnit.details && lightUnit.details.closestMatch);
    check('the other units still get a verdict', wasm.units.filter(entry => entry.status === 'ported').length === wasm.units.length - 1, statusLine(wasm));
  },

  brokenHomeScreen() {
    const pattern = plans.home.mainPatternHex;
    const broken = breakFunction(pristine, plans.home.mainIndex, pattern, pattern.replace(/41013a0000$/, '41023a0000'));
    const { buffer } = mutate(broken, { permute: true, seed: 1010 });
    const wasm = port(buffer);
    const home = unit(wasm, 'home-screen');
    check('the home screen fails when its anchor is gone', home.status === 'failed', home.reason);
    check('the update stops', wasm.ok === false);
    check('the other units still get a verdict', wasm.units.filter(entry => entry.status === 'ported').length >= 8, statusLine(wasm));
    check('no output is produced', !wasm.final);
  },

  missingImport() {
    const data = Buffer.from(pristine);
    const name = Buffer.from('glPixelStorei');
    const at = data.indexOf(name);
    data.write('glPixelStorex', at, 'latin1');
    const { buffer } = mutate(data, { permute: true, seed: 1111 });
    const wasm = port(buffer);
    const threads = wasm.units.filter(entry => entry.group === 'wasm' && entry.status === 'failed');
    check('a missing import fails cleanly', threads.length > 0, statusLine(wasm));
    check('the update stops', wasm.ok === false);
  },

  truncatedFile() {
    let error = null;
    try {
      port(pristine.subarray(0, pristine.length - 1000));
    } catch (caught) {
      error = caught;
    }
    check('a truncated download gives an error message', Boolean(error), error ? error.message : 'no error');
    check('the message is about the file', Boolean(error) && /section|past the end|WebAssembly/i.test(error.message));
  },
};

function decodeAll(bytes, readInstruction, bodyStart) {
  const out = [];
  let at = bodyStart(bytes, 0);
  while (at < bytes.length) {
    const instruction = readInstruction(bytes, at, {});
    at = instruction.end;
    out.push(instruction);
  }
  return out;
}

function reportFunctionDifferences(actual, expected) {
  const a = new WasmModule(actual);
  const b = new WasmModule(expected);
  console.log(`    sections: ${a.sections.map(section => section.end - section.start).join(',')} vs ${b.sections.map(section => section.end - section.start).join(',')}`);
  if (a.functionCount !== b.functionCount) {
    console.log(`    function count ${a.functionCount} vs ${b.functionCount}`);
    return;
  }
  let shown = 0;
  let different = 0;
  for (let func = a.importCount; func < a.functionCount; func++) {
    if (a.body(func).equals(b.body(func))) continue;
    different++;
    if (shown++ < 12) {
      const left = a.decode(func);
      const right = b.decode(func);
      const at = left.findIndex((entry, index) => !right[index] || entry.op !== right[index].op || entry.a !== right[index].a);
      const describe = entry => (entry ? `op ${entry.op.toString(16)} a ${entry.a}` : 'end');
      console.log(`    function ${func}: instruction ${at}: ${describe(left[at])} vs ${describe(right[at])}`);
    }
  }
  console.log(`    ${different} function bodies differ`);
}

function cloneBundle(from, to, wasm, editors = {}) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else {
        const target = path.join(to, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(full, target, fs.constants.COPYFILE_FICLONE);
      }
    }
  };
  walk(from, '');
  fs.writeFileSync(path.join(to, 'WebClient.wasm'), wasm);
  for (const [name, edit] of Object.entries(editors)) {
    const file = path.join(to, name);
    fs.writeFileSync(file, edit(fs.readFileSync(file, 'latin1')), 'latin1');
  }
}

async function runFullPipeline(options) {
  const pipeline = new Pipeline({ skipShaders: true, noCache: true, updatesDir: path.join(WORK, 'updates'), log, ...options });
  return pipeline.run();
}

const fullScenarios = {
  async chain() {
    const first = mutate(pristine, { permute: true, seed: 2001 });
    const firstBundle = path.join(WORK, 'bundle-1');
    cloneBundle(pristineDir, firstBundle, first.buffer);
    const one = await runFullPipeline({ bundle: firstBundle, toVersion: 'version-mutant-one' });
    const contractFailures = list => list.filter(contract => !contract.ok && contract.severity === 'error').map(contract => contract.id);
    check('the first update finishes with only the shader skip', one.report.outcome === 'partial' && !one.report.units.some(entry => entry.status === 'failed'), `${one.report.outcome}, ${contractFailures(one.report.contracts).join(',') || 'contracts clean'}`);
    const oneFinal = fs.readFileSync(path.join(one.stage.engine, 'WebClient.wasm'));
    check('the first update undoes to the live engine', sha(undoPermutation(oneFinal, first.truth)) === liveFinalSha);

    fs.rmSync(path.join(BUILDS, 'version-mutant-one'), { recursive: true, force: true });
    const shaderDir = path.join(one.stage.engine, 'shaders');
    fs.mkdirSync(path.join(one.stage.gen), { recursive: true });
    fs.copyFileSync(path.join(LIVE_PUBLIC, 'engine', 'shaders', 'shaders_glsles3_web.pack'), path.join(shaderDir, 'shaders_glsles3_web.pack'));

    const second = mutate(first.buffer, { permute: true, seed: 2002 });
    const secondBundle = path.join(WORK, 'bundle-2');
    cloneBundle(pristineDir, secondBundle, second.buffer);
    const two = await runFullPipeline({ bundle: secondBundle, toVersion: 'version-mutant-two', plansDir: one.stage.plans, publicDir: one.stage.public });
    check('the second update reads the first one through the recovery file', two.report.from.source === 'the recovery file', two.report.from.source);
    check('the second update finishes with only the shader skip', two.report.outcome === 'partial' && !two.report.units.some(entry => entry.status === 'failed'), `${two.report.outcome}, ${contractFailures(two.report.contracts).join(',') || 'contracts clean'}`);
    const twoFinal = fs.readFileSync(path.join(two.stage.engine, 'WebClient.wasm'));
    const backOne = undoPermutation(twoFinal, second.truth);
    const backZero = undoPermutation(backOne, first.truth);
    check('undoing both updates gives the live engine, byte for byte', sha(backZero) === liveFinalSha, sha(backZero).slice(0, 16));
    const tree = compareTrees(path.join(LIVE_PUBLIC, 'engine'), two.stage.engine);
    const expected = new Set(['WebClient.wasm', 'shaders/shaders_glsles3_web.pack', 'ExtraContent/models/UniversalApp/UniversalApp.rbxm']);
    const unexpected = [...tree.differs.filter(file => !expected.has(file)), ...tree.missing, ...tree.extra];
    check('the rest of the second stage matches the live engine', !unexpected.length, `${tree.compared} files compared${unexpected.length ? `: ${unexpected.slice(0, 5).join(', ')}` : ''}`);
    fs.rmSync(path.join(BUILDS, 'version-mutant-one'), { recursive: true, force: true });
    fs.rmSync(path.join(BUILDS, 'version-mutant-two'), { recursive: true, force: true });
  },

  async minifierRenames() {
    const webRenames = [['Ee', 'Qx'], ['Ce', 'Rm'], ['fe', 'kZ'], ['ie', 'Hb'], ['Ze', 'vT'], ['jr', 'Wy'], ['a_', 'c2'], ['Gr', 'Zk'], ['zr', 'Nq'], ['ri', 'tD'], ['Nr', 'gV'], ['di', 'uX'], ['n_', 'sJ']];
    const loaderRenames = [['Qe', 'Mz'], ['Ye', 'Ln']];
    const bundle = path.join(WORK, 'bundle-js');
    const collide = text => webRenames.concat(loaderRenames).filter(([, to]) => new RegExp(`(?<![\\w$.])${to}(?![\\w$])`).test(text)).map(([, to]) => to);
    const webText = fs.readFileSync(path.join(pristineDir, 'WebClient.js'), 'latin1');
    const loaderText = fs.readFileSync(path.join(pristineDir, 'WasmPlayer.js'), 'latin1');
    check('the renamed identifiers are free in the pristine files', !collide(webText).filter(name => webRenames.some(([, to]) => to === name)).length && !collide(loaderText).filter(name => loaderRenames.some(([, to]) => to === name)).length, [...collide(webText), ...collide(loaderText)].join(','));
    const { buffer } = mutate(pristine, { permute: true, seed: 3001 });
    cloneBundle(pristineDir, bundle, buffer, {
      'WebClient.js': text => renameIdentifiers(text, webRenames),
      'WasmPlayer.js': text => renameIdentifiers(text, loaderRenames),
    });
    const run = await runFullPipeline({ bundle, toVersion: 'version-mutant-js' });
    const failed = run.report.units.filter(entry => entry.status === 'failed');
    check('every JavaScript patch ports through renames', !failed.length, failed.map(entry => entry.title).join('; '));
    const renamed = run.report.units.filter(entry => (entry.group === 'webclient' || entry.group === 'loader') && entry.status === 'ported').length;
    check('some patches really were renamed', renamed > 0, `${renamed} renamed`);
    const stageWeb = fs.readFileSync(path.join(run.stage.engine, 'WebClient.js'), 'latin1');
    const expectedWeb = renameIdentifiers(fs.readFileSync(path.join(LIVE_PUBLIC, 'engine', 'WebClient.js'), 'latin1'), webRenames);
    check('patching then renaming equals renaming then patching for WebClient.js', stageWeb === expectedWeb, firstDifference(stageWeb, expectedWeb));
    const stageLoader = fs.readFileSync(path.join(run.stage.engine, 'WasmPlayer.js'), 'latin1');
    const expectedLoader = renameIdentifiers(fs.readFileSync(path.join(LIVE_PUBLIC, 'engine', 'WasmPlayer.js'), 'latin1'), loaderRenames);
    check('patching then renaming equals renaming then patching for WasmPlayer.js', stageLoader === expectedLoader, firstDifference(stageLoader, expectedLoader));
    check('both patched files parse', run.report.contracts.filter(contract => contract.id.startsWith('syntax-')).every(contract => contract.ok));
    fs.rmSync(path.join(BUILDS, 'version-mutant-js'), { recursive: true, force: true });
  },

  async boot() {
    const { buffer } = mutate(pristine, { permute: true, locals: true, seed: 5001 });
    const bundle = path.join(WORK, 'bundle-boot');
    cloneBundle(pristineDir, bundle, buffer);
    const run = await runFullPipeline({ bundle, toVersion: 'version-mutant-boot', skipShaders: false, smoke: true });
    const failed = run.report.contracts.filter(contract => !contract.ok);
    check('the shuffled build passes every check', run.report.outcome === 'ready', failed.map(contract => `${contract.id}: ${contract.detail.slice(0, 200)}`).join('; '));
    const smoke = run.report.contracts.find(contract => contract.id === 'smoke');
    check('the ported engine boots to the launcher in a headless browser', Boolean(smoke && smoke.ok), smoke && smoke.detail);
    const shot = path.join(run.stage.root, 'smoke.png');
    if (fs.existsSync(shot)) fs.copyFileSync(shot, path.join(ROOT, '.cache', 'autoport-boot.png'));
    fs.rmSync(path.join(BUILDS, 'version-mutant-boot'), { recursive: true, force: true });
  },

  async brokenJavaScript() {
    const bundle = path.join(WORK, 'bundle-badjs');
    const { buffer } = mutate(pristine, { permute: true, seed: 4001 });
    cloneBundle(pristineDir, bundle, buffer, {
      'WebClient.js': text => text.replace('console.log("[WebView JS] Setting iframe src to:",s),D.src=s', 'console.log("[WebView] src:",s),D.src=s'),
      'WasmPlayer.js': text => text.replace('"aria-label","Loading Roblox"', '"aria-label","Loading the client"'),
    });
    const run = await runFullPipeline({ bundle, toVersion: 'version-mutant-badjs' });
    const web = run.report.units.filter(entry => entry.group === 'webclient' && entry.status === 'failed');
    const loader = run.report.units.filter(entry => entry.group === 'loader' && entry.status === 'failed');
    check('a missing WebClient.js patch target fails', web.length === 1 && web[0].required, web.map(entry => entry.reason).join('; '));
    check('a missing wording target fails as optional', loader.length === 1 && !loader[0].required, loader.map(entry => entry.title).join('; '));
    check('the update stops and writes a report', run.report.outcome === 'failed' && fs.existsSync(run.stage.reportMarkdown));
    check('the live public folder is untouched', sha(fs.readFileSync(path.join(LIVE_PUBLIC, 'engine', 'WebClient.wasm'))) === liveFinalSha);
    fs.rmSync(path.join(BUILDS, 'version-mutant-badjs'), { recursive: true, force: true });
  },
};

function firstDifference(a, b) {
  if (a === b) return '';
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  return `first difference at ${at}: ${JSON.stringify(a.slice(at - 30, at + 50))} vs ${JSON.stringify(b.slice(at - 30, at + 50))}`;
}

async function main() {
  const wanted = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  const all = { ...scenarios, ...fullScenarios };
  const names = wanted.length ? wanted : Object.keys(all).filter(name => name !== 'boot');
  try {
    os.setPriority(0, 10);
  } catch {}
  for (const name of names) {
    if (!all[name]) throw new Error(`no scenario called ${name}. There are: ${Object.keys(all).join(', ')}`);
    current = name;
    const start = Date.now();
    console.log(`\n${name}`);
    try {
      await all[name]();
    } catch (error) {
      check('the scenario ran to the end', false, error.stack.split('\n').slice(0, 4).join(' | '));
    }
    console.log(`  ${((Date.now() - start) / 1000).toFixed(0)} seconds`);
  }
  fs.rmSync(WORK, { recursive: true, force: true });
  const failed = results.filter(entry => !entry.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  for (const entry of failed) console.log(`  FAILED ${entry.scenario}: ${entry.name} ${entry.detail}`);
  process.exitCode = failed.length ? 1 : 0;
}

main();
