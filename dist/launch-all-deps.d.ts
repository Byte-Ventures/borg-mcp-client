import type { ActiveCube } from './cubes.js';
import { type SeatStatus } from './seat-probe.js';
/** Subprocess runner — sync, returns stdout, THROWS on non-zero exit or ENOENT. */
export type RunSyncFn = (cmd: string, args: string[]) => string;
export interface LaunchAllDeps {
    /** Subprocess — sync, throws on non-zero exit (git, tmux -V, ...). */
    runSync: (cmd: string, args: string[], opts?: {
        cwd?: string;
    }) => string;
    /** Subprocess — sync, returns exit code WITHOUT throwing (tmux has-session). */
    runSyncExitCode: (cmd: string, args: string[]) => number;
    /**
     * Interactive subprocess with INHERITED stdio (terminal handover) — used for
     * `tmux attach-session` / `switch-client`, where a captured stdout would not
     * render the TUI. Spec §10's capture-runSync cannot interactively attach; this
     * seam completes that (real: spawnSync stdio:'inherit').
     */
    attachInteractive: (cmd: string, args: string[]) => void;
    /** Absolute path of the current working directory. */
    cwd: () => string;
    /** True iff the path exists on disk. */
    pathExists: (p: string) => boolean;
    /** $HOME / os.homedir(). */
    homedir: () => string;
    /** mkdir -p (recursive; no chmod of existing parents). */
    mkdirp: (dir: string) => void;
    /** Read a file; returns null on ENOENT (never throws for absence). */
    readFileOpt: (p: string) => string | null;
    /** Write a file (mode default 0o600). */
    writeFile: (p: string, content: string, mode?: number) => void;
    /** Unlink a file; does NOT throw on ENOENT. */
    unlinkOpt: (p: string) => void;
    /** mtime in ms, or null if absent. */
    statMtime: (p: string) => number | null;
    /** Directory entries, or [] if absent. */
    listDir: (p: string) => string[];
    /** Roster call (wraps getRoster from remote-client.ts). */
    getRoster: (token: string, apiUrl: string, since?: string, serverTrustIdentity?: string) => Promise<{
        drones: Array<{
            id: string;
            seen_since?: boolean;
        }>;
    }>;
    /** getCube for --only tier-2 role-name resolution (best-effort). */
    getCube: (apiUrl: string, token: string, cubeId: string) => Promise<{
        id: string;
        name: string;
        roles: Array<{
            id: string;
            name: string;
        }>;
    }>;
    /**
     * Probe ONE saved seat's server-side liveness using ITS OWN token (gh#877
     * reuse via seat-probe.ts). Lets launch-all skip evicted seats instead
     * of relaunching them (which silently re-mints a fresh drone — resurrection).
     */
    probeSeat: (sessionToken: string, apiUrl: string, serverTrustIdentity?: string) => Promise<SeatStatus>;
    /** Saved CLI preference for a worktree path (launch.json). */
    getCliPreferenceForPath: (projectPath: string) => Promise<'claude' | 'codex' | 'opencode' | null>;
    /** All persisted project identities from cubes.json. */
    readAllProjectIdentities: () => Promise<Array<{
        projectPath: string;
        cube: ActiveCube;
    }>>;
    /** findProjectRoot (cubes.ts export). */
    findProjectRoot: (dir: string) => string;
    /** Active cube for the cwd (cubes.ts getActiveCube), null if none. */
    getActiveCube: () => Promise<ActiveCube | null>;
    /** Interactive confirmation prompt. */
    prompt: (message: string) => Promise<string>;
    /** TTY check (stdin). */
    isTTY: () => boolean;
    /** Environment variable accessor (e.g. $BORG_TERMINAL, $TMUX). */
    getEnv: (name: string) => string | undefined;
    /** process.platform (injectable for native-Windows/WSL backend-selection tests). */
    platform: () => NodeJS.Platform;
    /** stderr writer. */
    stderr: (line: string) => void;
    /** stdout writer. */
    stdout: (line: string) => void;
}
/** Real-IO factory wiring production modules (spec §10). Test code stubs LaunchAllDeps directly. */
export declare function buildDefaultLaunchAllDeps(): LaunchAllDeps;
//# sourceMappingURL=launch-all-deps.d.ts.map