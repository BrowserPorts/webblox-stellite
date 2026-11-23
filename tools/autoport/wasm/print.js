'use strict';

const { KIND } = require('./module');

const NAMES = {
  0x00: 'unreachable', 0x01: 'nop', 0x02: 'block', 0x03: 'loop', 0x04: 'if', 0x05: 'else', 0x0a: 'throw_ref', 0x0b: 'end', 0x0c: 'br', 0x0d: 'br_if', 0x0e: 'br_table', 0x0f: 'return',
  0x10: 'call', 0x11: 'call_indirect', 0x12: 'return_call', 0x13: 'return_call_indirect', 0x1a: 'drop', 0x1b: 'select', 0x1c: 'select_t', 0x1f: 'try_table',
  0x20: 'local.get', 0x21: 'local.set', 0x22: 'local.tee', 0x23: 'global.get', 0x24: 'global.set',
  0x28: 'i32.load', 0x29: 'i64.load', 0x2a: 'f32.load', 0x2b: 'f64.load', 0x2c: 'i32.load8_s', 0x2d: 'i32.load8_u', 0x2e: 'i32.load16_s', 0x2f: 'i32.load16_u',
  0x30: 'i64.load8_s', 0x31: 'i64.load8_u', 0x32: 'i64.load16_s', 0x33: 'i64.load16_u', 0x34: 'i64.load32_s', 0x35: 'i64.load32_u',
  0x36: 'i32.store', 0x37: 'i64.store', 0x38: 'f32.store', 0x39: 'f64.store', 0x3a: 'i32.store8', 0x3b: 'i32.store16', 0x3c: 'i64.store8', 0x3d: 'i64.store16', 0x3e: 'i64.store32',
  0x3f: 'memory.size', 0x40: 'memory.grow', 0x41: 'i32.const', 0x42: 'i64.const', 0x43: 'f32.const', 0x44: 'f64.const',
  0x45: 'i32.eqz', 0x46: 'i32.eq', 0x47: 'i32.ne', 0x48: 'i32.lt_s', 0x49: 'i32.lt_u', 0x4a: 'i32.gt_s', 0x4b: 'i32.gt_u', 0x4c: 'i32.le_s', 0x4d: 'i32.le_u', 0x4e: 'i32.ge_s', 0x4f: 'i32.ge_u',
  0x50: 'i64.eqz', 0x51: 'i64.eq', 0x52: 'i64.ne', 0x5b: 'f32.eq', 0x5c: 'f32.ne', 0x5d: 'f32.lt', 0x5e: 'f32.gt', 0x5f: 'f32.le', 0x60: 'f32.ge',
  0x6a: 'i32.add', 0x6b: 'i32.sub', 0x6c: 'i32.mul', 0x6d: 'i32.div_s', 0x6e: 'i32.div_u', 0x6f: 'i32.rem_s', 0x70: 'i32.rem_u', 0x71: 'i32.and', 0x72: 'i32.or', 0x73: 'i32.xor', 0x74: 'i32.shl', 0x75: 'i32.shr_s', 0x76: 'i32.shr_u',
  0x92: 'f32.add', 0x93: 'f32.sub', 0x94: 'f32.mul', 0x95: 'f32.div', 0xa7: 'i32.wrap_i64', 0xad: 'i64.extend_i32_u', 0xb2: 'f32.convert_i32_s', 0xb3: 'f32.convert_i32_u',
};

function operand(instruction, signatures) {
  switch (instruction.kind) {
    case KIND.LOCAL:
    case KIND.GLOBAL:
    case KIND.CALL:
    case KIND.INDEX:
    case KIND.BYTE:
    case KIND.LANE:
      return ` ${instruction.a}`;
    case KIND.CONST_I32:
      return ` ${instruction.a}`;
    case KIND.CONST_I64:
      return ` ${instruction.wide}`;
    case KIND.CONST_F32:
      return ` 0x${instruction.a.toString(16)}`;
    case KIND.MEMARG:
    case KIND.MEMARG_LANE:
      return instruction.a ? ` offset=${instruction.a}` : '';
    case KIND.CALL_INDIRECT:
      return ` type=${instruction.a}`;
    case KIND.BLOCK:
    case KIND.TRY_TABLE:
      return instruction.a === -64 ? '' : ` result=${instruction.a}`;
    default:
      return '';
  }
}

function mnemonic(instruction) {
  if (instruction.sub >= 0) return `0x${instruction.op.toString(16)}.${instruction.sub}`;
  return NAMES[instruction.op] || `0x${instruction.op.toString(16)}`;
}

function formatInstruction(instruction) {
  return `${mnemonic(instruction)}${operand(instruction)}`;
}

function listing(decoded, from = 0, to = decoded.length) {
  const lines = [];
  let depth = 0;
  for (let i = 0; i < from && i < decoded.length; i++) {
    const op = decoded[i].op;
    if (op === 2 || op === 3 || op === 4 || op === 0x1f) depth++;
    else if (op === 0x0b) depth--;
  }
  for (let i = from; i < to && i < decoded.length; i++) {
    const instruction = decoded[i];
    const op = instruction.op;
    if (op === 0x0b || op === 0x05) depth--;
    lines.push(`${String(i).padStart(6)}  ${'  '.repeat(Math.max(0, depth))}${formatInstruction(instruction)}`);
    if (op === 2 || op === 3 || op === 4 || op === 0x1f || op === 0x05) depth++;
  }
  return lines.join('\n');
}

module.exports = { formatInstruction, mnemonic, listing };
