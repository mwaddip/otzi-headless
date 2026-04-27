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

[network]
name = "testnet"
opnet_rpc = "https://testnet.opnet.org"

[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:8800"

[[peers]]
endpoint = "127.0.0.1:8801"

[[peers]]
endpoint = "127.0.0.1:8802"

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
    expect(cfg.node).toEqual({ id: 'node-a' });
    expect(cfg.network).toEqual({
      name: 'testnet',
      opnetRpc: 'https://testnet.opnet.org',
    });
    expect(cfg.transport).toEqual({
      kind: 'peer-mesh',
      advertisedEndpoint: '127.0.0.1:8800',
    });
    expect(cfg.peers).toEqual([
      { endpoint: '127.0.0.1:8801' },
      { endpoint: '127.0.0.1:8802' },
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

[network]
name = "mainnet"
opnet_rpc = "https://api.opnet.org"

[transport]
kind = "relay"
url = "wss://relay.example.com"

[[peers]]
endpoint = "bravo.example:8443"

[[peers]]
endpoint = "charlie.example:8443"

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
    expect(cfg.peers[0]).toEqual({ endpoint: 'bravo.example:8443' });
    expect(cfg.peers[1]).toEqual({ endpoint: 'charlie.example:8443' });
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
    const toml = MINIMAL_TOML.replace(/\[node\][\s\S]*?(?=\n\[network\])/, '');
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
  it('rejects missing [network]', () => {
    const toml = MINIMAL_TOML.replace(/\[network\][\s\S]*?(?=\n\[transport\])/, '');
    expect(() => parseDaemonConfigToml(toml)).toThrow(/network.*missing required table/);
  });
});

describe('parseDaemonConfigToml — type & enum validation', () => {
  it('rejects non-string share.path', () => {
    const toml = MINIMAL_TOML.replace('path = "/etc/otzi/share.json"', 'path = 42');
    expect(() => parseDaemonConfigToml(toml)).toThrow(/share\.path.*must be a string/);
  });

  it('rejects unknown transport.kind', () => {
    const toml = MINIMAL_TOML.replace('kind = "peer-mesh"', 'kind = "smoke-signal"');
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /transport\.kind.*must be one of peer-mesh \| relay/,
    );
  });

  it('rejects unknown network.name', () => {
    const toml = MINIMAL_TOML.replace('name = "testnet"', 'name = "moonnet"');
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /network\.name.*must be one of mainnet \| testnet \| regtest/,
    );
  });

  it('rejects relay transport without url', () => {
    const toml = MINIMAL_TOML
      .replace('kind = "peer-mesh"', 'kind = "relay"')
      .replace('advertised_endpoint = "127.0.0.1:8800"', '');
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /transport\.url.*required when transport\.kind = "relay"/,
    );
  });

  it('rejects unknown gate.strategy', () => {
    const toml = MINIMAL_TOML.replace('strategy = "auto"', 'strategy = "telepathy"');
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /gate\.strategy.*must be one of auto \| policy \| exec \| webhook/,
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
      /triggers\[0\]\.kind.*must be one of http \| uds \| cron/,
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

[network]
name = "testnet"
opnet_rpc = "https://testnet.opnet.org"

[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:8800"

[gate]
strategy = "auto"
`;
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /peers.*must contain at least one peer/,
    );
  });
});

describe('parseDaemonConfigToml — Phase F legacy-field rejection', () => {
  it('rejects node.party_id', () => {
    const toml = MINIMAL_TOML.replace('id = "node-a"', 'id = "node-a"\nparty_id = 0');
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /node\.party_id.*no longer supported.*derived from the pubkey book/,
    );
  });

  it('rejects [[peers]].id', () => {
    const toml = MINIMAL_TOML.replace(
      'endpoint = "127.0.0.1:8801"',
      'id = "node-b"\nendpoint = "127.0.0.1:8801"',
    );
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /peers\[0\]\.id.*no longer supported/,
    );
  });

  it('rejects [[peers]].party_id', () => {
    const toml = MINIMAL_TOML.replace(
      'endpoint = "127.0.0.1:8801"',
      'party_id = 1\nendpoint = "127.0.0.1:8801"',
    );
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /peers\[0\]\.party_id.*no longer supported/,
    );
  });

  it('rejects [[peers]].wallet_address', () => {
    const toml = MINIMAL_TOML.replace(
      'endpoint = "127.0.0.1:8801"',
      'wallet_address = "0xfeedface"\nendpoint = "127.0.0.1:8801"',
    );
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /peers\[0\]\.wallet_address.*no longer supported/,
    );
  });

  it('rejects transport.listen', () => {
    const toml = MINIMAL_TOML.replace(
      'advertised_endpoint = "127.0.0.1:8800"',
      'listen = "127.0.0.1:8800"',
    );
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /transport\.listen.*no longer supported.*advertised_endpoint/,
    );
  });

  it('rejects [[peers]] without endpoint', () => {
    const toml = MINIMAL_TOML.replace(
      `[[peers]]
endpoint = "127.0.0.1:8801"`,
      '[[peers]]\n',
    );
    expect(() => parseDaemonConfigToml(toml)).toThrow(/peers\[0\]\.endpoint.*required/);
  });
});

describe('ConfigError', () => {
  it('carries a path field for programmatic consumers', () => {
    try {
      parseDaemonConfigToml(
        MINIMAL_TOML.replace('path = "/etc/otzi/share.json"', 'path = 42'),
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).path).toBe('share.path');
    }
  });
});

describe('[bootstrap] parsing', () => {
  it('parses leader role with bind', () => {
    const cfg = parseDaemonConfigToml(
      MINIMAL_TOML + '\n[bootstrap]\nrole = "leader"\nbind = "0.0.0.0:7090"\n',
    );
    expect(cfg.bootstrap).toEqual({ role: 'leader', bind: '0.0.0.0:7090' });
  });

  it('parses leaf role with leader_url', () => {
    const cfg = parseDaemonConfigToml(
      MINIMAL_TOML + '\n[bootstrap]\nrole = "leaf"\nleader_url = "http://leader-host:7090"\n',
    );
    expect(cfg.bootstrap).toEqual({ role: 'leaf', leaderUrl: 'http://leader-host:7090' });
  });

  it('returns undefined when [bootstrap] is absent', () => {
    const cfg = parseDaemonConfigToml(MINIMAL_TOML);
    expect(cfg.bootstrap).toBeUndefined();
  });

  it('throws when role is unknown', () => {
    expect(() =>
      parseDaemonConfigToml(MINIMAL_TOML + '\n[bootstrap]\nrole = "broker"\n'),
    ).toThrow(/bootstrap\.role.*must be one of/);
  });

  it('throws when leader role has no bind', () => {
    expect(() =>
      parseDaemonConfigToml(MINIMAL_TOML + '\n[bootstrap]\nrole = "leader"\n'),
    ).toThrow(/bootstrap\.bind.*required/);
  });

  it('throws when leaf role has no leader_url', () => {
    expect(() =>
      parseDaemonConfigToml(MINIMAL_TOML + '\n[bootstrap]\nrole = "leaf"\n'),
    ).toThrow(/bootstrap\.leader_url.*required/);
  });
});

describe('http trigger loopback enforcement', () => {
  it('accepts 127.0.0.1', () => {
    const cfg = parseDaemonConfigToml(
      MINIMAL_TOML + '\n[[triggers]]\nkind = "http"\nbind = "127.0.0.1:7080"\n',
    );
    expect(cfg.triggers[0]!.kind).toBe('http');
  });

  it('accepts ::1', () => {
    const cfg = parseDaemonConfigToml(
      MINIMAL_TOML + '\n[[triggers]]\nkind = "http"\nbind = "[::1]:7080"\n',
    );
    expect(cfg.triggers[0]!.kind).toBe('http');
  });

  it('accepts localhost', () => {
    const cfg = parseDaemonConfigToml(
      MINIMAL_TOML + '\n[[triggers]]\nkind = "http"\nbind = "localhost:7080"\n',
    );
    expect(cfg.triggers[0]!.kind).toBe('http');
  });

  it('rejects 0.0.0.0', () => {
    expect(() =>
      parseDaemonConfigToml(
        MINIMAL_TOML + '\n[[triggers]]\nkind = "http"\nbind = "0.0.0.0:7080"\n',
      ),
    ).toThrow(/bind.*loopback/);
  });

  it('rejects external IPs', () => {
    expect(() =>
      parseDaemonConfigToml(
        MINIMAL_TOML + '\n[[triggers]]\nkind = "http"\nbind = "10.0.0.1:7080"\n',
      ),
    ).toThrow(/bind.*loopback/);
  });
});

describe('uds trigger params', () => {
  it('parses path', () => {
    const cfg = parseDaemonConfigToml(
      MINIMAL_TOML + '\n[[triggers]]\nkind = "uds"\npath = "/var/run/otzi/otzi.sock"\n',
    );
    expect(cfg.triggers[0]).toMatchObject({
      kind: 'uds',
      params: { path: '/var/run/otzi/otzi.sock' },
    });
  });

  it('rejects relative paths', () => {
    expect(() =>
      parseDaemonConfigToml(
        MINIMAL_TOML + '\n[[triggers]]\nkind = "uds"\npath = "otzi.sock"\n',
      ),
    ).toThrow(/path.*absolute/);
  });
});

describe('parse — endpoint canonicalization', () => {
  it('canonicalizes [[peers]].endpoint with default port', () => {
    const text = `
[share]
path = "/x"
password_env = "P"
[node]
id = "a"
[network]
name = "testnet"
opnet_rpc = "https://testnet.opnet.org"
[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:8800"
[[peers]]
endpoint = "Node-B.example.com"
[gate]
strategy = "auto"
`;
    const cfg = parseDaemonConfigToml(text);
    expect(cfg.peers[0]!.endpoint).toBe('node-b.example.com:8800');
  });

  it('canonicalizes transport.advertised_endpoint with default port', () => {
    const text = `
[share]
path = "/x"
password_env = "P"
[node]
id = "a"
[network]
name = "testnet"
opnet_rpc = "https://testnet.opnet.org"
[transport]
kind = "peer-mesh"
advertised_endpoint = "192.168.1.5"
[[peers]]
endpoint = "127.0.0.1:8801"
[gate]
strategy = "auto"
`;
    const cfg = parseDaemonConfigToml(text);
    expect(cfg.transport.advertisedEndpoint).toBe('192.168.1.5:8800');
  });

  it('rejects wildcard 0.0.0.0 in transport.advertised_endpoint', () => {
    const text = `
[share]
path = "/x"
password_env = "P"
[node]
id = "a"
[network]
name = "testnet"
opnet_rpc = "https://testnet.opnet.org"
[transport]
kind = "peer-mesh"
advertised_endpoint = "0.0.0.0:8800"
[[peers]]
endpoint = "127.0.0.1:8801"
[gate]
strategy = "auto"
`;
    expect(() => parseDaemonConfigToml(text)).toThrow(/wildcard/);
  });

  it('rejects wildcard in [[peers]].endpoint', () => {
    const text = `
[share]
path = "/x"
password_env = "P"
[node]
id = "a"
[network]
name = "testnet"
opnet_rpc = "https://testnet.opnet.org"
[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:8800"
[[peers]]
endpoint = "0.0.0.0:8800"
[gate]
strategy = "auto"
`;
    expect(() => parseDaemonConfigToml(text)).toThrow(/wildcard/);
  });
});
