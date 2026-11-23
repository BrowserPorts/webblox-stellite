#!/usr/bin/env node
'use strict';

// Fills the engine bundle with the content files the Windows player ships and the web build leaves out: sounds, R6
// meshes, fonts, particles, sky, cursors. It reads them from the packages Roblox publishes for the Windows player, so
// no installed player is needed.
//
//   npm run import-content                    lists what would be copied
//   npm run import-content -- --apply         copies it, then run npm run prep
//   npm run import-content -- --version version-0123456789abcdef   reads that Windows build instead of the live one
//
// Only files the bundle lacks are copied. A file already there is never replaced, since several are patched. The
// native shader packs are not content and are left out.

const fs = require('fs');
const path = require('path');
const { BASE, ENGINE_DIR, GEN_DIR, ENGINE_VERSION } = require('../server/config');
const { zipEntries } = require('./zip');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const versionArg = args.indexOf('--version');
const VERSION_URL = 'https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer';
const MANIFEST_URL = version => `https://setup.rbxcdn.com/${version}-rbxPkgManifest.txt`;
const PACKAGE_URL = (version, name) => `https://setup.rbxcdn.com/${version}-${name}`;
const CACHE = path.join(BASE, '.cache', 'content-packages');
const REPORT = path.join(GEN_DIR, 'content-import.json');
const METADATA = path.join(GEN_DIR, 'WebClient.metadata.json');
const MISSING_SHOWN = 40;

// Where each Windows package unpacks inside the player's folder, which is the layout the engine bundle keeps
const PACKAGES = {
  'content-avatar.zip': 'content/avatar',
  'content-configs.zip': 'content/configs',
  'content-fonts.zip': 'content/fonts',
  'content-models.zip': 'content/models',
  'content-sky.zip': 'content/sky',
  'content-sounds.zip': 'content/sounds',
  'content-textures2.zip': 'content/textures',
  'content-textures3.zip': 'PlatformContent/pc/textures',
  'content-terrain.zip': 'PlatformContent/pc/terrain',
  'content-platform-fonts.zip': 'PlatformContent/pc/fonts',
  'content-platform-dictionaries.zip': 'PlatformContent/pc/shared_compression_dictionaries',
  'extracontent-places.zip': 'ExtraContent/places',
  'extracontent-luapackages.zip': 'ExtraContent/LuaPackages',
  'extracontent-translations.zip': 'ExtraContent/translations',
  'extracontent-textures.zip': 'ExtraContent/textures',
};
// The launcher models are patched and kept current by tools/update-launcher.js
const LEFT_OUT = ['extracontent-models.zip', 'shaders.zip'];

const log = message => console.log(`[content] ${message}`);
const megabytes = bytes => `${(bytes / 1048576).toFixed(1)} MB`;

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// The manifest is a version line, then four lines for each package: name, MD5, packed size, unpacked size
function readManifest(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const packages = new Map();
  for (let i = 1; i + 3 < lines.length; i += 4) packages.set(lines[i], { md5: lines[i + 1], packed: Number(lines[i + 2]) });
  return packages;
}

async function packageZip(version, name, md5) {
  const cached = path.join(CACHE, `${md5}-${name}`);
  if (fs.existsSync(cached)) return fs.readFileSync(cached);
  const zip = await download(PACKAGE_URL(version, name));
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cached, zip);
  return zip;
}

// Every file under a folder, by its path in lower case, since Windows names files without regard to case
function filesUnder(dir, prefix = '', out = new Map()) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) filesUnder(path.join(dir, entry.name), rel, out);
    else out.set(rel.toLowerCase(), rel);
  }
  return out;
}

async function main() {
  let version = versionArg >= 0 ? args[versionArg + 1] : '';
  if (!version) {
    const windows = await (await fetch(VERSION_URL)).json();
    version = windows.clientVersionUpload;
    log(`reading Windows ${windows.version} (${version}), the engine is ${ENGINE_VERSION}`);
  }
  if (!/^version-[0-9a-f]{16}$/.test(version || '')) throw new Error('that is not a Windows build name, which looks like version-0123456789abcdef');

  const manifest = readManifest((await download(MANIFEST_URL(version))).toString('utf8'));
  const unknown = [...manifest.keys()].filter(name => /^(extra)?content-/.test(name) && !PACKAGES[name] && !LEFT_OUT.includes(name));
  if (unknown.length) log(`packages this tool does not know, left alone: ${unknown.join(', ')}`);

  const have = filesUnder(ENGINE_DIR);
  const perPackage = [];
  let copied = 0;
  let bytes = 0;
  for (const [name, folder] of Object.entries(PACKAGES)) {
    const listed = manifest.get(name);
    if (!listed) {
      log(`${name} is not in this build`);
      continue;
    }
    const zip = await packageZip(version, name, listed.md5);
    let files = 0;
    let size = 0;
    for (const entry of zipEntries(zip)) {
      if (!entry.name || entry.name.endsWith('/')) continue;
      const rel = `${folder}/${entry.name}`;
      if (have.has(rel.toLowerCase())) continue;
      const data = entry.read();
      if (APPLY) {
        const target = path.join(ENGINE_DIR, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
      }
      have.set(rel.toLowerCase(), rel);
      files++;
      size += data.length;
    }
    if (files) perPackage.push({ package: name, folder, files, bytes: size });
    copied += files;
    bytes += size;
  }

  // What the engine's own file table names and the bundle still does not hold after the import
  let missing = [];
  try {
    const table = JSON.parse(fs.readFileSync(METADATA, 'utf8'));
    missing = table.map(entry => String(entry.path || '').replace(/^\//, '')).filter(rel => rel && !have.has(rel.toLowerCase()));
  } catch (err) {
    log(`could not read the engine's file table: ${err.message}`);
  }

  for (const row of perPackage) log(`${APPLY ? 'copied' : 'would copy'} ${row.files} files (${megabytes(row.bytes)}) into ${row.folder}`);
  log(`${APPLY ? 'copied' : 'would copy'} ${copied} files, ${megabytes(bytes)}, from ${version}`);
  if (missing.length) {
    log(`${missing.length} files the engine names are still missing:`);
    for (const rel of missing.slice(0, MISSING_SHOWN)) console.log(`  ${rel}`);
    if (missing.length > MISSING_SHOWN) console.log(`  and ${missing.length - MISSING_SHOWN} more, all listed in ${path.relative(BASE, REPORT)}`);
  } else log('every file the engine names is in the bundle');

  if (APPLY) {
    fs.writeFileSync(REPORT, `${JSON.stringify({ source: version, engine: ENGINE_VERSION, importedAt: new Date().toISOString(), files: copied, bytes, packages: perPackage, missing }, null, 2)}\n`);
    log(`wrote ${path.relative(BASE, REPORT)}. Run npm run prep so the new files are served`);
  } else if (copied) log('nothing was written. Run again with --apply to copy');
}

main().catch(err => {
  log(`import failed: ${err.message}`);
  process.exitCode = 1;
});
