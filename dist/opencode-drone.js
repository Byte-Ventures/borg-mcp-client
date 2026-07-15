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
export async function connectOpenCodeDrone(deps) {
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
    try {
        const { status, body } = await rawGet(`/session/${id}`);
        if (status !== 200)
            return null;
        return JSON.parse(body);
    }
    catch {
        return null;
    }
}
async function listSessionMessages(id) {
    const { status, body } = await rawGet(`/session/${id}/message`);
    if (status !== 200)
        throw new Error(`OpenCode session messages request failed (${status})`);
    return JSON.parse(body);
}
async function promptSession(id, bodyObj) {
    const { status } = await rawPost(`/session/${id}/prompt_async`, bodyObj);
    return status === 200 || status === 204;
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
async function rebindAfterFailure(knownRootSessionIds) {
    const replacement = await findUnseenTopLevelSession(knownRootSessionIds);
    if (!replacement)
        return null;
    saveBinding(replacement.session, replacement.knownRootSessionIds);
    return replacement.session;
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
 * Inject a silent context entry (noReply) into our session.
 * Falls through silently — caller falls back to inbox write.
 */
export async function injectOpenCodeEntry(text) {
    if (!state?.connected)
        return false;
    try {
        const target = await resolveInjectionSession();
        if (!target)
            return false;
        const body = {
            parts: [{ type: 'text', text }],
        };
        if (await promptSession(target.id, body)) {
            state.totalEntriesInjected++;
            return true;
        }
        // A failed prompt means the cached target is no longer trustworthy. Clear
        // it before considering only a newer root created by `/new`; never fall
        // through to a child or arbitrary newest session.
        const knownRootSessionIds = [...state.knownRootSessionIds];
        clearBinding();
        const replacement = await rebindAfterFailure(knownRootSessionIds);
        if (!replacement)
            return false;
        if (await promptSession(replacement.id, body)) {
            state.totalEntriesInjected++;
            return true;
        }
        clearBinding();
        return false;
    }
    catch (err) {
        log(`entry error: ${err}`);
        clearBinding();
        return false;
    }
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
        clearBinding();
        return false;
    }
}
export function disconnectOpenCodeDrone() {
    state = null;
}
export function getOpenCodeConnectionState() {
    return {
        connected: state?.connected ?? false,
        sessionId: state?.sessionId ?? null,
        totalEntriesInjected: state?.totalEntriesInjected ?? 0,
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