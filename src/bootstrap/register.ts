/**
 * Member-side bootstrap.
 *
 * POSTs `{ public_key_hex, advertised_endpoint }` to the master's `/register`
 * endpoint and waits (long-poll) for the complete pubkey book. Validates that
 * the returned book contains this leaf's own entry (matched by pubkey) and
 * that the entry's advertisedEndpoint round-trips unchanged.
 */

import type { IdentityKeyPair } from '../transport/identity';
import { toHex } from '../wire/hex';
import { NOOP_LOGGER, type Logger } from '../orchestrator/types';
import {
  computeFingerprint,
  parseBook,
  type PubkeyBook,
} from './pubkey-book';

export interface MemberRegisterInputs {
  self: {
    identity: IdentityKeyPair;
    /** Canonical `host:port` form. */
    advertisedEndpoint: string;
  };
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
  log.info('register: POST', {
    url,
    advertisedEndpoint: input.self.advertisedEndpoint,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        public_key_hex: publicKeyHex,
        advertised_endpoint: input.self.advertisedEndpoint,
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

  // Self-check: own entry identified by pubkey match.
  const self = book.entries.find(
    (e) => e.publicKeyHex.toLowerCase() === publicKeyHex.toLowerCase(),
  );
  if (!self)
    throw new Error('register: returned book missing our own pubkey entry');
  if (self.advertisedEndpoint !== input.self.advertisedEndpoint) {
    throw new Error(
      `register: master returned advertisedEndpoint='${self.advertisedEndpoint}' != ours='${input.self.advertisedEndpoint}'`,
    );
  }

  const fingerprint = await computeFingerprint(book);
  if (typeof parsed.fingerprint === 'string' && parsed.fingerprint !== fingerprint) {
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
