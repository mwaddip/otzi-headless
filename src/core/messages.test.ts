/**
 * Tests for the v2 ceremony control messages (facts/core.md, messages.ts).
 * Every rejection case is its own assertion; boundary values that must be
 * accepted are pinned alongside so a too-strict parser fails too.
 */

import { describe, it, expect } from 'vitest';
import {
  CEREMONY_ID_RE,
  MAX_INPUTS,
  encodeMessage,
  isCeremonyId,
  isProposalShape,
  parseMessage,
  type AnnounceDkg,
  type AnnounceSign,
  type CeremonyMessage,
  type SignoffAborted,
  type SignoffDone,
} from './messages';

const HEX64 = 'ab'.repeat(32);
const HEX128 = 'cd'.repeat(64);

function prevout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { txid: HEX64, vout: 1, amount: 50_000, script: '5120' + 'ef'.repeat(32), ...overrides };
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { network: 'signet', tx: '0200000001' + '00'.repeat(20), prevouts: [prevout()], ...overrides };
}

function announceDkg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 2,
    kind: 'announce-dkg',
    ceremonyId: 'dkg-1',
    sessionIdHex: HEX64,
    threshold: 2,
    parties: 3,
    network: 'testnet4',
    ...overrides,
  };
}

function announceSign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 2, kind: 'announce-sign', ceremonyId: 'sign:1', signers: [0, 1, 2], proposal: proposal(), ...overrides };
}

function signoffDone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 2, kind: 'signoff-done', ceremonyId: 'sign:1', signaturesHex: [HEX128], ...overrides };
}

function signoffAborted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 2, kind: 'signoff-aborted', ceremonyId: 'sign:1', reason: 'peer 2 dropped', ...overrides };
}

/** Encode an arbitrary JSON value the way the wire does (UTF-8 JSON). */
function raw(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Build an object lacking one key. */
function without(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = obj;
  return rest;
}

describe('constants', () => {
  it('CEREMONY_ID_RE and MAX_INPUTS match the contract', () => {
    expect(CEREMONY_ID_RE.source).toBe('^[A-Za-z0-9._:-]{1,128}$');
    expect(MAX_INPUTS).toBe(255);
  });
});

describe('round-trip', () => {
  const cases: Array<[string, CeremonyMessage]> = [
    ['announce-dkg', announceDkg() as unknown as AnnounceDkg],
    ['announce-sign', announceSign() as unknown as AnnounceSign],
    ['signoff-done', signoffDone() as unknown as SignoffDone],
    ['signoff-aborted with reason', signoffAborted() as unknown as SignoffAborted],
    ['signoff-aborted without reason', without(signoffAborted(), 'reason') as unknown as SignoffAborted],
  ];

  it.each(cases)('%s: parseMessage(encodeMessage(m)) deep-equals m', (_name, m) => {
    expect(parseMessage(encodeMessage(m))).toEqual(m);
  });

  it('encodeMessage emits UTF-8 JSON', () => {
    const m = announceDkg() as unknown as AnnounceDkg;
    const bytes = encodeMessage(m);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(m);
  });

  it('a multi-byte reason survives the round-trip', () => {
    const m = signoffAborted({ reason: 'abgebrochen: Überlauf \u{1F6AB}' }) as unknown as SignoffAborted;
    expect(parseMessage(encodeMessage(m))).toEqual(m);
  });
});

describe('parseMessage: envelope rejections', () => {
  it('rejects v: 1', () => {
    expect(parseMessage(raw(announceDkg({ v: 1 })))).toBeNull();
  });

  it('rejects a missing v', () => {
    expect(parseMessage(raw(without(announceDkg(), 'v')))).toBeNull();
  });

  it('rejects an unknown kind', () => {
    expect(parseMessage(raw(announceDkg({ kind: 'announce-frost' })))).toBeNull();
  });

  it('rejects the retired v1 kinds', () => {
    expect(parseMessage(raw({ v: 1, kind: 'announce', ceremonyId: 'x', baseCeremonyId: 'x', messageHex: '', signers: [0] }))).toBeNull();
  });

  it('rejects an extra key on announce-dkg', () => {
    expect(parseMessage(raw(announceDkg({ extra: 1 })))).toBeNull();
  });

  it('rejects an extra key on announce-sign', () => {
    expect(parseMessage(raw(announceSign({ extra: 1 })))).toBeNull();
  });

  it('rejects an extra key on signoff-done', () => {
    expect(parseMessage(raw(signoffDone({ extra: 1 })))).toBeNull();
  });

  it('rejects an extra key on signoff-aborted', () => {
    expect(parseMessage(raw(signoffAborted({ extra: 1 })))).toBeNull();
  });

  it('rejects a missing required key on each kind', () => {
    expect(parseMessage(raw(without(announceDkg(), 'network')))).toBeNull();
    expect(parseMessage(raw(without(announceSign(), 'proposal')))).toBeNull();
    expect(parseMessage(raw(without(signoffDone(), 'signaturesHex')))).toBeNull();
    expect(parseMessage(raw(without(signoffAborted(), 'ceremonyId')))).toBeNull();
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"announce-dkg"'],
    ['a number', '2'],
    ['malformed JSON', '{"v":2,'],
    ['empty input', ''],
  ])('rejects %s', (_name, text) => {
    expect(parseMessage(new TextEncoder().encode(text))).toBeNull();
  });

  it('rejects non-UTF-8 bytes', () => {
    expect(parseMessage(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull();
  });

  it('rejects non-UTF-8 bytes even when the rest is valid JSON', () => {
    const good = new TextEncoder().encode(JSON.stringify(signoffAborted({ reason: 'XX' })));
    const text = new TextDecoder().decode(good);
    const at = text.indexOf('XX');
    const bad = Uint8Array.from(good);
    bad[at] = 0xff; // lone 0xFF is never valid UTF-8
    expect(parseMessage(bad)).toBeNull();
  });

  it('does not throw on a __proto__ key', () => {
    const bytes = new TextEncoder().encode('{"v":2,"kind":"signoff-aborted","ceremonyId":"x","__proto__":{"a":1}}');
    expect(parseMessage(bytes)).toBeNull();
  });
});

describe('ceremonyId', () => {
  it.each([
    ['empty', ''],
    ['contains a space', 'a b'],
    ['contains #', 'x#1'],
    ['129 characters', 'a'.repeat(129)],
    ['contains a slash', 'a/b'],
    ['contains a newline', 'abc\n'],
    ['non-ASCII', 'café'],
  ])('rejects a ceremonyId that is %s (every kind)', (_name, id) => {
    expect(parseMessage(raw(announceDkg({ ceremonyId: id })))).toBeNull();
    expect(parseMessage(raw(announceSign({ ceremonyId: id })))).toBeNull();
    expect(parseMessage(raw(signoffDone({ ceremonyId: id })))).toBeNull();
    expect(parseMessage(raw(signoffAborted({ ceremonyId: id })))).toBeNull();
  });

  it('rejects a non-string ceremonyId', () => {
    expect(parseMessage(raw(announceDkg({ ceremonyId: 7 })))).toBeNull();
  });

  it('accepts a 128-character ceremonyId and the full allowed alphabet', () => {
    expect(parseMessage(raw(announceDkg({ ceremonyId: 'a'.repeat(128) })))).not.toBeNull();
    expect(parseMessage(raw(announceDkg({ ceremonyId: 'Az09._:-' })))).not.toBeNull();
  });

  it('isCeremonyId follows CEREMONY_ID_RE and rejects non-strings', () => {
    expect(isCeremonyId('dkg-1')).toBe(true);
    expect(isCeremonyId('a'.repeat(128))).toBe(true);
    expect(isCeremonyId('')).toBe(false);
    expect(isCeremonyId('x#1')).toBe(false);
    expect(isCeremonyId('a'.repeat(129))).toBe(false);
    expect(isCeremonyId(undefined)).toBe(false);
    expect(isCeremonyId(1)).toBe(false);
    expect(isCeremonyId(null)).toBe(false);
  });
});

describe('announce-dkg rules', () => {
  it('rejects threshold: 1', () => {
    expect(parseMessage(raw(announceDkg({ threshold: 1 })))).toBeNull();
  });

  it('rejects threshold: 0 and negative', () => {
    expect(parseMessage(raw(announceDkg({ threshold: 0 })))).toBeNull();
    expect(parseMessage(raw(announceDkg({ threshold: -2 })))).toBeNull();
  });

  it('rejects parties: 1', () => {
    expect(parseMessage(raw(announceDkg({ threshold: 2, parties: 1 })))).toBeNull();
  });

  it('rejects parties: 256', () => {
    expect(parseMessage(raw(announceDkg({ threshold: 2, parties: 256 })))).toBeNull();
  });

  it('rejects threshold > parties', () => {
    expect(parseMessage(raw(announceDkg({ threshold: 4, parties: 3 })))).toBeNull();
  });

  it('rejects non-integer or non-number threshold/parties', () => {
    expect(parseMessage(raw(announceDkg({ threshold: 2.5 })))).toBeNull();
    expect(parseMessage(raw(announceDkg({ parties: 3.5 })))).toBeNull();
    expect(parseMessage(raw(announceDkg({ threshold: '2' })))).toBeNull();
    expect(parseMessage(raw(announceDkg({ parties: '3' })))).toBeNull();
    expect(parseMessage(raw(announceDkg({ threshold: null })))).toBeNull();
  });

  it('accepts threshold === parties and the 2..255 bounds', () => {
    expect(parseMessage(raw(announceDkg({ threshold: 2, parties: 2 })))).not.toBeNull();
    expect(parseMessage(raw(announceDkg({ threshold: 255, parties: 255 })))).not.toBeNull();
    expect(parseMessage(raw(announceDkg({ threshold: 2, parties: 255 })))).not.toBeNull();
  });

  it("rejects network: 'testnet'", () => {
    expect(parseMessage(raw(announceDkg({ network: 'testnet' })))).toBeNull();
  });

  it('rejects a non-string network', () => {
    expect(parseMessage(raw(announceDkg({ network: 1 })))).toBeNull();
  });

  it('accepts each of the three networks', () => {
    for (const network of ['mainnet', 'testnet4', 'signet']) {
      expect(parseMessage(raw(announceDkg({ network })))).not.toBeNull();
    }
  });

  it.each([
    ['63 hex characters', 'a'.repeat(63)],
    ['65 hex characters', 'a'.repeat(65)],
    ['uppercase hex', 'AB'.repeat(32)],
    ['non-hex characters', 'g'.repeat(64)],
    ['empty', ''],
    ['a 0x prefix', '0x' + 'a'.repeat(62)],
  ])('rejects a sessionIdHex that is %s', (_name, sessionIdHex) => {
    expect(parseMessage(raw(announceDkg({ sessionIdHex })))).toBeNull();
  });

  it('rejects a non-string sessionIdHex', () => {
    expect(parseMessage(raw(announceDkg({ sessionIdHex: 12 })))).toBeNull();
  });
});

describe('announce-sign rules', () => {
  it('rejects signer 255', () => {
    expect(parseMessage(raw(announceSign({ signers: [0, 255] })))).toBeNull();
  });

  it('accepts signer 254 and 0', () => {
    expect(parseMessage(raw(announceSign({ signers: [0, 254] })))).not.toBeNull();
  });

  it('rejects an empty signers list', () => {
    expect(parseMessage(raw(announceSign({ signers: [] })))).toBeNull();
  });

  it('rejects 256 signers', () => {
    const signers = Array.from({ length: 256 }, (_, i) => i % 255);
    expect(parseMessage(raw(announceSign({ signers })))).toBeNull();
  });

  it('accepts 255 signers', () => {
    const signers = Array.from({ length: 255 }, (_, i) => i % 255);
    expect(parseMessage(raw(announceSign({ signers })))).not.toBeNull();
  });

  it('rejects negative, fractional and non-number signers', () => {
    expect(parseMessage(raw(announceSign({ signers: [-1] })))).toBeNull();
    expect(parseMessage(raw(announceSign({ signers: [1.5] })))).toBeNull();
    expect(parseMessage(raw(announceSign({ signers: ['1'] })))).toBeNull();
    expect(parseMessage(raw(announceSign({ signers: [null] })))).toBeNull();
  });

  it('rejects a non-array signers', () => {
    expect(parseMessage(raw(announceSign({ signers: 1 })))).toBeNull();
    expect(parseMessage(raw(announceSign({ signers: { 0: 1, length: 1 } })))).toBeNull();
  });

  it('does not check signer uniqueness (orchestrator concern)', () => {
    expect(parseMessage(raw(announceSign({ signers: [1, 1] })))).not.toBeNull();
  });

  it('rejects an invalid proposal', () => {
    expect(parseMessage(raw(announceSign({ proposal: proposal({ network: 'testnet' }) })))).toBeNull();
    expect(parseMessage(raw(announceSign({ proposal: 'tx' })))).toBeNull();
  });

  it('rejects 256 prevouts', () => {
    const prevouts = Array.from({ length: 256 }, () => prevout());
    expect(parseMessage(raw(announceSign({ proposal: proposal({ prevouts }) })))).toBeNull();
  });

  it('accepts 255 prevouts', () => {
    const prevouts = Array.from({ length: 255 }, () => prevout());
    expect(parseMessage(raw(announceSign({ proposal: proposal({ prevouts }) })))).not.toBeNull();
  });

  it('rejects an uppercase txid', () => {
    const prevouts = [prevout({ txid: 'AB'.repeat(32) })];
    expect(parseMessage(raw(announceSign({ proposal: proposal({ prevouts }) })))).toBeNull();
  });
});

describe('isProposalShape', () => {
  it('accepts a well-formed proposal', () => {
    expect(isProposalShape(proposal())).toBe(true);
  });

  it('accepts the boundary values (vout 0, amount 0, MAX_SAFE_INTEGER)', () => {
    expect(isProposalShape(proposal({ prevouts: [prevout({ vout: 0, amount: 0 })] }))).toBe(true);
    expect(
      isProposalShape(proposal({ prevouts: [prevout({ vout: Number.MAX_SAFE_INTEGER, amount: Number.MAX_SAFE_INTEGER })] })),
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'proposal'],
    ['an array', []],
  ])('rejects %s', (_name, p) => {
    expect(isProposalShape(p)).toBe(false);
  });

  it('rejects an extra top-level key', () => {
    expect(isProposalShape(proposal({ fee: 1 }))).toBe(false);
  });

  it('rejects each missing top-level key', () => {
    expect(isProposalShape(without(proposal(), 'network'))).toBe(false);
    expect(isProposalShape(without(proposal(), 'tx'))).toBe(false);
    expect(isProposalShape(without(proposal(), 'prevouts'))).toBe(false);
  });

  it('rejects a bad network', () => {
    expect(isProposalShape(proposal({ network: 'testnet' }))).toBe(false);
    expect(isProposalShape(proposal({ network: undefined }))).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['odd length', 'abc'],
    ['uppercase', 'AB'],
    ['non-hex', 'zz'],
    ['0x-prefixed', '0xab'],
  ])('rejects a tx that is %s', (_name, tx) => {
    expect(isProposalShape(proposal({ tx }))).toBe(false);
  });

  it('rejects a non-string tx', () => {
    expect(isProposalShape(proposal({ tx: 12 }))).toBe(false);
  });

  it('rejects empty and non-array prevouts', () => {
    expect(isProposalShape(proposal({ prevouts: [] }))).toBe(false);
    expect(isProposalShape(proposal({ prevouts: prevout() }))).toBe(false);
  });

  it('rejects 256 prevouts', () => {
    expect(isProposalShape(proposal({ prevouts: Array.from({ length: 256 }, () => prevout()) }))).toBe(false);
  });

  it('rejects a non-object prevout entry', () => {
    expect(isProposalShape(proposal({ prevouts: [null] }))).toBe(false);
    expect(isProposalShape(proposal({ prevouts: ['x'] }))).toBe(false);
    expect(isProposalShape(proposal({ prevouts: [[]] }))).toBe(false);
  });

  it('rejects an extra prevout key', () => {
    expect(isProposalShape(proposal({ prevouts: [prevout({ extra: 1 })] }))).toBe(false);
  });

  it('rejects each missing prevout key', () => {
    for (const key of ['txid', 'vout', 'amount', 'script']) {
      expect(isProposalShape(proposal({ prevouts: [without(prevout(), key)] }))).toBe(false);
    }
  });

  it.each([
    ['uppercase', 'AB'.repeat(32)],
    ['63 characters', 'a'.repeat(63)],
    ['65 characters', 'a'.repeat(65)],
    ['non-hex', 'g'.repeat(64)],
    ['numeric', 1],
  ])('rejects a txid that is %s', (_name, txid) => {
    expect(isProposalShape(proposal({ prevouts: [prevout({ txid })] }))).toBe(false);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['beyond the safe range', Number.MAX_SAFE_INTEGER + 1],
    ['a string', '1'],
    ['null', null],
  ])('rejects a vout that is %s', (_name, vout) => {
    expect(isProposalShape(proposal({ prevouts: [prevout({ vout })] }))).toBe(false);
  });

  it.each([
    ['negative', -1],
    ['fractional', 0.5],
    ['beyond the safe range', Number.MAX_SAFE_INTEGER + 1],
    ['a string', '50000'],
    ['null', null],
  ])('rejects an amount that is %s', (_name, amount) => {
    expect(isProposalShape(proposal({ prevouts: [prevout({ amount })] }))).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['odd length', '512'],
    ['uppercase', 'AB'],
    ['non-hex', 'zz'],
    ['numeric', 1],
  ])('rejects a script that is %s', (_name, script) => {
    expect(isProposalShape(proposal({ prevouts: [prevout({ script })] }))).toBe(false);
  });
});

describe('signoff-done rules', () => {
  it('rejects a 127-character signature', () => {
    expect(parseMessage(raw(signoffDone({ signaturesHex: ['a'.repeat(127)] })))).toBeNull();
  });

  it('rejects a 129-character signature', () => {
    expect(parseMessage(raw(signoffDone({ signaturesHex: ['a'.repeat(129)] })))).toBeNull();
  });

  it('rejects an uppercase signature', () => {
    expect(parseMessage(raw(signoffDone({ signaturesHex: ['AB'.repeat(64)] })))).toBeNull();
  });

  it('rejects a non-hex or non-string signature', () => {
    expect(parseMessage(raw(signoffDone({ signaturesHex: ['g'.repeat(128)] })))).toBeNull();
    expect(parseMessage(raw(signoffDone({ signaturesHex: [5] })))).toBeNull();
  });

  it('rejects one bad signature among good ones', () => {
    expect(parseMessage(raw(signoffDone({ signaturesHex: [HEX128, 'a'.repeat(127)] })))).toBeNull();
  });

  it('rejects an empty signaturesHex', () => {
    expect(parseMessage(raw(signoffDone({ signaturesHex: [] })))).toBeNull();
  });

  it('rejects 256 signatures', () => {
    expect(parseMessage(raw(signoffDone({ signaturesHex: Array.from({ length: 256 }, () => HEX128) })))).toBeNull();
  });

  it('accepts 255 signatures', () => {
    expect(parseMessage(raw(signoffDone({ signaturesHex: Array.from({ length: 255 }, () => HEX128) })))).not.toBeNull();
  });

  it('rejects a non-array signaturesHex', () => {
    expect(parseMessage(raw(signoffDone({ signaturesHex: HEX128 })))).toBeNull();
  });
});

describe('signoff-aborted rules', () => {
  it('accepts a 1024-character reason and the empty reason', () => {
    expect(parseMessage(raw(signoffAborted({ reason: 'r'.repeat(1024) })))).not.toBeNull();
    expect(parseMessage(raw(signoffAborted({ reason: '' })))).not.toBeNull();
  });

  it('rejects a 1025-character reason', () => {
    expect(parseMessage(raw(signoffAborted({ reason: 'r'.repeat(1025) })))).toBeNull();
  });

  it('rejects a non-string reason', () => {
    expect(parseMessage(raw(signoffAborted({ reason: 5 })))).toBeNull();
    expect(parseMessage(raw(signoffAborted({ reason: null })))).toBeNull();
  });

  it('accepts the message with no reason key', () => {
    expect(parseMessage(raw(without(signoffAborted(), 'reason')))).toEqual({
      v: 2,
      kind: 'signoff-aborted',
      ceremonyId: 'sign:1',
    });
  });
});

describe('optional-key scope', () => {
  it('reason is accepted only on signoff-aborted', () => {
    expect(parseMessage(raw(announceDkg({ reason: 'x' })))).toBeNull();
    expect(parseMessage(raw(announceSign({ reason: 'x' })))).toBeNull();
    expect(parseMessage(raw(signoffDone({ reason: 'x' })))).toBeNull();
  });
});
