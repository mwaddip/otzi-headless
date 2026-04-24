import { describe, expect, it } from 'vitest';
import { ConfigError, parseDaemonConfigToml } from './parse';
import {
  DEFAULT_DKG_DEADLINE_MS,
  DEFAULT_SIGNING_DEADLINE_MS,
} from './types';

const MINIMAL_TOML = `
[share]
path = "/etc/otzi/share.json"
password_env = "OTZI_SHARE_PASSWORD"

[node]
id = "node-a"
party_id = 1

[transport]
kind = "peer-mesh"

[[peers]]
id = "node-b"
party_id = 2

[[peers]]
id = "node-c"
party_id = 3

[gate]
strategy = "auto"
`;

describe('parseDaemonConfigToml — happy paths', () => {
  it('parses minimal valid TOML with defaults for deadlines/triggers', () => {
    const cfg = parseDaemonConfigToml(MINIMAL_TOML);
    expect(cfg.share).toEqual({
      path: '/etc/otzi/share.json',
      passwordEnv: 'OTZI_SHARE_PASSWORD',
    });
    expect(cfg.node).toEqual({ id: 'node-a', partyId: 1 });
    expect(cfg.transport).toEqual({ kind: 'peer-mesh' });
    expect(cfg.peers).toEqual([
      { id: 'node-b', partyId: 2, walletAddress: undefined, endpoint: undefined },
      { id: 'node-c', partyId: 3, walletAddress: undefined, endpoint: undefined },
    ]);
    expect(cfg.gate).toEqual({ strategy: 'auto', params: undefined });
    expect(cfg.deadlines).toEqual({
      signingMs: DEFAULT_SIGNING_DEADLINE_MS,
      dkgMs: DEFAULT_DKG_DEADLINE_MS,
    });
    expect(cfg.triggers).toEqual([]);
  });

  it('parses fully-populated TOML with all optional fields', () => {
    const toml = `
[share]
path = "/var/lib/otzi/share.json"
password_env = "OTZI_PWD"

[node]
id = "alpha"
party_id = 2

[transport]
kind = "relay"
url = "wss://relay.example.com"

[[peers]]
id = "bravo"
party_id = 1
wallet_address = "0xdeadbeef"
endpoint = "wss://bravo.example:8443"

[[peers]]
id = "charlie"
party_id = 3
wallet_address = "0xfeedface"
endpoint = "wss://charlie.example:8443"

[gate]
strategy = "policy"
max_amount_sats = 100000
destination_allowlist = ["bc1p...", "bc1q..."]

[deadlines]
signing_ms = 600000
dkg_ms = 1800000

[[triggers]]
kind = "http"
bind = "127.0.0.1:7080"
auth_token_env = "OTZI_TRIGGER_TOKEN"

[[triggers]]
kind = "cron"
schedule = "0 */6 * * *"
`;
    const cfg = parseDaemonConfigToml(toml);
    expect(cfg.transport).toEqual({ kind: 'relay', url: 'wss://relay.example.com' });
    expect(cfg.peers[0]).toEqual({
      id: 'bravo',
      partyId: 1,
      walletAddress: '0xdeadbeef',
      endpoint: 'wss://bravo.example:8443',
    });
    expect(cfg.gate.strategy).toBe('policy');
    expect(cfg.gate.params).toEqual({
      max_amount_sats: 100000,
      destination_allowlist: ['bc1p...', 'bc1q...'],
    });
    expect(cfg.deadlines).toEqual({ signingMs: 600_000, dkgMs: 1_800_000 });
    expect(cfg.triggers).toHaveLength(2);
    expect(cfg.triggers[0]!.kind).toBe('http');
    expect(cfg.triggers[0]!.params).toEqual({
      bind: '127.0.0.1:7080',
      auth_token_env: 'OTZI_TRIGGER_TOKEN',
    });
    expect(cfg.triggers[1]!.kind).toBe('cron');
    expect(cfg.triggers[1]!.params).toEqual({ schedule: '0 */6 * * *' });
  });
});

describe('parseDaemonConfigToml — missing required tables', () => {
  it('rejects missing [share]', () => {
    const toml = MINIMAL_TOML.replace(/\[share\][\s\S]*?(?=\n\[node\])/, '');
    expect(() => parseDaemonConfigToml(toml)).toThrow(/share.*missing required table/);
  });
  it('rejects missing [node]', () => {
    const toml = MINIMAL_TOML.replace(/\[node\][\s\S]*?(?=\n\[transport\])/, '');
    expect(() => parseDaemonConfigToml(toml)).toThrow(/node.*missing required table/);
  });
  it('rejects missing [transport]', () => {
    const toml = MINIMAL_TOML.replace(/\[transport\][\s\S]*?(?=\n\[\[peers\]\])/, '');
    expect(() => parseDaemonConfigToml(toml)).toThrow(/transport.*missing required table/);
  });
  it('rejects missing [[peers]]', () => {
    const toml = MINIMAL_TOML.replace(/\[\[peers\]\][\s\S]*?(?=\n\[gate\])/g, '');
    expect(() => parseDaemonConfigToml(toml)).toThrow(/peers.*missing required array/);
  });
  it('rejects missing [gate]', () => {
    const toml = MINIMAL_TOML.replace(/\[gate\][\s\S]*$/, '');
    expect(() => parseDaemonConfigToml(toml)).toThrow(/gate.*missing required table/);
  });
});

describe('parseDaemonConfigToml — type & enum validation', () => {
  it('rejects non-string share.path', () => {
    const toml = MINIMAL_TOML.replace('path = "/etc/otzi/share.json"', 'path = 42');
    expect(() => parseDaemonConfigToml(toml)).toThrow(/share\.path.*must be a string/);
  });

  it('rejects non-integer party_id', () => {
    const toml = MINIMAL_TOML.replace('party_id = 1', 'party_id = 1.5');
    expect(() => parseDaemonConfigToml(toml)).toThrow(/node\.party_id.*must be an integer/);
  });

  it('rejects negative party_id', () => {
    const toml = MINIMAL_TOML.replace('party_id = 1', 'party_id = -1');
    expect(() => parseDaemonConfigToml(toml)).toThrow(/node\.party_id.*must be >= 0/);
  });

  it('rejects unknown transport.kind', () => {
    const toml = MINIMAL_TOML.replace('kind = "peer-mesh"', 'kind = "smoke-signal"');
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /transport\.kind.*must be one of peer-mesh \| relay/,
    );
  });

  it('rejects relay transport without url', () => {
    const toml = MINIMAL_TOML.replace('kind = "peer-mesh"', 'kind = "relay"');
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /transport\.url.*required when transport\.kind = "relay"/,
    );
  });

  it('rejects unknown gate.strategy', () => {
    const toml = MINIMAL_TOML.replace('strategy = "auto"', 'strategy = "telepathy"');
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /gate\.strategy.*must be one of auto \| policy \| exec \| webhook \| cli \| queue/,
    );
  });

  it('rejects negative deadlines', () => {
    const toml =
      MINIMAL_TOML + '\n[deadlines]\nsigning_ms = -1\ndkg_ms = 900000\n';
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /deadlines\.signing_ms.*must be >= 1/,
    );
  });

  it('rejects unknown trigger.kind', () => {
    const toml =
      MINIMAL_TOML + '\n[[triggers]]\nkind = "carrier-pigeon"\n';
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /triggers\[0\]\.kind.*must be one of http \| cron/,
    );
  });

  it('rejects empty peers array', () => {
    // Top-level `peers = []` must appear before any [table] in TOML.
    const toml = `
peers = []

[share]
path = "/s"
password_env = "P"

[node]
id = "a"
party_id = 1

[transport]
kind = "peer-mesh"

[gate]
strategy = "auto"
`;
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /peers.*must contain at least one peer/,
    );
  });
});

describe('parseDaemonConfigToml — coherence', () => {
  it('rejects duplicate peer ids', () => {
    const toml = MINIMAL_TOML.replace('id = "node-c"', 'id = "node-b"');
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /peers\[1\]\.id.*duplicate id 'node-b'/,
    );
  });

  it('rejects duplicate peer partyIds', () => {
    const toml = MINIMAL_TOML.replace(
      '[[peers]]\nid = "node-c"\nparty_id = 3',
      '[[peers]]\nid = "node-c"\nparty_id = 2',
    );
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /peers\[1\]\.party_id.*duplicate partyId 2/,
    );
  });

  it('rejects peer partyId colliding with node partyId', () => {
    const toml = MINIMAL_TOML.replace(
      '[[peers]]\nid = "node-b"\nparty_id = 2',
      '[[peers]]\nid = "node-b"\nparty_id = 1',
    );
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /peers\[0\]\.party_id.*duplicate partyId 1/,
    );
  });

  it('rejects peer id colliding with node id', () => {
    const toml = MINIMAL_TOML.replace('id = "node-b"', 'id = "node-a"');
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /peers\[0\]\.id.*duplicate id 'node-a'/,
    );
  });
});

describe('ConfigError', () => {
  it('carries a path field for programmatic consumers', () => {
    try {
      parseDaemonConfigToml(MINIMAL_TOML.replace('party_id = 1', 'party_id = "1"'));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).path).toBe('node.party_id');
    }
  });
});
