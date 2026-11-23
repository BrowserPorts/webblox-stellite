import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { translate } from 'naga-wasm';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { readPack } = require('./shader-pack.js');
const { shaderKey } = require('../public/js/gl-webgpu-key.js');

const publicArg = process.argv.indexOf('--public');
const PUBLIC = publicArg >= 0 ? path.resolve(process.argv[publicArg + 1]) : path.join(ROOT, 'public');
const PACK = path.join(PUBLIC, 'engine', 'shaders', 'shaders_glsles3_web.pack');
const OUT_DIR = path.join(PUBLIC, 'gen');
const OUT_BIN = path.join(OUT_DIR, 'wgsl.txt');
const OUT_INDEX = path.join(OUT_DIR, 'wgsl-index.json');
const WORKERS = Math.max(2, os.cpus().length - 2);
const TYPE = { 0x76: 'vert', 0x70: 'frag' };

export function prepare(source, stage) {
  let binding = 0;
  let out = source.replace(/^#version.*$/m, '#version 450');
  out = out.replace(/^layout\(std140\) uniform block_(CB\d+) \{ (\w+) CB\d+\[(\d+)\]; \};$/gm, (m, name, type, size) => `uniform ${type} ${name}[${size}];`);
  out = out.replace(/^uniform\s+(?:highp\s+)?(u?vec4) (CB\d+)\[(\d+)\];$/gm, (m, type, name, size) => `layout(std140, set=0, binding=${Number(name.slice(2))}) uniform ${name}_block { ${type} ${name}[${size}]; };`);
  out = out.replace(/^uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w*sampler\w+)\s+(\w+);$/gm, (m, type, name) => `layout(set=1, binding=${binding++}) uniform ${type} ${name};`);
  out = out.replace(/\bgl_InstanceID\b/g, 'gl_InstanceIndex').replace(/\bgl_VertexID\b/g, 'gl_VertexIndex');
  const direction = stage === 'vert' ? 'out' : 'in';
  out = out.replace(new RegExp(`^((?:flat|centroid|smooth|noperspective)\\s+)?${direction}\\s+(?:highp\\s+|mediump\\s+|lowp\\s+)?(\\w+)\\s+VARYING(\\d+);$`, 'gm'), (m, qualifier, type, index) => `layout(location=${index}) ${qualifier || ''}${direction} ${type} VARYING${index};`);
  if (stage === 'vert') out = out.replace(/^\s*gl_PointSize\s*=.*$/gm, '');
  return out;
}

export function roundArrayLayers(wgsl) {
  return wgsl.replace(/(textureSample(?:Level|Grad|Bias)?\([^;\n]*?), i32\(([^()]+)\)/g, '$1, i32(floor($2 + 0.5f))');
}

async function convert(source, stage, base) {
  const file = `${base}.${stage}`;
  const spv = `${base}.spv`;
  const optimized = `${base}.opt.spv`;
  fs.writeFileSync(file, prepare(source, stage));
  try {
    await run('glslangValidator', ['-V', '--quiet', '-o', spv, file]);
    await run('spirv-opt', ['--split-combined-image-sampler', '--resolve-binding-conflicts', '-o', optimized, spv]);
    const wgsl = translate({ from: 'spirv', to: 'wgsl', source: new Uint8Array(fs.readFileSync(optimized)) });
    return { wgsl: roundArrayLayers(wgsl.replace(/^[ \t]+/gm, '')) };
  } catch (error) {
    const text = `${error.stdout || ''}${error.stderr || ''}${error.message || error}`;
    return { error: (text.split('\n').find(line => /ERROR|invalid|error/i.test(line)) || text).replace(/\S*wgsl-\S*/g, '').slice(0, 200) };
  } finally {
    for (const item of [file, spv, optimized]) fs.rmSync(item, { force: true });
  }
}

export function addFiles(sources, files) {
  for (const file of files) {
    for (const [source, stage] of JSON.parse(fs.readFileSync(file, 'utf8'))) sources.set(shaderKey(source), { source, stage, name: path.basename(file) });
  }
}

async function main() {
  const pack = readPack(fs.readFileSync(PACK));
  const sources = new Map();
  for (const variant of pack.variants) {
    const stage = TYPE[variant.type];
    if (!stage) continue;
    const source = variant.source.toString('latin1');
    const key = shaderKey(source);
    const existing = sources.get(key);
    if (existing && existing.source !== source && !existing.conflictChecked) existing.conflictChecked = true;
    if (!existing) sources.set(key, { source, stage, name: pack.shaders[variant.shader].name });
  }
  const extra = process.argv.slice(2).filter((item, index, list) => item !== '--public' && list[index - 1] !== '--public');
  if (extra.length) addFiles(sources, extra);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wgsl-'));
  const entries = [...sources.entries()];
  const results = new Map();
  const failures = new Map();
  let at = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (at < entries.length) {
      const index = at++;
      const [key, item] = entries[index];
      const result = await convert(item.source, item.stage, path.join(work, `s${index}`));
      if (result.wgsl) results.set(key, result.wgsl);
      else {
        const reason = result.error.replace(/\d+/g, 'N');
        const failure = failures.get(reason) || { count: 0, names: new Set() };
        failure.count++;
        failure.names.add(item.name);
        failures.set(reason, failure);
      }
    }
  }));
  fs.rmSync(work, { recursive: true, force: true });
  const index = {};
  const chunks = [];
  let offset = 0;
  for (const [key] of entries) {
    if (!results.has(key)) continue;
    const bytes = Buffer.from(results.get(key), 'latin1');
    index[key] = [offset, bytes.length];
    chunks.push(bytes);
    offset += bytes.length;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_BIN, Buffer.concat(chunks));
  fs.writeFileSync(OUT_INDEX, JSON.stringify(index));
  console.log(`${entries.length} unique shaders, ${results.size} converted, ${(offset / 1048576).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(0)}s`);
  for (const [reason, failure] of [...failures].sort((a, b) => b[1].count - a[1].count)) console.log(String(failure.count).padStart(5), reason, '|', [...failure.names].slice(0, 8).join(' '));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error);
  process.exit(1);
});
