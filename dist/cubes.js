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
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pruneDeadWakeTargets } from './codex-wake-resolve.js';
import { getActiveSeatCredential, getActiveSeatForWorktree, getSeatForWorktree, hasSeatForWorktree, observeSeat, readAllActiveSeats, refreshSeatMetadata, resetSeatForWorktree, seatRef, } from './seats.js';
const CUBES_DIR = join(homedir(), '.config', 'borgmcp');
const LAUNCH_FILE = join(CUBES_DIR, 'launch.json');
const CODEX_WAKE_TARGETS_FILE = join(CUBES_DIR, 'codex-wake-targets.json');
const INBOX_DIR = join(CUBES_DIR, 'inboxes');
/**
 * Walk up from cwd looking for a .git directory. If found, return that
 * directory. If not found by filesystem root, return the original cwd.
 * The returned absolute path is the "project key" used to scope cube state.
 */
export function findProjectRoot(cwd = process.cwd()) {
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
        return isLaunchFile(parsed) ? parsed : null;
    }
    catch {
        return null;
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
        return isCodexWakeTargetsFile(parsed) ? parsed : null;
    }
    catch {
        return null;
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
    const record = await getActiveSeatForWorktree(findProjectRoot());
    if (!record || !record.cubeId || !record.droneId)
        return null;
    return hydrateActiveCube(record);
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
        ...(record.expiresAt !== undefined ? { localSessionExpiresAt: record.expiresAt } : {}),
        ...(record.roleName !== undefined ? { roleName: record.roleName } : {}),
        ...(record.roleClass !== undefined ? { roleClass: record.roleClass } : {}),
        ...(record.isHumanSeat !== undefined ? { isHumanSeat: record.isHumanSeat } : {}),
    };
}
/**
 * Legacy binding-only writer. In the collapsed single-store model an ACTIVE seat is
 * created ONLY by the atomic mint→activate+bind path in seats.ts (driven by the
 * attach FINALIZE); there is no standalone binding write, and the
 * severed cloud path has no plaintext session to persist. Retained solely as the
 * fail-closed cloud/no-finalize branch seam.
 */
export async function setActiveCube(_active) {
    throw new Error('local Borg server session metadata is incomplete');
}
export function activeCubeWithFreshRegenIdentity(active, result) {
    const name = result.cube?.name ?? active.name;
    const droneLabel = result.drone?.label ?? active.droneLabel;
    if (name === active.name && droneLabel === active.droneLabel)
        return active;
    return { ...active, name, droneLabel };
}
/**
 * Snapshot this worktree's exact FULL local-seat binding (incl drone id) plus a
 * token-safe TYPED observation (active + digest | absent). Read-only. Returns null
 * when this worktree has no ACTIVE bound seat to reset: an honest no-op.
 */
export async function snapshotLocalSeat() {
    const worktree = findProjectRoot();
    const record = await getActiveSeatForWorktree(worktree);
    if (!record || !record.cubeId || !record.droneId)
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
        droneId: record.droneId,
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
        ...(record.expiresAt !== undefined ? { localSessionExpiresAt: record.expiresAt } : {}),
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
    await refreshSeatMetadata(findProjectRoot(), {
        name: active.name,
        droneLabel: active.droneLabel,
        ...(active.roleName !== undefined ? { roleName: active.roleName } : {}),
        ...(active.roleClass !== undefined ? { roleClass: active.roleClass } : {}),
        ...(active.isHumanSeat !== undefined ? { isHumanSeat: active.isHumanSeat } : {}),
    });
}
export async function getProjectCliPreference() {
    const data = await readLaunchFile();
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
export async function setProjectCliPreference(cli) {
    const existing = (await readLaunchFile()) ?? { projects: {} };
    existing.projects[findProjectRoot()] = { cli };
    await writeLaunchFile(existing);
}
export async function setCodexWakeTarget(cubeId, droneId, target) {
    const existing = (await readCodexWakeTargetsFile()) ?? { targets: {} };
    existing.targets[codexWakeTargetKey(cubeId, droneId)] = {
        ...target,
        updatedAt: new Date().toISOString(),
    };
    await writeCodexWakeTargetsFile(existing);
}
export async function getCodexWakeTarget(cubeId, droneId) {
    const existing = await readCodexWakeTargetsFile();
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
    if (!existing)
        return;
    const { targets, changed } = pruneDeadWakeTargets(existing.targets, socketLiveness);
    if (changed)
        await writeCodexWakeTargetsFile({ ...existing, targets });
}
//# sourceMappingURL=cubes.js.map