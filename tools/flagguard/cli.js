#!/usr/bin/env node
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Table = require('./table');
const Flags = require('./flags');
const Channels = require('./channels');
const Pin = require('./pin');
const Boot = require('./boot');
const Bisect = require('./bisect');
const Parity = require('./parity');
const Report = require('./report');
const { subsystemOf } = require('./classify');

const ROOT = path.join(__dirname, '..', '..');
const CACHE = path.join(ROOT, '.cache', 'flagguard');
const PLANS = path.join(ROOT, 'tools', 'backport');
const DEFAULT_ENGINE = path.join(ROOT, 'public', 'engine');
const DECISIONS = path.join(__dirname, 'parity.json');
const BISECT_FILE = path.join(CACHE, 'bisect.json');
const STATUS_FILE = path.join(CACHE, 'status.json');
const WEB = Channels.CHANNELS.web;
const MAC = Channels.CHANNELS.mac;
const PC = Channels.CHANNELS.pc;
const MIN_NODE = [22, 4];
const LOW_PRIORITY = 10;
const DEFAULT_WAIT = 10;
const MIN_SCREEN_COLORS = 12;
const MIN_CHECKED_FLAGS = 500;
const LOCAL_URL = 'http://localhost:3000';
const NAMED_LIMIT = 6;
const EXIT = { OK: 0, FAILED: 1 };
const VALUED = new Set(['set', 'good', 'bad', 'engine', 'wait', 'from', 'version']);

const HELP = `Flag Guard pins the fast flags WebBlox gives the engine, so a change on
Roblox's side cannot change the game without anyone noticing.

Usage: npm run flags -- [command] [options]

Commands:
  status              Fetch the live flags and list what changed since the
                      pin. This is the default.
  diff                Like status, with every changed entry listed.
  test                Boot the engine headless with a flag set. It checks that
                      the engine starts, that each flag reached engine memory
                      and that the screen is not blank.
  pin                 Pin the live flags after a test boot passes.
  accept <keys>       Copy these keys from the live flags into the pin.
  explain <key>       Show what this build does with one key.
  history [key]       Show when Roblox changed flags, or one flag.
  bisect <step>       Find which flags cause a problem. Steps: start, good,
                      bad, skip, auto, status, reset.
  parity              Compare with the Mac and PC flags and build the parity
                      set from tools/flagguard/parity.json.
  adopt [key=value]   Turn the adopted parity flags, or the given keys, into
                      permanent WebBlox overrides.
  check               The quiet check the server runs every hour.

Options:
  --set <name>        For test: pinned (default), live, a saved set such as
                      parity or bisect, or a path to a JSON flag set.
  --good <set>        For bisect start: the set without the problem. The
                      default is pinned.
  --bad <set>         For bisect start: the set with the problem. The default
                      is live.
  --all               List or bisect every changed entry, including the ones
                      with no effect.
  --keep-ixp          For pin: keep the pinned experiment values instead of
                      reading new ones.
  --no-test           For pin and accept: skip the test boot.
  --force             For pin: write the pin even if the test boot fails.
  --engine <dir>      Use this engine folder instead of public/engine.
  --wait <seconds>    How long a test boot runs before the checks. The
                      default is ${DEFAULT_WAIT}.
  --verbose           Print more detail.
  --help              Print this help.
`;

function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (VALUED.has(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value.`);
      options[name] = value;
      i++;
    } else {
      options[name] = true;
    }
  }
  return options;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

function context(options) {
  const engineDir = path.resolve(options.engine || DEFAULT_ENGINE);
  const profile = readJson(path.join(PLANS, 'profile.json'), {});
  const version = options.version || profile.version;
  if (!version) throw new Error('tools/backport/profile.json names no engine version.');
  const overrides = (readJson(path.join(engineDir, 'WebFlags.json'), {}) || {}).applicationSettings || {};
  const wait = options.wait === undefined ? DEFAULT_WAIT : Number(options.wait);
  if (!Number.isFinite(wait) || wait < 0) throw new Error('--wait needs a number of seconds.');
  return { engineDir, profile, version, overrides, wait, required: profile.requiredFlags || {}, pinFile: Pin.pinPath(engineDir), custom: engineDir !== DEFAULT_ENGINE };
}

function stageEnv(ctx) {
  if (!ctx.custom) return {};
  const publicDir = path.dirname(ctx.engineDir);
  const env = { WEBBLOX_ENGINE_DIR: ctx.engineDir, WEBBLOX_ENGINE_VERSION: ctx.version };
  if (fs.existsSync(path.join(publicDir, 'gen'))) env.WEBBLOX_GEN_DIR = path.join(publicDir, 'gen');
  if (fs.existsSync(path.join(publicDir, 'index.html'))) env.WEBBLOX_INDEX_FILE = path.join(publicDir, 'index.html');
  return env;
}

function count(object) {
  return Object.keys(object || {}).length;
}

function age(iso) {
  if (!iso) return 'unknown';
  const hours = (Date.now() - Date.parse(iso)) / 3600000;
  if (hours < 1) return 'less than an hour ago';
  if (hours < 48) return `${Math.round(hours)} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function readPinSafe(ctx, log) {
  try {
    return Pin.readPin(ctx.pinFile);
  } catch (error) {
    log(`Warning: ${error.message}`);
    return null;
  }
}

function requirePin(ctx, log) {
  const pin = readPinSafe(ctx, log);
  if (!pin) throw new Error('There is no pin yet. Run npm run flags -- pin first.');
  return pin;
}

async function fetchLive(name = WEB) {
  const settings = await Channels.fetchChannel(name);
  Channels.recordSnapshot(CACHE, name, settings);
  return settings;
}

function knownChannels(extra) {
  const lists = extra.filter(Boolean);
  for (const name of [WEB, MAC, PC]) {
    const snapshot = Channels.readSnapshot(CACHE, name);
    if (snapshot) lists.push(snapshot.applicationSettings);
  }
  return lists;
}

function loadTable(ctx, channels, log) {
  const table = Table.tableFor(ctx.engineDir, knownChannels(channels), { cacheDir: CACHE, log });
  for (const problem of Table.checkTable(table)) log(`Warning: ${problem}`);
  return table;
}

function writeReport(name, text) {
  const file = path.join(CACHE, name);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  return path.relative(ROOT, file);
}

function pinLine(pin, ctx) {
  const target = pin.engine === ctx.version ? '' : `, made for ${pin.engine}`;
  return `${pin.pinnedAt.slice(0, 16).replace('T', ' ')} UTC (${age(pin.pinnedAt)}), ${count(pin.applicationSettings)} entries and ${count(pin.ixp)} experiment values${target}`;
}

function warnEngine(pin, ctx, log) {
  if (pin.engine === ctx.version) return false;
  log('');
  log(`The pin was made for ${pin.engine}, and the engine is ${ctx.version}. The page skips it`);
  log('and gives the engine live flags. Run npm run flags -- pin to pin flags for this build.');
  return true;
}

async function commandStatus(options, ctx, log, full) {
  const pin = readPinSafe(ctx, log);
  const live = await fetchLive();
  const table = loadTable(ctx, [live, pin && pin.applicationSettings], log);
  log('Flag Guard');
  log(`  Engine   ${ctx.version}`);
  log(`  Live     ${count(live)} entries`);
  if (!pin) {
    log('  Pin      none, so the engine gets live flags');
    log('');
    log('Run npm run flags -- pin to pin the current flags.');
    return EXIT.OK;
  }
  log(`  Pin      ${pinLine(pin, ctx)}`);
  warnEngine(pin, ctx, log);
  const changes = Flags.compareSets(table, pin, { applicationSettings: live, ixp: pin.ixp }, { overrides: ctx.overrides });
  log('');
  const groups = Report.printChanges(changes, log, { all: full || options.all });
  const report = writeReport('report.md', Report.renderChanges('Flags since the pin', [`Pin: ${pinLine(pin, ctx)}.`, `Live: ${count(live)} entries, fetched ${new Date().toISOString()}.`], changes));
  log('');
  log(`Report: ${report}`);
  if (groups.changes.length || groups.staged.length || groups.unknown.length) {
    log('To try the live flags: npm run flags -- test --set live, or open');
    log(`${LOCAL_URL}/?flagset=live in a browser. To take them: npm run flags -- pin`);
  }
  return EXIT.OK;
}

function loadNamedSet(name, ctx, log) {
  if (name === 'live') return { set: null, label: 'live', query: 'launcher=roblox&flagset=live', serve: false };
  if (name === 'pinned') return { set: requirePin(ctx, log), label: 'pinned', query: 'launcher=roblox', serve: false };
  const file = /[\\/]|\.json$/.test(name) ? path.resolve(name) : Pin.setPath(CACHE, name);
  const set = Pin.readPin(file);
  if (!set) throw new Error(`There is no flag set at ${path.relative(ROOT, file)}.`);
  return { set: { ...set, engine: ctx.version }, label: path.basename(file, '.json'), query: 'launcher=roblox', serve: true };
}

function knownWritesFile(ctx) {
  return path.join(CACHE, 'tests', `engine-writes-${ctx.version}.json`);
}

function rememberEngineWrites(ctx, result) {
  const keys = new Set(readJson(knownWritesFile(ctx), []));
  for (const item of [...result.memory.notApplied, ...result.memory.engineWrites]) keys.add(item.key);
  writeJson(knownWritesFile(ctx), [...keys].sort());
}

function requiredReport(table, ctx, verify) {
  const failed = new Set(verify.notApplied.map(item => item.key));
  const unchecked = [];
  const unread = [];
  const missing = [];
  for (const key of Object.keys(ctx.required)) {
    const resolved = Table.resolve(table, key);
    if (!resolved.reader) unread.push(key);
    else if (resolved.reader !== 'engine' || !['Flag', 'Int'].includes(resolved.engine.type)) unchecked.push(key);
    else if (failed.has(key)) missing.push(key);
  }
  return { missing, unchecked, unread };
}

async function runTest(ctx, table, set, { label, query, log, serve = true }) {
  const shot = path.join(CACHE, 'tests', `${label}.png`);
  const outcome = await Boot.boot({ base: ROOT, env: stageEnv(ctx), query, flagSet: serve ? set : null, settleSeconds: ctx.wait, readMemory: Boot.memoryRows(table), screenshot: shot, log });
  const checks = [];
  const check = (id, ok, detail, severity = 'error') => checks.push({ id, ok: Boolean(ok), detail, severity });
  const started = outcome.steps.loaded && outcome.steps.engine;
  check('boot', started, started ? 'the loader finished and the engine started' : `the engine did not start (${Object.entries(outcome.steps).filter(([, ok]) => !ok).map(([step]) => step).join(', ') || 'unknown step'})`);
  const wantedName = set ? 'pinned' : 'live';
  const usedName = outcome.flagSet && outcome.flagSet.name;
  check('flag-set', usedName === wantedName, usedName === wantedName ? `the page gave the engine the ${label} set (${outcome.flagSet.entries} entries)` : `the page used ${usedName || 'no'} flags instead of the ${label} set`);
  const verify = Boot.verifyMemory(table, outcome.flags, outcome.ixpAtBoot, outcome.memory);
  const known = new Set(readJson(knownWritesFile(ctx), []));
  const fresh = verify.notApplied.filter(item => !known.has(item.key));
  const seen = verify.notApplied.filter(item => known.has(item.key));
  const writes = [...seen, ...verify.engineWrites];
  check('memory', verify.checked >= MIN_CHECKED_FLAGS && !fresh.length, `${verify.matched} of ${verify.checked} engine flags hold the expected value${fresh.length ? `, ${fresh.length} did not take: ${fresh.slice(0, NAMED_LIMIT).map(item => item.key).join(', ')}` : ''}${writes.length ? `. The engine sets ${writes.length} itself: ${writes.slice(0, NAMED_LIMIT).map(item => item.key).join(', ')}${writes.length > NAMED_LIMIT ? ', ...' : ''}` : ''}`, 'warning');
  const required = requiredReport(table, ctx, verify);
  const notes = [];
  if (required.unchecked.length) notes.push(`${required.unchecked.join(', ')} ${required.unchecked.length === 1 ? 'is' : 'are'} read by Lua or by name, so memory cannot show ${required.unchecked.length === 1 ? 'it' : 'them'}`);
  if (required.unread.length) notes.push(`nothing in this build reads ${required.unread.join(', ')}`);
  check('required', !required.missing.length && verify.checked >= MIN_CHECKED_FLAGS, required.missing.length ? `these WebBlox overrides did not reach the engine: ${required.missing.join(', ')}` : `every WebBlox override that engine memory can show took effect${notes.length ? `. Note: ${notes.join('; ')}` : ''}`);
  check('errors', !outcome.errors.length, outcome.errors.length ? `${outcome.errors.length} page errors, first: ${outcome.errors[0].slice(0, 160)}` : 'no page errors', 'warning');
  const colors = outcome.screenshot && outcome.screenshot.colors;
  check('screen', colors >= MIN_SCREEN_COLORS, colors === null || colors === undefined ? 'no screenshot' : `${colors} colours on screen${colors < MIN_SCREEN_COLORS ? ', so it looks blank' : ''}`);
  const result = {
    label,
    at: new Date().toISOString(),
    engine: ctx.version,
    signedIn: outcome.signedIn,
    ok: checks.every(item => item.ok || item.severity !== 'error'),
    checks,
    flagSet: outcome.flagSet,
    memory: { checked: verify.checked, matched: verify.matched, staged: verify.staged, notApplied: verify.notApplied, engineWrites: verify.engineWrites },
    errors: outcome.errors.slice(0, 20),
    screenshot: outcome.screenshot && outcome.screenshot.file ? path.relative(ROOT, outcome.screenshot.file) : null,
  };
  writeJson(path.join(CACHE, 'tests', `${label}.json`), result);
  return result;
}

function printTest(result, log) {
  log('');
  log(`Test boot with the ${result.label} set${result.signedIn ? ', signed in' : ', signed out'}:`);
  for (const item of result.checks) log(`  ${item.ok ? 'pass' : item.severity === 'error' ? 'FAIL' : 'warn'}  ${item.id}: ${item.detail}`);
  if (result.screenshot) log(`  screenshot: ${result.screenshot}`);
  log(result.ok ? 'The test passed.' : 'The test failed.');
}

async function commandTest(options, ctx, log) {
  const chosen = loadNamedSet(options.set || 'pinned', ctx, log);
  const table = loadTable(ctx, [chosen.set && chosen.set.applicationSettings], log);
  const result = await runTest(ctx, table, chosen.set, { label: chosen.label, query: chosen.query, log, serve: chosen.serve });
  printTest(result, log);
  return result.ok ? EXIT.OK : EXIT.FAILED;
}

async function captureExperiments(ctx, log) {
  log('Reading the experiment values Roblox gives this account (one headless boot).');
  const capture = await Boot.boot({ base: ROOT, env: stageEnv(ctx), query: 'launcher=roblox&flagset=live', captureIxp: true, settleSeconds: 2, screenshot: false, log });
  if (capture.ixp && count(capture.ixp)) return { ixp: capture.ixp, from: 'a headless boot' };
  log(capture.signedIn ? 'The engine saved no experiment values.' : 'The server has no Roblox session, so there are no experiment values to read.');
  return null;
}

function ensureRoute(ctx, log) {
  const publicDir = path.dirname(ctx.engineDir);
  const file = path.join(publicDir, 'gen', 'routes.json');
  const routes = readJson(file, null);
  if (!routes || routes[Pin.PIN_FILE]) return;
  const run = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'prep.js'), '--public', publicDir], { encoding: 'utf8' });
  if (run.status === 0) log(`Rebuilt ${path.relative(ROOT, file)} so the static service worker serves the pin in Wisp mode.`);
  else log(`Warning: ${path.relative(ROOT, file)} does not list the pin, so Wisp mode will use live flags. Run node tools/prep.js.`);
}

function summarizeAgainst(table, before, after, ctx, log) {
  const changes = Flags.compareSets(table, before, after, { overrides: ctx.overrides });
  const groups = Report.summarize(changes);
  log(`Compared with the old pin: ${changes.length} entries changed, ${groups.changes.length} of them change what this build does.`);
  for (const change of groups.changes.slice(0, 20)) log(`  ${change.key.padEnd(56)} ${Report.valueText(change)}`);
  if (groups.changes.length > 20) log(`  ${groups.changes.length - 20} more.`);
}

async function commandPin(options, ctx, log) {
  const old = readPinSafe(ctx, log);
  const live = options.from ? readJson(path.resolve(options.from), null) : await fetchLive();
  const settings = live && live.applicationSettings ? live.applicationSettings : live;
  if (!settings || typeof settings !== 'object') throw new Error(`${options.from} holds no flags.`);
  const table = loadTable(ctx, [settings, old && old.applicationSettings], log);
  let experiments = old && count(old.ixp) ? { ixp: old.ixp, from: 'the previous pin' } : { ixp: {}, from: 'none' };
  if (!options['keep-ixp']) {
    const captured = await captureExperiments(ctx, log);
    if (captured) experiments = captured;
  }
  const candidate = Pin.makePin({ engine: ctx.version, settings, ixp: experiments.ixp, source: { channel: options.from ? path.basename(options.from) : WEB, fetchedAt: new Date().toISOString(), experiments: experiments.from } });
  Pin.writePin(Pin.setPath(CACHE, 'candidate'), candidate);
  if (count(candidate.removed)) log(`Left out ${count(candidate.removed)} staged rollouts, so their flags keep their current value: ${Object.keys(candidate.removed).slice(0, NAMED_LIMIT).join(', ')}`);
  if (!options['no-test']) {
    const result = await runTest(ctx, table, candidate, { label: 'candidate', query: 'launcher=roblox', log });
    printTest(result, log);
    if (!result.ok && !options.force) {
      log('');
      log('The pin did not change. The candidate is in .cache/flagguard/sets/candidate.json.');
      return EXIT.FAILED;
    }
  }
  const bytes = Pin.writePin(ctx.pinFile, candidate);
  ensureRoute(ctx, log);
  const tested = readJson(path.join(CACHE, 'tests', 'candidate.json'), null);
  if (tested && tested.ok && !options['no-test']) rememberEngineWrites(ctx, tested);
  log('');
  if (old) summarizeAgainst(table, old, candidate, ctx, log);
  log(`Pinned ${count(candidate.applicationSettings)} entries and ${count(candidate.ixp)} experiment values in ${path.relative(ROOT, ctx.pinFile)} (${Math.round(bytes / 1024)} KB).`);
  return EXIT.OK;
}

async function commandAccept(options, ctx, log) {
  const keys = options._.slice(1);
  if (!keys.length) throw new Error('Name the keys to accept, for example: npm run flags -- accept FFlagSomething');
  const pin = requirePin(ctx, log);
  const live = await fetchLive();
  const table = loadTable(ctx, [live, pin.applicationSettings], log);
  const changes = { settings: {} };
  for (const key of keys) {
    if (key.endsWith(Flags.STAGED)) throw new Error(`${key} is a staged rollout. Accept ${key.slice(0, -Flags.STAGED.length)} to take its final value.`);
    if (Object.prototype.hasOwnProperty.call(live, key)) changes.settings[key] = live[key];
    else if (live[key + Flags.STAGED] !== undefined) changes.settings[key] = Flags.firstField(live[key + Flags.STAGED]);
    else if (Object.prototype.hasOwnProperty.call(pin.applicationSettings, key)) changes.settings[key] = null;
    else throw new Error(`${key} is in neither the live flags nor the pin.`);
  }
  const next = Pin.withChanges(pin, changes);
  for (const [key, value] of Object.entries(changes.settings)) log(`  ${key}: ${pin.applicationSettings[key] === undefined ? 'unset' : pin.applicationSettings[key]} -> ${value === null ? 'removed' : value}`);
  if (!options['no-test']) {
    const result = await runTest(ctx, table, next, { label: 'candidate', query: 'launcher=roblox', log });
    printTest(result, log);
    if (!result.ok && !options.force) return EXIT.FAILED;
  }
  Pin.writePin(ctx.pinFile, next);
  log(`Updated ${path.relative(ROOT, ctx.pinFile)}.`);
  return EXIT.OK;
}

function sameNameKeys(table, name) {
  return Object.entries(table.keys).filter(([, entry]) => entry.name === name).map(([key]) => key);
}

async function commandExplain(options, ctx, log) {
  const key = options._[1];
  if (!key) throw new Error('Name a key, for example: npm run flags -- explain FFlagSomething');
  const pin = readPinSafe(ctx, log);
  const live = await fetchLive();
  const table = loadTable(ctx, [live, pin && pin.applicationSettings], log);
  const resolved = Table.resolve(table, key);
  log(key);
  if (resolved.scope) log(`  This key limits ${resolved.base} to ${resolved.scope === 'Staged' ? 'a staged rollout' : resolved.scope === 'IXP' ? 'an experiment' : `certain ${resolved.scope.replace('Filter', '').toLowerCase()}s`}.`);
  const target = Table.resolve(table, resolved.base);
  if (target.reader === 'engine') {
    const entry = target.engine;
    log(`  Read by the engine: ${entry.type} ${entry.name}${entry.version !== null ? `, version ${entry.version}` : ''}${entry.list ? ' (a Luau flag)' : ''} at address ${entry.address}.`);
    log(`  Compiled default: ${Flags.displayValue(entry.default)}.`);
  } else if (target.reader === 'engine-name') {
    log('  The engine looks this name up at run time, so its default is not known.');
  } else if (target.reader === 'lua') {
    log(`  Read by Lua${target.lua && target.lua.type ? `, defined with default ${Flags.displayValue(target.lua.default)}` : ', with no default in the scripts'}.`);
  } else {
    const parts = Table.splitKey(resolved.base);
    const unversioned = parts ? parts.name.replace(/\d+$/, '') : '';
    const others = parts ? [...new Set([...sameNameKeys(table, parts.name), ...sameNameKeys(table, unversioned)])] : [];
    log(`  Nothing in this build reads this key.${others.length ? ` The build reads ${others.join(', ')} instead.` : ''}`);
  }
  const sets = [['Pinned', pin], ['Live', { applicationSettings: live, ixp: pin ? pin.ixp : {} }]];
  for (const name of [MAC, PC]) {
    const snapshot = Channels.readSnapshot(CACHE, name);
    if (snapshot) sets.push([name === MAC ? 'Mac' : 'PC', { applicationSettings: snapshot.applicationSettings }]);
  }
  for (const [label, set] of sets) {
    if (!set) continue;
    const state = Flags.effective(table, set, resolved.base);
    const raw = Flags.settingsOf(set)[key];
    log(`  ${label.padEnd(7)} ${raw === undefined ? 'unset' : raw}${target.reader ? `, so the value is ${Flags.displayValue(state.value)} (${state.source})` : ''}`);
  }
  if (ctx.overrides[resolved.base] !== undefined) log(`  WebBlox overrides it with ${ctx.overrides[resolved.base]} in WebFlags.json.`);
  const records = Channels.readHistory(CACHE).filter(record => key in record.added || key in record.removed || key in record.changed);
  for (const record of records.slice(-10)) {
    const what = key in record.added ? `added as ${record.added[key]}` : key in record.removed ? `removed (was ${record.removed[key]})` : `${record.changed[key][0]} -> ${record.changed[key][1]}`;
    log(`  ${record.at.slice(0, 16).replace('T', ' ')} ${record.channel}: ${what}`);
  }
  return EXIT.OK;
}

function commandHistory(options, ctx, log) {
  const key = options._[1];
  const records = Channels.readHistory(CACHE);
  if (!records.length) {
    log('No history yet. Each status, check or pin run records what changed since the run before.');
    return EXIT.OK;
  }
  if (key) {
    const hits = records.filter(record => key in record.added || key in record.removed || key in record.changed);
    if (!hits.length) log(`${key} has not changed since the history began on ${records[0].since.slice(0, 10)}.`);
    for (const record of hits) {
      const what = key in record.added ? `added as ${record.added[key]}` : key in record.removed ? `removed (was ${record.removed[key]})` : `${record.changed[key][0]} -> ${record.changed[key][1]}`;
      log(`${record.at.slice(0, 16).replace('T', ' ')}  ${record.channel}  ${what}`);
    }
    return EXIT.OK;
  }
  for (const record of records.slice(-30)) log(`${record.at.slice(0, 16).replace('T', ' ')}  ${record.channel.padEnd(16)}  ${count(record.added)} added, ${count(record.removed)} removed, ${count(record.changed)} changed`);
  return EXIT.OK;
}

function loadBisectSet(name, ctx, log) {
  if (name === 'live') return null;
  return loadNamedSet(name, ctx, log).set;
}

function bisectInstructions(state, ctx, log) {
  if (state.result) {
    log('');
    log(`The bisect finished after ${state.history.length} tests. ${state.result.length === 1 ? 'This change causes the problem:' : 'These changes cause the problem together:'}`);
    for (const index of state.result) {
      const change = state.changes[index];
      log(`  ${change.key.padEnd(56)} ${change.value === null ? 'removed' : change.value}  (${subsystemOf(change.key)})`);
    }
    log('');
    log('To keep a change out of the pin, leave it pinned as it is. To take one: npm run flags -- accept <key>.');
    return;
  }
  const indices = Bisect.candidate(state);
  const set = Bisect.applyChanges(state.base, state.changes, indices);
  Pin.writePin(Pin.setPath(CACHE, 'bisect'), { ...set, format: Pin.FORMAT, engine: ctx.version, pinnedAt: new Date().toISOString(), source: { bisect: true } });
  log('');
  log(`Test ${state.history.length + 1}, about ${Bisect.remainingTests(state)} to go. This set has ${indices.length} of the ${state.changes.length} changes.`);
  log(`Open ${LOCAL_URL}/?flagset=bisect and check for the problem. Add &placeId=<id> to join a game.`);
  log('If the page log says it skipped the bisect set, restart node server once.');
  log('Then run npm run flags -- bisect good, bad or skip.');
}

async function commandBisect(options, ctx, log) {
  const step = options._[1] || 'status';
  if (step === 'reset') {
    fs.rmSync(BISECT_FILE, { force: true });
    fs.rmSync(Pin.setPath(CACHE, 'bisect'), { force: true });
    log('The bisect is cleared.');
    return EXIT.OK;
  }
  if (step === 'start') {
    const goodName = options.good || 'pinned';
    const badName = options.bad || 'live';
    let good = loadBisectSet(goodName, ctx, log);
    let bad = loadBisectSet(badName, ctx, log);
    const live = good === null || bad === null ? await fetchLive() : null;
    const pin = readPinSafe(ctx, log);
    if (good === null) good = { applicationSettings: live, ixp: pin ? pin.ixp : {} };
    if (bad === null) bad = { applicationSettings: live, ixp: pin ? pin.ixp : {} };
    const table = loadTable(ctx, [good.applicationSettings, bad.applicationSettings], log);
    const all = Flags.compareSets(table, good, bad, { overrides: ctx.overrides });
    const useful = options.all ? all : all.filter(change => !['dead', 'none', 'overridden'].includes(change.effect));
    const changes = useful
      .map(change => ({ key: change.key, value: change.experiment ? (Flags.ixpOf(bad)[change.key] === undefined ? null : Flags.ixpOf(bad)[change.key]) : (Flags.settingsOf(bad)[change.key] === undefined ? null : Flags.settingsOf(bad)[change.key]), ixp: Boolean(change.experiment), effect: change.effect }))
      .sort((a, b) => subsystemOf(a.key).localeCompare(subsystemOf(b.key)) || a.key.localeCompare(b.key));
    if (!changes.length) {
      log(`The ${goodName} and ${badName} sets have no changes that matter to this build${options.all ? '' : '. Add --all to bisect every changed entry'}.`);
      return EXIT.FAILED;
    }
    const base = { applicationSettings: { ...good.applicationSettings }, ixp: { ...(good.ixp || {}) } };
    const state = Bisect.startBisect({ good: goodName, bad: badName, changes, base });
    writeJson(BISECT_FILE, state);
    log(`Bisecting ${changes.length} changes between ${goodName} (good) and ${badName} (bad).`);
    bisectInstructions(state, ctx, log);
    return EXIT.OK;
  }
  const state = readJson(BISECT_FILE, null);
  if (!state) throw new Error('No bisect is running. Start one with npm run flags -- bisect start.');
  if (step === 'status') {
    log(`Bisecting ${state.changes.length} changes between ${state.good} and ${state.bad}. ${state.history.length} tests so far.`);
    bisectInstructions(state, ctx, log);
    return EXIT.OK;
  }
  if (['good', 'bad', 'skip'].includes(step)) {
    Bisect.answer(state, step);
    writeJson(BISECT_FILE, state);
    bisectInstructions(state, ctx, log);
    return EXIT.OK;
  }
  if (step === 'auto') {
    const table = loadTable(ctx, [state.base.applicationSettings], log);
    log('Using the headless boot test as the judge. A set that passes it is good.');
    const ends = [['good', []], ['bad', state.changes.map((change, index) => index)]];
    for (const [name, indices] of ends) {
      const set = { ...Bisect.applyChanges(state.base, state.changes, indices), format: Pin.FORMAT, engine: ctx.version, pinnedAt: new Date().toISOString(), source: { bisect: true } };
      const result = await runTest(ctx, table, set, { label: 'bisect', query: 'launcher=roblox', log });
      if (result.ok !== (name === 'good')) {
        log(name === 'good' ? `The ${state.good} set fails the boot test on its own, so the test cannot judge the changes.` : `The ${state.bad} set passes the boot test, so the test cannot see this problem. Use bisect good and bad by hand.`);
        return EXIT.FAILED;
      }
    }
    while (!state.result) {
      const set = { ...Bisect.applyChanges(state.base, state.changes, Bisect.candidate(state)), format: Pin.FORMAT, engine: ctx.version, pinnedAt: new Date().toISOString(), source: { bisect: true } };
      const result = await runTest(ctx, table, set, { label: 'bisect', query: 'launcher=roblox', log });
      const verdict = result.ok ? 'good' : 'bad';
      log(`  ${Bisect.candidate(state).length} changes: ${verdict}`);
      Bisect.answer(state, verdict);
      writeJson(BISECT_FILE, state);
    }
    bisectInstructions(state, ctx, log);
    return EXIT.OK;
  }
  throw new Error(`Unknown bisect step "${step}". Use start, good, bad, skip, auto, status or reset.`);
}

async function commandParity(options, ctx, log) {
  const [web, mac, pc] = await Promise.all([fetchLive(WEB), fetchLive(MAC), fetchLive(PC)]);
  const pin = readPinSafe(ctx, log);
  const table = loadTable(ctx, [web, mac, pc, pin && pin.applicationSettings], log);
  const rows = Parity.parityRows(table, { web, mac, pc }, { overrides: ctx.overrides });
  const decisions = Parity.readDecisions(DECISIONS);
  const groups = Parity.classifyRows(rows, decisions);
  const stale = Parity.staleDecisions(table, rows, decisions);
  log(`${rows.length} engine flags have one value on both Mac and PC and another on web.`);
  log(`  ${groups.open.length} undecided, ${groups.adopted.length} adopted, ${groups.kept.length} kept as web has them, ${groups.overridden.length} already overridden, ${groups.noise.length} telemetry, logging or other platforms.`);
  for (const [label, items] of Report.bySubsystem(groups.open.map(row => ({ ...row, flag: row.key })))) {
    log(`  ${label}`);
    for (const row of items) log(`    ${row.key.padEnd(56)} web ${Flags.displayValue(row.web)}, desktop ${Flags.displayValue(row.desktop)}`);
  }
  for (const line of stale) log(`  Revisit: ${line}`);
  if (pin && count(decisions.adopt)) {
    const set = Pin.withChanges(pin, { settings: Parity.adoptedSettings(decisions) }, { note: 'pin plus adopted parity flags' });
    Pin.writePin(Pin.setPath(CACHE, 'parity'), set);
    log('');
    log(`The parity set is the pin plus ${count(decisions.adopt)} adopted flags. Test it with npm run flags -- test --set parity,`);
    log(`and in game at ${LOCAL_URL}/?flagset=parity (restart node server once if the page skips it).`);
  }
  const report = writeReport('parity.md', Report.renderParity(groups, stale, [`Web, Mac and PC channels fetched ${new Date().toISOString()}.`, `Engine ${ctx.version}.`]));
  log(`Report: ${report}`);
  return EXIT.OK;
}

function commandAdopt(options, ctx, log) {
  const pairs = options._.slice(1);
  const additions = {};
  if (pairs.length) {
    for (const pair of pairs) {
      const at = pair.indexOf('=');
      if (at <= 0) throw new Error(`"${pair}" is not key=value.`);
      additions[pair.slice(0, at)] = pair.slice(at + 1);
    }
  } else {
    Object.assign(additions, Parity.adoptedSettings(Parity.readDecisions(DECISIONS)));
    if (!count(additions)) throw new Error('tools/flagguard/parity.json adopts no flags, and no key=value pairs were given.');
  }
  const profileFile = path.join(PLANS, 'profile.json');
  const profile = readJson(profileFile, null);
  if (!profile) throw new Error('Could not read tools/backport/profile.json.');
  profile.requiredFlags = { ...(profile.requiredFlags || {}), ...additions };
  fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2) + '\n');
  const flagsFile = path.join(ctx.engineDir, 'WebFlags.json');
  const data = readJson(flagsFile, { applicationSettings: {} });
  data.applicationSettings = { ...(data.applicationSettings || {}), ...additions };
  fs.writeFileSync(flagsFile, JSON.stringify(data, null, 4) + '\n');
  for (const [key, value] of Object.entries(additions)) log(`  ${key} = ${value}`);
  log(`Added ${count(additions)} overrides to tools/backport/profile.json and ${path.relative(ROOT, flagsFile)}.`);
  log('Check them with npm run flags -- test.');
  return EXIT.OK;
}

function statusLine(summary, previous) {
  if (summary.error) return previous.error ? null : `[flags] Could not check Roblox's flags: ${summary.error}`;
  if (!summary.pinEngine) return previous.noPin ? null : '[flags] There is no flag pin, so the engine gets live flags. Run npm run flags -- pin.';
  if (summary.pinEngine !== summary.engine) return previous.pinEngine === summary.pinEngine && previous.engine === summary.engine ? null : `[flags] The flag pin is for ${summary.pinEngine}, so the engine gets live flags. Run npm run flags -- pin.`;
  const key = [...summary.changes, '|', ...summary.staged, '|', ...summary.unknown].join(',');
  const before = [...(previous.changes || []), '|', ...(previous.staged || []), '|', ...(previous.unknown || [])].join(',');
  if (key === before) return null;
  if (!summary.changes.length && !summary.staged.length && !summary.unknown.length) return '[flags] The live flags match the pin for everything this build reads.';
  const names = summary.changes.slice(0, NAMED_LIMIT).join(', ');
  const parts = [];
  if (summary.changes.length) parts.push(`${summary.changes.length} flags this build reads (${names}${summary.changes.length > NAMED_LIMIT ? ', ...' : ''})`);
  if (summary.staged.length) parts.push(`${summary.staged.length} staged rollouts`);
  if (summary.unknown.length) parts.push(`${summary.unknown.length} flags with an unclear effect`);
  return `[flags] Since the pin from ${age(summary.pinnedAt)}, Roblox changed ${parts.join(', ')}. The pin keeps them as they were. Run npm run flags for details.`;
}

async function commandCheck(options, ctx) {
  const previous = readJson(STATUS_FILE, {});
  const quiet = () => {};
  const summary = { at: new Date().toISOString(), engine: ctx.version, changes: [], staged: [], unknown: [] };
  try {
    const pin = readPinSafe(ctx, quiet);
    const live = await fetchLive();
    if (!pin) summary.noPin = true;
    else {
      summary.pinEngine = pin.engine;
      summary.pinnedAt = pin.pinnedAt;
      const table = loadTable(ctx, [live, pin.applicationSettings], quiet);
      const groups = Report.summarize(Flags.compareSets(table, pin, { applicationSettings: live, ixp: pin.ixp }, { overrides: ctx.overrides }));
      summary.changes = groups.changes.map(change => change.key);
      summary.staged = groups.staged.map(change => change.key);
      summary.unknown = groups.unknown.map(change => change.key);
    }
  } catch (error) {
    summary.error = error.message;
  }
  const line = statusLine(summary, previous);
  if (line) console.log(line);
  writeJson(STATUS_FILE, summary);
  return EXIT.OK;
}

const COMMANDS = {
  status: (options, ctx, log) => commandStatus(options, ctx, log, false),
  diff: (options, ctx, log) => commandStatus(options, ctx, log, true),
  test: commandTest,
  pin: commandPin,
  accept: commandAccept,
  explain: commandExplain,
  history: commandHistory,
  bisect: commandBisect,
  parity: commandParity,
  adopt: commandAdopt,
  check: commandCheck,
};

async function main(argv) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) throw new Error(`Flag Guard needs Node ${MIN_NODE.join('.')} or newer.`);
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }
  try {
    os.setPriority(LOW_PRIORITY);
  } catch {}
  const name = options._[0] || 'status';
  const command = COMMANDS[name];
  if (!command) throw new Error(`Unknown command "${name}". Run npm run flags -- --help.`);
  const ctx = context(options);
  const log = line => console.log(line === undefined ? '' : line);
  return command(options, ctx, log);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }, error => {
    console.error(`Flag Guard: ${error.message}`);
    if (process.argv.includes('--verbose')) console.error(error.stack);
    process.exitCode = EXIT.FAILED;
  });
}

module.exports = { main, parseArgs, statusLine, runTest, context, CACHE };
