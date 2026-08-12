import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { createServer } from 'node:net';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  OPENCODE_INJECTED_ENTRY_METADATA_KEY,
  OPENCODE_WAKE_IDENTITY_METADATA_KEY,
} from './opencode-plugin.js';

const LOG_FILE = join(tmpdir(), 'borg-opencode-drone.log');
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
}

interface OpenCodeDroneState {
  serverUrl: string;
  sessionId: string | null;
  sessionCreatedAt: number | null;
  knownRootSessionIds: string[];
  directory: string;
  droneLabel: string;
  cubeName: string;
  connected: boolean;
  totalEntriesInjected: number;
  totalEntriesRetried: number;
  deliveryQueue: OpenCodeDelivery[];
  activeDeliveries: Map<string, OpenCodeDelivery>;
  deliveredEntries: Map<string, OpenCodeDeliveryRecord>;
  unconfirmedEntries: Map<string, OpenCodeDeliveryRecord>;
  failedEntries: Map<string, OpenCodeDeliveryRecord>;
  pendingSubmissions: Map<string, string>;
  reconcilingEntryIds: Set<string>;
  processingDeliveries: boolean;
}

let state: OpenCodeDroneState | null = null;

interface ConnectDeps {
  serverUrl: string;
  directory: string;
  droneLabel: string;
  cubeName: string;
}

interface OCSession {
  id: string;
  directory: string;
  time: { created: number };
  parentID?: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
}

interface OCMessage {
  info?: {
    id?: string;
    role?: string;
    time?: { created?: number };
  };
  parts?: Array<{
    type?: string;
    text?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export type OpenCodeDeliveryState =
  | 'queued'
  | 'delivered-unconfirmed'
  | 'retried'
  | 'failed';

interface OpenCodeDelivery {
  entryId: string;
  sourceEntryId: string;
  text: string;
  allowSubmit: boolean;
  acceptedSubmission: boolean;
  sessionId: string | null;
  settled: boolean;
  state: Exclude<OpenCodeDeliveryState, 'failed'>;
  resolve: (delivered: boolean) => void;
  promise: Promise<boolean>;
}

interface OpenCodeDeliveryRecord {
  text: string;
  sourceEntryId: string;
}

type OpenCodeDeliveryOutcome = 'delivered' | 'delivered-unconfirmed' | 'failed';

const OPEN_CODE_DELIVERY_RETRY_DELAYS_MS = [0, 250, 1_000, 3_000] as const;
const OPEN_CODE_RECONCILIATION_DELAY_MS = 3_000;
// Keep one accepted-but-unconfirmed prompt from holding timers forever. It
// remains pending (never failed or resubmitted), and any later wake retry
// re-arms another confirmation-only window.
const OPEN_CODE_RECONCILIATION_ATTEMPTS = 20;
const OPEN_CODE_DELIVERY_HISTORY_LIMIT = 256;

interface SessionBinding {
  version: 3;
  sessionId: string;
  sessionCreatedAt: number;
  knownRootSessionIds: string[];
  serverUrl: string;
  directory: string;
  droneLabel: string;
  cubeName: string;
  pendingSubmissions: Array<{ entryId: string; sourceEntryId: string }>;
}

export interface OpenCodeLaunchKickoff {
  prompt: string;
  nonce: string;
}

// This is correlation metadata, intentionally not an instruction to the
// launched agent. A markdown comment keeps it benign in the user-visible
// kickoff while preserving it in OpenCode's stored message text.
const OPEN_CODE_LAUNCH_NONCE_MARKER = 'borg-opencode-correlation:';

/**
 * Add a launch-unique identity to the OpenCode-only copy of the shared
 * kickoff. The prompt is what OpenCode records as its first user message, so
 * the launcher can later bind the MCP child to this precise launch instead of
 * guessing from a repeated kickoff's text or timestamp.
 */
export function createOpenCodeLaunchKickoff(
  kickoff: string,
  nonce: string = randomUUID(),
): OpenCodeLaunchKickoff {
  return {
    prompt: `${kickoff}\n\n<!-- ${OPEN_CODE_LAUNCH_NONCE_MARKER}${nonce} -->`,
    nonce,
  };
}

const bindingPathsForTests = new Set<string>();

function abandonOpenCodeDeliveries(current: OpenCodeDroneState | null): void {
  if (!current) return;
  current.connected = false;
  for (const delivery of current.activeDeliveries.values()) {
    delivery.resolve(false);
  }
  current.activeDeliveries.clear();
  current.deliveryQueue.length = 0;
}

export async function connectOpenCodeDrone(deps: ConnectDeps): Promise<void> {
  abandonOpenCodeDeliveries(state);
  state = {
    serverUrl: deps.serverUrl,
    sessionId: null,
    sessionCreatedAt: null,
    knownRootSessionIds: [],
    directory: deps.directory,
    droneLabel: deps.droneLabel,
    cubeName: deps.cubeName,
    connected: true,
    totalEntriesInjected: 0,
    totalEntriesRetried: 0,
    deliveryQueue: [],
    activeDeliveries: new Map(),
    deliveredEntries: new Map(),
    unconfirmedEntries: new Map(),
    failedEntries: new Map(),
    pendingSubmissions: new Map(),
    reconcilingEntryIds: new Set(),
    processingDeliveries: false,
  };
  log(`connected url=${deps.serverUrl} dir=${deps.directory}`);
}

// ---------------------------------------------------------------------------
// Raw fetch wrappers
// ---------------------------------------------------------------------------

function apiUrl(path: string): string {
  const base = state!.serverUrl.replace(/\/+$/, '');
  return `${base}${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(state!.directory)}`;
}

const FETCH_TIMEOUT = 10_000;

async function rawGet(path: string): Promise<{ status: number; body: string }> {
  const url = apiUrl(path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function rawPost(path: string, bodyObj: unknown): Promise<{ status: number; body: string }> {
  const url = apiUrl(path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(bodyObj),
    });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function listSessions(): Promise<OCSession[]> {
  const { status, body } = await rawGet('/session');
  if (status !== 200) throw new Error(`OpenCode sessions request failed (${status})`);
  return JSON.parse(body);
}

async function getSession(id: string): Promise<OCSession | null> {
  const { status, body } = await rawGet(`/session/${id}`);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`OpenCode session request failed (${status})`);
  return JSON.parse(body);
}

async function listSessionMessages(id: string): Promise<OCMessage[]> {
  const { status, body } = await rawGet(`/session/${id}/message`);
  if (status !== 200) throw new Error(`OpenCode session messages request failed (${status})`);
  return JSON.parse(body);
}

async function findInjectedMessage(
  sessionId: string,
  expectedWakeIdentity: string,
): Promise<string | null> {
  const messages = await listSessionMessages(sessionId);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.info?.role !== 'user' || typeof message.info.id !== 'string') continue;
    const part = message.parts?.[0];
    if (
      part?.type === 'text' &&
      part.metadata?.[OPENCODE_INJECTED_ENTRY_METADATA_KEY] === true &&
      part.metadata?.[OPENCODE_WAKE_IDENTITY_METADATA_KEY] === expectedWakeIdentity
    ) {
      return message.info.id;
    }
  }
  return null;
}

async function promptSession(id: string, bodyObj: Record<string, unknown>): Promise<number> {
  const { status } = await rawPost(`/session/${id}/prompt_async`, bodyObj);
  return status;
}

// ---------------------------------------------------------------------------
// Persist the launch-selected session for the separately spawned MCP child.
// ---------------------------------------------------------------------------

function bindingPath(): string {
  const current = state!;
  const key = [current.serverUrl, current.directory, current.cubeName, current.droneLabel].join('\0');
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24);
  const path = join(tmpdir(), `borg-opencode-session-${digest}.json`);
  bindingPathsForTests.add(path);
  return path;
}

function bindingMatchesState(binding: SessionBinding): boolean {
  const current = state!;
  return binding.version === 3
    && binding.serverUrl === current.serverUrl
    && binding.directory === current.directory
    && binding.droneLabel === current.droneLabel
    && binding.cubeName === current.cubeName
    && typeof binding.sessionId === 'string'
    && typeof binding.sessionCreatedAt === 'number'
    && Array.isArray(binding.knownRootSessionIds)
    && binding.knownRootSessionIds.every((id) => typeof id === 'string')
    && Array.isArray(binding.pendingSubmissions)
    && binding.pendingSubmissions.every((pending) =>
      typeof pending?.entryId === 'string' && typeof pending?.sourceEntryId === 'string'
    );
}

function readBinding(): SessionBinding | null {
  try {
    const path = bindingPath();
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SessionBinding;
    return bindingMatchesState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clearBinding(): void {
  if (!state) return;
  const path = bindingPath();
  state.sessionId = null;
  state.sessionCreatedAt = null;
  state.knownRootSessionIds = [];
  state.pendingSubmissions.clear();
  try {
    unlinkSync(path);
  } catch {
    // The file may have already been removed by the launch process.
  }
}

function writeBinding(binding: SessionBinding): boolean {
  const current = state!;
  current.sessionId = binding.sessionId;
  current.sessionCreatedAt = binding.sessionCreatedAt;
  current.knownRootSessionIds = binding.knownRootSessionIds;

  try {
    const path = bindingPath();
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(binding), { mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch (err) {
    log(`session binding write failed: ${err}`);
    return false;
  }
}

function saveBinding(session: OCSession, knownRootSessionIds: string[]): void {
  const current = state!;
  if (current.sessionId !== null && current.sessionId !== session.id) {
    current.pendingSubmissions.clear();
  }
  const binding: SessionBinding = {
    version: 3,
    sessionId: session.id,
    sessionCreatedAt: session.time.created,
    knownRootSessionIds,
    serverUrl: current.serverUrl,
    directory: current.directory,
    droneLabel: current.droneLabel,
    cubeName: current.cubeName,
    pendingSubmissions: [...current.pendingSubmissions].map(([entryId, sourceEntryId]) => ({
      entryId,
      sourceEntryId,
    })),
  };
  writeBinding(binding);
}

function persistCurrentBinding(): boolean {
  const current = state;
  if (!current?.sessionId || current.sessionCreatedAt === null) return false;
  return writeBinding({
    version: 3,
    sessionId: current.sessionId,
    sessionCreatedAt: current.sessionCreatedAt,
    knownRootSessionIds: current.knownRootSessionIds,
    serverUrl: current.serverUrl,
    directory: current.directory,
    droneLabel: current.droneLabel,
    cubeName: current.cubeName,
    pendingSubmissions: [...current.pendingSubmissions].map(([entryId, sourceEntryId]) => ({
      entryId,
      sourceEntryId,
    })),
  });
}

function restoreBinding(): SessionBinding | null {
  if (!state) return null;
  if (state.sessionId && state.sessionCreatedAt !== null) {
    return {
      version: 3,
      sessionId: state.sessionId,
      sessionCreatedAt: state.sessionCreatedAt,
      knownRootSessionIds: state.knownRootSessionIds,
      serverUrl: state.serverUrl,
      directory: state.directory,
      droneLabel: state.droneLabel,
      cubeName: state.cubeName,
      pendingSubmissions: [...state.pendingSubmissions].map(([entryId, sourceEntryId]) => ({
        entryId,
        sourceEntryId,
      })),
    };
  }

  const binding = readBinding();
  if (!binding) return null;
  state.sessionId = binding.sessionId;
  state.sessionCreatedAt = binding.sessionCreatedAt;
  state.knownRootSessionIds = binding.knownRootSessionIds;
  state.pendingSubmissions = new Map(binding.pendingSubmissions.map((pending) => [
    pending.entryId,
    pending.sourceEntryId,
  ]));
  return binding;
}

function isBoundSession(session: OCSession, binding: SessionBinding): boolean {
  return session.id === binding.sessionId && session.directory === state!.directory;
}

function isTopLevelSession(session: OCSession): boolean {
  return !session.parentID;
}

async function findUnseenTopLevelSession(knownRootSessionIds: string[]): Promise<{
  session: OCSession;
  knownRootSessionIds: string[];
} | null> {
  try {
    const sessions = await listSessions();
    const roots = sessions.filter(
      (session) => session.directory === state!.directory
        && isTopLevelSession(session),
    );
    const matched = roots.filter((session) => !knownRootSessionIds.includes(session.id));
    if (matched.length === 0) return null;
    const best = matched.reduce((a, b) =>
      a.time.created > b.time.created ? a : b,
    );
    return { session: best, knownRootSessionIds: roots.map((session) => session.id) };
  } catch {
    return null;
  }
}

function kickoffMessageTime(messages: OCMessage[], nonce: string): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    if (message.info?.role && message.info.role !== 'user') continue;
    const matchesLaunchNonce = message.parts?.some(
      (part) => part.type === 'text' && part.text?.includes(`${OPEN_CODE_LAUNCH_NONCE_MARKER}${nonce}`),
    );
    if (!matchesLaunchNonce) continue;
    const created = message.info?.time?.created ?? 0;
    latest = latest === null ? created : Math.max(latest, created);
  }
  return latest;
}

/**
 * The launch process is the only place allowed to discover a session from the
 * server. It chooses the session that contains this launch's unique nonce,
 * rather than choosing by repeated kickoff text or session creation time. A
 * fork is therefore allowed only when it was explicitly selected for this
 * launch and received the nonce-bearing kickoff.
 */
async function findLaunchSession(nonce: string): Promise<{
  session: OCSession;
  knownRootSessionIds: string[];
} | null> {
  try {
    const sessions = (await listSessions()).filter(
      (session) => session.directory === state!.directory,
    );
    const knownRootSessionIds = sessions
      .filter(isTopLevelSession)
      .map((session) => session.id);
    const candidates = await Promise.all(sessions.map(async (session) => {
      try {
        const messageTime = kickoffMessageTime(
          await listSessionMessages(session.id),
          nonce,
        );
        return messageTime === null ? null : { session, messageTime };
      } catch {
        return null;
      }
    }));
    const matched = candidates.filter(
      (candidate): candidate is { session: OCSession; messageTime: number } => candidate !== null,
    );
    if (matched.length === 0) return null;
    const session = matched.reduce((best, candidate) =>
      candidate.messageTime > best.messageTime ? candidate : best,
    ).session;
    return { session, knownRootSessionIds };
  } catch {
    return null;
  }
}

async function resolveInjectionSession(): Promise<OCSession | null> {
  const binding = restoreBinding();
  if (!binding) return null;

  const bound = await getSession(binding.sessionId);
  if (!bound || !isBoundSession(bound, binding)) {
    clearBinding();
    const replacement = await findUnseenTopLevelSession(binding.knownRootSessionIds);
    if (!replacement) return null;
    saveBinding(replacement.session, replacement.knownRootSessionIds);
    return replacement.session;
  }

  // `/new` creates an unseen top-level session. Keep the launch-time root
  // snapshot so an old, unrelated root is never mistaken for a user switch.
  // Children never supersede the bound root.
  const switched = await findUnseenTopLevelSession(binding.knownRootSessionIds);
  if (switched) {
    saveBinding(switched.session, switched.knownRootSessionIds);
    return switched.session;
  }
  return bound;
}

function rememberBounded(
  entries: Map<string, OpenCodeDeliveryRecord>,
  entryId: string,
  text: string,
  sourceEntryId: string,
): void {
  entries.delete(entryId);
  entries.set(entryId, { text, sourceEntryId });
  while (entries.size > OPEN_CODE_DELIVERY_HISTORY_LIMIT) {
    const oldest = entries.keys().next().value;
    if (typeof oldest !== 'string') break;
    entries.delete(oldest);
  }
}

function clearPendingSubmission(owner: OpenCodeDroneState, entryId: string): void {
  if (!owner.pendingSubmissions.delete(entryId)) return;
  if (state === owner) persistCurrentBinding();
}

function confirmOpenCodeDelivery(
  owner: OpenCodeDroneState,
  delivery: Pick<OpenCodeDelivery, 'entryId' | 'sourceEntryId' | 'text'>,
): void {
  const unconfirmed = owner.unconfirmedEntries.get(delivery.entryId);
  if (unconfirmed && unconfirmed.text !== delivery.text) return;
  owner.unconfirmedEntries.delete(delivery.entryId);
  owner.failedEntries.delete(delivery.entryId);
  clearPendingSubmission(owner, delivery.entryId);
  rememberBounded(
    owner.deliveredEntries,
    delivery.entryId,
    delivery.text,
    delivery.sourceEntryId,
  );
  owner.totalEntriesInjected++;
}

function scheduleOpenCodeReconciliation(
  owner: OpenCodeDroneState,
  delivery: OpenCodeDelivery,
): void {
  if (!delivery.sessionId || owner.reconcilingEntryIds.has(delivery.entryId)) return;
  owner.reconcilingEntryIds.add(delivery.entryId);
  const sessionId = delivery.sessionId;
  void (async () => {
    try {
      for (let attempt = 0; attempt < OPEN_CODE_RECONCILIATION_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, OPEN_CODE_RECONCILIATION_DELAY_MS));
        if (state !== owner || !owner.connected || delivery.settled) return;
        const record = owner.unconfirmedEntries.get(delivery.entryId);
        if (!record || record.text !== delivery.text) return;
        owner.totalEntriesRetried++;
        try {
          if (await findInjectedMessage(sessionId, delivery.entryId)) {
            if (delivery.settled) return;
            confirmOpenCodeDelivery(owner, delivery);
            return;
          }
        } catch (err) {
          log(`entry ${delivery.entryId} reconciliation unavailable: ${err}`);
        }
      }
    } finally {
      owner.reconcilingEntryIds.delete(delivery.entryId);
    }
  })();
}

function waitForDeliveryRetry(attempt: number): Promise<void> {
  const delay = OPEN_CODE_DELIVERY_RETRY_DELAYS_MS[attempt] ?? 0;
  return delay > 0
    ? new Promise((resolve) => setTimeout(resolve, delay))
    : Promise.resolve();
}

async function deliverOpenCodeEntry(
  owner: OpenCodeDroneState,
  delivery: OpenCodeDelivery,
): Promise<OpenCodeDeliveryOutcome> {
  let target: OCSession | null = null;

  // Before the one allowed POST, retries are safe: no submission has happened.
  // OpenCode must generate the message ID: its run loop treats IDs as
  // lexicographically ordered, so arbitrary caller IDs can persist without
  // ever becoming the active user turn. The unique inbox text correlates the
  // generated message across confirmation and process-replay instead.
  for (let attempt = 0; attempt < OPEN_CODE_DELIVERY_RETRY_DELAYS_MS.length; attempt++) {
    if (delivery.settled) return 'delivered';
    if (state !== owner || !owner.connected) return 'failed';
    if (attempt > 0) {
      delivery.state = 'retried';
      owner.totalEntriesRetried++;
      await waitForDeliveryRetry(attempt);
      if (delivery.settled) return 'delivered';
      if (state !== owner || !owner.connected) return 'failed';
    }

    if (!target) {
      try {
        target = await resolveInjectionSession();
      } catch (err) {
        log(`entry ${delivery.entryId} target unavailable: ${err}`);
        continue;
      }
      if (!target) {
        log(`entry ${delivery.entryId} target unavailable: no bound session`);
        return 'failed';
      }
      delivery.sessionId = target.id;
    }

    try {
      const deliveredIdentity = await findInjectedMessage(target.id, delivery.entryId) ?? (
        delivery.sourceEntryId === delivery.entryId
          ? null
          : await findInjectedMessage(target.id, delivery.sourceEntryId)
      );
      if (deliveredIdentity) {
        log(`entry ${delivery.entryId} already present in session ${target.id}`);
        clearPendingSubmission(owner, delivery.entryId);
        return 'delivered';
      }
    } catch (err) {
      log(`entry ${delivery.entryId} confirmation unavailable: ${err}`);
      continue;
    }

    const submittedBefore = owner.pendingSubmissions.has(delivery.entryId);
    if (!delivery.allowSubmit && !submittedBefore) {
      continue;
    }

    if (submittedBefore) {
      delivery.acceptedSubmission = true;
      delivery.state = 'delivered-unconfirmed';
    } else {
      if (delivery.settled) return 'delivered';
      owner.pendingSubmissions.set(delivery.entryId, delivery.sourceEntryId);
      if (!persistCurrentBinding()) {
        owner.pendingSubmissions.delete(delivery.entryId);
        log(`entry ${delivery.entryId} submission skipped: pending intent was not durable`);
        return 'failed';
      }

      // prompt_async is not idempotent. Persist the intent before the one POST;
      // every recovery path is confirmation-only until that identity appears.
      let status: number | null = null;
      try {
        status = await promptSession(target.id, {
          parts: [{
            type: 'text',
            text: delivery.text,
            metadata: {
              [OPENCODE_INJECTED_ENTRY_METADATA_KEY]: true,
              [OPENCODE_WAKE_IDENTITY_METADATA_KEY]: delivery.entryId,
            },
          }],
        });
      } catch (err) {
        log(`entry ${delivery.entryId} submission outcome unavailable: ${err}`);
      }

      delivery.state = 'delivered-unconfirmed';
      if (status !== null && status !== 200 && status !== 204) {
        clearPendingSubmission(owner, delivery.entryId);
        if (status === 404) clearBinding();
        return 'failed';
      }
      delivery.acceptedSubmission = true;
    }

    for (
      let confirmationAttempt = 0;
      confirmationAttempt < OPEN_CODE_DELIVERY_RETRY_DELAYS_MS.length;
      confirmationAttempt++
    ) {
      if (confirmationAttempt > 0) {
        delivery.state = 'retried';
        owner.totalEntriesRetried++;
        await waitForDeliveryRetry(confirmationAttempt);
        if (delivery.settled) return 'delivered';
        if (state !== owner || !owner.connected) return 'delivered-unconfirmed';
        delivery.state = 'delivered-unconfirmed';
      }
      try {
        if (await findInjectedMessage(target.id, delivery.entryId)) {
          clearPendingSubmission(owner, delivery.entryId);
          return 'delivered';
        }
      } catch (err) {
        log(`entry ${delivery.entryId} post-acceptance confirmation unavailable: ${err}`);
      }
    }

    return 'delivered-unconfirmed';
  }

  // A replay begins from a durable inbox record but cannot know whether the
  // prior process stopped before or after submission. Missing confirmation
  // therefore remains unknown, not a definite delivery failure.
  return delivery.allowSubmit ? 'failed' : 'delivered-unconfirmed';
}

async function processOpenCodeDeliveries(owner: OpenCodeDroneState): Promise<void> {
  if (owner.processingDeliveries) return;
  owner.processingDeliveries = true;
  try {
    while (state === owner && owner.deliveryQueue.length > 0) {
      const delivery = owner.deliveryQueue.shift()!;
      let outcome: OpenCodeDeliveryOutcome = 'failed';
      try {
        outcome = await deliverOpenCodeEntry(owner, delivery);
      } catch (err) {
        log(`entry ${delivery.entryId} delivery error: ${err}`);
      }

      owner.activeDeliveries.delete(delivery.entryId);
      if (delivery.settled) {
        delivery.resolve(true);
      } else if (outcome === 'delivered') {
        confirmOpenCodeDelivery(owner, delivery);
        delivery.resolve(true);
      } else if (outcome === 'delivered-unconfirmed') {
        owner.failedEntries.delete(delivery.entryId);
        rememberBounded(
          owner.unconfirmedEntries,
          delivery.entryId,
          delivery.text,
          delivery.sourceEntryId,
        );
        delivery.resolve(delivery.acceptedSubmission);
        if (delivery.acceptedSubmission) scheduleOpenCodeReconciliation(owner, delivery);
      } else {
        owner.unconfirmedEntries.delete(delivery.entryId);
        rememberBounded(
          owner.failedEntries,
          delivery.entryId,
          delivery.text,
          delivery.sourceEntryId,
        );
        delivery.resolve(false);
      }
    }
  } finally {
    owner.processingDeliveries = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wait for the OpenCode HTTP server, then capture the session that received
 * this launch's nonce-bearing `--prompt` kickoff. The binding survives the separate
 * MCP-child process, which must never fall back to a newest-session heuristic.
 */
export async function injectInitialKickoff(launch: OpenCodeLaunchKickoff): Promise<boolean> {
  if (!state?.connected) { log('kickoff: not connected'); return false; }

  try {
    // Wait for the server.
    for (let i = 0; i < 30; i++) {
      try {
        await listSessions();
        log(`kickoff: server ready (attempt ${i + 1})`);
        break;
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Capture the launch-selected session, including explicit resume/fork
    // targets. Unrelated sessions do not contain this launch's nonce.
    for (let i = 0; i < 30; i++) {
      const binding = await findLaunchSession(launch.nonce);
      if (binding) {
        saveBinding(binding.session, binding.knownRootSessionIds);
        log(`kickoff: bound session ${binding.session.id.slice(0, 8)}…`);
        return true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    log('kickoff: no session found');
    return false;
  } catch (err) {
    log(`kickoff error: ${err}`);
    return false;
  }
}

/**
 * Queue one durable inbox entry for delivery into the bound OpenCode session.
 * The delivery identity is stored in TextPart metadata, so retries and replay
 * can confirm an earlier ambiguous submission without supplying an
 * ordering-breaking caller message ID or exposing the identity in delivered
 * text. Retry nonces also carry their durable source entry ID so they reconcile
 * one submission instead of creating a second prompt.
 */
export function injectOpenCodeEntry(
  text: string,
  entryId: string = createHash('sha256').update(text).digest('hex'),
  allowSubmit: boolean = true,
  sourceEntryId: string = entryId,
): Promise<boolean> {
  const owner = state;
  if (!owner?.connected) {
    log(`entry ${entryId} rejected: OpenCode is not connected`);
    return Promise.resolve(false);
  }

  const pendingSource = [...owner.pendingSubmissions].find(
    ([pendingEntryId, pendingSourceEntryId]) =>
      pendingEntryId !== entryId && pendingSourceEntryId === sourceEntryId,
  );
  if (pendingSource) {
    log(`entry ${entryId} reconciles pending source ${sourceEntryId}`);
    return injectOpenCodeEntry(text, pendingSource[0], false, sourceEntryId);
  }
  for (const [deliveredEntryId, record] of owner.deliveredEntries) {
    if (deliveredEntryId !== entryId && record.sourceEntryId === sourceEntryId) {
      if (record.text !== text) return Promise.resolve(false);
      log(`entry ${entryId} source ${sourceEntryId} already delivered`);
      return Promise.resolve(true);
    }
  }
  for (const [unconfirmedEntryId, record] of owner.unconfirmedEntries) {
    if (unconfirmedEntryId !== entryId && record.sourceEntryId === sourceEntryId) {
      if (record.text !== text) return Promise.resolve(false);
      log(`entry ${entryId} source ${sourceEntryId} remains unconfirmed`);
      return Promise.resolve(true);
    }
  }
  for (const active of owner.activeDeliveries.values()) {
    if (active.entryId !== entryId && active.sourceEntryId === sourceEntryId) {
      if (active.text !== text) return Promise.resolve(false);
      log(`entry ${entryId} joined active source ${sourceEntryId}`);
      return active.promise;
    }
  }

  const delivered = owner.deliveredEntries.get(entryId);
  if (delivered !== undefined) {
    if (delivered.text !== text || delivered.sourceEntryId !== sourceEntryId) {
      log(`entry ${entryId} replay text mismatch`);
      rememberBounded(owner.failedEntries, entryId, text, sourceEntryId);
      return Promise.resolve(false);
    }
    log(`entry ${entryId} replay already delivered`);
    return Promise.resolve(true);
  }

  const unconfirmed = owner.unconfirmedEntries.get(entryId);
  if (unconfirmed !== undefined) {
    if (unconfirmed.text !== text || unconfirmed.sourceEntryId !== sourceEntryId) {
      log(`entry ${entryId} unconfirmed replay text mismatch`);
      rememberBounded(owner.failedEntries, entryId, text, sourceEntryId);
      return Promise.resolve(false);
    }
    log(`entry ${entryId} replay remains unconfirmed`);
    const accepted = owner.pendingSubmissions.has(entryId);
    if (accepted && owner.sessionId) {
      scheduleOpenCodeReconciliation(owner, {
        entryId,
        sourceEntryId,
        text,
        allowSubmit: false,
        acceptedSubmission: true,
        sessionId: owner.sessionId,
        settled: false,
        state: 'delivered-unconfirmed',
        resolve: () => {},
        promise: Promise.resolve(true),
      });
    }
    return Promise.resolve(accepted);
  }

  const active = owner.activeDeliveries.get(entryId);
  if (active) {
    if (active.text !== text || active.sourceEntryId !== sourceEntryId) {
      log(`entry ${entryId} active text mismatch`);
      rememberBounded(owner.failedEntries, entryId, text, sourceEntryId);
      return Promise.resolve(false);
    }
    log(`entry ${entryId} replay joined active delivery`);
    return active.promise;
  }

  let resolveDelivery!: (delivered: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolveDelivery = resolve;
  });
  const delivery: OpenCodeDelivery = {
    entryId,
    sourceEntryId,
    text,
    allowSubmit,
    acceptedSubmission: false,
    sessionId: null,
    settled: false,
    state: 'queued',
    resolve: resolveDelivery,
    promise,
  };
  owner.unconfirmedEntries.delete(entryId);
  owner.failedEntries.delete(entryId);
  owner.activeDeliveries.set(entryId, delivery);
  owner.deliveryQueue.push(delivery);
  void processOpenCodeDeliveries(owner);
  return promise;
}

/** Stop retrying every delivery identity derived from a durable entry that the
 * agent has already consumed. Confirmed history stays available for dedup. */
export function settleOpenCodeEntry(sourceEntryId: string): void {
  const owner = state;
  if (!owner) return;

  let bindingChanged = false;
  for (const [entryId, record] of owner.unconfirmedEntries) {
    if (record.sourceEntryId !== sourceEntryId) continue;
    owner.unconfirmedEntries.delete(entryId);
    bindingChanged = owner.pendingSubmissions.delete(entryId) || bindingChanged;
  }
  for (const [entryId, record] of owner.failedEntries) {
    if (record.sourceEntryId === sourceEntryId) owner.failedEntries.delete(entryId);
  }
  for (const delivery of owner.activeDeliveries.values()) {
    if (delivery.sourceEntryId !== sourceEntryId) continue;
    delivery.settled = true;
    delivery.resolve(true);
    bindingChanged = owner.pendingSubmissions.delete(delivery.entryId) || bindingChanged;
  }
  if (bindingChanged) persistCurrentBinding();
}

export async function probeOpenCodeDroneArmed(): Promise<boolean | null> {
  if (!state?.connected) return null;
  const binding = restoreBinding();
  if (!binding) return false;

  try {
    const session = await getSession(binding.sessionId);
    if (session && isBoundSession(session, binding)) return true;
    clearBinding();
    return false;
  } catch {
    return false;
  }
}

export function disconnectOpenCodeDrone(): void {
  abandonOpenCodeDeliveries(state);
  state = null;
}

export interface OpenCodeConnectionState {
  connected: boolean;
  sessionId: string | null;
  totalEntriesInjected: number;
  totalEntriesRetried: number;
  deliveryStates: Record<OpenCodeDeliveryState, number>;
}

export function getOpenCodeConnectionState(): OpenCodeConnectionState {
  const deliveryStates: Record<OpenCodeDeliveryState, number> = {
    queued: 0,
    'delivered-unconfirmed': state?.unconfirmedEntries.size ?? 0,
    retried: 0,
    failed: state?.failedEntries.size ?? 0,
  };
  for (const delivery of state?.activeDeliveries.values() ?? []) {
    deliveryStates[delivery.state]++;
  }
  return {
    connected: state?.connected ?? false,
    sessionId: state?.sessionId ?? null,
    totalEntriesInjected: state?.totalEntriesInjected ?? 0,
    totalEntriesRetried: state?.totalEntriesRetried ?? 0,
    deliveryStates,
  };
}

export function computeOpenCodePort(droneId: string, base: number = 14096): number {
  let hash = 0;
  for (let i = 0; i < droneId.length; i++) {
    const char = droneId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return base + (Math.abs(hash) % 1024);
}

/**
 * Ask the OS for an available loopback port. The old deterministic hash is
 * retained above only for compatibility fixtures; launch paths must not use a
 * bounded shared port space where two drones can collide.
 */
async function canBindOpenCodePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

export function configuredOpenCodePort(env: NodeJS.ProcessEnv = process.env): number | null {
  const port = Number(env.BORG_OPENCODE_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

export const OPEN_CODE_PORT_MISSING_DIAGNOSTIC =
  'OpenCode launch port is missing; skipping OpenCode entry injection. Relaunch through borg.';

export function openCodeLaunchBinding(port: number): {
  cliPort: string;
  envPort: string;
  serverUrl: string;
} {
  const value = String(port);
  return { cliPort: value, envPort: value, serverUrl: `http://127.0.0.1:${value}` };
}

export async function allocateOpenCodePort(
  isPortAvailable: (port: number) => Promise<boolean> = canBindOpenCodePort,
): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      const fail = (error: Error) => {
        probe.close(() => reject(error));
      };
      probe.once('error', fail);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        if (address === null || typeof address === 'string') {
          fail(new Error('OpenCode port allocation returned no TCP address'));
          return;
        }
        probe.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
    if (await isPortAvailable(port)) return port;
  }
  throw new Error('OpenCode port allocation could not claim an available loopback port');
}

/** Test-only cleanup for module state and the local cross-process binding. */
export function __resetOpenCodeDroneForTests(): void {
  abandonOpenCodeDeliveries(state);
  state = null;
  for (const path of bindingPathsForTests) {
    try {
      unlinkSync(path);
    } catch {
      // Already removed.
    }
  }
  bindingPathsForTests.clear();
}
