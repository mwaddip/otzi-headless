import { describe, expect, it } from 'vitest';
import { CEREMONY_ID_RE } from '../core/messages';
import type { PartyId } from '../core/types';
import type { SendProposal } from '../otzi/lib/vault-types';
import {
  defaultCeremonyId,
  parseDkgRequest,
  parseProposal,
  parseSignRequest,
  parseVaultInfoRequest,
  RequestError,
} from './api';

const RING = { partyIds: [2, 0, 1] as PartyId[], self: 1, minSigners: 2 };

function prevout(i: number) {
  return { txid: i.toString(16).padStart(64, '0'), vout: i, amount: 1_000 + i, script: `5120${'ab'.repeat(32)}` };
}

function proposal(inputs = 1): SendProposal {
  return { network: 'testnet4', tx: '0200000001ab', prevouts: Array.from({ length: inputs }, (_, i) => prevout(i)) };
}

/** The `RequestError` `fn` throws; fails the test when it throws anything else or nothing. */
function requestError(fn: () => unknown): RequestError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RequestError);
    return err as RequestError;
  }
  throw new Error('expected a RequestError');
}

function signError(body: Record<string, unknown>): { status: number; message: string } {
  const err = requestError(() => parseSignRequest({ op: 'sign', proposal: proposal(), ...body }, RING));
  return { status: err.status, message: err.message };
}

describe('defaultCeremonyId', () => {
  it('is <op>-<uuid> and a valid ceremony id', () => {
    for (const op of ['dkg', 'sign'] as const) {
      const id = defaultCeremonyId(op);
      expect(id).toMatch(new RegExp(`^${op}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`));
      expect(CEREMONY_ID_RE.test(id)).toBe(true);
    }
    expect(defaultCeremonyId('sign')).not.toBe(defaultCeremonyId('sign'));
  });
});

describe('parseVaultInfoRequest', () => {
  it('takes only op', () => {
    expect(() => parseVaultInfoRequest({ op: 'vault-info' })).not.toThrow();
    const err = requestError(() => parseVaultInfoRequest({ op: 'vault-info', json: true }));
    expect(err).toMatchObject({ status: 400, message: "unknown field 'json'" });
  });
});

describe('parseDkgRequest', () => {
  it('takes a given ceremonyId and generates one when absent', () => {
    expect(parseDkgRequest({ op: 'dkg', ceremonyId: 'gen.1:a-b_c' })).toEqual({ ceremonyId: 'gen.1:a-b_c' });
    expect(parseDkgRequest({ op: 'dkg' }).ceremonyId).toMatch(/^dkg-/);
  });

  it('rejects unknown fields and bad ceremonyIds', () => {
    const unknown = requestError(() => parseDkgRequest({ op: 'dkg', threshold: 2 }));
    expect(unknown.status).toBe(400);
    expect(unknown.message).toBe("unknown field 'threshold'");
    for (const ceremonyId of ['', 'has space', 'x'.repeat(129), 7, 'slash/no']) {
      const err = requestError(() => parseDkgRequest({ op: 'dkg', ceremonyId }));
      expect(err.status).toBe(400);
      expect(err.message).toBe('ceremonyId must match ^[A-Za-z0-9._:-]{1,128}$');
    }
  });
});

describe('parseSignRequest', () => {
  it('defaults the ceremonyId and signers to every ring member, ascending', () => {
    const req = parseSignRequest({ op: 'sign', proposal: proposal() }, RING);
    expect(req.ceremonyId).toMatch(/^sign-/);
    expect(req.signers).toEqual([0, 1, 2]);
    expect(req.proposal).toEqual(proposal());
  });

  it('takes an explicit ceremonyId and signer set', () => {
    const req = parseSignRequest({ op: 'sign', ceremonyId: 'pay-42', signers: [1, 2], proposal: proposal() }, RING);
    expect(req).toEqual({ ceremonyId: 'pay-42', signers: [1, 2], proposal: proposal() });
  });

  it('rejects unknown fields, bad ceremonyIds and bad signer sets', () => {
    expect(signError({ scheme: 'frost' })).toEqual({ status: 400, message: "unknown field 'scheme'" });
    expect(signError({ ceremonyId: 'no spaces' })).toEqual({
      status: 400,
      message: 'ceremonyId must match ^[A-Za-z0-9._:-]{1,128}$',
    });
    for (const signers of ['0,1', [0, '1'], [0, 1.5], {}, [0, null]]) {
      expect(signError({ signers })).toEqual({ status: 400, message: 'signers must be an array of party ids' });
    }
    expect(signError({ signers: [1, 2, 1] })).toEqual({ status: 400, message: 'signers must be unique' });
    expect(signError({ signers: [1, 3] })).toEqual({ status: 400, message: 'signer 3 is not in the ring' });
    expect(signError({ signers: [0, 2] })).toEqual({ status: 400, message: 'signers must include this node (party 1)' });
    expect(signError({ signers: [1] })).toEqual({ status: 400, message: 'signers needs at least 2 entries, got 1' });
  });

  it('rejects a missing or malformed proposal', () => {
    const notAnObject = 'proposal must be an object with string tx and array prevouts';
    const err = requestError(() => parseSignRequest({ op: 'sign' }, RING));
    expect(err.status).toBe(400);
    expect(err.message).toBe(notAnObject);
    for (const p of [null, [], 'tx', { network: 'testnet4', tx: 5, prevouts: [] }, { network: 'testnet4', tx: 'ab' }]) {
      expect(signError({ proposal: p })).toEqual({ status: 400, message: notAnObject });
    }
    const shape = 'proposal does not have the expected shape { network, tx, prevouts: [{ txid, vout, amount, script }] }';
    const bad: unknown[] = [
      { ...proposal(), network: 'regtest' },
      { ...proposal(), tx: 'abc' },
      { ...proposal(), prevouts: [] },
      { ...proposal(), prevouts: [{ ...prevout(0), vout: -1 }] },
      { ...proposal(), prevouts: [{ ...prevout(0), extra: 1 }] },
      { ...proposal(), fee: 1 },
    ];
    for (const p of bad) expect(signError({ proposal: p })).toEqual({ status: 400, message: shape });
  });

  it('rejects more than 255 inputs', () => {
    expect(parseSignRequest({ op: 'sign', proposal: proposal(255) }, RING).proposal.prevouts).toHaveLength(255);
    expect(signError({ proposal: proposal(256) })).toEqual({
      status: 400,
      message: 'proposal has 256 inputs; at most 255 fit in one transaction',
    });
  });

  it('lowercases proposal hex before shape checks', () => {
    const lower = proposal(2);
    const upper = {
      ...lower,
      tx: lower.tx.toUpperCase(),
      prevouts: lower.prevouts.map(p => ({ ...p, script: p.script.toUpperCase() })),
    };
    upper.prevouts[1]!.txid = 'AB'.repeat(32);
    lower.prevouts[1]!.txid = 'ab'.repeat(32);
    const body = { op: 'sign', proposal: upper };
    const req = parseSignRequest(body, RING);
    expect(req.proposal).toEqual(lower);
    // The request body itself is left as sent.
    expect(upper.tx).toBe(lower.tx.toUpperCase());
    expect(upper.prevouts[1]!.txid).toBe('AB'.repeat(32));
  });
});

describe('parseProposal', () => {
  it('applies the sign op proposal rules to untrusted JSON (otzi btc sign)', () => {
    expect(parseProposal(proposal(2))).toEqual(proposal(2));
    expect(requestError(() => parseProposal({ network: 'testnet4' })).message).toBe(
      'proposal must be an object with string tx and array prevouts',
    );
    expect(requestError(() => parseProposal(proposal(256))).message).toBe(
      'proposal has 256 inputs; at most 255 fit in one transaction',
    );
    expect(requestError(() => parseProposal({ ...proposal(), fee: 1 })).status).toBe(400);
  });
});
