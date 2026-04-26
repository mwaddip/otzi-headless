/**
 * Resolves contracts + methods from a HeadlessManifest given operator
 * identifiers (name or 1-based index for contracts; name or letter for
 * methods).
 *
 * Letters: 'a' = first method, 'b' = second, ... 'z' = 26th. Beyond 'z'
 * the resolver throws — manifests should not be shipping >26 methods on
 * one contract; if they do, use the explicit method name instead.
 */

import { methodsForBuiltinType } from './builtin-abis';
import type { AbiMethod, HeadlessManifest, ManifestContract } from './manifest-types';

export interface ResolvedMethod {
  contract: ManifestContract;
  contractIndex: number;
  method: AbiMethod;
  methodIndex: number;
}

export function methodsForContract(c: ManifestContract): readonly AbiMethod[] {
  if (c.type === 'Custom') {
    if (!c.abi) throw new Error(`contract '${c.name}': type=Custom requires inline abi`);
    return c.abi;
  }
  return methodsForBuiltinType(c.type);
}

export function resolveContract(
  manifest: HeadlessManifest,
  identifier: string,
): { contract: ManifestContract; index: number } {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) throw new Error('contract identifier is empty');

  if (/^\d+$/.test(trimmed)) {
    const i = Number(trimmed);
    if (!Number.isInteger(i) || i < 1 || i > manifest.contracts.length)
      throw new Error(
        `contract index ${i} out of range (manifest has ${manifest.contracts.length} contracts)`,
      );
    return { contract: manifest.contracts[i - 1]!, index: i - 1 };
  }

  const i = manifest.contracts.findIndex((c) => c.name === trimmed);
  if (i < 0) {
    const names = manifest.contracts.map((c) => `'${c.name}'`).join(', ');
    throw new Error(`no contract '${trimmed}' in manifest; available: ${names}`);
  }
  return { contract: manifest.contracts[i]!, index: i };
}

export function resolveMethod(
  contract: ManifestContract,
  identifier: string,
): { method: AbiMethod; index: number } {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) throw new Error('method identifier is empty');

  const methods = methodsForContract(contract);

  if (/^[a-z]$/.test(trimmed)) {
    const idx = trimmed.charCodeAt(0) - 'a'.charCodeAt(0);
    if (idx >= methods.length)
      throw new Error(
        `method letter '${trimmed}' out of range (contract '${contract.name}' has ${methods.length} method(s))`,
      );
    return { method: methods[idx]!, index: idx };
  }

  const idx = methods.findIndex((m) => m.name === trimmed);
  if (idx < 0) {
    const names = methods.map((m) => `'${m.name}'`).join(', ');
    throw new Error(
      `no method '${trimmed}' on contract '${contract.name}'; available: ${names}`,
    );
  }
  return { method: methods[idx]!, index: idx };
}

export function resolve(
  manifest: HeadlessManifest,
  contractIdent: string,
  methodIdent: string,
): ResolvedMethod {
  const { contract, index: contractIndex } = resolveContract(manifest, contractIdent);
  const { method, index: methodIndex } = resolveMethod(contract, methodIdent);
  return { contract, contractIndex, method, methodIndex };
}
