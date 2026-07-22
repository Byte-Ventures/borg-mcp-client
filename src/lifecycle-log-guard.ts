import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensurePrivateBorgConfigRoot } from './private-root.js';

const STATE_FILE = join(homedir(), '.config', 'borgmcp', 'lifecycle-log-state.json');
const ARRIVAL_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export type LifecycleSignal = 'arrival' | 'ready';

export interface LifecycleLogSubject {
  cubeId: string;
  droneId: string;
}

interface LifecycleStateEntry {
  lastArrival?: {
    message: string;
    at: string;
  };
  idleReady?: {
    message: string;
    open: boolean;
    at: string;
  };
}

interface LifecycleStateFile {
  entries: Record<string, LifecycleStateEntry>;
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

async function readState(): Promise<LifecycleStateFile> {
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
    if (err?.code !== 'ENOENT') throw err;
  }
  return { entries: {} };
}

async function writeState(state: LifecycleStateFile): Promise<void> {
  const root = await ensurePrivateBorgConfigRoot();
  try {
    await root.verify();
    await mkdir(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await root.verify();
  } finally {
    await root.close();
  }
}

export function shouldSuppressLifecycleLogFromState(
  message: string,
  state: LifecycleStateEntry | undefined,
  nowMs: number = Date.now()
): { suppress: boolean; signal: LifecycleSignal | null } {
  const signal = lifecycleSignalForMessage(message);
  if (!signal) return { suppress: false, signal: null };

  if (signal === 'arrival') {
    const lastArrivalAt = state?.lastArrival?.at
      ? new Date(state.lastArrival.at).getTime()
      : NaN;
    const isRecent =
      Number.isFinite(lastArrivalAt) &&
      nowMs - lastArrivalAt < ARRIVAL_DUPLICATE_WINDOW_MS;
    return {
      suppress: state?.lastArrival?.message === message && isRecent,
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
  message: string
): Promise<{ suppress: boolean; signal: LifecycleSignal | null }> {
  const state = await readState();
  return shouldSuppressLifecycleLogFromState(
    message,
    state.entries[stateKey(subject)]
  );
}

export function nextLifecycleStateAfterLog(
  message: string,
  current: LifecycleStateEntry | undefined,
  nowIso: string = new Date().toISOString()
): LifecycleStateEntry {
  const signal = lifecycleSignalForMessage(message);
  if (signal === 'arrival') {
    return {
      ...current,
      lastArrival: { message, at: nowIso },
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
  message: string
): Promise<void> {
  const state = await readState();
  const key = stateKey(subject);
  state.entries[key] = nextLifecycleStateAfterLog(message, state.entries[key]);
  await writeState(state);
}
