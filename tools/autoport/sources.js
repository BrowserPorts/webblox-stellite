'use strict';

const fs = require('fs');
const path = require('path');
const { readZipEntry } = require('../zip');
const { recover, sha } = require('./delta');

const ROOT = path.join(__dirname, '..', '..');
const BUILDS = path.join(ROOT, '.cache', 'engine-builds');
const SETTINGS = 'https://clientsettingscdn.roblox.com/v2/client-version';
const CORE_FILES = ['/WasmPlayer.js', '/WebClient.js', '/WebClient.wasm', '/WebClient.metadata.json', '/audio-processor-fast.js', '/shaders/shaders_glsles3_web.pack'];
const CONCURRENCY = 16;
const ATTEMPTS = 4;
const RETRY_DELAY_MS = 800;
const MODELS = ['UniversalApp', 'InExperience'];
const EXTRA_MODELS = ['CrossExpVoiceDataModelPatch', 'Licenses'];

const bundleUrl = version => `https://setup.rbxcdn.com/webclient/${version}-RobloxWebClient`;
const windowsUrl = (hash, name) => `https://setup.rbxcdn.com/${hash}-${name}.zip`;
const release = version => String(version || '').split('.')[1] || '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function download(url) {
  let lastError;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await sleep(RETRY_DELAY_MS * attempt);
    try {
      const res = await fetch(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      lastError = new Error(`${url} answered ${res.status}`);
      lastError.status = res.status;
      if (res.status < 500 && res.status !== 429) throw lastError;
    } catch (error) {
      lastError = error;
      if (error.status && error.status < 500 && error.status !== 429) throw error;
    }
  }
  throw lastError;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}

async function latest() {
  const read = async name => JSON.parse((await download(`${SETTINGS}/${name}`)).toString('utf8'));
  const [web, windows] = await Promise.all([read('WebClientApp'), read('WindowsPlayer')]);
  return {
    web: { hash: web.clientVersionUpload, version: web.version },
    windows: { hash: windows.clientVersionUpload, version: windows.version },
  };
}

function localPath(dir, file) {
  return path.join(dir, ...file.replace(/^\//, '').split('/'));
}

async function fetchBundle(version, dir, log) {
  const metadataFile = localPath(dir, '/WebClient.metadata.json');
  if (!fs.existsSync(metadataFile)) writeAtomic(metadataFile, await download(`${bundleUrl(version)}/WebClient.metadata.json`));
  const listed = JSON.parse(fs.readFileSync(metadataFile, 'utf8')).map(entry => entry.path);
  const list = [...new Set([...listed, ...CORE_FILES])].sort();
  const queue = list.filter(file => !fs.existsSync(localPath(dir, file)));
  if (!queue.length) return { files: list.length, failed: [] };
  log(`Downloading ${queue.length} of ${list.length} files of ${version}`);
  const failed = [];
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const file = queue.shift();
      try {
        writeAtomic(localPath(dir, file), await download(bundleUrl(version) + file.split('/').map(encodeURIComponent).join('/')));
      } catch (error) {
        failed.push({ file, reason: error.message });
      }
      if (++done % 500 === 0) log(`  ${done} files`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const missingCore = failed.filter(entry => CORE_FILES.includes(entry.file));
  if (missingCore.length) throw new Error(`could not download ${missingCore[0].file}: ${missingCore[0].reason}`);
  return { files: list.length, failed };
}

async function ensureBundle(version, log) {
  const dir = path.join(BUILDS, version);
  const result = await fetchBundle(version, dir, log);
  return { dir, ...result };
}

async function ensureOldWasm(version, expected, { recoveryFile, patchedFile, log }) {
  const dir = path.join(BUILDS, version);
  const file = path.join(dir, 'WebClient.wasm');
  const tried = [];
  if (fs.existsSync(file)) {
    const data = fs.readFileSync(file);
    if (sha(data) === expected) return { data, dir, source: 'the local build cache' };
    tried.push(`${path.relative(ROOT, file)} has a different hash`);
  }
  if (fs.existsSync(recoveryFile) && fs.existsSync(patchedFile)) {
    try {
      const data = recover(recoveryFile, fs.readFileSync(patchedFile));
      if (sha(data) === expected) {
        writeAtomic(file, data);
        log('Rebuilt the old pristine engine from the recovery file');
        return { data, dir, source: 'the recovery file' };
      }
      tried.push('the recovery file produced a different build');
    } catch (error) {
      tried.push(error.message);
    }
  }
  try {
    const data = await download(`${bundleUrl(version)}/WebClient.wasm`);
    if (sha(data) === expected) {
      writeAtomic(file, data);
      return { data, dir, source: 'the Roblox CDN' };
    }
    tried.push('the CDN copy has a different hash');
  } catch (error) {
    tried.push(error.message);
  }
  throw new Error(`no copy of the old pristine engine ${version} (sha ${expected.slice(0, 12)}). Tried: ${tried.join('; ')}`);
}

async function ensureWindowsPackage(hash, name, log) {
  const file = path.join(BUILDS, 'windows', hash, `${name}.zip`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  log(`Downloading ${name} of Windows ${hash}`);
  const data = await download(windowsUrl(hash, name));
  writeAtomic(file, data);
  return data;
}

async function windowsModels(hash, log) {
  const models = await ensureWindowsPackage(hash, 'extracontent-models', log);
  const configs = await ensureWindowsPackage(hash, 'content-configs', log);
  const read = (zip, entry) => {
    try {
      return readZipEntry(zip, entry);
    } catch {
      return null;
    }
  };
  const entries = {};
  const files = [];
  for (const name of MODELS) {
    entries[name] = read(models, `${name}/${name}.rbxm`);
    if (!entries[name]) throw new Error(`Windows ${hash} has no ${name} model`);
    files.push({ rel: ['ExtraContent', 'models', name, `${name}.rbxm`], data: entries[name] });
    const checksum = read(models, `${name}/${name}_checksum`);
    if (checksum) files.push({ rel: ['ExtraContent', 'models', name, `${name}_checksum`], data: checksum });
    const config = read(configs, `${name}PatchConfig/${name}PatchConfig.json`);
    if (config) files.push({ rel: ['content', 'configs', `${name}PatchConfig`, `${name}PatchConfig.json`], data: config });
  }
  for (const name of EXTRA_MODELS) {
    const data = read(models, `${name}/${name}.rbxm`);
    if (data) files.push({ rel: ['ExtraContent', 'models', name, `${name}.rbxm`], data });
  }
  return { models: entries, files };
}

function modelsBelongTo(zipChecksum, engineDir, name) {
  const file = path.join(engineDir, 'ExtraContent', 'models', name, `${name}_checksum`);
  try {
    return fs.readFileSync(file, 'utf8').trim() === zipChecksum.toString('utf8').trim();
  } catch {
    return false;
  }
}

async function currentWindows(profile, engineDir, log) {
  const candidates = [profile.windows];
  try {
    const state = JSON.parse(fs.readFileSync(path.join(ROOT, '.cache', 'launcher', 'state.json'), 'utf8'));
    for (const hash of [state.modelsFrom, state.windows]) if (hash && !candidates.includes(hash)) candidates.push(hash);
  } catch {}
  for (const hash of candidates) {
    const { files } = await windowsModels(hash, log);
    const checksums = files.filter(entry => entry.rel[entry.rel.length - 1].endsWith('_checksum'));
    const allMatch = checksums.every(entry => modelsBelongTo(entry.data, engineDir, entry.rel[2]));
    if (checksums.length && allMatch) return hash;
  }
  throw new Error(`the models in public/engine do not come from Windows ${candidates.join(' or ')}`);
}

module.exports = { latest, ensureBundle, ensureOldWasm, windowsModels, currentWindows, release, download, writeAtomic, MODELS, BUILDS, CORE_FILES };
