import { describe, expect, it, vi } from 'vitest';
import type { AssimilateDeps, PreparedAssimilation } from '../src/assimilate-cmd';
import type { ActiveCube } from '../src/cubes';
import type { LaunchAllDeps } from '../src/launch-all-deps';
import { runQuickstart, type QuickstartDeps } from '../src/quickstart-cmd';

const context = {
  root: '/repo',
  commonDir: '/repo/.git',
  derivedName: 'borg-mcp',
  publicRepository: { kind: 'origin' as const, value: 'github.com/acme/borg-mcp' },
  publicRepositoryName: 'borg-mcp',
};

function makeDeps(options: {
  server?: string | null;
  existing?: boolean;
  identities?: Array<{ projectPath: string; cube: ActiveCube }>;
  prompts?: string[];
  assimilateCodes?: number[];
  launchCode?: number;
  tty?: boolean;
} = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const promptAnswers = [...(options.prompts ?? [])];
  const roles = [
    { id: 'role-c', name: 'Coordinator', is_default: false, is_mandatory: true, is_human_seat: true },
    { id: 'role-b', name: 'Builder', is_default: true, is_human_seat: false },
  ];
  const assimilateDeps = {
    cwd: () => '/repo',
    resolveRepositoryContext: vi.fn(async () => context),
    detectLocalServer: vi.fn(async () => options.server === undefined ? 'https://127.0.0.1:7091' : options.server),
    connectServer: vi.fn(async () => ({ token: 'token', trustIdentity: 'trust', serverCapabilities: ['create_cube'] })),
    getRepositoryIdentity: vi.fn(async () => context.publicRepository!),
    getRepositoryAssociation: vi.fn(async () => options.existing ? ({
      cubeId: 'cube-1', name: 'borg-mcp', workingRepoName: 'borg-mcp', template: 'software-dev',
    }) : null),
    resolveRepositoryCube: vi.fn(async () => ({ result: 'not_found' })),
    getCube: vi.fn(async () => ({ id: 'cube-1', name: 'borg-mcp', roles, drones: [] })),
    resolveCli: vi.fn(async () => 'codex'),
  } as unknown as AssimilateDeps;
  let sequence = 0;
  const runAssimilate = vi.fn(async (_args, _deps, runOptions) => {
    const code = options.assimilateCodes?.[sequence] ?? 0;
    sequence += 1;
    if (code === 0) {
      const roleName = _args.role === 'coordinator' ? 'Coordinator' : _args.role === 'builder' ? 'Builder' : _args.role!;
      const prepared: PreparedAssimilation = {
        cubeId: 'cube-1',
        cubeName: 'borg-mcp',
        droneId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
        droneLabel: `${_args.role}-${sequence}`,
        roleName,
        worktree: `/worktrees/${_args.role}-${sequence}`,
      };
      runOptions?.onPrepared?.(prepared);
    }
    return code;
  });
  const runLaunchAll = vi.fn(async () => options.launchCode ?? 0);
  const deps: QuickstartDeps = {
    buildAssimilateDeps: () => assimilateDeps,
    buildLaunchAllDeps: () => ({}) as LaunchAllDeps,
    readAllProjectIdentities: vi.fn(async () => options.identities ?? []),
    isTTY: () => options.tty ?? true,
    prompt: vi.fn(async () => promptAnswers.shift() ?? ''),
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
    runAssimilate: runAssimilate as typeof import('../src/assimilate-cmd').runAssimilate,
    runLaunchAll: runLaunchAll as typeof import('../src/launch-all-cmd').runLaunchAll,
  };
  return { deps, output, errors, runAssimilate, runLaunchAll, assimilateDeps };
}

describe('runQuickstart', () => {
  it('fails closed with the ratified two-terminal copy before repository identity or creation', async () => {
    const rig = makeDeps({ server: null });
    expect(await runQuickstart({ roles: [], yes: true }, rig.deps)).toBe(1);
    expect(rig.errors.join('')).toBe(
      'borg quickstart: no Borg server is running at https://127.0.0.1:7091.\n' +
      'Start it in another terminal and leave it open:\n' +
      '  borg server start\n' +
      'Then run `borg quickstart` again.\n',
    );
    expect(rig.assimilateDeps.getRepositoryIdentity).not.toHaveBeenCalled();
    expect(rig.runAssimilate).not.toHaveBeenCalled();
  });

  it('prompts with shared template copy and staffs the coordinator in the default roster', async () => {
    const rig = makeDeps({ prompts: ['', 'y'] });
    expect(await runQuickstart({ roles: [], yes: false }, rig.deps)).toBe(0);
    const text = rig.output.join('');
    expect(text).toContain('Template    1) Software Development');
    expect(text).toContain('Recommended for code repositories.');
    expect(text).toContain(
      'Drones      coordinator, builder, code-reviewer, release-quality,\n' +
      '            product-design, product-strategy, security-auditor',
    );
    expect(rig.runAssimilate).toHaveBeenCalledTimes(7);
    expect(rig.runAssimilate.mock.calls[0][0].role).toBe('coordinator');
    expect(rig.runAssimilate.mock.calls[0][0].flags.cli).toBe('codex');
    expect(rig.runAssimilate.mock.calls[0][2]).toEqual(expect.objectContaining({ launch: false }));
    expect(rig.runLaunchAll).toHaveBeenCalledOnce();
    expect(text).toContain('Start in the coordinator session (`coordinator-1`)');
  });

  it('treats --role as the complete multiplicity-adjusted roster', async () => {
    const rig = makeDeps();
    expect(await runQuickstart({
      template: 'software-dev',
      roles: [{ slug: 'builder', count: 2 }, { slug: 'code-reviewer', count: 1 }],
      yes: true,
    }, rig.deps)).toBe(0);
    expect(rig.runAssimilate.mock.calls.map((call) => call[0].role)).toEqual(['builder', 'builder', 'code-reviewer']);
  });

  it('uses singular copy for a one-drone plan and success', async () => {
    const rig = makeDeps({ prompts: ['1', 'y'] });
    expect(await runQuickstart({ roles: [{ slug: 'builder', count: 1 }], yes: false }, rig.deps)).toBe(0);
    expect(rig.deps.prompt).toHaveBeenLastCalledWith('Create and launch these 1 drone? [Y/n] ');
    expect(rig.output.join('')).toContain('1 drone launched.');
  });

  it('skips the template prompt for an existing cube', async () => {
    const rig = makeDeps({ existing: true, prompts: ['y'] });
    expect(await runQuickstart({ roles: [], yes: false }, rig.deps)).toBe(0);
    expect(rig.deps.prompt).toHaveBeenCalledTimes(1);
    expect(rig.deps.prompt).toHaveBeenCalledWith('Continue? [Y/n] ');
    expect(rig.output.join('')).not.toContain('Choose [1]');
  });

  it('uses software-dev without a template prompt outside a TTY when the plan is pre-approved', async () => {
    const rig = makeDeps({ tty: false });
    expect(await runQuickstart({ roles: [{ slug: 'coordinator', count: 1 }], yes: true }, rig.deps)).toBe(0);
    expect(rig.output.join('')).toContain('template: Software Development');
    expect(rig.deps.prompt).not.toHaveBeenCalled();
  });

  it('skips a consumed roster slot from the durable local registry and launches it without re-assimilating', async () => {
    const existingBuilder: ActiveCube = {
      cubeId: 'cube-1',
      droneId: '10000000-0000-4000-8000-000000000001',
      name: 'borg-mcp',
      sessionToken: 'token',
      droneLabel: 'builder-aaaa1111',
      apiUrl: 'https://127.0.0.1:7091',
      roleName: 'Builder',
    };
    const rig = makeDeps({ existing: true, identities: [{ projectPath: '/worktrees/builder', cube: existingBuilder }] });
    expect(await runQuickstart({ roles: [{ slug: 'builder', count: 1 }], yes: true }, rig.deps)).toBe(0);
    expect(rig.runAssimilate).not.toHaveBeenCalled();
    expect(rig.output.join('')).toContain('Have        builder');
    expect(rig.runLaunchAll.mock.calls[0][2]).toEqual({
      droneIds: [existingBuilder.droneId],
      requireAllRequested: true,
      targetCube: { cubeId: 'cube-1', name: 'borg-mcp' },
    });
  });

  it('keeps completed drones and gives the single resumable recovery command after a partial failure', async () => {
    const rig = makeDeps({ assimilateCodes: [0, 1] });
    expect(await runQuickstart({
      template: 'software-dev', roles: [{ slug: 'builder', count: 2 }], yes: true,
    }, rig.deps)).toBe(1);
    expect(rig.runAssimilate).toHaveBeenCalledTimes(2);
    expect(rig.errors.join('')).toContain('builder is missing.');
    expect(rig.errors.join('')).toContain('run `borg quickstart` again');
    expect(rig.runLaunchAll).not.toHaveBeenCalled();
  });

  it('leaves the staffed roster and points launch failures to launch-all', async () => {
    const rig = makeDeps({ launchCode: 1 });
    expect(await runQuickstart({
      template: 'software-dev', roles: [{ slug: 'builder', count: 1 }], yes: true,
    }, rig.deps)).toBe(1);
    expect(rig.errors.join('')).toContain('run `borg launch-all`');
  });
});
