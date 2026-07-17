import { describe, it, expect, vi } from 'vitest';
import { runSetupAuthority, type SetupAuthorityDeps } from '../src/setup-authority.js';

function makeDeps(overrides: Partial<SetupAuthorityDeps> = {}): SetupAuthorityDeps {
  return {
    probeSession: vi.fn(async () => 'valid' as const),
    authenticateWithGoogle: vi.fn(async () => {}),
    log: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
}

/**
 * gh#27 (CR 5f20d3f1): setup-authority branch unit-pins the local-first
 * promise. Each Local path must make ZERO Cloud calls (probeSession,
 * authenticateWithGoogle). The Cloud control must reach probeSession to
 * prove the harness enters the Cloud branch.
 */
describe('runSetupAuthority', () => {
  it('explicit local: zero Cloud calls', async () => {
    const deps = makeDeps();
    const result = await runSetupAuthority('local', deps);

    expect(result.useCloud).toBe(false);
    expect(deps.probeSession).not.toHaveBeenCalled();
    expect(deps.authenticateWithGoogle).not.toHaveBeenCalled();
  });

  it('undefined (cancel-safe default): defaults to local, zero Cloud calls', async () => {
    const deps = makeDeps();
    const result = await runSetupAuthority(undefined, deps);

    expect(result.useCloud).toBe(false);
    expect(deps.probeSession).not.toHaveBeenCalled();
    expect(deps.authenticateWithGoogle).not.toHaveBeenCalled();
  });

  it('explicit cloud: reaches probeSession (Cloud control)', async () => {
    const deps = makeDeps();
    const result = await runSetupAuthority('cloud', deps);

    expect(result.useCloud).toBe(true);
    expect(deps.probeSession).toHaveBeenCalled();
  });

  it('cloud + valid session: skips auth', async () => {
    const deps = makeDeps({ probeSession: vi.fn(async () => 'valid' as const) });
    const result = await runSetupAuthority('cloud', deps);

    expect(result.useCloud).toBe(true);
    expect(result.authAction).toBe('skip');
    expect(deps.authenticateWithGoogle).not.toHaveBeenCalled();
  });

  it('cloud + dead session: authenticates with Google', async () => {
    const deps = makeDeps({ probeSession: vi.fn(async () => 'dead' as const) });
    const result = await runSetupAuthority('cloud', deps);

    expect(result.useCloud).toBe(true);
    expect(result.authAction).toBe('reauth');
    expect(deps.authenticateWithGoogle).toHaveBeenCalled();
  });

  it('cloud + transient session: returns retry without authenticating', async () => {
    const deps = makeDeps({ probeSession: vi.fn(async () => 'transient' as const) });
    const result = await runSetupAuthority('cloud', deps);

    expect(result.useCloud).toBe(true);
    expect(result.authAction).toBe('retry');
    expect(deps.authenticateWithGoogle).not.toHaveBeenCalled();
    expect(deps.logError).toHaveBeenCalledWith(
      expect.stringContaining('Could not reach Google'),
    );
  });

  it('cloud + noBrowser flag: forwarded to authenticateWithGoogle', async () => {
    const deps = makeDeps({ probeSession: vi.fn(async () => 'dead' as const) });
    await runSetupAuthority('cloud', deps, { noBrowser: true });

    expect(deps.authenticateWithGoogle).toHaveBeenCalledWith({ noBrowser: true });
  });
});
