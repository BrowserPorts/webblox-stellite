#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { ENGINE_VERSION: CURRENT_VERSION, BASE } = require('../server/config');
const { readZipEntry } = require('./zip');
const { readPack, writePack, gate, variantId, namesToMask, TYPE } = require('./shader-pack');
const { patch } = require('./spirv-patch');

const CONVERTER_VERSION = 10;
const REPLACED_FAMILIES = new Set(['SmoothClusterFSUnified', 'SmoothClusterVSUnified']);
const args = process.argv.slice(2);
const argValue = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const CHECK = args.includes('--check');
const FORCE = args.includes('--force');
const SKIP_SHQ = args.includes('--skip-shq');
const PUBLIC_DIR = path.resolve(argValue('--public') || path.join(BASE, 'public'));
const ENGINE_VERSION = argValue('--engine-version') || CURRENT_VERSION;
const STAGED = Boolean(argValue('--public'));
const WEB_PACK = path.join(PUBLIC_DIR, 'engine', 'shaders', 'shaders_glsles3_web.pack');
const CACHE = path.join(BASE, '.cache', 'shader-port');
const GLSL_CACHE = path.join(CACHE, `glsl-v${CONVERTER_VERSION}`);
const SETTINGS = 'https://clientsettingscdn.roblox.com/v2/client-version';
const MAX_TEXTURE_UNIT = 15;
const MAX_UNIFORM_BLOCK_VEC4 = 512;
const ENGINE_BLOCK_VEC4 = { 6: 1020, 7: 84, 8: 1008 };
const SPIRV_MAGIC = Buffer.from([0x03, 0x02, 0x23, 0x07]);
const SAMPLER = /^uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?[iu]?sampler\w+\s+(Texture(\d+)Texture)\s*;/gm;
const UNIFORM_ARRAY = /^uniform\s+(?:highp\s+)?(u?vec4)\s+(CB(\d+))\s*\[(\d+)\]\s*;/gm;
const CLIP_TO_SCREEN = /\bvec2\(0\.5, -0\.5\)/g;

function run(cmd, cmdArgs, input) {
  return new Promise(resolve => {
    const child = execFile(cmd, cmdArgs, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function hasTool(name) {
  const r = await run(name, ['--version']);
  return r.ok || r.code !== 'ENOENT';
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

function release(version) {
  return String(version || '').split('.').slice(0, 2).join('.');
}

async function vulkanPack() {
  const given = argValue('--vulkan');
  if (given) return { pack: readPack(fs.readFileSync(path.resolve(given))), source: given };
  const pinned = argValue('--windows');
  const web = pinned ? {} : await getJson(`${SETTINGS}/WebClientApp`);
  const windows = pinned ? { clientVersionUpload: pinned, version: null } : await getJson(`${SETTINGS}/WindowsPlayer`);
  if (web.clientVersionUpload !== ENGINE_VERSION && !FORCE && !pinned) {
    throw new Error(`the web client moved on to ${web.clientVersionUpload}; pass --windows <version-hash> of a Windows build from the same release, or --force`);
  }
  if (windows.version && release(windows.version) !== release(web.version) && !FORCE) {
    throw new Error(`Windows ${windows.version} and web ${web.version} are different releases; pass --windows <version-hash> or --force`);
  }
  fs.mkdirSync(CACHE, { recursive: true });
  const zipFile = path.join(CACHE, `${windows.clientVersionUpload}-shaders.zip`);
  if (!fs.existsSync(zipFile)) {
    const url = `https://setup.rbxcdn.com/${windows.clientVersionUpload}-shaders.zip`;
    console.log(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    fs.writeFileSync(zipFile, Buffer.from(await res.arrayBuffer()));
  }
  const zip = fs.readFileSync(zipFile);
  const pack = readPack(readZipEntry(zip, 'shaders_vulkan_desktop.pack'));
  const names = textureNames(readPack(readZipEntry(zip, 'shaders_d3d11.pack')));
  return { pack, names, source: `Windows ${windows.version || windows.clientVersionUpload} (${windows.clientVersionUpload})` };
}

function rdefTextures(blob) {
  const dxbc = blob.indexOf('DXBC');
  if (dxbc < 0) return null;
  const chunks = blob.readUInt32LE(dxbc + 28);
  for (let i = 0; i < chunks; i++) {
    const at = dxbc + blob.readUInt32LE(dxbc + 32 + i * 4);
    if (blob.toString('latin1', at, at + 4) !== 'RDEF') continue;
    const data = at + 8;
    const count = blob.readUInt32LE(data + 8);
    const table = data + blob.readUInt32LE(data + 12);
    const units = new Map();
    for (let k = 0; k < count; k++) {
      const e = table + k * 32;
      if (blob.readUInt32LE(e + 4) !== 2) continue;
      const nameAt = data + blob.readUInt32LE(e);
      const name = blob.toString('latin1', nameAt, blob.indexOf(0, nameAt));
      const unit = blob.readUInt32LE(e + 20);
      const span = blob.readUInt32LE(e + 24);
      if (span === 1 && /^\w+Texture$/.test(name)) units.set(unit, name);
    }
    return units;
  }
  return null;
}

function textureNames(d3d) {
  const names = new Map();
  for (const v of d3d.variants) {
    const key = `${d3d.shaders[v.shader].name}|${v.type}|${v.key}`;
    if (names.has(key)) continue;
    const units = rdefTextures(v.source);
    if (units && units.size) names.set(key, units);
  }
  return names;
}

function nameSamplers(glsl, units) {
  if (!units) return glsl;
  const taken = new Set();
  const rename = new Map();
  for (const [, generic, unit] of glsl.matchAll(SAMPLER)) {
    const real = units.get(Number(unit));
    if (real && !taken.has(real) && !new RegExp(`\\b${real}\\b`).test(glsl)) {
      taken.add(real);
      rename.set(generic, real);
    }
  }
  return rename.size ? glsl.replace(/\bTexture\d+Texture\b/g, t => rename.get(t) || t) : glsl;
}

function finishGlsl(glsl, stage) {
  if (/\bbuffer\s+\w+\s*\{/.test(glsl)) throw new Error('uses storage buffers, which WebGL 2 does not have');
  if (/^#extension/m.test(glsl)) throw new Error('needs a GLSL extension');
  if (/layout\s*\([^)]*binding/.test(glsl)) throw new Error('uses explicit bindings');
  let out = glsl
    .replace(/^precision mediump float;$/m, 'precision highp float;')
    .replace(UNIFORM_ARRAY, (all, type, name, binding, size) => {
      if (type !== 'vec4') throw new Error('integer uniform arrays are not bound by the engine');
      return `uniform vec4 ${name}[${Math.min(Number(size), ENGINE_BLOCK_VEC4[binding] || MAX_UNIFORM_BLOCK_VEC4)}];`;
    });
  if (stage === 'frag' && !/^precision highp float;$/m.test(out)) out = out.replace(/^#version 300 es\n/, '#version 300 es\nprecision highp float;\n');
  const samplers = [...out.matchAll(SAMPLER)];
  for (const [, , unit] of samplers) if (Number(unit) > MAX_TEXTURE_UNIT) throw new Error(`texture unit ${unit} is above the WebGL limit`);
  const metadata = samplers.map(([, name, unit]) => `//$$${name}=s${unit}`).join('\n');
  return out.replace(/\s*$/, '\n') + (metadata ? metadata + '\n' : '');
}

function normalDecode(glsl) {
  const derived = new Set();
  const assigns = [...glsl.matchAll(/^\s*(?:highp\s+|mediump\s+)?(?:vec4\s+)?(\w+)\s*=\s*([^;]*);/gm)];
  const touches = rhs => /\bNormal\w*Texture\b/.test(rhs) || [...rhs.matchAll(/\b_\d+\b/g)].some(m => derived.has(m[0]));
  for (let grew = true; grew;) {
    grew = false;
    for (const [, name, rhs] of assigns) if (!derived.has(name) && touches(rhs)) { derived.add(name); grew = true; }
  }
  let used = false;
  let out = glsl.replace(/\b(_\d+)\.wy\b/g, (all, name) => {
    if (!derived.has(name)) return all;
    used = true;
    return `rbxNormalXY(${name})`;
  });
  for (let at = out.indexOf(').wy'); at >= 0; at = out.indexOf(').wy', at + 1)) {
    let depth = 0;
    let open = at;
    for (; open >= 0; open--) {
      if (out[open] === ')') depth++;
      else if (out[open] === '(' && --depth === 0) break;
    }
    let start = open;
    while (start > 0 && /\w/.test(out[start - 1])) start--;
    const expr = out.slice(start, at + 1);
    if (!touches(expr)) continue;
    used = true;
    out = out.slice(0, start) + `rbxNormalXY(${expr})` + out.slice(at + 4);
    at = start;
  }
  if (!used) return glsl;
  return addHelper(out, 'highp vec2 rbxNormalXY(highp vec4 n)\n{\n    return vec2(n.x * n.w, n.y);\n}');
}

function addHelper(glsl, helper) {
  if (glsl.includes(helper.split('\n')[0])) return glsl;
  return glsl.replace(/^void main\(\)/m, `${helper}\n\nvoid main()`);
}

function webOrigin(name, glsl) {
  if (name === 'ShadowEvsmPassThroughFlippedVS') return glsl.replace(/\bCB1\[11\]\.y - /, '1.0 - ');
  if (name === 'ShadowEvsmClearVS') return glsl.replace('vec2(2.0, -2.0)', 'vec2(2.0)').replace('vec2(-1.0, 1.0)', 'vec2(-1.0)');
  return glsl;
}

function screenRowOrder(glsl) {
  return glsl.replace(CLIP_TO_SCREEN, 'vec2(0.5)');
}

function signedIndices(glsl) {
  let out = '';
  let at = 0;
  for (const m of glsl.matchAll(/\bCB\d+\[/g)) {
    const open = m.index + m[0].length;
    if (open <= at) continue;
    let depth = 1;
    let close = open;
    while (close < glsl.length && depth) {
      if (glsl[close] === '[') depth++;
      else if (glsl[close] === ']') depth--;
      close++;
    }
    const inner = glsl.slice(open, close - 1);
    const scaled = inner.match(/^(\(.*\)) \* (\d+) \+ (\d+)$/);
    if (!scaled || !/\du\b|\buint\(/.test(scaled[1])) continue;
    out += glsl.slice(at, open) + `int${scaled[1]} * ${scaled[2]} + ${scaled[3]}`;
    at = close - 1;
  }
  return at ? out + glsl.slice(at) : glsl;
}

function engineView(glsl) {
  return glsl.replace(/^uniform vec4 CB(\d+)\s*\[(\d+)\];/gm, 'layout(std140) uniform block_CB$1 { vec4 CB$1[$2]; };');
}

async function convert(blob, tools) {
  const start = blob.indexOf(SPIRV_MAGIC);
  if (start < 0 || start % 4) throw new Error('no SPIR-V module in the blob');
  const spirv = blob.subarray(start);
  const id = crypto.createHash('sha1').update(spirv).digest('hex');
  const cached = path.join(GLSL_CACHE, `${id}.glsl`);
  if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  const patched = patch(spirv);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webblox-shader-'));
  try {
    const spv = path.join(tmp, 'in.spv');
    fs.writeFileSync(spv, patched.spirv);
    if (tools.spirvVal) {
      const v = await run('spirv-val', [spv]);
      if (!v.ok) throw new Error(`patched SPIR-V is invalid: ${(v.stderr || v.stdout).trim().split('\n')[0]}`);
    }
    const crossArgs = [spv, '--es', '--version', '300', '--flatten-ubo', '--no-support-nonzero-baseinstance', '--no-420pack-extension'];
    if (patched.stage === 'vert') crossArgs.push('--flip-vert-y');
    const c = await run('spirv-cross', crossArgs);
    if (!c.ok) throw new Error(`spirv-cross failed: ${c.stderr.trim().split('\n')[0]}`);
    const glsl = finishGlsl(c.stdout, patched.stage);
    if (tools.glslang) {
      const file = path.join(tmp, `out.${patched.stage}`);
      fs.writeFileSync(file, engineView(glsl));
      const g = await run('glslangValidator', [file]);
      if (!g.ok) throw new Error(`does not compile: ${g.stdout.split('\n').find(l => /ERROR/.test(l)) || g.stderr.trim()}`);
    }
    fs.mkdirSync(GLSL_CACHE, { recursive: true });
    fs.writeFileSync(cached, glsl);
    return glsl;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}

function isPorted(pack) {
  const plastic = pack.shaders.findIndex(s => s.name === 'DefaultUnifiedPlasticVS');
  return pack.variants.some(v => v.shader === plastic && v.key >>> 28 >= 4);
}

function basePack() {
  const pristine = path.join(CACHE, `${ENGINE_VERSION}-shaders_glsles3_web.pack`);
  const current = fs.readFileSync(WEB_PACK);
  if (!isPorted(readPack(current))) {
    fs.mkdirSync(CACHE, { recursive: true });
    if (!fs.existsSync(pristine) || !fs.readFileSync(pristine).equals(current)) fs.writeFileSync(pristine, current);
    return readPack(current);
  }
  if (!fs.existsSync(pristine)) throw new Error(`${path.relative(BASE, WEB_PACK)} is already ported and the original is not cached; restore it from git first`);
  return readPack(fs.readFileSync(pristine));
}

const WARMUP_LISTS = STAGED ? [path.join(PUBLIC_DIR, 'gen', 'shader-warmup.json')] : [path.join(PUBLIC_DIR, 'gen', 'shader-warmup.json'), path.join(BASE, '.cache', 'shader-warmup.json')];

function pruneWarmup(pack) {
  const plain = glsl => glsl.replace(/layout\(std140\) uniform block_CB(\d+) \{ vec4 CB\d+\[(\d+)\]; \}[^\n]*/g, 'uniform vec4 CB$1[$2];').replace(/\s+/g, ' ').trim();
  const sources = new Set(pack.variants.map(v => plain(v.source.toString('latin1'))));
  for (const file of WARMUP_LISTS) {
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const programs = data.programs || {};
    let removed = 0;
    for (const [key, rec] of Object.entries(programs)) {
      if (sources.has(plain(rec.vs || '')) && sources.has(plain(rec.fs || ''))) continue;
      delete programs[key];
      removed++;
    }
    if (!removed) continue;
    fs.writeFileSync(file, JSON.stringify(data));
    console.log(`Dropped ${removed} stale program(s) from ${path.relative(BASE, file)}.`);
  }
}

async function main() {
  const web = basePack();
  const { pack: vk, names, source } = await vulkanPack();
  console.log(`Web pack: ${web.variants.length} variants. Vulkan pack from ${source}: ${vk.variants.length} variants.`);
  const caps = web.caps.map(c => c.name).join(',');
  if (caps !== vk.caps.map(c => c.name).join(',')) throw new Error('the two packs list different device capabilities');

  const slot = (name, type, key) => `${name}|${type}|${key}`;
  const have = new Set(web.variants.filter(v => !REPLACED_FAMILIES.has(web.shaders[v.shader].name)).map(v => slot(web.shaders[v.shader].name, v.type, v.key)));
  const shq = BigInt(1 << vk.caps.findIndex(c => c.name === 'supportsSHQ'));
  const candidates = [];
  for (const v of vk.variants) {
    if ((v.type !== TYPE.vertex && v.type !== TYPE.fragment) || (SKIP_SHQ && v.capValue & shq)) continue;
    const name = vk.shaders[v.shader].name;
    if (!have.has(slot(name, v.type, v.key))) candidates.push({ ...v, name, gate: gate(vk, v) });
  }
  console.log(`${candidates.length} variants to port.`);
  if (CHECK) {
    const current = readPack(fs.readFileSync(WEB_PACK));
    const present = new Set(current.variants.map(v => slot(current.shaders[v.shader].name, v.type, v.key)));
    const missing = candidates.filter(v => !present.has(slot(v.name, v.type, v.key))).length;
    const failed = fs.existsSync(path.join(CACHE, 'failures.txt')) ? fs.readFileSync(path.join(CACHE, 'failures.txt'), 'utf8').split('\n').filter(Boolean).length : 0;
    const needed = missing > failed;
    console.log(needed ? `needed (${missing} variants missing)` : 'already applied');
    process.exitCode = needed ? 2 : 0;
    return;
  }
  if (!candidates.length) return console.log('Nothing to port; the pack already has every Vulkan variant.');

  const tools = { spirvVal: await hasTool('spirv-val'), glslang: await hasTool('glslangValidator') };
  if (!(await hasTool('spirv-cross'))) throw new Error('spirv-cross is required (brew install spirv-cross, or the Vulkan SDK)');
  if (!tools.spirvVal || !tools.glslang) console.log('Warning: spirv-val or glslangValidator missing; ported shaders will not be validated.');

  const converted = new Array(candidates.length);
  const failures = new Map();
  const failureLog = [];
  let done = 0;
  await pool(candidates, Math.max(2, os.cpus().length), async (v, i) => {
    try {
      converted[i] = await convert(v.source, tools);
    } catch (err) {
      failureLog.push(`${vk.shaders[v.shader].name} ${v.key.toString(16).padStart(8, '0')} ${v.type === TYPE.vertex ? 'vs' : 'fs'}: ${err.message}`);
      const reason = String(err.message).replace(/\d+/g, 'N').slice(0, 120);
      const entry = failures.get(reason) || { count: 0, example: `${vk.shaders[v.shader].name} ${v.key.toString(16).padStart(8, '0')}` };
      entry.count++;
      failures.set(reason, entry);
    }
    if (++done % 500 === 0) console.log(`  ${done}/${candidates.length}`);
  });

  let repaired = 0;
  const out = {
    ...web,
    shaders: web.shaders.slice(),
    flags: web.flags.slice(),
    variants: web.variants.filter(v => !REPLACED_FAMILIES.has(web.shaders[v.shader].name)).map(v => {
      const glsl = v.source.toString('latin1');
      const fixed = webOrigin(web.shaders[v.shader].name, signedIndices(glsl));
      if (fixed === glsl) return v;
      repaired++;
      return { ...v, source: Buffer.from(fixed, 'latin1') };
    }),
  };
  const shaderIndex = new Map(out.shaders.map((s, i) => [s.name, i]));
  let added = 0;
  let named = 0;
  candidates.forEach((v, i) => {
    if (converted[i] === undefined) return;
    const glsl = screenRowOrder(normalDecode(nameSamplers(converted[i], names && names.get(`${vk.shaders[v.shader].name}|${v.type}|${v.key}`))));
    if (glsl !== converted[i]) named++;
    const source = Buffer.from(glsl, 'latin1');
    const { name, gate: g } = v;
    for (const f of new Set([...g.flagMask, ...g.flagValue])) if (!out.flags.includes(f)) out.flags.push(f);
    if (!shaderIndex.has(name)) {
      shaderIndex.set(name, out.shaders.length);
      out.shaders.push({ name, extra: Buffer.alloc(4) });
    }
    out.variants.push({
      hash: crypto.createHash('md5').update(`webblox-port|${name}|${variantId(vk, v)}|`).update(source).digest(),
      key: v.key,
      type: v.type,
      shader: shaderIndex.get(name),
      flagMask: namesToMask(g.flagMask, out.flags),
      flagValue: namesToMask(g.flagValue, out.flags),
      capMask: namesToMask(g.capMask, out.caps.map(c => c.name)),
      capValue: namesToMask(g.capValue, out.caps.map(c => c.name)),
      source,
    });
    added++;
  });
  if (out.flags.length > 64) throw new Error('more than 64 flags; the pack format cannot gate on them');

  const failed = candidates.length - added;
  console.log(`Ported ${added} of ${candidates.length} variants${failed ? `; ${failed} could not be ported:` : '.'} Real texture names on ${named}. Repaired ${repaired} original web variant(s).`);
  for (const [reason, { count, example }] of [...failures].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(count).padStart(5)}  ${reason}  (e.g. ${example})`);
  }
  fs.writeFileSync(path.join(CACHE, 'failures.txt'), failureLog.sort().join('\n') + '\n');
  const buf = writePack(out);
  const check = readPack(buf);
  if (check.variants.length !== out.variants.length) throw new Error('the rewritten pack does not read back');
  fs.writeFileSync(WEB_PACK, buf);
  console.log(`Wrote ${path.relative(BASE, WEB_PACK)}: ${check.variants.length} variants, ${check.shaders.length} shaders, ${(buf.length / 1048576).toFixed(1)} MB.`);
  pruneWarmup(check);
}

main().catch(err => {
  console.error(`shader port failed: ${err.message}`);
  process.exitCode = 1;
});
