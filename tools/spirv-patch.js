'use strict';

const MAGIC = 0x07230203;
const Op = {
  Name: 5, EntryPoint: 15, TypeVoid: 19, TypeBool: 20, TypeInt: 21, TypeFloat: 22, TypeVector: 23,
  TypeMatrix: 24, TypeArray: 28, TypeRuntimeArray: 29, TypeStruct: 30, TypePointer: 32, Constant: 43,
  Function: 54, Variable: 59, Load: 61, CopyMemory: 63, AccessChain: 65, InBoundsAccessChain: 66,
  PtrAccessChain: 67, Decorate: 71, MemberDecorate: 72, DecorationGroup: 73, GroupDecorate: 74,
  GroupMemberDecorate: 75, CompositeConstruct: 80, CompositeExtract: 81, ConvertFToU: 109,
  ConvertFToS: 110, Bitcast: 124,
};
const Decoration = { Block: 2, BufferBlock: 3, ArrayStride: 6, BuiltIn: 11, Location: 30, Binding: 33 };
const Storage = { UniformConstant: 0, Input: 1, Uniform: 2, Output: 3, Function: 7 };
const ExecutionModel = { Vertex: 0, Fragment: 4 };
const MAX_UNROLLED_ARRAY = 64;

function decode(buf) {
  if (buf.length % 4 || buf.readUInt32LE(0) !== MAGIC) throw new Error('not a SPIR-V module');
  const words = new Uint32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const insts = [];
  for (let i = 5; i < words.length;) {
    const count = words[i] >>> 16;
    if (!count || i + count > words.length) throw new Error('malformed SPIR-V instruction stream');
    insts.push({ op: words[i] & 0xffff, args: Array.from(words.subarray(i + 1, i + count)) });
    i += count;
  }
  return { header: Array.from(words.subarray(0, 5)), insts };
}

function encode(module) {
  let size = 5;
  for (const inst of module.insts) size += 1 + inst.args.length;
  const words = new Uint32Array(size);
  words.set(module.header, 0);
  let i = 5;
  for (const inst of module.insts) {
    words[i++] = ((inst.args.length + 1) << 16) | inst.op;
    words.set(inst.args, i);
    i += inst.args.length;
  }
  return Buffer.from(words.buffer);
}

function literalString(text) {
  const bytes = Buffer.alloc(Math.floor(text.length / 4) * 4 + 4);
  bytes.write(text, 'latin1');
  const out = [];
  for (let i = 0; i < bytes.length; i += 4) out.push(bytes.readUInt32LE(i));
  return out;
}

function isTypeOp(op) {
  return (op >= Op.TypeVoid && op <= 39) || op === 322;
}

function inputSemantic(location) {
  return ['POSITION', 'NORMAL', 'COLOR0', 'COLOR1'][location] || `TEXCOORD${location - 4}`;
}

function patch(buf) {
  const module = decode(buf);
  const insts = module.insts;
  const defs = new Map();
  const valueType = new Map();
  let model = null;
  for (const inst of insts) {
    if (inst.op === Op.EntryPoint && model === null) model = inst.args[0];
    if (inst.op === Op.DecorationGroup || inst.op === Op.GroupDecorate || inst.op === Op.GroupMemberDecorate) throw new Error('decoration groups are not supported');
    if (isTypeOp(inst.op)) defs.set(inst.args[0], inst);
    else if ([Op.Constant, Op.Variable, 41, 42, 44, 46].includes(inst.op)) defs.set(inst.args[1], inst);
  }
  for (const inst of insts) {
    if (!isTypeOp(inst.op) && inst.args.length >= 2 && defs.has(inst.args[0]) && isTypeOp(defs.get(inst.args[0]).op)) valueType.set(inst.args[1], inst.args[0]);
  }
  if (model !== ExecutionModel.Vertex && model !== ExecutionModel.Fragment) throw new Error(`unsupported execution model ${model}`);

  let bound = module.header[3];
  const newId = () => bound++;
  const typeOf = id => defs.get(id);
  const decoration = (id, kind) => insts.find(i => i.op === Op.Decorate && i.args[0] === id && i.args[1] === kind);
  const constantValue = id => {
    const c = defs.get(id);
    if (!c || c.op !== Op.Constant) throw new Error('non-constant struct index');
    return c.args[2];
  };
  const placeAfter = (deps, inst) => {
    const at = Math.max(...deps.map(d => insts.indexOf(defs.get(d))));
    insts.splice(at + 1, 0, inst);
    defs.set(inst.args[0], inst);
    return inst.args[0];
  };
  const findType = (op, operands) => insts.find(i => i.op === op && i.args.length === operands.length + 1 && operands.every((a, k) => i.args[k + 1] === a));
  const scalarType = (op, operands) => {
    const found = findType(op, operands);
    if (found) return found.args[0];
    const firstType = insts.findIndex(i => isTypeOp(i.op));
    const inst = { op, args: [newId(), ...operands] };
    insts.splice(firstType, 0, inst);
    defs.set(inst.args[0], inst);
    return inst.args[0];
  };
  const floatScalar = () => scalarType(Op.TypeFloat, [32]);
  const signedInt = () => scalarType(Op.TypeInt, [32, 1]);
  const vectorOf = (component, count) => {
    const found = findType(Op.TypeVector, [component, count]);
    return found ? found.args[0] : placeAfter([component], { op: Op.TypeVector, args: [newId(), component, count] });
  };
  const pointerTo = (storage, pointee) => {
    const found = findType(Op.TypePointer, [storage, pointee]);
    return found ? found.args[0] : placeAfter([pointee], { op: Op.TypePointer, args: [newId(), storage, pointee] });
  };
  const isIntScalarOrVector = id => {
    const t = typeOf(id);
    return t.op === Op.TypeInt || (t.op === Op.TypeVector && typeOf(t.args[1]).op === Op.TypeInt);
  };
  const floatEquivalent = id => {
    const t = typeOf(id);
    if (t.op === Op.TypeInt) return floatScalar();
    return vectorOf(floatScalar(), t.args[2]);
  };
  const componentOf = id => (typeOf(id).op === Op.TypeVector ? typeOf(id).args[1] : id);
  const isSigned = id => typeOf(componentOf(id)).args[2] === 1;

  const twins = new Map();
  const needsTwin = id => {
    const t = typeOf(id);
    if (isIntScalarOrVector(id)) return true;
    if (t.op === Op.TypeArray || t.op === Op.TypeRuntimeArray) return needsTwin(t.args[1]);
    if (t.op === Op.TypeStruct) return t.args.slice(1).some(needsTwin);
    return false;
  };
  const twinOf = id => {
    if (!needsTwin(id)) return id;
    if (twins.has(id)) return twins.get(id);
    const t = typeOf(id);
    let twin;
    if (isIntScalarOrVector(id)) {
      twin = floatEquivalent(id);
    } else if (t.op === Op.TypeArray) {
      const element = twinOf(t.args[1]);
      twin = placeAfter([element, t.args[2], id], { op: Op.TypeArray, args: [newId(), element, t.args[2]] });
      const stride = decoration(id, Decoration.ArrayStride);
      if (!stride) throw new Error('uniform array without an ArrayStride');
      insts.splice(insts.indexOf(stride) + 1, 0, { op: Op.Decorate, args: [twin, Decoration.ArrayStride, stride.args[2]] });
    } else if (t.op === Op.TypeRuntimeArray) {
      throw new Error('runtime arrays inside uniform blocks are not supported');
    } else {
      const members = t.args.slice(1).map(twinOf);
      twin = placeAfter([...members, id], { op: Op.TypeStruct, args: [newId(), ...members] });
      const copies = insts.filter(i => (i.op === Op.MemberDecorate && i.args[0] === id) || (i.op === Op.Decorate && i.args[0] === id && i.args[1] === Decoration.Block));
      const anchor = copies.length ? insts.indexOf(copies[copies.length - 1]) : insts.findIndex(i => i.op === Op.Decorate);
      insts.splice(anchor + 1, 0, ...copies.map(c => ({ op: c.op, args: [twin, ...c.args.slice(1)] })));
    }
    twins.set(id, twin);
    return twin;
  };

  const variables = insts.filter(i => i.op === Op.Variable && i.args[2] !== Storage.Function);
  const names = new Map();
  const pointerInfo = new Map();
  for (const v of variables) {
    const [ptrType, id, storage] = v.args;
    const pointee = typeOf(ptrType).args[2];
    const binding = decoration(id, Decoration.Binding);
    const location = decoration(id, Decoration.Location);
    const builtin = decoration(id, Decoration.BuiltIn);
    if (storage === Storage.Uniform) {
      if (decoration(pointee, Decoration.BufferBlock)) throw new Error('uses storage buffers, which WebGL 2 does not have');
      if (typeOf(pointee).op === Op.TypeArray) throw new Error('arrays of uniform blocks are not supported');
      if (!decoration(pointee, Decoration.Block)) throw new Error('uniform buffer without a Block decoration');
      if (!binding) throw new Error('uniform block without a binding');
      const twin = twinOf(pointee);
      names.set(id, `CB${binding.args[2]}`);
      names.set(twin, `CB${binding.args[2]}`);
      if (twin !== pointee) v.args[0] = pointerTo(storage, twin);
      pointerInfo.set(id, { storage, type: twin, original: pointee, convert: null });
    } else if (storage === Storage.UniformConstant) {
      if (!binding) throw new Error('resource without a binding');
      names.set(id, `Texture${binding.args[2]}Texture`);
    } else if (storage === Storage.Input || storage === Storage.Output) {
      if (builtin) continue;
      if (!location) throw new Error('interface variable without a location');
      const loc = location.args[2];
      if (storage === Storage.Input) names.set(id, model === ExecutionModel.Vertex ? inputSemantic(loc) : `VARYING${loc}`);
      else names.set(id, model === ExecutionModel.Vertex ? `VARYING${loc}` : loc === 0 ? '_entryPointOutput' : `_entryPointOutput${loc}`);
      if (storage === Storage.Input && model === ExecutionModel.Vertex && isIntScalarOrVector(pointee)) {
        const to = floatEquivalent(pointee);
        v.args[0] = pointerTo(storage, to);
        pointerInfo.set(id, { storage, type: to, original: pointee, convert: isSigned(pointee) ? Op.ConvertFToS : Op.ConvertFToU });
      }
    }
  }

  const body = insts.slice(insts.findIndex(i => i.op === Op.Function));
  const out = [];
  const emit = (op, resultType, operands) => {
    const id = newId();
    out.push({ op, args: [resultType, id, ...operands] });
    return id;
  };
  const rebuild = (value, from, to, convertOp) => {
    if (from === to) return value;
    const t = typeOf(to);
    if (isIntScalarOrVector(to)) return emit(convertOp, to, [value]);
    if (t.op === Op.TypeStruct) {
      const parts = t.args.slice(1).map((member, i) => {
        const memberFrom = typeOf(from).args[1 + i];
        return rebuild(emit(Op.CompositeExtract, memberFrom, [value, i]), memberFrom, member, convertOp);
      });
      return emit(Op.CompositeConstruct, to, parts);
    }
    if (t.op === Op.TypeArray) {
      const count = constantValue(t.args[2]);
      if (count > MAX_UNROLLED_ARRAY) throw new Error(`whole-array uniform load of ${count} elements`);
      const elementFrom = typeOf(from).args[1];
      const parts = [];
      for (let i = 0; i < count; i++) parts.push(rebuild(emit(Op.CompositeExtract, elementFrom, [value, i]), elementFrom, t.args[1], convertOp));
      return emit(Op.CompositeConstruct, to, parts);
    }
    throw new Error(`cannot convert a value of type op ${t.op}`);
  };

  for (const inst of body) {
    if ((inst.op === Op.AccessChain || inst.op === Op.InBoundsAccessChain) && pointerInfo.has(inst.args[2])) {
      const info = pointerInfo.get(inst.args[2]);
      let type = info.type;
      let original = info.original;
      for (let n = 3; n < inst.args.length; n++) {
        const index = inst.args[n];
        const t = typeOf(type);
        if (t.op === Op.TypeStruct) {
          const member = constantValue(index);
          type = t.args[1 + member];
          original = typeOf(original).args[1 + member];
        } else if (t.op === Op.TypeArray || t.op === Op.TypeRuntimeArray || t.op === Op.TypeMatrix || t.op === Op.TypeVector) {
          const vt = valueType.get(index);
          if (info.storage === Storage.Uniform && vt && typeOf(vt).op === Op.TypeInt && typeOf(vt).args[2] === 0 && defs.get(index)?.op !== Op.Constant) {
            inst.args[n] = emit(Op.Bitcast, signedInt(), [index]);
          }
          type = t.args[1];
          original = typeOf(original).args[1];
        } else {
          throw new Error(`cannot index into type op ${t.op}`);
        }
      }
      const changed = type !== original;
      pointerInfo.set(inst.args[1], { storage: info.storage, type, original, convert: changed ? info.convert || Op.Bitcast : null });
      if (typeOf(inst.args[0]).args[2] !== type) inst.args[0] = pointerTo(info.storage, type);
      out.push(inst);
    } else if (inst.op === Op.PtrAccessChain && pointerInfo.has(inst.args[2])) {
      throw new Error('pointer access chains are not supported');
    } else if (inst.op === Op.CopyMemory && (pointerInfo.has(inst.args[0]) || pointerInfo.has(inst.args[1]))) {
      throw new Error('memory copies of patched data are not supported');
    } else if (inst.op === Op.Load && pointerInfo.has(inst.args[2])) {
      const info = pointerInfo.get(inst.args[2]);
      if (info.type === info.original) {
        out.push(inst);
        continue;
      }
      const loaded = newId();
      out.push({ op: Op.Load, args: [info.type, loaded, ...inst.args.slice(2)] });
      const convertOp = info.convert || Op.Bitcast;
      if (isIntScalarOrVector(info.original)) {
        out.push({ op: convertOp, args: [info.original, inst.args[1], loaded] });
      } else {
        const rebuilt = rebuild(loaded, info.type, info.original, convertOp);
        const last = out[out.length - 1];
        if (last.args[1] !== rebuilt) throw new Error('internal error rebuilding a uniform value');
        last.args[1] = inst.args[1];
      }
    } else {
      out.push(inst);
    }
  }
  insts.splice(insts.findIndex(i => i.op === Op.Function), body.length, ...out);

  for (const v of insts.filter(i => i.op === Op.Variable && i.args[2] !== Storage.Function)) {
    const pointer = defs.get(v.args[0]);
    if (insts.indexOf(pointer) > insts.indexOf(v)) {
      insts.splice(insts.indexOf(v), 1);
      insts.splice(insts.indexOf(pointer) + 1, 0, v);
    }
  }

  const firstAnnotation = insts.findIndex(i => i.op === Op.Decorate || i.op === Op.MemberDecorate || isTypeOp(i.op));
  insts.splice(firstAnnotation, 0, ...[...names].map(([id, name]) => ({ op: Op.Name, args: [id, ...literalString(name)] })));
  module.header[3] = bound;
  return { spirv: encode(module), stage: model === ExecutionModel.Vertex ? 'vert' : 'frag', twins: twins.size };
}

module.exports = { patch, decode, encode, inputSemantic };
