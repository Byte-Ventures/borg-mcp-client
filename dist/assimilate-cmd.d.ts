import type { Role, RoleOccupant } from './role-resolver.js';
import { type CodexRemoteLaunch } from './codex-remote.js';
import type { BorgCli } from './cubes.js';
import type { SeatStatus } from './seat-probe.js';
export interface AssimilateFlags {
    worktree?: string;
    template?: string;
    noTemplate?: boolean;
    cubeName?: string;
    here?: boolean;
    yes?: boolean;
    cli?: BorgCli;
    model?: string;
    server?: string;
    enroll?: boolean;
}
export interface AssimilateArgs {
    role: string | undefined;
    flags: AssimilateFlags;
}
export interface CubeSummary {
    id: string;
    name: string;
}
export interface CubeDetail {
    id: string;
    name: string;
    roles: Role[];
    drones?: RoleOccupant[];
}
export interface AssimilateResult {
    cube_id: string;
    drone_id: string;
    drone_label: string;
    session_token?: string;
    role_id: string;
    local_session?: {
        credential_ref: string;
        generation: number;
        expires_at: string | null;
    };
    reattached?: boolean;
    /** Internal correlator used only to complete durable local attach state. */
    local_attach_retry_key?: string;
}
export interface ActiveCube {
    cubeId: string;
    droneId: string;
    name: string;
    sessionToken?: string;
    droneLabel: string;
    apiUrl: string;
    /** Verified local-server CA identity; absent for Borg Cloud cubes. */
    serverTrustIdentity?: string;
    localSessionCredentialRef?: string;
    localSessionGeneration?: number;
    localSessionExpiresAt?: string | null;
    roleName?: string;
    roleClass?: 'queen' | 'worker';
    isHumanSeat?: boolean;
}
export interface AssimilateDeps {
    runSync: (cmd: string, args: string[], cwd?: string) => {
        status: number | null;
        stdout: string;
        stderr: string;
    };
    pathExists: (p: string) => boolean;
    cwd: () => string;
    chdir: (p: string) => void;
    homedir: () => string;
    mkdirp: (dir: string) => void;
    exec: (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<number>;
    stderr: (line: string) => void;
    stdout: (line: string) => void;
    prompt: (message: string) => Promise<string>;
    promptSecret: (message: string) => Promise<string>;
    isTTY: () => boolean;
    getHostname: () => string;
    setTerminalTitle: (label: string, cubeName: string) => void;
    getActiveCube: () => Promise<ActiveCube | null>;
    hasPersistedActiveCube: () => Promise<boolean>;
    probeSeat: (sessionToken: string, apiUrl: string, serverTrustIdentity?: string) => Promise<SeatStatus>;
    getPendingLocalAttach: (apiUrl: string, serverTrustIdentity: string, cubeId: string, roleId: string) => Promise<{
        priorDroneId?: string;
        remintInvalidPrior: boolean;
    } | null>;
    completeLocalAttach: (apiUrl: string, serverTrustIdentity: string, cubeId: string, roleId: string) => Promise<void>;
    setActiveCube: (a: ActiveCube) => Promise<void>;
    findProjectRoot: (cwd: string) => string;
    installProjectSessionHook: (projectRoot: string) => void;
    getCachedAuth: () => Promise<{
        token: string;
        apiUrl: string;
    } | null>;
    runSetup: () => Promise<{
        token: string;
        apiUrl: string;
    }>;
    cloudApiUrl: string;
    detectLocalServer: () => Promise<string | null>;
    connectServer: (apiUrl: string, enrollment?: {
        invitation: string;
    }) => Promise<{
        token: string;
        trustIdentity: string;
    }>;
    resumeServerEnrollment: (apiUrl: string) => Promise<{
        token: string;
        trustIdentity: string;
    } | null>;
    listCubes: (apiUrl: string, token: string, serverTrustIdentity?: string) => Promise<CubeSummary[]>;
    getCube: (apiUrl: string, token: string, cubeId: string, serverTrustIdentity?: string) => Promise<CubeDetail>;
    createCube: (apiUrl: string, token: string, params: {
        name?: string;
        template?: string;
        projectRoot?: string;
    }, serverTrustIdentity?: string) => Promise<CubeDetail>;
    assimilate: (apiUrl: string, token: string, params: {
        cube_id: string;
        role_id: string;
        hostname?: string | null;
        prior_drone_id?: string;
        remint_invalid_prior?: boolean;
        model?: string | null;
        agent_kind?: 'claude' | 'codex' | 'opencode' | null;
    }, serverTrustIdentity?: string) => Promise<AssimilateResult>;
    listTemplates: (apiUrl: string, token: string, serverTrustIdentity?: string) => Promise<Array<{
        name: string;
        description: string;
    }>>;
    getInboxPath: (cubeId: string, droneId: string) => string;
    probeMcpReady: () => Promise<boolean>;
    resolveCli: (explicit?: BorgCli) => Promise<BorgCli>;
    prepareCodexRemoteLaunch: () => Promise<CodexRemoteLaunch>;
    setCodexWakeTarget: (cubeId: string, droneId: string, target: {
        threadId: string;
        socketPath: string;
    }) => Promise<void>;
    findLoadedCodexThread: (options: {
        socketPath: string;
        cwd: string;
        previewIncludes: string;
        updatedAfter: number;
    }) => Promise<string | null>;
}
export declare function runAssimilate(args: AssimilateArgs, deps: AssimilateDeps): Promise<number>;
/**
 * Sprint 4 / gh#147 (drone-8 SR-PE-FINDING-1): strip ASCII control
 * characters before interpolating subprocess stderr into operator-
 * facing messages. Defense-in-depth against a local attacker editing
 * `.git/config` to embed ANSI escapes (e.g. `\x1b[2J` cursor moves,
 * `\x1b]0;...\x07` title injection) — git command stderr then carries
 * them, and unfiltered orchestrator output corrupts the terminal.
 *
 * Strips `[\x00-\x1F\x7F]` (NUL, all C0 controls, DEL). ASCII
 * whitespace inside C0 (tab, newline, CR) gets stripped too — the
 * orchestrator only ever interpolates short status fragments where
 * preserving multi-line layout isn't load-bearing; over-strip
 * trade-off accepted for shape simplicity.
 */
export declare function safeStderr(msg: string): string;
/**
 * Sprint 19 (gh#184): suggest the closest cube-role name for a misspelled
 * CLI role argument. Levenshtein distance ≤2 against the cube's role
 * names; case-insensitive. Returns null when no close match exists.
 *
 * Serves Queen's "more user-friendly" intent without violating the
 * Borg-collective metaphor (collective defines roles; drones slot in).
 * The original strict-failure semantic is preserved; the suggestion
 * is an additive nudge in the error message, not a fallback path.
 */
export declare function suggestRoleName(input: string, candidates: string[]): string | null;
//# sourceMappingURL=assimilate-cmd.d.ts.map