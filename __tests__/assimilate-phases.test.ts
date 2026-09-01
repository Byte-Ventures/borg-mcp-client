import { describe, expect, it, vi } from 'vitest';
import {
  finalizeAssimilationSeat,
  prepareAssimilationSeat,
  resolveAssimilationRepository,
  type AssimilationActiveCube,
  type AssimilateResult,
  type FinalizationInput,
} from '../src/assimilate-cmd.js';

const repositoryContext = {
  root: '/work/repo',
  commonDir: '/work/repo/.git',
  derivedName: 'repo',
  publicRepository: null,
  publicRepositoryName: null,
};

const activeCube: AssimilationActiveCube = {
  cubeId: 'cube-1',
  droneId: 'drone-1',
  name: 'cube',
  droneLabel: 'builder-1',
  apiUrl: 'https://localhost:8787',
  serverTrustIdentity: 'trust-1',
  localSessionCredentialRef: 'credential-1',
  roleName: 'Builder',
  isHumanSeat: false,
};

const finalize = {
  activate: vi.fn(async () => undefined),
  scrubPending: vi.fn(async () => undefined),
};

function finalizationInput(result: AssimilateResult): FinalizationInput {
  return {
    activeCube,
    apiUrl: activeCube.apiUrl,
    repositoryContext,
    result,
    sessionExpected: { kind: 'absent' },
    rollbackWorktree: vi.fn(),
  };
}

describe('assimilation phases', () => {
  it('resolves a repository without the full assimilation dependency surface', async () => {
    const resolveRepositoryContext = vi.fn(async () => repositoryContext);
    const outcome = await resolveAssimilationRepository(
      { role: undefined, flags: {} },
      { cwd: () => '/work/repo', resolveRepositoryContext, stderr: vi.fn() },
    );

    expect(outcome).toEqual({
      kind: 'continue',
      value: { mode: 'assimilate', repositoryContext },
    });
    expect(resolveRepositoryContext).toHaveBeenCalledWith('/work/repo');
  });

  it('prepares a fresh seat with an absent expectation through narrow dependencies', async () => {
    const assimilate = vi.fn(async (): Promise<AssimilateResult> => ({
      cube_id: 'cube-1',
      drone_id: 'drone-1',
      drone_label: 'builder-1',
      role_id: 'role-1',
      local_session: { credential_ref: 'credential-1' },
      finalize,
    }));
    const outcome = await prepareAssimilationSeat({
      apiUrl: activeCube.apiUrl,
      token: 'parent-token',
      serverTrustIdentity: activeCube.serverTrustIdentity!,
      cubeDetail: {
        id: 'cube-1',
        name: 'cube',
        roles: [{ id: 'role-1', name: 'Builder', description: '', is_human_seat: false }],
      },
      resolvedRole: { id: 'role-1', name: 'Builder', description: '', is_human_seat: false },
      cli: 'claude',
      effectiveModel: null,
      projectRoot: '/work/repo',
      existing: null,
      reattachPriorId: undefined,
      remintInvalidPrior: false,
      resumeCredentialRef: undefined,
      resumeDroneId: undefined,
      resumeState: undefined,
      sessionOperation: { projectRoot: '/work/repo', kind: 'sibling', operationKey: 'implicit-sibling:test' },
    }, { assimilate, getHostname: () => 'host', stderr: vi.fn() });

    expect(outcome.kind).toBe('continue');
    expect(assimilate).toHaveBeenCalledOnce();
    expect(assimilate.mock.calls[0]![2]).toMatchObject({
      session_expected: { kind: 'absent' },
      revalidate_at_prepare: true,
    });
  });

  it('rolls back when finalization throws after the finalizer was reached', async () => {
    const input = finalizationInput({
      cube_id: 'cube-1', drone_id: 'drone-1', drone_label: 'builder-1', role_id: 'role-1',
      local_session: { credential_ref: 'credential-1' }, finalize,
    });
    const finalizeServerSeat = vi.fn(async () => { throw new Error('late failure'); });
    const stderr = vi.fn();

    const outcome = await finalizeAssimilationSeat(input, {
      cwd: () => '/work/repo',
      finalizeServerSeat,
      findProjectRoot: (cwd) => cwd,
      stderr,
    });

    expect(outcome).toEqual({ kind: 'stop', code: 1 });
    expect(finalizeServerSeat).toHaveBeenCalledOnce();
    expect(input.rollbackWorktree).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith('finalizeServerSeat failed: late failure\n');
  });

  it('preserves the worktree only after a late activation failure binds the pending record', async () => {
    const bindPending = vi.fn(async () => 'bound' as const);
    const input = finalizationInput({
      cube_id: 'cube-1', drone_id: 'drone-1', drone_label: 'builder-1', role_id: 'role-1',
      local_session: { credential_ref: 'credential-1' },
      finalize: { ...finalize, bindPending },
    });
    const finalizeServerSeat = vi.fn(async () => ({ committed: false as const, reason: 'activation-failed' as const }));

    const outcome = await finalizeAssimilationSeat(input, {
      cwd: () => '/work/repo',
      finalizeServerSeat,
      findProjectRoot: (cwd) => cwd,
      stderr: vi.fn(),
    });

    expect(outcome).toEqual({ kind: 'stop', code: 1 });
    expect(finalizeServerSeat).toHaveBeenCalledOnce();
    expect(bindPending).toHaveBeenCalledWith(expect.objectContaining({ worktree: '/work/repo' }));
    expect(input.rollbackWorktree).not.toHaveBeenCalled();
  });

  it('rolls back after a late expectation mismatch', async () => {
    const input = finalizationInput({
      cube_id: 'cube-1', drone_id: 'drone-1', drone_label: 'builder-1', role_id: 'role-1',
      local_session: { credential_ref: 'credential-1' }, finalize,
    });
    const finalizeServerSeat = vi.fn(async () => ({ committed: false as const, reason: 'expectation-mismatch' as const }));

    const outcome = await finalizeAssimilationSeat(input, {
      cwd: () => '/work/repo',
      finalizeServerSeat,
      findProjectRoot: (cwd) => cwd,
      stderr: vi.fn(),
    });

    expect(outcome).toEqual({ kind: 'stop', code: 1 });
    expect(finalizeServerSeat).toHaveBeenCalledOnce();
    expect(input.rollbackWorktree).toHaveBeenCalledOnce();
  });
});
