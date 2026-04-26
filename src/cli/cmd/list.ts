/**
 * `otzi list` — read the installed manifest and print a nested numbered/
 * lettered tree of contracts + methods.
 *
 * Format:
 *   1 - Shitcoin - OP20 - 6 decimals
 *     a - transfer(to:address, amount:uint256)
 *     b - increaseAllowance(spender:address, amount:uint256)
 *   2 - Reserve - Custom
 *     a - emergencyWithdraw(to:address)
 */

import { readFile } from 'node:fs/promises';
import { methodsForContract } from '../manifest-resolver';
import { validateManifest } from '../manifest-validate';
import type { AbiMethod, HeadlessManifest, ManifestContract } from '../manifest-types';
import { DEFAULT_MANIFEST_PATH } from './install';

export interface ListOptions {
  manifestPath?: string;
}

export async function list(opts: ListOptions = {}): Promise<string> {
  const path = opts.manifestPath ?? DEFAULT_MANIFEST_PATH;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`no manifest installed at ${path}; run \`otzi install <path>\` first`);
    throw err;
  }
  const result = validateManifest(JSON.parse(raw));
  if (!result.ok)
    throw new Error(`installed manifest is invalid:\n  ` + result.errors.join('\n  '));
  return formatManifest(result.manifest);
}

function formatManifest(m: HeadlessManifest): string {
  const lines: string[] = [];
  m.contracts.forEach((c, i) => {
    lines.push(formatContractHeader(i + 1, c));
    methodsForContract(c).forEach((method, j) => {
      lines.push(`  ${letter(j)} - ${formatMethodSignature(method)}`);
    });
  });
  return lines.join('\n');
}

function formatContractHeader(index: number, c: ManifestContract): string {
  const decimalsBit =
    c.type === 'OP20' || c.type === 'OP20S' ? ` - ${c.decimals} decimals` : '';
  return `${index} - ${c.name} - ${c.type}${decimalsBit}`;
}

function formatMethodSignature(method: AbiMethod): string {
  const params = method.params.map((p) => `${p.name}:${p.type}`).join(', ');
  return `${method.name}(${params})`;
}

function letter(i: number): string {
  if (i < 26) return String.fromCharCode('a'.charCodeAt(0) + i);
  // Manifests shouldn't ship >26 methods on one contract; if they do, fall
  // back to numeric. Operators can still call by method name.
  return String(i);
}
