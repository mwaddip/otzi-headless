import { describe, it, expect } from 'vitest';
import { slugify } from './slugify.js';

describe('slugify', () => {
  it('lowercases and replaces spaces with dashes', () => {
    expect(slugify('My Vault')).toBe('my-vault');
  });

  it('strips non-alphanumeric characters', () => {
    expect(slugify('PERMAFROST Vault!@#')).toBe('permafrost-vault');
  });

  it('collapses runs of separators', () => {
    expect(slugify('foo   bar___baz')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('  --foo--  ')).toBe('foo');
  });

  it('returns the fallback for empty input', () => {
    expect(slugify('')).toBe('manifest');
    expect(slugify('   ')).toBe('manifest');
    expect(slugify('!!!')).toBe('manifest');
  });

  it('handles unicode by stripping non-ascii', () => {
    expect(slugify('Ötzi Vault')).toBe('tzi-vault');
  });

  it('truncates very long names to 64 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBe(64);
  });
});
