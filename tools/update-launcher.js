#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { BASE, ENGINE_DIR, ENGINE_VERSION } = require('../server/config');
const { readZipEntry } = require('./zip');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const QUIET = args.includes('--quiet');
const VERSION_URL = 'https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer';
const PACKAGE_URL = (version, name) => `https://setup.rbxcdn.com/${version}-${name}.zip`;
const MODELS = ['UniversalApp', 'InExperience'];
const CACHE = path.join(BASE, '.cache', 'launcher');
const STATE_FILE = path.join(CACHE, 'state.json');
const STAGE = path.join(CACHE, 'stage');
const PORTED_PLANS = path.join(CACHE, 'ported-plans');
const PLAN_DIR = path.join(__dirname, 'backport');
const PATCH_TOOL = path.join(__dirname, 'patch-engine.js');

const log = message => console.log(`[launcher] ${message}`);
const modelPath = (dir, name) => path.join(dir, 'ExtraContent', 'models', name, `${name}.rbxm`);
const checksumPath = (dir, name) => path.join(dir, 'ExtraContent', 'models', name, `${name}_checksum`);
const configPath = (dir, name) => path.join(dir, 'content', 'configs', `${name}PatchConfig`, `${name}PatchConfig.json`);
const release = version => String(version).split('.')[1];

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function writeAtomic(file, data) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}

function moveInto(from, to) {
  const temp = `${to}.tmp`;
  fs.copyFileSync(from, temp);
  fs.renameSync(temp, to);
}

async function portPatches(hash, incoming) {
  const { portLauncherProfile } = require('./autoport/launcher');
  const newModels = Object.fromEntries(incoming.map(({ name, model }) => [name, model]));
  const result = await portLauncherProfile({ hash, newModels, engineDir: ENGINE_DIR, planDir: PLAN_DIR, log });
  if (!result.ok) {
    log(`the patches could not be ported: ${result.reason}`);
    return null;
  }
  fs.rmSync(PORTED_PLANS, { recursive: true, force: true });
  fs.mkdirSync(PORTED_PLANS, { recursive: true });
  fs.writeFileSync(path.join(PORTED_PLANS, 'profile.json'), `${JSON.stringify(result.profile, null, 2)}\n`);
  for (const { name, model } of incoming) fs.writeFileSync(modelPath(STAGE, name), model);
  const patched = spawnSync(process.execPath, [PATCH_TOOL, '--bundle', STAGE, '--models-only', '--plans', PORTED_PLANS], { stdio: 'inherit' });
  if (patched.status !== 0) {
    log('the ported patches did not apply');
    return null;
  }
  return result.profile;
}

async function main() {
  const windows = await (await fetch(VERSION_URL)).json();
  const hash = windows.clientVersionUpload;
  if (!hash || !windows.version) throw new Error('Roblox did not report a Windows build');
  const state = readState();
  const summary = { windows: hash, engine: ENGINE_VERSION, modelsFrom: state.modelsFrom };
  if (!FORCE && state.windows === hash && state.engine === ENGINE_VERSION) {
    if (!QUIET) log(`up to date with Windows ${windows.version}`);
    return;
  }

  const engineRelease = JSON.parse(fs.readFileSync(configPath(ENGINE_DIR, MODELS[0]), 'utf8')).MaxAppVersion;
  if (!FORCE && release(windows.version) !== String(engineRelease)) {
    if (state.waiting !== hash) log(`Windows is on release ${release(windows.version)} and the engine is on ${engineRelease}, keeping the current launcher until they match`);
    writeState({ ...state, waiting: hash });
    return;
  }

  const zip = await download(PACKAGE_URL(hash, 'extracontent-models'));
  const incoming = MODELS.map(name => ({
    name,
    checksum: readZipEntry(zip, `${name}/${name}_checksum`),
    model: readZipEntry(zip, `${name}/${name}.rbxm`),
  }));
  const changed = incoming.filter(m => m.checksum.toString('utf8').trim() !== readText(checksumPath(ENGINE_DIR, m.name)));
  if (!changed.length) {
    writeState({ ...summary, modelsFrom: hash });
    if (!QUIET) log(`up to date with Windows ${windows.version}`);
    return;
  }

  fs.rmSync(STAGE, { recursive: true, force: true });
  for (const { name, model } of incoming) {
    const staged = modelPath(STAGE, name);
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    if (changed.some(m => m.name === name)) fs.writeFileSync(staged, model);
    else fs.copyFileSync(modelPath(ENGINE_DIR, name), staged);
  }
  const patched = spawnSync(process.execPath, [PATCH_TOOL, '--bundle', STAGE, '--models-only'], { stdio: 'inherit' });
  let portedProfile = null;
  if (patched.status !== 0) {
    log(`our patches no longer fit Windows ${windows.version}, so porting them`);
    try {
      portedProfile = await portPatches(hash, incoming);
    } catch (err) {
      log(`the patches could not be ported: ${err.message}`);
    }
    fs.rmSync(PORTED_PLANS, { recursive: true, force: true });
    if (!portedProfile) {
      fs.rmSync(STAGE, { recursive: true, force: true });
      writeState(summary);
      log('keeping the current launcher. Run npm run autoport -- --force for a full report');
      process.exitCode = 1;
      return;
    }
  }

  const configs = await download(PACKAGE_URL(hash, 'content-configs'));
  for (const { name, checksum } of portedProfile ? incoming : changed) {
    moveInto(modelPath(STAGE, name), modelPath(ENGINE_DIR, name));
    writeAtomic(checksumPath(ENGINE_DIR, name), checksum);
    writeAtomic(configPath(ENGINE_DIR, name), readZipEntry(configs, `${name}PatchConfig/${name}PatchConfig.json`));
  }
  fs.rmSync(STAGE, { recursive: true, force: true });
  if (portedProfile) writeAtomic(path.join(PLAN_DIR, 'profile.json'), `${JSON.stringify(portedProfile, null, 2)}\n`);
  writeState({ ...summary, modelsFrom: hash });
  log(`updated ${(portedProfile ? incoming : changed).map(m => m.name).join(' and ')} from Windows ${windows.version} (${hash})${portedProfile ? ' and ported the patch data in tools/backport/profile.json' : ''}`);
}

main().catch(err => {
  log(`update failed, keeping the current launcher: ${err.message}`);
  process.exitCode = 1;
});
