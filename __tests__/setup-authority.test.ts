import { describe, it, expect, vi } from 'vitest';
import {
  runSetupAuthority,
  isAuthFailed,
  type SetupAuthorityDeps,
} from '../src/setup-authority.js';

function makeDeps(overrides: Partial<SetupAuthorityDeps> = {}): SetupAuthorityDeps {
  return {
    probeSession: vi.fn(async () => 'valid' as const),
    authenticateWithGoogle: vi.fn(async () => {}),
    checkSubscriptionStatus: vi.fn(async () => ({ hasAccess: false })),
    createSubscription: vi.fn(async () => 'https://stripe.example.com/checkout'),
    openUrl: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    selectSubscribeMethod: vi.fn(async () => 'skip' as string | undefined),
    log: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
}

/**
 * gh#27 (CR 47f3c559): setup-authority branch unit-pins the local-first
 * promise for the COMPLETE authority-dependent setup work.
 *
 * Local paths: zero probeSession / authenticateWithGoogle /
 * checkSubscriptionStatus / createSubscription / openUrl / sleep /
 * selectSubscribeMethod calls.
 *
 * Cloud control: at minimum one real openUrl or createSubscription
 * call must be reached (downstream proven).
 *
 * Auth rejection: terminal {authFailed: true}, actionable recovery
 * logged once, zero subscription/browser/API work. Caller must exit.
 */
describe('runSetupAuthority', () => {
  // ── Local paths: zero Cloud calls ───────────────────────────────

  describe('local paths — zero Cloud calls', () => {
    it('explicit local: zero Cloud-side calls', async () => {
      const deps = makeDeps();
      const result = await runSetupAuthority('local', deps);

      expect(result.useCloud).toBe(false);
      expect(deps.probeSession).not.toHaveBeenCalled();
      expect(deps.authenticateWithGoogle).not.toHaveBeenCalled();
      expect(deps.checkSubscriptionStatus).not.toHaveBeenCalled();
      expect(deps.createSubscription).not.toHaveBeenCalled();
      expect(deps.openUrl).not.toHaveBeenCalled();
      expect(deps.sleep).not.toHaveBeenCalled();
      expect(deps.selectSubscribeMethod).not.toHaveBeenCalled();
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
      expect(deps.selectSubscribeMethod).not.toHaveBeenCalled();
    });
  });

  // ── Cloud paths: proves subscription branch reached ─────────────

  describe('cloud paths — proves Cloud branch reached', () => {
    it('Cloud control: reaches probeSession + checkSubscriptionStatus', async () => {
      const deps = makeDeps();
      const result = await runSetupAuthority('cloud', deps);

      expect(result.useCloud).toBe(true);
      expect(deps.probeSession).toHaveBeenCalled();
      expect(deps.checkSubscriptionStatus).toHaveBeenCalled();
    });

    it('Cloud + no-access + skip: reaches selectSubscribeMethod, returns Free tier status', async () => {
      const deps = makeDeps({
        selectSubscribeMethod: vi.fn(async () => 'skip'),
      });
      const result = await runSetupAuthority('cloud', deps);

      expect(result.useCloud).toBe(true);
      expect(result.subscriptionStatus).toEqual({ hasAccess: false });
      expect(deps.selectSubscribeMethod).toHaveBeenCalled();
    });

    it('Cloud + no-access + web: reaches openUrl (downstream proven)', async () => {
      const deps = makeDeps({
        selectSubscribeMethod: vi.fn(async () => 'web'),
      });
      const result = await runSetupAuthority('cloud', deps);

      expect(result.useCloud).toBe(true);
      expect(deps.openUrl).toHaveBeenCalledWith('https://borgmcp.ai/subscribe');
    });

    it('Cloud + no-access + stripe: reaches createSubscription + openUrl (downstream proven)', async () => {
      const deps = makeDeps({
        selectSubscribeMethod: vi.fn(async () => 'stripe'),
      });
      const result = await runSetupAuthority('cloud', deps);

      expect(result.useCloud).toBe(true);
      expect(deps.createSubscription).toHaveBeenCalled();
      expect(deps.openUrl).toHaveBeenCalled();
    });

    it('Cloud + no-access + recheck: reaches checkSubscriptionStatus (recheck path)', async () => {
      const checkCalls = vi.fn(async () => ({ hasAccess: false }));
      const deps = makeDeps({
        checkSubscriptionStatus: checkCalls,
        selectSubscribeMethod: vi.fn(async () => 'recheck'),
      });
      const result = await runSetupAuthority('cloud', deps);

      expect(result.useCloud).toBe(true);
      // retrySubscriptionCheck retries internally, so total calls > 1
      expect(checkCalls.mock.calls.length).toBeGreaterThan(1);
    });

    it('Cloud + no-access + cancel (undefined): zero open/create calls', async () => {
      const deps = makeDeps({
        selectSubscribeMethod: vi.fn(async () => undefined),
      });
      const result = await runSetupAuthority('cloud', deps);

      expect(result.useCloud).toBe(true);
      expect(result.subscriptionStatus).toEqual({ hasAccess: false });
      expect(deps.openUrl).not.toHaveBeenCalled();
      expect(deps.createSubscription).not.toHaveBeenCalled();
    });
  });

  // ── Cloud auth routing ──────────────────────────────────────────

  describe('cloud — auth routing', () => {
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

  // ── Cloud: auth failure (terminal) ──────────────────────────────

  describe('cloud — auth failure (terminal)', () => {
    it('auth failure: returns authFailed:true, logs actionable recovery once', async () => {
      const deps = makeDeps({
        probeSession: vi.fn(async () => 'dead' as const),
        authenticateWithGoogle: vi.fn(async () => {
          throw new Error('invalid_grant');
        }),
      });
      const result = await runSetupAuthority('cloud', deps);

      expect(isAuthFailed(result)).toBe(true);
      expect(result.useCloud).toBe(true);
      if ('authFailed' in result) expect(result.authFailed).toBe(true);

      // Actionable recovery logged exactly once
      const recoveryCalls = deps.logError.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('Re-run `borg setup` to try again.'),
      );
      expect(recoveryCalls).toHaveLength(1);

      // Zero subscription/browser/API work
      expect(deps.checkSubscriptionStatus).not.toHaveBeenCalled();
      expect(deps.createSubscription).not.toHaveBeenCalled();
      expect(deps.openUrl).not.toHaveBeenCalled();
      expect(deps.selectSubscribeMethod).not.toHaveBeenCalled();
      expect(deps.sleep).not.toHaveBeenCalled();
    });

    it('caller regression: authFailed causes exit before subscription work', async () => {
      const deps = makeDeps({
        probeSession: vi.fn(async () => 'dead' as const),
        authenticateWithGoogle: vi.fn(async () => {
          throw new Error('invalid_grant');
        }),
      });
      const result = await runSetupAuthority('cloud', deps);

      // Caller would do: if (isAuthFailed(result)) process.exit(1)
      // Before that, zero subscription work must have happened:
      expect(deps.checkSubscriptionStatus).not.toHaveBeenCalled();
      expect(deps.selectSubscribeMethod).not.toHaveBeenCalled();
      expect(deps.createSubscription).not.toHaveBeenCalled();
      expect(deps.openUrl).not.toHaveBeenCalled();

      // And no generic "Setup failed" should appear in the seam's output
      const setupFailedCalls = deps.logError.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('Setup failed'),
      );
      expect(setupFailedCalls).toHaveLength(0);
    });
  });

  // ── Cloud: subscription check resolution ────────────────────────

  describe('cloud — subscription check resolution', () => {
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

    it('subscription check success with access: returns hasAccess true', async () => {
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
