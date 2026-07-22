/**
 * Per-project active-cube persistence for Borg MCP client
 *
 * Stores the currently-assimilated cube identity + authority metadata PER
 * PROJECT in ~/.config/borgmcp/cubes.json. The "project"
 * is identified by walking up from cwd to find a .git directory; if none is
 * found, cwd itself is used as the project key.
 *
 * Local-server session tokens never enter this file: only an opaque keychain
 * reference is stored and hydrated at read time. An entry without verified
 * local-server trust can no longer be hydrated.
 *
 * apiUrl is captured at assimilate time so subprocess invocations (e.g. the
 * SessionStart hook firing borg-regen) don't need BORG_API_URL in their env
 * to know which worker to talk to.
 */
import { rename, unlink, writeFile } from 'node:fs/promises';
import { type SeatObservation, type SeatOperation } from './seats.js';
/** Re-exported from seats.ts for call-site parity (the retired cross-store name). */
export type { SeatExpectation as ExpectedBinding } from './seats.js';
export type BorgCli = 'claude' | 'codex' | 'opencode';
export interface ActiveCube {
    cubeId: string;
    droneId: string;
    name: string;
    sessionToken: string;
    droneLabel: string;
    apiUrl: string;
    /** Verified local-server CA identity; absent until a local server is selected. */
    serverTrustIdentity?: string;
    /** Opaque local-session keychain reference; never a bearer. */
    localSessionCredentialRef?: string;
    roleName?: string;
    roleClass?: 'queen' | 'worker';
    isHumanSeat?: boolean;
}
export type ActiveCubeInput = Omit<ActiveCube, 'sessionToken'> & {
    sessionToken?: string;
};
export interface CodexWakeTargetRecord {
    threadId: string;
    socketPath: string;
    updatedAt: string;
}
/**
 * Walk up from cwd looking for a .git directory. If found, return that
 * directory. If not found by filesystem root, return the original cwd.
 * The returned absolute path is the "project key" used to scope cube state.
 */
export declare function findProjectRoot(cwd?: string): string;
export declare function inboxPathForDrone(cubeId: string, droneId: string): string;
export declare function atomicWriteFile(filePath: string, data: string, opts?: {
    mode?: number;
    io?: {
        writeFile: typeof writeFile;
        rename: typeof rename;
        unlink: typeof unlink;
    };
}): Promise<void>;
/**
 * Get the currently-active cube for the current project, or null if not
 * assimilated in this project. Entries written by older client versions
 * that lack the `cubeId` field are treated as absent — re-assimilate to
 * refresh.
 */
export declare function getActiveCube(): Promise<ActiveCube | null>;
/**
 * True iff this worktree has an ACTIVE bound seat in seats.json. In the collapsed
 * single-store model the credential and the worktree binding are one atomic unit,
 * so there is no "binding present but credential lost" partial state to diagnose:
 * an active bound seat always hydrates.
 */
export declare function hasPersistedActiveCube(): Promise<boolean>;
/**
 * Legacy binding-only writer. In the collapsed single-store model an ACTIVE seat is
 * created ONLY by the atomic mint→activate+bind path in seats.ts (driven by the
 * attach FINALIZE); there is no standalone binding write. Retained solely as a
 * fail-closed guard for incomplete session metadata.
 */
export declare function setActiveCube(_active: ActiveCubeInput): Promise<void>;
export declare function activeCubeWithFreshRegenIdentity(active: ActiveCube, result: {
    cube?: {
        name?: string | null;
    };
    drone?: {
        label?: string | null;
    };
    role?: {
        name?: string | null;
        role_class?: 'queen' | 'worker' | null;
        is_human_seat?: boolean | null;
    };
}): ActiveCube;
export interface LocalSeatSnapshot {
    apiUrl: string;
    serverTrustIdentity: string;
    cubeId: string;
    /** The FULL binding includes the prior drone identity (CR #3): a drone-id
     *  change at recheck is a full-binding change and aborts the reset. CR#4: a
     *  bound-PENDING record (a sibling whose activation failed) may carry NO drone id
     *  yet — the snapshot then omits it and the reset matches on undefined-vs-undefined,
     *  still deleting the exact record. */
    droneId?: string;
    credentialRef: string;
    worktree: string;
    /** Token-safe TYPED seat observation: active|pending (with digest) or absent. */
    observation: SeatObservation;
}
export type ResetLocalSeatOutcome = {
    outcome: 'reset';
    credentialRef: string;
} | {
    outcome: 'no-binding';
} | {
    outcome: 'changed';
};
/**
 * Snapshot this worktree's exact FULL local-seat binding (incl drone id) plus a
 * token-safe TYPED observation (active + digest | absent). Read-only. Returns null
 * when this worktree has no ACTIVE bound seat to reset: an honest no-op.
 */
export declare function snapshotLocalSeat(): Promise<LocalSeatSnapshot | null>;
export interface PersistedLocalSeat {
    cubeId: string;
    /** Optional: a bound-PENDING record (a sibling whose activation failed) may carry
     *  no drone id yet — the ACTIVE resume path still has it. */
    droneId?: string;
    name: string;
    droneLabel: string;
    apiUrl: string;
    serverTrustIdentity: string;
    localSessionCredentialRef: string;
    roleName?: string;
    roleClass?: 'queen' | 'worker';
    isHumanSeat?: boolean;
    /** The STORED seat operation (projectRoot + kind + operationKey). The resume path
     *  re-derives the EXACT seat ref from this: for a bound-PENDING sibling it is the
     *  ORIGINAL sibling operation, NOT the rerun worktree's derived seat operation —
     *  so the rerun re-mints-or-reuses the identical pending bearer and converges. */
    operation: SeatOperation;
    /** The record state: a bound-PENDING record resumes with an ABSENT/pending-reuse
     *  expectation (re-send the identical bearer); an ACTIVE one resumes with EXACT. */
    state: 'pending' | 'active';
}
/**
 * Read the RAW persisted local-server seat bound to the current worktree — ACTIVE
 * or a bound-PENDING record — WITHOUT hydrating its credential. Used by the resume
 * path to recover the seat identity, its stored `operation`, and its `state`.
 *
 * CR#2: a SIBLING attach whose activation failed leaves a PENDING record BOUND to
 * the preserved worktree (via the attach path's bind-pending step). This surfaces it so the
 * rerun-from-that-worktree re-derives the EXACT sibling ref and re-sends the
 * identical bearer (ghost-free convergence). A crash-in-gap PENDING record that was
 * NEVER bound to a worktree still returns null here (it carries no worktree locator)
 * and is resumed by prepareSeat's idempotent mint-or-reuse; a genuine absence is
 * likewise null and a fresh enroll mints correctly.
 */
export declare function readPersistedLocalSeat(): Promise<PersistedLocalSeat | null>;
/**
 * Reset this worktree's seat: delegate to the single-store resetSeatForWorktree,
 * which under ONE flock re-checks the exact FULL binding (ref + drone id, CR #3)
 * plus the token-safe observation and DELETES the whole record — credential AND
 * binding vanish together in one commit. Any drift / missing / same-ref digest
 * replacement is an honest no-op ('changed'); no cross-store 'partial' exists.
 */
export declare function resetLocalSeatBinding(expected: LocalSeatSnapshot): Promise<ResetLocalSeatOutcome>;
export type FinalizeServerSeatOutcome = {
    committed: true;
} | {
    committed: false;
    reason: 'expectation-mismatch';
} | {
    committed: false;
    reason: 'activation-failed';
};
/**
 * Metadata-only refresh (cube name / drone label / role display) of the CURRENT
 * worktree's ACTIVE seat — delegates to seats.ts refreshSeatMetadata, which CANNOT
 * alter the credential, ref, identity, or worktree binding. A no-op when this
 * worktree has no active seat, so a stale regen identity can never resurrect or
 * mutate a seat ref.
 */
export declare function refreshActiveCubeMetadata(active: ActiveCubeInput): Promise<boolean>;
export declare function getProjectCliPreference(): Promise<BorgCli | null>;
/**
 * gh#556 Part 2 — like getProjectCliPreference, but keyed on an arbitrary
 * worktree dir (launch-all reads the saved CLI preference for EACH discovered
 * worktree, not just cwd). Returns null if no preference is saved for that path.
 */
export declare function getProjectCliPreferenceForPath(dir: string): Promise<BorgCli | null>;
/**
 * gh#556 Part 2 — returns all persisted project identities from the seat store.
 * Used by `borg launch-all` to enumerate drones across all known worktrees.
 * Returns an empty array when no ACTIVE bound seats exist.
 */
export declare function readAllProjectIdentities(): Promise<Array<{
    projectPath: string;
    cube: ActiveCube;
}>>;
export declare function setProjectCliPreference(cli: BorgCli): Promise<void>;
export declare function setCodexWakeTarget(cubeId: string, droneId: string, target: Omit<CodexWakeTargetRecord, 'updatedAt'>): Promise<void>;
export declare function getCodexWakeTarget(cubeId: string, droneId: string): Promise<CodexWakeTargetRecord | null>;
/**
 * gh#855: drop wake-target entries whose app-server socket is positively dead,
 * so the file self-heals (stale dead-socket entries from crashed prior launches
 * don't linger and mislead probeCodexBridgeArmed / health-beat). Pure prune
 * decision lives in codex-wake-resolve.ts (false-deaf-avoidance: keeps alive +
 * indeterminate); this is the thin read → prune → write-only-on-change glue.
 * The liveness check is injected (claude.ts wires checkCodexBridgeHealthy) so
 * cubes.ts stays free of the codex-remote dependency.
 */
export declare function pruneDeadCodexWakeTargets(socketLiveness: (socketPath: string) => boolean | null): Promise<void>;
//# sourceMappingURL=cubes.d.ts.map