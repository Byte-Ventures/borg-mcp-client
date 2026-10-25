import { callOpenCodeV2Broker, readOpenCodeV2Descriptor, OPENCODE_V2_DESCRIPTOR_ENV, type OpenCodeV2Descriptor, type OpenCodeV2Seat } from './opencode-v2-broker.js';
import type { OpenCodeConnectionState } from './opencode-drone.js';

let descriptor: OpenCodeV2Descriptor | null = null;
let connected = false;
let ready = false;
let sessionID: string | null = null;
let pending = 0;
let injected = 0;
let lastAt: number | null = null;
let lastEntry: string | null = null;
let failure: string | null = null;

export async function connectOpenCodeV2Runtime(seat: OpenCodeV2Seat, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  connected = false; ready = false; descriptor = null;
  const filename = env[OPENCODE_V2_DESCRIPTOR_ENV];
  if (!filename) return false;
  const candidate = readOpenCodeV2Descriptor(filename);
  const binding = await callOpenCodeV2Broker(candidate, '/bind', { seat });
  if (binding.generation !== 2 || binding.launch !== candidate.launch || typeof binding.sessionID !== 'string') throw new Error('Invalid OpenCode 2 binding');
  descriptor = candidate; sessionID = binding.sessionID; connected = true; failure = null;
  await resolveOpenCodeV2SessionID();
  return true;
}

export async function injectOpenCodeV2Entry(text: string, entryId?: string, allowSubmit = true, sourceEntryId?: string, isSourcePending?: () => Promise<boolean>): Promise<boolean> {
  if (!descriptor || !connected || !entryId) return false;
  try {
    if (isSourcePending && !(await isSourcePending())) {
      settleOpenCodeV2Entry(sourceEntryId ?? entryId); return true;
    }
    const result = await callOpenCodeV2Broker(descriptor, '/wake', { text, key: entryId, allowSubmit, source: sourceEntryId ?? entryId });
    const status = await callOpenCodeV2Broker(descriptor, '/status');
    pending = status.pending; sessionID = status.sessionID;
    ready = status.pluginReady === true && status.tools.length > 0;
    if (result.accepted) { injected++; lastAt = Date.now(); lastEntry = entryId; failure = null; }
    return result.accepted === true;
  } catch { failure = 'OPENCODE_V2_BROKER_UNAVAILABLE'; return false; }
}

export function settleOpenCodeV2Entry(source: string): void {
  if (descriptor) void callOpenCodeV2Broker(descriptor, '/settle', { source }).catch(() => { failure = 'OPENCODE_V2_BROKER_UNAVAILABLE'; });
}
export async function notifyOpenCodeV2LogPersisted(observedSessionID: unknown): Promise<void> {
  if (descriptor && typeof observedSessionID === 'string') await callOpenCodeV2Broker(descriptor, '/logged', { sessionID: observedSessionID }).catch(() => {});
}
export async function resolveOpenCodeV2SessionID(): Promise<string | null> {
  if (!descriptor) return null;
  try {
    const status = await callOpenCodeV2Broker(descriptor, '/status');
    sessionID = status.sessionID; pending = status.pending; failure = null;
    ready = status.pluginReady === true && status.tools.length > 0;
    return sessionID;
  } catch { failure = 'OPENCODE_V2_BROKER_UNAVAILABLE'; return null; }
}
export function getOpenCodeV2ConnectionState(): OpenCodeConnectionState | null {
  if (!descriptor) return null;
  return { connected: connected && ready, sessionId: sessionID, totalEntriesInjected: injected, totalEntriesRetried: 0,
    lastInjectionAt: lastAt, lastInjectionResult: failure ? 'failed' : null,
    lastAcceptedEntryId: lastEntry, lastFailureCode: failure,
    deliveryStates: { queued: 0, retried: 0, failed: failure ? 1 : 0, 'delivered-unconfirmed': pending } };
}
