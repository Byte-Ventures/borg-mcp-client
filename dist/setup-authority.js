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
import { setupActionForSession } from './setup-action.js';
import { retrySubscriptionCheck } from './subscription-retry.js';
/** Type guard: auth rejection (terminal — caller must exit). */
export function isAuthFailed(r) {
    return 'authFailed' in r && r.authFailed === true;
}
/** Type guard: network retry (caller should exit). */
export function isAuthRetry(r) {
    return r.useCloud && 'authAction' in r && r.authAction === 'retry';
}
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
export function handleAuthorityResult(result, log, logError) {
    if (!result.useCloud) {
        log('  To use a local server, run `borg assimilate --host <host>` in your project.\n');
        return 0;
    }
    if (isAuthFailed(result)) {
        return 1;
    }
    if (isAuthRetry(result)) {
        return 1;
    }
    return 0;
}
// ── Private helpers ────────────────────────────────────────────────
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 24;
async function pollForSubscription(check, sleep, log) {
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
        await sleep(POLL_INTERVAL_MS);
        try {
            const status = await check();
            if (status.hasAccess) {
                log('Subscription activated!');
                return;
            }
        }
        catch {
            // Continue polling even on errors
        }
    }
    throw new Error('Timeout - Run setup again after subscribing');
}
// ── Main entry point ──────────────────────────────────────────────
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
export async function runSetupAuthority(authority, deps, opts) {
    if (authority !== 'cloud') {
        deps.log('Local server mode — no account or subscription needed.');
        return { useCloud: false };
    }
    // ── Cloud: probe session ────────────────────────────────────────
    const sessionState = await deps.probeSession();
    const action = setupActionForSession(sessionState);
    if (action === 'retry') {
        deps.logError('Could not reach Google to verify your session (network issue). ' +
            'Re-run `borg setup` when your connection is back.');
        return { useCloud: true, authAction: 'retry' };
    }
    if (action === 'reauth') {
        // gh#557: actionable error recovery — auth rejection prints a
        // specific message telling the user to retry, instead of falling
        // through to a generic "Setup failed".
        try {
            await deps.authenticateWithGoogle(opts?.noBrowser ? { noBrowser: true } : undefined);
        }
        catch (error) {
            deps.logError(`Authentication failed: ${error.message}`);
            deps.logError('Re-run `borg setup` to try again.');
            return { useCloud: true, authFailed: true };
        }
    }
    else {
        deps.log('Already signed in');
    }
    // ── Cloud: subscription check + retry ───────────────────────────
    deps.log('Subscription Check');
    let status;
    try {
        status = await deps.checkSubscriptionStatus();
    }
    catch (error) {
        deps.logError(`Subscription check failed: ${error.message}`);
        deps.logError('Retrying before falling back to the Free tier...');
        status = { hasAccess: false };
    }
    status = await retrySubscriptionCheck(status, {
        check: deps.checkSubscriptionStatus,
        sleep: deps.sleep,
    });
    if (status.hasAccess) {
        deps.log('Active subscription found');
        if (status.expiresAt) {
            deps.log(`  Expires: ${new Date(status.expiresAt).toLocaleDateString()}`);
        }
        return { useCloud: true, authAction: action, subscriptionStatus: status };
    }
    // ── Cloud: subscription menu + actions ──────────────────────────
    deps.log("You're on the Free tier — permanent, no card needed: 1 cube + 3 agent sessions + 100 req/hr.");
    deps.log('Start using borgmcp right now. Upgrade any time: $1/month per cube, each cube adds 8 pooled agent sessions + 1000 req/hr.');
    const subscribeMethod = await deps.selectSubscribeMethod();
    if (subscribeMethod === undefined || subscribeMethod === 'skip') {
        deps.log("You're all set on the Free tier: 1 cube, 3 agent sessions, 100 req/hr.");
        return { useCloud: true, authAction: action, subscriptionStatus: status };
    }
    if (subscribeMethod === 'web') {
        deps.log('Opening: https://borgmcp.ai/subscribe');
        try {
            await deps.openUrl('https://borgmcp.ai/subscribe');
            deps.log('Waiting for subscription (checking every 5s for 2 min)...');
            await pollForSubscription(deps.checkSubscriptionStatus, deps.sleep, deps.log);
        }
        catch (error) {
            deps.logError(error.message);
            deps.log('Continuing on the Free tier. Upgrade any time from https://borgmcp.ai/subscribe.');
        }
    }
    else if (subscribeMethod === 'stripe') {
        try {
            const checkoutUrl = await deps.createSubscription();
            deps.log(`Opening Stripe: ${checkoutUrl}`);
            await deps.openUrl(checkoutUrl);
            deps.log('Waiting for subscription...');
            await pollForSubscription(deps.checkSubscriptionStatus, deps.sleep, deps.log);
        }
        catch (error) {
            deps.logError(`Failed to create checkout: ${error.message}`);
            deps.log('Continuing on the Free tier. Upgrade any time from https://borgmcp.ai/subscribe.');
        }
    }
    else if (subscribeMethod === 'recheck') {
        try {
            let recheckStatus;
            try {
                recheckStatus = await deps.checkSubscriptionStatus();
            }
            catch {
                recheckStatus = { hasAccess: false };
            }
            recheckStatus = await retrySubscriptionCheck(recheckStatus, {
                check: deps.checkSubscriptionStatus,
                sleep: deps.sleep,
            });
            if (recheckStatus.hasAccess) {
                deps.log('Subscription found!');
            }
            else {
                deps.log('No subscription found — continuing on the Free tier.');
            }
        }
        catch (error) {
            deps.logError(`Failed to recheck: ${error.message}`);
            deps.log('Continuing on the Free tier.');
        }
    }
    return { useCloud: true, authAction: action, subscriptionStatus: status };
}
//# sourceMappingURL=setup-authority.js.map