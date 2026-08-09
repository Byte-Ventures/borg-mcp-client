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
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pruneDeadWakeTargets } from './codex-wake-resolve.js';
import { borgConfigRoot } from './private-root.js';
import { getActiveSeatCredential, getActiveSeatForWorktree, getSeatForWorktree, hasSeatForWorktree, observeSeat, readAllActiveSeats, refreshSeatMetadata, resetSeatForWorktree, seatRef, } from './seats.js';
const CUBES_DIR = borgConfigRoot();
const LAUNCH_FILE = join(CUBES_DIR, 'launch.json');
const CODEX_WAKE_TARGETS_FILE = join(CUBES_DIR, 'codex-wake-targets.json');
const INBOX_DIR = join(CUBES_DIR, 'inboxes');
export const BORG_LAUNCH_EXPECTED_SEAT_ENV = 'BORG_LAUNCH_EXPECTED_SEAT';
export class LaunchSeatIdentityChangedError extends Error {
    code = 'LAUNCH_SEAT_IDENTITY_CHANGED';
    constructor(droneLabel) {
        super(`borg launch: did not launch '${droneLabel}' — its seat registration changed before the launch could start. ` +
            'Run `borg seats` to see the current state, then try again.');
        this.name = 'LaunchSeatIdentityChangedError';
    }
}
export function withLaunchSeatExpectationEnv(env, expectation) {
    // The deterministic ref and public identity are sufficient; never copy the
    // stored bearer into a process environment.
    return {
        ...env,
        [BORG_LAUNCH_EXPECTED_SEAT_ENV]: JSON.stringify(expectation),
    };
}
/** Codex MCP children do not inherit the wrapper environment, so carry the
 * launch-scoped expected seat through the same per-invocation config channel as
 * the Borg-session and state-root markers. */
export function codexLaunchSeatExpectationConfigArgs(env = process.env) {
    const expectation = env[BORG_LAUNCH_EXPECTED_SEAT_ENV];
    if (expectation === undefined)
        return [];
    return [
        '-c',
        `mcp_servers.borg.env.${BORG_LAUNCH_EXPECTED_SEAT_ENV}=${JSON.stringify(expectation)}`,
    ];
}
function readLaunchSeatExpectation(env = process.env) {
    const raw = env[BORG_LAUNCH_EXPECTED_SEAT_ENV];
    if (raw === undefined)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new LaunchSeatIdentityChangedError('<unknown>');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new LaunchSeatIdentityChangedError('<unknown>');
    }
    const value = parsed;
    const droneLabel = typeof value.droneLabel === 'string' ? value.droneLabel : '<unknown>';
    if (typeof value.credentialRef !== 'string' ||
        typeof value.cubeId !== 'string' ||
        typeof value.droneId !== 'string' ||
        typeof value.worktree !== 'string' ||
        typeof value.droneLabel !== 'string') {
        throw new LaunchSeatIdentityChangedError(droneLabel);
    }
    return {
        credentialRef: value.credentialRef,
        cubeId: value.cubeId,
        droneId: value.droneId,
        worktree: value.worktree,
        droneLabel: value.droneLabel,
    };
}
function assertLaunchSeatExpectation(expectation, active, worktree, currentRecord) {
    if (currentRecord === null ||
        seatRef(currentRecord) !== expectation.credentialRef ||
        currentRecord.cubeId !== expectation.cubeId ||
        currentRecord.droneId !== expectation.droneId ||
        resolve(worktree) !== resolve(expectation.worktree) ||
        (active !== undefined && (active === null ||
            active.localSessionCredentialRef !== expectation.credentialRef ||
            active.cubeId !== expectation.cubeId ||
            active.droneId !== expectation.droneId))) {
        throw new LaunchSeatIdentityChangedError(expectation.droneLabel);
    }
}
const UNREADABLE_STATE = Symbol('unreadable-state-file');
function unreadableStateError(filePath) {
    return new Error(`Borg state file is unreadable; refusing to overwrite it: ${filePath}`);
}
/**
 * Walk up from cwd looking for a .git directory. If found, return that
 * directory. If not found by filesystem root, return the original cwd.
 * The returned absolute path is the "project key" used to scope cube state.
 */
let pinnedMcpProjectRoot = null;
let pinnedMcpSeatIdentity = null;
export class McpSeatIdentityChangedError extends Error {
    code = 'SEAT_IDENTITY_CHANGED';
    constructor() {
        super('This worktree\'s saved connection changed after this MCP session pinned its identity. Exit this session and relaunch from the intended worktree.');
        this.name = 'McpSeatIdentityChangedError';
    }
}
export function pinMcpProjectRoot(worktree) {
    const normalized = resolve(worktree);
    if (pinnedMcpProjectRoot !== null && pinnedMcpProjectRoot !== normalized) {
        throw new Error(`Borg MCP session project root is already pinned to ${pinnedMcpProjectRoot}`);
    }
    pinnedMcpProjectRoot = normalized;
}
export function pinMcpSeatIdentity(active) {
    if (!active.worktree)
        throw new McpSeatIdentityChangedError();
    pinMcpProjectRoot(active.worktree);
    const next = {
        worktree: resolve(active.worktree),
        cubeId: active.cubeId,
        droneId: active.droneId,
        ...(active.localSessionCredentialRef
            ? { credentialRef: active.localSessionCredentialRef }
            : {}),
    };
    if (pinnedMcpSeatIdentity && (pinnedMcpSeatIdentity.worktree !== next.worktree ||
        pinnedMcpSeatIdentity.cubeId !== next.cubeId ||
        pinnedMcpSeatIdentity.droneId !== next.droneId ||
        pinnedMcpSeatIdentity.credentialRef !== next.credentialRef)) {
        throw new McpSeatIdentityChangedError();
    }
    pinnedMcpSeatIdentity = next;
}
export function findProjectRoot(cwd = pinnedMcpProjectRoot ?? process.cwd()) {
    let dir = resolve(cwd);
    while (true) {
        if (existsSync(join(dir, '.git')))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            return resolve(cwd); // hit root, fall back to cwd
        dir = parent;
    }
}
/**
 * Per-(cube, drone) inbox file path. Each drone gets its own file so that
 * multiple drones in the same cube don't trample each other's writes when
 * they each receive the same long-poll batch. The file lives under a
 * per-cube subdir keyed by cube ID, then by drone ID (a UUID, globally
 * unique).
 *
 * Validates cubeId/droneId as UUIDs before using them in a filesystem
 * path. The values come from cubes.json (populated from server response),
 * so the input is trusted in normal operation — but a regex guard is
 * cheap defense against a corrupted file or future bug that would
 * otherwise let `../` slip through into the inbox path.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function inboxPathForDrone(cubeId, droneId) {
    if (!UUID_RE.test(cubeId))
        throw new Error(`Invalid cubeId: ${cubeId}`);
    if (!UUID_RE.test(droneId))
        throw new Error(`Invalid droneId: ${droneId}`);
    return join(INBOX_DIR, cubeId, `${droneId}.log`);
}
// gh#894: crash-safe write. A plain truncate-write (open-for-write then write)
// leaves a truncated/empty prefs file if the process dies mid-write — losing
// every stored cube preference. Instead write to a same-directory temp file
// and rename() it over the target: rename is atomic on POSIX, so a reader
// always sees either the old complete file or the new complete file, never a
// partial one. On any failure the original is untouched (we never opened it for
// write) and the temp is best-effort cleaned. `io` is injectable for tests.
let atomicTmpCounter = 0;
export async function atomicWriteFile(filePath, data, opts = {}) {
    const io = opts.io ?? { writeFile, rename, unlink };
    const mode = opts.mode ?? 0o600;
    await mkdir(dirname(filePath), { recursive: true });
    // Same-dir temp so rename() stays on one filesystem (atomicity requirement).
    // pid + counter keeps concurrent same-process writes from colliding.
    const tmp = `${filePath}.${process.pid}.${atomicTmpCounter++}.tmp`;
    try {
        await io.writeFile(tmp, data, { mode });
        await io.rename(tmp, filePath);
    }
    catch (err) {
        try {
            await io.unlink(tmp);
        }
        catch {
            /* best-effort temp cleanup; never mask the original error */
        }
        throw err;
    }
}
function isLaunchFile(data) {
    return (data !== null &&
        typeof data === 'object' &&
        typeof data.projects === 'object' &&
        data.projects !== null &&
        !Array.isArray(data.projects));
}
async function readLaunchFile() {
    let raw;
    try {
        raw = await readFile(LAUNCH_FILE, 'utf8');
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return null;
        throw error;
    }
    try {
        const parsed = JSON.parse(raw);
        return isLaunchFile(parsed) ? parsed : UNREADABLE_STATE;
    }
    catch {
        return UNREADABLE_STATE;
    }
}
async function writeLaunchFile(data) {
    // atomicWriteFile handles the mkdir + 0o600 mode, and the temp+rename keeps
    // a concurrent reader from seeing a half-written launch file (gh#894, gh#901).
    await atomicWriteFile(LAUNCH_FILE, JSON.stringify(data, null, 2) + '\n');
}
function codexWakeTargetKey(cubeId, droneId) {
    if (!UUID_RE.test(cubeId))
        throw new Error(`Invalid cubeId: ${cubeId}`);
    if (!UUID_RE.test(droneId))
        throw new Error(`Invalid droneId: ${droneId}`);
    return `${cubeId}:${droneId}`;
}
function isCodexWakeTargetsFile(data) {
    return (data !== null &&
        typeof data === 'object' &&
        typeof data.targets === 'object' &&
        data.targets !== null &&
        !Array.isArray(data.targets));
}
async function readCodexWakeTargetsFile() {
    let raw;
    try {
        raw = await readFile(CODEX_WAKE_TARGETS_FILE, 'utf8');
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return null;
        throw error;
    }
    try {
        const parsed = JSON.parse(raw);
        return isCodexWakeTargetsFile(parsed) ? parsed : UNREADABLE_STATE;
    }
    catch {
        return UNREADABLE_STATE;
    }
}
async function writeCodexWakeTargetsFile(data) {
    // atomicWriteFile handles the mkdir + 0o600 mode, and the temp+rename keeps
    // a concurrent reader from seeing a half-written file (gh#894, gh#901).
    await atomicWriteFile(CODEX_WAKE_TARGETS_FILE, JSON.stringify(data, null, 2) + '\n');
}
/**
 * Get the currently-active cube for the current project, or null if not
 * assimilated in this project. Entries written by older client versions
 * that lack the `cubeId` field are treated as absent — re-assimilate to
 * refresh.
 */
export async function getActiveCube() {
    return getActiveCubeForWorktree(findProjectRoot());
}
export async function getActiveCubeForWorktree(worktree) {
    const projectRoot = findProjectRoot(worktree);
    const expectation = readLaunchSeatExpectation();
    const record = await getActiveSeatForWorktree(projectRoot);
    // A launch-by-label child must hydrate the exact record selected by its
    // parent. Check on both sides of bearer hydration so a concurrent preferred-
    // seat replacement fails closed instead of launching a different drone.
    if (expectation)
        assertLaunchSeatExpectation(expectation, undefined, projectRoot, record);
    if (!record || !record.cubeId || !record.droneId)
        return null;
    const active = await hydrateActiveCube(record);
    if (expectation) {
        const currentRecord = await getActiveSeatForWorktree(projectRoot);
        assertLaunchSeatExpectation(expectation, active, projectRoot, currentRecord);
    }
    if (active && pinnedMcpSeatIdentity && (resolve(active.worktree ?? '') !== pinnedMcpSeatIdentity.worktree ||
        active.cubeId !== pinnedMcpSeatIdentity.cubeId ||
        active.droneId !== pinnedMcpSeatIdentity.droneId ||
        active.localSessionCredentialRef !== pinnedMcpSeatIdentity.credentialRef)) {
        throw new McpSeatIdentityChangedError();
    }
    return active;
}
/**
 * True iff this worktree has an ACTIVE bound seat in seats.json. In the collapsed
 * single-store model the credential and the worktree binding are one atomic unit,
 * so there is no "binding present but credential lost" partial state to diagnose:
 * an active bound seat always hydrates.
 */
export async function hasPersistedActiveCube() {
    return hasSeatForWorktree(findProjectRoot());
}
/**
 * Compose an ActiveCube from an ACTIVE SeatRecord, hydrating the session bearer via
 * the SOLE raw-bearer reader (getActiveSeatCredential). Returns null if the bearer
 * can no longer be resolved (record concurrently reset/replaced).
 */
async function hydrateActiveCube(record) {
    const ref = seatRef(record);
    const sessionToken = await getActiveSeatCredential(ref, {
        origin: record.origin,
        trustIdentity: record.trustIdentity,
        cubeId: record.cubeId,
    });
    if (!sessionToken)
        return null;
    return {
        cubeId: record.cubeId,
        droneId: record.droneId,
        name: record.name ?? '',
        droneLabel: record.droneLabel ?? '',
        sessionToken,
        apiUrl: record.origin,
        serverTrustIdentity: record.trustIdentity,
        localSessionCredentialRef: ref,
        operation: record.operation,
        worktree: record.worktree,
        ...(record.roleName !== undefined ? { roleName: record.roleName } : {}),
        ...(record.roleClass !== undefined ? { roleClass: record.roleClass } : {}),
        ...(record.isHumanSeat !== undefined ? { isHumanSeat: record.isHumanSeat } : {}),
    };
}
export function __resetPinnedMcpProjectRootForTests() {
    pinnedMcpProjectRoot = null;
    pinnedMcpSeatIdentity = null;
}
/**
 * Token-free lookup used after an offline reset. A surviving seat is only
 * described as saved local state; the caller must still revalidate it with the
 * server before launch.
 */
export async function findRemainingActiveSeatForWorktree(worktree) {
    const record = await getActiveSeatForWorktree(worktree);
    return record ? { apiUrl: record.origin, operation: record.operation } : null;
}
/**
 * Legacy binding-only writer. In the collapsed single-store model an ACTIVE seat is
 * created ONLY by the atomic mint→activate+bind path in seats.ts (driven by the
 * attach FINALIZE); there is no standalone binding write. Retained solely as a
 * fail-closed guard for incomplete session metadata.
 */
export async function setActiveCube(_active) {
    throw new Error('local Borg server session metadata is incomplete');
}
export function activeCubeWithFreshRegenIdentity(active, result) {
    const name = result.cube?.name ?? active.name;
    const droneLabel = result.drone?.label ?? active.droneLabel;
    const roleName = result.role?.name ?? active.roleName;
    const roleClass = result.role?.role_class ?? active.roleClass;
    const isHumanSeat = result.role?.is_human_seat ?? active.isHumanSeat;
    if (name === active.name && droneLabel === active.droneLabel &&
        roleName === active.roleName && roleClass === active.roleClass &&
        isHumanSeat === active.isHumanSeat)
        return active;
    return { ...active, name, droneLabel, roleName, roleClass, isHumanSeat };
}
/**
 * Snapshot this worktree's exact FULL local-seat binding (incl drone id) plus a
 * token-safe TYPED observation (active + digest | absent). Read-only. Returns null
 * when this worktree has no ACTIVE bound seat to reset: an honest no-op.
 */
export async function snapshotLocalSeat() {
    const worktree = findProjectRoot();
    // CR#4: discover an ACTIVE seat OR a bound-PENDING record (a sibling whose
    // activation failed, bound to THIS worktree by the attach bind-pending step).
    // getActiveSeatForWorktree would MISS the bound-pending record (it requires
    // state==='active' + a drone id), so `reset-local-connection` would FALSELY report
    // "nothing to reset" (exit 0) while a resumable, server-digest-bound bearer
    // persists at rest — a FALSE-SUCCESS revocation failure. getSeatForWorktree sees
    // both, and the offline reset's exact re-check + delete cover the bound-pending
    // record too.
    const record = await getSeatForWorktree(worktree);
    if (!record || !record.cubeId)
        return null;
    const ref = seatRef(record);
    const observation = await observeSeat(ref, {
        origin: record.origin,
        trustIdentity: record.trustIdentity,
        cubeId: record.cubeId,
    });
    return {
        apiUrl: record.origin,
        serverTrustIdentity: record.trustIdentity,
        cubeId: record.cubeId,
        ...(record.droneId !== undefined ? { droneId: record.droneId } : {}),
        credentialRef: ref,
        worktree,
        observation,
    };
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
export async function readPersistedLocalSeat() {
    const record = await getSeatForWorktree(findProjectRoot());
    if (!record || !record.cubeId)
        return null;
    return {
        cubeId: record.cubeId,
        ...(record.droneId !== undefined ? { droneId: record.droneId } : {}),
        name: record.name ?? '',
        droneLabel: record.droneLabel ?? '',
        apiUrl: record.origin,
        serverTrustIdentity: record.trustIdentity,
        localSessionCredentialRef: seatRef(record),
        operation: record.operation,
        state: record.state,
        ...(record.roleName !== undefined ? { roleName: record.roleName } : {}),
        ...(record.roleClass !== undefined ? { roleClass: record.roleClass } : {}),
        ...(record.isHumanSeat !== undefined ? { isHumanSeat: record.isHumanSeat } : {}),
    };
}
/**
 * Reset this worktree's seat: delegate to the single-store resetSeatForWorktree,
 * which under ONE flock re-checks the exact FULL binding (ref + drone id, CR #3)
 * plus the token-safe observation and DELETES the whole record — credential AND
 * binding vanish together in one commit. Any drift / missing / same-ref digest
 * replacement is an honest no-op ('changed'); no cross-store 'partial' exists.
 */
export async function resetLocalSeatBinding(expected) {
    const outcome = await resetSeatForWorktree({
        worktree: expected.worktree,
        ref: expected.credentialRef,
        droneId: expected.droneId,
        observation: expected.observation,
    });
    if (outcome.outcome === 'reset')
        return { outcome: 'reset', credentialRef: outcome.ref };
    if (outcome.outcome === 'no-binding')
        return { outcome: 'no-binding' };
    return { outcome: 'changed' };
}
/**
 * Metadata-only refresh (cube name / drone label / role display) of the CURRENT
 * worktree's ACTIVE seat — delegates to seats.ts refreshSeatMetadata, which CANNOT
 * alter the credential, ref, identity, or worktree binding. A no-op when this
 * worktree has no active seat, so a stale regen identity can never resurrect or
 * mutate a seat ref.
 */
export async function refreshActiveCubeMetadata(active) {
    if (!active.localSessionCredentialRef)
        return false;
    return refreshSeatMetadata(findProjectRoot(), {
        credentialRef: active.localSessionCredentialRef,
        cubeId: active.cubeId,
        droneId: active.droneId,
    }, {
        name: active.name,
        droneLabel: active.droneLabel,
        ...(active.roleName !== undefined ? { roleName: active.roleName } : {}),
        ...(active.roleClass !== undefined ? { roleClass: active.roleClass } : {}),
        ...(active.isHumanSeat !== undefined ? { isHumanSeat: active.isHumanSeat } : {}),
    });
}
export async function getProjectCliPreference() {
    const data = await readLaunchFile();
    if (data === UNREADABLE_STATE)
        throw unreadableStateError(LAUNCH_FILE);
    if (!data)
        return null;
    const entry = data.projects[findProjectRoot()];
    return entry?.cli === 'claude' || entry?.cli === 'codex' || entry?.cli === 'opencode' ? entry.cli : null;
}
/**
 * gh#556 Part 2 — like getProjectCliPreference, but keyed on an arbitrary
 * worktree dir (launch-all reads the saved CLI preference for EACH discovered
 * worktree, not just cwd). Returns null if no preference is saved for that path.
 */
export async function getProjectCliPreferenceForPath(dir) {
    const data = await readLaunchFile();
    if (data === UNREADABLE_STATE)
        throw unreadableStateError(LAUNCH_FILE);
    if (!data)
        return null;
    const entry = data.projects[findProjectRoot(dir)];
    return entry?.cli === 'claude' || entry?.cli === 'codex' || entry?.cli === 'opencode' ? entry.cli : null;
}
/**
 * gh#556 Part 2 — returns all persisted project identities from the seat store.
 * Used by `borg launch-all` to enumerate drones across all known worktrees.
 * Returns an empty array when no ACTIVE bound seats exist.
 */
export async function readAllProjectIdentities() {
    const seats = await readAllActiveSeats();
    const hydrated = await Promise.all(seats.map(async ({ worktree, record }) => ({
        projectPath: worktree,
        cube: await hydrateActiveCube(record),
    })));
    return hydrated.flatMap(({ projectPath, cube }) => cube === null ? [] : [{ projectPath, cube }]);
}
/**
 * Save the CLI preference for the current project, or for an explicitly named
 * worktree. The explicit path is used when assimilate has just created a
 * sibling worktree but the process still began in the invoking checkout.
 */
export async function setProjectCliPreference(cli, dir) {
    const existing = await readLaunchFile();
    if (existing === UNREADABLE_STATE)
        throw unreadableStateError(LAUNCH_FILE);
    const next = existing ?? { projects: {} };
    next.projects[findProjectRoot(dir)] = { cli };
    await writeLaunchFile(next);
}
export async function setCodexWakeTarget(cubeId, droneId, target) {
    const existing = await readCodexWakeTargetsFile();
    if (existing === UNREADABLE_STATE)
        throw unreadableStateError(CODEX_WAKE_TARGETS_FILE);
    const next = existing ?? { targets: {} };
    next.targets[codexWakeTargetKey(cubeId, droneId)] = {
        ...target,
        updatedAt: new Date().toISOString(),
    };
    await writeCodexWakeTargetsFile(next);
}
export async function getCodexWakeTarget(cubeId, droneId) {
    const existing = await readCodexWakeTargetsFile();
    if (existing === UNREADABLE_STATE)
        throw unreadableStateError(CODEX_WAKE_TARGETS_FILE);
    if (!existing)
        return null;
    const target = existing.targets[codexWakeTargetKey(cubeId, droneId)];
    if (!target || typeof target.threadId !== 'string' || typeof target.socketPath !== 'string') {
        return null;
    }
    return target;
}
/**
 * gh#855: drop wake-target entries whose app-server socket is positively dead,
 * so the file self-heals (stale dead-socket entries from crashed prior launches
 * don't linger and mislead probeCodexBridgeArmed / health-beat). Pure prune
 * decision lives in codex-wake-resolve.ts (false-deaf-avoidance: keeps alive +
 * indeterminate); this is the thin read → prune → write-only-on-change glue.
 * The liveness check is injected (claude.ts wires checkCodexBridgeHealthy) so
 * cubes.ts stays free of the codex-remote dependency.
 */
export async function pruneDeadCodexWakeTargets(socketLiveness) {
    const existing = await readCodexWakeTargetsFile();
    if (existing === UNREADABLE_STATE)
        throw unreadableStateError(CODEX_WAKE_TARGETS_FILE);
    if (!existing)
        return;
    const { targets, changed } = pruneDeadWakeTargets(existing.targets, socketLiveness);
    if (changed)
        await writeCodexWakeTargetsFile({ ...existing, targets });
}
//# sourceMappingURL=cubes.js.map