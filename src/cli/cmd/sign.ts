/**
 * `otzi sign <contract> <method> <args...>`
 *
 * Resolves contract + method from the installed manifest, validates the
 * positional args against the resolved ABI types, and runs the two-step
 * threshold ceremony: ML-DSA pre-sign over sha256(calldata), then FROST
 * sign + broadcast via opnet-params over the daemon UDS.
 *
 * Output: returns the resulting transactionId on success.
 */

import { readFile } from 'node:fs/promises';
import { encodeCalldata, type ParamType as EncoderParamType } from '../../broadcast/opnet-calldata';
import { toHex } from '../../wire/hex';
import { DaemonClient } from '../daemon-client';
import { resolve as resolveManifest } from '../manifest-resolver';
import type { AbiParamType } from '../manifest-types';
import { validateManifest } from '../manifest-validate';
import { validate, type Parsed } from '../validation';
import { DEFAULT_MANIFEST_PATH } from './install';

export interface SignOptions {
  /** Daemon TOML path — passed to DaemonClient.fromConfig. */
  configPath: string;
  /** Manifest path override. Defaults to /etc/otzi/manifest.otzi.json. */
  manifestPath?: string;
  /** Contract identifier — name or 1-based index. */
  contractIdent: string;
  /** Method identifier — name or letter (a/b/c…). */
  methodIdent: string;
  /** Positional ABI args, parsed per the resolved method's param types. */
  args: string[];
  /** Optional fee-rate override (sat/vB). Defaults to undefined → daemon picks. */
  feeRate?: number;
}

export interface SignResult {
  transactionId: string;
}

export async function sign(opts: SignOptions): Promise<SignResult> {
  const manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST_PATH;

  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('no manifest installed; run `otzi install <path>` first');
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`installed manifest at ${manifestPath} is not valid JSON`);
  }
  const validation = validateManifest(parsed);
  if (!validation.ok)
    throw new Error(
      'installed manifest is invalid:\n  ' + validation.errors.join('\n  '),
    );
  const manifest = validation.manifest;

  const resolved = resolveManifest(manifest, opts.contractIdent, opts.methodIdent);
  const { contract, method } = resolved;

  if (opts.args.length !== method.params.length)
    throw new Error(
      `method '${method.name}' takes ${method.params.length} arg(s), got ${opts.args.length}`,
    );
  const parsedArgs: Parsed[] = opts.args.map((arg, i) =>
    validate(arg, {
      argIndex: i,
      paramName: method.params[i]!.name,
      paramType: method.params[i]!.type,
    }),
  );

  const wireParamTypes = method.params.map((p) => normalizeAbiType(p.type));
  const wireParams = parsedArgs.map((p) => toEncoderInput(p));

  const { messageHash } = encodeCalldata(method.name, wireParams, wireParamTypes);
  const messageHex = toHex(messageHash);

  const client = await DaemonClient.fromConfig(opts.configPath);
  const info = await client.vaultInfo();

  const mldsaResp = await client.request<{ signatureHex: string }>({
    op: 'sign',
    scheme: 'mldsa',
    protocol: 'raw',
    signers: info.partyIds,
    messageHex,
  });
  const mldsaThresholdSignatureHex = mldsaResp.signatureHex;

  const signResp = await client.request<{ transactionId?: string }>({
    op: 'sign',
    scheme: 'frost',
    protocol: 'opnet-params',
    signers: info.partyIds,
    contractAddress: contract.address,
    method: method.name,
    params: wireParams,
    paramTypes: wireParamTypes,
    mldsaThresholdSignatureHex,
    ...(opts.feeRate !== undefined ? { feeRate: opts.feeRate } : {}),
  });
  if (!signResp.transactionId)
    throw new Error('daemon returned no transactionId — broadcast may have failed');
  return { transactionId: signResp.transactionId };
}

/**
 * Map manifest ABI types to the calldata encoder's wire types.
 * The encoder only handles 'address' / 'u256' / 'bytes' directly; anything
 * else collapses to one of these. Bool maps to u256 (0/1, 32 bytes BE) —
 * the OPNet ABI tags it as BOOL, but the BinaryWriter encoding routes
 * through writeU256 in the existing encoder. String maps to bytes (raw,
 * no length prefix per OPNet convention — operators using string types
 * via Custom should be aware).
 */
function normalizeAbiType(t: AbiParamType): EncoderParamType {
  if (t === 'address') return 'address';
  if (t === 'bytes' || t === 'string') return 'bytes';
  return 'u256';
}

function toEncoderInput(p: Parsed): string {
  switch (p.kind) {
    case 'address':
      return p.value;
    case 'uint':
      return p.value.toString();
    case 'bool':
      return p.value ? '1' : '0';
    case 'bytes':
      return '0x' + Array.from(p.value, (b) => b.toString(16).padStart(2, '0')).join('');
    case 'string':
      return '0x' + Array.from(new TextEncoder().encode(p.value), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
  }
}
