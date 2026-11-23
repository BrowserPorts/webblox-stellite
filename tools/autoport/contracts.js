'use strict';

const fs = require('fs');
const os = require('os');
const vm = require('vm');
const path = require('path');
const { spawnSync } = require('child_process');
const { readPack, TYPE } = require('../shader-pack');
const { WasmModule } = require('./wasm/module');
const { MemoryImage } = require('./wasm/image');
const { readModuleScripts } = require('./luau/rbxm');

const ROOT = path.join(__dirname, '..', '..');
const JS_DIR = path.join(ROOT, 'public', 'js');
const FLAG_PREFIX = /^(?:DF|F|SF)(?:Flag|Int|Log|String)/;
const GLOBALS_STRUCT = /struct Globals\s*\{([^}]*)\}/;
const LIGHT_STRIDE_READ = /\bCB6\[\w+ \* (\d+) \+ \d+\]/g;
const STAR_SIZE = /\(CB0\[50\]\.xy \* 2\.0\)/;
const UNIFORM_BLOCK = /\bu?vec4\s+CB(\d+)\s*\[(\d+)\]/g;
const CONSTANT = name => new RegExp(`const ${name} = (\\d+);`);
const HELPER_STATE_END = 1024;
const REQUIRED_EXPORTS = ['pthread_self'];
const PATCH_IMPORTS = ['glEnable', 'glDisable', 'glPixelStorei', 'emscripten_asm_const_async_on_main_thread'];
const PATCHED_SHADERS = ['ShadowEvsmPassThroughFlippedVS', 'ShadowEvsmClearVS', 'SmoothClusterFSUnified', 'SmoothClusterVSUnified'];

function record(results, id, ok, detail, severity = 'warning') {
  results.push({ id, ok, detail, severity });
}

function readJsConstant(file, name) {
  const match = fs.readFileSync(path.join(JS_DIR, file), 'utf8').match(CONSTANT(name));
  return match ? Number(match[1]) : null;
}

function hotImports() {
  const source = fs.readFileSync(path.join(JS_DIR, 'gl-bridge.js'), 'utf8');
  const at = source.indexOf('const HOT = [');
  if (at < 0) return null;
  return [...source.slice(at, source.indexOf('];', at)).matchAll(/'([^']+)'/g)].map(match => match[1]);
}

function glCalls() {
  const scope = {};
  vm.runInNewContext(fs.readFileSync(path.join(JS_DIR, 'gl-ops.js'), 'utf8'), { self: scope, globalThis: scope, window: scope });
  return scope.__webbloxGlOps ? new Map(scope.__webbloxGlOps.CALLS) : new Map();
}

function flagText(side) {
  const scripts = Object.values(side.models || {}).flatMap(model => readModuleScripts(model).sources);
  return flag => {
    const bare = Buffer.from(flag.replace(FLAG_PREFIX, ''), 'latin1');
    return side.wasm.includes(bare) || scripts.some(source => source.includes(bare));
  };
}

function checkFlags(results, requiredFlags, oldSide, newSide, port = null) {
  const engineKeys = new Set(port ? port.engineKeys : []);
  const before = flagText(oldSide);
  const after = flagText(newSide);
  const textKeys = Object.keys(requiredFlags).filter(flag => !engineKeys.has(flag));
  const lost = [...(port ? port.lost : []), ...textKeys.filter(flag => before(flag) && !after(flag))];
  const unknown = textKeys.filter(flag => !before(flag) && !after(flag));
  const renamed = port && port.renamed.length ? ` Renamed for the new build: ${port.renamed.map(item => `${item.from} to ${item.to}`).join(', ')}.` : '';
  record(results, 'flags', !lost.length, lost.length ? `Nothing in the new build reads these WebFlags.json entries, so setting them does nothing: ${lost.join(', ')}.${renamed}` : `every WebBlox override still has a reader${unknown.length ? ` (${unknown.join(', ')} are read by nothing in either build)` : ''}.${renamed}`);
}

function checkWasm(results, oldBuffer, newBuffer, patchedBuffer) {
  const module = new WasmModule(newBuffer);
  const hot = hotImports();
  if (!hot) {
    record(results, 'gl-imports', false, 'could not read the HOT list in public/js/gl-bridge.js', 'error');
  } else {
    const absent = hot.filter(name => !module.importIndexByName.has(name));
    record(results, 'gl-imports', !absent.length, absent.length ? `The render worker records GL calls the engine no longer imports: ${absent.join(', ')}. Remove them from HOT in public/js/gl-bridge.js.` : `all ${hot.length} GL calls the render worker records are still imported`, 'error');
    const calls = glCalls();
    const wrong = [];
    for (const name of hot) {
      const index = module.importIndexByName.get(name);
      const kinds = calls.get(name[2].toLowerCase() + name.slice(3));
      if (index === undefined || kinds === undefined) continue;
      const params = module.types[module.functionImports[index].type].params.length;
      if (params !== kinds.length) wrong.push(`${name} takes ${params} values and public/js/gl-ops.js records ${kinds.length}`);
    }
    record(results, 'gl-signatures', !wrong.length, wrong.length ? wrong.join('; ') : 'argument counts match public/js/gl-ops.js', 'error');
  }
  const absentImports = PATCH_IMPORTS.filter(name => !module.importIndexByName.has(name));
  record(results, 'patch-imports', !absentImports.length, absentImports.length ? `The wasm patches call imports that are gone: ${absentImports.join(', ')}` : 'the imports the wasm patches call still exist', 'error');
  const absentExports = REQUIRED_EXPORTS.filter(name => !module.exports.has(name));
  record(results, 'exports', !absentExports.length, absentExports.length ? `The render thread helper needs exports that are gone: ${absentExports.join(', ')}` : 'the exports the render thread helper calls still exist', 'error');
  const image = new MemoryImage(module);
  record(results, 'low-memory', image.low >= HELPER_STATE_END, image.low >= HELPER_STATE_END ? `data starts at ${image.low}, so the helper state below ${HELPER_STATE_END} stays free` : `data starts at ${image.low}, inside the render thread helper state below ${HELPER_STATE_END}`, 'error');
  if (patchedBuffer) {
    record(results, 'wasm-native', WebAssembly.validate(patchedBuffer), 'V8 accepts the patched module', 'error');
    const patched = new WasmModule(patchedBuffer);
    const exported = ['wb_thread_create', 'wb_shadow_tiles', 'wb_drain_marks'].filter(name => patched.exports.has(name));
    record(results, 'helper-exports', exported.length === 0 || exported.length === 3, `${exported.length} of 3 render thread exports present`, 'error');
  }
  if (oldBuffer) {
    const oldModule = new WasmModule(oldBuffer);
    const before = new Map(oldModule.functionImports.map(entry => [entry.name, oldModule.types[entry.type].key]));
    const changed = module.functionImports.filter(entry => before.has(entry.name) && before.get(entry.name) !== module.types[entry.type].key).map(entry => entry.name);
    const added = module.functionImports.filter(entry => !before.has(entry.name)).map(entry => entry.name);
    const now = new Set(module.functionImports.map(entry => entry.name));
    const removed = [...before.keys()].filter(name => !now.has(name));
    const clean = !changed.length && !added.length && !removed.length;
    record(results, 'import-changes', clean, clean ? 'no imports were added, removed or changed' : `Imports changed. Added: ${added.join(', ') || 'none'}. Removed: ${removed.join(', ') || 'none'}. New signature: ${changed.join(', ') || 'none'}. Read public/js/gl-bridge.js if any of these are GL calls.`);
  }
}

function globalsStruct(pack) {
  for (const variant of pack.variants) {
    const match = variant.source.toString('latin1').match(GLOBALS_STRUCT);
    if (match) return match[1].replace(/\s+/g, ' ').trim();
  }
  return null;
}

function fullbrightCore() {
  const scope = {};
  vm.runInNewContext(fs.readFileSync(path.join(JS_DIR, 'fullbright.js'), 'utf8'), { self: scope, Float32Array, Math, Object, Map, Set, RegExp, URLSearchParams, location: { search: '' } });
  return scope.__webbloxFullbrightCore || null;
}

function fullbrightClasses(pack, core) {
  const classes = new Map();
  for (const variant of pack.variants) {
    if (variant.type !== TYPE.fragment) continue;
    const name = pack.shaders[variant.shader].name;
    const override = core.overrideFor('', variant.source.toString('latin1'));
    const kind = override ? `block ${override.block}` : 'none';
    if (!classes.has(name)) classes.set(name, new Set());
    classes.get(name).add(kind);
  }
  return classes;
}

function checkShaders(results, oldPackFile, newPackFile) {
  const newPack = readPack(fs.readFileSync(newPackFile));
  const names = new Set(newPack.shaders.map(shader => shader.name));
  const absent = PATCHED_SHADERS.filter(name => !names.has(name));
  record(results, 'patched-shaders', !absent.length, absent.length ? `The shader pack lost shaders tools/port-shaders.js edits by name: ${absent.join(', ')}` : 'the shaders tools/port-shaders.js edits by name still exist');

  const sources = newPack.variants.map(variant => variant.source.toString('latin1'));
  const strides = new Map();
  for (const source of sources) {
    for (const match of source.matchAll(LIGHT_STRIDE_READ)) strides.set(match[1], (strides.get(match[1]) || 0) + 1);
  }
  const stride = readJsConstant('light-grid.js', 'LIGHT_STRIDE');
  const strideOk = strides.has(String(stride));
  record(results, 'light-stride', strideOk, strideOk ? `light entries are still ${stride} rows` : `Shaders read CB6 in steps of ${[...strides.keys()].join(', ') || 'nothing'}, and LIGHT_STRIDE in public/js/light-grid.js is ${stride}`, 'error');

  const froxel = readJsConstant('light-grid.js', 'FROXEL_ROW');
  const froxelOk = sources.some(source => source.includes(`CB0[${froxel}]`) && source.includes(`CB0[${froxel + 3}]`));
  record(results, 'froxel-row', froxelOk, froxelOk ? `the froxel transform is still at row ${froxel}` : `No shader reads a froxel transform at row ${froxel}. Check FROXEL_ROW in public/js/light-grid.js.`, 'error');

  const starOk = sources.some(source => STAR_SIZE.test(source));
  record(results, 'star-size', starOk, starOk ? 'the star size rewrite in public/js/gl-webgpu.js still has a target' : 'No shader has the star size expression public/js/gl-webgpu.js rewrites, so stars may look too big.');

  if (!oldPackFile || !fs.existsSync(oldPackFile)) return;
  const oldPack = readPack(fs.readFileSync(oldPackFile));
  const oldStruct = globalsStruct(oldPack);
  const newStruct = globalsStruct(newPack);
  const same = oldStruct !== null && oldStruct === newStruct;
  record(results, 'globals-struct', same, same ? 'the frame constant layout is unchanged' : `The frame constant struct changed, so the CB0 rows in public/js/fullbright.js and public/js/light-grid.js need checking. Before: ${oldStruct}. Now: ${newStruct}`, 'error');

  const core = fullbrightCore();
  if (!core) return record(results, 'fullbright-classes', false, 'could not load public/js/fullbright.js');
  const before = fullbrightClasses(oldPack, core);
  const after = fullbrightClasses(newPack, core);
  const moved = [];
  for (const [name, kinds] of after) {
    const old = before.get(name);
    if (old && [...old].sort().join() !== [...kinds].sort().join()) moved.push(`${name} went from ${[...old].join('/')} to ${[...kinds].join('/')}`);
  }
  record(results, 'fullbright-classes', !moved.length, moved.length ? `Fullbright treats ${moved.length} shader(s) differently: ${moved.slice(0, 6).join('; ')}` : 'fullbright treats every shared shader the same way');

  const blockSizes = pack => {
    const sizes = new Map();
    for (const variant of pack.variants) {
      for (const match of variant.source.toString('latin1').matchAll(UNIFORM_BLOCK)) {
        const block = Number(match[1]);
        sizes.set(block, Math.max(sizes.get(block) || 0, Number(match[2])));
      }
    }
    return sizes;
  };
  const oldBlocks = blockSizes(oldPack);
  const newBlocks = blockSizes(newPack);
  const resized = [...newBlocks].filter(([block, size]) => oldBlocks.has(block) && oldBlocks.get(block) !== size).map(([block, size]) => `CB${block} went from ${oldBlocks.get(block)} to ${size} rows`);
  record(results, 'uniform-blocks', !resized.length, resized.length ? `Uniform blocks changed size: ${resized.join('; ')}. Check ENGINE_BLOCK_VEC4 in tools/port-shaders.js and MAX_LIGHTS in public/js/light-grid.js.` : 'uniform blocks keep their sizes', 'error');

  const oldPorted = oldPack.variants.length;
  const newPorted = newPack.variants.length;
  const shrunk = newPorted < oldPorted * 0.8;
  record(results, 'shader-count', !shrunk, `${oldPorted} variants before, ${newPorted} now`);
}

function checkJavaScript(results, file) {
  const name = path.basename(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webblox-syntax-'));
  try {
    const attempts = ['cjs', 'mjs'].map(extension => {
      const copy = path.join(dir, `copy.${extension}`);
      fs.copyFileSync(file, copy);
      return spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8', maxBuffer: 1 << 26 });
    });
    const parsed = attempts.some(attempt => attempt.status === 0);
    const error = parsed ? '' : attempts[0].stderr.split('\n').filter(line => /Error/.test(line))[0] || 'a syntax error';
    record(results, `syntax-${name}`, parsed, parsed ? `${name} parses after patching` : `${name} no longer parses: ${error}`, 'error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function checkToolchain(results, file) {
  const run = spawnSync('wasm-tools', ['validate', '--features', 'all', file], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (run.error && run.error.code === 'ENOENT') return record(results, 'wasm-tools', true, 'wasm-tools is not installed, so V8 was the only validator');
  record(results, 'wasm-tools', run.status === 0, run.status === 0 ? 'wasm-tools accepts the patched module' : `wasm-tools rejected the patched module: ${run.stderr.slice(0, 500)}`, 'error');
}

module.exports = { checkWasm, checkFlags, checkShaders, checkJavaScript, checkToolchain, record };
