import { describe, it, expect } from 'vitest';
import { shellEscape } from '../src/shell-escape';

describe('shellEscape (Sprint 18, paste-safe path quoting)', () => {
  it('wraps plain paths in single-quotes', () => {
    expect(shellEscape('/work/myrepo')).toBe(`'/work/myrepo'`);
  });

  it('handles spaces in paths (most common edge case)', () => {
    expect(shellEscape('/Users/Jane Doe/myrepo')).toBe(`'/Users/Jane Doe/myrepo'`);
  });

  it('defangs $VAR (single-quotes prevent expansion)', () => {
    // Single-quoted strings in POSIX shells do NOT expand $variables.
    expect(shellEscape('/Users/foo/$HOME/repo')).toBe(`'/Users/foo/$HOME/repo'`);
  });

  it('defangs backtick command substitution', () => {
    expect(shellEscape('/Users/foo/`hostname`/repo')).toBe(`'/Users/foo/\`hostname\`/repo'`);
  });

  it('defangs $() command substitution', () => {
    expect(shellEscape('/Users/foo/$(curl evil.com)/repo')).toBe(`'/Users/foo/$(curl evil.com)/repo'`);
  });

  it('escapes embedded single-quote as close+escape+reopen', () => {
    // POSIX-standard pattern: ' → '\''. Reads as close-quote, escaped-quote,
    // reopen-quote. The full output `'O'\''Brien'` evaluates back to O'Brien.
    expect(shellEscape(`/Users/O'Brien/repo`)).toBe(`'/Users/O'\\''Brien/repo'`);
  });

  it('handles multiple embedded single-quotes', () => {
    expect(shellEscape(`a'b'c`)).toBe(`'a'\\''b'\\''c'`);
  });

  it('wraps empty string as empty single-quoted pair', () => {
    expect(shellEscape('')).toBe(`''`);
  });

  it('handles paths with semicolons (would otherwise split commands)', () => {
    expect(shellEscape('/Users/foo/work; rm -rf /')).toBe(`'/Users/foo/work; rm -rf /'`);
  });

  it('handles paths with pipe characters', () => {
    expect(shellEscape('/Users/foo/work | evil')).toBe(`'/Users/foo/work | evil'`);
  });
});
