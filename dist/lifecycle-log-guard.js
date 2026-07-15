import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
const STATE_FILE = join(homedir(), '.config', 'borgmcp', 'lifecycle-log-state.json');
const ARRIVAL_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
export function lifecycleSignalForMessage(message) {
    if (message.startsWith('ARRIVAL: '))
        return 'arrival';
    if (message.startsWith('READY: ') &&
        message.includes('capacity clean') &&
        message.includes('awaiting next dispatch')) {
        return 'ready';
    }
    return null;
}
function stateKey(subject) {
    return `${subject.cubeId}:${subject.droneId}`;
}
async function readState() {
    try {
        const raw = await readFile(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed &&
            typeof parsed === 'object' &&
            parsed.entries &&
            typeof parsed.entries === 'object' &&
            !Array.isArray(parsed.entries)) {
            return parsed;
        }
    }
    catch (err) {
        if (err?.code !== 'ENOENT')
            throw err;
    }
    return { entries: {} };
}
async function writeState(state) {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
export function shouldSuppressLifecycleLogFromState(message, state, nowMs = Date.now()) {
    const signal = lifecycleSignalForMessage(message);
    if (!signal)
        return { suppress: false, signal: null };
    if (signal === 'arrival') {
        const lastArrivalAt = state?.lastArrival?.at
            ? new Date(state.lastArrival.at).getTime()
            : NaN;
        const isRecent = Number.isFinite(lastArrivalAt) &&
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
export async function shouldSuppressLifecycleLog(subject, message) {
    const state = await readState();
    return shouldSuppressLifecycleLogFromState(message, state.entries[stateKey(subject)]);
}
export function nextLifecycleStateAfterLog(message, current, nowIso = new Date().toISOString()) {
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
export async function recordLifecycleLog(subject, message) {
    const state = await readState();
    const key = stateKey(subject);
    state.entries[key] = nextLifecycleStateAfterLog(message, state.entries[key]);
    await writeState(state);
}
//# sourceMappingURL=lifecycle-log-guard.js.map