import { describe, it, expect, vi } from 'vitest';
import { runSetupAuthority, type SetupAuthorityDeps } from '../src/setup-authority.js';

function makeDeps(overrides: Partial<SetupAuthorityDeps> = {}): SetupAuthorityDeps {
  return {
    probeSession: vi.fn(async () => 'valid' as const),
    authenticateWithGoogle: vi.fn(async () => {}),
    checkSubscriptionStatus: vi.fn(async () => ({ hasAccess: false })),
    createSubscription: vi.fn(async () => 'https://stripe.example.com/checkout'),
    openUrl: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    log: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
}

/**
 * gh#27 (CR c7ef8d91): setup-authority branch unit-pins the local-first
 * promise for the COMPLETE authority-dependent setup work.
 *
 * Local paths must make ZERO Cloud calls: probeSession, authenticateWithGoogle,
 * checkSubscriptionStatus, createSubscription, openUrl.
 *
 * Cloud control must prove the subscription branch is reached (at minimum
 * probeSession + checkSubscriptionStatus called).
 */
describe('runSetupAuthority', () => {
  describe('local paths — zero Cloud calls', () => {
    it('explicit local: zero probe/auth/subscription/browser calls', async () => {
      const deps = makeDeps();
      const result = await runSetupAuthority('local', deps);

      expect(result.useCloud).toBe(false);
      expect(deps.probeSession).not.toHaveBeenCalled();
      expect(deps.authenticateWithGoogle).not.toHaveBeenCalled();
      expect(deps.checkSubscriptionStatus).not.toHaveBeenCalled();
      expect(deps.createSubscription).not.toHaveBeenCalled();
      expect(deps.openUrl).not.toHaveBeenCalled();
      expect(deps.sleep).not.toHaveBeenCalled();
    });

    it('undefined (cancel-safe default): defaults to local, zero Cloud calls', async () => {
      const deps = makeDeps();
      const result = await runSetupAuthority(undefined, deps);

      expect(result.useCloud).toBe(false);
      expect(deps.probeSession).not.toHaveBeenCalled();
      expect(deps.authenticateWithGoogle).not.toHaveBeenCalled();
      expect(deps.checkSubscriptionStatus).not.toHaveBeenCalled();
      expect(deps.createSubscription).not.toHaveBeenCalled();
      expect(deps.openUrl).not.toHaveBeenCalled();
      expect(deps.sleep).not.toHaveBeenCalled();
    });
  });

  describe('cloud paths — proves Cloud branch reached', () => {
    it('explicit cloud: reaches probeSession + checkSubscriptionStatus (Cloud control)', async () => {
      const deps = makeDeps();
      const result = await runSetupAuthority('cloud', deps);

      expect(result.useCloud).toBe(true);
      expect(deps.probeSession).toHaveBeenCalled();
      expect(deps.checkSubscriptionStatus).toHaveBeenCalled();
    });

    it('cloud + valid session: skips auth, still checks subscription', async () => {
      const deps = makeDeps({ probeSession: vi.fn(async () => 'valid' as const) });
      const result = await runSetupAuthority('cloud', deps);

      expect(result.useCloud).toBe(true);
      expect(result.authAction).toBe('skip');
      expect(deps.authenticateWithGoogle).not.toHaveBeenCalled();
      expect(deps.checkSubscriptionStatus).toHaveBeenCalled();
    });

    it('cloud + dead session: authenticates with Google', async () => {
      const deps = makeDeps({ probeSession: vi.fn(async () => 'dead' as const) });
      const result = await runSetupAuthority('cloud', deps);

      expect(result.useCloud).toBe(true);
      expect(result.authAction).toBe('reauth');
      expect(deps.authenticateWithGoogle).toHaveBeenCalled();
      expect(deps.checkSubscriptionStatus).toHaveBeenCalled();
    });

    it('cloud + transient session: returns retry, no auth or subscription check', async () => {
      const deps = makeDeps({ probeSession: vi.fn(async () => 'transient' as const) });
      const result = await runSetupAuthority('cloud', deps);

      expect(result.useCloud).toBe(true);
      expect(result.authAction).toBe('retry');
      expect(deps.authenticateWithGoogle).not.toHaveBeenCalled();
      expect(deps.checkSubscriptionStatus).not.toHaveBeenCalled();
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

  describe('cloud — auth error recovery', () => {
    it('auth failure: logs actionable recovery message', async () => {
      const deps = makeDeps({
        probeSession: vi.fn(async () => 'dead' as const),
        authenticateWithGoogle: vi.fn(async () => {
          throw new Error('invalid_grant');
        }),
      });
      const result = await runSetupAuthority('cloud', deps);

      expect(result.useCloud).toBe(true);
      expect(result.authAction).toBe('reauth');
      expect(deps.logError).toHaveBeenCalledWith(
        expect.stringContaining('Authentication failed: invalid_grant'),
      );
      expect(deps.logError).toHaveBeenCalledWith(
        expect.stringContaining('Re-run `borg setup` to try again.'),
      );
      expect(deps.checkSubscriptionStatus).not.toHaveBeenCalled();
    });
  });

  describe('cloud — subscription resolution', () => {
    it('subscription check failure: falls back to no-access', async () => {
      const deps = makeDeps({
        checkSubscriptionStatus: vi.fn(async () => {
          throw new Error('network timeout');
        }),
      });
      const result = await runSetupAuthority('cloud', deps);

      expect(result.useCloud).toBe(true);
      expect(result.subscriptionStatus).toEqual({ hasAccess: false });
      expect(deps.logError).toHaveBeenCalledWith(
        expect.stringContaining('Subscription check failed: network timeout'),
      );
    });

    it('subscription check success with access', async () => {
      const deps = makeDeps({
        checkSubscriptionStatus: vi.fn(async () => ({
          hasAccess: true,
          expiresAt: '2027-01-01T00:00:00Z',
        })),
      });
      const result = await runSetupAuthority('cloud', deps);

      expect(result.useCloud).toBe(true);
      expect(result.subscriptionStatus?.hasAccess).toBe(true);
    });
  });
});
