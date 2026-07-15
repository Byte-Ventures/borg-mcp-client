import { describe, expect, it } from 'vitest';
import { KNOWN_SUBCOMMANDS, unknownSubcommand } from '../src/unknown-subcommand';

describe('unknownSubcommand (gh#911)', () => {
  it('returns null for bare `borg` (no argv[2])', () => {
    expect(unknownSubcommand(undefined)).toBeNull();
  });

  it('returns null for every known subcommand (falls through to its handler)', () => {
    for (const cmd of KNOWN_SUBCOMMANDS) {
      expect(unknownSubcommand(cmd)).toBeNull();
    }
  });

  it('returns null for flags (handled downstream / passed through to the agent)', () => {
    expect(unknownSubcommand('--cli')).toBeNull();
    expect(unknownSubcommand('--remote')).toBeNull();
    expect(unknownSubcommand('-h')).toBeNull();
    expect(unknownSubcommand('--debug')).toBeNull();
  });

  it('returns the offending command for an unknown non-flag positional (the footgun)', () => {
    // the exact gh#911 repro: `borg evict-drone X` launched an agent with prompt "evict-drone"
    expect(unknownSubcommand('evict-drone')).toBe('evict-drone');
    // a typo of a real subcommand
    expect(unknownSubcommand('asimilate')).toBe('asimilate');
    expect(unknownSubcommand('bogus')).toBe('bogus');
  });
});
