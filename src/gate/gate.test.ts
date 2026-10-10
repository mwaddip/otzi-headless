import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../config/parse';
import { buildDkgSpec, buildSigningSpec, resolveLeaderId } from '../orchestrator/spec-builder';
import { NOOP_LOGGER, type Logger } from '../orchestrator/types';
import type { ProposalAnalysis } from '../otzi/lib/bitcoin';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecGate, serializeSpec } from './exec';
import { AutoGate, createGate } from './factory';
import { parsePolicyParams, PolicyGate } from './policy';
import type { CeremonyRole, DkgSpec, SigningSpec, SpecOutput } from './types';
import { parseWebhookParams } from './webhook';

/** A real local HTTP server for the webhook gate tests; `close()` drops open connections. */
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhook`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

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

describe('PolicyGate — allowed_recipients = "address-book"', () => {
  interface Captured {
    warnings: string[];
    logger: Logger;
  }

  function capture(): Captured {
    const warnings: string[] = [];
    return { warnings, logger: { ...NOOP_LOGGER, warn: (msg) => void warnings.push(msg) } };
  }

  const book = (addresses: string[]) => async () => addresses;

  it('address-book policy approves listed recipients and rejects others', async () => {
    const gate = new PolicyGate(
      { allowedRecipients: 'address-book' },
      { loadAddressBook: book([RECIPIENT_A, RECIPIENT_B]) },
    );
    expect(await gate.approve(signing({ recipient: RECIPIENT_A }))).toBe('approve');
    expect(await gate.approve(signing({ recipient: RECIPIENT_EVIL }))).toBe('reject');
    const mixed = signing({
      outputs: [
        { address: RECIPIENT_A, amount: 5_000, isChange: false },
        { address: RECIPIENT_B, amount: 6_000, isChange: false },
        { address: RECIPIENT_EVIL, amount: 1, isChange: false },
      ],
    });
    expect(await gate.approve(mixed)).toBe('reject');
    expect(await gate.approve(signing({ recipient: RECIPIENT_A.toUpperCase() }))).toBe('reject'); // exact string
  });

  it('ignores change outputs', async () => {
    const gate = new PolicyGate({ allowedRecipients: 'address-book' }, { loadAddressBook: book([RECIPIENT_A]) });
    expect(await gate.approve(signing({ recipient: RECIPIENT_A, change: 70_000 }))).toBe('approve');
    const consolidation = signing({ outputs: [{ address: VAULT, amount: 99_000, isChange: true }] });
    expect(await gate.approve(consolidation)).toBe('approve');
  });

  it('reads the book at each evaluation', async () => {
    let current = [RECIPIENT_A];
    let loads = 0;
    const gate = new PolicyGate(
      { allowedRecipients: 'address-book' },
      {
        loadAddressBook: async () => {
          loads++;
          return current;
        },
      },
    );
    expect(await gate.approve(signing({ recipient: RECIPIENT_B }))).toBe('reject');
    current = [RECIPIENT_A, RECIPIENT_B];
    expect(await gate.approve(signing({ recipient: RECIPIENT_B }))).toBe('approve');
    current = [];
    expect(await gate.approve(signing({ recipient: RECIPIENT_B }))).toBe('reject');
    expect(loads).toBe(3);
  });

  it('an empty book rejects every external output and still approves a change-only spec', async () => {
    const gate = new PolicyGate({ allowedRecipients: 'address-book' }, { loadAddressBook: book([]) });
    expect(await gate.approve(signing())).toBe('reject');
    expect(await gate.approve(signing({ outputs: [{ address: VAULT, amount: 99_000, isChange: true }] }))).toBe('approve');
  });

  it('address-book policy rejects when the book file is invalid, and logs the cause', async () => {
    const { warnings, logger } = capture();
    const gate = new PolicyGate(
      { allowedRecipients: 'address-book' },
      {
        loadAddressBook: async () => {
          throw new Error('address book /etc/otzi/address-book.otzi.json: Entry 2: duplicate address');
        },
        logger,
      },
    );
    expect(await gate.approve(signing({ recipient: RECIPIENT_A }))).toBe('reject');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Entry 2: duplicate address');
    expect(warnings[0]).toMatch(/address book/);
  });

  it('rejects when the book file is missing (the daemon loader throws ENOENT)', async () => {
    const { warnings, logger } = capture();
    const gate = new PolicyGate(
      { allowedRecipients: 'address-book' },
      {
        loadAddressBook: async () => {
          throw Object.assign(new Error("ENOENT: no such file or directory, access '/etc/otzi/address-book.otzi.json'"), {
            code: 'ENOENT',
          });
        },
        logger,
      },
    );
    expect(await gate.approve(signing())).toBe('reject');
    expect(warnings[0]).toContain('ENOENT');
  });

  it('a failed load rejects even a spec whose outputs are all change', async () => {
    const gate = new PolicyGate(
      { allowedRecipients: 'address-book' },
      {
        loadAddressBook: async () => {
          throw new Error('EACCES');
        },
      },
    );
    const consolidation = signing({ outputs: [{ address: VAULT, amount: 99_000, isChange: true }] });
    expect(await gate.approve(consolidation)).toBe('reject');
  });

  it('rejects, with a warning, when no address book loader was given', async () => {
    const { warnings, logger } = capture();
    const gate = new PolicyGate({ allowedRecipients: 'address-book' }, { logger });
    expect(await gate.approve(signing({ recipient: RECIPIENT_A }))).toBe('reject');
    const consolidation = signing({ outputs: [{ address: VAULT, amount: 99_000, isChange: true }] });
    expect(await gate.approve(consolidation)).toBe('reject');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/no address book loader/);
  });

  it('does not warn when the book loads', async () => {
    const { warnings, logger } = capture();
    const gate = new PolicyGate({ allowedRecipients: 'address-book' }, { loadAddressBook: book([RECIPIENT_A]), logger });
    expect(await gate.approve(signing({ recipient: RECIPIENT_A }))).toBe('approve');
    expect(await gate.approve(signing({ recipient: RECIPIENT_EVIL }))).toBe('reject');
    expect(warnings).toEqual([]);
  });

  it('never loads the book for a DKG spec or for an explicit address list', async () => {
    let loads = 0;
    const loadAddressBook = async () => {
      loads++;
      return [RECIPIENT_A];
    };
    const book1 = new PolicyGate({ allowedRecipients: 'address-book' }, { loadAddressBook });
    expect(await book1.approve(dkgSpec())).toBe('approve');
    const list = new PolicyGate({ allowedRecipients: [RECIPIENT_A] }, { loadAddressBook });
    expect(await list.approve(signing({ recipient: RECIPIENT_A }))).toBe('approve');
    expect(loads).toBe(0);
  });

  it('a failed load records nothing in the windows', async () => {
    let failing = true;
    const gate = new PolicyGate(
      { allowedRecipients: 'address-book', maxCeremoniesPerHour: 1, maxSatsPer24h: 100 },
      {
        loadAddressBook: async () => {
          if (failing) throw new Error('unreadable');
          return [RECIPIENT_A];
        },
      },
    );
    expect(await gate.approve(signing({ external: 100 }))).toBe('reject');
    failing = false;
    expect(await gate.approve(signing({ external: 100 }))).toBe('approve'); // neither window was consumed
    expect(await gate.approve(signing({ external: 1 }))).toBe('reject');
  });

  it('checks and records the windows in one synchronous section after the load', async () => {
    const gate = new PolicyGate(
      { allowedRecipients: 'address-book', maxSatsPer24h: 100_000 },
      {
        loadAddressBook: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return [RECIPIENT_A];
        },
      },
    );
    const decisions = await Promise.all([
      gate.approve(signing({ external: 60_000, ceremonyId: 'c-a' })),
      gate.approve(signing({ external: 60_000, ceremonyId: 'c-b' })),
      gate.approve(signing({ external: 40_000, ceremonyId: 'c-c' })),
    ]);
    expect(decisions).toEqual(['approve', 'reject', 'approve']);
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

    it('accepts the string "address-book"', () => {
      expect(parsePolicyParams({ allowed_recipients: 'address-book' })).toEqual({ allowedRecipients: 'address-book' });
    });

    it('rejects any other string, naming the key', () => {
      for (const bad of ['', 'address_book', 'Address-Book', ' address-book', 'any']) {
        expect(() => parsePolicyParams({ allowed_recipients: bad }), JSON.stringify(bad)).toThrow(ConfigError);
        expect(() => parsePolicyParams({ allowed_recipients: bad }), JSON.stringify(bad)).toThrow(
          /gate\.allowed_recipients.*"address-book"/,
        );
      }
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

  it('hands the address book loader and the logger to the PolicyGate', async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...NOOP_LOGGER, warn: (msg) => void warnings.push(msg) };
    const gate = createGate(
      { strategy: 'policy', params: { allowed_recipients: 'address-book' } },
      { loadAddressBook: async () => [RECIPIENT_A], logger },
    );
    expect(gate).toBeInstanceOf(PolicyGate);
    expect(await gate.approve(signing({ recipient: RECIPIENT_A }))).toBe('approve');
    expect(await gate.approve(signing({ recipient: RECIPIENT_EVIL }))).toBe('reject');
    expect(warnings).toEqual([]);

    const noBook = createGate({ strategy: 'policy', params: { allowed_recipients: 'address-book' } }, { logger });
    expect(await noBook.approve(signing({ recipient: RECIPIENT_A }))).toBe('reject');
    expect(warnings).toHaveLength(1);
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

  // setTimeout cannot hold more than 2147483647 ms; a longer delay fires at once. The gates
  // refuse such a timeout_sec at construction, naming gate.timeout_sec.
  it('ExecGate and WebhookGate accept timeout_sec up to the longest Node timer and refuse more', () => {
    const max = 2_147_483.647;
    expect(() => createGate({ strategy: 'exec', params: { command: ['/bin/true'], timeout_sec: max } })).not.toThrow();
    expect(() => createGate({ strategy: 'webhook', params: { url: 'https://x', timeout_sec: max } })).not.toThrow();
    for (const timeout_sec of [2_147_483.648, 86_400 * 365, Number.MAX_SAFE_INTEGER]) {
      expect(() => createGate({ strategy: 'exec', params: { command: ['/bin/true'], timeout_sec } }), `exec ${timeout_sec}`)
        .toThrow(/gate\.timeout_sec.*<= 2147483\.647.*longest Node\.js timer/);
      expect(() => createGate({ strategy: 'webhook', params: { url: 'https://x', timeout_sec } }), `webhook ${timeout_sec}`)
        .toThrow(/gate\.timeout_sec.*<= 2147483\.647.*longest Node\.js timer/);
    }
  });

  it('ExecGate at the largest timeout_sec runs to completion instead of timing out at once', async () => {
    const gate = createGate({
      strategy: 'exec',
      params: { command: [process.execPath, '-e', 'setTimeout(()=>process.stdout.write("approve\\n"),200)'], timeout_sec: 2_147_483.647 },
    });
    expect(await gate.approve(signing())).toBe('approve');
  });

  it('WebhookGate at the largest timeout_sec waits for a held response instead of timing out at once', async () => {
    const approver = await serve((_req, res) => {
      setTimeout(() => res.end(JSON.stringify({ decision: 'approve' })), 200);
    });
    try {
      const gate = createGate({ strategy: 'webhook', params: { url: approver.url, timeout_sec: 2_147_483.647 } });
      expect(await gate.approve(signing())).toBe('approve');
    } finally {
      await approver.close();
    }
  });

  it('creates WebhookGate for strategy="webhook" and returns the approver decision', async () => {
    const approver = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ decision: 'approve' }));
    });
    try {
      const gate = createGate({ strategy: 'webhook', params: { url: approver.url, timeout_sec: 5 } });
      expect(await gate.approve(signing())).toBe('approve');
    } finally {
      await approver.close();
    }
  });

  it('WebhookGate posts the signing spec as JSON with numeric sats', async () => {
    let seen: { method?: string; contentType?: string; authorization?: string; body?: string } = {};
    const approver = await serve(async (req, res) => {
      seen = {
        method: req.method,
        contentType: req.headers['content-type'],
        authorization: req.headers.authorization,
        body: await readRequestBody(req),
      };
      res.writeHead(200);
      res.end(JSON.stringify({ decision: 'reject' }));
    });
    try {
      const gate = createGate({ strategy: 'webhook', params: { url: approver.url, timeout_sec: 5 } });
      const spec = signing({ external: 50_000, change: 20_000 });
      expect(await gate.approve(spec)).toBe('reject');
      expect(seen.method).toBe('POST');
      expect(seen.contentType).toBe('application/json');
      expect(seen.authorization).toBeUndefined();
      expect(JSON.parse(seen.body!)).toEqual(spec);
      expect(typeof (JSON.parse(seen.body!) as SigningSpec).amount).toBe('number');
    } finally {
      await approver.close();
    }
  });

  it('WebhookGate sends the Bearer token read from the env at request time', async () => {
    let authorization: string | undefined;
    const approver = await serve((req, res) => {
      authorization = req.headers.authorization;
      res.end(JSON.stringify({ decision: 'approve' }));
    });
    const envName = 'OTZI_TEST_WEBHOOK_TOKEN';
    try {
      const gate = createGate({
        strategy: 'webhook',
        params: { url: approver.url, timeout_sec: 5, bearer_token_env: envName },
      });
      delete process.env[envName];
      await expect(gate.approve(signing())).rejects.toThrow(/OTZI_TEST_WEBHOOK_TOKEN.*empty or unset/);
      process.env[envName] = 's3cret';
      expect(await gate.approve(signing())).toBe('approve');
      expect(authorization).toBe('Bearer s3cret');
    } finally {
      delete process.env[envName];
      await approver.close();
    }
  });

  it('WebhookGate throws on non-200 response and names the status and body', async () => {
    const approver = await serve((_req, res) => {
      res.writeHead(503, 'Service Unavailable');
      res.end('server down');
    });
    try {
      const gate = createGate({ strategy: 'webhook', params: { url: approver.url, timeout_sec: 5 } });
      await expect(gate.approve(signing())).rejects.toThrow(/503 Service Unavailable — server down/);
    } finally {
      await approver.close();
    }
  });

  it('WebhookGate does not follow redirects', async () => {
    const approver = await serve((_req, res) => {
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });
    try {
      const gate = createGate({ strategy: 'webhook', params: { url: approver.url, timeout_sec: 5 } });
      await expect(gate.approve(signing())).rejects.toThrow(/302/);
    } finally {
      await approver.close();
    }
  });

  it('WebhookGate rejects a body that is not JSON or carries no valid decision', async () => {
    for (const [body, message] of [
      ['not json', /response is not JSON/],
      [JSON.stringify({ decision: 'maybe' }), /unexpected decision "maybe"/],
      [JSON.stringify({}), /unexpected decision undefined/],
      [JSON.stringify({ error: 'approver shutting down' }), /unexpected decision undefined/],
    ] as const) {
      const approver = await serve((_req, res) => {
        res.end(body);
      });
      try {
        const gate = createGate({ strategy: 'webhook', params: { url: approver.url, timeout_sec: 5 } });
        await expect(gate.approve(signing())).rejects.toThrow(message);
      } finally {
        await approver.close();
      }
    }
  });

  it('WebhookGate reports a refused connection as a failed request', async () => {
    const approver = await serve((_req, res) => {
      res.end();
    });
    const { url } = approver;
    await approver.close();
    const gate = createGate({ strategy: 'webhook', params: { url, timeout_sec: 5 } });
    await expect(gate.approve(signing())).rejects.toThrow(/WebhookGate: request failed/);
  });

  it('WebhookGate waits for an approver that holds the response, then returns its decision', async () => {
    const approver = await serve((_req, res) => {
      setTimeout(() => res.end(JSON.stringify({ decision: 'approve' })), 300);
    });
    try {
      const gate = createGate({ strategy: 'webhook', params: { url: approver.url, timeout_sec: 5 } });
      expect(await gate.approve(signing())).toBe('approve');
    } finally {
      await approver.close();
    }
  });

  // timeout_sec is one deadline for the whole request: connect, headers and the body read.
  // These pin the deadline against an approver that answers early but never finishes.
  describe('WebhookGate deadline', () => {
    async function expectsTimeout(handler: (req: IncomingMessage, res: ServerResponse) => void) {
      const approver = await serve(handler);
      try {
        const gate = createGate({ strategy: 'webhook', params: { url: approver.url, timeout_sec: 0.4 } });
        const started = Date.now();
        await expect(gate.approve(signing())).rejects.toThrow(/WebhookGate: timed out after 0\.4s/);
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(350);
        expect(elapsed).toBeLessThan(3_000);
      } finally {
        await approver.close();
      }
    }

    it('fires when the approver never answers', async () => {
      await expectsTimeout(() => {});
    });

    it('fires when the approver sends headers at once and never the body', async () => {
      await expectsTimeout((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
      });
    });

    it('fires when the approver sends headers at once and trickles whitespace', async () => {
      await expectsTimeout((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
        const timer = setInterval(() => res.write(' '), 50);
        res.on('close', () => clearInterval(timer));
      });
    });

    it('fires when the approver sends part of the body and stalls', async () => {
      await expectsTimeout((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"decision":');
      });
    });
  });

  it('WebhookGate fails when the connection drops in the middle of the body', async () => {
    const approver = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('{"decision":');
      setTimeout(() => res.destroy(), 50);
    });
    try {
      const gate = createGate({ strategy: 'webhook', params: { url: approver.url, timeout_sec: 5 } });
      await expect(gate.approve(signing())).rejects.toThrow(/WebhookGate: /);
    } finally {
      await approver.close();
    }
  });

  it('WebhookGate caps the response body so a hostile approver cannot exhaust memory', async () => {
    let sent = 0;
    const approver = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = ' '.repeat(16 * 1024);
      const timer = setInterval(() => {
        sent += chunk.length;
        res.write(chunk);
      }, 5);
      res.on('close', () => clearInterval(timer));
    });
    try {
      const gate = createGate({ strategy: 'webhook', params: { url: approver.url, timeout_sec: 10 } });
      await expect(gate.approve(signing())).rejects.toThrow(/response body exceeds 65536 bytes/);
      expect(sent).toBeLessThan(2 * 1024 * 1024);
    } finally {
      await approver.close();
    }
  });

  // http.request throws synchronously on a header value Node refuses (a token read from a CRLF
  // env file, a non-latin1 character). That must reject the call and leave no timer behind: a
  // leaked deadline timer would fire later inside the daemon process.
  it('WebhookGate rejects cleanly, with no timer left, when the request cannot be created', async () => {
    const envName = 'OTZI_TEST_WEBHOOK_BAD_TOKEN';
    const gate = createGate({
      strategy: 'webhook',
      params: { url: 'http://127.0.0.1:9/webhook', timeout_sec: 30, bearer_token_env: envName },
    });
    vi.useFakeTimers();
    try {
      for (const token of ['s3cret\r\n', 's3cret\r', 'sn\u2603wman']) {
        process.env[envName] = token;
        await expect(gate.approve(signing()), JSON.stringify(token))
          .rejects.toThrow(/WebhookGate: request failed: .*header/i);
        expect(vi.getTimerCount(), 'timers left after the rejection').toBe(0);
        // Past the deadline nothing fires (the old code threw a ReferenceError from the timer here).
        vi.advanceTimersByTime(60_000);
      }
    } finally {
      vi.useRealTimers();
      delete process.env[envName];
    }
  });

  it('WebhookGate rejects invalid params at construction', () => {
    expect(() => createGate({ strategy: 'webhook', params: { timeout_sec: 5 } }))
      .toThrow(/gate\.url/);
    expect(() => createGate({ strategy: 'webhook', params: { url: 'https://x', timeout_sec: 0 } }))
      .toThrow(/gate\.timeout_sec/);
    expect(() => createGate({ strategy: 'webhook', params: { url: 'https://x', timeout_sec: 5, bogus: true } }))
      .toThrow(/gate\.bogus/);
  });
});

describe('parseWebhookParams — url scheme', () => {
  it.each([
    'https://approver.example/otzi',
    'https://10.0.0.5:8443/decide',
    'http://127.0.0.1:8080/otzi',
    'http://127.12.0.9/otzi',
    'http://localhost:9000/',
    'http://LOCALHOST/',
    'http://[::1]:8080/otzi',
  ])('accepts %s', (url) => {
    expect(parseWebhookParams({ url, timeout_sec: 5 }).url).toBe(url);
  });

  it.each([
    'http://approver.example/otzi',
    'http://10.0.0.5:8080/decide',
    'http://192.168.1.10/',
    'http://[fe80::1]/',
    'http://localhost.evil.example/',
    'http://127.0.0.1.nip.io/',
  ])('refuses plain http to a non-loopback host: %s', (url) => {
    let err: unknown;
    try {
      parseWebhookParams({ url, timeout_sec: 5 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).path).toBe('gate.url');
    expect((err as Error).message).toMatch(/https/);
    expect((err as Error).message).toMatch(/loopback/);
  });

  it.each(['ftp://approver.example/', 'file:///tmp/x', 'not a url', 'https://'])('refuses %s', (url) => {
    expect(() => parseWebhookParams({ url, timeout_sec: 5 })).toThrow(/gate\.url/);
  });
});

describe('ExecGate — child process handling', () => {
  /** A signing spec whose JSON is well past a pipe buffer (64 KiB). */
  function hugeSpec(): SigningSpec {
    const outputs: SpecOutput[] = Array.from({ length: 800 }, (_, i) => ({
      address: `bc1q${String(i).padStart(38, '0')}`,
      amount: 1_000 + i,
      isChange: false,
      label: 'x'.repeat(40),
    }));
    return signing({ outputs });
  }

  it('a command that exits without reading a large spec decides; the daemon does not crash', async () => {
    expect(serializeSpec(hugeSpec()).length).toBeGreaterThan(64 * 1024);
    const escaped: unknown[] = [];
    const onEscape = (err: unknown) => escaped.push(err);
    process.on('uncaughtException', onEscape);
    process.on('unhandledRejection', onEscape);
    try {
      const gate = createGate({ strategy: 'exec', params: { command: ['sh', '-c', 'echo reject; exit 0'], timeout_sec: 10 } });
      for (let i = 0; i < 5; i++) await expect(gate.approve(hugeSpec())).resolves.toBe('reject');
      const approver = createGate({ strategy: 'exec', params: { command: ['sh', '-c', 'echo approve'], timeout_sec: 10 } });
      await expect(approver.approve(hugeSpec())).resolves.toBe('approve');
      await new Promise((r) => setTimeout(r, 50));
      expect(escaped).toEqual([]);
    } finally {
      process.off('uncaughtException', onEscape);
      process.off('unhandledRejection', onEscape);
    }
  }, 20_000);

  it("the command's environment lacks the share password variable", async () => {
    const name = 'OTZI_TEST_SHARE_PASSWORD';
    process.env[name] = 'pw-must-not-leak';
    try {
      const probe = `if [ -n "\${${name}+x}" ]; then echo reject; else echo approve; fi`;
      const gate = createGate(
        { strategy: 'exec', params: { command: ['sh', '-c', probe], timeout_sec: 10, env: { OTZI_TEST_OTHER: '1' } } },
        { secretEnv: [name] },
      );
      await expect(gate.approve(signing())).resolves.toBe('approve');
      // Other variables still reach it: the daemon environment and gate.env.
      const other = createGate(
        { strategy: 'exec', params: { command: ['sh', '-c', 'if [ "$OTZI_TEST_OTHER" = 1 ] && [ -n "$PATH" ]; then echo approve; else echo reject; fi'], timeout_sec: 10, env: { OTZI_TEST_OTHER: '1' } } },
        { secretEnv: [name] },
      );
      await expect(other.approve(signing())).resolves.toBe('approve');
    } finally {
      delete process.env[name];
    }
  }, 20_000);

  it('a command that ignores SIGTERM is killed after the grace period', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'exec-gate-'));
    try {
      const pidFile = join(dir, 'pid');
      const gate = new ExecGate({
        command: ['sh', '-c', `trap "" TERM; echo $$ > ${pidFile}; exec sleep 60`],
        timeoutSec: 0.3,
        killGraceMs: 200,
      });
      await expect(gate.approve(signing())).rejects.toThrow(/timed out after 0\.3s/);
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 10_000, interval: 25 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('a decision followed by a flood of output is read from the first line', async () => {
    const gate = createGate({
      strategy: 'exec',
      params: { command: ['sh', '-c', 'echo approve; head -c 3000000 /dev/zero | tr "\\0" x'], timeout_sec: 20 },
    });
    await expect(gate.approve(signing())).resolves.toBe('approve');
  }, 20_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
