'use strict';

function readLeb(buf, i, signed = false) {
  let r = 0n;
  let s = 0n;
  let b;
  do {
    b = buf[i++];
    r |= BigInt(b & 0x7f) << s;
    s += 7n;
  } while (b & 0x80);
  if (signed && (b & 0x40)) r -= 1n << s;
  return [Number(r), i];
}

function writeLeb(v, signed = false) {
  const out = [];
  let x = BigInt(v);
  for (;;) {
    const b = Number(x & 0x7fn);
    x >>= 7n;
    const done = signed ? ((x === 0n && !(b & 0x40)) || (x === -1n && (b & 0x40))) : x === 0n;
    out.push(done ? b : b | 0x80);
    if (done) return Buffer.from(out);
  }
}

function wasmSections(buf) {
  const list = [];
  let i = 8;
  while (i < buf.length) {
    const id = buf[i];
    const [size, j] = readLeb(buf, i + 1);
    list.push({ id, body: buf.subarray(j, j + size) });
    i = j + size;
  }
  return list;
}

function vecEntries(body) {
  const [count, start] = readLeb(body, 0);
  return { count, start };
}

function codeBodies(body) {
  const { count, start } = vecEntries(body);
  const out = [];
  let k = start;
  for (let n = 0; n < count; n++) {
    const [size, j] = readLeb(body, k);
    out.push(body.subarray(k, j + size));
    k = j + size;
  }
  return out;
}

function spliceBackport(src, bodiesWasm, plan) {
  const sections = wasmSections(src);
  const ported = wasmSections(bodiesWasm);
  const portedBodies = codeBodies(ported.find(s => s.id === 10).body);
  const fsec = ported.find(s => s.id === 3).body;
  const portedTypes = [];
  const { count, start } = vecEntries(fsec);
  for (let n = 0, k = start; n < count; n++) {
    const [t, j] = readLeb(fsec, k);
    portedTypes.push(t);
    k = j;
  }
  const code = sections.find(s => s.id === 10).body;
  const original = codeBodies(code);
  const defined = original.length;
  const replace = new Map();
  const appendBodies = [];
  const appendTypes = [];
  plan.order.forEach((idx, n) => {
    if (idx < plan.imports + defined) replace.set(idx - plan.imports, portedBodies[n]);
    else {
      appendBodies.push(portedBodies[n]);
      appendTypes.push(portedTypes[n]);
    }
  });
  const mainPattern = Buffer.from(plan.mainPatternHex, 'hex');
  const mainReplacement = Buffer.from(plan.mainReplacementHex, 'hex');
  const out = [src.subarray(0, 8)];
  for (const { id, body } of sections) {
    let next = body;
    if (id === 3) {
      const v = vecEntries(body);
      next = Buffer.concat([writeLeb(v.count + appendTypes.length), body.subarray(v.start), ...appendTypes.map(t => writeLeb(t))]);
    } else if (id === 4) {
      const v = vecEntries(body);
      const flags = body[v.start + 1];
      const [min, k] = readLeb(body, v.start + 2);
      let rest = body.subarray(k);
      const grown = min + plan.tableAdd.length;
      if (flags & 1) rest = Buffer.concat([writeLeb(grown), rest.subarray(readLeb(rest, 0)[1])]);
      next = Buffer.concat([writeLeb(1), Buffer.from([0x70, flags]), writeLeb(grown), rest]);
    } else if (id === 9) {
      const v = vecEntries(body);
      const [, afterConst] = readLeb(body, v.start + 2, true);
      const expr = body.subarray(v.start, afterConst + 1);
      const [n, k] = readLeb(body, afterConst + 1);
      next = Buffer.concat([writeLeb(1), expr, writeLeb(n + plan.tableAdd.length), body.subarray(k), ...plan.tableAdd.map(f => writeLeb(f))]);
    } else if (id === 10) {
      const parts = [writeLeb(defined + appendBodies.length)];
      original.forEach((b, n) => {
        let entry = replace.get(n) || b;
        if (n === plan.mainIndex - plan.imports) {
          const at = entry.indexOf(mainPattern);
          if (at < 0 || entry.indexOf(mainPattern, at + 1) >= 0) throw new Error('main exit sequence not found exactly once');
          entry = Buffer.concat([entry.subarray(0, at), mainReplacement, entry.subarray(at + mainPattern.length)]);
        }
        parts.push(entry);
      });
      next = Buffer.concat([...parts, ...appendBodies]);
    } else if (id === 11) {
      const v = vecEntries(body);
      const segs = Buffer.from(body.subarray(v.start));
      const sbrk = Buffer.alloc(4);
      sbrk.writeUInt32LE(plan.dataBase);
      const at = segs.indexOf(sbrk);
      if (at < 0 || segs.indexOf(sbrk, at + 1) >= 0) throw new Error('heap start not found exactly once in the data section');
      segs.writeUInt32LE(plan.dataBase + plan.reserve, at);
      const blob = Buffer.from(plan.dataHex, 'hex');
      const seg = Buffer.concat([Buffer.from([0x00, 0x41]), writeLeb(plan.dataBase, true), Buffer.from([0x0b]), writeLeb(blob.length), blob]);
      next = Buffer.concat([writeLeb(v.count + 1), segs, seg]);
    } else if (id === 12) {
      next = writeLeb(vecEntries(body).count + 1);
    }
    out.push(Buffer.from([id]), writeLeb(next.length), next);
  }
  return Buffer.concat(out);
}

function spliceRenderThreads(src, plan) {
  const sections = wasmSections(src);
  const original = codeBodies(sections.find(s => s.id === 10).body);
  const bare = entry => entry.subarray(readLeb(entry, 0)[1]);
  const sized = body => Buffer.concat([writeLeb(body.length), body]);
  const edited = new Map(plan.edits.map(edit => {
    const body = bare(original[edit.func - plan.imports]);
    const kept = [body.subarray(0, edit.keepStart), Buffer.from(edit.hex, 'hex'), body.subarray(body.length - edit.keepEnd)];
    return [edit.func - plan.imports, Buffer.concat(kept)];
  }));
  const added = plan.added.map(entry => (entry.moved === undefined ? Buffer.from(entry.hex, 'hex') : bare(original[entry.moved - plan.imports])));
  const out = [src.subarray(0, 8)];
  for (const { id, body } of sections) {
    let next = body;
    if (id === 3) {
      const v = vecEntries(body);
      next = Buffer.concat([writeLeb(v.count + added.length), body.subarray(v.start), ...plan.added.map(entry => writeLeb(entry.type))]);
    } else if (id === 7) {
      const v = vecEntries(body);
      const entries = plan.exports.map(([name, func]) => Buffer.concat([writeLeb(name.length), Buffer.from(name), Buffer.from([0]), writeLeb(func)]));
      next = Buffer.concat([writeLeb(v.count + entries.length), body.subarray(v.start), ...entries]);
    } else if (id === 10) {
      const parts = original.map((entry, index) => (edited.has(index) ? sized(edited.get(index)) : entry));
      next = Buffer.concat([writeLeb(original.length + added.length), ...parts, ...added.map(sized)]);
    }
    out.push(Buffer.from([id]), writeLeb(next.length), next);
  }
  return Buffer.concat(out);
}

function u32s(list) {
  const buffer = Buffer.alloc(list.length * 4);
  list.forEach((value, index) => buffer.writeUInt32LE(value, index * 4));
  return buffer;
}

function spliceSystemTheme(src, theme, home) {
  const sections = wasmSections(src);
  const elem = sections.find(s => s.id === 9).body;
  const ev = vecEntries(elem);
  const [elemBase, afterConst] = readLeb(elem, ev.start + 2, true);
  const [elemCount] = readLeb(elem, afterConst + 1);
  const data = sections.find(s => s.id === 11).body;
  const original = u32s(theme.vtableSlots);
  const at = data.indexOf(original);
  if (at < 0) throw new Error('the system theme vtable is not in the data section');
  if (data.indexOf(original, at + 1) >= 0) throw new Error('the system theme vtable pattern is not unique');
  const address = home.dataBase + theme.valueOffset;
  const fnBody = code => Buffer.concat([writeLeb(code.length + 1), Buffer.from([0x00]), code]);
  const bodies = [
    fnBody(Buffer.concat([Buffer.from([0x41]), writeLeb(address, true), Buffer.from([0x28, 0x02, 0x00, 0x0b])])),
    fnBody(Buffer.from([0x41, 0x01, 0x0b])),
  ];
  const fsec = sections.find(s => s.id === 3).body;
  const firstNew = home.imports + vecEntries(fsec).count;
  const newFuncs = bodies.map((_, i) => firstNew + i);
  const newSlots = newFuncs.map((_, i) => elemBase + elemCount + i);
  const out = [src.subarray(0, 8)];
  for (const { id, body } of sections) {
    let next = body;
    if (id === 3) {
      const v = vecEntries(body);
      next = Buffer.concat([writeLeb(v.count + bodies.length), body.subarray(v.start), ...bodies.map(() => writeLeb(theme.typeIndex))]);
    } else if (id === 4) {
      const v = vecEntries(body);
      const flags = body[v.start + 1];
      const [min, j] = readLeb(body, v.start + 2);
      let rest = body.subarray(j);
      const grown = min + bodies.length;
      if (flags & 1) rest = Buffer.concat([writeLeb(grown), rest.subarray(readLeb(rest, 0)[1])]);
      next = Buffer.concat([writeLeb(1), Buffer.from([0x70, flags]), writeLeb(grown), rest]);
    } else if (id === 9) {
      const [n, j] = readLeb(body, afterConst + 1);
      next = Buffer.concat([writeLeb(1), body.subarray(ev.start, afterConst + 1), writeLeb(n + bodies.length), body.subarray(j), ...newFuncs.map(f => writeLeb(f))]);
    } else if (id === 10) {
      const v = vecEntries(body);
      next = Buffer.concat([writeLeb(v.count + bodies.length), body.subarray(v.start), ...bodies]);
    } else if (id === 11) {
      next = Buffer.from(body);
      next.writeUInt32LE(newSlots[0], at + 8);
      next.writeUInt32LE(newSlots[1], at + 12);
    }
    out.push(Buffer.from([id]), writeLeb(next.length), next);
  }
  return Buffer.concat(out);
}

function applyLightingGates(src, gates, imports) {
  const sections = wasmSections(src);
  const original = codeBodies(sections.find(s => s.id === 10).body);
  const edited = new Map();
  for (const gate of gates) {
    const index = gate.func - imports;
    if (!original[index]) throw new Error(`lighting gate function ${gate.func} does not exist`);
    const body = edited.get(index) || original[index].subarray(readLeb(original[index], 0)[1]);
    const from = Buffer.from(gate.from, 'hex');
    const at = body.indexOf(from);
    if (at < 0 || body.indexOf(from, at + 1) >= 0) throw new Error(`function ${gate.func} does not hold the expected lighting gate exactly once`);
    edited.set(index, Buffer.concat([body.subarray(0, at), Buffer.from(gate.to, 'hex'), body.subarray(at + from.length)]));
  }
  const out = [src.subarray(0, 8)];
  for (const { id, body } of sections) {
    let next = body;
    if (id === 10) {
      const parts = [writeLeb(original.length)];
      original.forEach((entry, index) => {
        const changed = edited.get(index);
        if (changed) parts.push(writeLeb(changed.length), changed);
        else parts.push(entry);
      });
      next = Buffer.concat(parts);
    }
    out.push(Buffer.from([id]), writeLeb(next.length), next);
  }
  return Buffer.concat(out);
}

module.exports = { readLeb, writeLeb, wasmSections, vecEntries, codeBodies, spliceBackport, spliceRenderThreads, spliceSystemTheme, applyLightingGates };
