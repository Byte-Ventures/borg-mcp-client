import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { borgConfigRoot } from './private-root.js';
import type { AgentSessionIdentity } from './agent-session-identity.js';

const STATE_FILE = join(borgConfigRoot(), 'lifecycle-log-state.json');
const UNKNOWN_SESSION: AgentSessionIdentity = { kind: 'unknown', reason: 'identity-not-resolved' };

export type LifecycleSignal = 'arrival' | 'ready';

export interface LifecycleLogSubject {
  cubeId: string;
  droneId: string;
}

interface LifecycleStateEntry {
  arrivedSessionIds?: string[];
  idleReady?: {
    message: string;
    open: boolean;
    at: string;
  };
}

interface LifecycleStateFile {
  entries: Record<string, LifecycleStateEntry>;
}

const UNREADABLE_STATE = Symbol('unreadable-lifecycle-state');
type LifecycleStateRead = LifecycleStateFile | typeof UNREADABLE_STATE;

function unreadableStateError(): Error {
  return new Error(
    `Lifecycle log state is unreadable; refusing to overwrite it: ${STATE_FILE}`,
  );
}

export function lifecycleSignalForMessage(message: string): LifecycleSignal | null {
  if (message.startsWith('ARRIVAL: ')) return 'arrival';
  if (
    message.startsWith('READY: ') &&
    message.includes('capacity clean') &&
    message.includes('awaiting next dispatch')
  ) {
    return 'ready';
  }
  return null;
}

function stateKey(subject: LifecycleLogSubject): string {
  return `${subject.cubeId}:${subject.droneId}`;
}

async function readState(): Promise<LifecycleStateRead> {
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.entries &&
      typeof parsed.entries === 'object' &&
      !Array.isArray(parsed.entries)
    ) {
      return parsed as LifecycleStateFile;
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { entries: {} };
    return UNREADABLE_STATE;
  }
  return UNREADABLE_STATE;
}

async function writeState(state: LifecycleStateFile): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function shouldSuppressLifecycleLogFromState(
  message: string,
  state: LifecycleStateEntry | undefined,
  identity: AgentSessionIdentity = UNKNOWN_SESSION
): { suppress: boolean; signal: LifecycleSignal | null } {
  const signal = lifecycleSignalForMessage(message);
  if (!signal) return { suppress: false, signal: null };

  if (signal === 'arrival') {
    return {
      suppress: identity.kind === 'known' && state?.arrivedSessionIds?.includes(identity.id) === true,
      signal,
    };
  }

  return {
    suppress: state?.idleReady?.open === true && state.idleReady.message === message,
    signal,
  };
}

export async function shouldSuppressLifecycleLog(
  subject: LifecycleLogSubject,
  message: string,
  identity: AgentSessionIdentity = UNKNOWN_SESSION
): Promise<{ suppress: boolean; signal: LifecycleSignal | null }> {
  const state = await readState();
  if (state === UNREADABLE_STATE) throw unreadableStateError();
  return shouldSuppressLifecycleLogFromState(
    message,
    state.entries[stateKey(subject)],
    identity
  );
}

export function nextLifecycleStateAfterLog(
  message: string,
  current: LifecycleStateEntry | undefined,
  nowIso: string = new Date().toISOString(),
  identity: AgentSessionIdentity = UNKNOWN_SESSION
): LifecycleStateEntry {
  const signal = lifecycleSignalForMessage(message);
  if (signal === 'arrival') {
    if (identity.kind === 'unknown' || current?.arrivedSessionIds?.includes(identity.id)) return current ?? {};
    return {
      ...current,
      // Retain one opaque id per announced session so resuming an older session
      // also deduplicates. Pruning needs an explicit history-retention contract.
      arrivedSessionIds: [...(current?.arrivedSessionIds ?? []), identity.id],
    };
  }
  if (signal === 'ready') {
    return {
      ...current,
      idleReady: { message, open: true, at: nowIso },
    };
  }
  if (current?.idleReady?.open) {
    return {
      ...current,
      idleReady: { ...current.idleReady, open: false, at: nowIso },
    };
  }
  return current ?? {};
}

export async function recordLifecycleLog(
  subject: LifecycleLogSubject,
  message: string,
  identity: AgentSessionIdentity = UNKNOWN_SESSION
): Promise<void> {
  const state = await readState();
  if (state === UNREADABLE_STATE) throw unreadableStateError();
  const key = stateKey(subject);
  state.entries[key] = nextLifecycleStateAfterLog(message, state.entries[key], undefined, identity);
  await writeState(state);
}
