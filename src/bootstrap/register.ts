/**
 * Member-side bootstrap.
 *
 * Runs the `register` side of the bootstrap exchange: POSTs this daemon's
 * identity pubkey to the master's `/register` endpoint and waits (long-poll)
 * for the complete pubkey book. Validates that the returned book contains
 * this node's own entry with the matching pubkey — if master silently
 * replaced it, the self-check catches it here (and the operator-eyeball
 * fingerprint comparison catches it across nodes).
 */

import type { PartyId } from '../core/types';
import type { IdentityKeyPair } from '../transport/identity';
import { toHex } from '../wire/hex';
import { NOOP_LOGGER, type Logger } from '../orchestrator/types';
import {
  computeFingerprint,
  parseBook,
  type PubkeyBook,
} from './pubkey-book';

export interface MemberRegisterInputs {
  self: { nodeId: string; partyId: PartyId; identity: IdentityKeyPair };
  /** Master URL (without path). E.g. `http://10.0.0.1:7090`. */
  masterUrl: string;
  /** Defaults to 30 min to match master. */
  timeoutMs?: number;
  logger?: Logger;
}

export interface MemberRegisterResult {
  book: PubkeyBook;
  fingerprint: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export async function runMemberRegister(
  input: MemberRegisterInputs,
): Promise<MemberRegisterResult> {
  const log = input.logger ?? NOOP_LOGGER;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const publicKeyHex = toHex(input.self.identity.publicKeyRaw);

  const url = `${input.masterUrl.replace(/\/+$/, '')}/register`;
  log.info('register: POST', { url, nodeId: input.self.nodeId, partyId: input.self.partyId });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        node_id: input.self.nodeId,
        party_id: input.self.partyId,
        public_key_hex: publicKeyHex,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === 'AbortError')
      throw new Error(`register: timed out after ${timeoutMs}ms waiting for master response`);
    throw new Error(`register: POST failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await res.text();
  if (!res.ok) {
    let errMsg = `register: master responded ${res.status}`;
    try {
      const json = JSON.parse(bodyText) as { error?: unknown };
      if (typeof json.error === 'string') errMsg += `: ${json.error}`;
    } catch {
      /* fall through */
    }
    throw new Error(errMsg);
  }

  let parsed: { book?: unknown; fingerprint?: unknown };
  try {
    parsed = JSON.parse(bodyText) as { book?: unknown; fingerprint?: unknown };
  } catch {
    throw new Error('register: master returned malformed JSON');
  }
  if (parsed.book === undefined)
    throw new Error("register: response missing 'book'");

  const book = parseBook(JSON.stringify(parsed.book));

  // Self-check: our own entry must match what we sent. Defends against a
  // compromised master substituting our pubkey — though the fingerprint
  // cross-check across nodes is the last-line defense.
  const self = book.entries.find((e) => e.nodeId === input.self.nodeId);
  if (!self)
    throw new Error(`register: returned book missing our own entry for '${input.self.nodeId}'`);
  if (self.partyId !== input.self.partyId)
    throw new Error(
      `register: book claims partyId ${self.partyId} for us; we are ${input.self.partyId}`,
    );
  if (self.publicKeyHex.toLowerCase() !== publicKeyHex.toLowerCase())
    throw new Error('register: master returned a different pubkey for us than we sent');

  const fingerprint = await computeFingerprint(book);
  if (typeof parsed.fingerprint === 'string' && parsed.fingerprint !== fingerprint) {
    // Master's advisory fingerprint disagrees with our computation — must not
    // silently accept. Either book or fingerprint has been tampered with.
    throw new Error(
      `register: local fingerprint ${fingerprint} disagrees with master-advertised ${parsed.fingerprint}`,
    );
  }

  log.info('register: book received', {
    entries: book.entries.length,
    fingerprint,
  });
  return { book, fingerprint };
}
