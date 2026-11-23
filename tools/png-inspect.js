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

function inspect(file) {
  const b = fs.readFileSync(file);
  const sig = b.subarray(0, 8).toString('hex');
  console.log(`\n== ${file}`);
  console.log(`size=${b.length} signature=${sig} ${sig === '89504e470d0a1a0a' ? 'OK' : 'BAD'}`);
  let off = 8;
  const chunks = [];
  let ihdr = null;
  const idat = [];
  let palette = null;
  let trns = null;
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    const crcStored = b.readUInt32BE(off + 8 + len);
    const crcCalc = crc32(b.subarray(off + 4, off + 8 + len));
    chunks.push(`${type}(${len})${crcStored === crcCalc ? '' : ' CRC-BAD'}`);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], compression: data[10],
        filter: data[11], interlace: data[12],
      };
    }
    if (type === 'PLTE') palette = data;
    if (type === 'tRNS') trns = data;
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
    if (type === 'IEND') break;
  }
  console.log('chunks: ' + chunks.join(' '));
  console.log('IHDR: ' + JSON.stringify(ihdr));
  if (palette) console.log(`PLTE: ${palette.length / 3} entries` + (trns ? `, tRNS ${trns.length} bytes` : ''));

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  if (bitDepth !== 8 || interlace !== 0) return console.log('(pixel decode skipped)');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bpp = channels;
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const up = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
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
    if (colorType === 6) { r = out[i * 4]; g = out[i * 4 + 1]; bl = out[i * 4 + 2]; al = out[i * 4 + 3]; }
    else if (colorType === 4) { r = g = bl = out[i * 2]; al = out[i * 2 + 1]; }
    else if (colorType === 2) { r = out[i * 3]; g = out[i * 3 + 1]; bl = out[i * 3 + 2]; }
    else if (colorType === 0) { r = g = bl = out[i]; }
    else if (colorType === 3) {
      const idx = out[i];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; bl = palette[idx * 3 + 2];
      if (trns && idx < trns.length) al = trns[idx];
    }
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = bl; px[i * 4 + 3] = al;
  }
  let opaque = 0, clear = 0, mid = 0, maxA = 0, minA = 255;
  let minR = 255, maxR = 0;
  for (let i = 0; i < width * height; i++) {
    const a = px[i * 4 + 3];
    if (a === 0) clear++; else if (a === 255) { opaque++; minR = Math.min(minR, px[i * 4]); maxR = Math.max(maxR, px[i * 4]); }
    else mid++;
    maxA = Math.max(maxA, a); minA = Math.min(minA, a);
  }
  let x0 = width, x1 = -1, y0 = height, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (px[(y * width + x) * 4 + 3] > 8) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  console.log(`pixels: alpha min=${minA} max=${maxA} | opaque=${opaque} mid=${mid} clear=${clear}`);
  console.log(`opaque RGB range: ${minR}..${maxR}`);
  console.log(`visible bbox: x ${x0}..${x1} (${x1 - x0 + 1}px), y ${y0}..${y1} (${y1 - y0 + 1}px)`);
}

for (const f of process.argv.slice(2)) inspect(f);
