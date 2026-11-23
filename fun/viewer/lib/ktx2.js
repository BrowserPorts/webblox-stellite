const zlib = require('zlib');

const MAGIC = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER_SIZE = 80;
const SUPERCOMPRESSION_NONE = 0;
const SUPERCOMPRESSION_ZSTD = 2;
const FORMATS = {
  131: { blockBytes: 8, punchThrough: false },
  132: { blockBytes: 8, punchThrough: false },
  133: { blockBytes: 8, punchThrough: true },
  134: { blockBytes: 8, punchThrough: true },
  137: { blockBytes: 16, alpha: true },
  138: { blockBytes: 16, alpha: true },
};

function readLevel(file, maxSize = 0) {
  if (file.length < HEADER_SIZE + 24 || !file.subarray(0, 12).equals(MAGIC)) throw new Error('not a KTX2 file');
  const vkFormat = file.readUInt32LE(12);
  const baseWidth = file.readUInt32LE(20);
  const baseHeight = file.readUInt32LE(24);
  const levels = Math.max(1, file.readUInt32LE(40));
  const supercompression = file.readUInt32LE(44);
  const format = FORMATS[vkFormat];
  if (!format) throw new Error(`unsupported vkFormat ${vkFormat}`);
  let level = 0;
  while (maxSize && level < levels - 1 && Math.max(baseWidth >> level, baseHeight >> level) > maxSize) level++;
  const width = Math.max(1, baseWidth >> level);
  const height = Math.max(1, baseHeight >> level);
  const entry = HEADER_SIZE + level * 24;
  const offset = Number(file.readBigUInt64LE(entry));
  const length = Number(file.readBigUInt64LE(entry + 8));
  const stored = file.subarray(offset, offset + length);
  let blocks;
  if (supercompression === SUPERCOMPRESSION_ZSTD) blocks = zlib.zstdDecompressSync(stored);
  else if (supercompression === SUPERCOMPRESSION_NONE) blocks = stored;
  else throw new Error(`unsupported supercompression ${supercompression}`);
  return { width, height, format, blocks };
}

function expand565(value) {
  const r = (value >> 11) & 31;
  const g = (value >> 5) & 63;
  const b = value & 31;
  return [(r * 255 + 15) / 31 | 0, (g * 255 + 31) / 63 | 0, (b * 255 + 15) / 31 | 0];
}

function colorTable(c0, c1, fourColors, punchThrough) {
  const a = expand565(c0);
  const b = expand565(c1);
  if (fourColors) {
    return [[...a, 255], [...b, 255],
            a.map((v, i) => (2 * v + b[i]) / 3 | 0).concat(255),
            a.map((v, i) => (v + 2 * b[i]) / 3 | 0).concat(255)];
  }
  return [[...a, 255], [...b, 255], a.map((v, i) => (v + b[i]) / 2 | 0).concat(255), [0, 0, 0, punchThrough ? 0 : 255]];
}

function alphaTable(a0, a1) {
  const table = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) table.push(((7 - i) * a0 + i * a1) / 7 | 0);
  else {
    for (let i = 1; i < 5; i++) table.push(((5 - i) * a0 + i * a1) / 5 | 0);
    table.push(0, 255);
  }
  return table;
}

function decode({ width, height, format, blocks }) {
  const rgba = Buffer.alloc(width * height * 4);
  const across = Math.ceil(width / 4);
  const down = Math.ceil(height / 4);
  if (blocks.length < across * down * format.blockBytes) throw new Error('truncated image data');
  let at = 0;
  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) {
      let alphas = null;
      let alphaBits = 0n;
      let colorAt = at;
      if (format.alpha) {
        alphas = alphaTable(blocks[at], blocks[at + 1]);
        for (let i = 5; i >= 0; i--) alphaBits = (alphaBits << 8n) | BigInt(blocks[at + 2 + i]);
        colorAt = at + 8;
      }
      const c0 = blocks.readUInt16LE(colorAt);
      const c1 = blocks.readUInt16LE(colorAt + 2);
      const colors = colorTable(c0, c1, format.alpha || c0 > c1, format.punchThrough);
      const indices = blocks.readUInt32LE(colorAt + 4);
      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y;
        if (py >= height) break;
        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x;
          if (px >= width) continue;
          const texel = y * 4 + x;
          const color = colors[(indices >>> (texel * 2)) & 3];
          const out = (py * width + px) * 4;
          rgba[out] = color[0];
          rgba[out + 1] = color[1];
          rgba[out + 2] = color[2];
          rgba[out + 3] = alphas ? alphas[Number((alphaBits >> BigInt(texel * 3)) & 7n)] : color[3];
        }
      }
      at += format.blockBytes;
    }
  }
  return rgba;
}

function textureRole(file) {
  const { blocks, format } = readLevel(file, 64);
  const colorAt = format.alpha ? 8 : 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let n = 0;
  for (let i = 0; i + format.blockBytes <= blocks.length; i += format.blockBytes) {
    const c = blocks.readUInt16LE(i + colorAt);
    red += ((c >> 11) & 31) * 255 / 31;
    green += ((c >> 5) & 63) * 255 / 63;
    blue += (c & 31) * 255 / 31;
    n++;
  }
  if (!n) return 'color';
  red /= n;
  green /= n;
  blue /= n;
  if (format.alpha && red > 245 && blue < 8) return 'normal';
  if (blue < 8 && green > 8) return 'surface';
  return 'color';
}

function applyRole(rgba, role) {
  if (role === 'normal') {
    for (let i = 0; i < rgba.length; i += 4) {
      const x = rgba[i + 3] / 127.5 - 1;
      const y = rgba[i + 1] / 127.5 - 1;
      rgba[i] = rgba[i + 3];
      rgba[i + 2] = (Math.sqrt(Math.max(0, 1 - x * x - y * y)) + 1) * 127.5;
      rgba[i + 3] = 255;
    }
  } else if (role === 'surface') {
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i + 2] = rgba[i];
      rgba[i] = 0;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

module.exports = { readLevel, decode, textureRole, applyRole };
