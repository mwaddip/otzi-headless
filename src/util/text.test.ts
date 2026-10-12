import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { displayText, errorReason, shellQuote } from './text';

describe('displayText', () => {
  it('leaves ordinary text, including non-ASCII, as it is', () => {
    expect(displayText('cold storage #1 — Ötzi ₿ 冷')).toBe('cold storage #1 — Ötzi ₿ 冷');
    expect(displayText('')).toBe('');
  });

  it('removes every C0 and C1 control character except tab and line breaks', () => {
    const codes = [...Array.from({ length: 0x20 }, (_, i) => i), ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i)];
    const controls = codes.filter(c => c !== 0x09 && c !== 0x0a && c !== 0x0d).map(c => String.fromCharCode(c));
    expect(controls).toHaveLength(62);
    for (const ch of controls) {
      expect(displayText(`x${ch}y`), `U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).toBe('xy');
    }
    expect(displayText(controls.join(''))).toBe('');
  });

  it('turns tabs and line breaks into one space each run, so one-line output stays on one line', () => {
    expect(displayText('a\tb')).toBe('a b');
    expect(displayText('a\r\nb\n\nc')).toBe('a b c');
    expect(displayText('\nlead and trail\t')).toBe(' lead and trail ');
  });

  it('defuses terminal escape sequences', () => {
    const shown = displayText('\u001b[2J\u001b]0;title\u0007\u009b31mred');
    expect(shown).toBe('[2J]0;title31mred');
    expect(shown).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe('errorReason', () => {
  it('is the message of an Error and the text of anything else', () => {
    expect(errorReason(new Error('boom'))).toBe('boom');
    expect(errorReason('plain')).toBe('plain');
    expect(errorReason(42)).toBe('42');
  });

  it('digs the connection error out from behind fetch failed', () => {
    const viaMessage = new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:1') });
    expect(errorReason(viaMessage)).toBe('connect ECONNREFUSED 127.0.0.1:1');
    const viaCode = new Error('fetch failed', { cause: { code: 'ENOTFOUND' } });
    expect(errorReason(viaCode)).toBe('ENOTFOUND');
    expect(errorReason(new Error('fetch failed'))).toBe('fetch failed');
    expect(errorReason(new Error('other', { cause: new Error('hidden') }))).toBe('other');
  });
});

describe('shellQuote', () => {
  it('wraps a word in single quotes', () => {
    expect(shellQuote('/var/lib/otzi/share.json')).toBe("'/var/lib/otzi/share.json'");
    expect(shellQuote('')).toBe("''");
  });

  it('closes, escapes and reopens the quotes around an embedded single quote', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it.each([
    ['a path with a space', '/tmp/my dir/share.json'],
    ['a path with a single quote', "/tmp/it's/share.json"],
    ['a path with both', "/tmp/it's a dir/sha're.json"],
    ['shell metacharacters', '/tmp/$(touch pwned);`id`|&<>*?[x]\\"#~!/f'],
    ['leading dashes', '--no-dereference'],
  ])('reads back as the one word it was given by a real shell: %s', (_name, word) => {
    const out = execFileSync('sh', ['-c', `printf '%s\\0' ${shellQuote(word)} ${shellQuote('x y')}`], { encoding: 'utf8' });
    expect(out.split('\0').slice(0, 2)).toEqual([word, 'x y']);
  });
});
