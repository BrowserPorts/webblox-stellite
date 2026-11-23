const fs = require('fs');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function decode(file) {
  const b = fs.readFileSync(file);
  if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let off = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], interlace: data[12],
      };
    }
    if (type === 'PLTE') palette = data;
    if (type === 'tRNS') trns = data;
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
    if (type === 'IEND') break;
  }
  if (ihdr.bitDepth !== 8 || ihdr.interlace !== 0) throw new Error('only 8-bit non-interlaced');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];
  const { width, height } = ihdr;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const up = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[x] = v & 0xff;
    }
  }
  const px = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r, g, bl, al = 255;
    if (ihdr.colorType === 6) { r = out[i * 4]; g = out[i * 4 + 1]; bl = out[i * 4 + 2]; al = out[i * 4 + 3]; }
    else if (ihdr.colorType === 4) { r = g = bl = out[i * 2]; al = out[i * 2 + 1]; }
    else if (ihdr.colorType === 2) { r = out[i * 3]; g = out[i * 3 + 1]; bl = out[i * 3 + 2]; }
    else if (ihdr.colorType === 0) { r = g = bl = out[i]; }
    else if (ihdr.colorType === 3) {
      const idx = out[i];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; bl = palette[idx * 3 + 2];
      if (trns && idx < trns.length) al = trns[idx];
    }
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = bl; px[i * 4 + 3] = al;
  }
  return { width, height, px };
}

function resampleAlpha(alpha, width, height, scale) {
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) / scale - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(width - 1, x0 + 1), fx = sx - x0;
      const v =
        alpha[y0 * width + x0] * (1 - fx) * (1 - fy) +
        alpha[y0 * width + x1] * fx * (1 - fy) +
        alpha[y1 * width + x0] * (1 - fx) * fy +
        alpha[y1 * width + x1] * fx * fy;
      out[y * w + x] = Math.round(v);
    }
  }
  return { width: w, height: h, alpha: out };
}

const [, , srcPath, dstPath] = process.argv;
if (!srcPath || !dstPath) {
  console.error('usage: node tools/make-logo.js <source.png> <destination.png>');
  process.exit(1);
}

const src = decode(srcPath);

const coverage = new Uint8Array(src.width * src.height);
let worstInk = 0;
for (let i = 0; i < src.width * src.height; i++) {
  const a = src.px[i * 4 + 3];
  coverage[i] = a;
  if (a > 200) {
    const delta = Math.max(255 - src.px[i * 4], 255 - src.px[i * 4 + 1], 255 - src.px[i * 4 + 2]);
    if (delta > worstInk) worstInk = delta;
  }
}
if (worstInk > 48) throw new Error(`wordmark is not white (ink is ${worstInk} below white); palette encoding only supports a white logo`);
if (worstInk > 8) console.log(`note: near-white ink, worst channel ${255 - worstInk}`);

let x0 = src.width, x1 = -1, y0 = src.height, y1 = -1;
for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
  if (coverage[y * src.width + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
}
if (x1 < 0) throw new Error('source is fully transparent');
const cropW = x1 - x0 + 1, cropH = y1 - y0 + 1;
const cropped = new Uint8Array(cropW * cropH);
for (let y = 0; y < cropH; y++) {
  cropped.set(coverage.subarray((y + y0) * src.width + x0, (y + y0) * src.width + x0 + cropW), y * cropW);
}

const W = 476, H = 88;
const scale = Math.min(W / cropW, H / cropH);
const scaled = resampleAlpha(cropped, cropW, cropH, scale);
const ox = Math.floor((W - scaled.width) / 2);
const oy = Math.floor((H - scaled.height) / 2);

const indices = Buffer.alloc(W * H);
for (let y = 0; y < scaled.height; y++) {
  for (let x = 0; x < scaled.width; x++) {
    const px = ox + x, py = oy + y;
    if (px >= 0 && px < W && py >= 0 && py < H) indices[py * W + px] = scaled.alpha[y * scaled.width + x];
  }
}

const rows = Buffer.alloc((W + 1) * H);
for (let y = 0; y < H; y++) indices.copy(rows, y * (W + 1) + 1, y * W, (y + 1) * W);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const plte = Buffer.alloc(256 * 3, 255);
const trns = Buffer.alloc(256);
for (let i = 0; i < 256; i++) trns[i] = i;

const png = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  chunk('IHDR', ihdr),
  chunk('PLTE', plte),
  chunk('tRNS', trns),
  chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(dstPath, png);

console.log(`source ${src.width}x${src.height}, ink ${cropW}x${cropH}`);
console.log(`rendered ${scaled.width}x${scaled.height}, centred in ${W}x${H} at ${ox},${oy}`);
console.log(`wrote ${dstPath} (${png.length} bytes, 8-bit palette + tRNS)`);
