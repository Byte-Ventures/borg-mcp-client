/**
 * gh#780 option (ii): in-session borg_assimilate is RE-ATTACH-ONLY
 * (Queen ruling 33a62d94).
 *
 * Root-cause context: the tool used to POST /api/assimilate, which ALWAYS
 * mints a new drone row — so agents
 * "recovering" from auth blips spawned orphan seats. The tool is now
 * structurally incapable of minting: it either re-attaches to the
 * worktree's saved identity (cubes.json) or refuses with CLI guidance.
 * Seat CREATION stays in the CLI (`borg assimilate` in a terminal), where
 * worktree spawn + identity persistence are handled coherently.
 */
import { authRecoveryMessage } from './auth-recovery.js';
/** Cube names are lowercase server-side; tolerate caller case/whitespace. */
function normalizeCubeName(name) {
    return name.trim().toLowerCase();
}
/**
 * Classify an in-session assimilate request against the worktree's saved
 * identity. Pure — the caller owns I/O and rendering.
 */
export function classifyInSessionAssimilate(active, requestedCubeName) {
    if (!active)
        return { kind: 'no-identity' };
    if (normalizeCubeName(active.name) === normalizeCubeName(requestedCubeName)) {
        return { kind: 'reattach' };
    }
    return { kind: 'different-cube', activeCubeName: active.name };
}
/**
 * Agent-facing refusal text for the two non-reattach decisions. Always
 * directs seat creation to the CLI; never suggests an in-session mint.
 */
export function reattachOnlyRefusal(decision, requestedCubeName) {
    if (decision.kind === 'no-identity') {
        return (`◼ This session has no drone seat for this worktree, and in-session borg_assimilate is ` +
            `re-attach-only (it never creates seats — gh#780). To create a seat for cube ` +
            `"${requestedCubeName}", run \`borg assimilate\` in a terminal — it spawns the worktree, ` +
            `persists the identity, and launches the agent in one step.`);
    }
    return (`◼ This worktree is attached to cube "${decision.activeCubeName}"; in-session ` +
        `borg_assimilate is re-attach-only and cannot switch to "${requestedCubeName}" (gh#780). ` +
        `To work in "${requestedCubeName}", run \`borg assimilate\` in a terminal from that ` +
        `project (or spawn a fresh worktree for it).`);
}
/**
 * Failure advice when a re-attach's server-validated calls fail.
 *
 * Returns null for auth-class failures — the index.ts auth funnel
 * (auth-recovery.ts) owns that advice; the caller rethrows. For everything
 * else (evicted seat, revoked session, dead cube) the seat is unreachable:
 * surface the server error verbatim plus CLI guidance. NEVER advise an
 * in-session re-mint (SR cond-4: no fabricated success, lean on server
 * re-validation).
 */
export function reattachFailureMessage(error) {
    if (authRecoveryMessage(error))
        return null;
    const detail = error.message ?? String(error);
    return (`◼ Re-attach failed — this worktree's saved seat is unreachable (likely evicted or its ` +
        `session was revoked). Server said: ${detail}\n` +
        `Recover by running \`borg assimilate\` in a terminal to create a fresh seat; ` +
        `in-session borg_assimilate never re-mints (gh#780).`);
}
//# sourceMappingURL=assimilate-guard.js.map