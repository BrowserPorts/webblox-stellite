'use strict';

const crypto = require('crypto');
const A = require('../wasm/asm');
const { uleb } = require('../wasm/module');
const { PortError, value } = require('../context');
const { spliceRenderThreads } = require('../wasm/splice');

const { seq, i32, get, put, tee, call, load, load64, loadf, load8, store, storef, store8, store64, block, loop, ifThen, elseThen, end, ret, br, brIf, globalGet, globalSet, f32Zero, OPS, atomicLoad, atomicLoad8, atomicStore, atomicCmpxchg, tryTable, hole: v, encode, drop, plain, unreachable, throwRef, gap } = A;
const { ADD, SUB, MUL, DIV_S, EQ, NE, EQZ, LT_S, LT_U, GE_S, GE_U, AND, OR, I64_EQ, F32_DIV, F32_FROM_I32 } = OPS;
const LE_U = plain(0x4d);
const SHR_S = plain(0x75);
const GT_U = plain(0x4b);
const SELECT = plain(0x1b);
const V128_LOAD = offset => [{ op: 0xfd, sub: 0, a: offset }];
const V128_STORE = offset => [{ op: 0xfd, sub: 11, a: offset }];
const V128_LOAD64_ZERO = offset => [{ op: 0xfd, sub: 93, a: offset }];
const V128_CONST = [{ op: 0xfd, sub: 12 }];
const I32X4_ADD = [{ op: 0xfd, sub: 174 }];
const V128_STORE64_LANE = offset => [{ op: 0xfd, sub: 91, a: offset }];
const EXNREF = -23;

const STATE = {
  FLAGS: 768, JOB_ACTIVE: 771, JOB_RUNNING: 1, JOB_PENDING: 2, THREAD_REQUEST: 770, JOB: 772, ATTR: 896, HELPER_ID: 960, BLOCK: 964, REQUEST_FLAG: 975, LOCK: 976, DEPTH: 980, LOCK_RELEASES: 984,
  MARKS_WRITE: 988, MARKS_READ: 992, MARKS_AT: 4 << 20, MARKS_CAPACITY: 65536, MARK_BYTES: 32, BLOCK_BYTES: 8 << 20,
  SKIP_LIGHT_CULL: 1, SHADOW_THREAD: 4, KICK: 0x7E5A0010, JOIN: 0x7E5A0011, SERVICE: 0x7E5A0012, THREAD_ARG: 0x7E5A0020,
  HELPER_VECTOR: 800, CURVE_PADDING: 16, LIGHT_RANGE_FIELD: 12, GL_DEPTH_CLAMP: 0x864F,
};
const TEXTURE_MARK_SIGNATURE = '127,127,127,127,127,125,127,125>';
const TEXTURE_MARK_FLOATS = new Set([5, 7]);
const TEXTURE_MARK_ARGS = 8;
const TILE_JOB_ARGS = 6;
const THREAD_ATTR_ARG = 1;

function flag(mask) {
  return seq(i32(STATE.FLAGS), load8(), i32(mask), AND);
}

function sha(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function shrink(oldBody, newBody) {
  let prefix = 0;
  const limit = Math.min(oldBody.length, newBody.length);
  while (prefix < limit && oldBody[prefix] === newBody[prefix]) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && oldBody[oldBody.length - 1 - suffix] === newBody[newBody.length - 1 - suffix]) suffix++;
  return { keepStart: prefix, keepEnd: suffix, hex: newBody.subarray(prefix, newBody.length - suffix).toString('hex') };
}

function bodyWithLocals(count, code) {
  return Buffer.concat([uleb(count ? 1 : 0), count ? Buffer.concat([uleb(count), Buffer.from([0x7f])]) : Buffer.alloc(0), encode(code)]);
}

class Generator {
  constructor(ctx) {
    this.ctx = ctx;
    this.module = ctx.newModule;
    this.editors = new Map();
    this.added = [];
    this.exports = [];
    this.gate = call(this.module.importIndex('glPixelStorei'));
    this.values = {};
  }

  editor(func) {
    let editor = this.editors.get(func);
    if (!editor) {
      editor = this.ctx.edits(func);
      this.editors.set(func, editor);
    }
    return editor;
  }

  nextIndex() {
    return this.module.functionCount + this.added.length;
  }

  gateCall(code) {
    return seq(i32(code), i32(0), this.gate);
  }

  joinIfActive() {
    return seq(i32(STATE.JOB_ACTIVE), load8(), ifThen(), this.gateCall(STATE.JOIN), end);
  }

  particleCurves() {
    const { ctx } = this;
    if (!ctx.unchanged('CURVE_TABLE')) {
      const TABLE_BYTES = 512;
      ctx.site('CURVE_TABLE', () => seq(get(1), load(8), get(v('entry')), load(8), i32(TABLE_BYTES), call(v('compare'))), { label: 'the key compare that reads the table at offset 8 of the key' });
      ctx.site('CURVE_TABLE', () => seq(get(v('cache')), get(v('entry')), load(v('field')), i32(TABLE_BYTES), A.prefixed(0xfc, 10)), { label: 'the table copy into the per-slot cache' });
      ctx.note('CURVE_TABLE changed, but it still compares each key by the 512 byte table at offset 8 of the key, so the particle curve patch still reads the right table.');
    }
    const lookup = (f, key, slot) => seq(get(v('self')), load(v('owner')), get(v(key)), i32(slot), call(f('CURVE_TABLE')));
    const hit = ctx.site('FILL_PARTICLES', f => seq(lookup(f, 'k0', 0), put(v('t0')), lookup(f, 'k1', 1), put(v('t1')), lookup(f, 'k2', 2), tee(v('t2'))), { label: 'the three curve lookups' });
    const b = hit.bindings;
    const TABLE_FIELD = 8;
    const code = seq(get(value(b, 'k0')), load(TABLE_FIELD), put(value(b, 't0')), get(value(b, 'k1')), load(TABLE_FIELD), put(value(b, 't1')), get(value(b, 'k2')), load(TABLE_FIELD), tee(value(b, 't2')));
    this.editor(ctx.func('FILL_PARTICLES')).replace(hit.start, hit.end, encode(code));

    const copy = ctx.func('CURVE_COPY');
    const size = ctx.site('CURVE_COPY', f => seq(i32(v('bytes')), call(f('OPERATOR_NEW'))), { label: 'the table allocation', expect: { bytes: 516 } });
    const bytes = value(size.bindings, 'bytes');
    const refcount = ctx.site('CURVE_COPY', () => seq(get(v('table')), i32(1), store(bytes - 4)), { label: 'the reference count store' });
    const editor = this.editor(copy);
    editor.replace(size.start, ctx.decoded('new', copy)[size.index].end, encode(i32(bytes + STATE.CURVE_PADDING)));
    const table = value(refcount.bindings, 'table');
    const padding = [];
    for (let offset = 0; offset < STATE.CURVE_PADDING; offset += 4) padding.push(...seq(get(table), i32(0), store(bytes + offset)));
    editor.insertAt(refcount.end, encode(padding));
  }

  boundsUpdate() {
    const { ctx } = this;
    const func = ctx.func('BOUNDS_UPDATE');
    const copied = ctx.site('BOUNDS_UPDATE', () => seq(get(v('self')), get(v('next')), load64(v('nextTail')), store64(v('oldTail')), get(v('self')), get(v('next')), V128_LOAD(v('nextHead')), V128_STORE(v('oldHead')), get(v('dirty')), ifThen()), { label: 'the bounds copy' });
    const b = copied.bindings;
    const self = value(b, 'self');
    const next = value(b, 'next');
    const nextHead = value(b, 'nextHead');
    const oldHead = value(b, 'oldHead');
    const chain = ctx.site('BOUNDS_UPDATE', () => seq(get(self), load(v('renderer')), load(v('config')), load(v('storage')), put(v('storageLocal')), get(self), load(v('kind')), put(v('kindLocal'))), { label: 'the renderer config chain' });
    const c = chain.bindings;
    const slot = ctx.site('BOUNDS_UPDATE', () => seq(get(self), load(v('slot')), tee(v('slotLocal')), i32(0), GE_S, ifThen(), get(value(c, 'storageLocal')), load(v('kinds')), get(v('slotLocal')), ADD, get(self), load(value(c, 'kind')), store8(0)), { label: 'the kind store' });
    const k = slot.bindings;
    const owner = ctx.site('BOUNDS_UPDATE', () => seq(get(self), load(v('owner')), tee(v('ownerLocal')), i32(-1), EQ, ifThen()), { label: 'the owner check' });
    const kindsCode = seq(get(self), load(value(c, 'renderer')), load(value(c, 'config')), load(value(c, 'storage')), load(value(k, 'kinds')), get(self), load(value(k, 'slot')), ADD, load8());
    const same = (newOffset, oldOffset) => seq(get(next), load64(newOffset), get(self), load64(oldOffset), I64_EQ);
    const check = seq(
      get(value(b, 'dirty')), EQZ, get(self), load(value(k, 'slot')), i32(0), GE_S, AND, get(self), load(value(owner.bindings, 'owner')), i32(-1), NE, AND, ifThen(),
      same(nextHead, oldHead), same(nextHead + 8, oldHead + 8), AND, same(value(b, 'nextTail'), value(b, 'oldTail')), AND, ifThen(),
      kindsCode, get(self), load(value(c, 'kind')), i32(255), AND, EQ, ifThen(),
      ret,
      end, end, end,
    );
    this.editor(func).insertHead(encode(check));
  }

  lightListEnd() {
    const { ctx } = this;
    const limit = ctx.site('LIGHT_UPLOAD', () => seq(put(v('lights')), get(v('self')), load(v('limit')), tee(v('wanted')), get(v('list')), load(v('listEnd')), get(v('list')), load(v('listBegin')), SUB, i32(2), SHR_S, tee(v('have')), get(v('have')), get(v('wanted')), GT_U, SELECT, put(v('count')), loop(), get(v('index')), get(v('count')), GE_U, ifThen()), { label: 'the light loop head' });
    const b = limit.bindings;
    const stride = ctx.site('LIGHT_UPLOAD', () => seq(get(value(b, 'lights')), get(value(b, 'index')), i32(v('stride')), MUL, ADD), { label: 'the light entry stride' });
    const terminator = seq(
      get(value(b, 'count')), get(value(b, 'self')), load(value(b, 'limit')), LT_U, get(value(b, 'lights')), i32(0), NE, AND, ifThen(),
      get(value(b, 'lights')), get(value(b, 'count')), i32(value(stride.bindings, 'stride')), MUL, ADD, f32Zero, storef(STATE.LIGHT_RANGE_FIELD),
      end,
    );
    this.editor(ctx.func('LIGHT_UPLOAD')).insertAt(limit.end, encode(terminator));
    this.values.lightBytes = value(stride.bindings, 'stride');
  }

  rasterDepthClamp() {
    const { ctx } = this;
    const compare = ctx.site('RASTER_STATE', () => seq(get(v('cache')), load8(v('cachedClamp')), get(v('next')), load8(v('clamp')), NE, brIf(0), get(v('cache')), load8(v('cachedOther')), get(v('next')), load8(v('other')), EQ, brIf(1), end, get(v('cache')), get(v('next')), load64(0), store64(v('stateField'))), { label: 'the cached raster state compare and store' });
    const b = compare.bindings;
    if (value(b, 'cachedClamp') - value(b, 'stateField') !== value(b, 'clamp')) throw new PortError('the raster state compare no longer lines up with the cached state', { symbol: 'RASTER_STATE' });
    let writerSame = null;
    try {
      writerSame = ctx.unchanged('RASTER_WRITER');
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
    }
    if (writerSame === null) ctx.note('RASTER_WRITER has no match in the new build. Check that raster state byte 3 is still depth clamp.');
    else if (!writerSame) ctx.note('RASTER_WRITER changed. Check that raster state byte 3 is still depth clamp.');
    const toggle = seq(get(value(b, 'next')), load8(value(b, 'clamp')), ifThen(), i32(STATE.GL_DEPTH_CLAMP), call(this.module.importIndex('glEnable')), elseThen, i32(STATE.GL_DEPTH_CLAMP), call(this.module.importIndex('glDisable')), end);
    this.editor(ctx.func('RASTER_STATE')).insertAt(compare.end, encode(toggle));
  }

  lightCullSkip() {
    const { ctx } = this;
    const func = ctx.func('LIGHTING');
    const hit = ctx.site('LIGHTING', () => seq(block(), block(EXNREF), globalGet(0), i32(v('frame')), SUB, tee(v('sp')), globalSet(0), block(), i32(v('guard')), atomicLoad8()), { label: 'the light culling block', expect: { frame: 416 } });
    this.editor(func).insertAt(ctx.decoded('new', func)[hit.index + 1].start, encode(seq(flag(STATE.SKIP_LIGHT_CULL), brIf(0))));
  }

  shadowSites() {
    const { ctx } = this;
    const func = ctx.func('SHADOW_UPDATE');
    const decoded = ctx.decoded('new', func);
    const groups = ctx.site('SHADOW_UPDATE', () => seq(get(v('self')), i32(v('rects')), ADD, put(v('rectsLocal')), get(v('self')), load(v('renderer')), load(v('config')), load(v('storage')), put(v('storageLocal')), i32(0), put(v('index')), loop(), get(v('self')), load(v('groupsEnd')), get(v('self')), load(v('groupsBegin')), SUB, i32(v('groupBytes')), DIV_S, get(v('index')), LE_U, ifThen()), { label: 'the occlusion loop head' });
    const g = groups.bindings;
    const self = value(g, 'self');
    const index = value(g, 'index');
    const packing = ctx.site('SHADOW_UPDATE', () => seq(loop(), get(self), load(v('jobsEnd')), get(self), load(v('jobsBegin')), tee(v('begin')), SUB, i32(v('jobBytes')), DIV_S, get(v('packIndex')), LE_U, ifThen(), get(self), get(v('context')), get(v('scratch')), get(v('first')), get(v('count')), get(v('last')), call(v('tileJob'))), { label: 'the tile packing loop head' });
    const p = packing.bindings;
    const packIndex = value(p, 'packIndex');
    const tileJob = ctx.bindFunction('TILE_JOB', value(p, 'tileJob'), 'the tile packing loop');
    const scratch = value(p, 'scratch');
    const jobBytes = value(p, 'jobBytes');
    const rect = ctx.site('SHADOW_UPDATE', () => seq(get(v('jobsHere')), get(packIndex), i32(jobBytes), MUL, ADD, tee(v('job')), load(0), load(v('entries')), get(v('job')), load(v('entryIndex')), i32(v('entryBytes')), MUL, ADD, load(v('rectField')), call(v('rectOf')), tee(v('rect')), V128_LOAD64_ZERO(v('rectSize')), V128_CONST, I32X4_ADD, V128_STORE64_LANE(v('sizeField')), get(v('job')), get(scratch), get(v('out')), i32(v('sizeBase')), ADD, tee(v('sizeLocal')), call(v('packRect')), tee(v('result')), store(v('jobResult')), get(v('result')), i32(0), LT_S, ifThen()), { label: 'the tile packing step' });
    const r = rect.bindings;
    ctx.bindFunction('RECT_OF', value(r, 'rectOf'), 'the tile packing step');
    ctx.bindFunction('PACK_RECT', value(r, 'packRect'), 'the tile packing step');
    const padding = this.rectPadding(decoded.slice(rect.index, rect.next).find(instruction => instruction.op === 0xfd && instruction.sub === 12));
    const flush = ctx.site('SHADOW_UPDATE', () => seq(get(self), get(value(p, 'context')), get(scratch), get(value(p, 'first')), get(value(p, 'count')), get(value(p, 'last')), call(tileJob), get(scratch), call(v('clearPacker'))), { label: 'the packer reset' });
    ctx.bindFunction('CLEAR_PACKER', value(flush.bindings, 'clearPacker'), 'the packer reset');
    const entry = ctx.site('SHADOW_UPDATE', () => seq(get(self), load(value(p, 'jobsBegin')), get(index), i32(jobBytes), MUL, ADD, tee(v('job')), load(0), load(value(r, 'entries')), get(v('job')), load(value(r, 'entryIndex')), i32(value(r, 'entryBytes')), MUL, ADD, tee(v('entry')), load(value(r, 'rectField')), call(value(r, 'rectOf')), load(v('rectHeight')), put(v('height')), get(v('out')), i32(1), store8(v('flagField')), get(v('out')), V128_CONST, V128_STORE(v('zeroField'))), { label: 'the occlusion query setup' });
    const e = entry.bindings;
    if (value(e, 'rectHeight') !== value(r, 'rectSize') + 4) throw new PortError('the shadow rect width and height are no longer next to each other', { symbol: 'SHADOW_UPDATE' });
    const shadow = ctx.site('SHADOW_UPDATE', () => seq(get(value(e, 'out')), get(value(e, 'entry')), i32(v('shadowOffset')), ADD, store(v('entryField'))), { label: 'the shadow map pointer store' });
    const scale = this.shadowScale(value(e, 'out'), value(e, 'height'));
    const occlusion = ctx.site('SHADOW_UPDATE', () => seq(get(value(e, 'out')), i32(v('queryBase')), ADD, gap(2), get(index), i32(value(g, 'groupBytes')), MUL, ADD, i32(0), call(v('occlusion'))), { label: 'the occlusion call' });
    const o = occlusion.bindings;
    ctx.bindFunction('OCCLUSION', value(o, 'occlusion'), 'the occlusion call');
    const queryBase = value(o, 'queryBase');
    if (value(e, 'flagField') !== queryBase) throw new PortError('the occlusion query no longer starts at its flag field', { symbol: 'SHADOW_UPDATE' });
    return {
      groups, packing, self, index, packIndex,
      layout: {
        rects: value(g, 'rects'), renderer: value(g, 'renderer'), config: value(g, 'config'), storage: value(g, 'storage'),
        groupsBegin: value(g, 'groupsBegin'), groupsEnd: value(g, 'groupsEnd'), groupBytes: value(g, 'groupBytes'),
        jobsBegin: value(p, 'jobsBegin'), jobsEnd: value(p, 'jobsEnd'), jobBytes,
        entries: value(r, 'entries'), entryIndex: value(r, 'entryIndex'), entryBytes: value(r, 'entryBytes'), rectField: value(r, 'rectField'),
        rectWidth: value(r, 'rectSize'), rectHeight: value(e, 'rectHeight'), padding, jobResult: value(r, 'jobResult'),
        shadowOffset: value(shadow.bindings, 'shadowOffset'), lodField: scale.lodField,
        queryEntry: value(shadow.bindings, 'entryField') - queryBase, queryZero: value(e, 'zeroField') - queryBase, queryScale: scale.scaleField - queryBase,
      },
      args: { context: value(p, 'context'), scratch, first: value(p, 'first'), count: value(p, 'count'), last: value(p, 'last') },
    };
  }

  shadowScale(out, height) {
    const { ctx } = this;
    const forms = [
      () => {
        const config = ctx.site('SHADOW_UPDATE', f => seq(call(f('RENDER_CONFIG')), gap(12), loadf(v('lodField')), put(v('lod'))), { label: 'the render config read' });
        const store = ctx.site('SHADOW_UPDATE', () => seq(get(out), get(value(config.bindings, 'lod')), get(height), F32_FROM_I32, F32_DIV, storef(v('scaleField'))), { label: 'the shadow scale store' });
        return { lodField: value(config.bindings, 'lodField'), scaleField: value(store.bindings, 'scaleField') };
      },
      () => {
        const site = ctx.site('SHADOW_UPDATE', f => seq(call(f('RENDER_CONFIG')), put(v('config')), gap(12), get(out), get(v('config')), loadf(v('lodField')), get(height), F32_FROM_I32, F32_DIV, storef(v('scaleField'))), { label: 'the shadow scale computed straight from the render config' });
        return { lodField: value(site.bindings, 'lodField'), scaleField: value(site.bindings, 'scaleField') };
      },
    ];
    let first = null;
    for (const form of forms) {
      try {
        return form();
      } catch (error) {
        if (!(error instanceof PortError)) throw error;
        first = first || error;
      }
    }
    throw first;
  }

  rectPadding(instruction) {
    const bytes = this.module.buffer.subarray(instruction.start + 2, instruction.start + 18);
    const padding = bytes.readUInt32LE(0);
    if (bytes.readUInt32LE(4) !== padding) throw new PortError('the shadow rect padding is not the same in both directions', { symbol: 'SHADOW_UPDATE' });
    return padding;
  }

  shadowUpdate(sites) {
    const { ctx } = this;
    const { groups, packing, self, index, packIndex, args, layout } = sites;
    const func = ctx.func('SHADOW_UPDATE');
    const decoded = ctx.decoded('new', func);
    const editor = this.editor(func);
    const skip = target => encode(seq(flag(STATE.SHADOW_THREAD), ifThen(), i32(0x7fffffff), put(target), end));
    editor.insertAt(packing.start, skip(packIndex));
    editor.insertAt(decoded[groups.index + 11].start, skip(index));
    const jobCall = decoded.slice(packing.index + 12, packing.next);
    const jobs = seq(get(self), load(layout.jobsEnd), get(self), load(layout.jobsBegin), SUB, i32(layout.jobBytes), DIV_S);
    const values = [get(self), get(args.context), get(args.scratch), jobs, i32(0), get(args.last)];
    const stores = values.flatMap((item, position) => seq(i32(STATE.JOB + position * 4), item, store()));
    const pending = seq(i32(STATE.JOB_ACTIVE), i32(STATE.JOB_PENDING), store8());
    const originalCall = this.module.buffer.subarray(jobCall[0].start, jobCall[jobCall.length - 1].end);
    const kick = Buffer.concat([encode(seq(flag(STATE.SHADOW_THREAD), ifThen(), stores, pending, elseThen)), originalCall, encode(end)]);
    editor.replace(jobCall[0].start, jobCall[jobCall.length - 1].end, kick);
  }

  shadowBatches(sites) {
    const { ctx } = this;
    const { layout } = sites;
    const THIS = 0, CONTEXT = 1, SCRATCH = 2, JOBS = 3, LAST = 5;
    const INDEX = 6, FIRST = 7, COUNT = 8, JOB = 9, RECT = 10, SP = 11, RESULT = 12, ENTRY = 13;
    const FRAME = 64;
    const QUERY = 16;
    const flush = seq(get(THIS), get(CONTEXT), get(SCRATCH), get(FIRST), get(COUNT), get(LAST), call(ctx.func('TILE_JOB')));
    const pack = seq(get(JOB), get(SCRATCH), get(SP), call(ctx.func('PACK_RECT')));
    const jobAt = seq(get(THIS), load(layout.jobsBegin), get(INDEX), i32(layout.jobBytes), MUL, ADD, put(JOB));
    const entryAt = seq(get(JOB), load(), load(layout.entries), get(JOB), load(layout.entryIndex), i32(layout.entryBytes), MUL, ADD);
    const rectAt = seq(get(THIS), i32(layout.rects), ADD);
    const config = seq(get(THIS), load(layout.renderer), load(layout.config));
    const code = seq(
      globalGet(0), i32(FRAME), SUB, tee(SP), globalSet(0),
      i32(STATE.HELPER_VECTOR + 4), i32(STATE.HELPER_VECTOR), load(), store(),
      block(), loop(),
      get(INDEX), get(JOBS), GE_U, brIf(1),
      jobAt,
      entryAt, put(ENTRY),
      rectAt, get(ENTRY), load(layout.rectField), call(ctx.func('RECT_OF')), put(RECT),
      get(SP), i32(0), store(QUERY),
      get(SP), get(ENTRY), i32(layout.shadowOffset), ADD, store(QUERY + layout.queryEntry),
      get(SP), i32(0), store(QUERY + layout.queryZero),
      get(SP), i32(0), store(QUERY + layout.queryZero + 4),
      get(SP), config, call(ctx.func('RENDER_CONFIG')), loadf(layout.lodField), get(RECT), load(layout.rectHeight), F32_FROM_I32, F32_DIV, storef(QUERY + layout.queryScale),
      get(SP), f32Zero, storef(QUERY + layout.queryScale + 4),
      config, load(layout.storage), get(SP), i32(QUERY), ADD,
      get(THIS), load(layout.groupsBegin), get(INDEX), i32(layout.groupBytes), MUL, ADD,
      i32(0), call(ctx.func('OCCLUSION')),
      get(INDEX), i32(1), ADD, put(INDEX),
      br(0), end, end,
      i32(0), put(INDEX),
      block(), loop(),
      get(INDEX), get(JOBS), GE_U, brIf(1),
      jobAt,
      rectAt, entryAt, load(layout.rectField),
      call(ctx.func('RECT_OF')), put(RECT),
      get(SP), get(RECT), load(layout.rectWidth), i32(layout.padding), ADD, store(),
      get(SP), get(RECT), load(layout.rectHeight), i32(layout.padding), ADD, store(4),
      pack, tee(RESULT), store(layout.jobResult),
      get(RESULT), i32(0), LT_S, ifThen(),
      flush,
      get(SCRATCH), call(ctx.func('CLEAR_PACKER')),
      pack, store(layout.jobResult),
      i32(0), put(COUNT), get(INDEX), put(FIRST),
      end,
      get(COUNT), i32(1), ADD, put(COUNT),
      get(INDEX), i32(1), ADD, put(INDEX),
      br(0), end, end,
      flush,
      get(SP), i32(FRAME), ADD, globalSet(0), end,
    );
    return bodyWithLocals(8, code);
  }

  lockBody() {
    const { ctx } = this;
    const ME = 0, SPINS = 1;
    return bodyWithLocals(2, seq(
      call(ctx.func('PTHREAD_SELF')), put(ME),
      i32(STATE.LOCK), atomicLoad(), get(ME), EQ, ifThen(),
      i32(STATE.DEPTH), i32(STATE.DEPTH), load(), i32(1), ADD, store(), ret, end,
      loop(),
      i32(STATE.LOCK), i32(0), get(ME), atomicCmpxchg(), EQZ, ifThen(),
      i32(STATE.DEPTH), i32(1), store(), ret, end,
      get(SPINS), i32(1), ADD, tee(SPINS), i32(65535), AND, EQZ,
      i32(STATE.REQUEST_FLAG), load8(), OR, ifThen(),
      get(ME), i32(STATE.HELPER_ID), load(), NE, ifThen(),
      this.gateCall(STATE.SERVICE),
      end, end,
      br(0), end, end,
    ));
  }

  unlockBody() {
    return bodyWithLocals(0, seq(
      i32(STATE.DEPTH), i32(STATE.DEPTH), load(), i32(1), SUB, store(),
      i32(STATE.DEPTH), load(), EQZ, ifThen(),
      i32(STATE.LOCK_RELEASES), i32(STATE.LOCK_RELEASES), load(), i32(1), ADD, store(),
      i32(STATE.LOCK), i32(0), atomicStore(), end, end,
    ));
  }

  markSlot(at) {
    return seq(i32(STATE.BLOCK), load(), i32(STATE.MARKS_AT), ADD, get(at), i32(STATE.MARKS_CAPACITY - 1), AND, i32(STATE.MARK_BYTES), MUL, ADD);
  }

  textureMarkBody(moved) {
    const { ctx } = this;
    const AT = 8, SLOT = 9;
    const args = [];
    for (let index = 0; index < TEXTURE_MARK_ARGS; index++) args.push(...get(index));
    const saves = [];
    for (let index = 0; index < TEXTURE_MARK_ARGS; index++) {
      saves.push(...seq(get(SLOT), get(index), TEXTURE_MARK_FLOATS.has(index) ? storef(index * 4) : store(index * 4)));
    }
    return bodyWithLocals(2, seq(
      i32(STATE.JOB_ACTIVE), load8(), i32(STATE.JOB_RUNNING), EQ, ifThen(),
      call(ctx.func('PTHREAD_SELF')), i32(STATE.HELPER_ID), load(), NE, ifThen(),
      i32(STATE.MARKS_WRITE), load(), put(AT),
      get(AT), i32(STATE.MARKS_READ), atomicLoad(), SUB, i32(STATE.MARKS_CAPACITY), LT_U, ifThen(),
      this.markSlot(AT), put(SLOT),
      saves,
      i32(STATE.MARKS_WRITE), get(AT), i32(1), ADD, atomicStore(),
      ret, end, end, end,
      args, call(moved), end,
    ));
  }

  drainMarksBody(moved) {
    const AT = 0, SLOT = 1;
    const reads = [];
    for (let index = 0; index < TEXTURE_MARK_ARGS; index++) {
      reads.push(...seq(get(SLOT), TEXTURE_MARK_FLOATS.has(index) ? loadf(index * 4) : load(index * 4)));
    }
    return bodyWithLocals(2, seq(
      loop(),
      i32(STATE.MARKS_READ), load(), put(AT),
      get(AT), i32(STATE.MARKS_WRITE), atomicLoad(), EQ, ifThen(), ret, end,
      this.markSlot(AT), put(SLOT),
      reads,
      call(moved),
      i32(STATE.MARKS_READ), get(AT), i32(1), ADD, atomicStore(),
      br(0), end, end,
    ));
  }

  lockedWrapperBody(func, moved, lock, unlock) {
    const signature = this.module.signature(func);
    if (signature.results.length) throw new PortError(`function ${func} now returns a value, so it can't be wrapped in the shadow lock`);
    const args = [];
    signature.params.forEach((_, index) => args.push(...get(index)));
    return bodyWithLocals(0, seq(
      i32(STATE.JOB_ACTIVE), load8(), i32(STATE.JOB_RUNNING), NE, ifThen(), args, call(moved), ret, end,
      call(lock),
      block(EXNREF),
      tryTable(-64, [{ kind: 3, label: 0 }]),
      args, call(moved), call(unlock), ret,
      end, unreachable, end,
      call(unlock), throwRef, end,
    ));
  }

  helperCopy(func, addressMap, fieldMap) {
    const module = this.module;
    const decoded = this.ctx.decoded('new', func);
    const { start } = module.bodyBounds(func);
    const first = decoded[0].start;
    const parts = [module.buffer.subarray(start, first)];
    let constants = 0;
    let fields = 0;
    for (const instruction of decoded) {
      if (instruction.op === 0x41 && addressMap.has(instruction.a)) {
        parts.push(encode(i32(addressMap.get(instruction.a))));
        constants++;
      } else if (instruction.op >= 0x28 && instruction.op <= 0x3e && fieldMap.has(instruction.a)) {
        parts.push(Buffer.from([instruction.op]), uleb(instruction.align), uleb(fieldMap.get(instruction.a)));
        fields++;
      } else {
        parts.push(module.buffer.subarray(instruction.start, instruction.end));
      }
    }
    if (!constants || !fields) throw new PortError('the helper thread copy changed nothing');
    return Buffer.concat(parts);
  }

  helperDispatch(func, copy) {
    const args = [];
    this.module.signature(func).params.forEach((_, index) => args.push(...get(index)));
    const check = seq(i32(STATE.JOB_ACTIVE), load8(), ifThen(), call(this.ctx.func('PTHREAD_SELF')), i32(STATE.HELPER_ID), load(), EQ, ifThen(), args, call(copy), ret, end, end);
    this.editor(func).insertHead(encode(check));
  }

  shadowThread() {
    const { ctx, module } = this;
    if (ctx.newModule.dataSegments.length && Math.min(...ctx.newModule.dataSegments.filter(segment => segment.offset !== null).map(segment => segment.offset), Infinity) < 1024) {
      throw new PortError('the engine now keeps data below address 1024, where the helper thread state lives');
    }
    if (module.paramCount(ctx.func('TILE_JOB')) !== TILE_JOB_ARGS) throw new PortError(`the shadow tile job no longer takes ${TILE_JOB_ARGS} values, and public/js/gl-thread.js passes that many`, { symbol: 'TILE_JOB' });
    if (module.signature(ctx.func('TEXTURE_MARK')).key !== TEXTURE_MARK_SIGNATURE) throw new PortError('the texture mark function has a different signature now', { symbol: 'TEXTURE_MARK' });
    const sites = this.shadowSites();

    const kickSite = ctx.site('SCENE_PREPARE', () => seq(get(v('self')), load(0), load(v('field')), put(v('local')), get(v('self')), get(v('self')), loadf(v('a')), storef(v('b'))), { label: 'the point after the main view gather', expect: { field: 2872 } });
    this.editor(ctx.func('SCENE_PREPARE')).insertAt(kickSite.start, encode(seq(i32(STATE.JOB_ACTIVE), load8(), i32(STATE.JOB_PENDING), EQ, ifThen(), this.gateCall(STATE.KICK), end)));

    const outer = ctx.site('RENDER_OUTER', () => seq(call(v('perform'))), { label: 'the render call' });
    ctx.bindFunction('RENDER_PERFORM', value(outer.bindings, 'perform'), 'the render call');
    this.editor(ctx.func('RENDER_OUTER')).insertAt(outer.end, encode(this.joinIfActive()));

    this.shadowUpdate(sites);

    const threadCreate = seq(
      i32(STATE.THREAD_REQUEST), load8(), ifThen(),
      i32(STATE.THREAD_REQUEST), i32(0), store8(),
      i32(STATE.BLOCK), i32(STATE.BLOCK_BYTES), call(ctx.func('OPERATOR_NEW')), store(),
      i32(STATE.HELPER_ID), i32(STATE.ATTR), i32(THREAD_ATTR_ARG), i32(STATE.THREAD_ARG), call(ctx.func('PTHREAD_CREATE')), drop,
      end,
    );
    this.editor(ctx.func('LIGHTING')).insertHead(encode(threadCreate));
    this.editor(ctx.func('CULL_TREE')).insertHead(encode(this.joinIfActive()));

    const cluster = ctx.site('CLUSTER_NEW', f => seq(i32(v('bytes')), call(f('OPERATOR_NEW'))), { label: 'the cluster allocation', expect: { bytes: 340 } });
    const clusterBytes = value(cluster.bindings, 'bytes');
    const constants = ctx.profile.wasm.constants;
    if (!constants.CLUSTER_FIELDS || !constants.BATCH_VECTOR) throw new PortError('the profile lost the cluster fields when an earlier update could not translate them');
    const fields = constants.CLUSTER_FIELDS.map(field => ctx.translateOffset('CLUSTER_PREPARE', field));
    this.editor(ctx.func('CLUSTER_NEW')).replace(cluster.start, ctx.decoded('new', ctx.func('CLUSTER_NEW'))[cluster.index].end, encode(i32(clusterBytes + 4 * fields.length)));
    const fieldMap = new Map(fields.map((field, index) => [field, clusterBytes + index * 4]));
    const addressMap = new Map(constants.BATCH_VECTOR.map((address, index) => [ctx.translateConstant('CLUSTER_PREPARE', address), STATE.HELPER_VECTOR + index * 4]));

    const lock = this.nextIndex();
    this.added.push({ type: module.typeIndex('>'), body: this.lockBody() });
    const unlock = this.nextIndex();
    this.added.push({ type: module.typeIndex('>'), body: this.unlockBody() });
    const batches = this.nextIndex();
    this.added.push({ type: module.typeOf(ctx.func('TILE_JOB')), body: this.shadowBatches(sites) });
    for (const name of ['CLUSTER_PREPARE', 'CLUSTER_DRAW']) {
      const func = ctx.func(name);
      const copy = this.nextIndex();
      this.added.push({ type: module.typeOf(func), body: this.helperCopy(func, addressMap, fieldMap) });
      this.helperDispatch(func, copy);
    }
    for (const name of ['LOCKED_GATHER', 'LOCKED_MARK_B', 'LOCKED_MARK_C']) {
      const func = ctx.func(name);
      const moved = this.nextIndex();
      this.added.push({ type: module.typeOf(func), body: module.body(func), moved: func });
      this.editor(func).replaceWhole = this.lockedWrapperBody(func, moved, lock, unlock);
    }
    const mark = ctx.func('TEXTURE_MARK');
    const movedMark = this.nextIndex();
    this.added.push({ type: module.typeOf(mark), body: module.body(mark), moved: mark });
    this.editor(mark).replaceWhole = this.textureMarkBody(movedMark);
    const drain = this.nextIndex();
    this.added.push({ type: module.typeIndex('>'), body: this.drainMarksBody(movedMark) });
    this.exports = [['wb_thread_create', ctx.func('PTHREAD_CREATE')], ['wb_shadow_tiles', batches], ['wb_drain_marks', drain]];
    this.values.shadowLayout = sites.layout;
    this.values.clusterBytes = clusterBytes;
    this.values.clusterFields = fields;
    this.values.batchVector = [...addressMap.keys()];
  }

  plan() {
    const { module } = this;
    const edits = new Map();
    for (const [func, editor] of this.editors) edits.set(func, editor.replaceWhole || editor.build());
    const planEdits = [];
    for (const func of [...edits.keys()].sort((a, b) => a - b)) {
      planEdits.push({ func, ...shrink(module.body(func), edits.get(func)) });
    }
    const plan = {
      sourceSha256: sha(module.buffer),
      patchedSha256: '',
      imports: module.importCount,
      edits: planEdits,
      added: this.added.map(entry => (entry.moved !== undefined ? { type: entry.type, moved: entry.moved } : { type: entry.type, hex: entry.body.toString('hex') })),
      exports: this.exports,
    };
    const result = spliceRenderThreads(module.buffer, plan);
    plan.patchedSha256 = sha(result);
    return { plan, result };
  }
}

const UNITS = [
  { id: 'particle-curves', required: false, title: 'Particle curve lookups without table copies', run: g => g.particleCurves() },
  { id: 'bounds-update', required: false, title: 'Skip bounds updates that change nothing', run: g => g.boundsUpdate() },
  { id: 'light-list-end', required: true, title: 'End marker on the light list', run: g => g.lightListEnd() },
  { id: 'raster-depth-clamp', required: true, title: 'Depth clamp for directional shadows', run: g => g.rasterDepthClamp() },
  { id: 'light-cull-skip', required: false, title: 'Skip the engine light culling', run: g => g.lightCullSkip() },
  { id: 'shadow-thread', required: false, title: 'Shadow helper thread', run: g => g.shadowThread(), atomic: true },
];

function generate(ctx) {
  const generator = new Generator(ctx);
  const results = [];
  for (const unit of UNITS) {
    const before = {
      editors: new Map([...generator.editors].map(([func, editor]) => [func, { splices: [...editor.splices], replaceWhole: editor.replaceWhole }])),
      added: [...generator.added],
      exports: [...generator.exports],
    };
    try {
      unit.run(generator);
      results.push({ id: unit.id, title: unit.title, required: unit.required, status: 'ported' });
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      generator.editors = new Map();
      for (const [func, state] of before.editors) {
        const editor = ctx.edits(func);
        editor.splices = state.splices;
        editor.replaceWhole = state.replaceWhole;
        generator.editors.set(func, editor);
      }
      generator.added = before.added;
      generator.exports = before.exports;
      results.push({ id: unit.id, title: unit.title, required: unit.required, status: 'failed', reason: error.message, details: error.details });
    }
  }
  const { plan, result } = generator.plan();
  return { plan, result, units: results, values: generator.values };
}

module.exports = { generate, UNITS, STATE, shrink, sha };
