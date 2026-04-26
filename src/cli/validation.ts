/**
 * Pure type-validators for ABI param types. Each validator returns the
 * parsed value (typed) or throws a structured error with a message that
 * names the param + reason.
 *
 * Permissive normalization at the input boundary: trim whitespace, accept
 * upper-case hex, strip leading '+' on numbers. Reject everything else.
 */

import type { AbiParamType } from './manifest-types';

const UINT_MAX: Record<string, bigint> = {
  uint8: (1n << 8n) - 1n,
  uint16: (1n << 16n) - 1n,
  uint32: (1n << 32n) - 1n,
  uint64: (1n << 64n) - 1n,
  uint128: (1n << 128n) - 1n,
  uint256: (1n << 256n) - 1n,
};

export type Parsed =
  | { kind: 'address'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'uint'; bits: number; value: bigint };

export interface ValidatorContext {
  paramName: string;
  paramType: AbiParamType;
  argIndex: number;
}

export class ArgValidationError extends Error {
  constructor(
    public readonly ctx: ValidatorContext,
    public readonly reason: string,
    public readonly input: string,
  ) {
    super(
      `arg ${ctx.argIndex + 1} (${ctx.paramName}: ${ctx.paramType}) — ${reason}; got "${truncate(input)}"`,
    );
    this.name = 'ArgValidationError';
  }
}

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

export function validate(rawInput: string, ctx: ValidatorContext): Parsed {
  const input = rawInput.trim();
  switch (ctx.paramType) {
    case 'address':
      return { kind: 'address', value: parseAddress(input, ctx) };
    case 'bool':
      return { kind: 'bool', value: parseBool(input, ctx) };
    case 'string':
      return { kind: 'string', value: input };
    case 'bytes':
      return { kind: 'bytes', value: parseBytes(input, ctx) };
    case 'uint8':
    case 'uint16':
    case 'uint32':
    case 'uint64':
    case 'uint128':
    case 'uint256': {
      const bits = Number(ctx.paramType.slice(4));
      return { kind: 'uint', bits, value: parseUint(input, ctx) };
    }
  }
}

function parseAddress(input: string, ctx: ValidatorContext): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input))
    throw new ArgValidationError(ctx, "expected '0x' + 64 hex chars", input);
  return '0x' + input.slice(2).toLowerCase();
}

function parseBool(input: string, ctx: ValidatorContext): boolean {
  if (input === 'true') return true;
  if (input === 'false') return false;
  throw new ArgValidationError(ctx, "expected 'true' or 'false'", input);
}

function parseBytes(input: string, ctx: ValidatorContext): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(input))
    throw new ArgValidationError(ctx, "expected '0x' + even-length hex", input);
  const hex = input.slice(2);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function parseUint(input: string, ctx: ValidatorContext): bigint {
  const stripped = input.startsWith('+') ? input.slice(1) : input;
  if (!/^\d+$/.test(stripped))
    throw new ArgValidationError(
      ctx,
      `expected non-negative integer (decimal), no scientific notation`,
      input,
    );
  let value: bigint;
  try {
    value = BigInt(stripped);
  } catch {
    throw new ArgValidationError(ctx, 'failed to parse as integer', input);
  }
  const max = UINT_MAX[ctx.paramType];
  if (max === undefined)
    throw new Error(`internal: unknown uint type '${ctx.paramType}'`);
  if (value > max)
    throw new ArgValidationError(ctx, `value exceeds ${ctx.paramType} max (${max})`, input);
  return value;
}
