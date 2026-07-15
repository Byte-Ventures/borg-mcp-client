import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWriteFile, findProjectRoot } from './cubes.js';

const ATTACH_RETRIES_FILE = join(
  homedir(),
  '.config',
  'borgmcp',
  'local-attach-retries.json',
);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_LOCK_STALE_MS = 30_000;
const RETRY_LOCK_WAIT_MS = 10;
const RETRY_LOCK_ATTEMPTS = 200;

export interface LocalAttachBinding {
  origin: string;
  trustIdentity: string;
  cubeId: string;
  roleId: string;
}

interface LocalAttachRetryRecord extends LocalAttachBinding {
  retryKey: string;
}

interface LocalAttachRetriesFile {
  version: 1;
  retries: Record<string, LocalAttachRetryRecord>;
}

function validateBinding(binding: LocalAttachBinding): void {
  let parsed: URL;
  try {
    parsed = new URL(binding.origin);
  } catch {
    throw new Error('invalid Borg server attach origin');
  }
  if (parsed.origin !== binding.origin || parsed.protocol !== 'https:') {
    throw new Error('Borg server attach requires a canonical HTTPS origin');
  }
  if (
    binding.trustIdentity.length < 1 ||
    binding.trustIdentity.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(binding.trustIdentity) ||
    !UUID_RE.test(binding.cubeId) ||
    !UUID_RE.test(binding.roleId)
  ) {
    throw new Error('invalid Borg server attach binding');
  }
}

function bindingKey(projectRoot: string, binding: LocalAttachBinding): string {
  validateBinding(binding);
  return createHash('sha256')
    .update(projectRoot)
    .update('\0')
    .update(binding.origin)
    .update('\0')
    .update(binding.trustIdentity)
    .update('\0')
    .update(binding.cubeId)
    .update('\0')
    .update(binding.roleId)
    .digest('hex');
}

async function readRetries(): Promise<LocalAttachRetriesFile> {
  let raw: string;
  try {
    raw = await readFile(ATTACH_RETRIES_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, retries: {} };
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LocalAttachRetriesFile>;
    if (
      parsed.version !== 1 ||
      typeof parsed.retries !== 'object' ||
      parsed.retries === null ||
      Array.isArray(parsed.retries)
    ) {
      throw new Error('invalid');
    }
    return parsed as LocalAttachRetriesFile;
  } catch {
    throw new Error('Borg server attach retry state is corrupt');
  }
}

async function withRetryStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockPath = `${ATTACH_RETRIES_FILE}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < RETRY_LOCK_ATTEMPTS; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > RETRY_LOCK_STALE_MS) {
          await unlink(lockPath);
          continue;
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw inspectionError;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, RETRY_LOCK_WAIT_MS));
      continue;
    }

    try {
      return await operation();
    } finally {
      await handle.close();
      try {
        await unlink(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  throw new Error('Borg server attach retry state is busy');
}

/**
 * Load or create the non-authoritative attach correlator before any request is
 * sent. A lost response therefore reuses the exact same server binding.
 */
export async function getOrCreateLocalAttachRetryKey(
  binding: LocalAttachBinding,
  projectRoot = findProjectRoot(),
): Promise<string> {
  const key = bindingKey(projectRoot, binding);
  return withRetryStateLock(async () => {
    const state = await readRetries();
    const existing = state.retries[key];
    if (existing) {
      if (
        existing.origin !== binding.origin ||
        existing.trustIdentity !== binding.trustIdentity ||
        existing.cubeId !== binding.cubeId ||
        existing.roleId !== binding.roleId ||
        !UUID_RE.test(existing.retryKey)
      ) {
        throw new Error('Borg server attach retry state does not match its binding');
      }
      return existing.retryKey;
    }

    const retryKey = randomUUID();
    state.retries[key] = { ...binding, retryKey };
    await atomicWriteFile(ATTACH_RETRIES_FILE, JSON.stringify(state, null, 2) + '\n');
    return retryKey;
  });
}
