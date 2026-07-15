/**
 * gh#780 option (ii): the in-session borg_assimilate MCP tool is
 * RE-ATTACH-ONLY (Queen ruling 33a62d94). The decision module classifies a
 * request against the worktree's saved identity (cubes.json):
 *
 *   - saved identity matches the requested cube  → reattach (NO mint)
 *   - no identity for this worktree              → refuse, direct to CLI
 *   - identity exists but a DIFFERENT cube asked → refuse, direct to CLI
 *
 * The tool must be structurally INCAPABLE of POSTing /api/assimilate —
 * minting is the CLI's job, where worktree spawn + identity persistence
 * are handled coherently.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyInSessionAssimilate,
  reattachOnlyRefusal,
  reattachFailureMessage,
} from '../src/assimilate-guard.js';

const active = {
  cubeId: 'cube-1',
  droneId: 'drone-1',
  name: 'borg-mcp',
  sessionToken: 'tok',
  droneLabel: 'two-of-seventeen-builder',
  apiUrl: 'https://api.example',
};

describe('classifyInSessionAssimilate', () => {
  it('matching cube name → reattach', () => {
    expect(classifyInSessionAssimilate(active, 'borg-mcp')).toEqual({ kind: 'reattach' });
  });

  it('match is whitespace/case tolerant (cube names are lowercase server-side)', () => {
    expect(classifyInSessionAssimilate(active, '  Borg-MCP ')).toEqual({ kind: 'reattach' });
  });

  it('no saved identity for the worktree → no-identity', () => {
    expect(classifyInSessionAssimilate(null, 'borg-mcp')).toEqual({ kind: 'no-identity' });
  });

  it('different cube requested → different-cube with the active name', () => {
    expect(classifyInSessionAssimilate(active, 'other-cube')).toEqual({
      kind: 'different-cube',
      activeCubeName: 'borg-mcp',
    });
  });
});

describe('reattachOnlyRefusal', () => {
  it('no-identity refusal directs to the CLI and never suggests an in-session mint', () => {
    const msg = reattachOnlyRefusal({ kind: 'no-identity' }, 'somecube');
    expect(msg).toMatch(/borg assimilate/);
    expect(msg).toMatch(/terminal/i);
    expect(msg).toMatch(/re-?attach/i);
  });

  it('different-cube refusal names both cubes and directs to a separate worktree/CLI', () => {
    const msg = reattachOnlyRefusal(
      { kind: 'different-cube', activeCubeName: 'borg-mcp' },
      'other-cube'
    );
    expect(msg).toContain('borg-mcp');
    expect(msg).toContain('other-cube');
    expect(msg).toMatch(/terminal|worktree/i);
  });
});

describe('reattachFailureMessage', () => {
  it('auth-class failures return null so the auth funnel owns the advice', () => {
    expect(
      reattachFailureMessage({ message: 'Authentication required. Run: borg setup' })
    ).toBeNull();
    expect(
      reattachFailureMessage({ name: 'RefreshTransientError', message: 'Failed to refresh' })
    ).toBeNull();
  });

  it('non-auth failures surface seat-unreachable guidance without re-minting advice', () => {
    const msg = reattachFailureMessage({ message: 'HTTP 403: drone session not found' });
    expect(msg).toMatch(/seat/i);
    expect(msg).toMatch(/borg assimilate/);
    expect(msg).toMatch(/terminal/i);
    expect(msg).toContain('HTTP 403: drone session not found');
  });
});
