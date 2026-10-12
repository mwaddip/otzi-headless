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
name = "testnet4"

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
    expect(cfg.network).toEqual({ name: 'testnet4' });
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

describe('parseDaemonConfigToml — [network]', () => {
  const NETWORK_SECTION = '[network]\nname = "testnet4"\n';

  it.each(['mainnet', 'testnet4', 'signet'] as const)('accepts network.name = %s', (name) => {
    const toml = MINIMAL_TOML.replace('name = "testnet4"', `name = "${name}"`);
    expect(parseDaemonConfigToml(toml).network).toEqual({ name });
  });

  it('accepts an optional esplora_url', () => {
    for (const url of ['https://mempool.example/api', 'http://127.0.0.1:3002']) {
      const toml = MINIMAL_TOML.replace(NETWORK_SECTION, `${NETWORK_SECTION}esplora_url = "${url}"\n`);
      expect(parseDaemonConfigToml(toml).network).toEqual({ name: 'testnet4', esploraUrl: url });
    }
  });

  it('leaves esploraUrl absent when esplora_url is not set', () => {
    expect('esploraUrl' in parseDaemonConfigToml(MINIMAL_TOML).network).toBe(false);
  });

  it('rejects an esplora_url that is not an http(s) URL', () => {
    for (const bad of ['mempool.example/api', 'ftp://mempool.example', 'ws://mempool.example', 'https://', 'not a url']) {
      const toml = MINIMAL_TOML.replace(NETWORK_SECTION, `${NETWORK_SECTION}esplora_url = "${bad}"\n`);
      expect(() => parseDaemonConfigToml(toml), bad).toThrow(/network\.esplora_url.*http:\/\/ or https:\/\/ URL/);
    }
  });

  it('rejects a non-string esplora_url', () => {
    const toml = MINIMAL_TOML.replace(NETWORK_SECTION, `${NETWORK_SECTION}esplora_url = 42\n`);
    expect(() => parseDaemonConfigToml(toml)).toThrow(/network\.esplora_url.*must be a string/);
  });

  it('rejects network.opnet_rpc, testnet and regtest with explicit messages', () => {
    const withRpc = MINIMAL_TOML.replace(
      NETWORK_SECTION,
      `${NETWORK_SECTION}opnet_rpc = "https://testnet.opnet.org"\n`,
    );
    expect(() => parseDaemonConfigToml(withRpc)).toThrow(
      new ConfigError(
        'network.opnet_rpc',
        'no longer supported — remove it; the CLI reaches the chain through network.esplora_url',
      ),
    );
    const testnet = MINIMAL_TOML.replace('name = "testnet4"', 'name = "testnet"');
    expect(() => parseDaemonConfigToml(testnet)).toThrow(
      new ConfigError('network.name', 'use testnet4 or signet'),
    );
    const regtest = MINIMAL_TOML.replace('name = "testnet4"', 'name = "regtest"');
    expect(() => parseDaemonConfigToml(regtest)).toThrow(
      new ConfigError('network.name', 'not supported'),
    );
  });

  it('reports opnet_rpc before a bad network name', () => {
    const toml = MINIMAL_TOML.replace(
      NETWORK_SECTION,
      '[network]\nname = "regtest"\nopnet_rpc = "http://x"\n',
    );
    expect(() => parseDaemonConfigToml(toml)).toThrow(/network\.opnet_rpc/);
  });

  it('carries the offending key path on the ConfigError', () => {
    try {
      parseDaemonConfigToml(MINIMAL_TOML.replace('name = "testnet4"', 'name = "regtest"'));
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as ConfigError).path).toBe('network.name');
    }
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
    const toml = MINIMAL_TOML.replace('name = "testnet4"', 'name = "moonnet"');
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /network\.name.*must be one of mainnet \| testnet4 \| signet/,
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

  it.each(['max_sats_per_tx = 100000', 'allowed_recipients = "address-book"', 'command = ["/bin/true"]', 'url = "https://x"'])(
    'rejects a [gate] key the auto strategy does not use: %s',
    (line) => {
      const toml = MINIMAL_TOML.replace('strategy = "auto"', `strategy = "auto"\n${line}`);
      const key = line.split(' ')[0]!;
      let err: unknown;
      try {
        parseDaemonConfigToml(toml);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).path).toBe(`gate.${key}`);
      expect((err as Error).message).toBe(`config gate.${key}: not used by strategy auto`);
    },
  );

  it('rejects negative deadlines', () => {
    const toml =
      MINIMAL_TOML + '\n[deadlines]\nsigning_ms = -1\ndkg_ms = 900000\n';
    expect(() => parseDaemonConfigToml(toml)).toThrow(
      /deadlines\.signing_ms.*must be >= 1/,
    );
  });

  it('accepts deadlines up to the setTimeout maximum and rejects larger ones', () => {
    const max = 2_147_483_647;
    const at = (signing: number, dkg: number) =>
      parseDaemonConfigToml(MINIMAL_TOML + `\n[deadlines]\nsigning_ms = ${signing}\ndkg_ms = ${dkg}\n`);
    expect(at(max, max).deadlines).toEqual({ signingMs: max, dkgMs: max });
    expect(() => at(max + 1, 900_000)).toThrow(
      /deadlines\.signing_ms.*must be <= 2147483647 \(the longest Node\.js timer; got 2147483648\)/,
    );
    expect(() => at(300_000, max + 1)).toThrow(
      /deadlines\.dkg_ms.*must be <= 2147483647 \(the longest Node\.js timer; got 2147483648\)/,
    );
    expect(() => at(300_000, 10_000_000_000_000)).toThrow(/deadlines\.dkg_ms.*must be <= 2147483647/);
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
name = "testnet4"

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

describe('relay transport — [[peers]] optional, [bootstrap] parties', () => {
  /** MINIMAL_TOML on a relay transport, with no `[[peers]]` at all. */
  const RELAY_NO_PEERS = `
[share]
path = "/etc/otzi/share.json"
password_env = "OTZI_SHARE_PASSWORD"

[node]
id = "node-a"

[network]
name = "testnet4"

[transport]
kind = "relay"
url = "ws://relay.example:9000"

[gate]
strategy = "auto"
`;
  const RELAY_WITH_PEERS = RELAY_NO_PEERS.replace(
    '[gate]',
    '[[peers]]\nendpoint = "Node-B.example.com"\n\n[[peers]]\nendpoint = "127.0.0.1:8802"\n\n[gate]',
  );
  const LEADER = '\n[bootstrap]\nrole = "leader"\nbind = "0.0.0.0:7090"\n';

  function configError(toml: string): ConfigError {
    try {
      parseDaemonConfigToml(toml);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return e as ConfigError;
    }
    throw new Error('expected parseDaemonConfigToml to throw a ConfigError');
  }

  it('relay config without [[peers]] parses with peers = []', () => {
    const cfg = parseDaemonConfigToml(RELAY_NO_PEERS);
    expect(cfg.transport).toEqual({ kind: 'relay', url: 'ws://relay.example:9000' });
    expect(cfg.peers).toEqual([]);
    expect(cfg.bootstrap).toBeUndefined();
  });

  it('relay config with an empty peers array parses with peers = []', () => {
    const cfg = parseDaemonConfigToml(`peers = []\n${RELAY_NO_PEERS}`);
    expect(cfg.peers).toEqual([]);
  });

  it('relay config with [[peers]] still parses them', () => {
    const cfg = parseDaemonConfigToml(RELAY_WITH_PEERS);
    expect(cfg.peers).toEqual([
      { endpoint: 'node-b.example.com:8800' },
      { endpoint: '127.0.0.1:8802' },
    ]);
    // Entries that are present are validated as ever, even though relay does not use them.
    const err = configError(RELAY_WITH_PEERS.replace('endpoint = "127.0.0.1:8802"', 'endpoint = "127.0.0.1:8802"\nid = "x"'));
    expect(err.path).toBe('peers[1].id');
    expect(err.message).toMatch(/no longer supported/);
  });

  it('peer-mesh still requires at least one peer', () => {
    const missing = configError(MINIMAL_TOML.replace(/\[\[peers\]\][\s\S]*?(?=\n\[gate\])/g, ''));
    expect(missing.path).toBe('peers');
    expect(missing.message).toBe('config peers: missing required array (at least one peer)');
    const empty = configError(`peers = []\n${MINIMAL_TOML.replace(/\[\[peers\]\][\s\S]*?(?=\n\[gate\])/g, '')}`);
    expect(empty.path).toBe('peers');
    expect(empty.message).toBe('config peers: must contain at least one peer');
  });

  it('relay leader requires bootstrap.parties', () => {
    const err = configError(RELAY_NO_PEERS + LEADER);
    expect(err.path).toBe('bootstrap.parties');
    expect(err.message).toBe(
      'config bootstrap.parties: required when transport.kind = "relay" and bootstrap.role = "leader"',
    );
  });

  it('relay leader with bootstrap.parties parses it, at both ends of the range', () => {
    for (const n of [2, 3, 255]) {
      const cfg = parseDaemonConfigToml(RELAY_NO_PEERS + LEADER + `parties = ${n}\n`);
      expect(cfg.bootstrap).toEqual({ role: 'leader', bind: '0.0.0.0:7090', parties: n });
    }
  });

  it('relay leader with bootstrap.parties parses with [[peers]] present too', () => {
    const cfg = parseDaemonConfigToml(RELAY_WITH_PEERS + LEADER + 'parties = 3\n');
    expect(cfg.bootstrap?.parties).toBe(3);
    expect(cfg.peers).toHaveLength(2);
  });

  it('relay leaf needs no bootstrap.parties', () => {
    const cfg = parseDaemonConfigToml(
      RELAY_NO_PEERS + '\n[bootstrap]\nrole = "leaf"\nleader_url = "http://leader-host:7090"\n',
    );
    expect(cfg.bootstrap).toEqual({ role: 'leaf', leaderUrl: 'http://leader-host:7090' });
  });

  it.each<[string, string]>([
    ['1', '1'],
    ['0', '0'],
    ['-3', '-3'],
    ['256', '256'],
    ['2.5', '2.5'],
    ['"3"', '"3"'],
    ['true', 'true'],
  ])('bootstrap.parties must be an integer from 2 to 255 (rejects %s)', (_label, value) => {
    const err = configError(RELAY_NO_PEERS + LEADER + `parties = ${value}\n`);
    expect(err.path).toBe('bootstrap.parties');
  });

  it('bootstrap.parties out of range names the limits and the value', () => {
    expect(configError(RELAY_NO_PEERS + LEADER + 'parties = 1\n').message).toBe(
      'config bootstrap.parties: must be an integer from 2 to 255 (got 1)',
    );
    expect(configError(RELAY_NO_PEERS + LEADER + 'parties = 256\n').message).toBe(
      'config bootstrap.parties: must be an integer from 2 to 255 (got 256)',
    );
  });

  it('bootstrap.parties is rejected under peer-mesh', () => {
    const err = configError(MINIMAL_TOML + LEADER + 'parties = 3\n');
    expect(err.path).toBe('bootstrap.parties');
    expect(err.message).toBe(
      'config bootstrap.parties: only used with transport.kind = "relay"; peer-mesh counts [[peers]]',
    );
    // The specific message wins over the range check.
    expect(configError(MINIMAL_TOML + LEADER + 'parties = 1\n').message).toMatch(/only used with transport\.kind = "relay"/);
  });

  it('bootstrap.parties is rejected on a leaf', () => {
    const leaf = '\n[bootstrap]\nrole = "leaf"\nleader_url = "http://leader-host:7090"\nparties = 3\n';
    for (const base of [RELAY_NO_PEERS, MINIMAL_TOML]) {
      const err = configError(base + leaf);
      expect(err.path).toBe('bootstrap.parties');
      expect(err.message).toMatch(/unknown key \(expected one of role, leader_url\)/);
    }
  });

  it('keeps rejecting unknown [bootstrap] keys under relay', () => {
    const err = configError(RELAY_NO_PEERS + LEADER + 'parties = 3\nextra = 1\n');
    expect(err.path).toBe('bootstrap.extra');
    expect(err.message).toMatch(/unknown key \(expected one of role, bind, parties\)/);
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
name = "testnet4"
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
name = "testnet4"
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
name = "testnet4"
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
name = "testnet4"
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

describe('parseDaemonConfigToml — unknown keys', () => {
  const RELAY = MINIMAL_TOML.replace('kind = "peer-mesh"\nadvertised_endpoint = "127.0.0.1:8800"', 'kind = "relay"\nurl = "ws://relay.example:9000"');
  const WITH_ALL = `${MINIMAL_TOML}
[deadlines]
signing_ms = 1000

[[triggers]]
kind = "http"
bind = "127.0.0.1:7080"

[[triggers]]
kind = "uds"
path = "/var/run/otzi/otzi.sock"

[[triggers]]
kind = "cron"
schedule = "0 * * * *"
job_name = "hourly"

[bootstrap]
role = "leader"
bind = "0.0.0.0:7090"
`;

  it.each<[string, string, string]>([
    ['share.pasword_env', WITH_ALL, 'password_env = "OTZI_SHARE_PASSWORD"'],
    ['node.identity_file', WITH_ALL, 'id = "node-a"'],
    ['network.esplora_uri', WITH_ALL, 'name = "testnet4"'],
    ['transport.url', WITH_ALL, 'advertised_endpoint = "127.0.0.1:8800"'],
    ['peers[0].port', WITH_ALL, 'endpoint = "127.0.0.1:8801"'],
    ['deadlines.signing', WITH_ALL, 'signing_ms = 1000'],
    ['triggers[0].auth_token', WITH_ALL, 'bind = "127.0.0.1:7080"'],
    ['triggers[1].mode', WITH_ALL, 'path = "/var/run/otzi/otzi.sock"'],
    ['triggers[2].tz', WITH_ALL, 'job_name = "hourly"'],
    ['bootstrap.leader_url', WITH_ALL, 'bind = "0.0.0.0:7090"'],
  ])('rejects %s', (dotted, base, anchor) => {
    const key = dotted.split('.').at(-1)!;
    const value = key === 'port' || key === 'signing' ? '1' : '"x"';
    const toml = base.replace(anchor, `${anchor}\n${key} = ${value}`);
    let err: unknown;
    try {
      parseDaemonConfigToml(toml);
    } catch (e) {
      err = e;
    }
    expect(err, dotted).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).path).toBe(dotted);
    expect((err as Error).message).toMatch(/unknown key/);
  });

  it('rejects advertised_endpoint under a relay transport', () => {
    const toml = RELAY.replace('url = "ws://relay.example:9000"', 'url = "ws://relay.example:9000"\nadvertised_endpoint = "127.0.0.1:8800"');
    expect(() => parseDaemonConfigToml(toml)).toThrow(/config transport\.advertised_endpoint: unknown key/);
  });

  it('rejects an unknown top-level table or key', () => {
    expect(() => parseDaemonConfigToml(`${MINIMAL_TOML}\n[logging]\nlevel = "debug"\n`)).toThrow(/config logging: unknown key/);
    expect(() => parseDaemonConfigToml(`stray = 1\n${MINIMAL_TOML}`)).toThrow(/config stray: unknown key/);
  });

  it('keeps the specific messages for retired keys', () => {
    expect(() => parseDaemonConfigToml(MINIMAL_TOML.replace('id = "node-a"', 'id = "node-a"\nparty_id = 1'))).toThrow(/node\.party_id: no longer supported/);
    expect(() => parseDaemonConfigToml(MINIMAL_TOML.replace('name = "testnet4"', 'name = "testnet4"\nopnet_rpc = "x"'))).toThrow(/network\.opnet_rpc: no longer supported/);
  });

  it('accepts every documented key', () => {
    const toml = WITH_ALL.replace('name = "testnet4"', 'name = "testnet4"\nesplora_url = "https://mempool.space/testnet4/api"')
      .replace('id = "node-a"', 'id = "node-a"\nidentity_key_file = "/var/lib/otzi/identity.json"\npubkey_book_file = "/var/lib/otzi/pubkeys.json"')
      .replace('signing_ms = 1000', 'signing_ms = 1000\ndkg_ms = 2000')
      .replace('bind = "127.0.0.1:7080"', 'bind = "127.0.0.1:7080"\nauth_token_env = "OTZI_API_TOKEN"')
      .replace('job_name = "hourly"', 'job_name = "hourly"\ntimezone = "UTC"');
    expect(() => parseDaemonConfigToml(toml)).not.toThrow();
    expect(() => parseDaemonConfigToml(RELAY)).not.toThrow();
  });
});

