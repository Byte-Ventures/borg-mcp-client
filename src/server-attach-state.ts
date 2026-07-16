import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, findProjectRoot } from './cubes.js';
import { withServerKeychainLock } from './config.js';

const ATTACH_RETRIES_FILE = join(
  homedir(),
  '.config',
  'borgmcp',
  'local-attach-retries.json',
);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACH_RETRY_LOCK_ACCOUNT = 'borg-server-local-attach-retries';

export interface LocalAttachBinding {
  origin: string;
  trustIdentity: string;
  cubeId: string;
  roleId: string;
}

/**
 * Stable local identity for one attach operation. The project root is captured
 * before a sibling worktree is created, so completion never depends on the
 * process's later cwd. Sibling operations deliberately live in a different
 * namespace from the durable in-place seat.
 */
export interface LocalAttachOperation {
  projectRoot: string;
  kind: 'seat' | 'sibling';
  operationKey: string;
}

/** Opaque proof returned by preparation and consumed by exact completion. */
export interface LocalAttachCompletion {
  binding: LocalAttachBinding;
  operation: LocalAttachOperation;
  retryKey: string;
}

interface LocalAttachRetryRecord extends LocalAttachBinding {
  retryKey: string;
  pending?: {
    priorDroneId?: string;
    remintInvalidPrior: boolean;
  };
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

function validateOperation(operation: LocalAttachOperation): void {
  if (
    operation.projectRoot.length < 1 ||
    operation.projectRoot.length > 4096 ||
    operation.operationKey.length < 1 ||
    operation.operationKey.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(operation.projectRoot) ||
    /[\u0000-\u001f\u007f]/.test(operation.operationKey) ||
    (operation.kind !== 'seat' && operation.kind !== 'sibling')
  ) {
    throw new Error('invalid Borg server attach operation');
  }
}

function operationBindingKey(
  operation: LocalAttachOperation,
  binding: LocalAttachBinding,
): string {
  validateBinding(binding);
  validateOperation(operation);
  return createHash('sha256')
    .update(operation.projectRoot)
    .update('\0')
    .update(operation.kind)
    .update('\0')
    .update(operation.operationKey)
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

function bindingKey(projectRoot: string, binding: LocalAttachBinding): string {
  return operationBindingKey({
    projectRoot,
    kind: 'seat',
    operationKey: 'legacy-seat',
  }, binding);
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
  return withServerKeychainLock(ATTACH_RETRY_LOCK_ACCOUNT, operation);
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

/**
 * Replace an evicted seat's retry correlator exactly once. Concurrent callers
 * that all observed the same evicted seat converge on the first replacement
 * instead of minting one correlator (and therefore one seat) each.
 */
export async function replaceEvictedLocalAttachRetryKey(
  binding: LocalAttachBinding,
  expectedRetryKey: string,
  projectRoot = findProjectRoot(),
): Promise<string> {
  if (!UUID_RE.test(expectedRetryKey)) {
    throw new Error('Borg server attach retry state is invalid');
  }
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
      if (existing.retryKey !== expectedRetryKey) return existing.retryKey;
    }

    const retryKey = randomUUID();
    state.retries[key] = { ...binding, retryKey };
    await atomicWriteFile(ATTACH_RETRIES_FILE, JSON.stringify(state, null, 2) + '\n');
    return retryKey;
  });
}

export interface PendingLocalAttach {
  priorDroneId?: string;
  remintInvalidPrior: boolean;
}

function validateRetryRecord(
  record: LocalAttachRetryRecord,
  binding: LocalAttachBinding,
): void {
  if (
    record.origin !== binding.origin ||
    record.trustIdentity !== binding.trustIdentity ||
    record.cubeId !== binding.cubeId ||
    record.roleId !== binding.roleId ||
    !UUID_RE.test(record.retryKey) ||
    (record.pending !== undefined &&
      (typeof record.pending.remintInvalidPrior !== 'boolean' ||
        (record.pending.priorDroneId !== undefined &&
          !UUID_RE.test(record.pending.priorDroneId))))
  ) {
    throw new Error('Borg server attach retry state does not match its binding');
  }
}

/** Persist the exact attach tuple as pending before any attach request. */
export async function prepareLocalAttachRetry(
  binding: LocalAttachBinding,
  pending: PendingLocalAttach,
  operation: LocalAttachOperation,
): Promise<string> {
  if (pending.priorDroneId !== undefined && !UUID_RE.test(pending.priorDroneId)) {
    throw new Error('Borg server saved seat identity is invalid');
  }
  const key = operationBindingKey(operation, binding);
  return withRetryStateLock(async () => {
    const state = await readRetries();
    const existing = state.retries[key];
    if (existing) {
      validateRetryRecord(existing, binding);
      if (existing.pending) {
        if (
          existing.pending.priorDroneId !== pending.priorDroneId ||
          existing.pending.remintInvalidPrior !== pending.remintInvalidPrior
        ) {
          throw new Error('pending Borg server attach does not match this request');
        }
        return existing.retryKey;
      }
    }

    // A completed in-place seat retains its correlator for later reattach.
    // A deliberate sibling is a new seat operation: only an unfinished exact
    // sibling retry may reuse its correlator; a later sibling starts fresh.
    const retryKey = pending.remintInvalidPrior || !existing || operation.kind === 'sibling'
      ? randomUUID()
      : existing.retryKey;
    state.retries[key] = { ...binding, retryKey, pending: { ...pending } };
    await atomicWriteFile(ATTACH_RETRIES_FILE, JSON.stringify(state, null, 2) + '\n');
    return retryKey;
  });
}

/** Return an exact unfinished attach, if one exists for this request binding. */
export async function getPendingLocalAttach(
  binding: LocalAttachBinding,
  operation: LocalAttachOperation,
): Promise<PendingLocalAttach | null> {
  const key = operationBindingKey(operation, binding);
  return withRetryStateLock(async () => {
    const state = await readRetries();
    const existing = state.retries[key];
    if (!existing) return null;
    validateRetryRecord(existing, binding);
    return existing.pending ? { ...existing.pending } : null;
  });
}

/** Mark a pending attach complete only after cubes.json accepted its session. */
export async function completeLocalAttachRetry(
  completion: LocalAttachCompletion,
): Promise<void> {
  if (!UUID_RE.test(completion.retryKey)) {
    throw new Error('Borg server attach retry state is invalid');
  }
  const { binding, operation } = completion;
  const key = operationBindingKey(operation, binding);
  await withRetryStateLock(async () => {
    const state = await readRetries();
    const existing = state.retries[key];
    if (!existing) throw new Error('pending Borg server attach state is missing');
    validateRetryRecord(existing, binding);
    if (existing.retryKey !== completion.retryKey) {
      throw new Error('pending Borg server attach retry identity changed');
    }
    if (!existing.pending) {
      if (operation.kind === 'seat') return;
      throw new Error('pending Borg server sibling attach state is missing');
    }
    if (operation.kind === 'sibling') delete state.retries[key];
    else delete existing.pending;
    await atomicWriteFile(ATTACH_RETRIES_FILE, JSON.stringify(state, null, 2) + '\n');
  });
}
