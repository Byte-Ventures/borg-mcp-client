import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCodeExecutableChangedError } from './opencode-installation.js';
import { openCodePrivateRoot } from './opencode-private-state.js';
import { withOpenCodeV2Startup } from './opencode-v2-startup.js';
import { startOpenCodeV2Server, OpenCodeV2ServerStartError } from './opencode-v2-server.js';
const failed = () => new Error('OpenCode 2 startup supervisor stopped unexpectedly. No kickoff was submitted.');
function decodeFailure(kind) {
    if (kind === 'changed')
        return new OpenCodeExecutableChangedError();
    if (kind === 'startup')
        return failed();
    if (kind === 'queue-timeout')
        return new Error('Timed out waiting for another Borg OpenCode 2 session to finish startup. No kickoff was submitted.');
    return new OpenCodeV2ServerStartError(kind);
}
/** The supervisor owns both the mutex and the native process. Losing Borg's
 * IPC connection closes the native host BEFORE releasing startup exclusion.
 * After successful bootstrap, only the native process lease stays alive.
 * Credentials travel exclusively over the private parent/child IPC channel.
 */
export async function withOpenCodeV2StartupHost(operation, options = {}) {
    const child = spawn(process.execPath, [fileURLToPath(options.worker ?? new URL(import.meta.url)), options.root ?? openCodePrivateRoot(), String(options.waitMs ?? 300_000)], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: true,
    });
    const pending = new Map();
    let next = 0;
    let ready;
    let notReady;
    const acquired = new Promise((resolve, reject) => { ready = resolve; notReady = reject; });
    let serverClosed;
    let stopped = false;
    const stop = () => {
        if (stopped)
            return;
        stopped = true;
        notReady(failed());
        serverClosed?.();
        for (const request of pending.values())
            request.reject(failed());
        pending.clear();
    };
    child.on('error', stop);
    child.on('exit', stop);
    child.on('disconnect', stop);
    child.on('message', (message) => {
        if (message.type === 'acquired')
            ready();
        else if (message.type === 'queued')
            options.onQueued?.();
        else if (message.type === 'server-closed')
            serverClosed?.();
        else if (message.type === 'failed')
            notReady(decodeFailure(message.failure ?? 'startup'));
        else if (message.type === 'reply') {
            const request = pending.get(message.id);
            pending.delete(message.id);
            if (message.failure)
                request?.reject(decodeFailure(message.failure));
            else
                request?.resolve(message);
        }
    });
    const request = (type, serverOptions) => new Promise((resolve, reject) => {
        if (stopped || !child.connected) {
            reject(failed());
            return;
        }
        const id = ++next;
        pending.set(id, { resolve, reject });
        child.send({ id, type, options: serverOptions }, error => { if (error)
            stop(); });
    });
    let hosting = false;
    let acquiredLock = false;
    let completed = false;
    const host = {
        async startServer(serverOptions) {
            if (hosting)
                throw new Error('OpenCode startup supervisor already owns a server.');
            let closed;
            let endedAlready = false;
            const ended = new Promise(resolve => { closed = () => { endedAlready = true; resolve(); }; });
            serverClosed = closed;
            const reply = await request('start', serverOptions);
            const server = reply.server;
            hosting = true;
            let closing;
            return {
                url: server.url, pid: server.pid, version: server.version,
                headers: () => ({ ...server.headers }), tuiEnv: () => ({ ...server.env }), closed: ended,
                close: () => closing ??= (async () => {
                    try {
                        if (!endedAlready && !stopped)
                            await request('close');
                    }
                    finally {
                        hosting = false;
                        closed();
                    }
                })(),
            };
        },
    };
    try {
        await acquired;
        acquiredLock = true;
        const result = await operation(host);
        completed = true;
        return result;
    }
    finally {
        // Never kill the supervisor here: it must reap any starting native child
        // even if the caller failed or disconnected before receiving its identity.
        try {
            if (acquiredLock && !stopped) {
                if (!completed) {
                    await request('close');
                    hosting = false;
                }
                await request('release');
            }
        }
        finally {
            if (!hosting && child.connected)
                child.disconnect();
        }
    }
}
/** Exported for a process fixture which supplies a controlled native server. */
export async function runOpenCodeV2StartupHost(startServer = startOpenCodeV2Server) {
    const [root, rawWait] = process.argv.slice(2);
    const owner = new AbortController();
    let server;
    let released = false;
    let closingServer = false;
    let releaseReply;
    let unlock;
    const release = new Promise(resolve => { unlock = resolve; });
    let tail = Promise.resolve();
    const send = (message) => { if (process.connected)
        process.send?.(message, () => { }); };
    const disconnect = () => { if (process.connected)
        process.disconnect(); };
    const closeServer = async () => {
        closingServer = true;
        try {
            await server?.close();
            server = undefined;
        }
        finally {
            closingServer = false;
        }
    };
    let shuttingDown;
    const shutdown = () => shuttingDown ??= (async () => {
        owner.abort();
        // tail includes a pending start, whose own timeout and cleanup are bounded.
        try {
            await tail;
            await closeServer();
        }
        finally {
            unlock();
            disconnect();
        }
    })();
    process.once('disconnect', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
    // IPC can close before this module finishes loading and installs listeners.
    if (!process.connected)
        void shutdown();
    try {
        await withOpenCodeV2Startup(async () => {
            send({ type: 'acquired' });
            process.on('message', (command) => {
                tail = tail.then(async () => {
                    if (owner.signal.aborted)
                        return;
                    try {
                        if (command.type === 'start') {
                            if (server || released)
                                throw failed();
                            server = await startServer({ ...command.options, signal: owner.signal });
                            const current = server;
                            void current.closed.then(() => {
                                if (server === current)
                                    server = undefined;
                                send({ type: 'server-closed' });
                                if (released && !closingServer)
                                    disconnect();
                            });
                            send({ type: 'reply', id: command.id, server: { url: server.url, pid: server.pid, version: server.version,
                                    headers: server.headers(), env: server.tuiEnv() } });
                        }
                        else if (command.type === 'close') {
                            await closeServer();
                            send({ type: 'reply', id: command.id });
                            if (released)
                                disconnect();
                        }
                        else if (command.type === 'release') {
                            released = true;
                            unlock();
                            // Reply only after the SQLite transaction is actually released.
                            releaseReply = command.id;
                        }
                    }
                    catch (error) {
                        const failure = error instanceof OpenCodeExecutableChangedError ? 'changed'
                            : error instanceof OpenCodeV2ServerStartError ? error.reason : 'startup';
                        send({ type: 'reply', id: command.id, failure });
                    }
                });
            });
            await release;
        }, { root, waitMs: Number(rawWait), signal: owner.signal, onQueued: () => send({ type: 'queued' }) });
        if (releaseReply !== undefined)
            send({ type: 'reply', id: releaseReply });
        if (!server || owner.signal.aborted)
            disconnect();
    }
    catch (error) {
        await closeServer();
        const failure = error instanceof Error && error.message.startsWith('Timed out waiting for another Borg OpenCode 2') ? 'queue-timeout' : 'startup';
        send({ type: 'failed', failure });
        disconnect();
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void runOpenCodeV2StartupHost().catch(() => { process.exitCode = 1; });
}
//# sourceMappingURL=opencode-v2-startup-host.js.map