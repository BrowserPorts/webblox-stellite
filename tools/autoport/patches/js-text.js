'use strict';

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'extends', 'false', 'finally', 'for', 'function', 'if', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'yield',
  'Array', 'BigInt', 'Boolean', 'Date', 'Error', 'Float32Array', 'Float64Array', 'Function', 'Infinity', 'Int32Array', 'JSON', 'Map', 'Math', 'MessageChannel', 'NaN', 'Number', 'Object', 'Promise', 'Reflect', 'RegExp', 'Set', 'String', 'Symbol', 'Uint32Array', 'Uint8Array', 'URL', 'URLSearchParams', 'WeakMap', 'WebAssembly', 'Worker',
  'console', 'document', 'fetch', 'globalThis', 'importScripts', 'localStorage', 'location', 'navigator', 'parseFloat', 'parseInt', 'performance', 'requestAnimationFrame', 'self', 'sessionStorage', 'setInterval', 'setTimeout', 'clearTimeout', 'clearInterval', 'window', 'arguments',
]);

const TOKEN = /\s+|[A-Za-z_$][\w$]*|0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[\s\S]/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MAX_MINIFIED_NAME = 3;

function tokenize(text) {
  return text.match(TOKEN) || [];
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

function significant(tokens, index, step) {
  for (let at = index + step; at >= 0 && at < tokens.length; at += step) {
    if (!/^\s+$/.test(tokens[at])) return tokens[at];
  }
  return null;
}

function isRenameable(tokens, index) {
  const token = tokens[index];
  if (token.length > MAX_MINIFIED_NAME || !IDENTIFIER.test(token) || KEYWORDS.has(token)) return false;
  const before = significant(tokens, index, -1);
  const after = significant(tokens, index, 1);
  if (before === '.' || before === '?.') return false;
  if (after === ':' && (before === '{' || before === ',')) return false;
  return true;
}

function templateIdentifiers(token) {
  const names = new Set();
  for (const match of token.matchAll(/\$\{([^}]*)\}/g)) {
    for (const piece of tokenize(match[1])) if (IDENTIFIER.test(piece) && !KEYWORDS.has(piece)) names.add(piece);
  }
  return names;
}

function compile(text) {
  const tokens = tokenize(text);
  const groupOf = new Map();
  let source = '';
  tokens.forEach((token, index) => {
    if (isRenameable(tokens, index)) {
      const known = groupOf.get(token);
      if (known) source += `\\k<${known}>`;
      else {
        const group = `n${groupOf.size}`;
        groupOf.set(token, group);
        source += `${index === 0 ? '(?<![\\w$])' : '(?<![\\w$.])'}(?<${group}>[A-Za-z_$][\\w$]*)(?![\\w$])`;
      }
    } else {
      source += escapeRegExp(token);
    }
  });
  return { regex: new RegExp(source, 'g'), groupOf, tokens };
}

function freshName(base, taken) {
  for (let suffix = 0; ; suffix++) {
    const candidate = `_wb${base.replace(/\W/g, '')}${suffix || ''}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function rewrite(text, local, shared, inFile) {
  const tokens = tokenize(text);
  const mapped = new Set(local.values());
  const introduced = new Map();
  return tokens.map((token, index) => {
    if (!isRenameable(tokens, index)) {
      if (token[0] === '`') return token.replace(/\$\{([^}]*)\}/g, (all, inner) => `\${${rewrite(inner, local, shared, inFile)}}`);
      return token;
    }
    if (local.has(token)) return local.get(token);
    if (shared.has(token)) return shared.get(token);
    if (introduced.has(token)) return introduced.get(token);
    const name = mapped.has(token) || [...shared.values()].includes(token) ? freshName(token, inFile) : token;
    introduced.set(token, name);
    return name;
  }).join('');
}

function findBestPrefix(text, tokens, renameable) {
  let low = 1;
  let high = tokens.length;
  let best = 0;
  let where = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const prefix = tokens.slice(0, mid).join('');
    let regex;
    try {
      regex = compile(prefix).regex;
    } catch {
      high = mid - 1;
      continue;
    }
    const match = regex.exec(text);
    if (match) {
      best = mid;
      where = match.index + match[0].length;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { matchedTokens: best, totalTokens: tokens.length, continuesWith: tokens.slice(best, best + 12).join(''), found: where >= 0 ? text.slice(where, where + 120) : '' };
}

const MIN_ANCHOR_SHARE = 0.6;
const MAX_REGION_GROWTH = 1.5;
const REGION_SLACK = 200;
const MAX_EDIT_SHARE = 0.25;

function longestMatch(text, tokens, fromEnd, start = 0, limit = text.length) {
  let low = 1;
  let high = tokens.length;
  let best = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const piece = fromEnd ? tokens.slice(tokens.length - mid) : tokens.slice(0, mid);
    let compiled;
    try {
      compiled = compile(piece.join(''));
    } catch {
      high = mid - 1;
      continue;
    }
    compiled.regex.lastIndex = start;
    const match = compiled.regex.exec(text);
    if (match && match.index + match[0].length <= limit) {
      const names = new Map();
      for (const [name, group] of compiled.groupOf) names.set(name, match.groups[group]);
      best = { count: mid, index: match.index, end: match.index + match[0].length, names };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function lcsPairs(a, b) {
  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function hunksOf(pairs, aLength, bLength) {
  const hunks = [];
  let lastA = -1;
  let lastB = -1;
  for (const [i, j] of [...pairs, [aLength, bLength]]) {
    if (i > lastA + 1 || j > lastB + 1) hunks.push({ aStart: lastA + 1, aEnd: i, bStart: lastB + 1, bEnd: j });
    lastA = i;
    lastB = j;
  }
  return hunks;
}

function mergeEdits(base, ours, theirs) {
  const oursOf = new Int32Array(base.length).fill(-1);
  for (const [i, j] of lcsPairs(base, ours)) oursOf[i] = j;
  const theirHunks = hunksOf(lcsPairs(base, theirs), base.length, theirs.length);
  const edits = [];
  for (const hunk of theirHunks) {
    const left = hunk.aStart - 1;
    const right = hunk.aEnd;
    let kept = (left < 0 || oursOf[left] >= 0) && (right >= base.length || oursOf[right] >= 0);
    for (let k = hunk.aStart; kept && k < hunk.aEnd; k++) if (oursOf[k] < 0) kept = false;
    if (kept && left >= 0 && right < base.length && oursOf[right] - oursOf[left] !== right - left) kept = false;
    const removed = base.slice(hunk.aStart, hunk.aEnd).join('');
    const added = theirs.slice(hunk.bStart, hunk.bEnd).join('');
    if (!kept) return { conflict: { removed, added } };
    const start = left >= 0 ? oursOf[left] + 1 : oursOf[right] - right;
    edits.push({ start, end: start + (hunk.aEnd - hunk.aStart), tokens: theirs.slice(hunk.bStart, hunk.bEnd), removed, added });
  }
  const out = ours.slice();
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) out.splice(edit.start, edit.end - edit.start, ...edit.tokens);
  return { merged: out.join(''), edits: edits.map(({ removed, added }) => ({ removed, added })) };
}

function locateEdited(newText, from) {
  const tokens = tokenize(from);
  const head = longestMatch(newText, tokens, false);
  if (!head) return null;
  const limit = head.index + Math.ceil(from.length * MAX_REGION_GROWTH) + REGION_SLACK;
  const tail = longestMatch(newText, tokens, true, head.end, limit);
  if (!tail || head.count + tail.count < tokens.length * MIN_ANCHOR_SHARE) return null;
  const names = new Map(head.names);
  for (const [name, value] of tail.names) {
    if (names.has(name) && names.get(name) !== value) return null;
    names.set(name, value);
  }
  return { start: head.index, end: tail.end, names };
}

function mergeChanged(newText, from, to, shared, inFile) {
  const region = locateEdited(newText, from);
  if (!region) return null;
  const theirsText = newText.slice(region.start, region.end);
  if (newText.split(theirsText).length - 1 !== 1) return { reason: 'the edited code appears more than once in the new file' };
  const base = tokenize(rewrite(from, region.names, shared, inFile));
  const ours = tokenize(rewrite(to, region.names, shared, inFile));
  const theirs = tokenize(theirsText);
  const result = mergeEdits(base, ours, theirs);
  if (result.conflict) return { reason: `Roblox changed code that this patch rewrites: \`${result.conflict.removed}\` became \`${result.conflict.added}\``, closest: { text: theirsText } };
  const changed = result.edits.reduce((sum, edit) => sum + tokenize(edit.removed).length + tokenize(edit.added).length, 0);
  if (changed > base.length * MAX_EDIT_SHARE) return { reason: `Roblox rewrote too much of this code (${changed} of ${base.length} tokens) to merge it safely`, closest: { text: theirsText } };
  return { from: theirsText, to: result.merged, edits: result.edits, renames: [...region.names].filter(([name, value]) => name !== value) };
}

function isPlainText(from) {
  const tokens = tokenize(from);
  return !tokens.some((token, index) => isRenameable(tokens, index));
}

function mentionsRename(text, shared) {
  const renamed = name => shared.has(name) && shared.get(name) !== name;
  const tokens = tokenize(text);
  return tokens.some((token, index) => {
    if (token[0] === '`') return [...templateIdentifiers(token)].some(renamed);
    return isRenameable(tokens, index) && renamed(token);
  });
}

function portList(newText, patches) {
  const results = [];
  const sharedVotes = new Map();
  const matched = patches.map(([from, to, count]) => {
    const compiled = compile(from);
    const hits = [...newText.matchAll(compiled.regex)];
    const verbatim = newText.split(from).length - 1;
    const bindings = new Map();
    if (hits.length) {
      for (const [name, group] of compiled.groupOf) bindings.set(name, hits[0].groups[group]);
      const consistent = hits.every(hit => [...compiled.groupOf].every(([name, group]) => hit.groups[group] === bindings.get(name)));
      if (!consistent) return { from, to, count, hits, compiled, verbatim, bindings, inconsistent: true };
      for (const [name, value] of bindings) {
        if (!sharedVotes.has(name)) sharedVotes.set(name, new Map());
        const votes = sharedVotes.get(name);
        votes.set(value, (votes.get(value) || 0) + 1);
      }
    }
    return { from, to, count, hits, compiled, verbatim, bindings };
  });
  const shared = new Map();
  for (const [name, votes] of sharedVotes) if (votes.size === 1) shared.set(name, [...votes.keys()][0]);
  const inFile = new Set(tokenize(newText).filter(token => IDENTIFIER.test(token)));
  for (const entry of matched) {
    const { from, to, count, hits, verbatim } = entry;
    if (entry.inconsistent) {
      results.push({ status: 'failed', from, reason: 'the pattern matched places that use different variable names' });
      continue;
    }
    if (!hits.length) {
      const merged = count === 1 ? mergeChanged(newText, from, to, shared, inFile) : null;
      if (merged && merged.from !== undefined) {
        results.push({ status: 'merged', from: merged.from, to: merged.to, count: 1, renames: merged.renames, edits: merged.edits });
        continue;
      }
      const closest = findBestPrefix(newText, entry.compiled.tokens);
      results.push({ status: 'failed', from, reason: merged ? merged.reason : 'not found', closest: merged && merged.closest ? merged.closest : closest });
      continue;
    }
    const plain = isPlainText(from);
    if (hits.length !== count && !plain) {
      results.push({ status: 'failed', from, reason: `expected ${count} match(es), found ${hits.length}` });
      continue;
    }
    const nextFrom = hits[0][0];
    const nextTo = verbatim === hits.length && [...entry.bindings].every(([name, value]) => name === value) && !mentionsRename(to, shared) ? to : rewrite(to, entry.bindings, shared, inFile);
    results.push({ status: nextFrom === from ? 'unchanged' : 'renamed', from: nextFrom, to: nextTo, count: hits.length, renames: [...entry.bindings].filter(([name, value]) => name !== value), countChanged: hits.length !== count });
  }
  return results;
}

function apply(text, list) {
  let out = text;
  for (const [from, to] of list) out = out.split(from).join(to);
  return out;
}

module.exports = { portList, apply, tokenize, compile, rewrite, isRenameable, findBestPrefix, templateIdentifiers, mergeEdits, locateEdited, mergeChanged };
