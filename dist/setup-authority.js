/**
 * gh#27 (CR 5f20d3f1): extracted setup authority branch with dependency
 * injection so the local-first promise is unit-pinned. `setup.ts` is a
 * self-executing script with no exports; this module provides the
 * testable seam for the authority decision and Cloud-only auth probe.
 *
 * Local path: zero probeSession / authenticateWithGoogle /
 * checkSubscriptionStatus / createSubscription / open calls.
 *
 * Cloud path: probes the saved session, authenticates if needed, then
 * hands back to the caller for subscription handling.
 */
import { setupActionForSession } from './setup-action.js';
/**
 * Execute the setup authority branch: decide between local server and
 * Cloud, and for Cloud, probe + authenticate the session.
 *
 * Returns a result indicating which path was taken. Local returns
 * immediately with zero Cloud side effects. Cloud calls probeSession
 * and conditionally authenticateWithGoogle.
 *
 * `noBrowser` is forwarded to authenticateWithGoogle when the Cloud
 * re-auth path is entered.
 */
export async function runSetupAuthority(authority, deps, opts) {
    const useCloud = authority === 'cloud';
    if (!useCloud) {
        deps.log('Local server mode — no account or subscription needed.');
        return { useCloud: false };
    }
    // Cloud path: probe session then authenticate if needed.
    const sessionState = await deps.probeSession();
    const action = setupActionForSession(sessionState);
    if (action === 'retry') {
        deps.logError('Could not reach Google to verify your session (network issue). ' +
            'Re-run `borg setup` when your connection is back.');
        return { useCloud: true, authAction: 'retry' };
    }
    if (action === 'reauth') {
        await deps.authenticateWithGoogle(opts?.noBrowser ? { noBrowser: true } : undefined);
    }
    return { useCloud: true, authAction: action };
}
//# sourceMappingURL=setup-authority.js.map