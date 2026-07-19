import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CURSOR_FILE = join(homedir(), '.config', 'borgmcp', 'local-server-cursors.json');
const CURSOR_LOCK = `${CURSOR_FILE}.lock`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LocalServerCursor {
  id: string;
  created_at: string;
}

export interface LocalServerCursorBinding {
  origin: string;
  trustIdentity: string;
  cubeId: string;
  droneId: string;
  /**
   * client#41: cursor-purpose namespace. Absent (the default) is the UNREAD
   * WATERMARK — the point `read-log unread_only` reads from and advances only
   * on an explicit successful drain. `'stream'` is the SSE DELIVERY/RESUME
   * cursor the live tail advances as it delivers events. Keeping these under
   * separate keys stops SSE delivery from consuming the unread watermark (a
   * wake-triggering entry would otherwise disappear from `unread_only` before
   * the agent drained it — a silent missed wake).
   */
  purpose?: 'stream';
}

interface CursorFile {
  version: 1;
  cursors: Record<string, LocalServerCursor>;
}

function cursorKey(binding: LocalServerCursorBinding): string {
  if (
    new URL(binding.origin).origin !== binding.origin ||
    !UUID_RE.test(binding.cubeId) ||
    !UUID_RE.test(binding.droneId)
  ) {
    throw new Error('invalid local Borg server cursor binding');
  }
  const hash = createHash('sha256')
    .update(binding.origin)
    .update('\0')
    .update(binding.trustIdentity)
    .update('\0')
    .update(binding.cubeId)
    .update('\0')
    .update(binding.droneId);
  // The purpose component is appended ONLY when present, so the unread-watermark
  // key (purpose absent) stays byte-identical to the pre-client#41 key — already
  // persisted watermarks are not orphaned by the upgrade. The 'stream' delivery
  // cursor gets a distinct key.
  if (binding.purpose) {
    hash.update('\0').update(binding.purpose);
  }
  return hash.digest('hex');
}

function validCursor(value: unknown): value is LocalServerCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  return UUID_RE.test(String(cursor.id ?? '')) &&
    typeof cursor.created_at === 'string' &&
    Number.isFinite(Date.parse(cursor.created_at)) &&
    new Date(cursor.created_at).toISOString() === cursor.created_at;
}

async function readState(): Promise<CursorFile> {
  try {
    const parsed = JSON.parse(await readFile(CURSOR_FILE, 'utf8')) as Partial<CursorFile>;
    if (
      parsed.version !== 1 ||
      typeof parsed.cursors !== 'object' ||
      parsed.cursors === null ||
      Array.isArray(parsed.cursors) ||
      Object.values(parsed.cursors).some((cursor) => !validCursor(cursor))
    ) {
      throw new Error('invalid');
    }
    return parsed as CursorFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, cursors: {} };
    }
    throw new Error('local Borg server cursor state is corrupt');
  }
}

async function writeState(state: CursorFile): Promise<void> {
  await mkdir(dirname(CURSOR_FILE), { recursive: true });
  const temporary = `${CURSOR_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, CURSOR_FILE);
}

async function withLock<T>(operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(CURSOR_LOCK), { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let handle;
    try {
      handle = await open(CURSOR_LOCK, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const metadata = await stat(CURSOR_LOCK);
        if (Date.now() - metadata.mtimeMs > 30_000) {
          await unlink(CURSOR_LOCK);
          continue;
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw inspectionError;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      continue;
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      try {
        await unlink(CURSOR_LOCK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  throw new Error('local Borg server cursor state is busy');
}

export async function getLocalServerCursor(
  binding: LocalServerCursorBinding,
): Promise<LocalServerCursor | null> {
  const key = cursorKey(binding);
  const state = await readState();
  return state.cursors[key] ?? null;
}

export async function advanceLocalServerCursor(
  binding: LocalServerCursorBinding,
  cursor: LocalServerCursor,
): Promise<void> {
  if (!validCursor(cursor)) throw new Error('invalid local Borg server cursor');
  const key = cursorKey(binding);
  await withLock(async () => {
    const state = await readState();
    const prior = state.cursors[key];
    if (
      prior &&
      (prior.created_at > cursor.created_at ||
        (prior.created_at === cursor.created_at && prior.id >= cursor.id))
    ) {
      return;
    }
    state.cursors[key] = cursor;
    await writeState(state);
  });
}

/**
 * client#42: reset (delete) a persisted cursor for `binding`. Used by the SSE
 * recovery path when the server returns 410 CURSOR_EXPIRED for the stream's
 * resume cursor — the pointed-at entry has been pruned server-side, so the
 * stale cursor can never be resumed and must be cleared, letting the next
 * stream connect re-establish from a fresh valid point (the current tail)
 * instead of looping forever on the dead cursor. No-op when no cursor is
 * stored for the binding.
 */
export async function clearLocalServerCursor(
  binding: LocalServerCursorBinding,
): Promise<void> {
  const key = cursorKey(binding);
  await withLock(async () => {
    const state = await readState();
    if (!(key in state.cursors)) return;
    delete state.cursors[key];
    await writeState(state);
  });
}

export function encodeLocalServerCursor(cursor: LocalServerCursor): string {
  if (!validCursor(cursor)) throw new Error('invalid local Borg server cursor');
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}
