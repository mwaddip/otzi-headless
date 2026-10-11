import { BlockList, isIP } from 'node:net';

/**
 * Canonical endpoint form used everywhere endpoints cross peers (bootstrap
 * wire, config parse, transport-factory cross-checks, fixtures).
 *
 * Accepts `host`, `host:port`, IPv4 literal, hostname, `[v6]`, `[v6]:port`.
 *
 * Returns canonical `host:port` where:
 *  - hostname / IPv6 hex are lowercased
 *  - IPv6 is bracketed and normalized to RFC 5952 (longest zero-run → `::`)
 *  - port = 8800 (peer-mesh default) when absent in input
 *
 * Throws `EndpointParseError` on:
 *  - empty / whitespace input
 *  - wildcard hosts: `0.0.0.0`, `::`, hostname `*`
 *  - port out of [1, 65535]
 *  - malformed bracketing or ambiguous unbracketed IPv6
 */

const DEFAULT_PORT = 8800;
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '*']);

export class EndpointParseError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`endpoint ${path}: ${message}`);
    this.name = 'EndpointParseError';
    this.path = path;
  }
}

interface HostPort {
  host: string;
  port: number;
  isIPv6: boolean;
}

function splitHostPort(input: string, path: string): HostPort {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new EndpointParseError(path, 'empty input');

  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close === -1) throw new EndpointParseError(path, 'missing closing bracket on IPv6 host');
    const host = trimmed.slice(1, close);
    if (host.length === 0) throw new EndpointParseError(path, 'empty IPv6 host');
    if (isIP(host) !== 6) throw new EndpointParseError(path, `not a valid IPv6 address: '${host}'`);
    const rest = trimmed.slice(close + 1);
    if (rest.length === 0) return { host, port: DEFAULT_PORT, isIPv6: true };
    if (!rest.startsWith(':')) throw new EndpointParseError(path, `unexpected text after IPv6 brackets: '${rest}'`);
    return { host, port: parsePort(rest.slice(1), path), isIPv6: true };
  }

  // Reject unbracketed multi-colon inputs before isIP can silently accept
  // them — node:net.isIP('2a11:6c7::11:1044') returns 6 (valid IPv6), so
  // a host:port form would be swallowed as a bare address.
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount >= 2) {
    throw new EndpointParseError(path, `IPv6 address with port must be bracketed: '[host]:port' (got '${trimmed}')`);
  }

  const colonIdx = trimmed.indexOf(':');
  const host = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx);
  if (host.length === 0) throw new EndpointParseError(path, 'empty host');
  const port = colonIdx === -1 ? DEFAULT_PORT : parsePort(trimmed.slice(colonIdx + 1), path);
  return { host, port, isIPv6: false };
}

function parsePort(s: string, path: string): number {
  if (!/^[0-9]+$/.test(s)) throw new EndpointParseError(path, `port must be numeric, got '${s}'`);
  const n = Number(s);
  if (n < 1 || n > 65535) throw new EndpointParseError(path, `port out of range [1, 65535]: ${n}`);
  return n;
}

/**
 * Compress an IPv6 address per RFC 5952: lowercase, suppress leading zeros
 * in each group, replace the longest run of zero groups with `::`.
 *
 * Input is assumed to be a valid IPv6 from `isIP()`.
 */
function canonicalizeIPv6(input: string): string {
  const lower = input.toLowerCase();
  let groups: string[];
  if (lower.includes('::')) {
    const [head, tail] = lower.split('::');
    const headGroups = head!.length === 0 ? [] : head!.split(':');
    const tailGroups = tail!.length === 0 ? [] : tail!.split(':');
    const fillCount = 8 - headGroups.length - tailGroups.length;
    if (fillCount < 0) throw new Error(`unreachable: invalid IPv6 reached canonicalize: '${input}'`);
    groups = [...headGroups, ...Array(fillCount).fill('0'), ...tailGroups];
  } else {
    groups = lower.split(':');
  }
  const stripped = groups.map((g) => g.replace(/^0+/, '') || '0');

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '0') {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if (bestLen >= 2) {
    const head = stripped.slice(0, bestStart).join(':');
    const tail = stripped.slice(bestStart + bestLen).join(':');
    return `${head}::${tail}`;
  }
  return stripped.join(':');
}

export function canonicalizeEndpoint(input: string): string {
  const path = `'${input}'`;
  const { host, port, isIPv6 } = splitHostPort(input, path);

  if (WILDCARD_HOSTS.has(host)) {
    throw new EndpointParseError(path, `wildcard host not allowed: '${host}'`);
  }

  if (isIPv6) {
    const canonical = canonicalizeIPv6(host);
    if (canonical === '::' || WILDCARD_HOSTS.has(canonical)) {
      throw new EndpointParseError(path, `wildcard host not allowed: '${canonical}'`);
    }
    return `[${canonical}]:${port}`;
  }

  if (isIP(host) === 4) {
    return `${host}:${port}`;
  }

  const lower = host.toLowerCase();
  if (lower.includes('*') || lower.length === 0) {
    throw new EndpointParseError(path, `invalid hostname: '${host}'`);
  }
  return `${lower}:${port}`;
}

const LOOPBACK = (() => {
  const list = new BlockList();
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addAddress('::1', 'ipv6');
  return list;
})();

/**
 * True iff `host` names this machine only: `localhost` (any case), an IPv4
 * address in 127.0.0.0/8, or any spelling of `::1` (bracketed or not, an IPv6
 * zone id ignored). Anything else is false: a hostname that merely starts with
 * `localhost` or `127.` and `localhost.` with its trailing dot included. The
 * dotted form is a fully qualified name that hosts without a resolver mapping
 * it send to DNS, where a spoofed answer would steer the request elsewhere.
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.split('%')[0]!; // an IPv6 zone id
  if (h === 'localhost') return true;
  const family = isIP(h);
  return family !== 0 && LOOPBACK.check(h, family === 4 ? 'ipv4' : 'ipv6');
}
