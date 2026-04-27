import { describe, it, expect } from 'vitest';
import { canonicalizeEndpoint, EndpointParseError } from './endpoint';

describe('canonicalizeEndpoint — IPv4', () => {
  it('passes through host:port unchanged', () => {
    expect(canonicalizeEndpoint('192.168.1.5:8800')).toBe('192.168.1.5:8800');
  });

  it('fills in default port 8800 when absent', () => {
    expect(canonicalizeEndpoint('192.168.1.5')).toBe('192.168.1.5:8800');
  });

  it('preserves explicit non-default port', () => {
    expect(canonicalizeEndpoint('192.168.1.5:1044')).toBe('192.168.1.5:1044');
  });

  it('rejects 0.0.0.0 wildcard', () => {
    expect(() => canonicalizeEndpoint('0.0.0.0:8800')).toThrow(EndpointParseError);
    expect(() => canonicalizeEndpoint('0.0.0.0')).toThrow(EndpointParseError);
  });
});

describe('canonicalizeEndpoint — IPv6', () => {
  it('canonicalizes RFC 5952 — collapses zero runs, lowercase', () => {
    expect(canonicalizeEndpoint('[2A11:6C7:0:0:0:0:0:11]:1044')).toBe('[2a11:6c7::11]:1044');
  });

  it('preserves already-canonical RFC 5952 form', () => {
    expect(canonicalizeEndpoint('[2a11:6c7::11]:8800')).toBe('[2a11:6c7::11]:8800');
  });

  it('fills in default port for bracketed IPv6 without port', () => {
    expect(canonicalizeEndpoint('[2a11:6c7::11]')).toBe('[2a11:6c7::11]:8800');
  });

  it('lowercases mixed-case hex digits', () => {
    expect(canonicalizeEndpoint('[2A11:6C7::ABcD]:1044')).toBe('[2a11:6c7::abcd]:1044');
  });

  it('rejects :: wildcard', () => {
    expect(() => canonicalizeEndpoint('[::]:8800')).toThrow(EndpointParseError);
    expect(() => canonicalizeEndpoint('[::]')).toThrow(EndpointParseError);
  });

  it('rejects malformed brackets — missing closing', () => {
    expect(() => canonicalizeEndpoint('[2a11:6c7::11')).toThrow(EndpointParseError);
  });

  it('rejects unbracketed IPv6 with port (ambiguous)', () => {
    expect(() => canonicalizeEndpoint('2a11:6c7::11:1044')).toThrow(EndpointParseError);
  });

  it('rejects bare unbracketed IPv6 (no port) — must be bracketed', () => {
    expect(() => canonicalizeEndpoint('2a11:6c7::11')).toThrow(EndpointParseError);
    expect(() => canonicalizeEndpoint('::1')).toThrow(EndpointParseError);
  });
});

describe('canonicalizeEndpoint — hostname', () => {
  it('lowercases the hostname and fills in default port', () => {
    expect(canonicalizeEndpoint('Node-B.example.com')).toBe('node-b.example.com:8800');
  });

  it('preserves an explicit port', () => {
    expect(canonicalizeEndpoint('Node-B.example.com:1044')).toBe('node-b.example.com:1044');
  });

  it('rejects a wildcard hostname', () => {
    expect(() => canonicalizeEndpoint('*:8800')).toThrow(EndpointParseError);
    expect(() => canonicalizeEndpoint('*')).toThrow(EndpointParseError);
  });

  it('rejects an empty host', () => {
    expect(() => canonicalizeEndpoint(':8800')).toThrow(EndpointParseError);
  });
});

describe('canonicalizeEndpoint — port validation', () => {
  it('rejects port 0', () => {
    expect(() => canonicalizeEndpoint('192.168.1.5:0')).toThrow(EndpointParseError);
  });

  it('rejects port > 65535', () => {
    expect(() => canonicalizeEndpoint('192.168.1.5:65536')).toThrow(EndpointParseError);
  });

  it('rejects non-numeric port', () => {
    expect(() => canonicalizeEndpoint('192.168.1.5:abc')).toThrow(EndpointParseError);
  });
});

describe('canonicalizeEndpoint — empty input', () => {
  it('rejects empty string', () => {
    expect(() => canonicalizeEndpoint('')).toThrow(EndpointParseError);
  });

  it('rejects whitespace-only input', () => {
    expect(() => canonicalizeEndpoint('   ')).toThrow(EndpointParseError);
  });
});

describe('EndpointParseError', () => {
  it('has a `path` field for parser context', () => {
    try {
      canonicalizeEndpoint('0.0.0.0:8800');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EndpointParseError);
      expect((err as EndpointParseError).path).toBeTypeOf('string');
    }
  });
});
