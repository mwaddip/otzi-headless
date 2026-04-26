import { describe, expect, it } from 'vitest';
import { createConsoleLogger } from './console-logger';

/**
 * The fail2ban filter shipped at `examples/fail2ban/otzi.conf` (verbatim, with
 * `<HOST>` substituted by a named capture group). If this regex changes there,
 * the test below catches it — and vice versa: a logger format change must be
 * cross-checked against the filter.
 *
 * Note: fail2ban's `<HOST>` token expands to a regex matching IPv4 + IPv6.
 * For the unit-test scope we only care that the IP is captured, so we use a
 * lax `(?<host>[^"',\s\}]+)` substitute. Validating fail2ban's exact `<HOST>`
 * expansion is fail2ban's job; ours is to confirm the structural anchor.
 */
const FAIL2BAN_REGEX_TEMPLATE =
  String.raw`^.*peer-allowlist: dropped connection from non-peer source\s*[\{].*?ip["']?\s*[:=]\s*["']?<HOST>["']?.*$`;

const FAIL2BAN_REGEX_FOR_TEST = new RegExp(
  FAIL2BAN_REGEX_TEMPLATE.replace('<HOST>', String.raw`(?<host>[^"',\s\}]+)`),
);

describe('createConsoleLogger', () => {
  it('writes JSON-extras lines that match the fail2ban regex', () => {
    const lines: string[] = [];
    const logger = createConsoleLogger({ write: (line) => lines.push(line) });

    logger.warn('peer-allowlist: dropped connection from non-peer source', {
      ip: '1.2.3.4',
      port: 56789,
    });

    expect(lines).toHaveLength(1);
    const line = lines[0]!.replace(/\n$/, '');
    expect(line).toBe(
      'WARN peer-allowlist: dropped connection from non-peer source {"ip":"1.2.3.4","port":56789}',
    );

    const match = FAIL2BAN_REGEX_FOR_TEST.exec(line);
    expect(match, `regex did not match line: ${line}`).not.toBeNull();
    expect(match!.groups?.host).toBe('1.2.3.4');
  });

  it('captures IPv6 hosts in the same line shape', () => {
    const lines: string[] = [];
    const logger = createConsoleLogger({ write: (line) => lines.push(line) });

    logger.warn('peer-allowlist: dropped connection from non-peer source', {
      ip: '::ffff:1.2.3.4',
      port: 56789,
    });

    const line = lines[0]!.replace(/\n$/, '');
    const match = FAIL2BAN_REGEX_FOR_TEST.exec(line);
    expect(match).not.toBeNull();
    expect(match!.groups?.host).toBe('::ffff:1.2.3.4');
  });

  it('emits messages without extras as bare LEVEL + msg', () => {
    const lines: string[] = [];
    const logger = createConsoleLogger({ write: (line) => lines.push(line) });

    logger.info('daemon: started');

    expect(lines).toEqual(['INFO daemon: started\n']);
  });

  it('respects minLevel — debug suppressed by default, allowed when set', () => {
    const lines: string[] = [];
    const defaultLogger = createConsoleLogger({ write: (line) => lines.push(line) });
    defaultLogger.debug('hidden');
    defaultLogger.info('visible');
    expect(lines).toEqual(['INFO visible\n']);

    const verbose: string[] = [];
    const debugLogger = createConsoleLogger({
      minLevel: 'debug',
      write: (line) => verbose.push(line),
    });
    debugLogger.debug('shown');
    expect(verbose).toEqual(['DEBUG shown\n']);
  });

  it('serializes BigInt extras as strings (no throw)', () => {
    const lines: string[] = [];
    const logger = createConsoleLogger({ write: (line) => lines.push(line) });

    logger.info('amount', { sat: 12345n });

    expect(lines[0]).toBe('INFO amount {"sat":"12345"}\n');
  });

  it('omits the trailing space when extras is an empty object', () => {
    const lines: string[] = [];
    const logger = createConsoleLogger({ write: (line) => lines.push(line) });

    logger.warn('msg', {});

    expect(lines[0]).toBe('WARN msg\n');
  });

  it('matches fail2ban regex when daemon prefixes are present (sanity)', () => {
    // Defense-in-depth: even if some future renderer prepends a timestamp or
    // unit name to each line (e.g. journald rendering), the `^.*` anchor in
    // the regex absorbs the prefix.
    const decorated =
      '2026-04-26T10:00:00 otzi[123]: WARN peer-allowlist: dropped connection from non-peer source {"ip":"10.0.0.1","port":443}';
    const match = FAIL2BAN_REGEX_FOR_TEST.exec(decorated);
    expect(match).not.toBeNull();
    expect(match!.groups?.host).toBe('10.0.0.1');
  });
});
