import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { borgConfigRoot } from './private-root.js';
const STATE_FILE = join(borgConfigRoot(), 'lifecycle-log-state.json');
const UNKNOWN_SESSION = { kind: 'unknown', reason: 'identity-not-resolved' };
const UNREADABLE_STATE = Symbol('unreadable-lifecycle-state');
function unreadableStateError() {
    return new Error(`Lifecycle log state is unreadable; refusing to overwrite it: ${STATE_FILE}`);
}
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
        if (err?.code === 'ENOENT')
            return { entries: {} };
        return UNREADABLE_STATE;
    }
    return UNREADABLE_STATE;
}
async function writeState(state) {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
export function shouldSuppressLifecycleLogFromState(message, state, identity = UNKNOWN_SESSION) {
    const signal = lifecycleSignalForMessage(message);
    if (!signal)
        return { suppress: false, signal: null };
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
export async function shouldSuppressLifecycleLog(subject, message, identity = UNKNOWN_SESSION) {
    const state = await readState();
    if (state === UNREADABLE_STATE)
        throw unreadableStateError();
    return shouldSuppressLifecycleLogFromState(message, state.entries[stateKey(subject)], identity);
}
export function nextLifecycleStateAfterLog(message, current, nowIso = new Date().toISOString(), identity = UNKNOWN_SESSION) {
    const signal = lifecycleSignalForMessage(message);
    if (signal === 'arrival') {
        if (identity.kind === 'unknown' || current?.arrivedSessionIds?.includes(identity.id))
            return current ?? {};
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
export async function recordLifecycleLog(subject, message, identity = UNKNOWN_SESSION) {
    const state = await readState();
    if (state === UNREADABLE_STATE)
        throw unreadableStateError();
    const key = stateKey(subject);
    state.entries[key] = nextLifecycleStateAfterLog(message, state.entries[key], undefined, identity);
    await writeState(state);
}
//# sourceMappingURL=lifecycle-log-guard.js.map