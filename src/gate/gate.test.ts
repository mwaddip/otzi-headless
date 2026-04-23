import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config/parse';
import type { GateConfig } from '../config/types';
import { AutoGate, createGate } from './factory';
import { parsePolicyParams, PolicyGate } from './policy';
import type { CeremonySpec, DkgSpec, SigningSpec } from './types';

function signingSpec(overrides: Partial<SigningSpec> = {}): SigningSpec {
  return {
    kind: 'signing',
    ceremonyId: 'ceremony-1',
    leader: 'node-a',
    role: 'leader',
    operation: 'btc-transfer',
    amount: 50_000n,
    destination: 'bc1ptest',
    method: 'default',
    ...overrides,
  };
}

function dkgSpec(overrides: Partial<DkgSpec> = {}): DkgSpec {
  return {
    kind: 'dkg',
    ceremonyId: 'dkg-1',
    leader: 'node-a',
    role: 'leader',
    protocol: 'combined',
    threshold: 2,
    parties: 3,
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
    expect(await gate.approve(signingSpec({ amount: 10n ** 18n }))).toBe('approve');
  });
  it('approves any DKG spec', async () => {
    expect(await gate.approve(dkgSpec())).toBe('approve');
  });
});

// ---------------------------------------------------------------------------
// PolicyGate — signing
// ---------------------------------------------------------------------------

describe('PolicyGate — maxAmount', () => {
  it('approves when amount ≤ cap', async () => {
    const gate = new PolicyGate({ maxAmount: 100_000n });
    expect(await gate.approve(signingSpec({ amount: 100_000n }))).toBe('approve');
    expect(await gate.approve(signingSpec({ amount: 50_000n }))).toBe('approve');
  });
  it('rejects when amount > cap', async () => {
    const gate = new PolicyGate({ maxAmount: 100_000n });
    expect(await gate.approve(signingSpec({ amount: 100_001n }))).toBe('reject');
  });
  it('rejects when amount is missing but cap is set (strict-by-default)', async () => {
    const gate = new PolicyGate({ maxAmount: 100_000n });
    expect(await gate.approve(signingSpec({ amount: undefined }))).toBe('reject');
  });
  it('approves when no cap is set, even with huge amount', async () => {
    const gate = new PolicyGate({});
    expect(await gate.approve(signingSpec({ amount: 10n ** 18n }))).toBe('approve');
  });
  it('handles bigint amounts beyond Number.MAX_SAFE_INTEGER', async () => {
    const hugeCap = 10n ** 30n;
    const gate = new PolicyGate({ maxAmount: hugeCap });
    expect(await gate.approve(signingSpec({ amount: hugeCap }))).toBe('approve');
    expect(await gate.approve(signingSpec({ amount: hugeCap + 1n }))).toBe('reject');
  });
});

describe('PolicyGate — destinationAllowlist', () => {
  const gate = new PolicyGate({ destinationAllowlist: ['bc1pgood', 'bc1pallowed'] });
  it('approves when destination is in the list', async () => {
    expect(await gate.approve(signingSpec({ destination: 'bc1pgood' }))).toBe('approve');
  });
  it('rejects when destination is not in the list', async () => {
    expect(await gate.approve(signingSpec({ destination: 'bc1pevil' }))).toBe('reject');
  });
  it('rejects when destination is missing (strict-by-default)', async () => {
    expect(await gate.approve(signingSpec({ destination: undefined }))).toBe('reject');
  });
});

describe('PolicyGate — methodAllowlist', () => {
  const gate = new PolicyGate({ methodAllowlist: ['transfer', 'approve'] });
  it('approves when method is in the list', async () => {
    expect(await gate.approve(signingSpec({ method: 'transfer' }))).toBe('approve');
  });
  it('rejects when method is not in the list', async () => {
    expect(await gate.approve(signingSpec({ method: 'drain' }))).toBe('reject');
  });
  it('rejects when method is missing (strict-by-default)', async () => {
    expect(await gate.approve(signingSpec({ method: undefined }))).toBe('reject');
  });
});

describe('PolicyGate — combined rules', () => {
  const gate = new PolicyGate({
    maxAmount: 100_000n,
    destinationAllowlist: ['bc1pgood'],
    methodAllowlist: ['transfer'],
  });
  it('approves when all rules pass', async () => {
    expect(
      await gate.approve(
        signingSpec({ amount: 50_000n, destination: 'bc1pgood', method: 'transfer' }),
      ),
    ).toBe('approve');
  });
  it('rejects when any rule fails', async () => {
    expect(
      await gate.approve(
        signingSpec({ amount: 100_001n, destination: 'bc1pgood', method: 'transfer' }),
      ),
    ).toBe('reject');
    expect(
      await gate.approve(
        signingSpec({ amount: 50_000n, destination: 'bc1pevil', method: 'transfer' }),
      ),
    ).toBe('reject');
    expect(
      await gate.approve(
        signingSpec({ amount: 50_000n, destination: 'bc1pgood', method: 'drain' }),
      ),
    ).toBe('reject');
  });
});

// ---------------------------------------------------------------------------
// PolicyGate — DKG
// ---------------------------------------------------------------------------

describe('PolicyGate — DKG', () => {
  it('approves DKG by default (no dkg_leader_allowlist)', async () => {
    const gate = new PolicyGate({ maxAmount: 100_000n });
    expect(await gate.approve(dkgSpec())).toBe('approve');
  });
  it('approves DKG when leader is in the allowlist', async () => {
    const gate = new PolicyGate({ dkgLeaderAllowlist: ['node-a'] });
    expect(await gate.approve(dkgSpec({ leader: 'node-a' }))).toBe('approve');
  });
  it('rejects DKG when leader is not in the allowlist', async () => {
    const gate = new PolicyGate({ dkgLeaderAllowlist: ['node-a'] });
    expect(await gate.approve(dkgSpec({ leader: 'node-z' }))).toBe('reject');
  });
  it('DKG ignores signing-specific rules', async () => {
    const gate = new PolicyGate({
      maxAmount: 1n,
      destinationAllowlist: [],
      methodAllowlist: [],
    });
    expect(await gate.approve(dkgSpec())).toBe('approve');
  });
});

// ---------------------------------------------------------------------------
// parsePolicyParams
// ---------------------------------------------------------------------------

describe('parsePolicyParams', () => {
  it('parses empty params', () => {
    expect(parsePolicyParams({})).toEqual({});
  });

  it('parses all fields with snake_case → camelCase mapping', () => {
    expect(
      parsePolicyParams({
        max_amount: 100_000,
        destination_allowlist: ['bc1p1', 'bc1p2'],
        method_allowlist: ['transfer'],
        dkg_leader_allowlist: ['node-a'],
      }),
    ).toEqual({
      maxAmount: 100_000n,
      destinationAllowlist: ['bc1p1', 'bc1p2'],
      methodAllowlist: ['transfer'],
      dkgLeaderAllowlist: ['node-a'],
    });
  });

  it('accepts max_amount as a bigint', () => {
    expect(parsePolicyParams({ max_amount: 10n ** 30n })).toEqual({
      maxAmount: 10n ** 30n,
    });
  });

  it('accepts max_amount as a decimal string for u256-scale values', () => {
    expect(parsePolicyParams({ max_amount: '123456789012345678901234567890' })).toEqual({
      maxAmount: 123456789012345678901234567890n,
    });
  });

  it('rejects negative max_amount', () => {
    expect(() => parsePolicyParams({ max_amount: -1 })).toThrow(
      /gate\.max_amount.*must be >= 0/,
    );
  });

  it('rejects non-integer max_amount', () => {
    expect(() => parsePolicyParams({ max_amount: 1.5 })).toThrow(
      /gate\.max_amount.*must be an integer/,
    );
  });

  it('rejects max_amount string with non-digit chars', () => {
    expect(() => parsePolicyParams({ max_amount: '1e5' })).toThrow(
      /gate\.max_amount.*non-negative decimal string/,
    );
  });

  it('rejects destination_allowlist not an array', () => {
    expect(() => parsePolicyParams({ destination_allowlist: 'bc1p' })).toThrow(
      /gate\.destination_allowlist.*must be an array/,
    );
  });

  it('rejects non-string item in destination_allowlist', () => {
    expect(() =>
      parsePolicyParams({ destination_allowlist: ['bc1p', 42] }),
    ).toThrow(/gate\.destination_allowlist\[1\].*must be a string/);
  });

  it('rejects unknown policy field', () => {
    expect(() => parsePolicyParams({ ignore_amount: true })).toThrow(
      /gate\.ignore_amount.*unknown policy field/,
    );
  });

  it('carries a path on ConfigError', () => {
    try {
      parsePolicyParams({ max_amount: 'oops' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).path).toBe('gate.max_amount');
    }
  });
});

// ---------------------------------------------------------------------------
// createGate
// ---------------------------------------------------------------------------

describe('createGate', () => {
  it('creates AutoGate for strategy="auto"', async () => {
    const gate = createGate({ strategy: 'auto' });
    expect(gate).toBeInstanceOf(AutoGate);
    expect(await gate.approve(signingSpec())).toBe('approve');
  });

  it('creates PolicyGate for strategy="policy" with params', async () => {
    const gate = createGate({
      strategy: 'policy',
      params: { max_amount: 1000, destination_allowlist: ['bc1p1'] },
    });
    expect(gate).toBeInstanceOf(PolicyGate);
    expect(
      await gate.approve(signingSpec({ amount: 500n, destination: 'bc1p1' })),
    ).toBe('approve');
    expect(
      await gate.approve(signingSpec({ amount: 2000n, destination: 'bc1p1' })),
    ).toBe('reject');
  });

  it('creates PolicyGate with no params (empty rules = approve everything)', async () => {
    const gate = createGate({ strategy: 'policy' });
    expect(await gate.approve(signingSpec({ amount: 10n ** 18n }))).toBe('approve');
  });

  it('throws for unimplemented strategies', () => {
    for (const strategy of ['webhook', 'cli', 'queue'] as const) {
      const cfg: GateConfig = { strategy };
      expect(() => createGate(cfg)).toThrow(/not implemented yet/);
    }
  });

  it('propagates policy param errors at construction time', () => {
    expect(() =>
      createGate({ strategy: 'policy', params: { max_amount: -1 } }),
    ).toThrow(/gate\.max_amount.*must be >= 0/);
  });
});
