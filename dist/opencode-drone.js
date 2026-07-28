import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
const LOG_FILE = join(tmpdir(), 'borg-opencode-drone.log');
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        appendFileSync(LOG_FILE, line);
    }
    catch { }
}
let state = null;
const OPEN_CODE_DELIVERY_RETRY_DELAYS_MS = [0, 250, 1_000, 3_000];
const OPEN_CODE_DELIVERY_HISTORY_LIMIT = 256;
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
export function createOpenCodeLaunchKickoff(kickoff, nonce = randomUUID()) {
    return {
        prompt: `${kickoff}\n\n<!-- ${OPEN_CODE_LAUNCH_NONCE_MARKER}${nonce} -->`,
        nonce,
    };
}
const bindingPathsForTests = new Set();
function abandonOpenCodeDeliveries(current) {
    if (!current)
        return;
    current.connected = false;
    for (const delivery of current.activeDeliveries.values()) {
        delivery.resolve(false);
    }
    current.activeDeliveries.clear();
    current.deliveryQueue.length = 0;
}
export async function connectOpenCodeDrone(deps) {
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
        failedEntries: new Map(),
        processingDeliveries: false,
    };
    log(`connected url=${deps.serverUrl} dir=${deps.directory}`);
}
// ---------------------------------------------------------------------------
// Raw fetch wrappers
// ---------------------------------------------------------------------------
function apiUrl(path) {
    const base = state.serverUrl.replace(/\/+$/, '');
    return `${base}${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(state.directory)}`;
}
const FETCH_TIMEOUT = 10_000;
async function rawGet(path) {
    const url = apiUrl(path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
        const res = await fetch(url, { signal: controller.signal });
        const body = await res.text();
        return { status: res.status, body };
    }
    finally {
        clearTimeout(timer);
    }
}
async function rawPost(path, bodyObj) {
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
    }
    finally {
        clearTimeout(timer);
    }
}
async function listSessions() {
    const { status, body } = await rawGet('/session');
    if (status !== 200)
        throw new Error(`OpenCode sessions request failed (${status})`);
    return JSON.parse(body);
}
async function getSession(id) {
    const { status, body } = await rawGet(`/session/${id}`);
    if (status === 404)
        return null;
    if (status !== 200)
        throw new Error(`OpenCode session request failed (${status})`);
    return JSON.parse(body);
}
async function listSessionMessages(id) {
    const { status, body } = await rawGet(`/session/${id}/message`);
    if (status !== 200)
        throw new Error(`OpenCode session messages request failed (${status})`);
    return JSON.parse(body);
}
async function getSessionMessage(sessionId, messageId) {
    const { status, body } = await rawGet(`/session/${sessionId}/message/${encodeURIComponent(messageId)}`);
    if (status === 404)
        return 'missing';
    if (status !== 200) {
        throw new Error(`OpenCode message request failed (${status})`);
    }
    const message = JSON.parse(body);
    if (message.info?.id !== messageId || message.info.role !== 'user') {
        throw new Error('OpenCode returned the wrong injected message');
    }
    return 'found';
}
async function promptSession(id, bodyObj) {
    const { status } = await rawPost(`/session/${id}/prompt_async`, bodyObj);
    return status;
}
// ---------------------------------------------------------------------------
// Persist the launch-selected session for the separately spawned MCP child.
// ---------------------------------------------------------------------------
function bindingPath() {
    const current = state;
    const key = [current.serverUrl, current.directory, current.cubeName, current.droneLabel].join('\0');
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 24);
    const path = join(tmpdir(), `borg-opencode-session-${digest}.json`);
    bindingPathsForTests.add(path);
    return path;
}
function bindingMatchesState(binding) {
    const current = state;
    return binding.version === 2
        && binding.serverUrl === current.serverUrl
        && binding.directory === current.directory
        && binding.droneLabel === current.droneLabel
        && binding.cubeName === current.cubeName
        && typeof binding.sessionId === 'string'
        && typeof binding.sessionCreatedAt === 'number'
        && Array.isArray(binding.knownRootSessionIds)
        && binding.knownRootSessionIds.every((id) => typeof id === 'string');
}
function readBinding() {
    try {
        const path = bindingPath();
        if (!existsSync(path))
            return null;
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        return bindingMatchesState(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function clearBinding() {
    if (!state)
        return;
    const path = bindingPath();
    state.sessionId = null;
    state.sessionCreatedAt = null;
    state.knownRootSessionIds = [];
    try {
        unlinkSync(path);
    }
    catch {
        // The file may have already been removed by the launch process.
    }
}
function saveBinding(session, knownRootSessionIds) {
    const current = state;
    const binding = {
        version: 2,
        sessionId: session.id,
        sessionCreatedAt: session.time.created,
        knownRootSessionIds,
        serverUrl: current.serverUrl,
        directory: current.directory,
        droneLabel: current.droneLabel,
        cubeName: current.cubeName,
    };
    current.sessionId = binding.sessionId;
    current.sessionCreatedAt = binding.sessionCreatedAt;
    current.knownRootSessionIds = binding.knownRootSessionIds;
    try {
        const path = bindingPath();
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(binding), { mode: 0o600 });
        renameSync(temporary, path);
    }
    catch (err) {
        log(`session binding write failed: ${err}`);
    }
}
function restoreBinding() {
    if (!state)
        return null;
    if (state.sessionId && state.sessionCreatedAt !== null) {
        return {
            version: 2,
            sessionId: state.sessionId,
            sessionCreatedAt: state.sessionCreatedAt,
            knownRootSessionIds: state.knownRootSessionIds,
            serverUrl: state.serverUrl,
            directory: state.directory,
            droneLabel: state.droneLabel,
            cubeName: state.cubeName,
        };
    }
    const binding = readBinding();
    if (!binding)
        return null;
    state.sessionId = binding.sessionId;
    state.sessionCreatedAt = binding.sessionCreatedAt;
    state.knownRootSessionIds = binding.knownRootSessionIds;
    return binding;
}
function isBoundSession(session, binding) {
    return session.id === binding.sessionId && session.directory === state.directory;
}
function isTopLevelSession(session) {
    return !session.parentID;
}
async function findUnseenTopLevelSession(knownRootSessionIds) {
    try {
        const sessions = await listSessions();
        const roots = sessions.filter((session) => session.directory === state.directory
            && isTopLevelSession(session));
        const matched = roots.filter((session) => !knownRootSessionIds.includes(session.id));
        if (matched.length === 0)
            return null;
        const best = matched.reduce((a, b) => a.time.created > b.time.created ? a : b);
        return { session: best, knownRootSessionIds: roots.map((session) => session.id) };
    }
    catch {
        return null;
    }
}
function kickoffMessageTime(messages, nonce) {
    let latest = null;
    for (const message of messages) {
        if (message.info?.role && message.info.role !== 'user')
            continue;
        const matchesLaunchNonce = message.parts?.some((part) => part.type === 'text' && part.text?.includes(`${OPEN_CODE_LAUNCH_NONCE_MARKER}${nonce}`));
        if (!matchesLaunchNonce)
            continue;
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
async function findLaunchSession(nonce) {
    try {
        const sessions = (await listSessions()).filter((session) => session.directory === state.directory);
        const knownRootSessionIds = sessions
            .filter(isTopLevelSession)
            .map((session) => session.id);
        const candidates = await Promise.all(sessions.map(async (session) => {
            try {
                const messageTime = kickoffMessageTime(await listSessionMessages(session.id), nonce);
                return messageTime === null ? null : { session, messageTime };
            }
            catch {
                return null;
            }
        }));
        const matched = candidates.filter((candidate) => candidate !== null);
        if (matched.length === 0)
            return null;
        const session = matched.reduce((best, candidate) => candidate.messageTime > best.messageTime ? candidate : best).session;
        return { session, knownRootSessionIds };
    }
    catch {
        return null;
    }
}
async function resolveInjectionSession() {
    const binding = restoreBinding();
    if (!binding)
        return null;
    const bound = await getSession(binding.sessionId);
    if (!bound || !isBoundSession(bound, binding)) {
        clearBinding();
        const replacement = await findUnseenTopLevelSession(binding.knownRootSessionIds);
        if (!replacement)
            return null;
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
function openCodeMessageId(entryId) {
    const digest = createHash('sha256').update(entryId).digest('hex');
    return `msg_borg_${digest}`;
}
function rememberBounded(entries, entryId, text) {
    entries.delete(entryId);
    entries.set(entryId, text);
    while (entries.size > OPEN_CODE_DELIVERY_HISTORY_LIMIT) {
        const oldest = entries.keys().next().value;
        if (typeof oldest !== 'string')
            break;
        entries.delete(oldest);
    }
}
function waitForDeliveryRetry(attempt) {
    const delay = OPEN_CODE_DELIVERY_RETRY_DELAYS_MS[attempt] ?? 0;
    return delay > 0
        ? new Promise((resolve) => setTimeout(resolve, delay))
        : Promise.resolve();
}
async function deliverOpenCodeEntry(owner, delivery) {
    let target = null;
    for (let attempt = 0; attempt < OPEN_CODE_DELIVERY_RETRY_DELAYS_MS.length; attempt++) {
        if (state !== owner || !owner.connected)
            return false;
        if (attempt > 0) {
            delivery.state = 'retried';
            owner.totalEntriesRetried++;
            await waitForDeliveryRetry(attempt);
            if (state !== owner || !owner.connected)
                return false;
        }
        if (!target) {
            try {
                target = await resolveInjectionSession();
            }
            catch (err) {
                log(`entry ${delivery.entryId} target unavailable: ${err}`);
                continue;
            }
            if (!target)
                return false;
        }
        // A retry first asks whether the prior ambiguous submission persisted.
        // Never submit again while that answer is unknown: a lost HTTP response
        // may still have created the message and re-posting could run it twice.
        try {
            if (await getSessionMessage(target.id, delivery.messageId) === 'found') {
                return true;
            }
        }
        catch (err) {
            log(`entry ${delivery.entryId} confirmation unavailable: ${err}`);
            continue;
        }
        let status;
        try {
            status = await promptSession(target.id, {
                messageID: delivery.messageId,
                parts: [{ type: 'text', text: delivery.text }],
            });
        }
        catch (err) {
            log(`entry ${delivery.entryId} submission unavailable: ${err}`);
            continue;
        }
        if (status !== 200 && status !== 204) {
            if (status === 404) {
                clearBinding();
                return false;
            }
            continue;
        }
        delivery.state = 'delivered-unconfirmed';
        try {
            if (await getSessionMessage(target.id, delivery.messageId) === 'found') {
                return true;
            }
        }
        catch (err) {
            log(`entry ${delivery.entryId} post-acceptance confirmation unavailable: ${err}`);
        }
    }
    return false;
}
async function processOpenCodeDeliveries(owner) {
    if (owner.processingDeliveries)
        return;
    owner.processingDeliveries = true;
    try {
        while (state === owner && owner.deliveryQueue.length > 0) {
            const delivery = owner.deliveryQueue.shift();
            let delivered = false;
            try {
                delivered = await deliverOpenCodeEntry(owner, delivery);
            }
            catch (err) {
                log(`entry ${delivery.entryId} delivery error: ${err}`);
            }
            owner.activeDeliveries.delete(delivery.entryId);
            if (delivered) {
                owner.failedEntries.delete(delivery.entryId);
                rememberBounded(owner.deliveredEntries, delivery.entryId, delivery.text);
                owner.totalEntriesInjected++;
            }
            else {
                rememberBounded(owner.failedEntries, delivery.entryId, delivery.text);
            }
            delivery.resolve(delivered);
        }
    }
    finally {
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
export async function injectInitialKickoff(launch) {
    if (!state?.connected) {
        log('kickoff: not connected');
        return false;
    }
    try {
        // Wait for the server.
        for (let i = 0; i < 30; i++) {
            try {
                await listSessions();
                log(`kickoff: server ready (attempt ${i + 1})`);
                break;
            }
            catch {
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
    }
    catch (err) {
        log(`kickoff error: ${err}`);
        return false;
    }
}
/**
 * Queue one durable inbox entry for delivery into the bound OpenCode session.
 * The SSE entry ID becomes a stable OpenCode message ID, so retries and replay
 * can confirm an earlier ambiguous submission without running it twice.
 */
export function injectOpenCodeEntry(text, entryId = createHash('sha256').update(text).digest('hex')) {
    const owner = state;
    if (!owner?.connected)
        return Promise.resolve(false);
    const deliveredText = owner.deliveredEntries.get(entryId);
    if (deliveredText !== undefined) {
        if (deliveredText !== text) {
            log(`entry ${entryId} replay text mismatch`);
            rememberBounded(owner.failedEntries, entryId, text);
            return Promise.resolve(false);
        }
        return Promise.resolve(true);
    }
    const active = owner.activeDeliveries.get(entryId);
    if (active) {
        if (active.text !== text) {
            log(`entry ${entryId} active text mismatch`);
            rememberBounded(owner.failedEntries, entryId, text);
            return Promise.resolve(false);
        }
        return active.promise;
    }
    let resolveDelivery;
    const promise = new Promise((resolve) => {
        resolveDelivery = resolve;
    });
    const delivery = {
        entryId,
        text,
        messageId: openCodeMessageId(entryId),
        state: 'queued',
        resolve: resolveDelivery,
        promise,
    };
    owner.failedEntries.delete(entryId);
    owner.activeDeliveries.set(entryId, delivery);
    owner.deliveryQueue.push(delivery);
    void processOpenCodeDeliveries(owner);
    return promise;
}
export async function probeOpenCodeDroneArmed() {
    if (!state?.connected)
        return null;
    const binding = restoreBinding();
    if (!binding)
        return false;
    try {
        const session = await getSession(binding.sessionId);
        if (session && isBoundSession(session, binding))
            return true;
        clearBinding();
        return false;
    }
    catch {
        return false;
    }
}
export function disconnectOpenCodeDrone() {
    abandonOpenCodeDeliveries(state);
    state = null;
}
export function getOpenCodeConnectionState() {
    const deliveryStates = {
        queued: 0,
        'delivered-unconfirmed': 0,
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
export function computeOpenCodePort(droneId, base = 14096) {
    let hash = 0;
    for (let i = 0; i < droneId.length; i++) {
        const char = droneId.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return base + (Math.abs(hash) % 1024);
}
/** Test-only cleanup for module state and the local cross-process binding. */
export function __resetOpenCodeDroneForTests() {
    abandonOpenCodeDeliveries(state);
    state = null;
    for (const path of bindingPathsForTests) {
        try {
            unlinkSync(path);
        }
        catch {
            // Already removed.
        }
    }
    bindingPathsForTests.clear();
}
//# sourceMappingURL=opencode-drone.js.map