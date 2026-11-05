import { join } from 'node:path';
import { fs, openSqlite } from './guarded-fs.js';
import { ensureOpenCodePrivateRoot, openCodePrivateRoot, verifyOpenCodePrivateWindowsPath } from './opencode-private-state.js';
import { isCanonicalPath } from './private-root.js';
import { loadSqlite } from './representative-db.js';
/** Native migrations are protected by an in-process semaphore, not a file lock.
 * All Borg V2 hosts share one database. Serialize their complete bootstrap so
 * migration journals and cold config watchers cannot race across launchers.
 * A data-free SQLite mutex releases automatically on process death, including
 * SIGKILL. It never opens or changes the native OpenCode database.
 * The startup supervisor owns this lock and the native child, so a launcher
 * crash cannot release exclusion before the supervisor reaps that child.
 */
export async function withOpenCodeV2Startup(operation, options = {}) {
    const root = options.root ?? openCodePrivateRoot();
    ensureOpenCodePrivateRoot(root);
    const waitMs = options.waitMs ?? 300_000;
    if (!Number.isFinite(waitMs) || waitMs < 0)
        throw new Error('Invalid OpenCode startup queue timeout.');
    const filename = join(root, 'opencode-v2-startup.sqlite');
    try {
        fs.closeSync(fs.openSync(filename, 'wx', 0o600));
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const stat = fs.lstatSync(filename);
    if (!isCanonicalPath(filename) || !stat.isFile() || stat.isSymbolicLink() ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) {
        throw new Error('OpenCode startup mutex must be a private regular file.');
    }
    verifyOpenCodePrivateWindowsPath(filename);
    const { DatabaseSync } = await loadSqlite();
    const mutex = openSqlite(DatabaseSync, filename);
    const deadline = performance.now() + waitMs;
    let queued = false;
    let acquired = false;
    try {
        // Poll asynchronously: a blocking busy_timeout would prevent an owner in
        // this same Node process from completing its awaited startup and releasing.
        mutex.exec('PRAGMA busy_timeout = 0');
        for (;;) {
            options.signal?.throwIfAborted();
            try {
                mutex.exec('PRAGMA journal_mode = MEMORY');
                mutex.exec('BEGIN EXCLUSIVE');
                acquired = true;
                break;
            }
            catch (error) {
                const code = error.errcode;
                if (typeof code !== 'number' || ![5, 6].includes(code & 255))
                    throw error;
                if (!queued) {
                    queued = true;
                    options.onQueued?.();
                }
                if (performance.now() >= deadline) {
                    throw new Error('Timed out waiting for another Borg OpenCode 2 session to finish startup. No kickoff was submitted.');
                }
                await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - performance.now())));
            }
        }
        return await operation();
    }
    finally {
        try {
            if (acquired)
                mutex.exec('ROLLBACK');
        }
        finally {
            mutex.close();
        }
    }
}
//# sourceMappingURL=opencode-v2-startup.js.map