import { describe, expect, it } from 'vitest';
import {
  normalizeSetupAgentSelection,
  resolveSetupAgentSelection,
  setupAgentChoices,
  setupRestartInstruction,
} from '../src/setup-selection';

describe('borg setup agent selection', () => {
  it('offers only detected CLIs and pre-checks every one', () => {
    expect(setupAgentChoices(['claude', 'opencode'])).toEqual([
      { title: 'Claude Code', value: 'claude', selected: true },
      { title: 'OpenCode', value: 'opencode', selected: true },
    ]);
  });

  it('marks a fully configured CLI as non-actionable in a partial install', () => {
    expect(setupAgentChoices(['claude', 'codex'], new Set(['claude']))).toEqual([
      { title: 'Claude Code (already configured)', value: 'claude', selected: false, disabled: true },
      { title: 'Codex', value: 'codex', selected: true },
    ]);
  });

  it('preserves detected order while filtering deselected and unknown values', () => {
    expect(normalizeSetupAgentSelection(
      ['claude', 'codex', 'opencode'],
      ['opencode', 'not-a-cli', 'claude', 'claude'],
    )).toEqual(['claude', 'opencode']);
  });

  it('keeps an explicit zero selection empty without inventing a persisted choice', () => {
    expect(normalizeSetupAgentSelection(['claude', 'codex'], [])).toEqual([]);
    expect(normalizeSetupAgentSelection(['claude', 'codex'], undefined)).toEqual([]);
  });

  it('turns Esc into cancellation before any caller-owned mutation', () => {
    expect(resolveSetupAgentSelection(['claude'], ['claude'], true)).toEqual({ kind: 'cancelled' });
  });

  it('gives zero selected agents a distinct outcome from cancellation', () => {
    expect(resolveSetupAgentSelection(['claude', 'codex'], [])).toEqual({ kind: 'empty' });
  });

  it('derives restart guidance from the selected agent set', () => {
    expect(setupRestartInstruction(['codex', 'opencode'])).toBe(
      '🔄 Restart Codex / OpenCode (or open a new session) for the changes to take effect.',
    );
  });
});
