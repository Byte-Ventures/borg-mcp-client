import { describe, it, expect } from 'vitest';
import { validateName } from '../src/name-validator';

describe('validateName', () => {
  it('accepts lowercase letters, digits, hyphens, underscores', () => {
    expect(validateName('builder')).toEqual({ ok: true });
    expect(validateName('drone-2')).toEqual({ ok: true });
    expect(validateName('code_reviewer')).toEqual({ ok: true });
    expect(validateName('a1b2c3')).toEqual({ ok: true });
  });

  it('rejects empty string', () => {
    const r = validateName('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('must not be empty');
  });

  it('rejects leading hyphen (would parse as flag)', () => {
    const r = validateName('-foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('must not start with a hyphen');
  });

  it('accepts leading underscore and leading digit', () => {
    expect(validateName('_foo')).toEqual({ ok: true });
    expect(validateName('1foo')).toEqual({ ok: true });
  });

  it('rejects uppercase, spaces, dots, slashes', () => {
    expect(validateName('Builder').ok).toBe(false);
    expect(validateName('builder one').ok).toBe(false);
    expect(validateName('builder.one').ok).toBe(false);
    expect(validateName('../etc/passwd').ok).toBe(false);
    expect(validateName('foo/bar').ok).toBe(false);
  });

  it('enforces 48-char length cap', () => {
    expect(validateName('a'.repeat(48))).toEqual({ ok: true });
    expect(validateName('a'.repeat(49)).ok).toBe(false);
  });
});
