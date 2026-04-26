import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../orchestrator/types';

// vi.mock is hoisted; declare the mock fn separately so we can manipulate it
// per-test before importing PeerAllowlist.
const lookupMock = vi.fn();

vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import { PeerAllowlist } from './allowlist';

function makeLogger(): { logger: Logger; calls: Array<{ level: string; msg: string; extra?: Record<string, unknown> }> } {
  const calls: Array<{ level: string; msg: string; extra?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug: (msg, extra) => calls.push({ level: 'debug', msg, extra }),
    info: (msg, extra) => calls.push({ level: 'info', msg, extra }),
    warn: (msg, extra) => calls.push({ level: 'warn', msg, extra }),
    error: (msg, extra) => calls.push({ level: 'error', msg, extra }),
  };
  return { logger, calls };
}

describe('PeerAllowlist', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  afterEach(() => {
    lookupMock.mockReset();
  });

  it('resolves a hostname into the IP set', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);
    const { logger } = makeLogger();
    const al = new PeerAllowlist(
      [{ partyId: 1, endpoint: 'ws://localhost:8800' }],
      logger,
    );
    await al.resolve();
    expect(al.has('127.0.0.1')).toBe(true);
    expect(al.has('::1')).toBe(true);
    expect(lookupMock).toHaveBeenCalledWith('localhost', { all: true, family: 0 });
  });

  it('matches both raw IPv4 and ::ffff:-mapped IPv6 form', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const { logger } = makeLogger();
    const al = new PeerAllowlist([{ partyId: 1, endpoint: 'ws://host.example:8800' }], logger);
    await al.resolve();
    expect(al.has('127.0.0.1')).toBe(true);
    expect(al.has('::ffff:127.0.0.1')).toBe(true);
    expect(al.has('192.0.2.1')).toBe(false);
  });

  it('strips ::ffff: prefix from stored IPs too (resolved IPv6 v4-mapped form)', async () => {
    // If DNS hands back a v4-mapped form, we still want has('127.0.0.1') to match.
    lookupMock.mockResolvedValueOnce([{ address: '::ffff:127.0.0.1', family: 6 }]);
    const { logger } = makeLogger();
    const al = new PeerAllowlist([{ partyId: 1, endpoint: 'ws://host.example:8800' }], logger);
    await al.resolve();
    expect(al.has('127.0.0.1')).toBe(true);
    expect(al.has('::ffff:127.0.0.1')).toBe(true);
  });

  it('skips peers with no endpoint', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    const { logger } = makeLogger();
    const al = new PeerAllowlist(
      [
        { partyId: 1, endpoint: 'ws://a.example:8800' },
        { partyId: 2 }, // relay-only peer, no endpoint
      ],
      logger,
    );
    await al.resolve();
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(al.has('10.0.0.1')).toBe(true);
  });

  it('throws cleanly when a hostname cannot be resolved', async () => {
    lookupMock.mockRejectedValueOnce(Object.assign(new Error('queryA ENOTFOUND nope.invalid'), { code: 'ENOTFOUND' }));
    const { logger } = makeLogger();
    const al = new PeerAllowlist(
      [{ partyId: 1, endpoint: 'ws://nope.invalid:8800' }],
      logger,
    );
    await expect(al.resolve()).rejects.toThrow(/peer-allowlist: DNS lookup failed.*partyId=1.*nope\.invalid/);
  });

  it('throws when an endpoint cannot be parsed', async () => {
    const { logger } = makeLogger();
    const al = new PeerAllowlist(
      [{ partyId: 1, endpoint: 'not a url' }],
      logger,
    );
    await expect(al.resolve()).rejects.toThrow(/unparseable endpoint/);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('throws when an endpoint uses a non-ws protocol', async () => {
    const { logger } = makeLogger();
    const al = new PeerAllowlist(
      [{ partyId: 1, endpoint: 'http://host.example:8800' }],
      logger,
    );
    await expect(al.resolve()).rejects.toThrow(/unparseable endpoint/);
  });

  it('parses bracketed IPv6 endpoint hosts', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '::1', family: 6 }]);
    const { logger } = makeLogger();
    const al = new PeerAllowlist(
      [{ partyId: 1, endpoint: 'ws://[::1]:8800' }],
      logger,
    );
    await al.resolve();
    expect(lookupMock).toHaveBeenCalledWith('::1', { all: true, family: 0 });
    expect(al.has('::1')).toBe(true);
  });

  it('refresh logs membership change at info level when IPs differ', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    const { logger, calls } = makeLogger();
    const al = new PeerAllowlist(
      [{ partyId: 1, endpoint: 'ws://drifty.example:8800' }],
      logger,
    );
    await al.resolve();
    expect(al.has('10.0.0.1')).toBe(true);

    // Second resolution returns a different IP — refresh must log + swap.
    lookupMock.mockResolvedValueOnce([{ address: '10.0.0.2', family: 4 }]);
    await al.refresh();

    const infoLines = calls.filter((c) => c.level === 'info' && c.msg.startsWith('peer-allowlist:'));
    expect(infoLines).toHaveLength(1);
    expect(infoLines[0]!.extra).toMatchObject({
      added: ['10.0.0.2'],
      removed: ['10.0.0.1'],
    });
    expect(al.has('10.0.0.2')).toBe(true);
    expect(al.has('10.0.0.1')).toBe(false);
  });

  it('refresh does NOT log when membership is unchanged', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    const { logger, calls } = makeLogger();
    const al = new PeerAllowlist(
      [{ partyId: 1, endpoint: 'ws://stable.example:8800' }],
      logger,
    );
    await al.resolve();
    const before = calls.length;
    await al.refresh();
    const after = calls.length;
    expect(after).toBe(before);
  });

  it('aggregates IPs from multiple peers with endpoints', async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
      .mockResolvedValueOnce([
        { address: '10.0.0.2', family: 4 },
        { address: '::1', family: 6 },
      ]);
    const { logger } = makeLogger();
    const al = new PeerAllowlist(
      [
        { partyId: 1, endpoint: 'ws://a.example:8800' },
        { partyId: 2, endpoint: 'ws://b.example:8800' },
      ],
      logger,
    );
    await al.resolve();
    expect(al.has('10.0.0.1')).toBe(true);
    expect(al.has('10.0.0.2')).toBe(true);
    expect(al.has('::1')).toBe(true);
  });
});
