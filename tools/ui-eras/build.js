#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { encodeForRoblox, COMPILE_FLAGS } = require('../luau-bytecode');
const { BASE, ENGINE_DIR } = require('../../server/config');

const era = process.argv[2];
if (!era) {
  console.error('usage: node tools/ui-eras/build.js <era>');
  process.exit(1);
}

const ROOT = __dirname;
const ERA_DIR = path.join(ROOT, era);
const ASSET_DIR = path.join(ERA_DIR, 'assets');
const config = require(path.join(ERA_DIR, 'era.js'));
const ASSET_ROOT = path.join(ENGINE_DIR, 'content');
const ERA_PREFIX = `eras/${era}/`;
const TRACKER_REPO = 'https://github.com/MaximumADHD/Roblox-Client-Tracker.git';
const WORK_DIR = path.join(BASE, '.cache', 'ui-eras');
const TRACKER_DIR = path.join(WORK_DIR, 'tracker');
const SKIPPED = /(\.spec\.luau?$|\/__tests__\/|\/TestUtil|\/Tests?\/|\.story\.luau?$|\.storybook\.luau?$|\/jest\.config)/;
const PACKAGE_DROP = config.dropPackages || [];

function run(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, maxBuffer: 1 << 30, ...options });
}

function trackerSource() {
  const target = path.join(WORK_DIR, 'src', era);
  const stamp = path.join(target, '.commit');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === config.tracker) return target;
  if (!fs.existsSync(path.join(TRACKER_DIR, '.git'))) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    run(WORK_DIR, ['clone', '--filter=blob:none', '--no-checkout', TRACKER_REPO, TRACKER_DIR]);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const archive = path.join(WORK_DIR, `${era}.tar`);
  const hasPackages = run(TRACKER_DIR, ['ls-tree', '--name-only', config.tracker, 'LuaPackages']).length > 0;
  const trees = hasPackages ? ['scripts/CoreScripts', 'LuaPackages'] : ['scripts/CoreScripts'];
  run(TRACKER_DIR, ['archive', '--format=tar', `--output=${archive}`, config.tracker, ...trees]);
  execFileSync('tar', ['-xf', archive, '-C', target]);
  fs.rmSync(archive, { force: true });
  fs.writeFileSync(stamp, config.tracker);
  return target;
}

function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.name.endsWith('.lua') || entry.name.endsWith('.luau')) found.push(full);
  }
  return found;
}

function sources() {
  if (!config.tracker) {
    const root = path.join(ERA_DIR, 'src');
    return walk(root).map(file => ({ file, relative: path.relative(root, file).split(path.sep).join('/'), group: 'scripts' }));
  }
  const root = trackerSource();
  const scripts = path.join(root, 'scripts', 'CoreScripts');
  const packages = path.join(root, 'LuaPackages');
  const list = walk(scripts).map(file => ({ file, relative: path.relative(scripts, file).split(path.sep).join('/'), group: 'scripts' }));
  if (fs.existsSync(packages)) {
    for (const file of walk(packages)) {
      const inner = path.relative(packages, file).split(path.sep).join('/');
      if (PACKAGE_DROP.some(name => inner === name || inner.startsWith(`${name}/`) || inner.startsWith(`${name}.`))) continue;
      list.push({ file, relative: `Packages/${inner}`, group: 'packages' });
    }
  }
  return list.filter(item => !SKIPPED.test(`/${item.relative}`) && !/^(ServerCoreScripts|Server|ServerStarterScript|LoadingScript)/.test(item.relative));
}

const literalAssets = new Map();

function rewriteAssets(text) {
  if (config.tracker) {
    return text.replace(/rbxasset:\/\/textures\/([A-Za-z0-9_/@. -]+\.[a-z]{3,4})/g, (match, rest) => {
      const copy = literalAssets.get(rest);
      return copy ? `rbxasset://textures/${ERA_PREFIX}${rest}` : match;
    });
  }
  return text.replace(/rbxasset:\/\/(textures|sounds)\//g, `rbxasset://$1/${ERA_PREFIX}`);
}

function transform({ relative, group }, source) {
  let out = source.replace(/^--rbxsig.*\n/, '').replace(/^--rbxassetid.*\n/, '');
  for (const patch of config.patches || []) {
    if (patch.file !== relative) continue;
    if (!out.includes(patch.from)) throw new Error(`patch target missing in ${relative}: ${patch.from.slice(0, 60)}`);
    out = out.split(patch.from).join(patch.to);
  }
  if (group === 'scripts') {
    out = out
      .replace(/\.Modules\b/g, '.EraModules')
      .replace(/(["'])Modules\1/g, '$1EraModules$1');
  }
  out = out
    .replace(/game\s*:\s*GetService\(\s*(["'])CorePackages\1\s*\)/g, '__eraCorePackages')
    .replace(/game\.CorePackages\b/g, '__eraCorePackages')
    .replace(/game\s*:\s*GetFastFlag\(/g, '__eraFastFlag(')
    .replace(/game\s*:\s*DefineFastFlag\(/g, '__eraDefineFlag(')
    .replace(/[A-Za-z_][\w.]*(?:\s*:\s*GetService\([^)]*\))?\s*:\s*AddCoreScriptLocal\(/g, '__eraAddCore(')
    .replace(/([A-Za-z_][\w.]*):SetVerb\(/g, '__eraVerb($1, ');
  return rewriteAssets(out);
}

function moduleKey(relative) {
  const stripped = relative.replace(/\.luau?$/, '');
  return stripped.endsWith('/init') ? stripped.slice(0, -5) : stripped;
}

function luaString(text) {
  return JSON.stringify(text);
}

function bundle() {
  const seen = new Map();
  for (const item of sources()) {
    const text = fs.readFileSync(item.file, 'utf8');
    seen.set(moduleKey(item.relative), transform(item, text));
  }
  const entries = [...seen.entries()];
  const body = entries.map(([key, source]) => `[${luaString(key)}] = function(...)\n${source}\nend,`).join('\n');
  const flags = Object.entries(config.flags || {}).map(([name, value]) => `[${luaString(name)}] = ${value},`).join('\n');
  const runtime = fs.readFileSync(path.join(ROOT, 'runtime.luau'), 'utf8');
  return {
    count: entries.length,
    text: runtime
      .replace('__ERA_NAME__', era)
      .replace('__ERA_ENTRY__', config.entry || 'StarterScript')
      .replace('__ERA_DEFAULT_FLAG__', String(Boolean(config.defaultFlag)))
      .replace('__ERA_FLAGS__', () => `{\n${flags}\n}`)
      .replace('__ERA_SOURCES__', () => `{\n${body}\n}`),
  };
}

function compile(source) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-era-'));
  const file = path.join(scratch, 'era.luau');
  fs.writeFileSync(file, source);
  try {
    return execFileSync('luau-compile', ['--binary', '-O1', '-g1', `--fflags=${COMPILE_FLAGS.join(',')}`, file], { maxBuffer: 2 ** 31 });
  } catch (err) {
    throw new Error(String(err.stderr || err.message).slice(0, 2000));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function copyAssets() {
  if (!fs.existsSync(ASSET_DIR)) return 0;
  let count = 0;
  const copy = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) copy(source, target);
      else {
        fs.mkdirSync(to, { recursive: true });
        fs.copyFileSync(source, target);
        fs.chmodSync(target, 0o644);
        count++;
      }
    }
  };
  for (const group of ['textures', 'sounds']) {
    const from = path.join(ASSET_DIR, group);
    if (fs.existsSync(from)) copy(from, path.join(ASSET_ROOT, group, 'eras', era));
  }
  return count;
}

function indexAssets() {
  const root = path.join(ASSET_DIR, 'textures');
  if (!fs.existsSync(root)) return;
  const scan = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else literalAssets.set(path.relative(root, full).split(path.sep).join('/'), true);
    }
  };
  scan(root);
}

indexAssets();
const { text, count } = bundle();
const compiled = compile(text);
const encoded = encodeForRoblox(compiled);
fs.writeFileSync(path.join(ERA_DIR, 'StarterScript.bytecode'), encoded);
const assets = copyAssets();
console.log(`${era}: ${count} modules, ${(text.length / 1048576).toFixed(1)}MB source, ${(encoded.length / 1048576).toFixed(1)}MB bytecode, ${assets} assets`);
