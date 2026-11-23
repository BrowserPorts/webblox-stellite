'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createDelta, applyDelta, writeRecovery, readRecoveryHead, recover } = require('../delta');

function roundTrip(source, target) {
  const delta = createDelta(source, target);
  assert.ok(applyDelta(source, delta).equals(target));
  return delta;
}

test('identical buffers need almost no space', () => {
  const data = crypto.randomBytes(200000);
  assert.ok(roundTrip(data, data).length < 16);
});

test('small edits stay small', () => {
  const source = crypto.randomBytes(500000);
  const target = Buffer.from(source);
  target.write('changed', 1000);
  target.write('changed too', 400000);
  assert.ok(roundTrip(source, target).length < 200);
});

test('insertions, deletions and moved blocks are handled', () => {
  const source = crypto.randomBytes(300000);
  const target = Buffer.concat([source.subarray(150000), crypto.randomBytes(500), source.subarray(0, 100000)]);
  assert.ok(roundTrip(source, target).length < 800);
});

test('tiny and empty buffers work', () => {
  roundTrip(Buffer.alloc(0), Buffer.alloc(0));
  roundTrip(Buffer.from('abc'), Buffer.from('abd'));
  roundTrip(Buffer.alloc(0), Buffer.from('new data'));
  roundTrip(crypto.randomBytes(1000), Buffer.alloc(0));
});

test('unrelated data still round trips', () => {
  roundTrip(crypto.randomBytes(5000), crypto.randomBytes(5000));
});

test('a repetitive source does not break it', () => {
  const source = Buffer.alloc(100000, 7);
  const target = Buffer.alloc(120000, 7);
  target[5000] = 9;
  roundTrip(source, target);
});

test('the recovery file rebuilds the target and checks both hashes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webblox-delta-'));
  const file = path.join(dir, 'pristine.delta');
  try {
    const patched = crypto.randomBytes(100000);
    const pristine = Buffer.concat([patched.subarray(0, 40000), Buffer.from('original'), patched.subarray(40100)]);
    const { bytes } = writeRecovery(file, { version: 'version-test', source: patched, target: pristine });
    assert.ok(bytes < 1000);
    assert.equal(readRecoveryHead(file).head.version, 'version-test');
    assert.ok(recover(file, patched).equals(pristine));
    assert.throws(() => recover(file, pristine), /does not match/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
