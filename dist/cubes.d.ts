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
export declare function clearActiveCube(): Promise<{
    removed: boolean;
    credentialRef: string | null;
}>;
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