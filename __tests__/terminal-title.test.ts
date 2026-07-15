/**
 * Tests for the borg terminal-title setter.
 *
 * Split by surface:
 *   - composeTerminalTitle: pure title-string composition. Tests both
 *     branches (assimilated / unassimilated) and the exact separator /
 *     prefix shape drone-4 UX-APPROVED at 19:09:55.
 *   - setTerminalTitle: side-effecting wrapper. Tests TTY gating
 *     (escape only emitted when stdout.isTTY === true) and the
 *     return-value-regardless-of-tty contract.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  composeTerminalTitle,
  setTerminalTitle,
} from '../src/terminal-title';

describe('composeTerminalTitle', () => {
  it('assimilated drone format: `borg · <label> · <cubeName>`', () => {
    expect(
      composeTerminalTitle({ label: 'drone-7', cubeName: 'borg-mcp' }, 'irrelevant')
    ).toBe('borg · drone-7 · borg-mcp');
  });

  it('unassimilated session: `borg · <repo-basename>`', () => {
    expect(composeTerminalTitle(null, 'borg-mcp-ux')).toBe('borg · borg-mcp-ux');
  });

  it('repo-basename is ignored when activeDrone is present', () => {
    expect(
      composeTerminalTitle(
        { label: 'drone-5', cubeName: 'borg-mcp' },
        'this-is-ignored'
      )
    ).toBe('borg · drone-5 · borg-mcp');
  });

  it('uses middle-dot (U+00B7) separators verbatim', () => {
    // Defense against a future refactor accidentally switching the
    // separator to em-dash or pipe — drone-4 UX-APPROVED the
    // specific glyph at 19:09:55. Asserts byte-exact rendering.
    const t = composeTerminalTitle(
      { label: 'drone-1', cubeName: 'borg-mcp' },
      'whatever'
    );
    expect(t).toContain('·');
    expect(t.split('·')).toHaveLength(3);
  });
});

describe('setTerminalTitle', () => {
  function makeStdout(isTTY: boolean) {
    const writes: string[] = [];
    const stdout = {
      isTTY,
      write: vi.fn((s: any) => {
        writes.push(String(s));
        return true;
      }),
    } as unknown as NodeJS.WriteStream;
    return { stdout, writes };
  }

  it('emits OSC 0 escape when stdout is a TTY', () => {
    const { stdout, writes } = makeStdout(true);
    setTerminalTitle(
      { label: 'drone-7', cubeName: 'borg-mcp' },
      'fallback',
      stdout
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('\x1b]0;borg · drone-7 · borg-mcp\x07');
  });

  it('no-ops when stdout is NOT a TTY (piped / CI)', () => {
    const { stdout, writes } = makeStdout(false);
    setTerminalTitle(
      { label: 'drone-7', cubeName: 'borg-mcp' },
      'fallback',
      stdout
    );
    expect(writes).toHaveLength(0);
  });

  it('returns the composed title regardless of TTY state', () => {
    // Diagnostic / logging callers may want the title even when the
    // escape was not emitted. Both paths return the same string.
    const { stdout: ttyOut } = makeStdout(true);
    const { stdout: notTtyOut } = makeStdout(false);
    const ttyTitle = setTerminalTitle(
      { label: 'drone-3', cubeName: 'borg-mcp' },
      'fallback',
      ttyOut
    );
    const notTtyTitle = setTerminalTitle(
      { label: 'drone-3', cubeName: 'borg-mcp' },
      'fallback',
      notTtyOut
    );
    expect(ttyTitle).toBe('borg · drone-3 · borg-mcp');
    expect(notTtyTitle).toBe('borg · drone-3 · borg-mcp');
  });

  it('renders the unassimilated branch via the stream when TTY', () => {
    const { stdout, writes } = makeStdout(true);
    setTerminalTitle(null, 'borg-mcp-builder', stdout);
    expect(writes[0]).toBe('\x1b]0;borg · borg-mcp-builder\x07');
  });
});
