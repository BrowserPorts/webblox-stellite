const params = new URLSearchParams(location.search);
const TRACE = params.get('trace');
const BACKEND = params.get('backend') || 'webgl';
const START = Number(params.get('start') || 0);
const END = Number(params.get('end') || Infinity);
const PER_CALL_TIMING = params.get('percall') === '1';
const TIMING = params.get('timing') === '1';
const SHOTS = new Set((params.get('shots') || '').split(',').filter(Boolean).map(Number));
const SKIP_BEFORE_START = /^(drawElements|drawElementsInstanced|drawArrays|drawArraysInstanced|clear|clearBufferfv|clearBufferiv|clearBufferfi|blitFramebuffer|readPixels|invalidateFramebuffer)$/;
const canvas = document.getElementById('canvas');
const objects = new Map();
const report = { trace: TRACE, backend: BACKEND, frames: [], errors: [], shots: {}, done: false };
window.__replay = report;

let gl = null;
let blobTable = null;
let blobBase = 0;
let blobBytes = null;

const VIEWS = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray };

const decode = value => {
  if (value === null || typeof value !== 'object') return value;
  if ('o' in value) return objects.get(value.o) ?? null;
  if ('list' in value) return value.list.map(decode);
  if ('blob' in value) {
    const start = blobBase + blobTable[value.blob];
    const end = value.blob + 1 < blobTable.length ? blobBase + blobTable[value.blob + 1] : blobBytes.byteLength;
    const Kind = VIEWS[value.view] || Uint8Array;
    const size = Kind.BYTES_PER_ELEMENT;
    const copy = blobBytes.slice(start, end).buffer;
    return new Kind(copy, 0, Math.floor(copy.byteLength / size));
  }
  return value;
};

const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

const makeContext = async attributes => {
  if (BACKEND === 'webgpu') {
    window.__webgpuReplay = true;
    if (params.get('skip')) window.__webgpuSkipTarget = new RegExp(params.get('skip'));
    await import('/gl-webgpu-key.js');
    await import('/webgpu.js');
    await window.__webgpuReady(canvas, attributes, { tableBase: '/', autoPresent: false });
  }
  gl = canvas.getContext('webgl2', attributes);
  if (!gl) throw new Error('no context');
};

const finishGpu = async () => {
  if (BACKEND === 'webgpu') {
    await gl.__finish();
    return;
  }
  const pixel = new Uint8Array(4);
  const bound = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, bound);
};

const VIEW_FOR_TYPE = { 0x1400: Int8Array, 0x1401: Uint8Array, 0x1402: Int16Array, 0x1403: Uint16Array, 0x1404: Int32Array, 0x1405: Uint32Array, 0x1406: Float32Array, 0x140B: Uint16Array, 0x8D61: Uint16Array, 0x8363: Uint16Array, 0x8033: Uint16Array, 0x8034: Uint16Array, 0x8368: Uint32Array, 0x8C3B: Uint32Array, 0x8C3E: Uint32Array, 0x84FA: Uint32Array };
const IMAGE_ARGS = { texImage2D: [7, 8], texImage3D: [8, 9], texSubImage2D: [7, 8], texSubImage3D: [9, 10] };

const typedImage = (name, args) => {
  const positions = IMAGE_ARGS[name];
  if (!positions) return args;
  const data = args[positions[1]];
  if (!ArrayBuffer.isView(data)) return args;
  const Kind = VIEW_FOR_TYPE[args[positions[0]]] || Uint8Array;
  if (data instanceof Kind) return args;
  const out = args.slice();
  const size = Kind.BYTES_PER_ELEMENT;
  const start = data.byteOffset;
  const usable = start % size === 0 ? data.buffer : data.buffer.slice(start, start + data.byteLength);
  out[positions[1]] = new Kind(usable, usable === data.buffer ? start : 0, Math.floor(data.byteLength / size));
  return out;
};

const runCall = (name, rawArgs, entry) => {
  let result;
  let args = BACKEND === 'webgl' ? typedImage(name, rawArgs) : rawArgs;
  if (name === 'readPixels' && args.length === 6) args = [...args, new Uint8Array(args[2] * args[3] * 8)];
  if (name.startsWith('ext:')) {
    const [, extension, method] = name.split(':');
    const target = gl.getExtension(extension);
    if (target) result = target[method](...args);
  } else {
    result = gl[name](...args);
  }
  if (entry.length > 2 && entry[2] && typeof entry[2] === 'object' && 'o' in entry[2]) objects.set(entry[2].o, result);
};

let pendingCalls = [];
let frame = 0;
let stopped = false;

const playFrame = async meta => {
  const [index, width, height, draws] = meta;
  const inRange = index >= START;
  const prepared = [];
  for (const entry of pendingCalls) {
    if (!inRange && SKIP_BEFORE_START.test(entry[0])) continue;
    prepared.push(entry);
  }
  pendingCalls = [];
  if (TIMING && BACKEND === 'webgpu' && inRange && gl.__startTiming) gl.__startTiming();
  const t0 = performance.now();
  let glMs = 0;
  let failures = 0;
  for (let i = 0; i < prepared.length; i++) {
    const entry = prepared[i];
    const args = entry.decoded;
    const before = inRange && PER_CALL_TIMING ? performance.now() : 0;
    try {
      runCall(entry[0], args, entry);
    } catch (err) {
      failures++;
      if (report.errors.length < 40) report.errors.push(`${entry[0]}: ${String(err.message || err).slice(0, 240)}`);
    }
    if (inRange && PER_CALL_TIMING) glMs += performance.now() - before;
  }
  const submitted = performance.now();
  if (!PER_CALL_TIMING) {
    for (const entry of prepared) entry.decoded;
    glMs = Math.max(0, submitted - t0 - (performance.now() - submitted));
  }
  if (inRange) {
    await finishGpu();
    const synced = performance.now();
    report.frames.push({ index, calls: prepared.length, draws, loopMs: +(submitted - t0).toFixed(3), glMs: +glMs.toFixed(3), gpuWaitMs: +(synced - submitted).toFixed(3), failures });
    if (TIMING && BACKEND === 'webgpu') {
      const passes = await gl.__readTiming();
      if (passes) (report.timing || (report.timing = [])).push({ index, passes });
    }
    if (SHOTS.has(index)) report.shots[index] = BACKEND === 'webgpu' ? await gl.__capture() : canvas.toDataURL('image/png');
    await nextFrame();
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  frame = index + 1;
  if (frame > END) stopped = true;
};

const run = async () => {
  const info = await (await fetch(`/trace/${encodeURIComponent(TRACE)}/info.json`)).json();
  report.info = info;
  for (let chunk = 0; chunk < info.chunks && !stopped; chunk++) {
    const response = await fetch(`/trace/${encodeURIComponent(TRACE)}/chunk-${chunk}.bin`);
    if (!response.ok) throw new Error(`chunk ${chunk}: ${response.status}`);
    blobBytes = new Uint8Array(await response.arrayBuffer());
    const headLength = new DataView(blobBytes.buffer).getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(blobBytes.subarray(4, 4 + headLength)));
    blobBase = 4 + headLength;
    blobTable = head.table;
    for (const entry of head.calls) {
      if (stopped) break;
      const name = entry[0];
      if (name === '@context') {
        const [attributes, width, height] = entry[1];
        canvas.width = width;
        canvas.height = height;
        await makeContext(attributes);
        continue;
      }
      if (name === '@frame') {
        await playFrame(entry[1]);
        continue;
      }
      entry.decoded = null;
      Object.defineProperty(entry, 'decoded', { get() { return entry[1].map(decode); }, configurable: true });
      if (entry[1].some(arg => arg && typeof arg === 'object' && 'blob' in arg)) {
        const fixed = entry[1].map(decode);
        const resolved = entry[1].map((arg, i) => (arg && typeof arg === 'object' && 'blob' in arg ? fixed[i] : arg));
        Object.defineProperty(entry, 'decoded', { get() { return resolved.map(arg => (arg && typeof arg === 'object' && 'o' in arg ? objects.get(arg.o) ?? null : arg && arg.list ? arg.list.map(decode) : arg)); }, configurable: true });
      }
      pendingCalls.push(entry);
    }
  }
  if (BACKEND === 'webgpu' && gl) {
    report.webgpu = { stats: gl.stats, errors: gl.errors, missing: (gl.missing || []).length };
  }
  report.done = true;
};

window.addEventListener('error', event => report.errors.push(`window: ${event.message}`));
run().catch(err => {
  report.errors.push(`fatal: ${String(err.stack || err).slice(0, 800)}`);
  report.done = true;
});
