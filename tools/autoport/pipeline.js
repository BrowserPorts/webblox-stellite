'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Sources = require('./sources');
const Contracts = require('./contracts');
const { writeRecovery, sha } = require('./delta');
const { portWasm } = require('./patches/engine-wasm');
const { portModels } = require('./patches/models');
const { portList } = require('./patches/js-text');
const { deepDifferences, compareTrees, modelsEquivalent, wgslEquivalent, metadataEquivalent } = require('./verify');
const { renderReport } = require('./report');
const FlagTable = require('../flagguard/table');
const FlagChannels = require('../flagguard/channels');
const FlagPins = require('../flagguard/pin');
const { portOverrides } = require('../flagguard/port');

const ROOT = path.join(__dirname, '..', '..');
const TOOLS = path.join(ROOT, 'tools');
const PLAN_FILES = { profile: 'profile.json', home: 'luaapp-plan.json', bodies: 'luaapp-bodies.wasm', threads: 'render-threads-plan.json' };
const RECOVERY_FILE = 'pristine.delta';
const ENGINE_ONLY_RUNTIME = /__webblox|__wb/;
const WARMUP = 'shader-warmup.json';
const CLONE = fs.constants.COPYFILE_FICLONE;
const MATCH_SOURCES = ['match/matcher.js', 'match/features.js', 'match/align.js', 'wasm/module.js', 'wasm/image.js'];

const OUTCOME = { READY: 'ready', PARTIAL: 'partial', FAILED: 'failed', CURRENT: 'up to date' };
const EXIT = { [OUTCOME.READY]: 0, [OUTCOME.CURRENT]: 0, [OUTCOME.FAILED]: 1, [OUTCOME.PARTIAL]: 2 };

function stagePaths(root) {
  const publicDir = path.join(root, 'public');
  return {
    root,
    public: publicDir,
    engine: path.join(publicDir, 'engine'),
    gen: path.join(publicDir, 'gen'),
    index: path.join(publicDir, 'index.html'),
    plans: path.join(root, 'plans'),
    logs: path.join(root, 'logs'),
    reportJson: path.join(root, 'report.json'),
    reportMarkdown: path.join(root, 'report.md'),
  };
}

function readPlans(dir) {
  const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  return {
    profile: read(PLAN_FILES.profile),
    home: read(PLAN_FILES.home),
    threads: read(PLAN_FILES.threads),
    bodies: fs.readFileSync(path.join(dir, PLAN_FILES.bodies)),
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function walkFiles(dir, prefix = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkFiles(path.join(dir, entry.name), rel, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function cloneFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, CLONE);
}

function ownedFiles(engineDir) {
  const listed = JSON.parse(fs.readFileSync(path.join(engineDir, 'WebClient.metadata.json'), 'utf8')).map(entry => entry.path);
  const fromRoblox = new Set([...listed, ...Sources.CORE_FILES].map(file => file.replace(/^\//, '')));
  return walkFiles(engineDir).filter(rel => !fromRoblox.has(rel));
}

class MatchCache {
  constructor(dir) {
    this.dir = dir;
    const hash = crypto.createHash('sha256');
    for (const file of MATCH_SOURCES) hash.update(fs.readFileSync(path.join(__dirname, file)));
    this.tag = hash.digest('hex').slice(0, 16);
  }

  file(oldSha, newSha) {
    return path.join(this.dir, `${oldSha.slice(0, 16)}-${newSha.slice(0, 16)}-${this.tag}.match`);
  }

  load(oldSha, newSha) {
    const file = this.file(oldSha, newSha);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  save(oldSha, newSha, data) {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(`-${this.tag}.match`)) fs.rmSync(path.join(this.dir, name), { force: true });
    }
    Sources.writeAtomic(this.file(oldSha, newSha), data);
  }
}

function replaceOnce(text, pattern, replacement, label) {
  const hits = text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
  if (!hits || hits.length !== 1) throw new Error(`${label}: expected one match, found ${hits ? hits.length : 0}`);
  return text.replace(pattern, replacement);
}

function indexHtmlFor(text, version, themeAddress) {
  const versioned = replaceOnce(text, /var version = 'version-[0-9a-z-]+';/, `var version = '${version}';`, 'the engine version in public/index.html');
  return replaceOnce(versioned, /heap\[\d+ >> 2\] = scheme\.matches \? 2 : 1;/, `heap[${themeAddress} >> 2] = scheme.matches ? 2 : 1;`, 'the theme address in public/index.html');
}

function runTool(args, { logFile, verbose, cwd = ROOT, env = process.env }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(logFile);
    let output = '';
    const onData = data => {
      output += data;
      log.write(data);
      if (verbose) process.stdout.write(data);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', error => {
      log.end();
      resolve({ ok: false, output: error.message });
    });
    child.on('close', code => {
      log.end();
      resolve({ ok: code === 0, output });
    });
  });
}

class Pipeline {
  constructor(options = {}) {
    this.options = options;
    this.plansDir = options.plansDir || path.join(TOOLS, 'backport');
    this.publicDir = options.publicDir || path.join(ROOT, 'public');
    this.updatesDir = options.updatesDir || path.join(ROOT, '.cache', 'engine-update');
    this.log = options.log || (message => console.log(`[autoport] ${message}`));
    this.started = Date.now();
    this.report = {
      tool: 'autoport',
      startedAt: new Date(this.started).toISOString(),
      selftest: Boolean(options.selftest),
      from: {},
      to: {},
      units: [],
      contracts: [],
      notes: [],
      warnings: [],
      steps: [],
      outcome: OUTCOME.FAILED,
    };
  }

  async step(id, work) {
    const start = Date.now();
    try {
      return await work();
    } finally {
      this.report.steps.push({ id, seconds: +((Date.now() - start) / 1000).toFixed(1) });
    }
  }

  warn(message) {
    this.report.warnings.push(message);
    this.log(`warning: ${message}`);
  }

  unit(entry) {
    this.report.units.push(entry);
  }

  async resolveTarget(plans) {
    const { options, report } = this;
    const { profile } = plans;
    report.from = { version: profile.version, wasmSha256: plans.home.sourceSha256, patchedSha256: plans.threads.patchedSha256 };
    if (options.selftest) return { version: profile.version, dir: null };
    if (options.bundle) {
      const dir = path.resolve(options.bundle);
      const wasm = path.join(dir, 'WebClient.wasm');
      if (!fs.existsSync(wasm)) throw new Error(`${dir} has no WebClient.wasm`);
      return { version: options.toVersion || `version-local-${sha(fs.readFileSync(wasm)).slice(0, 16)}`, dir };
    }
    const live = await Sources.latest();
    report.live = live;
    if (options.toVersion) return { version: options.toVersion, dir: null, live };
    return { version: live.web.hash, dir: null, live };
  }

  async chooseWindows(target, profile, oldWindows) {
    const { options } = this;
    if (options.windows) return options.windows;
    if (options.selftest || !target.live) return oldWindows;
    const { web, windows } = target.live;
    if (Sources.release(web.version) === Sources.release(windows.version)) return windows.hash;
    this.warn(`Windows is on release ${Sources.release(windows.version)} and the web client is on ${Sources.release(web.version)}, so the models and shaders stay on Windows ${oldWindows}. Run npm run update-launcher and npm run port-shaders when the releases match.`);
    return oldWindows;
  }

  portStrings(group, title, oldList, text, requiredOf) {
    const results = portList(text, oldList);
    const next = [];
    results.forEach((result, index) => {
      const required = requiredOf(oldList[index]);
      const label = `${title}: ${oldList[index][0].slice(0, 60)}`;
      if (result.status === 'failed') {
        this.unit({ id: `${group}-${index}`, group, title: label, required, status: 'failed', reason: result.reason, details: { closest: result.closest } });
        return;
      }
      const warnings = [];
      if (result.count !== oldList[index][2]) warnings.push(`the text appears ${result.count} times, and it used to appear ${oldList[index][2]} times`);
      if (result.status === 'merged') warnings.push(`Roblox edited this code, and the tool carried the edit into the patch: ${result.edits.map(edit => `\`${edit.removed}\` became \`${edit.added}\``).join('; ')}`);
      this.unit({ id: `${group}-${index}`, group, title: label, required, status: result.status === 'unchanged' ? 'unchanged' : 'ported', warnings, renames: result.renames });
      next.push([result.from, result.to, result.count]);
    });
    return next;
  }

  async buildStage(stage, newDir, windows) {
    fs.rmSync(stage.public, { recursive: true, force: true });
    this.log('Copying the new build into the stage');
    const newFiles = walkFiles(newDir);
    const present = new Set(newFiles);
    for (const rel of newFiles) cloneFile(path.join(newDir, rel), path.join(stage.engine, rel));
    const liveEngine = path.join(this.publicDir, 'engine');
    let overlaid = 0;
    if (fs.existsSync(liveEngine)) {
      for (const rel of ownedFiles(liveEngine)) {
        if (present.has(rel)) this.report.notes.push(`The new build ships ${rel}, and WebBlox has its own copy of that file. The stage uses the WebBlox copy.`);
        cloneFile(path.join(liveEngine, rel), path.join(stage.engine, rel));
        overlaid++;
      }
    }
    for (const entry of windows.files) {
      const file = path.join(stage.engine, ...entry.rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entry.data);
    }
    fs.mkdirSync(stage.gen, { recursive: true });
    const warmup = path.join(this.publicDir, 'gen', WARMUP);
    if (fs.existsSync(warmup)) cloneFile(warmup, path.join(stage.gen, WARMUP));
    return { files: newFiles.length, overlaid };
  }

  async runPatcher(stage) {
    const result = await runTool([path.join(TOOLS, 'patch-engine.js'), '--bundle', stage.engine, '--plans', stage.plans], { logFile: path.join(stage.logs, 'patch-engine.log'), verbose: this.options.verbose });
    const failures = result.output.split('\n').filter(line => /\bFAILED\b/.test(line)).map(line => line.trim());
    for (const failure of failures) this.unit({ id: `patch-${failure.slice(0, 24)}`, group: 'patcher', title: failure.split('  ')[0], required: true, status: 'failed', reason: failure });
    if (!result.ok && !failures.length) this.unit({ id: 'patcher', group: 'patcher', title: 'tools/patch-engine.js', required: true, status: 'failed', reason: result.output.slice(-800) });
    return result.ok;
  }

  async runShaders(stage, version, windowsHash) {
    const shared = { verbose: this.options.verbose };
    const steps = [
      { id: 'port-shaders', args: [path.join(TOOLS, 'port-shaders.js'), '--public', stage.public, '--engine-version', version, '--windows', windowsHash] },
      { id: 'build-wgsl', args: [path.join(TOOLS, 'build-wgsl.mjs'), '--public', stage.public] },
      { id: 'prep', args: [path.join(TOOLS, 'prep.js'), '--public', stage.public] },
    ];
    for (const { id, args } of steps) {
      this.log(`Running ${id}`);
      const result = await this.step(id, () => runTool(args, { ...shared, logFile: path.join(stage.logs, `${id}.log`) }));
      if (!result.ok) {
        this.unit({ id, group: 'shaders', title: `tools/${path.basename(args[0])}`, required: true, status: 'failed', reason: result.output.trim().split('\n').slice(-6).join('\n') });
        return false;
      }
      this.unit({ id, group: 'shaders', title: `tools/${path.basename(args[0])}`, required: true, status: 'ported', summary: result.output.trim().split('\n').slice(-1)[0] });
    }
    return true;
  }

  async portFlags(oldWasm, newWasm, required) {
    let live = null;
    try {
      live = await FlagChannels.fetchChannel(FlagChannels.CHANNELS.web);
    } catch (error) {
      this.warn(`${error.message}. The stage gets no flag pin, so run npm run flags -- pin after --apply.`);
    }
    let pin = null;
    try {
      pin = FlagPins.readPin(FlagPins.pinPath(path.join(this.publicDir, 'engine')));
    } catch (error) {
      this.warn(error.message);
    }
    const channels = [live, pin && pin.applicationSettings].filter(Boolean);
    if (!channels.length) {
      this.warn('Without any flag list the flag tables cannot be built, so the WebBlox overrides were not checked against the new build.');
      return { flags: required, renamed: [], lost: [], unchecked: Object.keys(required), live, pin, engineKeys: [] };
    }
    let oldTable;
    let newTable;
    try {
      oldTable = FlagTable.buildEngineTable(oldWasm, channels);
      newTable = FlagTable.buildEngineTable(newWasm, channels);
    } catch (error) {
      this.warn(`The flag tables could not be built (${error.message}), so the WebBlox overrides were not checked against the new build.`);
      return { flags: required, renamed: [], lost: [], unchecked: Object.keys(required), live, pin, engineKeys: [] };
    }
    for (const problem of FlagTable.checkTable({ ...newTable, lua: {}, mentions: [] })) this.warn(`Flag table: ${problem}`);
    const port = portOverrides(required, oldTable, newTable);
    for (const { from, to } of port.renamed) this.warn(`Roblox renamed the WebBlox override ${from} to ${to} in the new build, so the stage uses ${to}.`);
    this.log(`Flags: ${Object.keys(newTable.keys).length} engine flags in the new build, ${port.renamed.length} overrides renamed, ${port.lost.length} lost`);
    return { ...port, live, pin, engineKeys: Object.keys(required).filter(key => oldTable.keys[key]) };
  }

  stagePin(stage, version, flags) {
    const file = FlagPins.pinPath(stage.engine);
    if (this.options.selftest) return;
    if (!flags.live) {
      fs.rmSync(file, { force: true });
      return;
    }
    const pin = FlagPins.makePin({
      engine: version,
      settings: flags.live,
      ixp: flags.pin ? flags.pin.ixp : {},
      source: { channel: FlagChannels.CHANNELS.web, fetchedAt: new Date().toISOString(), experiments: flags.pin ? 'the previous pin' : 'none' },
    });
    FlagPins.writePin(file, pin);
    this.report.notes.push(`The stage pins ${Object.keys(pin.applicationSettings).length} live flags from ${pin.pinnedAt}, with the experiment values of the old pin. Run npm run flags -- pin after --apply to read fresh experiment values and test the pin.`);
  }

  async checkStage(stage, oldWasm, newWasm, plans, next) {
    const results = this.report.contracts;
    const finalFile = path.join(stage.engine, 'WebClient.wasm');
    const final = fs.readFileSync(finalFile);
    Contracts.record(results, 'wasm-hash', sha(final) === next.threads.patchedSha256, 'the patched engine matches the hash the planner recorded', 'error');
    Contracts.checkWasm(results, oldWasm, newWasm, final);
    Contracts.checkFlags(results, plans.profile.requiredFlags, { wasm: oldWasm, models: this.oldModels }, { wasm: newWasm, models: this.newModels }, this.flagPort);
    Contracts.checkToolchain(results, finalFile);
    Contracts.checkJavaScript(results, path.join(stage.engine, 'WebClient.js'));
    Contracts.checkJavaScript(results, path.join(stage.engine, 'WasmPlayer.js'));
    const packFile = path.join(stage.engine, 'shaders', 'shaders_glsles3_web.pack');
    if (!this.options.skipShaders) Contracts.checkShaders(results, path.join(this.publicDir, 'engine', 'shaders', 'shaders_glsles3_web.pack'), packFile);
    const check = await runTool([path.join(TOOLS, 'patch-engine.js'), '--check', '--bundle', stage.engine, '--plans', stage.plans], { logFile: path.join(stage.logs, 'patch-check.log') });
    Contracts.record(results, 'patches-applied', check.ok && !/\bneeded\b/.test(check.output), check.ok ? 'tools/patch-engine.js --check finds every patch applied' : check.output.slice(-400), 'error');
  }

  compareIdentity(stage, plans, next) {
    const { report } = this;
    const differences = [];
    const sections = [['profile', plans.profile, next.profile], ['home plan', plans.home, next.home], ['thread plan', plans.threads, next.threads]];
    for (const [name, before, after] of sections) {
      for (const difference of deepDifferences(before, after).slice(0, 20)) differences.push(`${name}: ${difference}`);
    }
    const liveEngine = path.join(this.publicDir, 'engine');
    const liveGen = path.join(this.publicDir, 'gen');
    const engineTree = compareTrees(liveEngine, stage.engine);
    const explained = new Set();
    for (const file of engineTree.differs) {
      if (!file.endsWith('.rbxm')) continue;
      const same = modelsEquivalent(fs.readFileSync(path.join(liveEngine, file)), fs.readFileSync(path.join(stage.engine, file)));
      if (same.equivalent) {
        explained.add(file);
        report.notes.push(`${file} differs from the live file, but it holds the same scripts. ${same.detail}`);
      }
    }
    const trees = [['engine', engineTree]];
    if (!this.options.skipShaders) {
      const genTree = compareTrees(liveGen, stage.gen);
      genTree.differs = genTree.differs.filter(file => {
        if (file === 'wgsl.txt' || file === 'wgsl-index.json') return !wgslEquivalent(liveGen, stage.gen);
        if (file === 'WebClient.metadata.json') return !metadataEquivalent(path.join(liveGen, file), path.join(stage.gen, file), explained);
        return true;
      });
      trees.push(['gen', genTree]);
    }
    for (const [name, tree] of trees) {
      this.log(`Compared ${tree.compared} files in ${name}`);
      for (const file of tree.differs.filter(entry => !explained.has(entry)).slice(0, 30)) differences.push(`${name}/${file} differs`);
      for (const file of tree.missing.slice(0, 30)) differences.push(`${name}/${file} is missing from the stage`);
      for (const file of tree.extra.slice(0, 30)) differences.push(`${name}/${file} only exists in the stage`);
    }
    report.identity = { same: !differences.length, differences };
    Contracts.record(report.contracts, 'identity', !differences.length, differences.length ? `${differences.length} difference(s) between the regenerated tree and the live tree` : 'the regenerated engine, plans and profile match the live ones', 'error');
  }

  async run() {
    try {
      return await this.runSteps();
    } catch (error) {
      this.report.outcome = OUTCOME.FAILED;
      this.report.fatal = error.message;
      this.report.fatalStack = error.stack;
      return this.finish(this.stage || null);
    }
  }

  async runSteps() {
    const { options, report } = this;
    const plans = readPlans(this.plansDir);
    const target = await this.step('resolve', () => this.resolveTarget(plans));
    report.to = { version: target.version };
    if (!options.selftest && target.version === plans.profile.version && !options.force) {
      report.outcome = OUTCOME.CURRENT;
      this.log(`Already on the live web client ${target.version}`);
      return this.finish(null);
    }

    const stage = stagePaths(path.join(this.updatesDir, target.version));
    fs.mkdirSync(stage.logs, { recursive: true });
    fs.rmSync(stage.plans, { recursive: true, force: true });
    fs.mkdirSync(stage.plans, { recursive: true });
    this.stage = stage;

    const recoveryFile = path.join(this.plansDir, RECOVERY_FILE);
    const patchedFile = path.join(this.publicDir, 'engine', 'WebClient.wasm');
    const old = await this.step('old-build', () => Sources.ensureOldWasm(plans.profile.version, plans.home.sourceSha256, { recoveryFile, patchedFile, log: this.log }));
    report.from.source = old.source;
    this.log(`Old pristine engine from ${old.source}`);

    const newBundle = await this.step('new-build', async () => (target.dir ? { dir: target.dir, failed: [] } : Sources.ensureBundle(target.version, this.log)));
    for (const entry of newBundle.failed) this.warn(`Could not download ${entry.file}: ${entry.reason}`);
    const newWasm = fs.readFileSync(path.join(newBundle.dir, 'WebClient.wasm'));
    report.to.wasmSha256 = sha(newWasm);

    const oldWindows = await this.step('old-windows', () => Sources.currentWindows(plans.profile, path.join(this.publicDir, 'engine'), this.log));
    const newWindows = await this.chooseWindows(target, plans.profile, oldWindows);
    report.from.windows = oldWindows;
    report.to.windows = newWindows;

    const wasm = await this.step('port-wasm', () => portWasm({
      oldPristine: old.data,
      newPristine: newWasm,
      profile: plans.profile,
      homePlan: plans.home,
      homeBodies: plans.bodies,
      cache: options.noCache ? null : new MatchCache(path.join(ROOT, '.cache', 'autoport', 'matches')),
      log: this.log,
    }));
    report.match = wasm.stats;
    report.symbols = wasm.evidence;
    report.missingSymbols = wasm.missingSymbols;
    report.notes.push(...wasm.notes);
    report.warnings.push(...wasm.doubts);
    for (const unit of wasm.units) {
      this.unit(unit);
      for (const warning of unit.warnings || []) report.warnings.push(`${unit.title}: ${warning}`);
    }

    this.log('Porting the Lua models');
    const oldModels = await Sources.windowsModels(oldWindows, this.log);
    const newModels = oldWindows === newWindows ? oldModels : await Sources.windowsModels(newWindows, this.log);
    this.oldModels = oldModels.models;
    this.newModels = newModels.models;
    let modelResult = null;
    await this.step('port-models', async () => {
      try {
        modelResult = portModels({ oldModels: oldModels.models, newModels: newModels.models, profile: plans.profile, bundles: { old: old.dir, new: newBundle.dir } });
        for (const result of modelResult.results) {
          this.unit({ ...result, group: 'models' });
          if (result.warning) report.warnings.push(`${result.title}: ${result.warning}`);
        }
      } catch (error) {
        this.unit({ id: 'models', group: 'models', title: 'Lua models', required: true, status: 'failed', reason: error.message });
      }
    });

    this.log('Porting the JavaScript patches');
    const webClient = await this.step('port-js', () => this.portStrings('webclient', 'WebClient.js', plans.profile.webClient, fs.readFileSync(path.join(newBundle.dir, 'WebClient.js'), 'utf8'), () => true));
    const wording = this.portStrings('loader', 'WasmPlayer.js', plans.profile.wording, fs.readFileSync(path.join(newBundle.dir, 'WasmPlayer.js'), 'utf8'), patch => ENGINE_ONLY_RUNTIME.test(patch[1]));

    const requiredFailed = () => report.units.filter(unit => unit.required && unit.status === 'failed');
    const optionalFailed = () => report.units.filter(unit => !unit.required && unit.status === 'failed');
    if (!wasm.ok || !modelResult || requiredFailed().length) {
      report.outcome = OUTCOME.FAILED;
      return this.finish(stage);
    }

    this.flagPort = await this.step('flags', () => this.portFlags(old.data, newWasm, plans.profile.requiredFlags || {}));
    const modelsNext = modelResult.next;
    const nextProfile = {};
    const filled = {
      version: target.version,
      wasm: wasm.profile.wasm,
      windows: newWindows,
      themeAddress: wasm.profile.themeAddress,
      systemTheme: wasm.profile.systemTheme,
      gateConstants: wasm.profile.gateConstants,
      lightingGates: wasm.profile.lightingGates,
      wordmarkBoxes: modelsNext.wordmarkBoxes || [],
      rectEdits: modelsNext.rectEdits || [],
      aspect: modelsNext.aspect || null,
      bytecodeVersion: modelsNext.bytecodeVersion === undefined ? plans.profile.bytecodeVersion : modelsNext.bytecodeVersion,
      bytecodeEdits: modelsNext.bytecodeEdits,
      wording,
      webClient,
      requiredFlags: this.flagPort.flags,
    };
    for (const key of Object.keys(plans.profile)) nextProfile[key] = key in filled ? filled[key] : plans.profile[key];
    const next = { profile: nextProfile, home: wasm.homePlan, threads: wasm.threadPlan };

    writeJson(path.join(stage.plans, PLAN_FILES.profile), nextProfile);
    writeJson(path.join(stage.plans, PLAN_FILES.home), wasm.homePlan);
    writeJson(path.join(stage.plans, PLAN_FILES.threads), wasm.threadPlan);
    fs.writeFileSync(path.join(stage.plans, PLAN_FILES.bodies), wasm.homeBodies);
    const recovery = writeRecovery(path.join(stage.plans, RECOVERY_FILE), { version: target.version, source: wasm.final, target: newWasm });
    this.log(`Recovery file is ${recovery.bytes} bytes`);

    const built = await this.step('stage', () => this.buildStage(stage, newBundle.dir, newModels));
    this.stagePin(stage, target.version, this.flagPort);
    this.log(`Stage has ${built.files} engine files and ${built.overlaid} files WebBlox owns`);

    this.log('Applying the patches to the stage');
    const patched = await this.step('patch', () => this.runPatcher(stage));
    if (!patched) {
      report.outcome = OUTCOME.FAILED;
      return this.finish(stage);
    }

    fs.writeFileSync(stage.index, indexHtmlFor(fs.readFileSync(path.join(this.publicDir, 'index.html'), 'utf8'), target.version, nextProfile.themeAddress));

    if (options.skipShaders) {
      this.warn('The shader port was skipped, so this stage cannot be applied.');
    } else if (!(await this.runShaders(stage, target.version, newWindows))) {
      report.outcome = OUTCOME.FAILED;
      return this.finish(stage);
    }

    this.log('Checking the stage');
    await this.step('contracts', () => this.checkStage(stage, old.data, newWasm, plans, next));
    if (options.selftest) this.compareIdentity(stage, plans, next);

    if (options.smoke) {
      this.log('Booting the stage in a headless browser');
      const smoke = await this.step('smoke', () => runTool([path.join(TOOLS, 'smoke.js'), '--stage', stage.root], { logFile: path.join(stage.logs, 'smoke.log'), verbose: options.verbose }));
      Contracts.record(report.contracts, 'smoke', smoke.ok, smoke.ok ? 'the stage boots to the launcher in a headless browser' : smoke.output.trim().split('\n').slice(-8).join('\n'), 'error');
    }

    if (options.selftest) fs.rmSync(stage.public, { recursive: true, force: true });
    const contractErrors = report.contracts.filter(contract => !contract.ok && contract.severity === 'error');
    if (requiredFailed().length || contractErrors.length) report.outcome = OUTCOME.FAILED;
    else if (optionalFailed().length || options.skipShaders) report.outcome = OUTCOME.PARTIAL;
    else report.outcome = OUTCOME.READY;
    return this.finish(stage);
  }

  finish(stage) {
    const { report } = this;
    report.finishedAt = new Date().toISOString();
    report.seconds = +((Date.now() - this.started) / 1000).toFixed(1);
    if (stage) {
      report.stage = path.relative(ROOT, stage.root);
      writeJson(stage.reportJson, report);
      fs.writeFileSync(stage.reportMarkdown, renderReport(report));
    }
    return { report, stage, exitCode: EXIT[report.outcome] };
  }
}

module.exports = { Pipeline, MatchCache, ownedFiles, stagePaths, readPlans, indexHtmlFor, replaceOnce, OUTCOME, EXIT, PLAN_FILES, RECOVERY_FILE, ROOT };
