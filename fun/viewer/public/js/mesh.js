import * as THREE from 'three';
import { DRACOLoader } from '/vendor/three/DRACOLoader.js';

const draco = new DRACOLoader();
draco.setDecoderPath('/vendor/three/draco/');
draco.setDecoderConfig({ type: 'wasm' });

class Cursor {
  constructor(buffer, at = 0) {
    this.view = new DataView(buffer);
    this.buffer = buffer;
    this.at = at;
  }
  u8() { return this.view.getUint8(this.at++); }
  u16() { const v = this.view.getUint16(this.at, true); this.at += 2; return v; }
  u32() { const v = this.view.getUint32(this.at, true); this.at += 4; return v; }
  f32() { const v = this.view.getFloat32(this.at, true); this.at += 4; return v; }
}

function readVertices(c, count, size) {
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const start = c.at;
  for (let i = 0; i < count; i++) {
    c.at = start + i * size;
    position[i * 3] = c.f32();
    position[i * 3 + 1] = c.f32();
    position[i * 3 + 2] = c.f32();
    normal[i * 3] = c.f32();
    normal[i * 3 + 1] = c.f32();
    normal[i * 3 + 2] = c.f32();
    uv[i * 2] = c.f32();
    uv[i * 2 + 1] = c.f32();
  }
  c.at = start + count * size;
  return { position, normal, uv };
}

function readFaces(c, count) {
  const index = new Uint32Array(count * 3);
  for (let i = 0; i < count * 3; i++) index[i] = c.u32();
  return index;
}

function makeGeometry({ position, normal, uv, index }) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  if (normal) geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  if (uv) geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (index) geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

function readSkin(c, vertices) {
  const envelopes = new Uint8Array(c.buffer, c.at, vertices * 8).slice();
  c.at += vertices * 8;
  return envelopes;
}

function readBones(c, count) {
  const bones = [];
  for (let i = 0; i < count; i++) {
    const nameOffset = c.u32();
    const parent = c.u16();
    c.u16();
    c.f32();
    const rotation = [];
    for (let k = 0; k < 9; k++) rotation.push(c.f32());
    const position = [c.f32(), c.f32(), c.f32()];
    bones.push({ nameOffset, parent: parent === 0xffff ? -1 : parent, rotation, position, name: '' });
  }
  return bones;
}

function readNames(c, bones, size) {
  const bytes = new Uint8Array(c.buffer, c.at, size);
  const decoder = new TextDecoder();
  for (const bone of bones) {
    let end = bone.nameOffset;
    while (end < size && bytes[end]) end++;
    bone.name = decoder.decode(bytes.subarray(bone.nameOffset, end));
  }
  c.at += size;
}

function readSubsets(c, count) {
  const subsets = [];
  for (let i = 0; i < count; i++) {
    c.u32();
    c.u32();
    const vertsBegin = c.u32();
    const vertsLength = c.u32();
    c.u32();
    const indices = [];
    for (let k = 0; k < 26; k++) indices.push(c.u16());
    subsets.push({ vertsBegin, vertsLength, indices });
  }
  return subsets;
}

function applySkin(geometry, envelopes, bones, subsets) {
  const count = geometry.attributes.position.count;
  if (!envelopes || !bones.length || envelopes.length < count * 8) return [];
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const owner = new Int32Array(count).fill(-1);
  subsets.forEach((subset, s) => {
    const end = Math.min(count, subset.vertsBegin + subset.vertsLength);
    for (let v = subset.vertsBegin; v < end; v++) owner[v] = s;
  });
  for (let v = 0; v < count; v++) {
    const subset = subsets[owner[v]];
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const local = envelopes[v * 8 + k];
      const weight = envelopes[v * 8 + 4 + k] / 255;
      skinIndex[v * 4 + k] = subset ? subset.indices[local] ?? 0 : local;
      skinWeight[v * 4 + k] = weight;
      total += weight;
    }
    if (total > 0) for (let k = 0; k < 4; k++) skinWeight[v * 4 + k] /= total;
    else skinWeight[v * 4] = 1;
  }
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  return bones;
}

function parseTextMesh(text, version) {
  const lines = text.split(/\r?\n/);
  const faces = Number(lines[1]);
  const values = (lines[2] || '').match(/\[[^\]]*\]/g) || [];
  const position = new Float32Array(faces * 9);
  const normal = new Float32Array(faces * 9);
  const uv = new Float32Array(faces * 6);
  const scale = version === '1.00' ? 0.5 : 1;
  for (let i = 0; i < faces * 3; i++) {
    const read = k => (values[i * 3 + k] || '').slice(1, -1).split(',').map(Number);
    const [px, py, pz] = read(0);
    const [nx, ny, nz] = read(1);
    const [u, v] = read(2);
    position.set([px * scale, py * scale, pz * scale], i * 3);
    normal.set([nx, ny, nz], i * 3);
    uv.set([u, 1 - v], i * 2);
  }
  return { geometry: makeGeometry({ position, normal, uv }), version, faces, vertices: faces * 3, lods: 1, bones: [] };
}

function decodeDraco(bytes) {
  return new Promise((resolve, reject) => {
    draco.decodeDracoFile(bytes, resolve, undefined, undefined, THREE.LinearSRGBColorSpace, reject);
  });
}

function finish(geometry, version, lods, envelopes, bones, subsets) {
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const total = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
  let faces = total;
  if (lods.length >= 2 && lods[1] > lods[0] && lods[1] <= total) {
    faces = lods[1] - lods[0];
    geometry.setDrawRange(lods[0] * 3, faces * 3);
  }
  const skeleton = applySkin(geometry, envelopes, bones, subsets);
  geometry.computeBoundingBox();
  return { geometry, version, faces, vertices: geometry.attributes.position.count, lods: Math.max(1, lods.length - 1), bones: skeleton };
}

async function parseChunked(buffer, at, version) {
  const c = new Cursor(buffer, at);
  const decoder = new TextDecoder('latin1');
  let geometry = null;
  let lods = [];
  let envelopes = null;
  let bones = [];
  let subsets = [];
  while (c.at + 16 <= buffer.byteLength) {
    const name = decoder.decode(new Uint8Array(buffer, c.at, 8)).replace(/\0+$/, '');
    c.at += 8;
    const chunkVersion = c.u32();
    const size = c.u32();
    const end = c.at + size;
    if (name === 'COREMESH') {
      if (chunkVersion >= 2) {
        const length = c.u32();
        geometry = await decodeDraco(buffer.slice(c.at, c.at + length));
      } else {
        const vertices = c.u32();
        const data = readVertices(c, vertices, 40);
        const faces = c.u32();
        geometry = makeGeometry({ ...data, index: readFaces(c, faces) });
      }
    } else if (name === 'LODS') {
      c.u16();
      c.u8();
      const count = c.u32();
      lods = [];
      for (let i = 0; i < count; i++) lods.push(c.u32());
    } else if (name === 'SKINNING') {
      const count = c.u32();
      envelopes = readSkin(c, count);
      const boneCount = c.u32();
      bones = readBones(c, boneCount);
      const nameSize = c.u32();
      readNames(c, bones, nameSize);
      subsets = readSubsets(c, c.u32());
    }
    c.at = end;
  }
  if (!geometry) throw new Error('This mesh has no geometry in it.');
  return finish(geometry, version, lods, envelopes, bones, subsets);
}

export async function parseMesh(buffer) {
  const head = new TextDecoder('latin1').decode(new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength)));
  const match = /^version (\d\.\d\d)\r?\n/.exec(head);
  if (!match) throw new Error('This file is not a Roblox mesh.');
  const version = match[1];
  const at = match[0].length;
  if (version.startsWith('1.')) return parseTextMesh(new TextDecoder().decode(buffer), version);
  if (version >= '6') return parseChunked(buffer, at, version);
  const c = new Cursor(buffer, at);
  const headerSize = c.u16();
  if (version.startsWith('2.')) {
    const vertexSize = c.u8();
    c.u8();
    const vertices = c.u32();
    const faces = c.u32();
    c.at = at + headerSize;
    const data = readVertices(c, vertices, vertexSize);
    return finish(makeGeometry({ ...data, index: readFaces(c, faces) }), version, [], null, [], []);
  }
  if (version.startsWith('3.')) {
    const vertexSize = c.u8();
    c.u8();
    c.u16();
    const lodCount = c.u16();
    const vertices = c.u32();
    const faces = c.u32();
    c.at = at + headerSize;
    const data = readVertices(c, vertices, vertexSize);
    const index = readFaces(c, faces);
    const lods = [];
    for (let i = 0; i < lodCount; i++) lods.push(c.u32());
    return finish(makeGeometry({ ...data, index }), version, lods, null, [], []);
  }
  c.u16();
  const vertices = c.u32();
  const faces = c.u32();
  const lodCount = c.u16();
  const boneCount = c.u16();
  const nameSize = c.u32();
  const subsetCount = c.u16();
  c.at = at + headerSize;
  const data = readVertices(c, vertices, 40);
  const envelopes = boneCount ? readSkin(c, vertices) : null;
  const index = readFaces(c, faces);
  const lods = [];
  for (let i = 0; i < lodCount; i++) lods.push(c.u32());
  const bones = readBones(c, boneCount);
  readNames(c, bones, nameSize);
  const subsets = readSubsets(c, subsetCount);
  return finish(makeGeometry({ ...data, index }), version, lods, envelopes, bones, subsets);
}

const cache = new Map();
const CACHE_LIMIT = 40;

export async function loadMesh(url) {
  if (cache.has(url)) return cache.get(url);
  const task = fetch(url).then(res => {
    if (!res.ok) throw new Error(`The mesh file could not be read (${res.status}).`);
    return res.arrayBuffer();
  }).then(parseMesh);
  cache.set(url, task);
  task.catch(() => cache.delete(url));
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return task;
}
