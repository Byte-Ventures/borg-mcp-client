/**
 * gh#27 (CR 47f3c559): extracted setup authority branch with complete
 * dependency injection covering ALL authority-dependent setup work.
 * `setup.ts` is a self-executing script with no exports; this module
 * provides the testable seam for authority decision, Cloud auth, and
 * the full subscription/menu/checkout/browser/poll flow.
 *
 * Local path: zero probeSession / authenticateWithGoogle /
 * checkSubscriptionStatus / createSubscription / openUrl / sleep calls.
 *
 * Cloud path: probes the saved session, authenticates if needed (with
 * actionable error recovery), checks subscription with retry, drives
 * the subscription menu (web/stripe/recheck/skip), and performs any
 * browser/checkout/poll actions — all through injected dependencies.
 *
 * Auth rejection is a TERMINAL outcome: prints actionable recovery,
 * returns {authFailed: true}, and performs zero subscription/browser/API
 * work. The caller must exit before subscription handling.
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
    /** Injected sleep for subscription retry/poll delays. */
    sleep: (ms: number) => Promise<void>;
    /** Prompt the user to select a subscription method. Cloud-only. */
    selectSubscribeMethod: () => Promise<string | undefined>;
    /** Log to stdout. */
    log: (...args: unknown[]) => void;
    /** Log to stderr. */
    logError: (...args: unknown[]) => void;
}
/**
 * Terminal result: auth rejection. The caller MUST exit before any
 * subscription/browser/API work. Logs actionable recovery exactly once.
 */
export interface AuthFailedResult {
    useCloud: true;
    authFailed: true;
}
/**
 * Retry result: network issue probing the session. The caller should
 * exit (no subscription work).
 */
export interface AuthRetryResult {
    useCloud: true;
    authAction: 'retry';
}
/**
 * Success result: auth succeeded, subscription status resolved.
 * May include subscription menu actions already performed.
 */
export interface AuthSuccessResult {
    useCloud: true;
    authAction: 'skip' | 'reauth';
    subscriptionStatus: SubscriptionStatus;
}
/**
 * Local result: no Cloud work performed.
 */
export interface LocalResult {
    useCloud: false;
}
export type SetupAuthorityResult = LocalResult | AuthFailedResult | AuthRetryResult | AuthSuccessResult;
/** Type guard: auth rejection (terminal — caller must exit). */
export declare function isAuthFailed(r: SetupAuthorityResult): r is AuthFailedResult;
/** Type guard: network retry (caller should exit). */
export declare function isAuthRetry(r: SetupAuthorityResult): r is AuthRetryResult;
/**
 * Evaluate the authority result and return the process exit code.
 * 0 = continue to success message; 1 = exit (auth failure or network retry).
 * This is the production-path caller decision from setup.ts — extracted
 * so tests can assert exit code + logged output without mocking process.exit.
 *
 * On exit-code-1 paths the function also appends the actionable recovery
 * message exactly once.  The caller MUST NOT append a generic "Setup failed"
 * after this returns 1.
 */
export declare function handleAuthorityResult(result: SetupAuthorityResult, log: (...args: unknown[]) => void, logError: (...args: unknown[]) => void): number;
/**
 * Execute the COMPLETE setup authority branch: decide between local
 * server and Cloud, and for Cloud, probe + authenticate the session,
 * check subscription status with retry, drive the subscription menu,
 * and perform any browser/checkout/poll actions — all through injected
 * dependencies.
 *
 * Returns a result indicating which path was taken. Local returns
 * immediately with zero Cloud side effects. Auth rejection returns a
 * terminal {authFailed: true} result — the caller MUST exit before
 * subscription work.
 */
export declare function runSetupAuthority(authority: 'local' | 'cloud' | undefined, deps: SetupAuthorityDeps, opts?: {
    noBrowser?: boolean;
}): Promise<SetupAuthorityResult>;
//# sourceMappingURL=setup-authority.d.ts.map