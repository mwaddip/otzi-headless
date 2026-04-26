/**
 * BTC unit conversion. Operator can pass amounts as:
 *   "25000"       — sats (default; bare integer)
 *   "25000sats"   — explicit sats
 *   "0.001btc"    — BTC; 1 btc = 100_000_000 sats
 *   "1mbtc"       — milli-BTC; 1 mbtc = 100_000 sats
 *   "1ubtc"       — micro-BTC; 1 ubtc = 100 sats
 *
 * Conversion always yields integer sats; non-integer-sat amounts are
 * rejected (e.g. "0.000000001btc" would be 0.1 sats — reject).
 */

export type BtcUnit = 'sats' | 'btc' | 'mbtc' | 'ubtc';

const UNIT_TO_SATS: Record<BtcUnit, bigint> = {
  sats: 1n,
  ubtc: 100n,
  mbtc: 100_000n,
  btc: 100_000_000n,
};

export interface ParsedAmount {
  sats: bigint;
  unit: BtcUnit;
  raw: string;
}

export function parseBtcAmount(input: string): ParsedAmount {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) throw new Error('amount is empty');

  const m = /^([0-9]+(?:\.[0-9]+)?)(sats|btc|mbtc|ubtc)?$/.exec(trimmed);
  if (!m)
    throw new Error(`invalid amount '${input}' (expected '<number>[sats|btc|mbtc|ubtc]')`);

  const valueStr = m[1]!;
  const unit = (m[2] as BtcUnit | undefined) ?? 'sats';
  const factor = UNIT_TO_SATS[unit];

  const [intPart, fracPart = ''] = valueStr.split('.');
  if (unit === 'sats' && fracPart.length > 0) {
    throw new Error(`sats amount must be integer (got '${input}')`);
  }

  const intBigint = BigInt(intPart!) * factor;
  let fracBigint = 0n;
  if (fracPart.length > 0) {
    const fracValue = BigInt(fracPart);
    const scale = 10n ** BigInt(fracPart.length);
    if ((fracValue * factor) % scale !== 0n) {
      throw new Error(
        `amount '${input}' is not an integer number of sats (smallest unit is 1 sat)`,
      );
    }
    fracBigint = (fracValue * factor) / scale;
  }

  const sats = intBigint + fracBigint;
  if (sats < 0n) throw new Error('amount must be non-negative');
  return { sats, unit, raw: input };
}

export function formatSats(sats: bigint, unit: BtcUnit = 'sats'): string {
  const factor = UNIT_TO_SATS[unit];
  if (unit === 'sats') return sats.toString();
  const digits = Math.log10(Number(factor));
  const intPart = sats / factor;
  const fracPart = sats % factor;
  const fracStr = fracPart.toString().padStart(digits, '0').replace(/0+$/, '');
  return fracStr.length > 0 ? `${intPart}.${fracStr}` : `${intPart}`;
}
