import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import { createServer } from 'node:net';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  borgConfigRoot,
  ensurePrivateBorgConfigRoot,
  ensurePrivateBorgConfigRootSync,
} from './private-root.js';
import {
  OPENCODE_INJECTED_ENTRY_METADATA_KEY,
  OPENCODE_WAKE_IDENTITY_METADATA_KEY,
  OPENCODE_LAUNCH_CORRELATION_METADATA_KEY,
} from './opencode-plugin.js';
import {
  createOpenCodeLaunchTrust,
  isOpenCode256BitIdentity,
  OPENCODE_SERVER_USERNAME,
  type OpenCodeLaunchTrust,
} from './opencode-launch-trust.js';
import {
  OpenCodeAuthenticationError,
  OpenCodeHttpError,
  OpenCodeResponseError,
  OpenCodeUnreachableError,
  type OpenCodeFailureCode,
} from './server-errors.js';

const OPEN_CODE_DIAGNOSTIC_LOG_MAX_BYTES = 64 * 1024;
const diagnosticLogPathsForTests = new Set<string>();

function stateIdentityDigest(current: OpenCodeDroneState): string {
  // Diagnostic files follow the stable worktree location; launch placeholders
  // must not select a second log before session identity resolves.
  return createHash('sha256').update(resolve(current.directory)).digest('hex').slice(0, 24);
}

export function openCodeStartupDiagnosticLogPath(): string {
  return join(borgConfigRoot(), 'opencode-drone-startup.log');
}

function diagnosticLogPath(owner: OpenCodeDroneState | null): string {
  const root = borgConfigRoot();
  const path = owner
    ? join(root, `opencode-drone-${stateIdentityDigest(owner)}.log`)
    : openCodeStartupDiagnosticLogPath();
  diagnosticLogPathsForTests.add(path);
  return path;
}

function log(msg: string, owner: OpenCodeDroneState | null = state, throwOnFailure = false) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  let descriptor: number | null = null;
  let temporaryDescriptor: number | null = null;
  let temporary: string | null = null;
  try {
    ensurePrivateBorgConfigRootSync(borgConfigRoot());
    const path = diagnosticLogPath(owner);
    // The private root is the primary boundary. Where available, no-follow also
    // closes the final replacement gap between root verification and this open.
    const noFollow = constants.O_NOFOLLOW ?? 0;
    descriptor = openSync(
      path,
      constants.O_RDWR |
        constants.O_APPEND |
        constants.O_CREAT |
        noFollow,
      0o600,
    );
    if (!fstatSync(descriptor).isFile()) {
      throw Object.assign(new Error('OpenCode diagnostic log is not a regular file'), { code: 'EINVAL' });
    }
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, line, null, 'utf8');

    const size = fstatSync(descriptor).size;
    if (size <= OPEN_CODE_DIAGNOSTIC_LOG_MAX_BYTES) return;
    const tail = Buffer.allocUnsafe(OPEN_CODE_DIAGNOSTIC_LOG_MAX_BYTES);
    let bytesRead = 0;
    while (bytesRead < tail.length) {
      const count = readSync(
        descriptor,
        tail,
        bytesRead,
        tail.length - bytesRead,
        size - tail.length + bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    const completeTail = tail.subarray(0, bytesRead);
    const firstNewline = completeTail.indexOf(0x0a);
    const bounded = firstNewline >= 0 ? completeTail.subarray(firstNewline + 1) : completeTail;

    temporary = `${path}.${randomUUID()}.tmp`;
    temporaryDescriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    if (!fstatSync(temporaryDescriptor).isFile()) {
      throw Object.assign(new Error('OpenCode diagnostic temporary is not a regular file'), { code: 'EINVAL' });
    }
    fchmodSync(temporaryDescriptor, 0o600);
    let bytesWritten = 0;
    while (bytesWritten < bounded.length) {
      const count = writeSync(
        temporaryDescriptor,
        bounded,
        bytesWritten,
        bounded.length - bytesWritten,
      );
      if (count === 0) throw Object.assign(new Error('OpenCode diagnostic temporary write stalled'), { code: 'EIO' });
      bytesWritten += count;
    }
    closeSync(temporaryDescriptor);
    temporaryDescriptor = null;
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    temporary = null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? 'unknown';
    process.stderr.write(`OpenCode diagnostic log write failed (${code})\n`);
    if (throwOnFailure) throw error;
  } finally {
    if (temporaryDescriptor !== null) {
      try { closeSync(temporaryDescriptor); } catch { /* The primary write error is already reported. */ }
    }
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* The primary write error is already reported. */ }
    }
    if (temporary !== null) {
      try {
        unlinkSync(temporary);
      } catch {
        // Already absent or inaccessible; the randomized name cannot be reused.
      }
    }
  }
}

export function writeOpenCodeStartupDiagnostic(message: string): void {
  log(message, null, true);
}

interface OpenCodeDroneState {
  serverUrl: string;
  apiPassword: string;
  sessionId: string | null;
  sessionCreatedAt: number | null;
  knownRootSessionIds: string[];
  directory: string;
  droneLabel: string;
  cubeName: string;
  launchIdentity: string;
  connected: boolean;
  totalEntriesInjected: number;
  totalEntriesRetried: number;
  deliveryQueue: OpenCodeDelivery[];
  activeDeliveries: Map<string, OpenCodeDelivery>;
  deliveredEntries: Map<string, OpenCodeDeliveryRecord>;
  unconfirmedEntries: Map<string, OpenCodeDeliveryRecord>;
  failedEntries: Map<string, OpenCodeDeliveryRecord>;
  pendingSubmissions: Map<string, PendingOpenCodeSubmission>;
  reconcilingEntryIds: Set<string>;
  processingDeliveries: boolean;
  nextObservationSequence: number;
  lastObservation: OpenCodeLastObservation;
}

interface OpenCodeLastObservation {
  injectionSequence: number;
  acceptedSequence: number;
  failureSequence: number;
  lastInjectionAt: number | null;
  lastInjectionResult: OpenCodeInjectionResult | null;
  lastAcceptedEntryId: string | null;
  lastFailureCode: string | null;
}

type OpenCodeLastFields = Pick<
  OpenCodeLastObservation,
  'lastInjectionAt' | 'lastInjectionResult' | 'lastAcceptedEntryId' | 'lastFailureCode'
>;

let state: OpenCodeDroneState | null = null;

interface ConnectDeps {
  serverUrl: string;
  apiPassword: string;
  directory: string;
  droneLabel: string;
  cubeName: string;
  launchIdentity: string;
}

interface OCSession {
  id: string;
  directory: string;
  time: { created: number };
  parentID?: string;
}

interface OCMessage {
  info: {
    id?: string;
    role: string;
    time?: { created?: number };
  };
  parts: Array<{
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
  sequence: number;
  entryId: string;
  sourceEntryId: string;
  text: string;
  allowSubmit: boolean;
  acceptedSubmission: boolean;
  sessionId: string | null;
  settled: boolean;
  isSourcePending?: () => Promise<boolean>;
  state: Exclude<OpenCodeDeliveryState, 'failed'>;
  resolve: (delivered: boolean) => void;
  promise: Promise<boolean>;
}

interface OpenCodeDeliveryRecord {
  text: string;
  sourceEntryId: string;
}

interface PendingOpenCodeSubmission {
  sourceEntryId: string;
  /** Session that received the one allowed prompt_async submission. */
  sessionId: string;
}

type OpenCodeDeliveryOutcome = 'delivered' | 'delivered-unconfirmed' | 'failed';
type OpenCodeInjectionResult = OpenCodeDeliveryOutcome;

const OPEN_CODE_DELIVERY_RETRY_DELAYS_MS = [0, 250, 1_000, 3_000] as const;
const OPEN_CODE_RECONCILIATION_DELAY_MS = 3_000;
// Keep one accepted-but-unconfirmed prompt from holding timers forever. It
// remains pending (never failed or resubmitted), and any later wake retry
// re-arms another confirmation-only window.
const OPEN_CODE_RECONCILIATION_ATTEMPTS = 20;
const OPEN_CODE_DELIVERY_HISTORY_LIMIT = 256;

interface SessionBinding {
  version: 5;
  sessionId: string;
  sessionCreatedAt: number;
  knownRootSessionIds: string[];
  serverUrl: string;
  directory: string;
  droneLabel: string;
  cubeName: string;
  launchIdentity: string;
  pendingSubmissions: Array<{
    entryId: string;
    sourceEntryId: string;
    sessionId: string;
  }>;
}

export interface OpenCodeLaunchKickoff {
  prompt: string;
  apiPassword: string;
  correlationIdentity: string;
}

/**
 * Create independent launch trust for OpenCode without changing the shared
 * kickoff text. The plugin writes the correlation identity to hidden metadata
 * on the first qualifying human TextPart; the API password stays in env.
 */
export function createOpenCodeLaunchKickoff(
  kickoff: string,
  trust: Partial<OpenCodeLaunchTrust> = {},
): OpenCodeLaunchKickoff {
  const launchTrust = createOpenCodeLaunchTrust(trust);
  return {
    prompt: kickoff,
    ...launchTrust,
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
  if (!isOpenCode256BitIdentity(deps.apiPassword)) {
    throw new OpenCodeAuthenticationError('OpenCode API password is missing or unverifiable');
  }
  if (!isOpenCode256BitIdentity(deps.launchIdentity)) {
    throw new OpenCodeAuthenticationError('OpenCode launch identity is missing or unverifiable');
  }
  await ensurePrivateBorgConfigRoot(borgConfigRoot());
  abandonOpenCodeDeliveries(state);
  state = {
    serverUrl: deps.serverUrl,
    apiPassword: deps.apiPassword,
    sessionId: null,
    sessionCreatedAt: null,
    knownRootSessionIds: [],
    directory: deps.directory,
    droneLabel: deps.droneLabel,
    cubeName: deps.cubeName,
    launchIdentity: deps.launchIdentity,
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
    nextObservationSequence: 0,
    lastObservation: {
      injectionSequence: 0,
      acceptedSequence: 0,
      failureSequence: 0,
      lastInjectionAt: null,
      lastInjectionResult: null,
      lastAcceptedEntryId: null,
      lastFailureCode: null,
    },
  };
  log(`connected url=${deps.serverUrl} dir=${deps.directory}`, state);
}

// ---------------------------------------------------------------------------
// Raw fetch wrappers
// ---------------------------------------------------------------------------

function apiUrl(path: string): string {
  const base = state!.serverUrl.replace(/\/+$/, '');
  return `${base}${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(state!.directory)}`;
}

function authenticatedHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const password = state?.apiPassword;
  if (!isOpenCode256BitIdentity(password)) {
    throw new OpenCodeAuthenticationError('OpenCode API password is missing or unverifiable');
  }
  return {
    ...headers,
    Authorization: `Basic ${Buffer.from(`${OPENCODE_SERVER_USERNAME}:${password}`).toString('base64')}`,
  };
}

const FETCH_TIMEOUT = 10_000;

async function rawGet(path: string): Promise<{ status: number; body: string }> {
  const url = apiUrl(path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { headers: authenticatedHeaders(), signal: controller.signal });
    const body = await res.text();
    return { status: res.status, body };
  } catch (error) {
    if (error instanceof OpenCodeAuthenticationError) throw error;
    throw new OpenCodeUnreachableError(
      controller.signal.aborted ? 'timeout' : 'transient',
      controller.signal.aborted ? 'OpenCode request timed out' : 'OpenCode request failed',
      { cause: error },
    );
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
      headers: authenticatedHeaders({ 'Content-Type': 'application/json' }),
      signal: controller.signal,
      body: JSON.stringify(bodyObj),
    });
    const body = await res.text();
    return { status: res.status, body };
  } catch (error) {
    if (error instanceof OpenCodeAuthenticationError) throw error;
    throw new OpenCodeUnreachableError(
      controller.signal.aborted ? 'timeout' : 'transient',
      controller.signal.aborted ? 'OpenCode request timed out' : 'OpenCode request failed',
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

function openCodeHttpError(status: number, operation: string): OpenCodeHttpError {
  const code: OpenCodeFailureCode = status === 401
    ? 'unauthorized'
    : status === 404
      ? 'not-found'
      : status >= 500 || status === 429
        ? 'transient'
        : 'incompatible-api';
  return new OpenCodeHttpError(status, code, `OpenCode ${operation} request failed (${status})`);
}

function parseOpenCodeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new OpenCodeResponseError('OpenCode returned malformed JSON', { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeSession(value: unknown): OCSession {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || value.id.length === 0
    || typeof value.directory !== 'string'
    || !isRecord(value.time)
    || typeof value.time.created !== 'number'
    || !Number.isFinite(value.time.created)
    || (value.parentID !== undefined && typeof value.parentID !== 'string')
  ) {
    throw new OpenCodeResponseError();
  }
  return value as unknown as OCSession;
}

function decodeSessions(body: string): OCSession[] {
  const value = parseOpenCodeJson(body);
  if (!Array.isArray(value)) throw new OpenCodeResponseError();
  return value.map(decodeSession);
}

function decodeMessages(body: string): OCMessage[] {
  const value = parseOpenCodeJson(body);
  if (!Array.isArray(value)) throw new OpenCodeResponseError();
  return value.map((message) => {
    if (!isRecord(message)) throw new OpenCodeResponseError();
    if (
      !isRecord(message.info)
      || typeof message.info.role !== 'string'
      || (message.info.id !== undefined && typeof message.info.id !== 'string')
      || (message.info.time !== undefined && (
        !isRecord(message.info.time)
        || (message.info.time.created !== undefined && typeof message.info.time.created !== 'number')
      ))
    ) throw new OpenCodeResponseError();
    if (
      !Array.isArray(message.parts)
      || message.parts.some((part) => !isRecord(part)
        || (part.type !== undefined && typeof part.type !== 'string')
        || (part.text !== undefined && typeof part.text !== 'string')
        || (part.metadata !== undefined && !isRecord(part.metadata)))
    ) throw new OpenCodeResponseError();
    return message as unknown as OCMessage;
  });
}

async function listSessions(): Promise<OCSession[]> {
  const { status, body } = await rawGet('/session');
  if (status !== 200) throw openCodeHttpError(status, 'sessions');
  return decodeSessions(body);
}

async function getSession(id: string): Promise<OCSession | null> {
  const { status, body } = await rawGet(`/session/${id}`);
  if (status === 404) return null;
  if (status !== 200) throw openCodeHttpError(status, 'session');
  return decodeSession(parseOpenCodeJson(body));
}

async function listSessionMessages(id: string): Promise<OCMessage[]> {
  const { status, body } = await rawGet(`/session/${id}/message`);
  if (status !== 200) throw openCodeHttpError(status, 'session messages');
  return decodeMessages(body);
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
  const identity = createHash('sha256').update(current.launchIdentity).digest('hex').slice(0, 24);
  const path = join(tmpdir(), `borg-opencode-session-${identity}.json`);
  bindingPathsForTests.add(path);
  return path;
}

function bindingMatchesState(binding: SessionBinding): boolean {
  const current = state!;
  const sameResolvedSeat = binding.droneLabel === current.droneLabel
    && binding.cubeName === current.cubeName;
  // The 256-bit launch identity lets the resolved MCP child claim only its
  // launcher's placeholder binding; resolved ownership still requires labels.
  const unclaimedLaunch = binding.droneLabel === 'opencode'
    && binding.cubeName === 'borg';
  return binding.version === 5
    && binding.directory === current.directory
    && binding.launchIdentity === current.launchIdentity
    && (sameResolvedSeat || unclaimedLaunch)
    && typeof binding.sessionId === 'string'
    && typeof binding.sessionCreatedAt === 'number'
    && Array.isArray(binding.knownRootSessionIds)
    && binding.knownRootSessionIds.every((id) => typeof id === 'string')
    && Array.isArray(binding.pendingSubmissions)
    && binding.pendingSubmissions.every((pending) =>
      typeof pending?.entryId === 'string'
        && typeof pending?.sourceEntryId === 'string'
        && typeof pending.sessionId === 'string'
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
  // A missing/replaced target does not prove that an earlier prompt_async was
  // rejected. Keep its durable submission marker (and origin session) so a
  // replacement binding and later MCP-child reconnect remain confirmation-only.
  if (state.pendingSubmissions.size > 0) return;
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
  const binding: SessionBinding = {
    version: 5,
    sessionId: session.id,
    sessionCreatedAt: session.time.created,
    knownRootSessionIds,
    serverUrl: current.serverUrl,
    directory: current.directory,
    droneLabel: current.droneLabel,
    cubeName: current.cubeName,
    launchIdentity: current.launchIdentity,
    pendingSubmissions: [...current.pendingSubmissions].map(([entryId, pending]) => ({
      entryId,
      sourceEntryId: pending.sourceEntryId,
      sessionId: pending.sessionId,
    })),
  };
  writeBinding(binding);
}

function persistCurrentBinding(): boolean {
  const current = state;
  if (!current?.sessionId || current.sessionCreatedAt === null) return false;
  return writeBinding({
    version: 5,
    sessionId: current.sessionId,
    sessionCreatedAt: current.sessionCreatedAt,
    knownRootSessionIds: current.knownRootSessionIds,
    serverUrl: current.serverUrl,
    directory: current.directory,
    droneLabel: current.droneLabel,
    cubeName: current.cubeName,
    launchIdentity: current.launchIdentity,
    pendingSubmissions: [...current.pendingSubmissions].map(([entryId, pending]) => ({
      entryId,
      sourceEntryId: pending.sourceEntryId,
      sessionId: pending.sessionId,
    })),
  });
}

function restoreBinding(): SessionBinding | null {
  if (!state) return null;
  if (state.sessionId && state.sessionCreatedAt !== null) {
    return {
      version: 5,
      sessionId: state.sessionId,
      sessionCreatedAt: state.sessionCreatedAt,
      knownRootSessionIds: state.knownRootSessionIds,
      serverUrl: state.serverUrl,
      directory: state.directory,
      droneLabel: state.droneLabel,
      cubeName: state.cubeName,
      launchIdentity: state.launchIdentity,
      pendingSubmissions: [...state.pendingSubmissions].map(([entryId, pending]) => ({
        entryId,
        sourceEntryId: pending.sourceEntryId,
        sessionId: pending.sessionId,
      })),
    };
  }

  const binding = readBinding();
  if (!binding) return null;
  if (binding.droneLabel === 'opencode' && binding.cubeName === 'borg') {
    binding.droneLabel = state.droneLabel;
    binding.cubeName = state.cubeName;
    if (!writeBinding(binding)) return null;
  }
  state.sessionId = binding.sessionId;
  state.sessionCreatedAt = binding.sessionCreatedAt;
  state.knownRootSessionIds = binding.knownRootSessionIds;
  state.pendingSubmissions = new Map(binding.pendingSubmissions.map((pending) => [
    pending.entryId,
    {
      sourceEntryId: pending.sourceEntryId,
      sessionId: pending.sessionId,
    },
  ]));
  return binding;
}

function isBoundSession(session: OCSession, binding: SessionBinding): boolean {
  return session.id === binding.sessionId && session.directory === binding.directory;
}

function isTopLevelSession(session: OCSession): boolean {
  return !session.parentID;
}

async function findUnseenTopLevelSession(knownRootSessionIds: string[], directory: string): Promise<{
  session: OCSession;
  knownRootSessionIds: string[];
} | null> {
  const sessions = await listSessions();
  const roots = sessions.filter(
    (session) => session.directory === directory
      && isTopLevelSession(session),
  );
  const matched = roots.filter((session) => !knownRootSessionIds.includes(session.id));
  if (matched.length === 0) return null;
  const best = matched.reduce((a, b) =>
    a.time.created > b.time.created ? a : b,
  );
  return { session: best, knownRootSessionIds: roots.map((session) => session.id) };
}

function launchCorrelationMatchCount(messages: OCMessage[], correlationIdentity: string): number {
  let count = 0;
  for (const message of messages) {
    if (message.info?.role !== 'user') continue;
    for (const part of message.parts ?? []) {
      if (
        part.type === 'text' &&
        part.metadata?.[OPENCODE_LAUNCH_CORRELATION_METADATA_KEY] === correlationIdentity
      ) {
        count++;
      }
    }
  }
  return count;
}

/**
 * The launch process is the only place allowed to discover a session from the
 * server. It chooses the session containing exactly one hidden metadata match,
 * never repeated prompt text, timestamps, or newest-session order. A fork is
 * therefore allowed only when it received this launch's correlation metadata.
 */
async function findLaunchSession(correlationIdentity: string): Promise<{
  kind: 'found';
  session: OCSession;
  knownRootSessionIds: string[];
} | {
  kind: 'superseded';
} | {
  kind: 'list-failed';
  failureCode: string;
  errorClass: string;
  httpStatus: number | null;
} | {
  kind: 'directory-miss';
  listedCount: number;
  directoryCount: 0;
} | {
  kind: 'message-list-failed';
  listedCount: number;
  directoryCount: number;
  failureCode: string;
  errorClass: string;
  httpStatus: number | null;
} | {
  kind: 'correlation-mismatch';
  listedCount: number;
  directoryCount: number;
  matchCount: number;
}> {
  const owner = state!;
  const observationSequence = ++owner.nextObservationSequence;
  let listedSessions: OCSession[];
  try {
    listedSessions = await listSessions();
  } catch (error) {
    if (state === owner) recordOpenCodeFailure(owner, error, observationSequence);
    return { kind: 'list-failed', ...openCodeFailureDiagnostic(error) };
  }
  if (state !== owner) return { kind: 'superseded' };
  const sessions = listedSessions.filter(
    (session) => session.directory === owner.directory,
  );
  if (sessions.length === 0) {
    return { kind: 'directory-miss', listedCount: listedSessions.length, directoryCount: 0 };
  }
  const knownRootSessionIds = sessions
    .filter(isTopLevelSession)
    .map((session) => session.id);
  let candidates: Array<{ session: OCSession; matchCount: number }>;
  try {
    candidates = await Promise.all(sessions.map(async (session) => ({
      session,
      matchCount: launchCorrelationMatchCount(
        await listSessionMessages(session.id),
        correlationIdentity,
      ),
    })));
  } catch (error) {
    if (state === owner) recordOpenCodeFailure(owner, error, observationSequence);
    return {
      kind: 'message-list-failed',
      listedCount: listedSessions.length,
      directoryCount: sessions.length,
      ...openCodeFailureDiagnostic(error),
    };
  }
  if (state !== owner) return { kind: 'superseded' };
  const totalMatches = candidates.reduce((total, candidate) => total + candidate.matchCount, 0);
  if (totalMatches !== 1) {
    return {
      kind: 'correlation-mismatch',
      listedCount: listedSessions.length,
      directoryCount: sessions.length,
      matchCount: totalMatches,
    };
  }
  const matched = candidates.find((candidate) => candidate.matchCount === 1)!;
  return { kind: 'found', session: matched.session, knownRootSessionIds };
}

type LaunchSessionSearchFailure = Exclude<Awaited<ReturnType<typeof findLaunchSession>>, {
  kind: 'found' | 'superseded';
}>;

function logLaunchSessionSearchFailure(
  failure: LaunchSessionSearchFailure,
  attempts: number,
  owner: OpenCodeDroneState,
): void {
  switch (failure.kind) {
    case 'list-failed':
      log(
        `kickoff: session search list-failed code=${failure.failureCode} `
        + `class=${failure.errorClass} status=${failure.httpStatus ?? 'none'} `
        + `listed=unknown directory=unknown matches=unknown attempts=${attempts}`,
        owner,
      );
      break;
    case 'directory-miss':
      log(
        `kickoff: session search directory-miss listed=${failure.listedCount} `
        + `directory=${failure.directoryCount} matches=0 attempts=${attempts}`,
        owner,
      );
      break;
    case 'message-list-failed':
      log(
        `kickoff: session search messages-failed code=${failure.failureCode} `
        + `class=${failure.errorClass} status=${failure.httpStatus ?? 'none'} `
        + `listed=${failure.listedCount} directory=${failure.directoryCount} `
        + `matches=unknown attempts=${attempts}`,
        owner,
      );
      break;
    case 'correlation-mismatch':
      log(
        `kickoff: session search correlation-mismatch listed=${failure.listedCount} `
        + `directory=${failure.directoryCount} `
        + `matches=${failure.matchCount} attempts=${attempts}`,
        owner,
      );
      break;
  }
}

async function resolveInjectionSession(
  owner: OpenCodeDroneState,
  observationSequence: number,
): Promise<OCSession | null> {
  if (state !== owner) return null;
  const binding = restoreBinding();
  if (!binding) return null;

  const bound = await getSession(binding.sessionId);
  if (state !== owner) return null;
  if (!bound || !isBoundSession(bound, binding)) {
    clearBinding();
    const replacement = await findUnseenTopLevelSession(binding.knownRootSessionIds, owner.directory);
    if (state !== owner) return null;
    if (!replacement) return null;
    saveBinding(replacement.session, replacement.knownRootSessionIds);
    return replacement.session;
  }

  // `/new` creates an unseen top-level session. Keep the launch-time root
  // snapshot so an old, unrelated root is never mistaken for a user switch.
  // Children never supersede the bound root.
  let switched: Awaited<ReturnType<typeof findUnseenTopLevelSession>> = null;
  try {
    switched = await findUnseenTopLevelSession(binding.knownRootSessionIds, owner.directory);
  } catch (error) {
    recordOpenCodeFailure(owner, error, observationSequence);
  }
  if (state !== owner) return null;
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

function openCodeFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return error instanceof Error && error.name ? error.name : 'unknown';
}

function openCodeFailureDiagnostic(error: unknown): {
  failureCode: string;
  errorClass: string;
  httpStatus: number | null;
} {
  return {
    failureCode: openCodeFailureCode(error),
    errorClass: error instanceof Error && error.name ? error.name : 'unknown',
    httpStatus: error instanceof OpenCodeHttpError ? error.status : null,
  };
}

function updateLastOpenCodeObservation(
  owner: OpenCodeDroneState,
  sequence: number,
  update: Partial<OpenCodeLastFields>,
): void {
  // Attempts, acceptances, and failures resolve independently; an observation
  // may be stale for one field without being stale for the others.
  const current = owner.lastObservation;
  const updatesInjection = 'lastInjectionAt' in update || 'lastInjectionResult' in update;
  const updatesAccepted = 'lastAcceptedEntryId' in update;
  const updatesFailure = 'lastFailureCode' in update;
  owner.lastObservation = {
    ...current,
    ...(updatesInjection && sequence >= current.injectionSequence
      ? {
        injectionSequence: sequence,
        ...('lastInjectionAt' in update
          ? { lastInjectionAt: update.lastInjectionAt as number | null }
          : {}),
        ...('lastInjectionResult' in update
          ? { lastInjectionResult: update.lastInjectionResult as OpenCodeInjectionResult | null }
          : {}),
      }
      : {}),
    ...(updatesAccepted && sequence >= current.acceptedSequence
      ? { acceptedSequence: sequence, lastAcceptedEntryId: update.lastAcceptedEntryId as string | null }
      : {}),
    ...(updatesFailure && sequence >= current.failureSequence
      ? { failureSequence: sequence, lastFailureCode: update.lastFailureCode as string | null }
      : {}),
  };
}

function recordOpenCodeFailure(
  owner: OpenCodeDroneState,
  error: unknown,
  observationSequence: number,
): void {
  updateLastOpenCodeObservation(owner, observationSequence, {
    lastFailureCode: openCodeFailureCode(error),
  });
}

function recordOpenCodeAcceptance(
  owner: OpenCodeDroneState,
  delivery: Pick<OpenCodeDelivery, 'sequence' | 'entryId'>,
): void {
  updateLastOpenCodeObservation(owner, delivery.sequence, {
    lastAcceptedEntryId: delivery.entryId,
  });
}

function clearPendingSubmission(owner: OpenCodeDroneState, entryId: string): void {
  if (!owner.pendingSubmissions.delete(entryId)) return;
  if (state === owner) persistCurrentBinding();
}

function confirmOpenCodeDelivery(
  owner: OpenCodeDroneState,
  delivery: Pick<OpenCodeDelivery, 'sequence' | 'entryId' | 'sourceEntryId' | 'text'>,
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
  updateLastOpenCodeObservation(owner, delivery.sequence, {
    lastAcceptedEntryId: delivery.entryId,
    lastInjectionResult: 'delivered',
    lastFailureCode: null,
  });
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
          recordOpenCodeFailure(owner, err, delivery.sequence);
          log(`entry ${delivery.entryId} reconciliation unavailable: ${err}`, owner);
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

  const sourcePending = async (): Promise<boolean> => {
    if (!delivery.isSourcePending) return true;
    if (await delivery.isSourcePending()) return true;
    delivery.settled = true;
    settleOpenCodeEntry(delivery.sourceEntryId);
    return false;
  };

  // Before the one allowed POST, retries are safe: no submission has happened.
  // OpenCode must generate the message ID: its run loop treats IDs as
  // lexicographically ordered, so arbitrary caller IDs can persist without
  // ever becoming the active user turn. The unique inbox text correlates the
  // generated message across confirmation and process-replay instead.
  for (let attempt = 0; attempt < OPEN_CODE_DELIVERY_RETRY_DELAYS_MS.length; attempt++) {
    if (delivery.settled) return 'delivered';
    if (state !== owner || !owner.connected) return 'failed';
    if (!(await sourcePending())) return 'delivered';
    if (attempt > 0) {
      delivery.state = 'retried';
      owner.totalEntriesRetried++;
      await waitForDeliveryRetry(attempt);
      if (delivery.settled) return 'delivered';
      if (state !== owner || !owner.connected) return 'failed';
    }

    if (!target) {
      try {
        target = await resolveInjectionSession(owner, delivery.sequence);
      } catch (err) {
        recordOpenCodeFailure(owner, err, delivery.sequence);
        log(`entry ${delivery.entryId} target unavailable: ${err}`, owner);
        continue;
      }
      if (!target) {
        recordOpenCodeFailure(owner, openCodeHttpError(404, 'session'), delivery.sequence);
        log(`entry ${delivery.entryId} target unavailable: no bound session`, owner);
        return 'failed';
      }
      delivery.sessionId = target.id;
    }

    const pendingSubmission = owner.pendingSubmissions.get(delivery.entryId);
    const confirmationSessionId = pendingSubmission?.sessionId ?? target.id;
    delivery.sessionId = confirmationSessionId;

    try {
      const deliveredIdentity = await findInjectedMessage(confirmationSessionId, delivery.entryId) ?? (
        delivery.sourceEntryId === delivery.entryId
          ? null
          : await findInjectedMessage(confirmationSessionId, delivery.sourceEntryId)
      );
      if (deliveredIdentity) {
        log(`entry ${delivery.entryId} already present in session ${confirmationSessionId}`, owner);
        clearPendingSubmission(owner, delivery.entryId);
        return 'delivered';
      }
    } catch (err) {
      recordOpenCodeFailure(owner, err, delivery.sequence);
      log(`entry ${delivery.entryId} confirmation unavailable: ${err}`, owner);
      continue;
    }

    const submittedBefore = pendingSubmission !== undefined;
    if (!delivery.allowSubmit && !submittedBefore) {
      continue;
    }

    if (submittedBefore) {
      delivery.acceptedSubmission = true;
      delivery.state = 'delivered-unconfirmed';
    } else {
      if (delivery.settled) return 'delivered';
      if (!(await sourcePending())) return 'delivered';
      owner.pendingSubmissions.set(delivery.entryId, {
        sourceEntryId: delivery.sourceEntryId,
        sessionId: target.id,
      });
      if (!persistCurrentBinding()) {
        owner.pendingSubmissions.delete(delivery.entryId);
        log(`entry ${delivery.entryId} submission skipped: pending intent was not durable`, owner);
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
        recordOpenCodeFailure(owner, err, delivery.sequence);
        log(`entry ${delivery.entryId} submission outcome unavailable: ${err}`, owner);
      }

      delivery.state = 'delivered-unconfirmed';
      if (status !== null && status !== 200 && status !== 204) {
        recordOpenCodeFailure(owner, openCodeHttpError(status, 'prompt'), delivery.sequence);
        clearPendingSubmission(owner, delivery.entryId);
        if (status === 404) clearBinding();
        return 'failed';
      }
      delivery.acceptedSubmission = true;
      if (status === 200 || status === 204) recordOpenCodeAcceptance(owner, delivery);
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
        if (await findInjectedMessage(delivery.sessionId!, delivery.entryId)) {
          clearPendingSubmission(owner, delivery.entryId);
          return 'delivered';
        }
      } catch (err) {
        recordOpenCodeFailure(owner, err, delivery.sequence);
        log(`entry ${delivery.entryId} post-acceptance confirmation unavailable: ${err}`, owner);
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
      updateLastOpenCodeObservation(owner, delivery.sequence, {
        lastInjectionAt: Date.now(),
        lastInjectionResult: null,
        lastFailureCode: null,
      });
      let outcome: OpenCodeDeliveryOutcome = 'failed';
      try {
        outcome = await deliverOpenCodeEntry(owner, delivery);
      } catch (err) {
        recordOpenCodeFailure(owner, err, delivery.sequence);
        log(`entry ${delivery.entryId} delivery error: ${err}`, owner);
      }
      updateLastOpenCodeObservation(owner, delivery.sequence, {
        lastInjectionResult: outcome,
        lastFailureCode: outcome === 'delivered'
          ? null
          : outcome === 'failed'
            ? (owner.lastObservation.lastFailureCode ?? 'unknown')
            : owner.lastObservation.lastFailureCode,
      });

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
 * this launch's metadata-correlated `--prompt` kickoff. The binding survives
 * the separate MCP-child process, which must never fall back to a newest-session heuristic.
 */
export async function injectInitialKickoff(launch: OpenCodeLaunchKickoff): Promise<boolean> {
  const owner = state;
  if (!owner?.connected) { log('kickoff: not connected', owner); return false; }
  if (!isOpenCode256BitIdentity(launch.correlationIdentity)) {
    log('kickoff: correlation identity missing or unverifiable', owner);
    return false;
  }

  try {
    // Wait for the server.
    let serverReady = false;
    let lastServerError: unknown;
    for (let i = 0; i < 30; i++) {
      try {
        await listSessions();
        if (state !== owner) return false;
        serverReady = true;
        log(`kickoff: server ready (attempt ${i + 1})`, owner);
        break;
      } catch (error) {
        if (state !== owner) return false;
        lastServerError = error;
      }
      if (i < 29) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!serverReady) {
      const observationSequence = ++owner.nextObservationSequence;
      recordOpenCodeFailure(owner, lastServerError, observationSequence);
      const failure = openCodeFailureDiagnostic(lastServerError);
      log(
        `kickoff: server unavailable code=${failure.failureCode} `
        + `class=${failure.errorClass} status=${failure.httpStatus ?? 'none'} attempts=30`,
        owner,
      );
      return false;
    }

    // Capture the launch-selected session, including explicit resume/fork
    // targets. Unrelated sessions do not contain this launch's metadata identity.
    let lastSearchFailure: LaunchSessionSearchFailure | null = null;
    for (let i = 0; i < 30; i++) {
      const result = await findLaunchSession(launch.correlationIdentity);
      if (result.kind === 'superseded') return false;
      if (result.kind === 'found') {
        saveBinding(result.session, result.knownRootSessionIds);
        log(`kickoff: bound session ${result.session.id.slice(0, 8)}…`, owner);
        return true;
      }
      lastSearchFailure = result;
      if (i < 29) await new Promise((r) => setTimeout(r, 1000));
    }

    if (lastSearchFailure) {
      logLaunchSessionSearchFailure(lastSearchFailure, 30, owner);
      if (
        lastSearchFailure.kind === 'directory-miss'
        || lastSearchFailure.kind === 'correlation-mismatch'
      ) {
        updateLastOpenCodeObservation(owner, ++owner.nextObservationSequence, {
          lastFailureCode: 'no-target',
        });
      }
    }
    return false;
  } catch (err) {
    log(`kickoff error: ${err}`, owner);
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
  isSourcePending?: () => Promise<boolean>,
): Promise<boolean> {
  const owner = state;
  if (!owner?.connected) {
    log(`entry ${entryId} rejected: OpenCode is not connected`, owner);
    return Promise.resolve(false);
  }

  // Rehydrate durable source markers before source-level deduplication. A
  // freshly connected MCP child starts with an empty in-memory map; waiting
  // until target resolution would let a different wake nonce queue a second
  // submission before the prior source identity is visible locally.
  restoreBinding();
  const pendingSource = [...owner.pendingSubmissions].find(
    ([pendingEntryId, pending]) =>
      pendingEntryId !== entryId && pending.sourceEntryId === sourceEntryId,
  );
  if (pendingSource) {
    log(`entry ${entryId} reconciles pending source ${sourceEntryId}`, owner);
    return injectOpenCodeEntry(text, pendingSource[0], false, sourceEntryId, isSourcePending);
  }
  for (const [deliveredEntryId, record] of owner.deliveredEntries) {
    if (deliveredEntryId !== entryId && record.sourceEntryId === sourceEntryId) {
      if (record.text !== text) return Promise.resolve(false);
      log(`entry ${entryId} source ${sourceEntryId} already delivered`, owner);
      return Promise.resolve(true);
    }
  }
  for (const [unconfirmedEntryId, record] of owner.unconfirmedEntries) {
    if (unconfirmedEntryId !== entryId && record.sourceEntryId === sourceEntryId) {
      if (record.text !== text) return Promise.resolve(false);
      log(`entry ${entryId} source ${sourceEntryId} remains unconfirmed`, owner);
      return Promise.resolve(true);
    }
  }
  for (const active of owner.activeDeliveries.values()) {
    if (active.entryId !== entryId && active.sourceEntryId === sourceEntryId) {
      if (active.text !== text) return Promise.resolve(false);
      log(`entry ${entryId} joined active source ${sourceEntryId}`, owner);
      return active.promise;
    }
  }

  const delivered = owner.deliveredEntries.get(entryId);
  if (delivered !== undefined) {
    if (delivered.text !== text || delivered.sourceEntryId !== sourceEntryId) {
      log(`entry ${entryId} replay text mismatch`, owner);
      rememberBounded(owner.failedEntries, entryId, text, sourceEntryId);
      return Promise.resolve(false);
    }
    log(`entry ${entryId} replay already delivered`, owner);
    return Promise.resolve(true);
  }

  const unconfirmed = owner.unconfirmedEntries.get(entryId);
  if (unconfirmed !== undefined) {
    if (unconfirmed.text !== text || unconfirmed.sourceEntryId !== sourceEntryId) {
      log(`entry ${entryId} unconfirmed replay text mismatch`, owner);
      rememberBounded(owner.failedEntries, entryId, text, sourceEntryId);
      return Promise.resolve(false);
    }
    log(`entry ${entryId} replay remains unconfirmed`, owner);
    const pending = owner.pendingSubmissions.get(entryId);
    const accepted = pending !== undefined;
    if (pending) {
      scheduleOpenCodeReconciliation(owner, {
        sequence: ++owner.nextObservationSequence,
        entryId,
        sourceEntryId,
        text,
        allowSubmit: false,
        acceptedSubmission: true,
        sessionId: pending.sessionId,
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
      log(`entry ${entryId} active text mismatch`, owner);
      rememberBounded(owner.failedEntries, entryId, text, sourceEntryId);
      return Promise.resolve(false);
    }
    log(`entry ${entryId} replay joined active delivery`, owner);
    return active.promise;
  }

  let resolveDelivery!: (delivered: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolveDelivery = resolve;
  });
  const delivery: OpenCodeDelivery = {
    sequence: ++owner.nextObservationSequence,
    entryId,
    sourceEntryId,
    text,
    allowSubmit,
    acceptedSubmission: false,
    sessionId: null,
    settled: false,
    isSourcePending,
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
  const owner = state;
  if (!owner?.connected) return null;
  const observationSequence = ++owner.nextObservationSequence;
  const binding = restoreBinding();
  if (!binding) return false;

  try {
    const session = await getSession(binding.sessionId);
    if (state !== owner) return null;
    if (session && isBoundSession(session, binding)) return true;
    recordOpenCodeFailure(owner, openCodeHttpError(404, 'session'), observationSequence);
    clearBinding();
    return false;
  } catch (error) {
    if (state === owner) recordOpenCodeFailure(owner, error, observationSequence);
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
  lastInjectionAt: number | null;
  lastInjectionResult: OpenCodeInjectionResult | null;
  lastAcceptedEntryId: string | null;
  lastFailureCode: string | null;
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
    lastInjectionAt: state?.lastObservation.lastInjectionAt ?? null,
    lastInjectionResult: state?.lastObservation.lastInjectionResult ?? null,
    lastAcceptedEntryId: state?.lastObservation.lastAcceptedEntryId ?? null,
    lastFailureCode: state?.lastObservation.lastFailureCode ?? null,
    deliveryStates,
  };
}

export function __getOpenCodeDiagnosticLogPathForTests(): string {
  if (!state) throw new Error('OpenCode drone is not connected');
  return diagnosticLogPath(state);
}

export function __getOpenCodeBindingPathForTests(): string {
  if (!state) throw new Error('OpenCode drone is not connected');
  return bindingPath();
}

export function __getOpenCodeLastObservationForTests(): OpenCodeLastObservation {
  if (!state) throw new Error('OpenCode drone is not connected');
  return { ...state.lastObservation };
}

export function __decodeOpenCodeSessionForTests(value: unknown): unknown {
  return decodeSession(value);
}

export async function __listOpenCodeSessionsForTests(): Promise<unknown[]> {
  return listSessions();
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
  for (const path of diagnosticLogPathsForTests) {
    try {
      unlinkSync(path);
    } catch {
      // Already removed.
    }
  }
  diagnosticLogPathsForTests.clear();
}
