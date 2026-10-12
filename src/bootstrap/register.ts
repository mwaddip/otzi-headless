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
import {
  BOOTSTRAP_FULL_ERROR,
  ENDPOINT_IN_RELAY_ERROR,
  ENDPOINT_MISSING_ERROR,
} from './master';
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
  "setup: bootstrap is full — another party registered in this node's place, or the leader's [bootstrap] parties is lower than the number of nodes; abort, delete pubkeys.json on every node, check the leader's parties, and redo setup with the bootstrap port reachable only by the members";
/** Connection-level failures that mean nothing is accepting registrations at the leader URL. */
const NOT_LISTENING_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET']);
const NOT_LISTENING_HINT =
  'the leader is not accepting registrations — it may not be started yet, or setup already completed without this node; if the leader has finished, compare key ids with the other operators, and if one is unknown delete pubkeys.json on every node and redo setup';

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
    const message = err instanceof Error ? err.message : String(err);
    // fetch reports `fetch failed` and hides the socket error's code in `cause`.
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    if (typeof code === 'string' && NOT_LISTENING_CODES.has(code))
      throw new Error(`register: POST failed: ${message} (${code}); ${NOT_LISTENING_HINT}`);
    throw new Error(`register: POST failed: ${message}`);
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
    const relayMember = sentEndpoint === undefined;
    if (res.status === 400 && relayMember && leaderError === ENDPOINT_MISSING_ERROR)
      throw new Error(RELAY_MEMBER_PEER_MESH_LEADER);
    if (res.status === 400 && !relayMember && leaderError === ENDPOINT_IN_RELAY_ERROR)
      throw new Error(PEER_MESH_MEMBER_RELAY_LEADER);
    if (res.status === 409 && leaderError === BOOTSTRAP_FULL_ERROR) throw new Error(BOOTSTRAP_FULL);
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
