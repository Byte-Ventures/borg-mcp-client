/**
 * gh#673 P1: the borg-launch activation gate (WI-4 + WI-5-claude).
 *
 * The `borg` wrapper sets BORG_SESSION=1 in the agent's launch env; the
 * MCP server (CallTool) and the hook bins (borg-regen, borg-clear-rewake,
 * borg-log-audit) activate only when it is present. SR-BINDING (1482e7f9): this is an
 * ACTIVATION gate only — user-settable by design (manual BORG_SESSION=1
 * is a supported override) and never consulted for any access/security
 * decision; server-side auth is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { isBorgSession, borgSessionToolNotice } from '../src/launch-gate.js';

describe('isBorgSession', () => {
  it('on when BORG_SESSION=1 (the wrapper-set value)', () => {
    expect(isBorgSession({ BORG_SESSION: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('off when unset (vanilla claude/codex session)', () => {
    expect(isBorgSession({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('follows the BORG_* falsy-spelling convention (auth-env envToggleOn)', () => {
    for (const v of ['0', 'false', 'no', '', '  ']) {
      expect(isBorgSession({ BORG_SESSION: v } as NodeJS.ProcessEnv)).toBe(false);
    }
    for (const v of ['1', 'true', 'yes', 'on']) {
      expect(isBorgSession({ BORG_SESSION: v } as NodeJS.ProcessEnv)).toBe(true);
    }
  });
});

describe('borgSessionToolNotice', () => {
  it('names the refused tool and directs to a borg launch — non-silent, never a half-success', () => {
    const msg = borgSessionToolNotice('borg_regen');
    expect(msg).toContain('borg_regen');
    expect(msg).toMatch(/launched via `?borg`?|launched with `?borg`?/i);
    expect(msg).toMatch(/borg assimilate|`borg`/);
  });

  it('explains the vanilla-session state rather than implying an error in the cube', () => {
    const msg = borgSessionToolNotice('borg_log');
    expect(msg).toMatch(/this session/i);
    expect(msg).not.toMatch(/error|failed|broken/i);
  });
});
