import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { withStoreLock } from './seat-store.js';
import { BORG_USER_ROOT, SERVER_CREDENTIALS_FILE } from './credential-paths.js';
const processTails = new Map();
const heldOrigins = new AsyncLocalStorage();
function enrollmentLockPath(origin) {
    const binding = createHash('sha256').update(origin).digest('hex');
    return `${SERVER_CREDENTIALS_FILE}.enrollment-${binding}.lock`;
}
async function withProcessOriginLock(origin, operation) {
    const prior = processTails.get(origin) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = prior.then(() => current);
    processTails.set(origin, tail);
    await prior;
    try {
        return await operation();
    }
    finally {
        release();
        if (processTails.get(origin) === tail)
            processTails.delete(origin);
    }
}
/**
 * Serialize every authoritative enrollment read, commit, and recovery for one
 * server origin. The in-process queue also covers injected test backends; the
 * file lock is the cross-process authority in production.
 */
export async function withEnrollmentOriginLock(origin, operation, options = {}) {
    const held = heldOrigins.getStore();
    if (held?.has(origin))
        return operation();
    return withProcessOriginLock(origin, async () => {
        const run = () => heldOrigins.run(new Set([...(held ?? []), origin]), operation);
        if (options.processShared === false)
            return run();
        return withStoreLock(enrollmentLockPath(origin), run, {
            secureRoot: BORG_USER_ROOT,
            rootMode: 'owner-controlled',
        });
    });
}
export function __clearEnrollmentOriginLocksForTest() {
    processTails.clear();
}
//# sourceMappingURL=enrollment-lock.js.map