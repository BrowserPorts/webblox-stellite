'use strict';

const MAX_MYERS_DISTANCE = 4096;
const MAX_MYERS_AREA = 40000000;

function myers(a, aLow, aHigh, b, bLow, bHigh, out) {
  const n = aHigh - aLow;
  const m = bHigh - bLow;
  if (n === 0 || m === 0) return true;
  const maxDistance = Math.min(n + m, MAX_MYERS_DISTANCE);
  if ((maxDistance + 1) * (maxDistance + 1) > MAX_MYERS_AREA) return false;
  const width = 2 * maxDistance + 2;
  const frontier = new Int32Array(width);
  const history = [];
  let found = -1;
  search:
  for (let d = 0; d <= maxDistance; d++) {
    const snapshot = new Int32Array(d + 1);
    for (let k = -d; k <= d; k += 2) {
      const index = k + maxDistance;
      let x;
      if (k === -d || (k !== d && frontier[index - 1] < frontier[index + 1])) x = frontier[index + 1];
      else x = frontier[index - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aLow + x] === b[bLow + y]) {
        x++;
        y++;
      }
      frontier[index] = x;
      snapshot[(k + d) >> 1] = x;
      if (x >= n && y >= m) {
        history.push(snapshot);
        found = d;
        break search;
      }
    }
    history.push(snapshot);
  }
  if (found < 0) return false;
  const reversed = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const k = x - y;
    const previous = history[d - 1];
    const at = value => previous[(value + d - 1) >> 1];
    let previousK;
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) previousK = k + 1;
    else previousK = k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY && x > 0 && y > 0 && a[aLow + x - 1] === b[bLow + y - 1]) {
      x--;
      y--;
      reversed.push(aLow + x, bLow + y);
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    reversed.push(aLow + x, bLow + y);
  }
  for (let i = reversed.length - 2; i >= 0; i -= 2) out.push(reversed[i], reversed[i + 1]);
  return true;
}

function longestIncreasing(pairs) {
  const tails = [];
  const links = new Int32Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    const value = pairs[i][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) links[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = [];
  for (let at = tails.length ? tails[tails.length - 1] : -1; at >= 0; at = links[at]) out.push(pairs[at]);
  return out.reverse();
}

function uniqueAnchors(a, aLow, aHigh, b, bLow, bHigh) {
  const counts = new Map();
  for (let i = aLow; i < aHigh; i++) {
    const entry = counts.get(a[i]);
    if (entry === undefined) counts.set(a[i], { a: 1, b: 0, atA: i, atB: -1 });
    else entry.a++;
  }
  for (let i = bLow; i < bHigh; i++) {
    const entry = counts.get(b[i]);
    if (entry !== undefined) {
      entry.b++;
      entry.atB = i;
    }
  }
  const anchors = [];
  for (const entry of counts.values()) if (entry.a === 1 && entry.b === 1) anchors.push([entry.atA, entry.atB]);
  anchors.sort((x, y) => x[0] - y[0]);
  return longestIncreasing(anchors);
}

function alignRange(a, aLow, aHigh, b, bLow, bHigh, out, depth) {
  while (aLow < aHigh && bLow < bHigh && a[aLow] === b[bLow]) {
    out.push(aLow, bLow);
    aLow++;
    bLow++;
  }
  const suffix = [];
  while (aLow < aHigh && bLow < bHigh && a[aHigh - 1] === b[bHigh - 1]) {
    aHigh--;
    bHigh--;
    suffix.push(aHigh, bHigh);
  }
  if (aLow < aHigh && bLow < bHigh) {
    const anchors = depth < 32 ? uniqueAnchors(a, aLow, aHigh, b, bLow, bHigh) : [];
    if (anchors.length) {
      let previousA = aLow;
      let previousB = bLow;
      for (const [atA, atB] of anchors) {
        alignRange(a, previousA, atA, b, previousB, atB, out, depth + 1);
        out.push(atA, atB);
        previousA = atA + 1;
        previousB = atB + 1;
      }
      alignRange(a, previousA, aHigh, b, previousB, bHigh, out, depth + 1);
    } else {
      myers(a, aLow, aHigh, b, bLow, bHigh, out);
    }
  }
  for (let i = suffix.length - 2; i >= 0; i -= 2) out.push(suffix[i], suffix[i + 1]);
}

function alignTokens(a, b) {
  const out = [];
  alignRange(a, 0, a.length, b, 0, b.length, out, 0);
  return out;
}

function gaps(pairs, aLength, bLength) {
  const list = [];
  let previousA = 0;
  let previousB = 0;
  for (let i = 0; i <= pairs.length; i += 2) {
    const atA = i < pairs.length ? pairs[i] : aLength;
    const atB = i < pairs.length ? pairs[i + 1] : bLength;
    if (atA > previousA || atB > previousB) list.push({ aStart: previousA, aEnd: atA, bStart: previousB, bEnd: atB });
    previousA = atA + 1;
    previousB = atB + 1;
  }
  return list;
}

module.exports = { alignTokens, gaps };
