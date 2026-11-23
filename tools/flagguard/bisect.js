'use strict';

const FORMAT = 1;
const VERDICTS = new Set(['good', 'bad', 'skip']);

function startBisect({ good, bad, changes, base }) {
  const state = { format: FORMAT, good, bad, base, changes, current: changes.map((change, index) => index), n: 2, phase: 'subsets', index: 0, answers: {}, history: [], result: null };
  settle(state);
  return state;
}

function partitions(current, n) {
  const parts = [];
  const size = current.length / n;
  for (let i = 0; i < n; i++) {
    const part = current.slice(Math.round(i * size), Math.round((i + 1) * size));
    if (part.length) parts.push(part);
  }
  return parts;
}

function complement(current, part) {
  const removed = new Set(part);
  return current.filter(index => !removed.has(index));
}

function candidate(state) {
  if (state.result) return null;
  const parts = partitions(state.current, state.n);
  const part = parts[state.index];
  return state.phase === 'subsets' ? part : complement(state.current, part);
}

function keyOf(indices) {
  return indices.slice().sort((a, b) => a - b).join(',');
}

function finishGranularity(state) {
  if (state.n < state.current.length) {
    state.n = Math.min(state.n * 2, state.current.length);
    state.phase = 'subsets';
    state.index = 0;
  } else {
    state.result = state.current.slice();
  }
}

function advance(state, verdict, tested) {
  if (verdict === 'bad') {
    const fromSubsets = state.phase === 'subsets';
    state.current = tested;
    state.n = fromSubsets ? 2 : Math.max(state.n - 1, 2);
    state.phase = 'subsets';
    state.index = 0;
    return;
  }
  state.index++;
  const count = partitions(state.current, state.n).length;
  if (state.index < count) return;
  if (state.phase === 'subsets' && count > 2) {
    state.phase = 'complements';
    state.index = 0;
    return;
  }
  finishGranularity(state);
}

function settle(state) {
  for (;;) {
    if (state.result) return;
    if (state.current.length <= 1) {
      state.result = state.current.slice();
      return;
    }
    const tested = candidate(state);
    const known = state.answers[keyOf(tested)];
    if (!known) return;
    advance(state, known, tested);
  }
}

function answer(state, verdict) {
  if (!VERDICTS.has(verdict)) throw new Error(`The answer must be good, bad or skip, not "${verdict}".`);
  if (state.result) throw new Error('The bisect already finished.');
  const tested = candidate(state);
  state.answers[keyOf(tested)] = verdict;
  state.history.push({ changes: tested.length, verdict });
  advance(state, verdict, tested);
  settle(state);
  return state;
}

function applyChanges(base, changes, indices) {
  const set = { ...base, applicationSettings: { ...base.applicationSettings }, ixp: { ...(base.ixp || {}) } };
  for (const index of indices) {
    const change = changes[index];
    const target = change.ixp ? set.ixp : set.applicationSettings;
    if (change.value === null) delete target[change.key];
    else target[change.key] = change.value;
  }
  return set;
}

function remainingTests(state) {
  if (state.result) return 0;
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, state.current.length))));
}

module.exports = { startBisect, answer, candidate, applyChanges, partitions, remainingTests, FORMAT };
