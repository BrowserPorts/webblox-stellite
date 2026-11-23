'use strict';

const { uleb, sleb } = require('../wasm/module');

const I32 = 0x7f;

function section(id, body) {
  return Buffer.concat([Buffer.from([id]), uleb(body.length), body]);
}

function vector(items) {
  return Buffer.concat([uleb(items.length), ...items]);
}

function nameBytes(text) {
  const bytes = Buffer.from(text);
  return Buffer.concat([uleb(bytes.length), bytes]);
}

function constExpression(value) {
  return Buffer.concat([Buffer.from([0x41]), sleb(value), Buffer.from([0x0b])]);
}

function typeEntry({ params = [], results = [] }) {
  return Buffer.concat([Buffer.from([0x60]), uleb(params.length), Buffer.from(params), uleb(results.length), Buffer.from(results)]);
}

function buildModule({ types = [{}], imports = [], functions = [], elements = null, tableSize = 0, memoryPages = 0, globals = [], exports = [], data = [] }) {
  const parts = [Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])];
  parts.push(section(1, vector(types.map(typeEntry))));
  if (imports.length) parts.push(section(2, vector(imports.map(entry => Buffer.concat([nameBytes(entry.module || 'env'), nameBytes(entry.name), Buffer.from([0]), uleb(entry.type || 0)])))));
  parts.push(section(3, vector(functions.map(entry => uleb(entry.type || 0)))));
  if (tableSize) parts.push(section(4, vector([Buffer.concat([Buffer.from([0x70, 0]), uleb(tableSize)])])));
  if (memoryPages) parts.push(section(5, vector([Buffer.concat([Buffer.from([0]), uleb(memoryPages)])])));
  if (globals.length) parts.push(section(6, vector(globals.map(value => Buffer.concat([Buffer.from([I32, 1]), constExpression(value)])))));
  if (exports.length) parts.push(section(7, vector(exports.map(([name, index]) => Buffer.concat([nameBytes(name), Buffer.from([0]), uleb(index)])))));
  if (elements) parts.push(section(9, vector([Buffer.concat([uleb(0), constExpression(elements.base), vector(elements.functions.map(func => uleb(func)))])])));
  parts.push(section(10, vector(functions.map(entry => {
    const body = Buffer.concat([uleb(entry.locals ? 1 : 0), entry.locals ? Buffer.concat([uleb(entry.locals), Buffer.from([I32])]) : Buffer.alloc(0), Buffer.from(entry.code), Buffer.from([0x0b])]);
    return Buffer.concat([uleb(body.length), body]);
  }))));
  if (data.length) parts.push(section(11, vector(data.map(({ offset, bytes }) => Buffer.concat([uleb(0), constExpression(offset), uleb(bytes.length), Buffer.from(bytes)])))));
  return Buffer.concat(parts);
}

const code = {
  i32: value => [0x41, ...sleb(value)],
  get: index => [0x20, ...uleb(index)],
  put: index => [0x21, ...uleb(index)],
  call: func => [0x10, ...uleb(func)],
  drop: [0x1a],
  add: [0x6a],
  load: offset => [0x28, 2, ...uleb(offset)],
};

module.exports = { buildModule, code, I32 };
