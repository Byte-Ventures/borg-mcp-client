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
import { type SubscriptionStatus } from './subscription-retry.js';
export interface SetupAuthorityDeps {
    /** Classify the saved Google session. Cloud-only. */
    probeSession: () => Promise<SessionState>;
    /** Full Google OAuth flow. Cloud-only. */
    authenticateWithGoogle: (opts?: {
        noBrowser?: boolean;
    }) => Promise<void>;
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
export declare function runSetupAuthority(authority: 'local' | 'cloud' | undefined, deps: SetupAuthorityDeps, opts?: {
    noBrowser?: boolean;
}): Promise<SetupAuthorityResult>;
//# sourceMappingURL=setup-authority.d.ts.map