import type {
  ProjectManifest, ManifestCondition, ManifestConfig,
  ManifestParam, ManifestRead,
} from './manifest-types';
import { OP20_METHODS } from './op20-methods';

// ── Validation ──

export function validateManifest(data: unknown): { valid: true; manifest: ProjectManifest } | { valid: false; error: string } {
  if (!data || typeof data !== 'object') return { valid: false, error: 'Manifest must be a JSON object' };
  const m = data as Record<string, unknown>;

  if (m.version !== 1) return { valid: false, error: `Unsupported manifest version: ${m.version}` };
  if (typeof m.name !== 'string' || !m.name) return { valid: false, error: 'Manifest requires a name' };
  if (!m.contracts || typeof m.contracts !== 'object') return { valid: false, error: 'Manifest requires contracts' };
  if (!Array.isArray(m.operations)) return { valid: false, error: 'Manifest requires operations array' };

  for (const op of m.operations as Record<string, unknown>[]) {
    if (!op.id || !op.label || !op.contract || !op.method) {
      return { valid: false, error: `Operation missing required fields: ${JSON.stringify(op)}` };
    }
    if (!Array.isArray(op.params)) {
      return { valid: false, error: `Operation "${op.id}" requires params array` };
    }
  }

  return { valid: true, manifest: data as ProjectManifest };
}

// ── ABI shorthand resolution ──

const OP20_ABI_SHORTHAND = OP20_METHODS.map(m => ({
  name: m.name,
  inputs: m.params.map(p => ({ name: p.name, type: p.type === 'u256' ? 'uint256' : p.type })),
  outputs: [],
  type: 'Function',
}));

export function resolveAbi(abi: unknown[] | string): unknown[] {
  if (typeof abi === 'string') {
    if (abi === 'OP_20') return OP20_ABI_SHORTHAND;
    if (abi === 'OP_20S') return OP20_ABI_SHORTHAND;
    if (abi === 'OP_721') return [];
    return [];
  }
  const result: unknown[] = [];
  for (const entry of abi) {
    if (typeof entry === 'string') {
      result.push(...resolveAbi(entry));
    } else {
      result.push(entry);
    }
  }
  return result;
}

// ── Condition evaluation ──

export function evaluateCondition(
  condition: ManifestCondition,
  reads: Record<string, unknown>,
  currentBlock?: number,
): boolean {
  if ('and' in condition) {
    return condition.and.every(c => evaluateCondition(c, reads, currentBlock));
  }
  if ('or' in condition) {
    return condition.or.some(c => evaluateCondition(c, reads, currentBlock));
  }
  if ('not' in condition) {
    return !evaluateCondition(condition.not, reads, currentBlock);
  }
  if ('blockWindow' in condition) {
    if (currentBlock === undefined) return false;
    const baseBlock = Number(reads[condition.blockWindow.read] ?? 0);
    if (!baseBlock) return false;
    if (condition.blockWindow.minBlocks !== undefined) {
      return currentBlock >= baseBlock + condition.blockWindow.minBlocks;
    }
    if (condition.blockWindow.maxBlocks !== undefined) {
      return currentBlock < baseBlock + condition.blockWindow.maxBlocks;
    }
    return true;
  }
  if ('eq' in condition) {
    return String(reads[condition.read]) === String(condition.eq);
  }
  if ('neq' in condition) {
    return String(reads[condition.read]) !== String(condition.neq);
  }
  if ('gt' in condition) {
    return Number(reads[condition.read] ?? 0) > condition.gt;
  }
  if ('lt' in condition) {
    return Number(reads[condition.read] ?? 0) < condition.lt;
  }
  return true;
}

// ── Format helpers ──

export function formatReadValue(value: unknown, format?: ManifestRead['format'], map?: Record<string, string>): string {
  const raw = String(value ?? '');
  if (map && map[raw]) return map[raw];

  let n: bigint;
  try { n = BigInt(raw || '0'); } catch { return raw; }

  switch (format) {
    case 'token8':
    case 'btc8':
    case 'price8': {
      const negative = n < 0n;
      const abs = negative ? -n : n;
      const whole = abs / 100_000_000n;
      const frac = abs % 100_000_000n;
      const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '') || '0';
      const num = `${negative ? '-' : ''}${whole}.${fracStr}`;
      if (format === 'btc8') return `${num} BTC`;
      if (format === 'price8') return `$${num}`;
      return num;
    }
    case 'percent8': {
      // Use BigInt division to avoid Number overflow on huge values
      const whole = n / 1_000_000n;
      const frac = ((n % 1_000_000n) * 100n) / 1_000_000n;
      return `${whole}.${frac.toString().padStart(2, '0')}%`;
    }
    case 'address':
      return raw.length > 16 ? `${raw.slice(0, 10)}...${raw.slice(-6)}` : raw;
    default:
      return raw;
  }
}

// ── Param resolution ──

export function resolveParamValue(
  param: ManifestParam,
  config: ManifestConfig,
  reads: Record<string, unknown>,
): string | undefined {
  if (!param.source) return undefined;

  const [sourceType, sourceKey] = param.source.split(':');
  if (!sourceKey) return undefined;

  switch (sourceType) {
    case 'contract':
      return config.addresses[sourceKey];
    case 'setting':
      return config.settings?.[sourceKey];
    case 'read':
      return reads[sourceKey] !== undefined ? String(reads[sourceKey]) : undefined;
    default:
      return undefined;
  }
}

// ── Param encoding ──

export function encodeParamValue(value: string, param: ManifestParam): string {
  if (param.type === 'uint256' && param.scale) {
    const scaled = BigInt(Math.round(parseFloat(value) * param.scale));
    return scaled.toString();
  }
  return value;
}
