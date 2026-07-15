/**
 * gh#853 — bare `borg` (no-args) interactive launch menu.
 *
 * The menu's option-set + selection→action mapping + show/collapse decision are
 * factored into PURE, deps-injected functions so they're unit-testable without a
 * real TTY. claude.ts main() is thin glue: compute the three inputs (default cli,
 * other-installed cli, launch-all targets), gate on shouldShowLaunchMenu, then
 * dispatch the returned action.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildLaunchMenuOptions,
  explicitCliLaunchHint,
  resolveLaunchMenuChoice,
  runBareLaunchMenu,
  shouldResolveExplicitCliLaunchHintTargets,
  shouldShowLaunchMenu,
} from '../src/bare-launch-menu';

describe('gh#853 — shouldShowLaunchMenu (gate: bare-borg + TTY only)', () => {
  it('bare borg + both streams TTY → show', () => {
    expect(shouldShowLaunchMenu({ extraArgs: [], stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
  });

  it('non-TTY (stdin OR stdout) → no menu (scripted/programmatic borg unchanged)', () => {
    expect(shouldShowLaunchMenu({ extraArgs: [], stdinIsTTY: false, stdoutIsTTY: true })).toBe(false);
    expect(shouldShowLaunchMenu({ extraArgs: [], stdinIsTTY: true, stdoutIsTTY: false })).toBe(false);
  });

  it('any explicit args/flags → no menu (only bare borg triggers it)', () => {
    expect(shouldShowLaunchMenu({ extraArgs: ['--resume'], stdinIsTTY: true, stdoutIsTTY: true })).toBe(false);
    expect(shouldShowLaunchMenu({ extraArgs: ['somePrompt'], stdinIsTTY: true, stdoutIsTTY: true })).toBe(false);
  });
});

describe('gh#967 — explicit --cli launch-all hint', () => {
  it('resolves launch-all targets only when an explicit --cli hint could be shown', () => {
    expect(shouldResolveExplicitCliLaunchHintTargets({
      explicitCli: 'codex',
      stdinIsTTY: true,
      stdoutIsTTY: true,
      hasActiveCube: true,
    })).toBe(true);

    expect(shouldResolveExplicitCliLaunchHintTargets({
      explicitCli: undefined,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      hasActiveCube: true,
    })).toBe(false);
    expect(shouldResolveExplicitCliLaunchHintTargets({
      explicitCli: 'codex',
      stdinIsTTY: false,
      stdoutIsTTY: true,
      hasActiveCube: true,
    })).toBe(false);
    expect(shouldResolveExplicitCliLaunchHintTargets({
      explicitCli: 'codex',
      stdinIsTTY: true,
      stdoutIsTTY: false,
      hasActiveCube: true,
    })).toBe(false);
    expect(shouldResolveExplicitCliLaunchHintTargets({
      explicitCli: 'codex',
      stdinIsTTY: true,
      stdoutIsTTY: true,
      hasActiveCube: false,
    })).toBe(false);
  });

  it('emits a hint only for interactive explicit --cli launches in an active cube with launch-all targets', () => {
    expect(explicitCliLaunchHint({
      explicitCli: 'codex',
      stdinIsTTY: true,
      stdoutIsTTY: true,
      hasActiveCube: true,
      hasLaunchAllTargets: true,
    })).toBe(
      'borg --cli codex launches Codex directly; use bare borg for the launch menu or borg launch-all --cli codex for all drone worktrees.\n'
    );

    expect(explicitCliLaunchHint({
      explicitCli: undefined,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      hasActiveCube: true,
      hasLaunchAllTargets: true,
    })).toBeNull();
    expect(explicitCliLaunchHint({
      explicitCli: 'codex',
      stdinIsTTY: false,
      stdoutIsTTY: true,
      hasActiveCube: true,
      hasLaunchAllTargets: true,
    })).toBeNull();
    expect(explicitCliLaunchHint({
      explicitCli: 'codex',
      stdinIsTTY: true,
      stdoutIsTTY: true,
      hasActiveCube: false,
      hasLaunchAllTargets: true,
    })).toBeNull();
    expect(explicitCliLaunchHint({
      explicitCli: 'codex',
      stdinIsTTY: true,
      stdoutIsTTY: true,
      hasActiveCube: true,
      hasLaunchAllTargets: false,
    })).toBeNull();
  });
});

describe('gh#853 — buildLaunchMenuOptions (context-aware option set)', () => {
  it('option 1 (launch default) is always present and names the default cli', () => {
    const opts = buildLaunchMenuOptions({ defaultCli: 'claude', otherInstalledClis: [], hasLaunchAllTargets: false });
    expect(opts).toHaveLength(1);
    expect(opts[0].key).toBe('1');
    expect(opts[0].action).toEqual({ kind: 'launch', cli: 'claude' });
    expect(opts[0].label).toContain('Claude');
  });

  it('each installed non-default agent gets its own option; launches it one-shot', () => {
    const withOther = buildLaunchMenuOptions({ defaultCli: 'claude', otherInstalledClis: ['codex'], hasLaunchAllTargets: false });
    const opt2 = withOther.find((o) => o.action.kind === 'launch' && o.action.cli === 'codex');
    expect(opt2).toBeDefined();
    expect(opt2!.label).toContain('Codex');
    // not shown when the other agent isn't installed
    const noOther = buildLaunchMenuOptions({ defaultCli: 'claude', otherInstalledClis: [], hasLaunchAllTargets: false });
    expect(noOther.some((o) => o.action.kind === 'launch' && o.action.cli === 'codex')).toBe(false);
  });

  it('when multiple other agents are installed, each gets a sequential option', () => {
    const opts = buildLaunchMenuOptions({ defaultCli: 'claude', otherInstalledClis: ['codex', 'opencode'], hasLaunchAllTargets: false });
    expect(opts).toHaveLength(3);
    expect(opts[0].key).toBe('1');
    expect(opts[0].action).toEqual({ kind: 'launch', cli: 'claude' });
    expect(opts[1].key).toBe('2');
    expect(opts[1].action).toEqual({ kind: 'launch', cli: 'codex' });
    expect(opts[2].key).toBe('3');
    expect(opts[2].action).toEqual({ kind: 'launch', cli: 'opencode' });
  });

  it('option shown only when there are launch-all targets', () => {
    const withTargets = buildLaunchMenuOptions({ defaultCli: 'codex', otherInstalledClis: [], hasLaunchAllTargets: true });
    expect(withTargets.some((o) => o.action.kind === 'launch-all')).toBe(true);
    const noTargets = buildLaunchMenuOptions({ defaultCli: 'codex', otherInstalledClis: [], hasLaunchAllTargets: false });
    expect(noTargets.some((o) => o.action.kind === 'launch-all')).toBe(false);
  });

  it('keys are sequential (no gaps) regardless of which options are hidden', () => {
    // no others, launch-all present → launch-all gets key "2", not "3" (no gap menu).
    const opts = buildLaunchMenuOptions({ defaultCli: 'claude', otherInstalledClis: [], hasLaunchAllTargets: true });
    expect(opts.map((o) => o.key)).toEqual(['1', '2']);
    expect(opts[1].action).toEqual({ kind: 'launch-all' });
    // one other + launch-all → 1,2,3
    const threeOpts = buildLaunchMenuOptions({ defaultCli: 'claude', otherInstalledClis: ['codex'], hasLaunchAllTargets: true });
    expect(threeOpts.map((o) => o.key)).toEqual(['1', '2', '3']);
    // two others + launch-all → 1,2,3,4
    const fourOpts = buildLaunchMenuOptions({ defaultCli: 'claude', otherInstalledClis: ['codex', 'opencode'], hasLaunchAllTargets: true });
    expect(fourOpts.map((o) => o.key)).toEqual(['1', '2', '3', '4']);
  });
});

describe('gh#853 — resolveLaunchMenuChoice (selection → action)', () => {
  const options = buildLaunchMenuOptions({ defaultCli: 'claude', otherInstalledClis: ['codex'], hasLaunchAllTargets: true });

  it('empty input / Enter → option 1 (default)', () => {
    expect(resolveLaunchMenuChoice(options, '')).toEqual({ ok: true, action: { kind: 'launch', cli: 'claude' } });
    expect(resolveLaunchMenuChoice(options, '   ')).toEqual({ ok: true, action: { kind: 'launch', cli: 'claude' } });
  });

  it('key "2" → other-agent launch; "3" → launch-all', () => {
    expect(resolveLaunchMenuChoice(options, '2')).toEqual({ ok: true, action: { kind: 'launch', cli: 'codex' } });
    expect(resolveLaunchMenuChoice(options, '3')).toEqual({ ok: true, action: { kind: 'launch-all' } });
  });

  it('out-of-range / non-numeric → not ok (caller re-prompts)', () => {
    expect(resolveLaunchMenuChoice(options, '9').ok).toBe(false);
    expect(resolveLaunchMenuChoice(options, 'x').ok).toBe(false);
  });
});

describe('gh#853 — runBareLaunchMenu (orchestration)', () => {
  it('collapses to a direct default launch (NO prompt) when only option 1 applies', async () => {
    const prompt = vi.fn(async () => '');
    const action = await runBareLaunchMenu(
      { defaultCli: 'claude', otherInstalledClis: [], hasLaunchAllTargets: false },
      prompt
    );
    expect(action).toEqual({ kind: 'launch', cli: 'claude' });
    expect(prompt).not.toHaveBeenCalled(); // never render a 1-item menu
  });

  it('renders + maps the selection when there is a real choice', async () => {
    const prompt = vi.fn(async () => '2');
    const action = await runBareLaunchMenu(
      { defaultCli: 'claude', otherInstalledClis: ['codex'], hasLaunchAllTargets: true },
      prompt
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(action).toEqual({ kind: 'launch', cli: 'codex' });
  });

  it('re-prompts on invalid input, then accepts a valid one', async () => {
    const prompt = vi.fn().mockResolvedValueOnce('9').mockResolvedValueOnce('3');
    const action = await runBareLaunchMenu(
      { defaultCli: 'claude', otherInstalledClis: ['codex'], hasLaunchAllTargets: true },
      prompt
    );
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(action).toEqual({ kind: 'launch-all' });
  });

  it('exhausting attempts falls back to the safe default (option 1)', async () => {
    const prompt = vi.fn(async () => 'nonsense');
    const action = await runBareLaunchMenu(
      { defaultCli: 'codex', otherInstalledClis: ['claude'], hasLaunchAllTargets: false },
      prompt,
      { maxAttempts: 2 }
    );
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(action).toEqual({ kind: 'launch', cli: 'codex' });
  });
});
