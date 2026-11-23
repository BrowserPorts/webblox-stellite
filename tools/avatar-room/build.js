#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { BASE, ENGINE_DIR, PORT } = require('../../server/config');

const PLACE = path.join(ENGINE_DIR, 'ExtraContent', 'places', 'Mobile.rbxl');
const RAW_DIR = path.join(BASE, '.cache', 'avatar-room');
const OUTPUT_DIR = path.join(BASE, 'public', 'assets', 'classic', 'avatar-room');
const TOKEN_FILE = path.join(BASE, '.cache', 'proxy-token');
const ROOM_YAW = -2.2689280275926285;
const UNION_KEY = [86, 46, 110, 88, 49, 32, 48, 4, 52, 105, 12, 119, 12, 1, 94, 0, 26, 96, 55, 105, 29, 82, 43, 7, 79, 36, 89, 101, 83, 4, 122];
const UNION_HEADER = 42;
const CYLINDER_SEGMENTS = 32;
const SPHERE_RINGS = 12;
const SPHERE_SEGMENTS = 24;
const DECAL_LIFT = 0.012;
const FACE_LIFT = 0.008;
const DDS_HEADER = 128;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const NEON = 288;

const FACES = [
  { normal: [1, 0, 0], u: [0, 0, -1], v: [0, -1, 0] },
  { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { normal: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0] },
  { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, -1, 0] },
  { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { normal: [0, 0, -1], u: [-1, 0, 0], v: [0, -1, 0] },
];

function lz4(source, size) {
  const out = Buffer.alloc(size);
  let s = 0;
  let d = 0;
  while (s < source.length) {
    const token = source[s++];
    let literal = token >> 4;
    if (literal === 15) {
      let more;
      do { more = source[s++]; literal += more; } while (more === 255);
    }
    source.copy(out, d, s, s + literal);
    s += literal;
    d += literal;
    if (s >= source.length) break;
    const offset = source.readUInt16LE(s);
    s += 2;
    let length = token & 15;
    if (length === 15) {
      let more;
      do { more = source[s++]; length += more; } while (more === 255);
    }
    length += 4;
    for (let i = 0; i < length; i++) {
      out[d] = out[d - offset];
      d++;
    }
  }
  return out;
}

function readChunks(data) {
  const chunks = [];
  let at = 32;
  while (at < data.length) {
    const name = data.toString('latin1', at, at + 4);
    const compressed = data.readUInt32LE(at + 4);
    const size = data.readUInt32LE(at + 8);
    const payload = data.subarray(at + 16, at + 16 + (compressed || size));
    let body = payload;
    if (compressed) body = payload[0] === 0x28 && payload[1] === 0xb5 ? zlib.zstdDecompressSync(payload) : lz4(payload, size);
    chunks.push({ name, body });
    at += 16 + (compressed || size);
    if (name === 'END\0') break;
  }
  return chunks;
}

const unzigzag = value => (value >>> 1) ^ -(value & 1);

function interleaved(body, at, count) {
  const values = [];
  for (let k = 0; k < count; k++) {
    values.push(((body[at + k] * 2 ** 24) + (body[at + count + k] << 16) + (body[at + 2 * count + k] << 8) + body[at + 3 * count + k]) >>> 0);
  }
  return values;
}

function refs(body, at, count) {
  let total = 0;
  return interleaved(body, at, count).map(value => {
    total += unzigzag(value);
    return total;
  });
}

function floats(body, at, count) {
  const scratch = Buffer.alloc(4);
  return interleaved(body, at, count).map(value => {
    scratch.writeUInt32BE(((value >>> 1) | (value << 31)) >>> 0);
    return scratch.readFloatBE(0);
  });
}

function rotationFromId(id) {
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];
  const x = axes[Math.floor((id - 1) / 6)];
  const y = axes[(id - 1) % 6];
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

function readProperty(body, at, type, count) {
  const out = [];
  if (type === 0x01) {
    let cursor = at;
    for (let i = 0; i < count; i++) {
      const length = body.readUInt32LE(cursor);
      out.push(body.subarray(cursor + 4, cursor + 4 + length));
      cursor += 4 + length;
    }
  } else if (type === 0x02) {
    for (let i = 0; i < count; i++) out.push(body[at + i] !== 0);
  } else if (type === 0x04) {
    return floats(body, at, count);
  } else if (type === 0x12) {
    return interleaved(body, at, count);
  } else if (type === 0x0c || type === 0x0e) {
    const x = floats(body, at, count);
    const y = floats(body, at + 4 * count, count);
    const z = floats(body, at + 8 * count, count);
    for (let i = 0; i < count; i++) out.push([x[i], y[i], z[i]]);
  } else if (type === 0x0d) {
    const x = floats(body, at, count);
    const y = floats(body, at + 4 * count, count);
    for (let i = 0; i < count; i++) out.push([x[i], y[i]]);
  } else if (type === 0x15 || type === 0x16) {
    const fields = type === 0x15 ? 3 : 5;
    let cursor = at;
    for (let i = 0; i < count; i++) {
      const points = body.readUInt32LE(cursor);
      cursor += 4;
      const sequence = [];
      for (let k = 0; k < points; k++) {
        const values = [];
        for (let field = 0; field < fields; field++) values.push(body.readFloatLE(cursor + field * 4));
        sequence.push(values);
        cursor += fields * 4;
      }
      out.push(sequence);
    }
  } else if (type === 0x17) {
    for (let i = 0; i < count; i++) out.push([body.readFloatLE(at + i * 8), body.readFloatLE(at + i * 8 + 4)]);
  } else if (type === 0x1a) {
    for (let i = 0; i < count; i++) out.push([body[at + i], body[at + count + i], body[at + 2 * count + i]]);
  } else if (type === 0x10) {
    let cursor = at;
    const rotations = [];
    for (let i = 0; i < count; i++) {
      const id = body[cursor++];
      if (id) rotations.push(rotationFromId(id));
      else {
        const matrix = [];
        for (let k = 0; k < 9; k++) matrix.push(body.readFloatLE(cursor + k * 4));
        cursor += 36;
        rotations.push(matrix);
      }
    }
    const x = floats(body, cursor, count);
    const y = floats(body, cursor + 4 * count, count);
    const z = floats(body, cursor + 8 * count, count);
    for (let i = 0; i < count; i++) out.push({ rotation: rotations[i], position: [x[i], y[i], z[i]] });
  } else {
    return null;
  }
  return out;
}

function parseModel(data) {
  const chunks = readChunks(data);
  const classes = new Map();
  const instances = new Map();
  for (const { body } of chunks.filter(chunk => chunk.name === 'INST')) {
    const nameLength = body.readUInt32LE(4);
    const className = body.toString('latin1', 8, 8 + nameLength);
    const count = body.readUInt32LE(9 + nameLength);
    const ids = refs(body, 13 + nameLength, count);
    classes.set(body.readUInt32LE(0), ids);
    for (const id of ids) instances.set(id, { id, className, props: {}, children: [], parent: null });
  }
  for (const { body } of chunks.filter(chunk => chunk.name === 'PROP')) {
    const ids = classes.get(body.readUInt32LE(0));
    if (!ids) continue;
    const nameLength = body.readUInt32LE(4);
    const name = body.toString('latin1', 8, 8 + nameLength);
    const values = readProperty(body, 9 + nameLength, body[8 + nameLength], ids.length);
    if (values) ids.forEach((id, index) => { instances.get(id).props[name] = values[index]; });
  }
  const parents = chunks.find(chunk => chunk.name === 'PRNT').body;
  const count = parents.readUInt32LE(1);
  const children = refs(parents, 5, count);
  const owners = refs(parents, 5 + 4 * count, count);
  children.forEach((child, index) => {
    const node = instances.get(child);
    const owner = instances.get(owners[index]);
    node.parent = owner || null;
    if (owner) owner.children.push(node);
  });
  return instances;
}

const text = value => (value ? value.toString('latin1') : '');
const assetId = value => text(value).match(/(?:id=|rbxassetid:\/\/)(\d+)/)?.[1] || null;

async function asset(id) {
  const file = path.join(RAW_DIR, id);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const url = `http://localhost:${PORT}/__proxy__/https://assetdelivery.roblox.com/v1/asset/?id=${id}`;
  const response = await fetch(url, { headers: { Cookie: `webblox_token=${token}`, 'Accept-Encoding': 'identity' } });
  if (!response.ok) throw new Error(`asset ${id} returned ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(file, data);
  return data;
}

function parseFileMesh(data) {
  const header = data.toString('latin1', 0, 12);
  if (header.startsWith('version 1.')) {
    const scale = header.startsWith('version 1.00') ? 0.5 : 1;
    const lines = data.toString('latin1').split(/\r?\n/);
    const numbers = lines[2].match(/-?[\d.]+(?:e[-+]?\d+)?/gi).map(Number);
    const triangles = [];
    for (let at = 0; at + 9 <= numbers.length; at += 9) {
      triangles.push({
        position: [numbers[at] * scale, numbers[at + 1] * scale, numbers[at + 2] * scale],
        normal: [numbers[at + 3], numbers[at + 4], numbers[at + 5]],
        uv: [numbers[at + 6], 1 - numbers[at + 7]],
      });
    }
    return triangles;
  }
  if (!header.startsWith('version 2.')) throw new Error(`unsupported mesh ${header}`);
  const start = data.indexOf(0x0a) + 1;
  const headerSize = data.readUInt16LE(start);
  const stride = data[start + 2];
  const vertexCount = data.readUInt32LE(start + 4);
  const faceCount = data.readUInt32LE(start + 8);
  const vertices = start + headerSize;
  const faces = vertices + vertexCount * stride;
  const triangles = [];
  for (let face = 0; face < faceCount; face++) {
    for (let corner = 0; corner < 3; corner++) {
      const at = vertices + data.readUInt32LE(faces + face * 12 + corner * 4) * stride;
      triangles.push({
        position: [data.readFloatLE(at), data.readFloatLE(at + 4), data.readFloatLE(at + 8)],
        normal: [data.readFloatLE(at + 12), data.readFloatLE(at + 16), data.readFloatLE(at + 20)],
        uv: [data.readFloatLE(at + 24), data.readFloatLE(at + 28)],
      });
    }
  }
  return triangles;
}

function parseUnion(data) {
  const operation = [...parseModel(data).values()].find(node => node.className === 'PartOperationAsset');
  const mesh = Buffer.from(operation.props.MeshData);
  for (let i = 0; i < mesh.length; i++) mesh[i] ^= UNION_KEY[i % UNION_KEY.length];
  if (mesh.toString('latin1', 0, 6) !== 'CSGMDL') throw new Error('union is not CSGMDL');
  const vertexCount = mesh.readUInt32LE(UNION_HEADER);
  const stride = mesh.readUInt32LE(UNION_HEADER + 4);
  const vertices = UNION_HEADER + 8;
  const indices = vertices + vertexCount * stride;
  const indexCount = mesh.readUInt32LE(indices);
  const corners = [];
  for (let i = 0; i < indexCount; i++) {
    const at = vertices + mesh.readUInt32LE(indices + 4 + i * 4) * stride;
    corners.push({
      position: [mesh.readFloatLE(at), mesh.readFloatLE(at + 4), mesh.readFloatLE(at + 8)],
      normal: [mesh.readFloatLE(at + 12), mesh.readFloatLE(at + 16), mesh.readFloatLE(at + 20)],
      color: [mesh[at + 24], mesh[at + 25], mesh[at + 26]],
      uv: [mesh.readFloatLE(at + 32), mesh.readFloatLE(at + 36)],
    });
  }
  return corners;
}

function boxCorners(size) {
  const half = size.map(value => value / 2);
  const corners = [];
  for (const { normal, u, v } of FACES) {
    const point = (a, b) => [0, 1, 2].map(axis => (normal[axis] + u[axis] * a + v[axis] * b) * half[axis]);
    const quad = [point(-1, -1), point(1, -1), point(1, 1), point(-1, 1)];
    const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const index of [0, 2, 1, 0, 3, 2]) corners.push({ position: quad[index], normal, uv: uvs[index] });
  }
  return corners;
}

function cylinderCorners(radiusA, radiusB, length, axis) {
  const corners = [];
  const place = (along, a, b) => (axis === 'x' ? [along, a, b] : [a, along, b]);
  const flip = axis === 'x' ? 1 : -1;
  for (let i = 0; i < CYLINDER_SEGMENTS; i++) {
    const one = (i / CYLINDER_SEGMENTS) * Math.PI * 2;
    const two = ((i + 1) / CYLINDER_SEGMENTS) * Math.PI * 2;
    const ring = angle => [Math.cos(angle) * radiusA, Math.sin(angle) * radiusB];
    const side = angle => {
      const n = [Math.cos(angle) / radiusA, Math.sin(angle) / radiusB];
      const size = Math.hypot(n[0], n[1]);
      return place(0, n[0] / size, n[1] / size);
    };
    const [a1, b1] = ring(one);
    const [a2, b2] = ring(two);
    const half = length / 2;
    const quad = [
      { position: place(-half, a1, b1), normal: side(one), uv: [i / CYLINDER_SEGMENTS, 1] },
      { position: place(half, a1, b1), normal: side(one), uv: [i / CYLINDER_SEGMENTS, 0] },
      { position: place(half, a2, b2), normal: side(two), uv: [(i + 1) / CYLINDER_SEGMENTS, 0] },
      { position: place(-half, a2, b2), normal: side(two), uv: [(i + 1) / CYLINDER_SEGMENTS, 1] },
    ];
    const order = flip > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    for (const index of order) corners.push(quad[index]);
    const capA = place(1, 0, 0);
    const capB = place(-1, 0, 0);
    const disc = (a, b) => [0.5 + a / (2 * radiusA), 0.5 + b / (2 * radiusB)];
    const top = [
      { position: place(half, 0, 0), normal: capA, uv: [0.5, 0.5] },
      { position: place(half, a1, b1), normal: capA, uv: disc(a1, b1) },
      { position: place(half, a2, b2), normal: capA, uv: disc(a2, b2) },
    ];
    const bottom = [
      { position: place(-half, 0, 0), normal: capB, uv: [0.5, 0.5] },
      { position: place(-half, a2, b2), normal: capB, uv: disc(a2, b2) },
      { position: place(-half, a1, b1), normal: capB, uv: disc(a1, b1) },
    ];
    corners.push(...(flip > 0 ? top : [top[0], top[2], top[1]]), ...(flip > 0 ? bottom : [bottom[0], bottom[2], bottom[1]]));
  }
  return corners;
}

function sphereCorners(size) {
  const corners = [];
  const point = (ring, segment) => {
    const pitch = (ring / SPHERE_RINGS) * Math.PI;
    const yaw = (segment / SPHERE_SEGMENTS) * Math.PI * 2;
    const unit = [Math.sin(pitch) * Math.cos(yaw), Math.cos(pitch), Math.sin(pitch) * Math.sin(yaw)];
    const normal = [unit[0] / size[0], unit[1] / size[1], unit[2] / size[2]];
    const length = Math.hypot(...normal);
    return { position: unit.map((value, axis) => (value * size[axis]) / 2), normal: normal.map(value => value / length), uv: [segment / SPHERE_SEGMENTS, ring / SPHERE_RINGS] };
  };
  for (let ring = 0; ring < SPHERE_RINGS; ring++) {
    for (let segment = 0; segment < SPHERE_SEGMENTS; segment++) {
      const a = point(ring, segment);
      const b = point(ring + 1, segment);
      const c = point(ring + 1, segment + 1);
      const d = point(ring, segment + 1);
      corners.push(a, c, b, a, d, c);
    }
  }
  return corners;
}

const batches = new Map();

function batch({ material, transparency, texture, tiled = false }) {
  const key = `${material}|${transparency.toFixed(2)}|${texture || ''}|${tiled}`;
  if (!batches.has(key)) batches.set(key, { material, transparency, texture, tiled, positions: [], normals: [], uvs: [], colors: [] });
  return batches.get(key);
}

function multiply(rotation, [x, y, z]) {
  return [
    rotation[0] * x + rotation[1] * y + rotation[2] * z,
    rotation[3] * x + rotation[4] * y + rotation[5] * z,
    rotation[6] * x + rotation[7] * y + rotation[8] * z,
  ];
}

function emit(target, corners, frame, color, transform = {}) {
  const { scale = [1, 1, 1], offset = [0, 0, 0], lift = 0 } = transform;
  for (const corner of corners) {
    const scaled = corner.position.map((value, axis) => value * scale[axis] + offset[axis]);
    const inverse = corner.normal.map((value, axis) => value / (scale[axis] || 1));
    const size = Math.hypot(...inverse) || 1;
    const normal = multiply(frame.rotation, inverse.map(value => value / size));
    const world = multiply(frame.rotation, scaled).map((value, axis) => value + frame.position[axis] + normal[axis] * lift);
    target.positions.push(...world);
    target.normals.push(...normal);
    target.uvs.push(...corner.uv);
    target.colors.push(...(corner.color && !color ? corner.color : color));
  }
}

function faceQuad(size, face, stud) {
  const { normal, u, v } = FACES[face];
  const half = size.map(value => value / 2);
  const width = Math.abs(u[0]) * size[0] + Math.abs(u[1]) * size[1] + Math.abs(u[2]) * size[2];
  const height = Math.abs(v[0]) * size[0] + Math.abs(v[1]) * size[1] + Math.abs(v[2]) * size[2];
  const point = (a, b) => [0, 1, 2].map(axis => (normal[axis] + u[axis] * a + v[axis] * b) * half[axis]);
  const uvAt = (a, b) => (stud ? [((a + 1) / 2) * width / stud[0], ((b + 1) / 2) * height / stud[1]] : [(a + 1) / 2, (b + 1) / 2]);
  const quad = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({ position: point(a, b), normal, uv: uvAt(a, b) }));
  return [quad[0], quad[2], quad[1], quad[0], quad[3], quad[2]];
}

function dominantFace(normal) {
  const axis = [0, 1, 2].reduce((best, index) => (Math.abs(normal[index]) > Math.abs(normal[best]) ? index : best), 0);
  const positive = normal[axis] > 0;
  return [positive ? 0 : 3, positive ? 1 : 4, positive ? 2 : 5][axis];
}

function alignment(parts) {
  const rugs = parts.filter(part => text(part.props.Name) === 'Rug-Round');
  if (!rugs.length) throw new Error('Rug-Round not found');
  let x = 0;
  let z = 0;
  let top = -Infinity;
  for (const rug of rugs) {
    const { rotation, position } = rug.props.CFrame;
    x += position[0];
    z += position[2];
    const size = rug.props.size;
    top = Math.max(top, position[1] + (Math.abs(rotation[3]) * size[0] + Math.abs(rotation[4]) * size[1] + Math.abs(rotation[5]) * size[2]) / 2);
  }
  const cos = Math.cos(ROOM_YAW);
  const sin = Math.sin(ROOM_YAW);
  return {
    rotation: [cos, 0, sin, 0, 1, 0, -sin, 0, cos],
    translate: [-x / rugs.length, -top, -z / rugs.length],
  };
}

function aligned(frame, align) {
  const moved = frame.position.map((value, axis) => value + align.translate[axis]);
  const r = align.rotation;
  const f = frame.rotation;
  return {
    position: multiply(r, moved),
    rotation: [
      r[0] * f[0] + r[1] * f[3] + r[2] * f[6], r[0] * f[1] + r[1] * f[4] + r[2] * f[7], r[0] * f[2] + r[1] * f[5] + r[2] * f[8],
      r[3] * f[0] + r[4] * f[3] + r[5] * f[6], r[3] * f[1] + r[4] * f[4] + r[5] * f[7], r[3] * f[2] + r[4] * f[5] + r[5] * f[8],
      r[6] * f[0] + r[7] * f[3] + r[8] * f[6], r[6] * f[1] + r[7] * f[4] + r[8] * f[7], r[6] * f[2] + r[7] * f[5] + r[8] * f[8],
    ],
  };
}

const scaleColor = (color, tint) => color.map((value, index) => Math.min(255, value * (tint?.[index] ?? 1)));
const to255 = color => (color ? color.map(value => Math.round(value * 255)) : [255, 255, 255]);

async function bakePart(part, frame) {
  const { props, children } = part;
  const size = props.size;
  const material = props.Material;
  const transparency = props.Transparency || 0;
  const color = props.Color3uint8;
  const block = children.find(child => child.className === 'BlockMesh');
  const cylinder = children.find(child => child.className === 'CylinderMesh');
  const special = children.find(child => child.className === 'SpecialMesh');
  let shapeSize = size;
  if (special && special.props.MeshType === 5) {
    const id = assetId(special.props.MeshId);
    if (id) {
      const corners = parseFileMesh(await asset(id));
      const textureId = assetId(special.props.TextureId);
      const target = batch({ material, transparency, texture: textureId });
      emit(target, corners, frame, textureId ? scaleColor([255, 255, 255], special.props.VertexColor) : scaleColor(color, special.props.VertexColor), { scale: special.props.Scale, offset: special.props.Offset });
      if (textureId) used.add(textureId);
    }
  } else if (special && special.props.MeshType === 3) {
    shapeSize = size.map((value, axis) => value * special.props.Scale[axis]);
    emit(batch({ material, transparency }), sphereCorners(shapeSize), frame, color, { offset: special.props.Offset });
  } else if (cylinder) {
    shapeSize = size.map((value, axis) => value * cylinder.props.Scale[axis]);
    emit(batch({ material, transparency }), cylinderCorners(shapeSize[0] / 2, shapeSize[2] / 2, shapeSize[1], 'y'), frame, color, { offset: cylinder.props.Offset });
  } else if (props.shape === 0) {
    emit(batch({ material, transparency }), sphereCorners(size), frame, color);
  } else if (props.shape === 2) {
    emit(batch({ material, transparency }), cylinderCorners(size[1] / 2, size[2] / 2, size[0], 'x'), frame, color);
  } else {
    if (block) shapeSize = size.map((value, axis) => value * block.props.Scale[axis]);
    emit(batch({ material, transparency }), boxCorners(shapeSize), frame, color, { offset: block?.props.Offset });
  }
  for (const child of children) {
    if (child.className !== 'Decal' && child.className !== 'Texture') continue;
    const id = assetId(child.props.Texture);
    if (!id) continue;
    used.add(id);
    const tiled = child.className === 'Texture';
    const stud = tiled ? [child.props.StudsPerTileU || 1, child.props.StudsPerTileV || 1] : null;
    const target = batch({ material: 272, transparency: child.props.Transparency || 0, texture: id, tiled });
    emit(target, faceQuad(shapeSize, child.props.Face ?? 5, stud), frame, to255(child.props.Color3), { lift: DECAL_LIFT });
  }
}

async function bakeUnion(part, frame) {
  const { props, children } = part;
  const id = assetId(props.AssetId);
  if (!id) return;
  const corners = parseUnion(await asset(id));
  const initial = props.InitialSize || props.size;
  const scale = props.size.map((value, axis) => value / (initial[axis] || value || 1));
  const transparency = props.Transparency || 0;
  emit(batch({ material: props.Material, transparency }), corners, frame, props.UsePartColor ? props.Color3uint8 : null, { scale });
  for (const child of children) {
    if (child.className !== 'Texture' && child.className !== 'Decal') continue;
    const texture = assetId(child.props.Texture);
    if (!texture) continue;
    used.add(texture);
    const tiled = child.className === 'Texture';
    const stud = tiled ? [child.props.StudsPerTileU || 1, child.props.StudsPerTileV || 1] : [1, 1];
    const face = child.props.Face ?? 5;
    const selected = [];
    for (let at = 0; at + 3 <= corners.length; at += 3) {
      const trio = corners.slice(at, at + 3);
      if (dominantFace(trio[0].normal) !== face) continue;
      selected.push(...trio.map(corner => ({ ...corner, uv: [corner.uv[0] / stud[0], corner.uv[1] / stud[1]] })));
    }
    emit(batch({ material: 272, transparency: child.props.Transparency || 0, texture, tiled: true }), selected, frame, to255(child.props.Color3), { scale, lift: FACE_LIFT });
  }
}

const used = new Set();
const decoded = new Map();

function dxt5Pixels(data) {
  const height = data.readUInt32LE(12);
  const width = data.readUInt32LE(16);
  const pixels = Buffer.alloc(width * height * 4);
  const color565 = value => [((value >> 11) & 31) * 255 / 31, ((value >> 5) & 63) * 255 / 63, (value & 31) * 255 / 31];
  let at = DDS_HEADER;
  for (let blockY = 0; blockY < height; blockY += 4) {
    for (let blockX = 0; blockX < width; blockX += 4) {
      const a0 = data[at];
      const a1 = data[at + 1];
      const alphas = [a0, a1];
      for (let step = 1; step <= 6; step++) alphas.push(a0 > a1 ? ((7 - step) * a0 + step * a1) / 7 : step <= 4 ? ((5 - step) * a0 + step * a1) / 5 : step === 5 ? 0 : 255);
      const alphaBits = data.readUIntLE(at + 2, 6);
      const c0 = data.readUInt16LE(at + 8);
      const c1 = data.readUInt16LE(at + 10);
      const one = color565(c0);
      const two = color565(c1);
      const colors = [one, two, one.map((value, index) => (2 * value + two[index]) / 3), one.map((value, index) => (value + 2 * two[index]) / 3)];
      const colorBits = data.readUInt32LE(at + 12);
      for (let index = 0; index < 16; index++) {
        const x = blockX + index % 4;
        const y = blockY + Math.floor(index / 4);
        if (x >= width || y >= height) continue;
        const color = colors[(colorBits >>> (index * 2)) & 3];
        const alpha = alphas[Math.floor(alphaBits / 2 ** (index * 3)) & 7];
        pixels.set([color[0], color[1], color[2], alpha].map(Math.round), (y * width + x) * 4);
      }
      at += 16;
    }
  }
  return { width, height, pixels };
}

function encodePng({ width, height, pixels }) {
  const chunk = (name, body) => {
    const named = Buffer.concat([Buffer.from(name, 'latin1'), body]);
    const out = Buffer.alloc(named.length + 8);
    out.writeUInt32BE(body.length, 0);
    named.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(named), named.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function particleTexture(value) {
  const id = assetId(value);
  if (id) {
    await asset(id);
    used.add(id);
    return `${id}.${extension(id)}`;
  }
  const relative = text(value).replace('rbxasset://', '');
  const name = `${path.basename(relative, path.extname(relative))}.png`;
  decoded.set(name, encodePng(dxt5Pixels(fs.readFileSync(path.join(ENGINE_DIR, 'content', relative)))));
  return name;
}

async function bakeEmitter(emitter, align) {
  const { props, parent } = emitter;
  const frame = aligned(parent.props.CFrame, align);
  return {
    texture: await particleTexture(props.Texture),
    rate: props.Rate,
    lifetime: props.Lifetime,
    size: props.Size,
    transparency: props.Transparency,
    color: props.Color,
    speed: props.Speed,
    spread: props.SpreadAngle || [0, 0],
    acceleration: multiply(align.rotation, props.Acceleration),
    drag: props.Drag,
    lightEmission: props.LightEmission,
    position: frame.position,
    rotation: frame.rotation,
    box: parent.props.size,
    direction: FACES[props.EmissionDirection].normal,
  };
}

function writeOutput(lights, emitters) {
  const sections = [];
  let offset = 0;
  const push = buffer => {
    const start = offset;
    sections.push(buffer);
    offset += buffer.length;
    return start;
  };
  const list = [];
  for (const entry of batches.values()) {
    if (!entry.positions.length || entry.transparency >= 1) continue;
    const count = entry.positions.length / 3;
    list.push({
      count,
      texture: entry.texture ? `${entry.texture}.${extension(entry.texture)}` : null,
      tiled: entry.tiled,
      opacity: 1 - entry.transparency,
      neon: entry.material === NEON,
      positions: push(Buffer.from(Float32Array.from(entry.positions).buffer)),
      normals: push(Buffer.from(Float32Array.from(entry.normals).buffer)),
      uvs: push(Buffer.from(Float32Array.from(entry.uvs).buffer)),
      colors: push(Buffer.from(Float32Array.from(entry.colors.map(value => value / 255)).buffer)),
    });
  }
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'room.bin'), Buffer.concat(sections));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'room.json'), JSON.stringify({ batches: list, lights, emitters }));
  for (const id of used) fs.copyFileSync(path.join(RAW_DIR, id), path.join(OUTPUT_DIR, `${id}.${extension(id)}`));
  for (const [name, data] of decoded) fs.writeFileSync(path.join(OUTPUT_DIR, name), data);
  const triangles = list.reduce((total, entry) => total + entry.count / 3, 0);
  console.log(`${list.length} batches, ${Math.round(triangles)} triangles, ${(offset / 1048576).toFixed(1)}MB geometry, ${used.size + decoded.size} textures, ${emitters.length} emitters`);
}

function extension(id) {
  const head = fs.readFileSync(path.join(RAW_DIR, id)).subarray(0, 4);
  return head[0] === 0x89 ? 'png' : 'jpg';
}

async function main() {
  const instances = parseModel(fs.readFileSync(PLACE));
  const storage = [...instances.values()].find(node => node.className === 'ReplicatedStorage');
  const folder = storage.children.find(node => text(node.props.Name) === 'AvatarEditorScene');
  const model = folder.children.find(node => text(node.props.Name) === 'Model');
  const nodes = [];
  const walk = node => {
    nodes.push(node);
    node.children.forEach(walk);
  };
  walk(model);
  const parts = nodes.filter(node => node.className === 'Part' || node.className === 'UnionOperation');
  const align = alignment(parts);
  for (const part of parts) {
    const frame = aligned(part.props.CFrame, align);
    if (part.className === 'Part') await bakePart(part, frame);
    else await bakeUnion(part, frame);
  }
  const lights = nodes.filter(node => node.className === 'PointLight' && node.props.Enabled !== false).map(light => ({
    position: aligned(light.parent.props.CFrame, align).position,
    color: light.props.Color || [1, 1, 1],
    brightness: light.props.Brightness,
    range: light.props.Range,
  }));
  const emitters = [];
  for (const node of nodes) {
    if (node.className === 'ParticleEmitter' && node.props.Enabled !== false) emitters.push(await bakeEmitter(node, align));
  }
  writeOutput(lights, emitters);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
