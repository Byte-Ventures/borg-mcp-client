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
 * local-server trust can no longer be hydrated (no cloud plaintext tokens).
 *
 * apiUrl is captured at assimilate time so subprocess invocations (e.g. the
 * SessionStart hook firing borg-regen) don't need BORG_API_URL in their env
 * to know which worker to talk to.
 */
import { rename, unlink, writeFile } from 'node:fs/promises';
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
    localSessionExpiresAt?: string | null;
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
 * Distinguish a genuinely new worktree from one whose persisted local seat can
 * no longer be hydrated (for example, because its keychain item is missing).
 * No authority-bearing fields are returned through this diagnostic seam.
 */
export declare function hasPersistedActiveCube(): Promise<boolean>;
/**
 * Set the active cube for the current project. Preserves entries for all
 * other projects.
 */
export declare function setActiveCube(active: ActiveCubeInput): Promise<void>;
export declare function activeCubeWithFreshRegenIdentity(active: ActiveCube, result: {
    cube?: {
        name?: string | null;
    };
    drone?: {
        label?: string | null;
    };
}): ActiveCube;
/**
 * Clear the active cube for the current project. If the projects map
 * becomes empty as a result, remove the file entirely rather than leave
 * an empty {projects:{}} skeleton.
 */
export declare function clearActiveCube(expected?: {
    credentialRef?: string | null;
    sessionDigest?: string;
}): Promise<{
    removed: boolean;
    credentialRef: string | null;
}>;
/**
 * Typed token-safe observation of this worktree's saved local seat credential.
 * The raw bearer is never surfaced past this module — PRESENT carries only its
 * sha256 digest so the caller (the offline `borg reset-local-seat` command) can
 * pin the exact credential it observed without ever handling the secret.
 */
export type LocalSeatObservation = {
    kind: 'present';
    sessionDigest: string;
} | {
    kind: 'absent';
};
export interface LocalSeatSnapshot {
    apiUrl: string;
    serverTrustIdentity: string;
    cubeId: string;
    credentialRef: string;
    worktree: string;
    observation: LocalSeatObservation;
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
 * S0 of the ratified client-seat-reset-state-model: snapshot this worktree's
 * exact local-seat binding plus a token-safe observation of its keychain
 * credential (PRESENT+digest | ABSENT). Read-only — no lock is held past the
 * read, and the authoritative re-check happens under the cube lock in
 * resetLocalSeatBinding. Returns null when this worktree has no LOCAL-server
 * seat to reset (no binding, or a non-local/legacy binding): an honest no-op.
 */
export declare function snapshotLocalSeat(): Promise<LocalSeatSnapshot | null>;
/**
 * S2/S3 of the ratified client-seat-reset-state-model. Re-acquires the cube
 * write lock (OUTER; the keychain lock is only ever taken INNER via
 * compareAndClearServerSessionCredential — never a keychain→cube inversion),
 * re-observes the typed union, and commits only when the current binding STILL
 * matches the exact snapshot. Any change / missing / same-ref replacement is an
 * honest no-op ('changed'). Ordering is CREDENTIAL-FIRST: the keychain bearer is
 * deleted before the cube binding is removed, so the only surviving intermediate
 * state is binding-present/credential-absent — safe, rerunnable, and truthful.
 */
export declare function resetLocalSeatBinding(expected: LocalSeatSnapshot): Promise<ResetLocalSeatOutcome>;
/**
 * Typed prepare-time expectation for the composite attach FINALIZE (ratified
 * client-seat-reset-state-model clause 3). REATTACH declares EXACT — the exact
 * prior live binding must still hold at commit time (its ref, and when a live
 * bearer is being preserved, its digest). FIRST-ENROLL (and a fresh sibling
 * seat) declares ABSENT — no binding may have appeared. A self-remint after an
 * authoritative eviction declares EXACT with the ref only (the bearer is
 * intentionally replaced, so no digest is pinned).
 */
export type ExpectedBinding = {
    kind: 'exact';
    credentialRef: string;
    sessionDigest?: string;
} | {
    kind: 'absent';
};
export interface FinalizeServerSeatInput {
    /** The full worktree binding to persist (must carry the local-server trust +
     *  the localSessionCredentialRef of the exact PENDING record). */
    active: ActiveCubeInput;
    /** Typed expectation declared at PREPARE. */
    expected: ExpectedBinding;
    /** The single keychain pending→ACTIVE transition — run LAST, after the binding. */
    activate: () => Promise<unknown>;
    /** Compare-and-scrub the caller's OWN pending record on abort (never an ACTIVE
     *  record, never a same-ref replacement). */
    scrubPending: () => Promise<unknown>;
}
export type FinalizeServerSeatOutcome = {
    committed: true;
} | {
    committed: false;
    reason: 'expectation-mismatch';
};
/**
 * COMPOSITE cube-owned FINALIZE closing Race 2 on the attach path (ratified
 * client-seat-reset-state-model clause 3). The CUBE write lock is held OUTER and
 * CONTINUOUSLY across revalidate → write-binding → activate; the keychain lock is
 * only ever taken INNER, inside the injected activate()/scrubPending() config
 * wrappers (never a keychain→cube inversion). The network POST already happened
 * between PREPARE and this call, with the cube lock released.
 *
 * REVALIDATE the current worktree binding against the typed expectation:
 *   EXACT  — the prior binding must still exist with the exact same ref (and, when
 *            a digest is pinned, the live bearer's digest must still match — an
 *            absent/same-ref-replaced credential is a mismatch);
 *   ABSENT — no binding may have appeared.
 * Any mismatch = ABORT: compare-and-scrub ONLY the caller's own pending record,
 * never a silent recreate (this is the exact PREPARE-paused → offline-reset-commits
 * → FINALIZE-aborts shape — the reset stays complete, no orphan is minted).
 *
 * On match, FINALIZE is BINDING-FIRST: persist the cubes binding referencing the
 * exact PENDING record FIRST, THEN the single keychain pending→ACTIVE transition
 * LAST. The invariant "ACTIVE credential without a binding" is UNREACHABLE in
 * every crash/interleave order; the only surviving intermediate is
 * binding-present/credential-PENDING — non-hydratable (getActiveServerSessionCredential
 * requires state=='active'), retry-safe, and truthful. An activate() throw
 * leaves exactly that state (the binding stays written); re-running PREPARE+FINALIZE
 * converges.
 */
export declare function finalizeServerSeatAttachment(input: FinalizeServerSeatInput): Promise<FinalizeServerSeatOutcome>;
/**
 * Metadata-only refresh (cube name / drone label / role display) for the CURRENT
 * worktree's existing binding. Deliberately CANNOT alter the seat reference,
 * identity, or credential binding: it reads the persisted entry, overlays ONLY
 * the display fields, and rewrites — localSessionCredentialRef, cubeId, droneId,
 * apiUrl, and serverTrustIdentity are taken verbatim from the PERSISTED entry,
 * never from the argument. A no-op when this worktree has no binding, so a stale
 * regen identity can never resurrect or mutate a seat ref. (Part D: split from
 * the seat-ref/binding commit path setActiveCube / finalizeServerSeatAttachment.)
 */
export declare function refreshActiveCubeMetadata(active: ActiveCubeInput): Promise<void>;
export declare function getProjectCliPreference(): Promise<BorgCli | null>;
/**
 * gh#556 Part 2 — like getProjectCliPreference, but keyed on an arbitrary
 * worktree dir (launch-all reads the saved CLI preference for EACH discovered
 * worktree, not just cwd). Returns null if no preference is saved for that path.
 */
export declare function getProjectCliPreferenceForPath(dir: string): Promise<BorgCli | null>;
/**
 * gh#556 Part 2 — returns all persisted project identities from cubes.json.
 * Used by `borg launch-all` to enumerate drones across all known worktrees
 * (scheme-agnostic — covers both old sibling paths and new ~/.borg paths).
 * Returns an empty array if the file is absent or malformed.
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