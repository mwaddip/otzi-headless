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
// PolicyGate — protocol-scoped rules + rate limit
// ---------------------------------------------------------------------------

describe('PolicyGate — maxBtcPerTx', () => {
  const btcSpec = (overrides: Partial<SigningSpec> = {}) =>
    signingSpec({
      operation: 'btc-transfer',
      outputs: [{ address: 'bc1pA', amountSat: 40_000n }, { address: 'bc1pB', amountSat: 60_000n }],
      amount: 100_000n,
      destination: 'bc1pA',
      method: undefined,
      ...overrides,
    });

  it('approves when sum of outputs is at or below cap', async () => {
    const gate = new PolicyGate({ maxBtcPerTx: 100_000n });
    expect(await gate.approve(btcSpec())).toBe('approve');
  });

  it('rejects when sum of outputs exceeds cap', async () => {
    const gate = new PolicyGate({ maxBtcPerTx: 99_999n });
    expect(await gate.approve(btcSpec())).toBe('reject');
  });

  it('rejects when outputs missing on a btc-transfer spec', async () => {
    const gate = new PolicyGate({ maxBtcPerTx: 1_000_000n });
    expect(await gate.approve(btcSpec({ outputs: undefined }))).toBe('reject');
  });

  it('does NOT apply to opnet-call specs', async () => {
    const gate = new PolicyGate({ maxBtcPerTx: 1n });
    expect(
      await gate.approve(signingSpec({ operation: 'opnet-call', outputs: undefined })),
    ).toBe('approve');
  });
});

describe('PolicyGate — allowedBtcRecipients', () => {
  const btcSpec = (outputs: SigningSpec['outputs']) =>
    signingSpec({ operation: 'btc-transfer', outputs, amount: 100n, destination: undefined, method: undefined });

  it('approves when every non-self output is in allowlist', async () => {
    const gate = new PolicyGate({ allowedBtcRecipients: ['bc1pA', 'bc1pB'] });
    expect(
      await gate.approve(btcSpec([{ address: 'bc1pA', amountSat: 50n }, { address: 'bc1pB', amountSat: 50n }])),
    ).toBe('approve');
  });

  it('rejects when any output is not in allowlist', async () => {
    const gate = new PolicyGate({ allowedBtcRecipients: ['bc1pA'] });
    expect(
      await gate.approve(btcSpec([{ address: 'bc1pA', amountSat: 50n }, { address: 'bc1pEvil', amountSat: 50n }])),
    ).toBe('reject');
  });

  it('rejects any output with address=null (non-standard output)', async () => {
    const gate = new PolicyGate({ allowedBtcRecipients: ['bc1pA'] });
    expect(
      await gate.approve(btcSpec([{ address: 'bc1pA', amountSat: 50n }, { address: null, amountSat: 0n }])),
    ).toBe('reject');
  });

  it('rejects when outputs missing', async () => {
    const gate = new PolicyGate({ allowedBtcRecipients: ['bc1pA'] });
    expect(
      await gate.approve(signingSpec({ operation: 'btc-transfer', outputs: undefined, amount: 0n, destination: undefined, method: undefined })),
    ).toBe('reject');
  });

  it('ignores opnet-call specs', async () => {
    const gate = new PolicyGate({ allowedBtcRecipients: ['bc1pA'] });
    expect(await gate.approve(signingSpec({ operation: 'opnet-call', outputs: undefined }))).toBe('approve');
  });
});

describe('PolicyGate — allowedContracts', () => {
  it('approves when contract destination in allowlist', async () => {
    const gate = new PolicyGate({ allowedContracts: ['0xabc'] });
    expect(
      await gate.approve(signingSpec({ operation: 'opnet-call', destination: '0xabc' })),
    ).toBe('approve');
  });

  it('rejects when destination not in allowlist', async () => {
    const gate = new PolicyGate({ allowedContracts: ['0xabc'] });
    expect(
      await gate.approve(signingSpec({ operation: 'opnet-call', destination: '0xdef' })),
    ).toBe('reject');
  });

  it('rejects when destination missing', async () => {
    const gate = new PolicyGate({ allowedContracts: ['0xabc'] });
    expect(
      await gate.approve(signingSpec({ operation: 'opnet-call', destination: undefined })),
    ).toBe('reject');
  });

  it('ignores btc-transfer specs', async () => {
    const gate = new PolicyGate({ allowedContracts: ['0xabc'] });
    expect(await gate.approve(signingSpec({ operation: 'btc-transfer' }))).toBe('approve');
  });
});

describe('PolicyGate — maxCeremoniesPerHour (sliding window)', () => {
  it('approves up to the cap, rejects the N+1th within the hour', async () => {
    let t = 1_700_000_000_000;
    const gate = new PolicyGate({ maxCeremoniesPerHour: 3 }, () => t);
    // All specs with distinct ceremonyIds so orchestrator-side cache is irrelevant here.
    for (let i = 0; i < 3; i++) {
      expect(await gate.approve(signingSpec({ ceremonyId: `c${i}` }))).toBe('approve');
      t += 100;
    }
    expect(await gate.approve(signingSpec({ ceremonyId: 'c3' }))).toBe('reject');
  });

  it('evicts old approvals past the 1h cutoff', async () => {
    let t = 1_700_000_000_000;
    const gate = new PolicyGate({ maxCeremoniesPerHour: 2 }, () => t);
    expect(await gate.approve(signingSpec({ ceremonyId: 'c0' }))).toBe('approve');
    expect(await gate.approve(signingSpec({ ceremonyId: 'c1' }))).toBe('approve');
    expect(await gate.approve(signingSpec({ ceremonyId: 'c2' }))).toBe('reject');
    // Advance 1h + 1ms → first approval falls outside the window.
    t += 60 * 60 * 1000 + 1;
    expect(await gate.approve(signingSpec({ ceremonyId: 'c3' }))).toBe('approve');
  });

  it('does NOT count DKG towards the signing rate limit', async () => {
    const gate = new PolicyGate({ maxCeremoniesPerHour: 1 });
    expect(await gate.approve(dkgSpec({ ceremonyId: 'dkg-0' }))).toBe('approve');
    expect(await gate.approve(dkgSpec({ ceremonyId: 'dkg-1' }))).toBe('approve');
    expect(await gate.approve(signingSpec({ ceremonyId: 'sig-0' }))).toBe('approve');
    expect(await gate.approve(signingSpec({ ceremonyId: 'sig-1' }))).toBe('reject');
  });

  it('does NOT record a timestamp on rejection (rate-limit slots only consumed by approvals)', async () => {
    let t = 1_700_000_000_000;
    // Rate-limit=2, but also destination_allowlist rejects.
    const gate = new PolicyGate(
      { maxCeremoniesPerHour: 2, destinationAllowlist: ['bc1pOK'] },
      () => t,
    );
    // 10 rejected attempts.
    for (let i = 0; i < 10; i++) {
      expect(await gate.approve(signingSpec({ ceremonyId: `bad${i}`, destination: 'bc1pBAD' }))).toBe('reject');
      t += 10;
    }
    // Slots still available.
    expect(await gate.approve(signingSpec({ ceremonyId: 'ok0', destination: 'bc1pOK' }))).toBe('approve');
    expect(await gate.approve(signingSpec({ ceremonyId: 'ok1', destination: 'bc1pOK' }))).toBe('approve');
    expect(await gate.approve(signingSpec({ ceremonyId: 'ok2', destination: 'bc1pOK' }))).toBe('reject');
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

  it('parses protocol-scoped rules + rate limit', () => {
    expect(
      parsePolicyParams({
        max_btc_per_tx: 100_000_000,
        allowed_btc_recipients: ['bc1p1'],
        allowed_contracts: ['0xabc'],
        max_ceremonies_per_hour: 10,
      }),
    ).toEqual({
      maxBtcPerTx: 100_000_000n,
      allowedBtcRecipients: ['bc1p1'],
      allowedContracts: ['0xabc'],
      maxCeremoniesPerHour: 10,
    });
  });

  it('accepts max_btc_per_tx as a decimal string', () => {
    expect(parsePolicyParams({ max_btc_per_tx: '2100000000000000' })).toEqual({
      maxBtcPerTx: 2_100_000_000_000_000n,
    });
  });

  it('rejects non-positive max_ceremonies_per_hour', () => {
    expect(() => parsePolicyParams({ max_ceremonies_per_hour: 0 })).toThrow(
      /gate\.max_ceremonies_per_hour.*>= 1/,
    );
    expect(() => parsePolicyParams({ max_ceremonies_per_hour: 1.5 })).toThrow(
      /gate\.max_ceremonies_per_hour.*positive integer/,
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
    for (const strategy of ['cli', 'queue'] as const) {
      const cfg: GateConfig = { strategy };
      expect(() => createGate(cfg)).toThrow(/not implemented yet/);
    }
  });

  it('propagates policy param errors at construction time', () => {
    expect(() =>
      createGate({ strategy: 'policy', params: { max_amount: -1 } }),
    ).toThrow(/gate\.max_amount.*must be >= 0/);
  });

  it('creates ExecGate for strategy="exec"', async () => {
    // approve via `node -e "… approve …"`. Fast (no human in loop), deterministic.
    const gate = createGate({
      strategy: 'exec',
      params: {
        command: [process.execPath, '-e', 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{if(!d)process.exit(1);process.stdout.write("approve\\n");process.exit(0);});'],
        timeout_sec: 10,
      },
    });
    expect(await gate.approve(signingSpec())).toBe('approve');
  });

  it('ExecGate returns reject when command prints "reject"', async () => {
    const gate = createGate({
      strategy: 'exec',
      params: {
        command: [process.execPath, '-e', 'process.stdin.resume();process.stdin.on("end",()=>{console.log("reject");process.exit(0)});'],
        timeout_sec: 10,
      },
    });
    expect(await gate.approve(signingSpec())).toBe('reject');
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
      expect(await gate.approve(signingSpec())).toBe('approve');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('WebhookGate throws on non-200 response', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('server down', { status: 503 });
    try {
      const gate = createGate({
        strategy: 'webhook',
        params: { url: 'http://approver.test/decide', timeout_sec: 5 },
      });
      await expect(gate.approve(signingSpec())).rejects.toThrow(/503/);
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

