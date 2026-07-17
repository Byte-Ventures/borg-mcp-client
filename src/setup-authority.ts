/**
 * gh#27 (CR c7ef8d91): extracted setup authority branch with dependency
 * injection so the local-first promise is unit-pinned. `setup.ts` is a
 * self-executing script with no exports; this module provides the
 * testable seam for ALL authority-dependent setup work.
 *
 * Local path: zero probeSession / authenticateWithGoogle /
 * checkSubscriptionStatus / createSubscription / open calls.
 *
 * Cloud path: probes the saved session, authenticates if needed (with
 * actionable error recovery), checks subscription status with retry,
 * and returns the resolved status for the caller's subscription menu.
 */

import type { SessionState } from './remote-client.js';
import { setupActionForSession } from './setup-action.js';
import { retrySubscriptionCheck, type SubscriptionStatus } from './subscription-retry.js';

export interface SetupAuthorityDeps {
  /** Classify the saved Google session. Cloud-only. */
  probeSession: () => Promise<SessionState>;
  /** Full Google OAuth flow. Cloud-only. */
  authenticateWithGoogle: (opts?: { noBrowser?: boolean }) => Promise<void>;
  /** Check the user's subscription status against the API. Cloud-only. */
  checkSubscriptionStatus: () => Promise<SubscriptionStatus>;
  /** Create a Stripe checkout session and return the URL. Cloud-only. */
  createSubscription: () => Promise<string>;
  /** Open a URL in the browser. Cloud-only. */
  openUrl: (url: string) => Promise<void>;
  /** Injected sleep for subscription retry delays. */
  sleep: (ms: number) => Promise<void>;
  /** Log to stdout. */
  log: (...args: unknown[]) => void;
  /** Log to stderr. */
  logError: (...args: unknown[]) => void;
}

export interface SetupAuthorityResult {
  /** Whether the Cloud path was entered. */
  useCloud: boolean;
  /** For Cloud path: the auth action taken (skip / retry / reauth). */
  authAction?: 'skip' | 'retry' | 'reauth';
  /** For Cloud path: resolved subscription status after check + retry. */
  subscriptionStatus?: SubscriptionStatus;
}

/**
 * Execute the COMPLETE setup authority branch: decide between local
 * server and Cloud, and for Cloud, probe + authenticate the session,
 * then check subscription status with retry.
 *
 * Returns a result indicating which path was taken. Local returns
 * immediately with zero Cloud side effects. Cloud calls probeSession,
 * conditionally authenticateWithGoogle (with actionable error recovery),
 * and checkSubscriptionStatus (with retry).
 *
 * `noBrowser` is forwarded to authenticateWithGoogle when the Cloud
 * re-auth path is entered.
 */
export async function runSetupAuthority(
  authority: 'local' | 'cloud' | undefined,
  deps: SetupAuthorityDeps,
  opts?: { noBrowser?: boolean },
): Promise<SetupAuthorityResult> {
  const useCloud = authority === 'cloud';

  if (!useCloud) {
    deps.log('Local server mode — no account or subscription needed.');
    return { useCloud: false };
  }

  // Cloud path: probe session then authenticate if needed.
  // gh#794 / SR#3: classify the saved session before deciding whether
  // to re-auth. probeSession attempts a silent refresh, so an EXPIRED
  // id_token with a still-VALID refresh_token resolves to 'valid' → we
  // short-circuit the OAuth flow. 'dead' does the full re-auth.
  const sessionState = await deps.probeSession();
  const action = setupActionForSession(sessionState);

  if (action === 'retry') {
    deps.logError(
      'Could not reach Google to verify your session (network issue). ' +
        'Re-run `borg setup` when your connection is back.',
    );
    return { useCloud: true, authAction: 'retry' };
  }

  if (action === 'reauth') {
    // gh#557: actionable error recovery — auth rejection prints a
    // specific message telling the user to retry, instead of falling
    // through to a generic "Setup failed".
    try {
      await deps.authenticateWithGoogle(opts?.noBrowser ? { noBrowser: true } : undefined);
    } catch (error: any) {
      deps.logError(`Authentication failed: ${error.message}`);
      deps.logError('Re-run `borg setup` to try again.');
      return { useCloud: true, authAction: 'reauth' };
    }
  }

  // Subscription check with retry (gh#521 propagation-lag fix).
  let status: SubscriptionStatus;
  try {
    status = await deps.checkSubscriptionStatus();
  } catch (error: any) {
    deps.logError(`Subscription check failed: ${error.message}`);
    deps.logError('Retrying before falling back to the Free tier...');
    status = { hasAccess: false };
  }

  status = await retrySubscriptionCheck(status, {
    check: deps.checkSubscriptionStatus,
    sleep: deps.sleep,
  });

  return { useCloud: true, authAction: action, subscriptionStatus: status };
}
