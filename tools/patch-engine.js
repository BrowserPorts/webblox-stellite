const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { decodePng, encodePng } = require('./png');
const { blake2b } = require('./blake2b');
const { encodeForRoblox, COMPILE_FLAGS } = require('./luau-bytecode');
const { spliceBackport, spliceRenderThreads, spliceSystemTheme, applyLightingGates } = require('./autoport/wasm/splice');

const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const argValue = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const LOGO = path.resolve(argValue('--logo') || path.join(ROOT, 'art', 'new logo.png'));

function findBundle() {
  const given = argValue('--bundle');
  if (given) return path.resolve(given);
  return path.join(ROOT, 'public', 'engine');
}

const BUNDLE = findBundle();
const PLANS_DIR = path.resolve(argValue('--plans') || path.join(__dirname, 'backport'));
const PROFILE = JSON.parse(fs.readFileSync(path.join(PLANS_DIR, 'profile.json'), 'utf8'));
const results = [];
const report = (name, status, detail = '') => results.push({ name, status, detail });

function writeFile(file, data) {
  if (CHECK) return;
  fs.writeFileSync(file, data);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function ddsExpectedSize(buf) {
  if (buf.length < 128 || buf.toString('ascii', 0, 4) !== 'DDS ') return null;
  const height = buf.readUInt32LE(12);
  const width = buf.readUInt32LE(16);
  const mips = Math.max(1, buf.readUInt32LE(28));
  const fourcc = buf.toString('ascii', 84, 88);
  const caps2 = buf.readUInt32LE(112);
  const blockBytes = { DXT1: 8, ATI1: 8, BC4U: 8, DXT3: 16, DXT5: 16, ATI2: 16, BC5U: 16 }[fourcc];
  if (!blockBytes) return null;
  const faces = caps2 & 0x200 ? 6 : 1;
  let total = 0;
  for (let f = 0; f < faces; f++) {
    let w = width, h = height;
    for (let level = 0; level < mips; level++) {
      total += Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * blockBytes;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
  }
  return 128 + total;
}

function patchTextEncodedTextures() {
  const name = 'Sky textures (undo UTF-8 mangling)';
  let repaired = 0, healthy = 0;
  const unrepairable = [];
  for (const file of walk(BUNDLE)) {
    if (!/\.(tex|dds)$/i.test(file)) continue;
    const buf = fs.readFileSync(file);
    const expected = ddsExpectedSize(buf);
    if (expected === null) continue;
    if (expected === buf.length) { healthy++; continue; }
    const text = buf.toString('utf8');
    const fixed = Buffer.from(text, 'latin1');
    const roundTrips = Buffer.from(text, 'utf8').equals(buf) && fixed.toString('latin1') === text;
    if (roundTrips && fixed.length === expected) {
      writeFile(file, fixed);
      repaired++;
    } else {
      unrepairable.push(path.relative(BUNDLE, file));
    }
  }
  if (unrepairable.length) report(name, 'FAILED', `${unrepairable.length} texture(s) have the wrong size and are not UTF-8 damage: ${unrepairable.slice(0, 3).join(', ')}`);
  else if (repaired) report(name, CHECK ? 'needed' : 'applied', `${repaired} repaired, ${healthy} already correct`);
  else report(name, 'already applied', `${healthy} textures checked`);
}

function patchAuthLogo() {
  const name = 'Login screen logo';
  const target = path.join(BUNDLE, 'ExtraContent', 'textures', 'ui', 'LuaApp', 'graphic', 'Auth', 'logo_white_1x.png');
  if (!fs.existsSync(LOGO)) return report(name, 'FAILED', `logo source not found: ${LOGO}`);
  if (!fs.existsSync(target)) return report(name, 'FAILED', `asset not found: ${path.relative(BUNDLE, target)}`);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webblox-logo-')), 'logo.png');
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'make-logo.js'), LOGO, tmp], { stdio: 'pipe' });
    const built = fs.readFileSync(tmp);
    const current = decodePng(fs.readFileSync(target));
    if (Buffer.from(decodePng(built).rgba).equals(Buffer.from(current.rgba))) return report(name, 'already applied');
    writeFile(target, built);
    report(name, CHECK ? 'needed' : 'applied');
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

function logoCoverage() {
  const { width, height, rgba } = decodePng(fs.readFileSync(LOGO));
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('logo source is fully transparent');
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const alpha = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) alpha[y * w + x] = rgba[((y + y0) * width + x + x0) * 4 + 3];
  }
  return { width: w, height: h, alpha };
}

function areaResample(src, sw, sh, dw, dh) {
  const resampleAxis = (input, inLen, outLen, lines, stride, step) => {
    const out = new Float64Array(outLen * lines);
    const scale = inLen / outLen;
    for (let line = 0; line < lines; line++) {
      for (let o = 0; o < outLen; o++) {
        const start = o * scale, end = start + scale;
        let sum = 0;
        for (let i = Math.floor(start); i < Math.min(inLen, Math.ceil(end)); i++) {
          const cover = Math.min(end, i + 1) - Math.max(start, i);
          if (cover > 0) sum += input[line * stride + i * step] * cover;
        }
        out[line * outLen + o] = sum / scale;
      }
    }
    return out;
  };
  const horizontal = resampleAxis(src, sw, dw, sh, sw, 1);
  const transposed = new Float64Array(dw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < dw; x++) transposed[x * sh + y] = horizontal[y * dw + x];
  const vertical = resampleAxis(transposed, sh, dh, dw, sh, 1);
  const out = new Uint8Array(dw * dh);
  for (let x = 0; x < dw; x++) {
    for (let y = 0; y < dh; y++) out[y * dw + x] = Math.max(0, Math.min(255, Math.round(vertical[x * dh + y])));
  }
  return out;
}

const SHEET_DIR = ['ExtraContent', 'LuaPackages', 'Packages', '_Index', 'FoundationImages', 'FoundationImages', 'SpriteSheets'];
const SPRITE_TOLERANCE = 40;
const WORDMARK_BOXES = PROFILE.wordmarkBoxes;

function patchWordmarkSprites() {
  const name = 'Home header wordmark sprites';
  if (!fs.existsSync(LOGO)) return report(name, 'FAILED', `logo source not found: ${LOGO}`);
  const logo = logoCoverage();
  let changed = 0;
  for (const box of WORDMARK_BOXES) {
    const file = path.join(BUNDLE, ...SHEET_DIR, box.sheet);
    const { width, height, rgba } = decodePng(fs.readFileSync(file));
    const next = new Uint8Array(rgba);
    const scale = Math.min(box.w / logo.width, box.visible / logo.height);
    const lw = Math.round(logo.width * scale), lh = Math.round(logo.height * scale);
    const alpha = areaResample(logo.alpha, logo.width, logo.height, lw, lh);
    const ox = box.x, oy = box.visibleY + ((box.visible - lh) >> 1);
    for (let y = box.y; y < box.y + box.h; y++) next.fill(0, (y * width + box.x) * 4, (y * width + box.x + box.w) * 4);
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const i = ((oy + y) * width + ox + x) * 4;
        next[i] = next[i + 1] = next[i + 2] = 255;
        next[i + 3] = alpha[y * lw + x];
      }
    }
    let maxDiff = 0;
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let i = (y * width + box.x) * 4; i < (y * width + box.x + box.w) * 4; i++) {
        const d = Math.abs(next[i] - rgba[i]);
        if (d > maxDiff) maxDiff = d;
      }
    }
    if (maxDiff <= SPRITE_TOLERANCE) continue;
    writeFile(file, encodePng(width, height, next));
    changed++;
  }
  report(name, changed ? (CHECK ? 'needed' : 'applied') : 'already applied', changed ? `${changed} sheet(s) redrawn` : '');
}

const OP_LOADN = (4 * 227) & 0xff;
const loadnPair = (x, y) => {
  const b = Buffer.alloc(8);
  b[0] = OP_LOADN; b[1] = 3; b.writeInt16LE(x, 2);
  b[4] = OP_LOADN; b[5] = 4; b.writeInt16LE(y, 6);
  return b;
};
const double = n => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
const RECT_EDITS = PROFILE.rectEdits;
const ASPECT = PROFILE.aspect ? PROFILE.aspect.map(([w, h]) => double(w / h)) : null;

function replaceAll(buf, from, to) {
  let count = 0;
  for (let i = buf.indexOf(from); i >= 0; i = buf.indexOf(from, i + to.length)) {
    to.copy(buf, i);
    count++;
  }
  return count;
}

const BYTECODE_EDITS = PROFILE.bytecodeEdits.map(edit => ({ from: Buffer.from(edit.from, 'hex'), to: Buffer.from(edit.to, 'hex') }));

function patchScriptSource(src) {
  const out = Buffer.from(src);
  let edits = 0, applied = 0;
  for (const edit of RECT_EDITS) {
    const oldOffset = loadnPair(...edit.offset[0]);
    const oldSize = loadnPair(...edit.size[0]);
    for (let i = out.indexOf(oldOffset); i >= 0; i = out.indexOf(oldOffset, i + 8)) {
      const s = out.indexOf(oldSize, i + 8);
      if (s < 0 || s - i > 48) continue;
      loadnPair(...edit.offset[1]).copy(out, i);
      loadnPair(...edit.size[1]).copy(out, s);
      edits++;
    }
    const newOffset = loadnPair(...edit.offset[1]);
    for (let i = out.indexOf(newOffset); i >= 0; i = out.indexOf(newOffset, i + 8)) {
      const s = out.indexOf(loadnPair(...edit.size[1]), i + 8);
      if (s >= 0 && s - i <= 48) applied++;
    }
  }
  if (ASPECT) {
    edits += replaceAll(out, ASPECT[0], ASPECT[1]);
    if (out.includes(ASPECT[1])) applied++;
  }
  for (const edit of BYTECODE_EDITS) {
    edits += replaceAll(out, edit.from, edit.to);
    if (out.includes(edit.to)) applied++;
  }
  return { out, edits, applied };
}

function readChunks(data) {
  const chunks = [];
  let i = 32;
  while (i < data.length) {
    const name = data.toString('latin1', i, i + 4);
    const compressed = data.readUInt32LE(i + 4);
    const uncompressed = data.readUInt32LE(i + 8);
    const reserved = data.readUInt32LE(i + 12);
    const raw = data.subarray(i, i + 16 + (compressed || uncompressed));
    const payload = raw.subarray(16);
    chunks.push({ name, compressed: compressed !== 0, reserved, raw, payload, body: null });
    i += 16 + (compressed || uncompressed);
    if (name === 'END\0') break;
  }
  return chunks;
}

function chunkBody(chunk) {
  if (!chunk.decoded) chunk.decoded = chunk.compressed ? zlib.zstdDecompressSync(chunk.payload) : chunk.payload;
  return chunk.decoded;
}

function encodeChunk(chunk) {
  if (!chunk.body) return chunk.raw;
  const header = Buffer.alloc(16);
  header.write(chunk.name, 0, 'latin1');
  if (chunk.compressed) {
    const packed = zlib.zstdCompressSync(chunk.body, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });
    header.writeUInt32LE(packed.length, 4);
    header.writeUInt32LE(chunk.body.length, 8);
    header.writeUInt32LE(chunk.reserved, 12);
    return Buffer.concat([header, packed]);
  }
  header.writeUInt32LE(0, 4);
  header.writeUInt32LE(chunk.body.length, 8);
  header.writeUInt32LE(chunk.reserved, 12);
  return Buffer.concat([header, chunk.body]);
}

function splitStrings(blob, count) {
  const list = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const len = blob.readUInt32LE(j);
    list.push(blob.subarray(j + 4, j + 4 + len));
    j += 4 + len;
  }
  return { list, tail: blob.subarray(j) };
}

const LUA_DIR = path.join(__dirname, 'lua');

function luauModule(name) {
  const source = path.join(LUA_DIR, `${name}.luau`);
  const built = path.join(LUA_DIR, `${name}.bytecode`);
  try {
    const compiled = execFileSync('luau-compile', ['--binary', '-O2', '-g1', `--fflags=${COMPILE_FLAGS.join(',')}`, source], { stdio: ['ignore', 'pipe', 'pipe'] });
    const encoded = encodeForRoblox(compiled);
    if (!fs.existsSync(built) || !fs.readFileSync(built).equals(encoded)) writeFile(built, encoded);
    return encoded;
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`luau-compile failed on ${name}.luau: ${String(err.stderr || err.message).trim()}`);
    return fs.readFileSync(built);
  }
}

const SCRIPT_REPLACEMENTS = PROFILE.scriptReplacements;

function patchModelFile(rel, replacements = {}) {
  const name = `Lua header patch: ${path.basename(rel)}`;
  const file = path.join(BUNDLE, rel);
  if (!fs.existsSync(file)) return report(name, 'FAILED', 'file not found');
  if (typeof zlib.zstdDecompressSync !== 'function') return report(name, 'FAILED', 'needs Node 22.15 or newer (zstd)');
  const data = fs.readFileSync(file);
  if (data.toString('latin1', 0, 8) !== '<roblox!') return report(name, 'FAILED', 'not a binary Roblox model');
  const chunks = readChunks(data);
  let moduleClass = null, moduleCount = 0;
  for (const chunk of chunks.filter(c => c.name === 'INST')) {
    const body = chunkBody(chunk);
    const classId = body.readUInt32LE(0);
    const nameLen = body.readUInt32LE(4);
    if (body.toString('latin1', 8, 8 + nameLen) === 'ModuleScript') {
      moduleClass = classId;
      moduleCount = body.readUInt32LE(9 + nameLen);
    }
  }
  if (moduleClass === null) return report(name, 'FAILED', 'no ModuleScript class');
  const sourceChunk = chunks.find(c => {
    if (c.name !== 'PROP') return false;
    const body = chunkBody(c);
    const nameLen = body.readUInt32LE(4);
    return body.readUInt32LE(0) === moduleClass && body.toString('latin1', 8, 8 + nameLen) === 'Source';
  });
  if (!sourceChunk) return report(name, 'FAILED', 'no Source property');
  const body = chunkBody(sourceChunk);
  const prefixLen = 9 + body.readUInt32LE(4);
  const { list, tail } = splitStrings(body.subarray(prefixLen), moduleCount);
  const nameChunk = chunks.find(c => {
    if (c.name !== 'PROP') return false;
    const nb = chunkBody(c);
    const nameLen = nb.readUInt32LE(4);
    return nb.readUInt32LE(0) === moduleClass && nb.toString('latin1', 8, 8 + nameLen) === 'Name';
  });
  const names = nameChunk
    ? splitStrings(chunkBody(nameChunk).subarray(9 + chunkBody(nameChunk).readUInt32LE(4)), moduleCount).list.map(n => n.toString('utf8'))
    : [];
  const builds = new Map(Object.entries(replacements).map(([script, module]) => [script, luauModule(module)]));
  const replaced = new Set();
  const changedIndexes = [];
  let edits = 0, applied = 0;
  const sources = list.map((src, k) => {
    const build = builds.get(names[k]);
    if (build) {
      replaced.add(names[k]);
      if (src.equals(build)) {
        applied++;
        return src;
      }
      edits++;
      changedIndexes.push(k);
      return build;
    }
    const result = patchScriptSource(src);
    applied += result.applied;
    if (!result.edits) return src;
    edits += result.edits;
    changedIndexes.push(k);
    return result.out;
  });
  const missing = Object.keys(replacements).filter(script => !replaced.has(script));
  if (missing.length) return report(name, 'FAILED', `script(s) not found: ${missing.join(', ')}`);
  if (!edits) {
    return applied ? report(name, 'already applied') : report(name, 'FAILED', 'neither the original nor the patched bytecode was found; run npm run autoport');
  }
  const parts = [body.subarray(0, prefixLen)];
  for (const src of sources) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(src.length);
    parts.push(len, src);
  }
  parts.push(tail);
  sourceChunk.body = Buffer.concat(parts);
  const hashChunk = chunks.find(c => c.name === 'HASH');
  if (hashChunk) {
    const hashes = Buffer.from(chunkBody(hashChunk));
    const count = hashes.readUInt32LE(0);
    const size = hashes.readUInt16LE(4);
    if (count !== moduleCount || size !== 16) return report(name, 'FAILED', `unexpected HASH layout (${count} x ${size})`);
    for (const k of changedIndexes) blake2b(sources[k], 16).copy(hashes, 6 + 16 * k);
    hashChunk.body = hashes;
  }
  writeFile(file, Buffer.concat([data.subarray(0, 32), ...chunks.map(encodeChunk)]));
  report(name, CHECK ? 'needed' : 'applied', `${edits} edit(s) in ${changedIndexes.length} script(s)`);
}

const REQUIRED_FLAGS = PROFILE.requiredFlags;

function patchFlags() {
  const name = 'WebFlags.json overrides';
  const file = path.join(BUNDLE, 'WebFlags.json');
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { applicationSettings: {} };
  data.applicationSettings = data.applicationSettings || {};
  const missing = Object.entries(REQUIRED_FLAGS).filter(([k, v]) => data.applicationSettings[k] !== v);
  if (!missing.length) return report(name, 'already applied');
  for (const [k, v] of missing) data.applicationSettings[k] = v;
  writeFile(file, JSON.stringify(data, null, 4) + '\n');
  report(name, CHECK ? 'needed' : 'applied', `${missing.length} flag(s) set`);
}

const WORDING = PROFILE.wording;

function patchStrings(name, fileName, list) {
  const file = path.join(BUNDLE, fileName);
  if (!fs.existsSync(file)) return report(name, 'FAILED', `${fileName} not found`);
  let text = fs.readFileSync(file, 'utf8');
  const count = (s, needle) => s.split(needle).length - 1;
  let replaced = 0;
  const unmatched = [];
  for (const [from, to, expected] of list) {
    if (count(text, from) === expected) {
      text = text.split(from).join(to);
      replaced++;
    } else if (count(text, to) !== expected) {
      unmatched.push(from);
    }
  }
  if (unmatched.length) return report(name, 'FAILED', `${unmatched.length} string(s) not found: ${unmatched[0]}`);
  if (!replaced) return report(name, 'already applied');
  writeFile(file, text);
  report(name, CHECK ? 'needed' : 'applied', `${replaced} string(s) replaced`);
}

function patchWording() {
  patchStrings('Loader patches in WasmPlayer.js', 'WasmPlayer.js', WORDING);
}

const WEBCLIENT = PROFILE.webClient;

function patchWebClient() {
  patchStrings('WebClient.js patches (web views, main loop)', 'WebClient.js', WEBCLIENT);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readPlan(name) {
  return JSON.parse(fs.readFileSync(path.join(PLANS_DIR, name), 'utf8'));
}

function wasmStages() {
  const home = readPlan('luaapp-plan.json');
  const threads = readPlan('render-threads-plan.json');
  const stages = [
    { id: 'home', name: 'Home screen backport in WebClient.wasm', sha: home.patchedSha256, apply: data => spliceBackport(data, fs.readFileSync(path.join(PLANS_DIR, 'luaapp-bodies.wasm')), home), detail: `${home.order.length} function(s), ${home.tableAdd.length} table slot(s)` },
  ];
  if (PROFILE.systemTheme) stages.push({ id: 'theme', name: 'System theme provider in WebClient.wasm', sha: PROFILE.systemTheme.patchedSha256, apply: data => spliceSystemTheme(data, PROFILE.systemTheme, home), detail: `theme value at ${PROFILE.themeAddress}` });
  if (PROFILE.lightingGates) stages.push({ id: 'gates', name: 'Future lighting gates in WebClient.wasm', sha: threads.sourceSha256, apply: data => applyLightingGates(data, PROFILE.lightingGates, home.imports), detail: `${PROFILE.lightingGates.length} edit(s)` });
  stages.push({ id: 'threads', name: 'Render threads in WebClient.wasm', sha: threads.patchedSha256, apply: data => spliceRenderThreads(data, threads), detail: `${threads.edits.length} function edit(s), ${threads.added.length} new function(s)` });
  return { stages, hashes: [home.sourceSha256, ...stages.map(stage => stage.sha)] };
}

function patchWasm() {
  const file = path.join(BUNDLE, 'WebClient.wasm');
  const { stages, hashes } = wasmStages();
  if (!fs.existsSync(file)) {
    for (const stage of stages) report(stage.name, 'FAILED', 'WebClient.wasm not found');
    return;
  }
  let data = fs.readFileSync(file);
  const at = hashes.indexOf(sha256(data));
  if (at < 0) {
    for (const stage of stages) report(stage.name, 'FAILED', 'WebClient.wasm is not a build this profile was made for; run npm run autoport');
    return;
  }
  let wrote = false;
  stages.forEach((stage, index) => {
    if (index + 1 <= at) return report(stage.name, 'already applied');
    data = stage.apply(data);
    if (sha256(data) !== stage.sha) throw new Error(`${stage.name}: the result does not match the recorded hash`);
    wrote = true;
    report(stage.name, CHECK ? 'needed' : 'applied', stage.detail);
  });
  if (wrote) writeFile(file, data);
}

const modelSteps = [
  () => patchModelFile(path.join('ExtraContent', 'models', 'UniversalApp', 'UniversalApp.rbxm')),
  () => patchModelFile(path.join('ExtraContent', 'models', 'InExperience', 'InExperience.rbxm'), SCRIPT_REPLACEMENTS),
];

const steps = args.includes('--models-only') ? modelSteps : [
  patchWasm,
  patchTextEncodedTextures,
  patchAuthLogo,
  patchWordmarkSprites,
  ...modelSteps,
  patchFlags,
  patchWording,
  patchWebClient,
];

console.log(`${CHECK ? 'Checking' : 'Patching'} ${path.relative(ROOT, BUNDLE) || BUNDLE}`);
for (const step of steps) {
  try {
    step();
  } catch (err) {
    report(step.name || 'patch', 'FAILED', err.message);
  }
}
const width = Math.max(...results.map(r => r.name.length));
for (const r of results) console.log(`  ${r.name.padEnd(width)}  ${r.status}${r.detail ? `  (${r.detail})` : ''}`);
const failed = results.filter(r => r.status === 'FAILED').length;
if (failed) {
  console.log(`\n${failed} patch(es) failed. The engine probably changed. Run npm run autoport to port them.`);
  process.exitCode = 1;
}
