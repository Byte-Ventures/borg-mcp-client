import type { Role, RoleOccupant } from './role-resolver.js';
import { type CodexRemoteLaunch } from './codex-remote.js';
import type { BorgCli } from './cubes.js';
import type { SeatStatus } from './seat-probe.js';
import type { ServerSessionOperation } from './config.js';
import type { ExpectedBinding, FinalizeServerSeatOutcome, PersistedLocalSeat } from './cubes.js';
import type { SeatBinding } from './seats.js';
import { type LaunchApprovalDecision } from './cli-tool-approval.js';
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
    };
    result?: 'created' | 'reused';
    finalize?: {
        activate: (binding: SeatBinding) => Promise<unknown>;
        scrubPending: () => Promise<unknown>;
        bindPending?: (binding: SeatBinding) => Promise<unknown>;
    };
    prepareAborted?: boolean;
}
export interface ActiveCube {
    cubeId: string;
    droneId: string;
    name: string;
    sessionToken?: string;
    droneLabel: string;
    apiUrl: string;
    /** Verified local-server CA identity; absent until a local server is selected. */
    serverTrustIdentity?: string;
    localSessionCredentialRef?: string;
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
    /** Verify writable Borg state before any local read or remote mutation. */
    preparePrivateRoot?: () => Promise<void>;
    exec: (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<number>;
    stderr: (line: string) => void;
    stdout: (line: string) => void;
    prompt: (message: string) => Promise<string>;
    promptSecret: (message: string) => Promise<string>;
    isTTY: () => boolean;
    /** Selected-harness approval inspection/consent (client#20). */
    resolveCliApprovals?: (cli: BorgCli, cwd: string) => Promise<LaunchApprovalDecision>;
    getHostname: () => string;
    setTerminalTitle: (label: string, cubeName: string) => void;
    getActiveCube: () => Promise<ActiveCube | null>;
    hasPersistedActiveCube: () => Promise<boolean>;
    /** Read the RAW persisted local seat for this worktree WITHOUT hydrating its
     *  keychain credential — used to recover a crash-in-gap PENDING seat when
     *  getActiveCube() returns null purely because the credential is non-hydratable
     *  (binding written by FINALIZE, then a crash before the pending→ACTIVE flip). */
    readPersistedLocalSeat?: () => Promise<PersistedLocalSeat | null>;
    /** Pure PEEK: is a resumable session RECORD (pending or active) present at the
     *  per-seat ref? Distinguishes a rerunnable crash-in-gap state from genuine
     *  keychain loss without creating or mutating anything. */
    peekServerSessionRecord?: (credentialRef: string, binding: {
        origin: string;
        trustIdentity: string;
        cubeId: string;
    }) => Promise<boolean>;
    /** CR#3: recover an in-flight IMPLICIT-sibling attempt (a crash-orphaned UNBOUND
     *  pending sibling record) keyed by source repo, so a rerun re-derives the EXACT
     *  seat ref + re-sends the identical bearer (server reuses — no ghost). Returns the
     *  stored operation + role so the rerun adopts them. Absent from unit stubs that
     *  fully mock `assimilate`. */
    findIncompleteSiblingAttempt?: (binding: {
        origin: string;
        trustIdentity: string;
        cubeId: string;
        projectRoot: string;
    }) => Promise<{
        operation: ServerSessionOperation;
        roleId: string;
        credentialRef: string;
    } | null>;
    probeSeat: (sessionToken: string, apiUrl: string, serverTrustIdentity?: string) => Promise<SeatStatus>;
    setActiveCube: (a: ActiveCube) => Promise<void>;
    /** COMPOSITE cube-owned FINALIZE (Race 2): under the cube lock, revalidate the
     *  typed expectation, persist the binding FIRST, then run `activate` (keychain
     *  pending→ACTIVE) LAST; on mismatch, `scrubPending` the own pending record and
     *  report an honest abort. Wired to the merged activate+bind FINALIZE in
     *  production; absent from unit stubs that fully mock `assimilate`. */
    finalizeServerSeat?: (input: {
        active: ActiveCube;
        expected: ExpectedBinding;
        activate: (binding: SeatBinding) => Promise<unknown>;
        scrubPending: () => Promise<unknown>;
    }) => Promise<FinalizeServerSeatOutcome>;
    findProjectRoot: (cwd: string) => string;
    installProjectSessionHook: (projectRoot: string) => void;
    /** gh#27: optional test seam — when set, selectAssimilationAuthority uses
     *  this instead of prompting/failing. Not wired in production. */
    defaultAuthority?: AssimilationAuthority;
    detectLocalServer: () => Promise<string | null>;
    connectServer: (apiUrl: string, enrollment?: {
        invitation: string;
    }) => Promise<{
        token: string;
        trustIdentity: string;
        serverCapabilities?: readonly string[];
    }>;
    resumeServerEnrollment: (apiUrl: string, onPending?: () => void) => Promise<{
        token: string;
        trustIdentity: string;
        serverCapabilities?: readonly string[];
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
        session_operation?: ServerSessionOperation;
        session_expected?: ExpectedBinding;
        revalidate_at_prepare?: boolean;
    }, serverTrustIdentity?: string) => Promise<AssimilateResult>;
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
type AssimilationAuthority = {
    kind: 'server';
    apiUrl: string;
};
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
export {};
//# sourceMappingURL=assimilate-cmd.d.ts.map