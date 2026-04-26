/**
 * `PeerAllowlist` — L4 source-IP filter for peer-mesh inbound connections.
 *
 * Cryptographic auth (Noise-KK + ML-DSA pubkey book) is the primary line of
 * defense; this filter is *additional*, dropping random scanners before they
 * reach the handshake. Defense-in-depth, not a replacement for crypto.
 *
 * Usage:
 *   - Construct from the configured peer list at transport startup.
 *   - `await resolve()` once before the WS server starts listening — fails
 *     fast if any endpoint hostname can't be resolved.
 *   - On each inbound connection, `has(req.socket.remoteAddress)` decides
 *     whether to proceed or silently destroy the socket.
 *
 * `refresh()` is exposed for future periodic re-resolution; B.1 only calls
 * `resolve()` once at startup.
 *
 * IPv4-mapped IPv6 normalization: when a Node WS server binds to `::`, an
 * inbound IPv4 connection arrives with `remoteAddress` like
 * `::ffff:127.0.0.1`. `has()` strips the prefix before comparing.
 */

import { lookup } from 'node:dns/promises';
import type { Logger } from '../../orchestrator/types';

export interface AllowlistPeer {
  partyId: number;
  /** `ws://host:port`. Optional — relay-only peers have no endpoint and are skipped. */
  endpoint?: string;
}

const IPV4_MAPPED_PREFIX = '::ffff:';

export class PeerAllowlist {
  private readonly peers: ReadonlyArray<AllowlistPeer>;
  private readonly log: Logger;
  private readonly ips = new Set<string>();

  constructor(peers: ReadonlyArray<AllowlistPeer>, logger: Logger) {
    this.peers = peers;
    this.log = logger;
  }

  /**
   * DNS-resolves every peer's endpoint host into the internal IP set.
   * Throws on first unresolvable host so the daemon refuses to start with a
   * misconfigured peer list rather than silently letting nothing in.
   */
  async resolve(): Promise<void> {
    const next = await this.resolveAll();
    this.ips.clear();
    for (const ip of next) this.ips.add(ip);
  }

  /**
   * Re-resolves all hostnames; logs at info level if the IP set changed.
   * Errors propagate — the caller decides whether a transient DNS failure
   * means "keep the old set" or "start dropping everything".
   */
  async refresh(): Promise<void> {
    const next = await this.resolveAll();
    const before = new Set(this.ips);
    const after = new Set(next);
    const changed =
      before.size !== after.size || [...after].some((ip) => !before.has(ip));
    if (changed) {
      this.ips.clear();
      for (const ip of after) this.ips.add(ip);
      this.log.info('peer-allowlist: membership changed', {
        added: [...after].filter((ip) => !before.has(ip)),
        removed: [...before].filter((ip) => !after.has(ip)),
      });
    }
  }

  /**
   * Returns true iff `ip` is in the set. Strips the IPv4-mapped IPv6 prefix
   * before comparing so `::ffff:127.0.0.1` matches a stored `127.0.0.1`.
   */
  has(ip: string): boolean {
    return this.ips.has(normalize(ip));
  }

  private async resolveAll(): Promise<string[]> {
    const out: string[] = [];
    for (const peer of this.peers) {
      if (!peer.endpoint) continue;
      const host = parseHost(peer.endpoint);
      if (!host) {
        throw new Error(
          `peer-allowlist: peer partyId=${peer.partyId} has unparseable endpoint '${peer.endpoint}'`,
        );
      }
      let results: Array<{ address: string; family: number }>;
      try {
        results = await lookup(host, { all: true, family: 0 });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `peer-allowlist: DNS lookup failed for peer partyId=${peer.partyId} host='${host}': ${reason}`,
        );
      }
      for (const r of results) out.push(normalize(r.address));
    }
    return out;
  }
}

function normalize(ip: string): string {
  if (ip.startsWith(IPV4_MAPPED_PREFIX)) return ip.slice(IPV4_MAPPED_PREFIX.length);
  return ip;
}

function parseHost(endpoint: string): string | null {
  // Endpoint shape: ws://host:port or wss://host:port
  // Use URL for robust parsing (handles bracketed IPv6).
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  if (!url.hostname) return null;
  // Node's URL keeps brackets on IPv6 literals (`[::1]`); strip them so dns
  // lookup gets the bare address form.
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
}
