/**
 * gh#780 companion fix: classify auth-class failures into the RIGHT
 * recovery advice for an in-session agent.
 *
 * Root-cause context: the pre-gh#780 funnel answered every auth failure by
 * pointing the user at `borg assimilate` (the wrong remedy; gh#794 now also
 * differentiates a dead saved login from never-signed-in, both → `borg setup`).
 * An in-session agent's only reachable assimilate is the borg_assimilate MCP tool, which
 * minted a brand-new drones row — so each auth blip spawned an orphan seat
 * (the gh#780 class). Neither failure mode is fixable by assimilating:
 * assimilate rides the same broken Bearer token.
 *
 *   - REVOKED / re-consent required (RefreshTokenInvalidError surfaced as
 *     "Authentication required/expired"): only `borg setup` in a terminal
 *     re-consents.
 *   - TRANSIENT refresh failure (RefreshTransientError, "Failed to
 *     refresh"): keychain intact by design (gh#34) — the next call
 *     retries; waiting IS the recovery.
 */
/**
 * Returns the agent-facing recovery message for an auth-class error, or
 * null when the error is not auth-related (caller falls through to its
 * generic error rendering). Transient classification wins over the generic
 * auth-text match — a transient error's message may also mention
 * "Authentication".
 */
export function authRecoveryMessage(error) {
    const message = error.message ?? '';
    if (error.name === 'RefreshTransientError' || message.includes('Failed to refresh')) {
        return ('◼ Transient auth-refresh failure (network/Google hiccup). Your session is intact ' +
            'and auth self-recovers — retry the tool call in a moment. ' +
            'Do NOT re-assimilate: borg_assimilate cannot fix auth and would mint a duplicate drone seat.');
    }
    if (message.includes('Authentication required') || message.includes('Authentication expired')) {
        return ('◼ Authentication expired — re-consent needed. Run `borg setup` in a terminal to sign in again. ' +
            'Do NOT re-assimilate: borg_assimilate cannot fix auth and would mint a duplicate drone seat.');
    }
    return null;
}
//# sourceMappingURL=auth-recovery.js.map