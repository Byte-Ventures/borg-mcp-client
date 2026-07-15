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
interface AuthErrorLike {
    name?: string;
    message?: string;
}
/**
 * Returns the agent-facing recovery message for an auth-class error, or
 * null when the error is not auth-related (caller falls through to its
 * generic error rendering). Transient classification wins over the generic
 * auth-text match — a transient error's message may also mention
 * "Authentication".
 */
export declare function authRecoveryMessage(error: AuthErrorLike): string | null;
export {};
//# sourceMappingURL=auth-recovery.d.ts.map