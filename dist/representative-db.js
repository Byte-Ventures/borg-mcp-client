/**
 * The representative's durable state: one SQLite database (node:sqlite, WAL)
 * inside a published generation directory.
 *
 *   <borg config>/representative/state/
 *     CURRENT          "<gen>\n", published by one atomic rename
 *     publish.sqlite   data-free mutex (journal_mode=MEMORY), serializes creation and reset
 *     <gen>/state.sqlite (+ -wal, -shm)
 *
 * Every mutation is one synchronous `BEGIN IMMEDIATE` transaction that first
 * re-reads CURRENT, so a reset (a new generation published over CURRENT) is
 * observed inside the transaction that would otherwise write to the old one.
 * No network I/O can run inside a transaction: `transact` takes a synchronous
 * body. No database file is ever renamed or moved.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, readdirSync, readSync, writeSync } from 'node:fs';
import { mkdirSync, openSqlite, openSync, renameSync, rmdirSync, unlinkSync } from './guarded-fs.js';
import { join, relative, sep } from 'node:path';
import { borgConfigRoot, borgHomeRoot } from './private-root.js';
import { assertSecureRoot } from './seat-store.js';
export const REPRESENTATIVE_STATE_SCHEMA = 'borg-representative/1';
export const REPRESENTATIVE_STATE_USER_VERSION = 1;
/** g<17-digit UTC millisecond stamp>-<random>: strictly increasing, so name order is publication order. */
const GEN_RE = /^g\d{17}-[0-9a-f]{16}$/;
const CURRENT_RE = /^(g\d{17}-[0-9a-f]{16})\n$/;
const DB_NAMES = ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm'];
const RETAINED_GENERATIONS = 3;
const BUSY_TIMEOUT_MS = 10_000;
export class RepresentativeStateError extends Error {
    code;
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'RepresentativeStateError';
    }
}
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
/** Proven corruption only; BUSY, I/O, FULL, READONLY and permission errors are not. */
export function isSqliteCorruption(error) {
    const code = error?.errcode;
    return typeof code === 'number' && [SQLITE_CORRUPT, SQLITE_NOTADB].includes(code & 0xff);
}
function corrupt(path, error) {
    return new RepresentativeStateError('REPRESENTATIVE_STATE_CORRUPT', `The representative state database ${path} is corrupt (${error instanceof Error ? error.message : String(error)}). ` +
        'Recovery discards pending and ambiguous send records; run `borg representative reset-state` to recover.', { path, reason: error instanceof Error ? error.message : String(error) });
}
function invalid(path, reason) {
    return new RepresentativeStateError('REPRESENTATIVE_STATE_INVALID', `The representative state path ${path} is not safe to use (${reason}). Nothing was read or written.`, { path, reason });
}
let filterInstalled = false;
/**
 * Hide only SQLite's ExperimentalWarning. Node prints warnings through its own
 * 'warning' listeners; they are replaced by one that forwards every other
 * warning to them unchanged. Must run before node:sqlite is loaded.
 */
export function installSqliteWarningFilter(proc = process) {
    if (filterInstalled)
        return;
    filterInstalled = true;
    const previous = proc.listeners('warning');
    proc.removeAllListeners('warning');
    proc.on('warning', (warning) => {
        if (warning.name === 'ExperimentalWarning' && /\bSQLite\b/i.test(warning.message))
            return;
        for (const listener of previous)
            listener.call(proc, warning);
    });
}
let sqliteModule;
/** The only way node:sqlite is loaded: after the warning filter, by dynamic import (static imports are hoisted). */
export async function loadSqlite() {
    installSqliteWarningFilter();
    sqliteModule ??= import('node:sqlite').catch((error) => {
        sqliteModule = undefined;
        throw new Error(`The representative state needs node:sqlite (Node.js 22.13 or later); this is Node.js ${process.versions.node} ` +
            `(${error instanceof Error ? error.message : String(error)}).`);
    });
    return sqliteModule;
}
/** A value for terminal output: C0/C1 control characters and DEL escaped as \\uXXXX. */
export function printable(value) {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
/**
 * Validate a private directory under the Borg config root and every ancestor
 * with the private-store policy; never repairs unsafe state. False when absent.
 */
export async function validatePrivateDirectory(directory, create) {
    let current = borgHomeRoot();
    for (const component of relative(current, directory).split(sep)) {
        if (!await assertSecureRoot(current, current === borgConfigRoot() || current.startsWith(borgConfigRoot() + sep) ? 'private' : 'owner-controlled', create))
            return false;
        current = join(current, component);
    }
    return assertSecureRoot(current, 'private', create);
}
export function representativeStateRoot() {
    return join(borgConfigRoot(), 'representative', 'state');
}
/** C1 leaf rule: absent, or a regular 0600 file owned by this user (lstat). */
function assertPrivateFile(path) {
    let metadata;
    try {
        metadata = lstatSync(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink())
        throw invalid(path, 'not a regular file');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        throw invalid(path, 'not owned by this user');
    if ((metadata.mode & 0o777) !== 0o600)
        throw invalid(path, `mode ${(metadata.mode & 0o777).toString(8)}, expected 600`);
    return true;
}
function assertGenerationDirectory(root, gen) {
    const directory = join(root, gen);
    let metadata;
    try {
        metadata = lstatSync(directory);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            throw invalid(directory, 'generation directory is missing');
        throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw invalid(directory, 'not a directory');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        throw invalid(directory, 'not owned by this user');
    if ((metadata.mode & 0o777) !== 0o700)
        throw invalid(directory, `mode ${(metadata.mode & 0o777).toString(8)}, expected 700`);
    for (const name of DB_NAMES)
        assertPrivateFile(join(directory, name));
    return directory;
}
/** CURRENT's generation, or null when unpublished. Never follows a link. */
export function readCurrent(root) {
    const path = join(root, 'CURRENT');
    if (!assertPrivateFile(path))
        return null;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const buffer = Buffer.alloc(64);
        const length = readSync(fd, buffer, 0, buffer.length, 0);
        const match = CURRENT_RE.exec(buffer.subarray(0, length).toString('utf8'));
        if (!match)
            throw invalid(path, 'unrecognised content');
        return match[1];
    }
    finally {
        closeSync(fd);
    }
}
function fsyncPath(path, flags = constants.O_RDONLY) {
    const fd = openSync(path, flags | constants.O_NOFOLLOW);
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
function createPrivateFile(path, content) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
        if (content !== undefined)
            writeSync(fd, content);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
/**
 * A name later than every existing generation (runs under the publish mutex):
 * the clock's millisecond stamp, or one past the newest existing stamp when the
 * clock has not moved on (same millisecond, or a clock set back).
 */
function newGenerationName(root, now) {
    const clock = BigInt(now.toISOString().replace(/[-:T.Z]/g, ''));
    const newest = readdirSync(root).filter((name) => GEN_RE.test(name))
        .reduce((max, name) => { const stamp = BigInt(name.slice(1, 18)); return stamp > max ? stamp : max; }, 0n);
    const stamp = clock > newest ? clock : newest + 1n;
    return `g${stamp.toString().padStart(17, '0')}-${randomBytes(8).toString('hex')}`;
}
const SCHEMA = [
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
    `CREATE TABLE bindings (worktree TEXT PRIMARY KEY, generation TEXT NOT NULL UNIQUE, seat TEXT NOT NULL,
     origin TEXT NOT NULL CHECK (origin IN ('prepared', 'legacy')), binding TEXT NOT NULL) STRICT`,
    `CREATE TABLE delivery (
     generation TEXT PRIMARY KEY, seat TEXT NOT NULL,
     start_id TEXT NOT NULL, start_at TEXT NOT NULL, start_kind TEXT NOT NULL,
     checkpoint_id TEXT, checkpoint_at TEXT, read_through_id TEXT, read_through_at TEXT) STRICT`,
    `CREATE TABLE returned (generation TEXT NOT NULL, entry_id TEXT NOT NULL, created_at TEXT NOT NULL,
     PRIMARY KEY (generation, entry_id)) STRICT`,
    `CREATE TABLE requests (generation TEXT NOT NULL, seq INTEGER NOT NULL, request_id TEXT NOT NULL, record TEXT NOT NULL,
     PRIMARY KEY (generation, request_id)) STRICT`,
    `CREATE TABLE wake_state (generation TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT`,
    `CREATE TABLE wake_replies (generation TEXT NOT NULL, entry_id TEXT NOT NULL, created_at TEXT NOT NULL,
     attempts INTEGER NOT NULL, next_at TEXT NOT NULL, PRIMARY KEY (generation, entry_id)) STRICT`,
];
function configure(db, busyTimeoutMs = BUSY_TIMEOUT_MS) {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    const journal = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
    if (journal !== 'wal')
        throw new Error(`SQLite refused WAL mode (journal mode ${journal ?? 'unknown'})`);
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
}
function verifyVersion(db, path) {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    let schema;
    try {
        schema = db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get()?.value;
    }
    catch (error) {
        if (isSqliteCorruption(error))
            throw error;
    }
    if (version !== REPRESENTATIVE_STATE_USER_VERSION || schema !== REPRESENTATIVE_STATE_SCHEMA) {
        throw new RepresentativeStateError('REPRESENTATIVE_STATE_VERSION', `The representative state database ${path} has version ${version}/${schema ?? 'none'}; this borgmcp expects ` +
            `${REPRESENTATIVE_STATE_USER_VERSION}/${REPRESENTATIVE_STATE_SCHEMA}. Nothing was read or written.`, { path, found: `${version}/${schema ?? 'none'}`, expected: `${REPRESENTATIVE_STATE_USER_VERSION}/${REPRESENTATIVE_STATE_SCHEMA}` });
    }
}
export function createRepresentativeState(options = {}) {
    const root = options.root ?? representativeStateRoot();
    const now = options.now ?? (() => new Date());
    const hook = (name) => options.hooks?.[name]?.();
    const busyTimeoutMs = options.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
    const reportKept = options.onKept ?? ((stateRoot, kept) => {
        process.stderr.write(`borg representative: left in place in ${printable(stateRoot)} (not removable as a plain generation): ` +
            `${kept.map(printable).join(', ')}. Nothing else in them was touched; remove them by hand if they are not needed.\n`);
    });
    let handle = null;
    const discard = () => {
        if (!handle)
            return;
        try {
            handle.db.close();
        }
        catch { /* already unusable */ }
        handle = null;
    };
    const openGeneration = async (gen) => {
        const { DatabaseSync } = await loadSqlite();
        hook('beforeOpen');
        const directory = assertGenerationDirectory(root, gen);
        const path = join(directory, 'state.sqlite');
        if (!assertPrivateFile(path))
            throw invalid(path, 'generation has no database');
        let db;
        try {
            db = openSqlite(DatabaseSync, path);
            configure(db, busyTimeoutMs);
            const check = db.prepare('PRAGMA quick_check').all();
            if (check.length !== 1 || check[0].quick_check !== 'ok') {
                throw corrupt(path, new Error(`quick_check: ${check.map((row) => row.quick_check).join('; ')}`));
            }
            verifyVersion(db, path);
            // SQLite created or reused the sidecars: they must still be private.
            for (const name of DB_NAMES)
                assertPrivateFile(join(directory, name));
            return { gen, db };
        }
        catch (error) {
            try {
                db?.close();
            }
            catch { /* ignore */ }
            if (error instanceof RepresentativeStateError)
                throw error;
            if (isSqliteCorruption(error))
                throw corrupt(path, error);
            throw error;
        }
    };
    const ensureTree = async (create) => {
        if (!await validatePrivateDirectory(root, create))
            return false;
        return true;
    };
    /** CURRENT's generation, publishing the first generation when none exists. */
    const currentGeneration = async () => {
        let current = readCurrent(root);
        if (current === null) {
            const fill = options.seed ? await options.seed() : () => { };
            const kept = await withPublishMutex(root, (sqlite, lockedRoot) => readCurrent(lockedRoot) === null ? publishGeneration(sqlite, lockedRoot, fill, now, hook).kept : [], { create: true, ensureTree });
            // Retention never removes anything but exact database files: report what it left.
            if (kept.length > 0)
                reportKept(root, kept);
            current = readCurrent(root);
            if (current === null)
                throw invalid(join(root, 'CURRENT'), 'CURRENT was not published');
        }
        return current;
    };
    const safeCurrent = () => { try {
        return readCurrent(root);
    }
    catch {
        return null;
    } };
    return {
        root,
        async transact(body) {
            if (!await ensureTree(true))
                throw invalid(root, 'state directory could not be created privately');
            for (let attempt = 0; attempt < 2; attempt += 1) {
                let target = null;
                let active;
                try {
                    target = await currentGeneration();
                    if (!handle || handle.gen !== target) {
                        discard();
                        handle = await openGeneration(target);
                    }
                    active = handle;
                    hook('beforeBegin');
                    active.db.exec('BEGIN IMMEDIATE');
                }
                catch (error) {
                    // RESET-2b: the open or BEGIN on the generation we captured failed, or
                    // it vanished. If CURRENT has moved since, re-target once; if it has
                    // not, surface the original error unmasked.
                    discard();
                    const nowCurrent = safeCurrent();
                    if (attempt === 0 && target !== null && nowCurrent !== null && nowCurrent !== target)
                        continue;
                    if (error instanceof RepresentativeStateError)
                        throw error;
                    if (isSqliteCorruption(error))
                        throw corrupt(join(root, target ?? 'CURRENT', 'state.sqlite'), error);
                    throw error;
                }
                hook('afterBegin');
                let finished = false;
                try {
                    // Inside the write transaction: a reset that published a new
                    // generation is seen here, never after a commit to the old one.
                    if (readCurrent(root) !== active.gen) {
                        active.db.exec('ROLLBACK');
                        finished = true;
                        discard();
                        if (attempt === 0)
                            continue;
                        throw new RepresentativeStateError('REPRESENTATIVE_STATE_BUSY', 'The representative state moved to a new generation twice during one operation; retry.');
                    }
                    const result = body(active.db);
                    active.db.exec('COMMIT');
                    finished = true;
                    return result;
                }
                catch (error) {
                    if (!finished) {
                        try {
                            active.db.exec('ROLLBACK');
                        }
                        catch { /* the transaction is already gone */ }
                    }
                    if (isSqliteCorruption(error)) {
                        discard();
                        throw corrupt(join(root, active.gen, 'state.sqlite'), error);
                    }
                    throw error;
                }
            }
            throw new RepresentativeStateError('REPRESENTATIVE_STATE_BUSY', 'The representative state is changing; retry.');
        },
        async readOnly(body) {
            if (!await validatePrivateDirectory(root, false))
                return null;
            const gen = readCurrent(root);
            if (gen === null)
                return null;
            const { DatabaseSync } = await loadSqlite();
            const directory = assertGenerationDirectory(root, gen);
            const path = join(directory, 'state.sqlite');
            if (!assertPrivateFile(path))
                throw invalid(path, 'generation has no database');
            let db;
            try {
                db = openSqlite(DatabaseSync, path, { readOnly: true });
                db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
                verifyVersion(db, path);
                const result = body(db);
                for (const name of DB_NAMES)
                    assertPrivateFile(join(directory, name));
                return result;
            }
            catch (error) {
                if (error instanceof RepresentativeStateError)
                    throw error;
                if (isSqliteCorruption(error))
                    throw corrupt(path, error);
                throw error;
            }
            finally {
                try {
                    db?.close();
                }
                catch { /* ignore */ }
            }
        },
        close: discard,
    };
}
/**
 * Serialize creation and reset on the data-free publish mutex: an empty
 * rollback-journal database held with BEGIN EXCLUSIVE and never written. Its
 * journal lives in memory (journal_mode=MEMORY), so holding the lock creates no
 * sidecar file; OFF is not used because defensive SQLite builds refuse it.
 */
export async function withPublishMutex(root, body, options) {
    const sqlite = await loadSqlite();
    const { DatabaseSync } = sqlite;
    if (!await (options.ensureTree ?? ((create) => validatePrivateDirectory(root, create)))(options.create)) {
        throw invalid(root, 'state directory is missing or unsafe');
    }
    const path = join(root, 'publish.sqlite');
    if (!assertPrivateFile(path)) {
        try {
            createPrivateFile(path);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        assertPrivateFile(path);
    }
    const mutex = openSqlite(DatabaseSync, path);
    try {
        mutex.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
        const journal = mutex.prepare('PRAGMA journal_mode = MEMORY').get()?.journal_mode;
        if (journal !== 'memory')
            throw invalid(path, `publish mutex journal mode is ${journal ?? 'unknown'}, expected memory`);
        mutex.exec('BEGIN EXCLUSIVE');
        try {
            return body(sqlite, root);
        }
        finally {
            mutex.exec('ROLLBACK');
        }
    }
    finally {
        mutex.close();
    }
}
/**
 * Build a complete generation, then publish it with one rename of CURRENT.
 * Nothing is visible until the rename; durability is claimed only after the
 * final directory fsync. Runs inside the publish mutex. Returns the new
 * generation and the generation-named entries retention left in place.
 */
export function publishGeneration(sqlite, root, fill, now = () => new Date(), hook = () => { }) {
    const { DatabaseSync } = sqlite;
    const gen = newGenerationName(root, now());
    const directory = join(root, gen);
    mkdirPrivate(directory);
    hook('publish:dir');
    const path = join(directory, 'state.sqlite');
    createPrivateFile(path);
    const db = openSqlite(DatabaseSync, path);
    try {
        configure(db);
        db.exec('BEGIN IMMEDIATE');
        for (const statement of SCHEMA)
            db.exec(statement);
        db.prepare(`INSERT INTO meta (key, value) VALUES ('schema', ?)`).run(REPRESENTATIVE_STATE_SCHEMA);
        db.exec(`PRAGMA user_version = ${REPRESENTATIVE_STATE_USER_VERSION}`);
        hook('publish:schema');
        fill(db);
        hook('publish:rows');
        db.exec('COMMIT');
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch { /* ignore */ }
        throw error;
    }
    finally {
        db.close();
    }
    fsyncPath(path);
    fsyncPath(directory);
    hook('publish:fsync');
    const tmp = join(root, `CURRENT.${randomBytes(8).toString('hex')}.tmp`);
    createPrivateFile(tmp, `${gen}\n`);
    hook('publish:tmp');
    hook('publish:rename');
    renameSync(tmp, join(root, 'CURRENT'));
    fsyncPath(root);
    hook('publish:done');
    return { generation: gen, kept: cleanupGenerations(root, gen) };
}
function mkdirPrivate(directory) {
    // An explicit mode, then verify: the umask can only remove bits.
    mkdirSync(directory, { mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
        throw invalid(directory, 'generation directory is not private');
    }
}
/**
 * Remove orphan and old non-current generations, keeping the newest
 * RETAINED_GENERATIONS. Never recursive: only the three exact database names
 * are unlinked (after lstat), then rmdir; anything else stays and is reported.
 * Stray CURRENT tmp files (exact pattern, regular) are removed. Runs inside
 * the publish mutex.
 */
export function cleanupGenerations(root, current) {
    const kept = [];
    const names = readdirSync(root);
    for (const name of names) {
        if (/^CURRENT\.[0-9a-f]{16}\.tmp$/.test(name)) {
            const path = join(root, name);
            const metadata = lstatSync(path);
            if (metadata.isFile() && !metadata.isSymbolicLink())
                unlinkSync(path);
        }
    }
    const generations = names.filter((name) => GEN_RE.test(name) && name !== current).sort().reverse();
    for (const name of generations.slice(RETAINED_GENERATIONS)) {
        const directory = join(root, name);
        const metadata = lstatSync(directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            kept.push(name);
            continue;
        }
        for (const file of DB_NAMES) {
            const path = join(directory, file);
            try {
                const leaf = lstatSync(path);
                if (leaf.isFile() && !leaf.isSymbolicLink())
                    unlinkSync(path);
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        }
        try {
            rmdirSync(directory);
        }
        catch {
            kept.push(name);
        }
    }
    return kept;
}
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/**
 * Disaster recovery for a CORRUPT state database (never a healthy one): build a
 * new generation holding the salvageable bindings, each starting at its binding
 * start (replay; duplicates, never loss), and publish it over CURRENT. The old
 * generation is left in place (0700) and retained with the newest others.
 * Lost: every delivery checkpoint, the request ledger (pending and ambiguous
 * send guards) and wake state.
 */
export async function resetRepresentativeState(options) {
    const root = options.root ?? representativeStateRoot();
    const now = options.now ?? (() => new Date());
    if (!await validatePrivateDirectory(root, false)) {
        return { outcome: 'not-initialized', salvaged: [], dropped: [], retainedAside: [] };
    }
    const hook = (name) => options.hooks?.[name]?.();
    return withPublishMutex(root, (sqlite, lockedRoot) => {
        const { DatabaseSync } = sqlite;
        const previous = readCurrent(lockedRoot);
        if (previous === null)
            return { outcome: 'not-initialized', salvaged: [], dropped: [], retainedAside: [] };
        const directory = assertGenerationDirectory(lockedRoot, previous);
        const path = join(directory, 'state.sqlite');
        let exclusive;
        try {
            // Revalidate the target under the mutex; a healthy database is never reset.
            try {
                const db = openSqlite(DatabaseSync, path);
                exclusive = db;
                db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
                const check = db.prepare('PRAGMA quick_check').all();
                if (check.length === 1 && check[0].quick_check === 'ok') {
                    verifyVersion(db, path); // a version mismatch refuses; it is not corruption
                    return { outcome: 'healthy', previous, salvaged: [], dropped: [], retainedAside: [] };
                }
                // Openable but corrupt: hold EXCLUSIVE through publication, so no writer
                // can commit to this generation after CURRENT moves (writers wait, then
                // re-read CURRENT inside their transaction and re-target).
                db.exec('BEGIN EXCLUSIVE');
            }
            catch (error) {
                if (error instanceof RepresentativeStateError)
                    throw error;
                if (!isSqliteCorruption(error))
                    throw error;
                // Not a database at all: nobody can begin a transaction on it.
                try {
                    exclusive?.close();
                }
                catch { /* ignore */ }
                exclusive = undefined;
            }
            const salvaged = [];
            const dropped = [];
            try {
                const reader = openSqlite(DatabaseSync, path, { readOnly: true });
                try {
                    const rows = reader.prepare('SELECT worktree, binding FROM bindings ORDER BY worktree').all();
                    for (const row of rows) {
                        const worktree = typeof row.worktree === 'string' ? row.worktree : null;
                        try {
                            const parsed = worktree && typeof row.binding === 'string'
                                ? options.validateBinding(JSON.parse(row.binding), worktree) : null;
                            if (!parsed) {
                                dropped.push({ worktree, reason: 'binding failed validation' });
                                continue;
                            }
                            const holder = salvaged.find((kept) => options.generationOf(kept) === options.generationOf(parsed));
                            if (holder) {
                                dropped.push({ worktree, reason: `binding generation already kept for ${holder.worktree}` });
                                continue;
                            }
                            salvaged.push({ ...parsed, raw: JSON.stringify(parsed) });
                        }
                        catch {
                            dropped.push({ worktree, reason: 'binding unreadable' });
                        }
                    }
                }
                finally {
                    reader.close();
                }
            }
            catch (error) {
                dropped.push({ worktree: null, reason: `bindings unreadable (${error instanceof Error ? error.message : String(error)})` });
            }
            const { generation: current } = publishGeneration(sqlite, lockedRoot, (db) => {
                const binding = db.prepare(`INSERT INTO bindings (worktree, generation, seat, origin, binding) VALUES (?, ?, ?, 'prepared', ?)`);
                const delivery = db.prepare(`INSERT INTO delivery (generation, seat, start_id, start_at, start_kind, checkpoint_id,
          checkpoint_at, read_through_id, read_through_at) VALUES (?, ?, ?, ?, 'binding', NULL, NULL, NULL, NULL)`);
                for (const entry of salvaged) {
                    const generation = options.generationOf(entry);
                    const seat = options.seatOf(entry);
                    binding.run(entry.worktree, generation, seat, entry.raw);
                    delivery.run(generation, seat, NIL_UUID, entry.boundAt);
                }
            }, now, hook);
            const retainedAside = readdirSync(lockedRoot).filter((name) => GEN_RE.test(name) && name !== current).sort();
            return { outcome: 'reset', previous, current, salvaged: salvaged.map((entry) => entry.worktree), dropped, retainedAside };
        }
        finally {
            if (exclusive) {
                try {
                    exclusive.exec('ROLLBACK');
                }
                catch { /* no transaction */ }
                try {
                    exclusive.close();
                }
                catch { /* ignore */ }
            }
        }
    }, { create: false });
}
//# sourceMappingURL=representative-db.js.map