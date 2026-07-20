/**
 * gh#780 option (ii): in-session borg_assimilate is RE-ATTACH-ONLY
 * (Queen ruling 33a62d94).
 *
 * Root-cause context: the retired attach path always
 * mints a new drone row — so agents
 * "recovering" from auth blips spawned orphan seats. The tool is now
 * structurally incapable of minting: it either re-attaches to the
 * worktree's saved identity (cubes.json) or refuses with CLI guidance.
 * Seat CREATION stays in the CLI (`borg assimilate` in a terminal), where
 * worktree spawn + identity persistence are handled coherently.
 */
import type { ActiveCube } from './cubes.js';
export type AssimilateDecision = {
    kind: 'reattach';
} | {
    kind: 'no-identity';
} | {
    kind: 'different-cube';
    activeCubeName: string;
};
/**
 * Classify an in-session assimilate request against the worktree's saved
 * identity. Pure — I/O and rendering stay outside this helper.
 */
export declare function classifyInSessionAssimilate(active: Pick<ActiveCube, 'name'> | null, requestedCubeName: string): AssimilateDecision;
/**
 * Agent-facing refusal text for the two non-reattach decisions. Always
 * directs seat creation to the CLI; never suggests an in-session mint.
 */
export declare function reattachOnlyRefusal(decision: Exclude<AssimilateDecision, {
    kind: 'reattach';
}>, requestedCubeName: string): string;
/**
 * Failure advice when a re-attach's server-validated calls fail.
 *
 * The seat is unreachable (evicted seat, revoked session, dead cube):
 * surface the server error verbatim plus CLI guidance. NEVER advise an
 * in-session re-mint (SR cond-4: no fabricated success, lean on server
 * re-validation).
 */
export declare function reattachFailureMessage(error: {
    name?: string;
    message?: string;
}): string;
//# sourceMappingURL=assimilate-guard.d.ts.map