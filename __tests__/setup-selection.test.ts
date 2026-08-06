import { describe, expect, it } from 'vitest';
import {
  normalizeSetupAgentSelection,
  resolveSetupAgentSelection,
  setupAgentChoices,
} from '../src/setup-selection';

describe('borg setup agent selection', () => {
  it('offers only detected CLIs and pre-checks every one', () => {
    expect(setupAgentChoices(['claude', 'opencode'])).toEqual([
      { title: 'Claude Code', value: 'claude', selected: true },
      { title: 'OpenCode', value: 'opencode', selected: true },
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
});
