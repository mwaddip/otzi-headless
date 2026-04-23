/**
 * Pure calldata encoding for OPNet contract invocations.
 *
 * Extracted verbatim-in-spirit from `otzi/backend/src/routes/tx.ts` (the
 * `POST /api/tx/encode` handler) with the Express wrapper stripped. Byte-compat
 * with Ötzi — a calldata buffer produced here must match the one Ötzi's UI
 * produces for identical inputs, since they feed into the same on-chain
 * contracts.
 *
 * Wire format: `selector (4B) || param_0 || param_1 || ...`
 *   selector = first 4 bytes of SHA256(methodName)
 *   address  = 32 bytes (pre-hex-decoded)
 *   u256     = BinaryWriter.writeU256 (32 bytes, big-endian)
 *   bytes    = raw hex-decoded bytes (no length prefix — OPNet convention)
 */

import { createHash } from 'node:crypto';
import { BinaryWriter } from '@btc-vision/transaction';
import { OP_20_ABI } from 'opnet';

export type ParamType = 'address' | 'u256' | 'bytes';

const ABI_TYPE_MAP: Record<string, string> = {
  uint256: 'UINT256', uint8: 'UINT8', uint16: 'UINT16', uint32: 'UINT32',
  address: 'ADDRESS', bool: 'BOOL', bytes: 'BYTES', string: 'STRING',
};

const ABI_SHORTHANDS: Record<string, typeof OP_20_ABI> = {
  OP_20: OP_20_ABI,
  OP_20S: OP_20_ABI, // extend when more shorthands added to Ötzi
};

function normalizeAbiEntry(entry: unknown): unknown[] {
  if (typeof entry === 'string') {
    return ABI_SHORTHANDS[entry] ?? [];
  }
  if (typeof entry !== 'object' || !entry) return [entry];
  const e = entry as Record<string, unknown>;
  return [{
    ...e,
    type: typeof e.type === 'string' ? e.type.toLowerCase() : e.type,
    constant: (e.inputs as unknown[] | undefined)?.length === 0,
    inputs: Array.isArray(e.inputs)
      ? e.inputs.map((inp: Record<string, unknown>) => ({
          ...inp,
          type: ABI_TYPE_MAP[String(inp.type).toLowerCase()] || String(inp.type).toUpperCase(),
        }))
      : e.inputs,
    outputs: Array.isArray(e.outputs)
      ? e.outputs.map((out: Record<string, unknown>) => ({
          ...out,
          type: ABI_TYPE_MAP[String(out.type).toLowerCase()] || String(out.type).toUpperCase(),
        }))
      : e.outputs,
  }];
}

/** Resolve manifest ABI shorthand into the full opnet-SDK ABI array. */
export function resolveAbi(abi: unknown): unknown[] {
  if (!abi) return OP_20_ABI;
  const raw = Array.isArray(abi) ? abi : [abi];
  return raw.flatMap(normalizeAbiEntry);
}

/**
 * Encode an OPNet contract call into a calldata buffer.
 *
 * @param method      Contract method name (e.g. `"transfer"`).
 * @param params      Per-argument string encodings. `address` and `bytes` are
 *                    hex (0x-prefixed OK); `u256` is a decimal or hex string
 *                    accepted by `BigInt`.
 * @param paramTypes  Tag array aligned with `params`.
 * @returns           `calldata` (selector || packed args) and `messageHash`
 *                    (SHA256 of calldata — Ötzi uses this as the cache key
 *                    for broadcast-status lookups).
 */
export function encodeCalldata(
  method: string,
  params: readonly string[],
  paramTypes: readonly ParamType[],
): { calldata: Uint8Array; messageHash: Uint8Array } {
  if (params.length !== paramTypes.length) {
    throw new Error(
      `params/paramTypes length mismatch: ${params.length} vs ${paramTypes.length}`,
    );
  }

  const selector = createHash('sha256')
    .update(new TextEncoder().encode(method))
    .digest()
    .subarray(0, 4);

  const writer = new BinaryWriter();
  writer.writeBytes(new Uint8Array(selector));

  for (let i = 0; i < params.length; i++) {
    const value = params[i]!;
    const type = paramTypes[i]!;
    if (type === 'address') {
      writer.writeBytes(new Uint8Array(Buffer.from(value.replace(/^0x/, ''), 'hex')));
    } else if (type === 'u256') {
      writer.writeU256(BigInt(value));
    } else if (type === 'bytes') {
      writer.writeBytes(new Uint8Array(Buffer.from(value.replace(/^0x/, ''), 'hex')));
    } else {
      throw new Error(`Unknown paramType: ${type satisfies never}`);
    }
  }

  const calldata = new Uint8Array(writer.getBuffer());
  const messageHash = new Uint8Array(createHash('sha256').update(calldata).digest());
  return { calldata, messageHash };
}
