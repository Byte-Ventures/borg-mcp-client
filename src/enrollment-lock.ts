import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { withStoreLock } from './seat-store.js';
import { BORG_USER_ROOT, SERVER_CREDENTIALS_FILE } from './credential-paths.js';

const processTails = new Map<string, Promise<void>>();
const heldOrigins = new AsyncLocalStorage<ReadonlySet<string>>();

function enrollmentLockPath(origin: string): string {
  const binding = createHash('sha256').update(origin).digest('hex');
  return `${SERVER_CREDENTIALS_FILE}.enrollment-${binding}.lock`;
}

async function withProcessOriginLock<T>(origin: string, operation: () => Promise<T>): Promise<T> {
  const prior = processTails.get(origin) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.then(() => current);
  processTails.set(origin, tail);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (processTails.get(origin) === tail) processTails.delete(origin);
  }
}

/**
 * Serialize every authoritative enrollment read, commit, and recovery for one
 * server origin. The in-process queue also covers injected test backends; the
 * file lock is the cross-process authority in production.
 */
export async function withEnrollmentOriginLock<T>(
  origin: string,
  operation: () => Promise<T>,
  options: { processShared?: boolean } = {},
): Promise<T> {
  const held = heldOrigins.getStore();
  if (held?.has(origin)) return operation();
  return withProcessOriginLock(origin, async () => {
    const run = () => heldOrigins.run(new Set([...(held ?? []), origin]), operation);
    if (options.processShared === false) return run();
    return withStoreLock(enrollmentLockPath(origin), run, {
        secureRoot: BORG_USER_ROOT,
        rootMode: 'owner-controlled',
      });
  });
}

export function __clearEnrollmentOriginLocksForTest(): void {
  processTails.clear();
}
