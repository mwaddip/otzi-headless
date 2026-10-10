import { describe, expect, it } from 'vitest';
import { BroadcastFailedError } from '../cli/cmd/btc';
import { DaemonClientError } from '../cli/daemon-client';
import { parseVerbArgs, reportCliError } from './entrypoint';

const TX_HEX = '02000000000101ab';

function report(err: unknown): string[] {
  const lines: string[] = [];
  reportCliError(err, line => lines.push(line));
  return lines;
}

describe('reportCliError', () => {
  it('prints the signed transaction hex when a broadcast failed after signing', () => {
    const lines = report(new BroadcastFailedError('broadcast failed: 400 bad-txns-inputs-missingorspent', 'ab'.repeat(32), TX_HEX));
    expect(lines[0]).toBe('broadcast failed: 400 bad-txns-inputs-missingorspent');
    expect(lines.join('\n')).toContain(`txid ${'ab'.repeat(32)}`);
    expect(lines.join('\n')).toMatch(/broadcast it by other means/);
    expect(lines[lines.length - 1]).toBe(TX_HEX);
  });

  it('prints just the message for any other error', () => {
    expect(report(new DaemonClientError(409, 'this node already holds a vault'))).toEqual([
      'this node already holds a vault',
    ]);
    expect(report(new Error('boom'))).toEqual(['boom']);
    expect(report('plain')).toEqual(['plain']);
  });
});

describe('parseVerbArgs', () => {
  const spec = { values: ['config', 'fee-rate'], booleans: ['broadcast', 'json'] };

  it('splits positionals from value and boolean flags in any order', () => {
    const r = parseVerbArgs(['--broadcast', 'proposal.json', '--config', '/x.toml'], spec);
    expect(r.positional).toEqual(['proposal.json']);
    expect(r.flags.get('config')).toBe('/x.toml');
    expect(r.flags.has('broadcast')).toBe(true);
    expect(r.flags.has('json')).toBe(false);
  });

  it('keeps negative-looking and decimal tokens as positionals', () => {
    expect(parseVerbArgs(['tb1qaddr', '0.5btc', '--fee-rate', '7.5'], spec)).toMatchObject({
      positional: ['tb1qaddr', '0.5btc'],
      flags: new Map([['fee-rate', '7.5']]),
    });
  });

  it('rejects unknown flags', () => {
    expect(() => parseVerbArgs(['--fee_rate', '5'], spec)).toThrow("unknown flag '--fee_rate'");
  });

  it('rejects a value flag without a value', () => {
    expect(() => parseVerbArgs(['--config'], spec)).toThrow("flag '--config' needs a value");
    expect(() => parseVerbArgs(['--config', '--json'], spec)).toThrow("flag '--config' needs a value");
  });
});
