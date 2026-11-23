'use strict';

const zlib = require('zlib');

function readChunks(data) {
  if (data.toString('latin1', 0, 8) !== '<roblox!') throw new Error('not a binary Roblox model');
  const chunks = [];
  let at = 32;
  while (at < data.length) {
    const name = data.toString('latin1', at, at + 4);
    const compressed = data.readUInt32LE(at + 4);
    const uncompressed = data.readUInt32LE(at + 8);
    const payload = data.subarray(at + 16, at + 16 + (compressed || uncompressed));
    chunks.push({ name, body: compressed ? zlib.zstdDecompressSync(payload) : payload });
    at += 16 + (compressed || uncompressed);
    if (name === 'END\0') break;
  }
  return chunks;
}

function splitStrings(blob, count) {
  const list = [];
  let at = 0;
  for (let k = 0; k < count; k++) {
    const length = blob.readUInt32LE(at);
    list.push(blob.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return list;
}

function readModuleScripts(data) {
  const chunks = readChunks(data);
  let moduleClass = null;
  let count = 0;
  for (const chunk of chunks) {
    if (chunk.name !== 'INST') continue;
    const nameLength = chunk.body.readUInt32LE(4);
    if (chunk.body.toString('latin1', 8, 8 + nameLength) === 'ModuleScript') {
      moduleClass = chunk.body.readUInt32LE(0);
      count = chunk.body.readUInt32LE(9 + nameLength);
    }
  }
  if (moduleClass === null) throw new Error('the model has no ModuleScript class');
  const property = name => {
    const chunk = chunks.find(candidate => {
      if (candidate.name !== 'PROP') return false;
      const nameLength = candidate.body.readUInt32LE(4);
      return candidate.body.readUInt32LE(0) === moduleClass && candidate.body.toString('latin1', 8, 8 + nameLength) === name;
    });
    if (!chunk) throw new Error(`the model has no ${name} property on ModuleScript`);
    return splitStrings(chunk.body.subarray(9 + chunk.body.readUInt32LE(4)), count);
  };
  const sources = property('Source');
  const names = property('Name').map(name => name.toString('utf8'));
  return { names, sources, count };
}

module.exports = { readChunks, splitStrings, readModuleScripts };
