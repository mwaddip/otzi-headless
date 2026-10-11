/**
 * Member-side bootstrap.
 *
 * POSTs `{ public_key_hex, advertised_endpoint }` (peer-mesh) or
 * `{ public_key_hex }` (relay) to the master's `/register` endpoint and waits
 * (long-poll) for the complete pubkey book. Validates that the returned book
 * contains this leaf's own entry (matched by pubkey) and that the entry's
 * endpoint is what this leaf registered: the same string under peer-mesh,
 * none under relay. Maps the leader's transport-mismatch and
 * `bootstrap is full` refusals to operator instructions.
 */

import type { IdentityKeyPair } from '../transport/identity';
import { toHex } from '../otzi/lib/hex';
import { NOOP_LOGGER, type Logger } from '../orchestrator/types';
import {
  computeFingerprint,
  parseBook,
  type PubkeyBook,
} from './pubkey-book';

export interface MemberRegisterInputs {
  self: {
    identity: IdentityKeyPair;
    /**
     * Peer-mesh: this node's endpoint, canonical `host:port` form. Relay:
     * absent — no endpoint is sent, and the book must give this node none.
     */
    advertisedEndpoint?: string;
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

const RELAY_MEMBER_PEER_MESH_LEADER =
  'setup: the leader expects peer-mesh registrations (an advertised endpoint); this node is configured for relay — use the same transport on every node';
const PEER_MESH_MEMBER_RELAY_LEADER =
  'setup: the leader expects relay registrations (no advertised endpoint); this node is configured for peer-mesh — use the same transport on every node';
const BOOTSTRAP_FULL =
  "setup: bootstrap is full — another party registered in this node's place; abort, delete pubkeys.json on every node and redo setup with the bootstrap port reachable only by the members";

export async function runMemberRegister(
  input: MemberRegisterInputs,
): Promise<MemberRegisterResult> {
  const log = input.logger ?? NOOP_LOGGER;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const publicKeyHex = toHex(input.self.identity.publicKeyRaw);
  /** Peer-mesh when set; relay when undefined. */
  const sentEndpoint = input.self.advertisedEndpoint;

  const url = `${input.masterUrl.replace(/\/+$/, '')}/register`;
  log.info('register: POST', { url, advertisedEndpoint: sentEndpoint ?? '(none: relay)' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        public_key_hex: publicKeyHex,
        ...(sentEndpoint !== undefined ? { advertised_endpoint: sentEndpoint } : {}),
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
    let leaderError: string | undefined;
    try {
      const json = JSON.parse(bodyText) as { error?: unknown };
      if (typeof json.error === 'string') leaderError = json.error;
    } catch {
      /* fall through */
    }
    // Error strings sent by master.ts.
    const relayMember = sentEndpoint === undefined;
    if (
      res.status === 400 &&
      relayMember &&
      leaderError?.startsWith("'advertised_endpoint' missing")
    )
      throw new Error(RELAY_MEMBER_PEER_MESH_LEADER);
    if (
      res.status === 400 &&
      !relayMember &&
      leaderError === "'advertised_endpoint' not used in relay mode"
    )
      throw new Error(PEER_MESH_MEMBER_RELAY_LEADER);
    if (res.status === 409 && leaderError === 'bootstrap is full') throw new Error(BOOTSTRAP_FULL);
    throw new Error(
      `register: master responded ${res.status}${leaderError !== undefined ? `: ${leaderError}` : ''}`,
    );
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
  // Own endpoint, by mode: none under relay, the one we sent under peer-mesh.
  if (sentEndpoint === undefined) {
    if (self.advertisedEndpoint !== undefined)
      throw new Error(
        `register: the leader's book gives this node advertisedEndpoint='${self.advertisedEndpoint}'; a relay node registers none`,
      );
  } else if (self.advertisedEndpoint === undefined) {
    throw new Error(
      `register: the leader's book has no advertisedEndpoint for this node; it registered '${sentEndpoint}'`,
    );
  } else if (self.advertisedEndpoint !== sentEndpoint) {
    throw new Error(
      `register: master returned advertisedEndpoint='${self.advertisedEndpoint}' != ours='${sentEndpoint}'`,
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
