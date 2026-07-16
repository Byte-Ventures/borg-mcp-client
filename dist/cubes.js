/**
 * Per-project active-cube persistence for Borg MCP client
 *
 * Stores the currently-assimilated cube identity + authority metadata PER
 * PROJECT in ~/.config/borgmcp/cubes.json. The "project"
 * is identified by walking up from cwd to find a .git directory; if none is
 * found, cwd itself is used as the project key.
 *
 * Cloud session tokens retain their legacy plaintext persistence for rollout
 * compatibility. Local-server session tokens never enter this file: only an
 * opaque generation-specific keychain reference is stored and hydrated at
 * read time.
 *
 * apiUrl is captured at assimilate time so subprocess invocations (e.g. the
 * SessionStart hook firing borg-regen) don't need BORG_API_URL in their env
 * to know which worker to talk to.
 */
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pruneDeadWakeTargets } from './codex-wake-resolve.js';
import { clearServerSessionCredential, getServerSessionCredential, } from './config.js';
const CUBES_DIR = join(homedir(), '.config', 'borgmcp');
const CUBES_FILE = join(CUBES_DIR, 'cubes.json');
const LAUNCH_FILE = join(CUBES_DIR, 'launch.json');
const CODEX_WAKE_TARGETS_FILE = join(CUBES_DIR, 'codex-wake-targets.json');
const INBOX_DIR = join(CUBES_DIR, 'inboxes');
const CUBES_WRITE_LOCK = `${CUBES_FILE}.lock`;
const CUBES_LOCK_STALE_MS = 30_000;
async function withCubesWriteLock(operation) {
    await mkdir(dirname(CUBES_WRITE_LOCK), { recursive: true });
    for (let attempt = 0; attempt < 200; attempt += 1) {
        let handle;
        try {
            handle = await open(CUBES_WRITE_LOCK, 'wx', 0o600);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            try {
                const metadata = await stat(CUBES_WRITE_LOCK);
                if (Date.now() - metadata.mtimeMs > CUBES_LOCK_STALE_MS) {
                    await unlink(CUBES_WRITE_LOCK);
                    continue;
                }
            }
            catch (inspectionError) {
                if (inspectionError.code === 'ENOENT')
                    continue;
                throw inspectionError;
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
            continue;
        }
        try {
            return await operation();
        }
        finally {
            await handle.close();
            try {
                await unlink(CUBES_WRITE_LOCK);
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        }
    }
    throw new Error('Borg cube state is busy');
}
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
/**
 * Type guard: true iff the parsed JSON looks like the new schema. Anything
 * else (old single-cube schema, malformed, missing) is treated as "no state".
 */
function isCubesFile(data) {
    return (data !== null &&
        typeof data === 'object' &&
        typeof data.projects === 'object' &&
        data.projects !== null &&
        !Array.isArray(data.projects));
}
/**
 * Read the cubes.json file. Returns null if the file does not exist, is
 * unparseable, or is in the old single-cube schema (per the project's no-
 * backward-compat stance, the old shape is treated as absent — it will be
 * overwritten the next time setActiveCube() runs).
 */
async function readCubesFile() {
    let raw;
    try {
        raw = await readFile(CUBES_FILE, 'utf8');
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return null;
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!isCubesFile(parsed))
        return null;
    return parsed;
}
/**
 * Write the cubes.json file, ensuring the parent directory exists.
 */
async function writeCubesFile(data) {
    await atomicWriteFile(CUBES_FILE, JSON.stringify(data, null, 2) + '\n');
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
    const data = await readCubesFile();
    if (!data)
        return null;
    const key = findProjectRoot();
    const entry = data.projects[key];
    if (!entry || typeof entry.cubeId !== 'string' || !entry.cubeId)
        return null;
    if (typeof entry.droneId !== 'string' || !entry.droneId)
        return null;
    return hydrateActiveCube(entry);
}
/**
 * Distinguish a genuinely new worktree from one whose persisted local seat can
 * no longer be hydrated (for example, because its keychain item is missing).
 * No authority-bearing fields are returned through this diagnostic seam.
 */
export async function hasPersistedActiveCube() {
    const data = await readCubesFile();
    if (!data)
        return false;
    return Object.prototype.hasOwnProperty.call(data.projects, findProjectRoot());
}
async function hydrateActiveCube(entry) {
    if (entry.serverTrustIdentity !== undefined) {
        if (typeof entry.localSessionCredentialRef !== 'string' ||
            !Number.isSafeInteger(entry.localSessionGeneration) ||
            (entry.localSessionGeneration ?? 0) < 1) {
            return null;
        }
        const sessionToken = await getServerSessionCredential(entry.localSessionCredentialRef, {
            origin: entry.apiUrl,
            trustIdentity: entry.serverTrustIdentity,
            cubeId: entry.cubeId,
            droneId: entry.droneId,
            generation: entry.localSessionGeneration,
        });
        if (!sessionToken)
            return null;
        return { ...entry, sessionToken };
    }
    if (typeof entry.sessionToken !== 'string' || !entry.sessionToken)
        return null;
    return entry;
}
let activeCubeWriteQueue = Promise.resolve();
/**
 * Set the active cube for the current project. Preserves entries for all
 * other projects.
 */
export async function setActiveCube(active) {
    const operation = activeCubeWriteQueue.then(() => withCubesWriteLock(async () => {
        const existing = (await readCubesFile()) ?? { projects: {} };
        const projectKey = findProjectRoot();
        const prior = existing.projects[projectKey];
        if (active.serverTrustIdentity !== undefined) {
            if (typeof active.localSessionCredentialRef !== 'string' ||
                !Number.isSafeInteger(active.localSessionGeneration) ||
                (active.localSessionGeneration ?? 0) < 1) {
                throw new Error('local Borg server session metadata is incomplete');
            }
            const nextGeneration = active.localSessionGeneration;
            if (prior?.serverTrustIdentity === active.serverTrustIdentity &&
                prior.apiUrl === active.apiUrl &&
                prior.cubeId === active.cubeId &&
                prior.droneId === active.droneId &&
                typeof prior.localSessionGeneration === 'number' &&
                prior.localSessionGeneration >= nextGeneration) {
                if (prior.localSessionCredentialRef !== active.localSessionCredentialRef) {
                    await clearServerSessionCredential(active.localSessionCredentialRef);
                }
                throw new Error('stale Borg server session generation was discarded');
            }
            const { sessionToken: _discardLocalBearer, ...persisted } = active;
            existing.projects[projectKey] = persisted;
            try {
                await writeCubesFile(existing);
            }
            catch (error) {
                try {
                    await clearServerSessionCredential(active.localSessionCredentialRef);
                }
                catch {
                    // Preserve the metadata-write error; a future attach rotation can
                    // overwrite an orphaned, unreferenced keychain generation.
                }
                throw error;
            }
            if (prior?.localSessionCredentialRef &&
                prior.localSessionCredentialRef !== active.localSessionCredentialRef) {
                await clearServerSessionCredential(prior.localSessionCredentialRef);
            }
            return;
        }
        if (typeof active.sessionToken !== 'string' || !active.sessionToken) {
            throw new Error('Cloud cube session token is missing');
        }
        existing.projects[projectKey] = active;
        await writeCubesFile(existing);
    }));
    activeCubeWriteQueue = operation.catch(() => { });
    await operation;
}
export function activeCubeWithFreshRegenIdentity(active, result) {
    const name = result.cube?.name ?? active.name;
    const droneLabel = result.drone?.label ?? active.droneLabel;
    if (name === active.name && droneLabel === active.droneLabel)
        return active;
    return { ...active, name, droneLabel };
}
/**
 * Clear the active cube for the current project. If the projects map
 * becomes empty as a result, remove the file entirely rather than leave
 * an empty {projects:{}} skeleton.
 */
export async function clearActiveCube() {
    const operation = activeCubeWriteQueue.then(() => withCubesWriteLock(async () => {
        const existing = await readCubesFile();
        if (!existing)
            return;
        const key = findProjectRoot();
        if (!(key in existing.projects))
            return;
        const removedCredentialRef = existing.projects[key].localSessionCredentialRef;
        delete existing.projects[key];
        if (Object.keys(existing.projects).length === 0) {
            try {
                await unlink(CUBES_FILE);
            }
            catch (error) {
                if (error?.code !== 'ENOENT')
                    throw error;
            }
            if (removedCredentialRef)
                await clearServerSessionCredential(removedCredentialRef);
            return;
        }
        await writeCubesFile(existing);
        if (removedCredentialRef)
            await clearServerSessionCredential(removedCredentialRef);
    }));
    activeCubeWriteQueue = operation.catch(() => { });
    await operation;
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
 * gh#556 Part 2 — returns all persisted project identities from cubes.json.
 * Used by `borg launch-all` to enumerate drones across all known worktrees
 * (scheme-agnostic — covers both old sibling paths and new ~/.borg paths).
 * Returns an empty array if the file is absent or malformed.
 */
export async function readAllProjectIdentities() {
    const data = await readCubesFile();
    if (!data)
        return [];
    const persisted = Object.entries(data.projects)
        .filter(([, entry]) => entry !== null &&
        typeof entry === 'object' &&
        typeof entry.cubeId === 'string' &&
        entry.cubeId.length > 0 &&
        typeof entry.droneId === 'string' &&
        entry.droneId.length > 0);
    const hydrated = await Promise.all(persisted.map(async ([projectPath, cube]) => ({
        projectPath,
        cube: await hydrateActiveCube(cube),
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