'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { portList, apply, isRenameable, tokenize, mergeEdits } = require('../patches/js-text');

test('a patch whose text is unchanged stays as it is', () => {
  const [result] = portList('var a=1;e.postMessage({cmd:1,mem:Ce});', [['e.postMessage({cmd:1,mem:Ce})', 'e.postMessage({cmd:1,mem:Ce,gl:g})', 1]]);
  assert.equal(result.status, 'unchanged');
  assert.equal(result.count, 1);
  assert.equal(result.from, 'e.postMessage({cmd:1,mem:Ce})');
  assert.equal(result.to, 'e.postMessage({cmd:1,mem:Ce,gl:g})');
});

test('a renamed identifier follows into the replacement', () => {
  const [result] = portList('r.postMessage({cmd:1,mem:Xq});', [['e.postMessage({cmd:1,mem:Ce})', 'e.postMessage({cmd:1,mem:Ce,gl:Ce})', 1]]);
  assert.equal(result.status, 'renamed');
  assert.equal(result.from, 'r.postMessage({cmd:1,mem:Xq})');
  assert.equal(result.to, 'r.postMessage({cmd:1,mem:Xq,gl:Xq})');
});

test('a name in one patch helps another patch that only mentions it in its replacement', () => {
  const results = portList('foo=Qq;bar(Mm);', [['foo=Ce', 'foo=Ce', 1], ['bar(ab)', 'bar(ab,Ce)', 1]]);
  assert.equal(results[1].to, 'bar(Mm,Qq)');
});

test('a replacement follows a rename found by another patch even when its own text is unchanged', () => {
  const results = portList('run(1);Qq=()=>0;', [['run(1)', 'run(1),Ze.fresh()', 1], ['Ze=()=>0', 'Ze=()=>1', 1]]);
  assert.equal(results[0].status, 'unchanged');
  assert.equal(results[0].to, 'run(1),Qq.fresh()');
  assert.equal(results[1].to, 'Qq=()=>1');
});

test('string contents and long names never become holes', () => {
  const results = portList('run("Close tab",performance.now());', [['run("Close tab",performance.now())', 'run("Leave",performance.now())', 1]]);
  assert.equal(results[0].status, 'unchanged');
  assert.equal(portList('run("Open tab");', [['run("Close tab")', 'x', 1]])[0].status, 'failed');
  assert.equal(portList('performanceX.now();', [['performance.now()', 'x', 1]])[0].status, 'failed');
});

test('keywords are not treated as minified names', () => {
  const tokens = tokenize('if(a)');
  assert.equal(isRenameable(tokens, 0), false);
  assert.equal(portList('for(b);', [['if(a)', 'x', 1]])[0].status, 'failed');
});

test('property names are not renameable', () => {
  assert.equal(portList('e.xy=1;', [['e.ab=1', 'x', 1]])[0].status, 'failed');
});

test('a missing target fails with a reason and the closest text', () => {
  const [result] = portList('var unrelated=[1,2,3];', [['function In(){return gone}', 'x', 1]]);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'not found');
  assert.ok(result.closest !== undefined);
});

test('a Roblox edit inside code the patch keeps is carried into the replacement', () => {
  const from = 'function In(){try{await l.run()}catch(a){console.error("threw",a)}e.post(0)}';
  const to = 'function In(){var b=!1;try{await l.run()}catch(a){console.error("threw",a)}b=!0;e.post(0)}';
  const updated = 'x=1;function Qn(){try{await l.run()}catch(a){console.error("threw",a),l.report?.(a)}e.post(0)}y=2;';
  const [result] = portList(updated, [[from, to, 1]]);
  assert.equal(result.status, 'merged');
  assert.equal(result.from, 'function Qn(){try{await l.run()}catch(a){console.error("threw",a),l.report?.(a)}e.post(0)}');
  assert.equal(result.to, 'function Qn(){var b=!1;try{await l.run()}catch(a){console.error("threw",a),l.report?.(a)}b=!0;e.post(0)}');
  assert.deepEqual(result.edits, [{ removed: '', added: ',l.report?.(a)' }]);
  assert.equal(apply(updated, [[result.from, result.to]]), `x=1;${result.to}y=2;`);
});

test('a Roblox edit inside code the patch rewrites stops the merge', () => {
  const from = 'function In(){var r=1,t=0;go(r,t);done()}';
  const to = 'function In(){var r=2,t=0;go(r,t);done()}';
  const [result] = portList('function In(){var r=5,t=0;go(r,t);done()}', [[from, to, 1]]);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /Roblox changed code that this patch rewrites/);
  assert.equal(result.closest.text, 'function In(){var r=5,t=0;go(r,t);done()}');
});

test('the three-way merge applies Roblox edits at the right place', () => {
  const merged = mergeEdits(tokenize('a(1);b(2);c(3)'), tokenize('a(1);x();b(2);c(3)'), tokenize('a(1);b(2,9);c(3)'));
  assert.equal(merged.merged, 'a(1);x();b(2,9);c(3)');
  assert.ok(mergeEdits(tokenize('a(1);b(2)'), tokenize('a(1);b(7)'), tokenize('a(1);b(8)')).conflict);
});

test('a code pattern with the wrong count fails', () => {
  const [result] = portList('a(b);a(b);', [['a(b)', 'c', 1]]);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /expected 1 match/);
});

test('plain text may change how often it appears', () => {
  const [result] = portList('"Loading Roblox" and "Loading Roblox"', [['"Loading Roblox"', '"Loading WebBlox"', 1]]);
  assert.notEqual(result.status, 'failed');
  assert.equal(result.count, 2);
});

test('a pattern that binds one name to two values fails', () => {
  const [result] = portList('x(a,a);x(b,b);', [['x(q,q)', 'y', 2]]);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /different variable names/);
});

test('a repeated name must repeat in the new text', () => {
  assert.equal(portList('add(a,b);', [['add(q,q)', 'x', 1]])[0].status, 'failed');
});

test('a new local in the replacement avoids names already in the file', () => {
  const [result] = portList('run(Ze);n=1;', [['run(Ze)', 'run(Ze,n=>n+1)', 1]]);
  assert.notEqual(result.status, 'failed');
  assert.match(result.to, /run\(Ze,/);
});

test('apply replaces every occurrence', () => {
  assert.equal(apply('a b a', [['a', 'c']]), 'c b c');
});
