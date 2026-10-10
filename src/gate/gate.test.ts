import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config/parse';
import { buildDkgSpec, buildSigningSpec, resolveLeaderId } from '../orchestrator/spec-builder';
import type { ProposalAnalysis } from '../otzi/lib/bitcoin';
import { AutoGate, createGate } from './factory';
import { parsePolicyParams, PolicyGate } from './policy';
import type { CeremonyRole, DkgSpec, SigningSpec, SpecOutput } from './types';

const HOUR = 3_600_000;
const DAY = 86_400_000;

const RECIPIENT_A = 'bc1qa0000000000000000000000000000000000000';
const RECIPIENT_B = 'bc1qb0000000000000000000000000000000000000';
const RECIPIENT_EVIL = 'bc1qe0000000000000000000000000000000000000';
const VAULT = 'bc1pv0000000000000000000000000000000000000000000000000000000';

interface SigningOpts {
  /** Value of one external output to `recipient`. Default 10 000. */
  external?: number;
  recipient?: string;
  /** Value of a change output back to the vault; omitted when 0. Default 0. */
  change?: number;
  fee?: number;
  vsize?: number;
  /** Replaces the generated outputs entirely (amount and totals follow). */
  outputs?: SpecOutput[];
  ceremonyId?: string;
  leader?: string;
  role?: CeremonyRole;
}

function signing(o: SigningOpts = {}): SigningSpec {
  const outputs: SpecOutput[] = o.outputs ?? [
    { address: o.recipient ?? RECIPIENT_A, amount: o.external ?? 10_000, isChange: false },
    ...(o.change ? [{ address: VAULT, amount: o.change, isChange: true }] : []),
  ];
  const fee = o.fee ?? 1_000;
  const vsize = o.vsize ?? 200;
  const totalOut = outputs.reduce((s, x) => s + x.amount, 0);
  const totalIn = totalOut + fee;
  return {
    kind: 'signing',
    ceremonyId: o.ceremonyId ?? 'ceremony-1',
    leader: o.leader ?? 'node-a',
    role: o.role ?? 'leader',
    network: 'mainnet',
    txid: 'ab'.repeat(32),
    inputs: [{ txid: 'cd'.repeat(32), vout: 0, amount: totalIn }],
    outputs,
    amount: outputs.filter((x) => !x.isChange).reduce((s, x) => s + x.amount, 0),
    totalIn,
    totalOut,
    fee,
    vsize,
    feeRate: fee / vsize,
  };
}

function dkgSpec(overrides: Partial<DkgSpec> = {}): DkgSpec {
  return {
    kind: 'dkg',
    ceremonyId: 'dkg-1',
    leader: 'node-a',
    role: 'leader',
    threshold: 3,
    parties: 3,
    network: 'mainnet',
    peerIds: ['node-a', 'node-b', 'node-c'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AutoGate
// ---------------------------------------------------------------------------

describe('AutoGate', () => {
  const gate = new AutoGate();

  it('approves any signing spec', async () => {
    expect(await gate.approve(signing({ external: 2_100_000_000_000_000 }))).toBe('approve');
  });
  it('approves any DKG spec', async () => {
    expect(await gate.approve(dkgSpec())).toBe('approve');
  });
});

// ---------------------------------------------------------------------------
// PolicyGate — per-transaction rules
// ---------------------------------------------------------------------------

describe('PolicyGate — max_sats_per_tx', () => {
  it('approves at the cap and rejects one sat above', async () => {
    const gate = new PolicyGate({ maxSatsPerTx: 50_000 });
    expect(await gate.approve(signing({ external: 50_000 }))).toBe('approve');
    expect(await gate.approve(signing({ external: 50_001 }))).toBe('reject');
  });

  it('sums every external output', async () => {
    const gate = new PolicyGate({ maxSatsPerTx: 100_000 });
    const two = (a: number, b: number) =>
      signing({
        outputs: [
          { address: RECIPIENT_A, amount: a, isChange: false },
          { address: RECIPIENT_B, amount: b, isChange: false },
        ],
      });
    expect(await gate.approve(two(40_000, 60_000))).toBe('approve');
    expect(await gate.approve(two(40_000, 60_001))).toBe('reject');
  });

  it('does not count change back to the vault', async () => {
    const gate = new PolicyGate({ maxSatsPerTx: 50_000 });
    expect(await gate.approve(signing({ external: 50_000, change: 9_000_000 }))).toBe('approve');
  });

  it('approves a transaction that only pays change when the cap is 0', async () => {
    const gate = new PolicyGate({ maxSatsPerTx: 0 });
    const consolidation = signing({ outputs: [{ address: VAULT, amount: 99_000, isChange: true }] });
    expect(await gate.approve(consolidation)).toBe('approve');
    expect(await gate.approve(signing({ external: 1 }))).toBe('reject');
  });

  it('approves any amount when no cap is set', async () => {
    const gate = new PolicyGate({});
    expect(await gate.approve(signing({ external: Number.MAX_SAFE_INTEGER - 10_000 }))).toBe('approve');
  });

  it('rejects when the spec carries no usable amount (strict-by-default)', async () => {
    const gate = new PolicyGate({ maxSatsPerTx: 100_000 });
    const broken = { ...signing(), amount: undefined } as unknown as SigningSpec;
    expect(await gate.approve(broken)).toBe('reject');
    expect(await gate.approve({ ...signing(), amount: Number.NaN })).toBe('reject');
  });
});

describe('PolicyGate — allowed_recipients', () => {
  const gate = new PolicyGate({ allowedRecipients: [RECIPIENT_A, RECIPIENT_B] });

  it('approves when every external output is listed', async () => {
    const spec = signing({
      outputs: [
        { address: RECIPIENT_A, amount: 5_000, isChange: false },
        { address: RECIPIENT_B, amount: 6_000, isChange: false },
      ],
    });
    expect(await gate.approve(spec)).toBe('approve');
  });

  it('ignores change and rejects any other external output', async () => {
    // Change to the vault is not in the list and does not need to be.
    expect(await gate.approve(signing({ recipient: RECIPIENT_A, change: 70_000 }))).toBe('approve');
    expect(await gate.approve(signing({ recipient: RECIPIENT_EVIL, change: 70_000 }))).toBe('reject');
    const mixed = signing({
      outputs: [
        { address: RECIPIENT_A, amount: 5_000, isChange: false },
        { address: RECIPIENT_EVIL, amount: 1, isChange: false },
        { address: VAULT, amount: 70_000, isChange: true },
      ],
    });
    expect(await gate.approve(mixed)).toBe('reject');
  });

  it('compares by exact string', async () => {
    expect(await gate.approve(signing({ recipient: RECIPIENT_A.toUpperCase() }))).toBe('reject');
  });

  it('approves a change-only transaction even with an empty list', async () => {
    const empty = new PolicyGate({ allowedRecipients: [] });
    const consolidation = signing({ outputs: [{ address: VAULT, amount: 99_000, isChange: true }] });
    expect(await empty.approve(consolidation)).toBe('approve');
    expect(await empty.approve(signing())).toBe('reject');
  });

  it('rejects when the spec carries no outputs array (strict-by-default)', async () => {
    const broken = { ...signing(), outputs: undefined } as unknown as SigningSpec;
    expect(await gate.approve(broken)).toBe('reject');
  });
});

describe('PolicyGate — max_fee_sats and max_fee_rate', () => {
  it('max_fee_sats approves at the cap and rejects one sat above', async () => {
    const gate = new PolicyGate({ maxFeeSats: 2_000 });
    expect(await gate.approve(signing({ fee: 2_000 }))).toBe('approve');
    expect(await gate.approve(signing({ fee: 2_001 }))).toBe('reject');
  });

  it('fractional max_fee_rate caps the fee rate', async () => {
    const gate = new PolicyGate({ maxFeeRate: 2.5 });
    expect(await gate.approve(signing({ fee: 500, vsize: 200 }))).toBe('approve'); // 2.5 sat/vB
    expect(await gate.approve(signing({ fee: 501, vsize: 200 }))).toBe('reject'); // 2.505 sat/vB
    expect(await gate.approve(signing({ fee: 100, vsize: 200 }))).toBe('approve'); // 0.5 sat/vB
  });

  it('rejects when the spec carries no usable fee or fee rate (strict-by-default)', async () => {
    const noFee = { ...signing(), fee: undefined } as unknown as SigningSpec;
    expect(await new PolicyGate({ maxFeeSats: 10_000 }).approve(noFee)).toBe('reject');
    const noRate = { ...signing(), feeRate: Number.NaN };
    expect(await new PolicyGate({ maxFeeRate: 100 }).approve(noRate)).toBe('reject');
  });
});

describe('PolicyGate — combined rules', () => {
  const gate = new PolicyGate({
    maxSatsPerTx: 100_000,
    allowedRecipients: [RECIPIENT_A],
    maxFeeSats: 5_000,
    maxFeeRate: 25,
  });

  it('approves when every rule passes', async () => {
    expect(await gate.approve(signing({ external: 90_000, recipient: RECIPIENT_A, fee: 2_000 }))).toBe('approve');
  });

  it('rejects when any single rule fails', async () => {
    expect(await gate.approve(signing({ external: 100_001 }))).toBe('reject');
    expect(await gate.approve(signing({ recipient: RECIPIENT_EVIL }))).toBe('reject');
    expect(await gate.approve(signing({ fee: 5_001, vsize: 1_000 }))).toBe('reject');
    expect(await gate.approve(signing({ fee: 4_000, vsize: 100 }))).toBe('reject'); // 40 sat/vB
  });
});

// ---------------------------------------------------------------------------
// PolicyGate — windows
// ---------------------------------------------------------------------------

describe('PolicyGate — max_sats_per_24h', () => {
  it('counts approvals in a rolling day', async () => {
    let t = 0;
    const gate = new PolicyGate({ maxSatsPer24h: 100_000 }, { now: () => t });
    expect(await gate.approve(signing({ external: 60_000 }))).toBe('approve');
    expect(await gate.approve(signing({ external: 40_000 }))).toBe('approve');
    expect(await gate.approve(signing({ external: 1 }))).toBe('reject');
    t = DAY + 1;
    expect(await gate.approve(signing({ external: 60_000 }))).toBe('approve');
  });

  it('keeps an approval for exactly 24 h and prunes it afterwards', async () => {
    let t = 1_700_000_000_000;
    const gate = new PolicyGate({ maxSatsPer24h: 100 }, { now: () => t });
    expect(await gate.approve(signing({ external: 100 }))).toBe('approve');
    t += DAY;
    expect(await gate.approve(signing({ external: 1 }))).toBe('reject');
    t += 1;
    expect(await gate.approve(signing({ external: 1 }))).toBe('approve');
  });

  it('prunes entries individually as they age out', async () => {
    let t = 0;
    const gate = new PolicyGate({ maxSatsPer24h: 100 }, { now: () => t });
    expect(await gate.approve(signing({ external: 60 }))).toBe('approve'); // at 0
    t = 10 * HOUR;
    expect(await gate.approve(signing({ external: 40 }))).toBe('approve'); // at 10h
    t = DAY + 1; // the first entry is gone, the second remains
    expect(await gate.approve(signing({ external: 61 }))).toBe('reject');
    expect(await gate.approve(signing({ external: 60 }))).toBe('approve');
  });

  it('does not count change', async () => {
    const gate = new PolicyGate({ maxSatsPer24h: 100 });
    expect(await gate.approve(signing({ external: 100, change: 5_000_000 }))).toBe('approve');
    expect(await gate.approve(signing({ external: 0, change: 5_000_000 }))).toBe('approve');
  });

  it('evaluates the check and the record in one synchronous section', async () => {
    const gate = new PolicyGate({ maxSatsPer24h: 100_000 });
    const decisions = await Promise.all([
      gate.approve(signing({ external: 60_000, ceremonyId: 'c-a' })),
      gate.approve(signing({ external: 60_000, ceremonyId: 'c-b' })),
      gate.approve(signing({ external: 40_000, ceremonyId: 'c-c' })),
    ]);
    expect(decisions).toEqual(['approve', 'reject', 'approve']);
  });

  it('records nothing for a spec rejected by another rule', async () => {
    const gate = new PolicyGate({ maxSatsPer24h: 100, maxSatsPerTx: 80 });
    expect(await gate.approve(signing({ external: 90 }))).toBe('reject'); // over the per-tx cap
    expect(await gate.approve(signing({ external: 80 }))).toBe('approve');
    expect(await gate.approve(signing({ external: 20 }))).toBe('approve'); // 90 was never recorded
    expect(await gate.approve(signing({ external: 1 }))).toBe('reject');
  });

  it('records nothing for a spec rejected by the hourly ceremony cap, and vice versa', async () => {
    let t = 0;
    const gate = new PolicyGate({ maxSatsPer24h: 100, maxCeremoniesPerHour: 1 }, { now: () => t });
    expect(await gate.approve(signing({ external: 10 }))).toBe('approve');
    expect(await gate.approve(signing({ external: 50 }))).toBe('reject'); // hourly cap hit
    t = HOUR + 1;
    expect(await gate.approve(signing({ external: 90 }))).toBe('approve'); // 10 + 90, the 50 was not recorded

    t = 2 * DAY;
    const gate2 = new PolicyGate({ maxSatsPer24h: 100, maxCeremoniesPerHour: 1 }, { now: () => t });
    expect(await gate2.approve(signing({ external: 200 }))).toBe('reject'); // 24 h cap
    expect(await gate2.approve(signing({ external: 10 }))).toBe('approve'); // hourly slot still free
  });

  it('does not count DKG specs and is not applied to them', async () => {
    const gate = new PolicyGate({ maxSatsPer24h: 1 });
    expect(await gate.approve(dkgSpec())).toBe('approve');
    expect(await gate.approve(signing({ external: 1 }))).toBe('approve');
  });
});

describe('PolicyGate — max_ceremonies_per_hour (sliding window)', () => {
  it('approves up to the cap, rejects the N+1th within the hour', async () => {
    let t = 1_700_000_000_000;
    const gate = new PolicyGate({ maxCeremoniesPerHour: 3 }, { now: () => t });
    for (let i = 0; i < 3; i++) {
      expect(await gate.approve(signing({ ceremonyId: `c${i}` }))).toBe('approve');
      t += 100;
    }
    expect(await gate.approve(signing({ ceremonyId: 'c3' }))).toBe('reject');
  });

  it('evicts old approvals past the 1h cutoff', async () => {
    let t = 1_700_000_000_000;
    const gate = new PolicyGate({ maxCeremoniesPerHour: 2 }, { now: () => t });
    expect(await gate.approve(signing({ ceremonyId: 'c0' }))).toBe('approve');
    expect(await gate.approve(signing({ ceremonyId: 'c1' }))).toBe('approve');
    expect(await gate.approve(signing({ ceremonyId: 'c2' }))).toBe('reject');
    t += HOUR + 1;
    expect(await gate.approve(signing({ ceremonyId: 'c3' }))).toBe('approve');
  });

  it('does NOT count DKG towards the signing rate limit', async () => {
    const gate = new PolicyGate({ maxCeremoniesPerHour: 1 });
    expect(await gate.approve(dkgSpec({ ceremonyId: 'dkg-0' }))).toBe('approve');
    expect(await gate.approve(dkgSpec({ ceremonyId: 'dkg-1' }))).toBe('approve');
    expect(await gate.approve(signing({ ceremonyId: 'sig-0' }))).toBe('approve');
    expect(await gate.approve(signing({ ceremonyId: 'sig-1' }))).toBe('reject');
  });

  it('does NOT record a timestamp on rejection (slots are only consumed by approvals)', async () => {
    let t = 1_700_000_000_000;
    const gate = new PolicyGate(
      { maxCeremoniesPerHour: 2, allowedRecipients: [RECIPIENT_A] },
      { now: () => t },
    );
    for (let i = 0; i < 10; i++) {
      expect(await gate.approve(signing({ ceremonyId: `bad${i}`, recipient: RECIPIENT_EVIL }))).toBe('reject');
      t += 10;
    }
    expect(await gate.approve(signing({ ceremonyId: 'ok0' }))).toBe('approve');
    expect(await gate.approve(signing({ ceremonyId: 'ok1' }))).toBe('approve');
    expect(await gate.approve(signing({ ceremonyId: 'ok2' }))).toBe('reject');
  });
});

// ---------------------------------------------------------------------------
// PolicyGate — DKG
// ---------------------------------------------------------------------------

describe('PolicyGate — DKG', () => {
  it('approves DKG by default (no dkg_leader_allowlist)', async () => {
    const gate = new PolicyGate({ maxSatsPerTx: 1 });
    expect(await gate.approve(dkgSpec())).toBe('approve');
  });
  it('approves DKG when the leader is in the allowlist', async () => {
    const gate = new PolicyGate({ dkgLeaderAllowlist: ['node-a'] });
    expect(await gate.approve(dkgSpec({ leader: 'node-a' }))).toBe('approve');
  });
  it('rejects DKG when the leader is not in the allowlist', async () => {
    const gate = new PolicyGate({ dkgLeaderAllowlist: ['node-a'] });
    expect(await gate.approve(dkgSpec({ leader: 'node-z' }))).toBe('reject');
  });
  it('signing rules never apply to a DKG spec', async () => {
    const gate = new PolicyGate({
      maxSatsPerTx: 0,
      maxSatsPer24h: 0,
      allowedRecipients: [],
      maxFeeSats: 0,
      maxFeeRate: 0,
    });
    expect(await gate.approve(dkgSpec())).toBe('approve');
  });
  it('the DKG leader allowlist never applies to a signing spec', async () => {
    const gate = new PolicyGate({ dkgLeaderAllowlist: ['node-a'] });
    expect(await gate.approve(signing({ leader: 'node-z' }))).toBe('approve');
  });
});

// ---------------------------------------------------------------------------
// parsePolicyParams
// ---------------------------------------------------------------------------

describe('parsePolicyParams', () => {
  it('parses empty params', () => {
    expect(parsePolicyParams({})).toEqual({});
  });

  it('parses every key with the snake_case → camelCase mapping', () => {
    expect(
      parsePolicyParams({
        max_sats_per_tx: 100_000,
        max_sats_per_24h: 1_000_000,
        allowed_recipients: [RECIPIENT_A, RECIPIENT_B],
        max_fee_sats: 5_000,
        max_fee_rate: 12.5,
        max_ceremonies_per_hour: 10,
        dkg_leader_allowlist: ['node-a'],
      }),
    ).toEqual({
      maxSatsPerTx: 100_000,
      maxSatsPer24h: 1_000_000,
      allowedRecipients: [RECIPIENT_A, RECIPIENT_B],
      maxFeeSats: 5_000,
      maxFeeRate: 12.5,
      maxCeremoniesPerHour: 10,
      dkgLeaderAllowlist: ['node-a'],
    });
  });

  it('rejects legacy keys with the replacement', () => {
    expect(() => parsePolicyParams({ max_btc_per_tx: 1 })).toThrow(/use max_sats_per_tx/);
    expect(() => parsePolicyParams({ max_amount: 1 })).toThrow(/use max_sats_per_tx/);
    expect(() => parsePolicyParams({ allowed_btc_recipients: [] })).toThrow(/use allowed_recipients/);
    expect(() => parsePolicyParams({ destination_allowlist: [] })).toThrow(/use allowed_recipients/);
    expect(() => parsePolicyParams({ allowed_contracts: [] })).toThrow(/no longer supported/);
    expect(() => parsePolicyParams({ method_allowlist: [] })).toThrow(/no longer supported/);
  });

  it('reports each legacy key as a ConfigError at gate.<key>', () => {
    const legacy: Array<[string, string]> = [
      ['max_amount', 'use max_sats_per_tx'],
      ['max_btc_per_tx', 'use max_sats_per_tx'],
      ['allowed_btc_recipients', 'use allowed_recipients'],
      ['destination_allowlist', 'use allowed_recipients'],
      ['method_allowlist', 'no longer supported'],
      ['allowed_contracts', 'no longer supported'],
    ];
    for (const [key, message] of legacy) {
      try {
        parsePolicyParams({ [key]: 1 });
        expect.fail(`${key} should have been rejected`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).path).toBe(`gate.${key}`);
        expect((err as ConfigError).message).toBe(`config gate.${key}: ${message}`);
      }
    }
  });

  it('rejects a legacy key even next to valid keys', () => {
    expect(() => parsePolicyParams({ max_sats_per_tx: 1, max_amount: 1 })).toThrow(/gate\.max_amount/);
  });

  it('rejects unknown keys', () => {
    expect(() => parsePolicyParams({ ignore_amount: true })).toThrow(/gate\.ignore_amount.*unknown policy field/);
  });

  describe('sat caps', () => {
    const CAP_KEYS = ['max_sats_per_tx', 'max_sats_per_24h', 'max_fee_sats'] as const;
    const FIELD: Record<(typeof CAP_KEYS)[number], string> = {
      max_sats_per_tx: 'maxSatsPerTx',
      max_sats_per_24h: 'maxSatsPer24h',
      max_fee_sats: 'maxFeeSats',
    };

    for (const key of CAP_KEYS) {
      it(`${key} accepts integers and decimal strings`, () => {
        expect(parsePolicyParams({ [key]: 0 })).toEqual({ [FIELD[key]]: 0 });
        expect(parsePolicyParams({ [key]: 100_000 })).toEqual({ [FIELD[key]]: 100_000 });
        expect(parsePolicyParams({ [key]: '2100000000000000' })).toEqual({ [FIELD[key]]: 2_100_000_000_000_000 });
        expect(parsePolicyParams({ [key]: Number.MAX_SAFE_INTEGER })).toEqual({ [FIELD[key]]: Number.MAX_SAFE_INTEGER });
        expect(parsePolicyParams({ [key]: String(Number.MAX_SAFE_INTEGER) })).toEqual({
          [FIELD[key]]: Number.MAX_SAFE_INTEGER,
        });
      });

      it(`${key} rejects negatives, fractions and unsafe integers`, () => {
        const path = new RegExp(`gate\\.${key}`);
        expect(() => parsePolicyParams({ [key]: -1 })).toThrow(path);
        expect(() => parsePolicyParams({ [key]: '-1' })).toThrow(path);
        expect(() => parsePolicyParams({ [key]: 1.5 })).toThrow(path);
        expect(() => parsePolicyParams({ [key]: '1.5' })).toThrow(path);
        expect(() => parsePolicyParams({ [key]: Number.MAX_SAFE_INTEGER + 1 })).toThrow(path);
        expect(() => parsePolicyParams({ [key]: String(Number.MAX_SAFE_INTEGER + 1) })).toThrow(path);
        expect(() => parsePolicyParams({ [key]: '99999999999999999999999' })).toThrow(path);
        expect(() => parsePolicyParams({ [key]: 10n ** 30n })).toThrow(path);
        expect(() => parsePolicyParams({ [key]: Number.NaN })).toThrow(path);
        expect(() => parsePolicyParams({ [key]: Number.POSITIVE_INFINITY })).toThrow(path);
      });

      it(`${key} rejects non-numeric values`, () => {
        const path = new RegExp(`gate\\.${key}`);
        for (const bad of ['', ' 5', '1e5', '0x10', 'oops', true, null, [], {}]) {
          expect(() => parsePolicyParams({ [key]: bad }), JSON.stringify(bad)).toThrow(path);
        }
      });
    }

    it('accepts a TOML bigint inside the safe range', () => {
      expect(parsePolicyParams({ max_sats_per_tx: 5n })).toEqual({ maxSatsPerTx: 5 });
    });

    it('names the offending cap in the error message', () => {
      expect(() => parsePolicyParams({ max_sats_per_tx: -1 })).toThrow(/gate\.max_sats_per_tx.*must be >= 0/);
      expect(() => parsePolicyParams({ max_sats_per_tx: 1.5 })).toThrow(/gate\.max_sats_per_tx.*must be an integer/);
      expect(() => parsePolicyParams({ max_sats_per_tx: 2 ** 53 })).toThrow(/gate\.max_sats_per_tx.*must be <= 9007199254740991/);
      expect(() => parsePolicyParams({ max_sats_per_tx: '1e5' })).toThrow(/gate\.max_sats_per_tx.*non-negative decimal string/);
    });
  });

  describe('max_fee_rate', () => {
    it('accepts non-negative numbers, fractional included, and decimal strings', () => {
      expect(parsePolicyParams({ max_fee_rate: 0 })).toEqual({ maxFeeRate: 0 });
      expect(parsePolicyParams({ max_fee_rate: 2.5 })).toEqual({ maxFeeRate: 2.5 });
      expect(parsePolicyParams({ max_fee_rate: 25 })).toEqual({ maxFeeRate: 25 });
      expect(parsePolicyParams({ max_fee_rate: '2.5' })).toEqual({ maxFeeRate: 2.5 });
      expect(parsePolicyParams({ max_fee_rate: '3' })).toEqual({ maxFeeRate: 3 });
    });

    it('rejects negatives, non-finite numbers and malformed strings', () => {
      for (const bad of [-0.5, '-1', Number.NaN, Number.POSITIVE_INFINITY, '', '.5', '5.', '1e3', '2.5.1', ' 2', 'fast', true, null, []]) {
        expect(() => parsePolicyParams({ max_fee_rate: bad }), String(bad)).toThrow(/gate\.max_fee_rate/);
      }
      expect(() => parsePolicyParams({ max_fee_rate: '9'.repeat(400) })).toThrow(/gate\.max_fee_rate/);
    });
  });

  describe('allowed_recipients', () => {
    it('accepts an array of non-empty address strings, including an empty array', () => {
      expect(parsePolicyParams({ allowed_recipients: [RECIPIENT_A] })).toEqual({ allowedRecipients: [RECIPIENT_A] });
      expect(parsePolicyParams({ allowed_recipients: [] })).toEqual({ allowedRecipients: [] });
    });

    it('rejects a non-array', () => {
      expect(() => parsePolicyParams({ allowed_recipients: RECIPIENT_A })).toThrow(
        /gate\.allowed_recipients.*must be an array/,
      );
    });

    it('rejects a non-string or empty element with an indexed path', () => {
      expect(() => parsePolicyParams({ allowed_recipients: [RECIPIENT_A, RECIPIENT_B, 42] })).toThrow(
        /gate\.allowed_recipients\[2\].*must be a string/,
      );
      expect(() => parsePolicyParams({ allowed_recipients: [RECIPIENT_A, ''] })).toThrow(
        /gate\.allowed_recipients\[1\].*must not be empty/,
      );
    });

    it('copies the array', () => {
      const input = [RECIPIENT_A];
      const parsed = parsePolicyParams({ allowed_recipients: input });
      input.push(RECIPIENT_EVIL);
      expect(parsed.allowedRecipients).toEqual([RECIPIENT_A]);
    });
  });

  describe('max_ceremonies_per_hour and dkg_leader_allowlist', () => {
    it('rejects non-positive or fractional max_ceremonies_per_hour', () => {
      expect(() => parsePolicyParams({ max_ceremonies_per_hour: 0 })).toThrow(/gate\.max_ceremonies_per_hour.*>= 1/);
      expect(() => parsePolicyParams({ max_ceremonies_per_hour: 1.5 })).toThrow(
        /gate\.max_ceremonies_per_hour.*positive integer/,
      );
    });

    it('rejects a dkg_leader_allowlist that is not an array of strings', () => {
      expect(() => parsePolicyParams({ dkg_leader_allowlist: 'node-a' })).toThrow(
        /gate\.dkg_leader_allowlist.*must be an array/,
      );
      expect(() => parsePolicyParams({ dkg_leader_allowlist: ['node-a', 1] })).toThrow(
        /gate\.dkg_leader_allowlist\[1\].*must be a string/,
      );
    });
  });

  it('carries the key path on ConfigError', () => {
    try {
      parsePolicyParams({ max_sats_per_tx: 'oops' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).path).toBe('gate.max_sats_per_tx');
    }
  });
});

// ---------------------------------------------------------------------------
// Spec builders
// ---------------------------------------------------------------------------

describe('buildSigningSpec', () => {
  function analysis(): ProposalAnalysis {
    return {
      txid: 'ab'.repeat(32),
      inputs: [
        { txid: 'cd'.repeat(32), vout: 1, amount: 700_000 },
        { txid: 'ef'.repeat(32), vout: 0, amount: 400_000 },
      ],
      outputs: [
        { address: RECIPIENT_A, amount: 300_000, isChange: false },
        { address: VAULT, amount: 700_000, isChange: true },
        { address: RECIPIENT_B, amount: 90_000, isChange: false },
      ],
      totalIn: 1_100_000,
      totalOut: 1_090_000,
      fee: 10_000,
      vsize: 250,
      feeRate: 40,
      sighashes: [
        { index: 0, hash: '11'.repeat(32), type: 'key-path' },
        { index: 1, hash: '22'.repeat(32), type: 'key-path' },
      ],
    };
  }
  const base = { ceremonyId: 'sign-1', leader: 'node-a', role: 'participant' as const };

  it('sums non-change outputs and copies the analysis fields', () => {
    const a = analysis();
    expect(buildSigningSpec(a, base, 'testnet4')).toStrictEqual({
      kind: 'signing',
      ceremonyId: 'sign-1',
      leader: 'node-a',
      role: 'participant',
      network: 'testnet4',
      txid: a.txid,
      inputs: a.inputs,
      outputs: a.outputs,
      amount: 390_000,
      totalIn: 1_100_000,
      totalOut: 1_090_000,
      fee: 10_000,
      vsize: 250,
      feeRate: 40,
    });
  });

  it('drops the sighashes', () => {
    expect(buildSigningSpec(analysis(), base, 'mainnet')).not.toHaveProperty('sighashes');
  });

  it('amount is 0 when every output is change', () => {
    const a = analysis();
    a.outputs = [{ address: VAULT, amount: 1_090_000, isChange: true }];
    expect(buildSigningSpec(a, base, 'mainnet').amount).toBe(0);
  });

  it('applies labels only where labelFor returns a string', () => {
    const labels = new Map([[RECIPIENT_A, 'Exchange hot wallet'], [VAULT, 'Our vault']]);
    const spec = buildSigningSpec(analysis(), base, 'mainnet', (address) => labels.get(address));
    expect(spec.outputs).toStrictEqual([
      { address: RECIPIENT_A, amount: 300_000, isChange: false, label: 'Exchange hot wallet' },
      { address: VAULT, amount: 700_000, isChange: true, label: 'Our vault' },
      { address: RECIPIENT_B, amount: 90_000, isChange: false },
    ]);
    expect('label' in spec.outputs[2]!).toBe(false);
  });

  it('leaves outputs unlabelled without labelFor', () => {
    const spec = buildSigningSpec(analysis(), base, 'mainnet');
    for (const out of spec.outputs) expect('label' in out).toBe(false);
  });

  it('does not alias the analysis', () => {
    const a = analysis();
    const spec = buildSigningSpec(a, base, 'mainnet');
    a.outputs[0]!.amount = 1;
    a.inputs[0]!.amount = 1;
    expect(spec.outputs[0]!.amount).toBe(300_000);
    expect(spec.inputs[0]!.amount).toBe(700_000);
  });

  it('produces a spec the policy gate evaluates', async () => {
    const spec = buildSigningSpec(analysis(), base, 'mainnet');
    expect(await new PolicyGate({ maxSatsPerTx: 390_000, allowedRecipients: [RECIPIENT_A, RECIPIENT_B] }).approve(spec)).toBe('approve');
    expect(await new PolicyGate({ maxSatsPerTx: 389_999 }).approve(spec)).toBe('reject');
    expect(await new PolicyGate({ maxFeeRate: 39.9 }).approve(spec)).toBe('reject');
  });
});

describe('buildDkgSpec', () => {
  it('combines the base with the ring parameters', () => {
    const peerIds = ['node-a', 'node-b', 'node-c'];
    const spec = buildDkgSpec(
      { ceremonyId: 'dkg-9', leader: 'node-b', role: 'leader' },
      { threshold: 3, parties: 3, network: 'signet', peerIds },
    );
    expect(spec).toStrictEqual({
      kind: 'dkg',
      ceremonyId: 'dkg-9',
      leader: 'node-b',
      role: 'leader',
      threshold: 3,
      parties: 3,
      network: 'signet',
      peerIds: ['node-a', 'node-b', 'node-c'],
    });
    peerIds.push('node-d');
    expect(spec.peerIds).toHaveLength(3);
  });
});

describe('resolveLeaderId', () => {
  it('maps a party to its label and falls back to the party number', () => {
    const peers = new Map([[0, 'node-a'], [1, 'node-b']]);
    expect(resolveLeaderId(1, peers)).toBe('node-b');
    expect(resolveLeaderId(2, peers)).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// createGate (exec and webhook approvers receive the spec as JSON)
// ---------------------------------------------------------------------------

describe('createGate', () => {
  it('creates AutoGate for strategy="auto"', async () => {
    const gate = createGate({ strategy: 'auto' });
    expect(gate).toBeInstanceOf(AutoGate);
    expect(await gate.approve(signing())).toBe('approve');
  });

  it('creates PolicyGate for strategy="policy" with flat params', async () => {
    const gate = createGate({
      strategy: 'policy',
      params: { max_sats_per_tx: 1000, allowed_recipients: [RECIPIENT_A] },
    });
    expect(gate).toBeInstanceOf(PolicyGate);
    expect(await gate.approve(signing({ external: 500 }))).toBe('approve');
    expect(await gate.approve(signing({ external: 2000 }))).toBe('reject');
    expect(await gate.approve(signing({ external: 500, recipient: RECIPIENT_EVIL }))).toBe('reject');
  });

  it('creates PolicyGate with no params (empty rules = approve everything)', async () => {
    const gate = createGate({ strategy: 'policy' });
    expect(await gate.approve(signing({ external: 2_100_000_000_000_000 }))).toBe('approve');
  });

  it('propagates policy param errors at construction time', () => {
    expect(() => createGate({ strategy: 'policy', params: { max_sats_per_tx: -1 } })).toThrow(
      /gate\.max_sats_per_tx.*must be >= 0/,
    );
    expect(() => createGate({ strategy: 'policy', params: { max_btc_per_tx: 1 } })).toThrow(/use max_sats_per_tx/);
  });

  it('creates ExecGate for strategy="exec"', async () => {
    const gate = createGate({
      strategy: 'exec',
      params: {
        command: [process.execPath, '-e', 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{if(!d)process.exit(1);process.stdout.write("approve\\n");process.exit(0);});'],
        timeout_sec: 10,
      },
    });
    expect(await gate.approve(signing())).toBe('approve');
  });

  it('ExecGate returns reject when command prints "reject"', async () => {
    const gate = createGate({
      strategy: 'exec',
      params: {
        command: [process.execPath, '-e', 'process.stdin.resume();process.stdin.on("end",()=>{console.log("reject");process.exit(0)});'],
        timeout_sec: 10,
      },
    });
    expect(await gate.approve(signing())).toBe('reject');
  });

  it('ExecGate delivers the Bitcoin signing spec as one JSON line with numeric sats', async () => {
    // The approver parses stdin and approves only if the spec has the Bitcoin shape.
    const script = [
      'let d="";process.stdin.on("data",c=>d+=c);',
      'process.stdin.on("end",()=>{',
      'const lines=d.split("\\n");const s=JSON.parse(lines[0]);',
      'const ok=lines.length===2&&lines[1]===""&&s.kind==="signing"&&s.network==="mainnet"',
      '&&s.amount===50000&&s.fee===1000&&s.feeRate===5&&s.vsize===200',
      '&&s.outputs.length===2&&s.outputs[0].isChange===false&&s.outputs[0].amount===50000',
      '&&s.outputs[1].isChange===true&&!("operation" in s);',
      'process.stdout.write(ok?"approve\\n":"reject\\n");});',
    ].join('');
    const gate = createGate({
      strategy: 'exec',
      params: { command: [process.execPath, '-e', script], timeout_sec: 10 },
    });
    expect(await gate.approve(signing({ external: 50_000, change: 20_000 }))).toBe('approve');
  });

  it('ExecGate delivers a DKG spec with the network and no protocol field', async () => {
    const script = [
      'let d="";process.stdin.on("data",c=>d+=c);',
      'process.stdin.on("end",()=>{const s=JSON.parse(d);',
      'const ok=s.kind==="dkg"&&s.network==="mainnet"&&s.threshold===3&&s.parties===3&&s.peerIds.length===3&&!("protocol" in s);',
      'process.stdout.write(ok?"approve\\n":"reject\\n");});',
    ].join('');
    const gate = createGate({
      strategy: 'exec',
      params: { command: [process.execPath, '-e', script], timeout_sec: 10 },
    });
    expect(await gate.approve(dkgSpec())).toBe('approve');
  });

  it('ExecGate rejects invalid exec params at construction', () => {
    expect(() => createGate({ strategy: 'exec', params: { command: [], timeout_sec: 10 } }))
      .toThrow(/gate\.command/);
    expect(() => createGate({ strategy: 'exec', params: { command: ['/bin/true'], timeout_sec: -1 } }))
      .toThrow(/gate\.timeout_sec/);
    expect(() => createGate({ strategy: 'exec', params: { command: ['/bin/true'], timeout_sec: 5, unknown: 1 } }))
      .toThrow(/gate\.unknown/);
  });

  it('creates WebhookGate for strategy="webhook" and returns the approver decision', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ decision: 'approve' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    try {
      const gate = createGate({
        strategy: 'webhook',
        params: { url: 'http://approver.test/decide', timeout_sec: 5 },
      });
      expect(await gate.approve(signing())).toBe('approve');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('WebhookGate posts the signing spec as JSON with numeric sats', async () => {
    const origFetch = globalThis.fetch;
    let body: unknown;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ decision: 'reject' }), { status: 200 });
    }) as typeof fetch;
    try {
      const gate = createGate({
        strategy: 'webhook',
        params: { url: 'http://approver.test/decide', timeout_sec: 5 },
      });
      const spec = signing({ external: 50_000, change: 20_000 });
      expect(await gate.approve(spec)).toBe('reject');
      expect(body).toEqual(spec);
      expect(typeof (body as SigningSpec).amount).toBe('number');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('WebhookGate throws on non-200 response', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('server down', { status: 503 });
    try {
      const gate = createGate({
        strategy: 'webhook',
        params: { url: 'http://approver.test/decide', timeout_sec: 5 },
      });
      await expect(gate.approve(signing())).rejects.toThrow(/503/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('WebhookGate rejects invalid params at construction', () => {
    expect(() => createGate({ strategy: 'webhook', params: { timeout_sec: 5 } }))
      .toThrow(/gate\.url/);
    expect(() => createGate({ strategy: 'webhook', params: { url: 'http://x', timeout_sec: 0 } }))
      .toThrow(/gate\.timeout_sec/);
    expect(() => createGate({ strategy: 'webhook', params: { url: 'http://x', timeout_sec: 5, bogus: true } }))
      .toThrow(/gate\.bogus/);
  });
});
