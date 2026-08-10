/**
 * gh#853 — bare `borg` (no-args) interactive launch menu.
 *
 * The menu's option-set + selection→action mapping + show/collapse decision are
 * factored into deps-injected functions so they're unit-testable without a real
 * TTY. claude.ts main() supplies the saved-seat and launch dependencies, gates
 * on shouldShowLaunchMenu, then dispatches the returned action.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildLaunchMenuOptions,
  configureSelectedLaunchCli,
  discoverLiveLaunchMenuCandidates,
  isMainGitWorktree,
  resolveLaunchMenuChoice,
  runBareLaunchMenu,
  shouldShowLaunchMenu,
} from '../src/bare-launch-menu';

describe('gh#853 — main-worktree launch-menu gate', () => {
  it('identifies the main worktree from git-dir/common-dir equality', () => {
    const main = vi.fn((args: string[]) => args.includes('--git-dir') ? '/repo/.git\n' : '/repo/.git\n');
    const linked = vi.fn((args: string[]) =>
      args.includes('--git-dir') ? '/repo/.git/worktrees/reviewer\n' : '/repo/.git\n'
    );

    expect(isMainGitWorktree(main)).toBe(true);
    expect(isMainGitWorktree(linked)).toBe(false);
    expect(isMainGitWorktree(() => { throw new Error('not a repository'); })).toBe(false);
  });

  it('wires the Git worktree probe and legacy current drone into the launcher menu', () => {
    const source = readFileSync(new URL('../src/claude.ts', import.meta.url), 'utf8');
    const probe = source.indexOf('const isMainWorktree = isMainGitWorktree');
    const gate = source.indexOf('shouldShowLaunchMenu({', probe);
    const gateInput = source.indexOf('isMainWorktree,', gate);
    const currentDroneInput = source.indexOf('currentDrone:', gate);

    expect(probe).toBeGreaterThan(0);
    expect(source.indexOf("launchAllDeps.runSync('git'", probe)).toBeGreaterThan(probe);
    expect(gate).toBeGreaterThan(probe);
    expect(gateInput).toBeGreaterThan(gate);
    expect(currentDroneInput).toBeGreaterThan(gateInput);
  });

  it('bare borg + both streams TTY + main worktree → show', () => {
    expect(shouldShowLaunchMenu({
      extraArgs: [],
      stdinIsTTY: true,
      stdoutIsTTY: true,
      isMainWorktree: true,
    })).toBe(true);
  });

  it('non-TTY (stdin OR stdout) → no menu (scripted/programmatic borg unchanged)', () => {
    expect(shouldShowLaunchMenu({ extraArgs: [], stdinIsTTY: false, stdoutIsTTY: true, isMainWorktree: true })).toBe(false);
    expect(shouldShowLaunchMenu({ extraArgs: [], stdinIsTTY: true, stdoutIsTTY: false, isMainWorktree: true })).toBe(false);
  });

  it('any explicit args/flags → no menu (only bare borg triggers it)', () => {
    expect(shouldShowLaunchMenu({ extraArgs: ['--resume'], stdinIsTTY: true, stdoutIsTTY: true, isMainWorktree: true })).toBe(false);
    expect(shouldShowLaunchMenu({ extraArgs: ['somePrompt'], stdinIsTTY: true, stdoutIsTTY: true, isMainWorktree: true })).toBe(false);
  });

  it('a linked worktree launches its saved drone directly without showing the menu', () => {
    expect(shouldShowLaunchMenu({
      extraArgs: [],
      stdinIsTTY: true,
      stdoutIsTTY: true,
      isMainWorktree: false,
    })).toBe(false);
  });
});

describe('client#362 — live sibling drone discovery', () => {
  const ALPHA_ID = '11111111-1111-4111-8111-111111111111';
  const BETA_ID = '22222222-2222-4222-8222-222222222222';
  const EVICTED_ID = '33333333-3333-4333-8333-333333333333';
  const PENDING_ID = '44444444-4444-4444-8444-444444444444';
  const MISSING_ID = '55555555-5555-4555-8555-555555555555';
  const CUBE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('keeps only linked, present, active, non-terminal sibling seats', async () => {
    const identities = [
      { projectPath: '/repo/beta', cube: { cubeId: CUBE_ID, droneId: BETA_ID, droneLabel: 'beta', name: 'my-cube' } },
      { projectPath: '/repo/alpha', cube: { cubeId: CUBE_ID, droneId: ALPHA_ID, droneLabel: 'alpha', name: 'my-cube' } },
      { projectPath: '/repo/evicted', cube: { cubeId: CUBE_ID, droneId: EVICTED_ID, droneLabel: 'evicted', name: 'my-cube' } },
      { projectPath: '/repo/pending', cube: { cubeId: CUBE_ID, droneId: PENDING_ID, droneLabel: 'pending', name: 'my-cube' } },
      { projectPath: '/repo/missing', cube: { cubeId: CUBE_ID, droneId: MISSING_ID, droneLabel: 'missing', name: 'my-cube' } },
    ];
    const discovered = identities.map(({ projectPath, cube }) => ({
      worktreeDir: projectPath,
      cubeId: cube.cubeId,
      droneId: cube.droneId,
      droneLabel: cube.droneLabel,
      seat: {
        ...cube,
        name: 'my-cube',
        sessionToken: `token-${cube.droneLabel}`,
        apiUrl: 'https://127.0.0.1:3000',
      },
    }));
    const activeIds = new Set([ALPHA_ID, BETA_ID, EVICTED_ID, MISSING_ID]);

    const result = await discoverLiveLaunchMenuCandidates({
      readAllProjectIdentities: async () => identities,
      discoverDroneCandidates: async () => discovered,
      getActiveSeatForWorktree: async (worktree) => {
        const found = identities.find((entry) => entry.projectPath === worktree);
        return found && activeIds.has(found.cube.droneId)
          ? { cubeId: found.cube.cubeId, droneId: found.cube.droneId }
          : null;
      },
      pathExists: (worktree) => worktree !== '/repo/missing',
      probeSeat: async (candidate) => candidate.droneId === EVICTED_ID ? 'evicted' : 'live',
    });

    expect(result).toEqual({
      candidates: [
        { droneLabel: 'alpha', target: ALPHA_ID, worktree: '/repo/alpha' },
        { droneLabel: 'beta', target: BETA_ID, worktree: '/repo/beta' },
      ],
      launchAllCubeId: CUBE_ID,
    });
  });

  it('fails closed before the menu when linked-worktree discovery fails', async () => {
    const prompt = vi.fn(async () => '');
    const resolveMenu = async () => {
      const siblingContext = await discoverLiveLaunchMenuCandidates({
        readAllProjectIdentities: async () => [{
          projectPath: '/repo/alpha',
          cube: { cubeId: CUBE_ID, droneId: ALPHA_ID, droneLabel: 'alpha', name: 'my-cube' },
        }],
        discoverDroneCandidates: async () => {
          throw new Error('git worktree list failed');
        },
        getActiveSeatForWorktree: async () => null,
        pathExists: () => true,
        probeSeat: async () => 'live',
      });
      return runBareLaunchMenu({
        defaultCli: 'claude',
        otherConfiguredClis: [],
        hasLaunchAllTargets: false,
        droneCandidates: siblingContext.candidates,
      }, prompt);
    };

    await expect(resolveMenu()).rejects.toThrow('git worktree list failed');
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe('gh#853 — buildLaunchMenuOptions (context-aware option set)', () => {
  it('option 1 (launch default) is always present and names the default cli', () => {
    const opts = buildLaunchMenuOptions({ defaultCli: 'claude', otherConfiguredClis: [], hasLaunchAllTargets: false });
    expect(opts).toHaveLength(1);
    expect(opts[0].key).toBe('1');
    expect(opts[0].action).toEqual({ kind: 'launch', cli: 'claude' });
    expect(opts[0].label).toContain('Claude');
  });

  it('each installed non-default agent gets its own option; launches it one-shot', () => {
    const withOther = buildLaunchMenuOptions({ defaultCli: 'claude', otherConfiguredClis: ['codex'], hasLaunchAllTargets: false });
    const opt2 = withOther.find((o) => o.action.kind === 'launch' && o.action.cli === 'codex');
    expect(opt2).toBeDefined();
    expect(opt2!.label).toContain('Codex');
    // not shown when the other agent isn't installed
    const noOther = buildLaunchMenuOptions({ defaultCli: 'claude', otherConfiguredClis: [], hasLaunchAllTargets: false });
    expect(noOther.some((o) => o.action.kind === 'launch' && o.action.cli === 'codex')).toBe(false);
  });

  it('when multiple other agents are installed, each gets a sequential option', () => {
    const opts = buildLaunchMenuOptions({ defaultCli: 'claude', otherConfiguredClis: ['codex', 'opencode'], hasLaunchAllTargets: false });
    expect(opts).toHaveLength(3);
    expect(opts[0].key).toBe('1');
    expect(opts[0].action).toEqual({ kind: 'launch', cli: 'claude' });
    expect(opts[1].key).toBe('2');
    expect(opts[1].action).toEqual({ kind: 'launch', cli: 'codex' });
    expect(opts[2].key).toBe('3');
    expect(opts[2].action).toEqual({ kind: 'launch', cli: 'opencode' });
  });

  it('option shown only when there are launch-all targets', () => {
    const withTargets = buildLaunchMenuOptions({ defaultCli: 'codex', otherConfiguredClis: [], hasLaunchAllTargets: true });
    expect(withTargets.some((o) => o.action.kind === 'launch-all')).toBe(true);
    const noTargets = buildLaunchMenuOptions({ defaultCli: 'codex', otherConfiguredClis: [], hasLaunchAllTargets: false });
    expect(noTargets.some((o) => o.action.kind === 'launch-all')).toBe(false);
  });

  it('keys are sequential (no gaps) regardless of which options are hidden', () => {
    // no others, launch-all present → launch-all gets key "2", not "3" (no gap menu).
    const opts = buildLaunchMenuOptions({ defaultCli: 'claude', otherConfiguredClis: [], hasLaunchAllTargets: true });
    expect(opts.map((o) => o.key)).toEqual(['1', '2']);
    expect(opts[1].action).toEqual({ kind: 'launch-all' });
    // one other + launch-all → 1,2,3
    const threeOpts = buildLaunchMenuOptions({ defaultCli: 'claude', otherConfiguredClis: ['codex'], hasLaunchAllTargets: true });
    expect(threeOpts.map((o) => o.key)).toEqual(['1', '2', '3']);
    // two others + launch-all → 1,2,3,4
    const fourOpts = buildLaunchMenuOptions({ defaultCli: 'claude', otherConfiguredClis: ['codex', 'opencode'], hasLaunchAllTargets: true });
    expect(fourOpts.map((o) => o.key)).toEqual(['1', '2', '3', '4']);
  });

  it('gives a seatless main checkout sorted drones, launch-all, then unattached launches', () => {
    const opts = buildLaunchMenuOptions({
      defaultCli: 'claude',
      otherConfiguredClis: ['codex'],
      hasLaunchAllTargets: true,
      launchAllCubeId: 'cube-id',
      droneCandidates: [
        { droneLabel: 'beta', target: 'beta-id', worktree: '/repo/beta' },
        { droneLabel: 'alpha', target: 'alpha-id', worktree: '/repo/alpha' },
      ],
    });

    expect(opts).toEqual([
      { key: '1', label: 'Resume alpha (/repo/alpha)', action: { kind: 'launch-seat', target: 'alpha-id' } },
      { key: '2', label: 'Resume beta (/repo/beta)', action: { kind: 'launch-seat', target: 'beta-id' } },
      { key: '3', label: "Launch all (this cube's drone worktrees)", action: { kind: 'launch-all', cubeId: 'cube-id' } },
      { key: '4', label: 'Launch Claude here without a drone', action: { kind: 'launch', cli: 'claude' } },
      { key: '5', label: 'Launch with Codex here without a drone (one-shot)', action: { kind: 'launch', cli: 'codex' } },
    ]);
    expect(resolveLaunchMenuChoice(opts, '')).toEqual({
      ok: true,
      action: { kind: 'launch-seat', target: 'alpha-id' },
    });
  });

  it('puts a legacy main-worktree drone first, then managed siblings and launch-all', () => {
    const opts = buildLaunchMenuOptions({
      defaultCli: 'codex',
      otherConfiguredClis: ['claude'],
      hasLaunchAllTargets: true,
      launchAllCubeId: 'cube-id',
      currentDrone: { droneLabel: 'coordinator', worktree: '/repo' },
      droneCandidates: [
        { droneLabel: 'reviewer', target: 'reviewer-id', worktree: '/repo-reviewer' },
      ],
    });

    expect(opts).toEqual([
      { key: '1', label: 'Resume coordinator (/repo)', action: { kind: 'launch', cli: 'codex' } },
      { key: '2', label: 'Resume reviewer (/repo-reviewer)', action: { kind: 'launch-seat', target: 'reviewer-id' } },
      { key: '3', label: "Launch all (this cube's drone worktrees)", action: { kind: 'launch-all', cubeId: 'cube-id' } },
      { key: '4', label: 'Resume coordinator with Claude (one-shot)', action: { kind: 'launch', cli: 'claude' } },
    ]);
  });
});

describe('gh#853 — resolveLaunchMenuChoice (selection → action)', () => {
  const options = buildLaunchMenuOptions({ defaultCli: 'claude', otherConfiguredClis: ['codex'], hasLaunchAllTargets: true });

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

describe('gh#326 — launch self-heal follows the final menu selection', () => {
  it('configures only the one-shot CLI when default Claude launches Codex', () => {
    const configured: string[] = [];
    const cli = configureSelectedLaunchCli(
      'claude',
      { kind: 'launch', cli: 'codex' },
      (selected) => configured.push(selected),
    );

    expect(cli).toBe('codex');
    expect(configured).toEqual(['codex']);
  });
});

describe('gh#853 — runBareLaunchMenu (orchestration)', () => {
  it('renders the main-worktree menu even when only option 1 applies', async () => {
    const prompt = vi.fn(async () => '');
    const action = await runBareLaunchMenu(
      { defaultCli: 'claude', otherConfiguredClis: [], hasLaunchAllTargets: false },
      prompt
    );
    expect(action).toEqual({ kind: 'launch', cli: 'claude' });
    expect(prompt).toHaveBeenCalledWith(
      'borg — how do you want to launch?\n  1) Launch (default · Claude)\n[1]: '
    );
  });

  it('renders + maps the selection when there is a real choice', async () => {
    const prompt = vi.fn(async () => '2');
    const action = await runBareLaunchMenu(
      { defaultCli: 'claude', otherConfiguredClis: ['codex'], hasLaunchAllTargets: true },
      prompt
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(action).toEqual({ kind: 'launch', cli: 'codex' });
  });

  it('re-prompts on invalid input, then accepts a valid one', async () => {
    const prompt = vi.fn().mockResolvedValueOnce('9').mockResolvedValueOnce('3');
    const action = await runBareLaunchMenu(
      { defaultCli: 'claude', otherConfiguredClis: ['codex'], hasLaunchAllTargets: true },
      prompt
    );
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(action).toEqual({ kind: 'launch-all' });
  });

  it('exhausting attempts falls back to the safe default (option 1)', async () => {
    const prompt = vi.fn(async () => 'nonsense');
    const action = await runBareLaunchMenu(
      { defaultCli: 'codex', otherConfiguredClis: ['claude'], hasLaunchAllTargets: false },
      prompt,
      { maxAttempts: 2 }
    );
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(action).toEqual({ kind: 'launch', cli: 'codex' });
  });

  it('falls back to the first sorted drone after three invalid candidate-menu choices', async () => {
    const prompt = vi.fn(async () => 'nonsense');
    const action = await runBareLaunchMenu(
      {
        defaultCli: 'claude',
        otherConfiguredClis: [],
        hasLaunchAllTargets: true,
        launchAllCubeId: 'cube-id',
        droneCandidates: [
          { droneLabel: 'beta', target: 'beta-id', worktree: '/repo/beta' },
          { droneLabel: 'alpha', target: 'alpha-id', worktree: '/repo/alpha' },
        ],
      },
      prompt,
    );

    expect(prompt).toHaveBeenCalledTimes(3);
    expect(prompt.mock.calls[0][0]).toContain('borg — how do you want to launch?\n  1) Resume alpha (/repo/alpha)');
    expect(prompt.mock.calls[1][0].startsWith('Invalid choice.\n')).toBe(true);
    expect(action).toEqual({ kind: 'launch-seat', target: 'alpha-id' });
  });
});
