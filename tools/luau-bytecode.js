const ROBLOX_PREFIX = Buffer.from('527a104a5b3209e0', 'hex');
const ROBLOX_TRAILER = Buffer.from('d066c6d3e10d461e30066c5e84906662a07ed1a7e2a2acd2', 'hex');
const ROBLOX_VERSION = 9;
const OPCODE_KEY = 227;
const AUX_OPS = new Set([7, 8, 12, 15, 16, 20, 27, 28, 29, 30, 31, 32, 53, 55, 58, 60, 66, 74, 75, 77, 78, 79, 80, 83, 84, 85, 86, 87, 88, 90, 91, 93, 94]);
const MAX_ROBLOX_OP = 82;

function layout(buf) {
  let o = 0;
  const u8 = () => buf[o++];
  const varint = () => {
    let r = 0, s = 0;
    for (;;) {
      const b = buf[o++];
      r += (b & 0x7f) * 2 ** s;
      s += 7;
      if (b < 0x80) return r;
    }
  };
  const version = u8();
  if (version < 3 || version > 14) throw new Error(`unsupported Luau bytecode version ${version}`);
  const typesVersion = version >= 4 ? u8() : 0;
  const stringCount = varint();
  for (let k = 0; k < stringCount; k++) {
    const length = varint();
    o += length;
  }
  if (typesVersion === 3) {
    for (let idx = u8(); idx !== 0; idx = u8()) varint();
  }
  const protoCount = varint();
  const headerEnd = o;
  const protos = [];
  for (let p = 0; p < protoCount; p++) {
    const size = version >= 12 ? varint() : 0;
    const start = o;
    o += 4;
    if (version >= 4) {
      o++;
      const typeSize = varint();
      o += typeSize;
    }
    const count = varint();
    const codeOffset = o;
    o += 4 * count;
    const sizek = varint();
    for (let k = 0; k < sizek; k++) {
      const t = u8();
      if (t === 1) o++;
      else if (t === 2) o += 8;
      else if (t === 3 || t === 6) varint();
      else if (t === 4) o += 4;
      else if (t === 5) { const n = varint(); for (let q = 0; q < n; q++) varint(); }
      else if (t === 7) o += 16;
      else if (t === 8) { const n = varint(); for (let q = 0; q < n; q++) { varint(); o += 4; } }
      else if (t === 9) { o++; while (buf[o++] >= 0x80); }
      else if (t === 11) o += 32;
      else if (t !== 0) throw new Error(`unknown constant type ${t}`);
    }
    const sizep = varint();
    for (let k = 0; k < sizep; k++) varint();
    varint();
    varint();
    if (u8()) {
      const gap = u8();
      o += count + 4 * (((count - 1) >> gap) + 1);
    }
    if (u8()) {
      const locals = varint();
      for (let k = 0; k < locals; k++) { varint(); varint(); varint(); o++; }
      const upvalues = varint();
      for (let k = 0; k < upvalues; k++) varint();
    }
    const bodyEnd = o;
    if (version >= 11) {
      const feedback = varint();
      if (feedback) throw new Error('feedback vectors cannot be expressed in Roblox bytecode; compile with LuauEmitCallFeedback=false');
    }
    if (version >= 12) o = start + size;
    protos.push({ start, codeOffset, count, bodyEnd });
  }
  return { version, headerEnd, protos, tail: o };
}

function downgrade(compiled) {
  const { version, headerEnd, protos, tail } = layout(compiled);
  if (version <= ROBLOX_VERSION) return Buffer.from(compiled);
  const header = Buffer.from(compiled.subarray(0, headerEnd));
  header[0] = ROBLOX_VERSION;
  return Buffer.concat([header, ...protos.map(p => compiled.subarray(p.start, p.bodyEnd)), compiled.subarray(tail)]);
}

function encodeForRoblox(compiled) {
  const out = downgrade(compiled);
  for (const { codeOffset, count } of layout(out).protos) {
    for (let pc = 0; pc < count; pc++) {
      const at = codeOffset + pc * 4;
      const op = out[at];
      if (op > MAX_ROBLOX_OP) throw new Error(`opcode ${op} is newer than Roblox bytecode version ${ROBLOX_VERSION}`);
      out[at] = (op * OPCODE_KEY) & 0xff;
      if (AUX_OPS.has(op)) pc++;
    }
  }
  return Buffer.concat([ROBLOX_PREFIX, out, ROBLOX_TRAILER]);
}

function withEngineTrailer(source) {
  const body = source.subarray(ROBLOX_PREFIX.length);
  const { tail } = layout(body);
  let end = tail;
  while (body[end] >= 0x80) end++;
  end++;
  return Buffer.concat([source.subarray(0, ROBLOX_PREFIX.length), body.subarray(0, end), ROBLOX_TRAILER]);
}

const COMPILE_FLAGS = [
  'LuauEmitCallFeedback=false',
  'LuauCompileFastpcall=false',
  'LuauFastpcall=false',
  'LuauBytecodeCostModel=false',
  'LuauCompileCallFbRemap=false',
  'LuauCompileRefactorFeedback=false',
];

module.exports = { encodeForRoblox, COMPILE_FLAGS, withEngineTrailer };
