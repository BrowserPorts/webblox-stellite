const zlib = require('zlib');

function lz4(input, size) {
  const out = Buffer.alloc(size);
  let i = 0;
  let o = 0;
  while (i < input.length) {
    const token = input[i++];
    let literals = token >> 4;
    if (literals === 15) {
      let more;
      do { more = input[i++]; literals += more; } while (more === 255);
    }
    input.copy(out, o, i, i + literals);
    i += literals;
    o += literals;
    if (i >= input.length) break;
    const offset = input[i] | (input[i + 1] << 8);
    i += 2;
    let length = token & 15;
    if (length === 15) {
      let more;
      do { more = input[i++]; length += more; } while (more === 255);
    }
    length += 4;
    for (let k = 0; k < length; k++, o++) out[o] = out[o - offset];
  }
  return out;
}

function inflate(payload, compressed, size) {
  if (!compressed) return payload;
  if (payload[0] === 0x28 && payload[1] === 0xb5 && payload[2] === 0x2f && payload[3] === 0xfd) return zlib.zstdDecompressSync(payload);
  return lz4(payload, size);
}

class Reader {
  constructor(buffer) {
    this.b = buffer;
    this.at = 0;
  }
  u8() { return this.b[this.at++]; }
  u32() { const v = this.b.readUInt32LE(this.at); this.at += 4; return v; }
  f32() { const v = this.b.readFloatLE(this.at); this.at += 4; return v; }
  f64() { const v = this.b.readDoubleLE(this.at); this.at += 8; return v; }
  bytes(n) { const v = this.b.subarray(this.at, this.at + n); this.at += n; return v; }
  str() { return this.bytes(this.u32()); }
  text() { return this.str().toString('utf8'); }
  interleaved(count, width) {
    const raw = this.bytes(count * width);
    const out = Buffer.alloc(count * width);
    for (let i = 0; i < count; i++) for (let k = 0; k < width; k++) out[i * width + k] = raw[k * count + i];
    return out;
  }
  ints(count) {
    const raw = this.interleaved(count, 4);
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const u = raw.readUInt32BE(i * 4);
      out[i] = (u >>> 1) ^ -(u & 1);
    }
    return out;
  }
  floats(count) {
    const raw = this.interleaved(count, 4);
    const scratch = Buffer.alloc(4);
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const u = raw.readUInt32BE(i * 4);
      scratch.writeUInt32LE(((u >>> 1) | (u << 31)) >>> 0);
      out[i] = scratch.readFloatLE(0);
    }
    return out;
  }
  refs(count) {
    const out = this.ints(count);
    for (let i = 1; i < count; i++) out[i] += out[i - 1];
    return out;
  }
}

const NORMALS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];

function specialRotation(id) {
  const x = NORMALS[Math.floor((id - 1) / 6)];
  const y = NORMALS[(id - 1) % 6];
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

function readCFrames(r, count) {
  const rotations = [];
  for (let i = 0; i < count; i++) {
    const id = r.u8();
    if (id === 0) {
      const m = [];
      for (let k = 0; k < 9; k++) m.push(r.f32());
      rotations.push(m);
    } else rotations.push(specialRotation(id));
  }
  const xs = r.floats(count);
  const ys = r.floats(count);
  const zs = r.floats(count);
  return rotations.map((m, i) => [xs[i], ys[i], zs[i], ...m]);
}

function readValues(r, type, count, strings) {
  switch (type) {
    case 0x01: {
      const out = [];
      for (let i = 0; i < count; i++) out.push(r.str());
      return out.map(b => {
        const text = b.toString('utf8');
        return Buffer.byteLength(text) === b.length && !text.includes('\ufffd') ? text : Buffer.from(b);
      });
    }
    case 0x02: {
      const out = [];
      for (let i = 0; i < count; i++) out.push(r.u8() !== 0);
      return out;
    }
    case 0x03: return r.ints(count);
    case 0x04: return r.floats(count);
    case 0x05: {
      const out = [];
      for (let i = 0; i < count; i++) out.push(r.f64());
      return out;
    }
    case 0x0b: {
      const raw = r.interleaved(count, 4);
      const out = [];
      for (let i = 0; i < count; i++) out.push(raw.readUInt32BE(i * 4));
      return out;
    }
    case 0x0c:
    case 0x0e: {
      const a = r.floats(count);
      const b = r.floats(count);
      const c = r.floats(count);
      return a.map((v, i) => [v, b[i], c[i]]);
    }
    case 0x0d: {
      const a = r.floats(count);
      const b = r.floats(count);
      return a.map((v, i) => [v, b[i]]);
    }
    case 0x10: return readCFrames(r, count);
    case 0x12: {
      const raw = r.interleaved(count, 4);
      const out = [];
      for (let i = 0; i < count; i++) out.push(raw.readUInt32BE(i * 4));
      return out;
    }
    case 0x13: return r.refs(count).map(v => ({ ref: v }));
    case 0x1a: {
      const a = r.bytes(count);
      const b = r.bytes(count);
      const c = r.bytes(count);
      return Array.from(a, (v, i) => [v / 255, b[i] / 255, c[i] / 255]);
    }
    case 0x1c: {
      const raw = r.interleaved(count, 4);
      const out = [];
      for (let i = 0; i < count; i++) out.push({ shared: strings[raw.readUInt32BE(i * 4)] });
      return out;
    }
    case 0x1e: {
      r.u8();
      const frames = readCFrames(r, count);
      r.u8();
      const present = [];
      for (let i = 0; i < count; i++) present.push(r.u8() !== 0);
      return frames.map((f, i) => (present[i] ? f : null));
    }
    case 0x22: {
      const sources = r.ints(count);
      const uriCount = r.u32();
      const uris = [];
      for (let i = 0; i < uriCount; i++) uris.push(r.text());
      let next = 0;
      return sources.map(source => (source === 1 ? uris[next++] : ''));
    }
    default: return null;
  }
}

function parseBinary(data) {
  const classes = new Map();
  const instances = new Map();
  const strings = [];
  let at = 32;
  let parents = null;
  const props = [];
  while (at < data.length) {
    const name = data.toString('latin1', at, at + 4);
    const compressed = data.readUInt32LE(at + 4);
    const size = data.readUInt32LE(at + 8);
    const stored = compressed || size;
    const body = inflate(data.subarray(at + 16, at + 16 + stored), compressed !== 0, size);
    at += 16 + stored;
    if (name === 'END\0') break;
    const r = new Reader(body);
    if (name === 'SSTR') {
      r.u32();
      const count = r.u32();
      for (let i = 0; i < count; i++) {
        r.bytes(16);
        strings.push(r.str());
      }
    } else if (name === 'INST') {
      const id = r.u32();
      const className = r.text();
      r.u8();
      const count = r.u32();
      const refs = r.refs(count);
      classes.set(id, { className, refs });
      for (const ref of refs) instances.set(ref, { ref, className, props: {}, children: [], parent: null });
    } else if (name === 'PROP') props.push(body);
    else if (name === 'PRNT') {
      r.u8();
      const count = r.u32();
      parents = { refs: r.refs(count), to: r.refs(count) };
    }
  }
  for (const body of props) {
    const r = new Reader(body);
    const cls = classes.get(r.u32());
    if (!cls) continue;
    const prop = r.text();
    const type = r.u8();
    let values = null;
    try { values = readValues(r, type, cls.refs.length, strings); } catch { values = null; }
    if (!values) continue;
    cls.refs.forEach((ref, i) => { instances.get(ref).props[prop] = values[i]; });
  }
  const roots = [];
  if (parents) {
    parents.refs.forEach((ref, i) => {
      const inst = instances.get(ref);
      if (!inst) return;
      const parent = instances.get(parents.to[i]);
      inst.parent = parent || null;
      if (parent) parent.children.push(inst);
      else roots.push(inst);
    });
  }
  for (const inst of instances.values()) {
    for (const [key, value] of Object.entries(inst.props)) {
      if (value && value.ref !== undefined) inst.props[key] = instances.get(value.ref) || null;
    }
  }
  return { roots, instances: [...instances.values()] };
}

function decodeXml(text) {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]));
}

function parseXml(data) {
  const text = data.toString('utf8');
  const instances = [];
  const roots = [];
  const stack = [];
  const refs = new Map();
  const tag = /<Item\s+class="([^"]+)"(?:\s+referent="([^"]+)")?\s*>|<\/Item>|<Properties>([\s\S]*?)<\/Properties>/g;
  let m;
  while ((m = tag.exec(text))) {
    if (m[1]) {
      const inst = { ref: m[2], className: m[1], props: {}, children: [], parent: stack[stack.length - 1] || null };
      instances.push(inst);
      if (m[2]) refs.set(m[2], inst);
      if (inst.parent) inst.parent.children.push(inst);
      else roots.push(inst);
      stack.push(inst);
    } else if (m[3] !== undefined) {
      const inst = stack[stack.length - 1];
      if (!inst) continue;
      const prop = /<(\w+)\s+name="([^"]+)"\s*>([\s\S]*?)<\/\1>/g;
      let p;
      while ((p = prop.exec(m[3]))) {
        const body = p[3];
        const url = /<url>([\s\S]*?)<\/url>/.exec(body);
        if (p[1] === 'Content') inst.props[p[2]] = url ? decodeXml(url[1]) : '';
        else if (p[1] === 'string') inst.props[p[2]] = decodeXml(body);
        else if (p[1] === 'float' || p[1] === 'double' || p[1] === 'int') inst.props[p[2]] = Number(body);
        else if (p[1] === 'bool') inst.props[p[2]] = body.trim() === 'true';
        else if (p[1] === 'Vector3') {
          const v = name => Number((new RegExp(`<${name}>([^<]*)</${name}>`).exec(body) || [])[1]);
          inst.props[p[2]] = [v('X'), v('Y'), v('Z')];
        } else if (p[1] === 'CoordinateFrame') {
          inst.props[p[2]] = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22']
            .map(name => Number((new RegExp(`<${name}>([^<]*)</${name}>`).exec(body) || [])[1]));
        } else if (p[1] === 'Ref') inst.props[p[2]] = { xmlRef: body.trim() };
      }
    } else stack.pop();
  }
  for (const inst of instances) {
    for (const [key, value] of Object.entries(inst.props)) {
      if (value && value.xmlRef !== undefined) inst.props[key] = refs.get(value.xmlRef) || null;
    }
  }
  return { roots, instances };
}

function parseModel(data) {
  if (data.toString('latin1', 0, 8) === '<roblox!') return parseBinary(data);
  return parseXml(data);
}

module.exports = { parseModel };
