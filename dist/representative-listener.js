/** Supervised body-free wake channel; independent of the lazy MCP tools lease. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { borgConfigRoot } from './private-root.js';
import { acquireStreamLease, readOwnershipSnapshot, STREAM_OWNER_STALE_MS } from './stream-owner.js';
import { representativeOwnerDeps } from './representative-owner.js';
import { createListenerInbox } from './representative-listener-store.js';
import { streamOnce, streamReconnectDelay } from './log-stream.js';
import { resolveRepresentativeContext } from './representative-cmd.js';
import { DroneEvictedError, CubeDeletedError } from './drone-lifecycle.js';
import { BorgServerTrustError, BorgServerUnreachableError } from './server-errors.js';
import { isTransportFailure } from './seat-probe.js';
import { readBorgServerTrustIdentity } from './server-trust.js';
import { RepresentativeError, verifyLiveBinding } from './representative-core.js';
function listenerOwnerDeps(binding) {
    const authority = createHash('sha256').update(JSON.stringify([binding.origin, binding.trustIdentity])).digest('hex');
    return { ...representativeOwnerDeps(binding), locksDir: join(borgConfigRoot(), 'representative-listener-locks', authority) };
}
export async function representativeListenerStatus(binding) {
    const ownership = await readOwnershipSnapshot(binding.cubeId, binding.representativeDroneId, listenerOwnerDeps(binding));
    let alive = false;
    if (ownership.pid) {
        try {
            process.kill(ownership.pid, 0);
            alive = true;
        }
        catch (error) {
            alive = error.code === 'EPERM';
        }
    }
    return { ...ownership, running: alive && (ownership.ageMs ?? Infinity) <= STREAM_OWNER_STALE_MS,
        ...await createListenerInbox(binding).snapshot() };
}
function codeOf(error) {
    if (error instanceof DroneEvictedError)
        return 'DRONE_EVICTED';
    if (error instanceof CubeDeletedError)
        return 'CUBE_DELETED';
    if (error instanceof BorgServerTrustError)
        return 'TRUST_CHANGED';
    return typeof error?.code === 'string' ? error.code : 'LISTENER_ERROR';
}
function terminalReason(error) {
    const code = codeOf(error);
    if (code === 'DRONE_EVICTED' || code === 'CUBE_DELETED' || code === 'SEAT_UNAVAILABLE')
        return 'evicted';
    if (code === 'BINDING_MISMATCH' || code === 'COORDINATOR_UNAVAILABLE')
        return 'rebound';
    if (code.includes('TRUST'))
        return 'trust-changed';
    if (['SESSION_REVOKED', 'SESSION_REJECTED', 'CREDENTIAL_REJECTED'].includes(code))
        return 'revoked';
    return undefined;
}
export async function runListener(command, deps, options = {}) {
    const emit = async (event) => {
        deps.stdout(JSON.stringify(event) + '\n');
        // The command exits after its final event; wait for the pipe to flush.
        await new Promise((resolve, reject) => process.stdout.write('', error => error ? reject(error) : resolve()));
    };
    let lease = null;
    let timer;
    let started = false, reason, active;
    const abort = new AbortController();
    let pending = Promise.resolve();
    const serial = (fn) => {
        const result = pending.then(fn);
        pending = result.catch(() => { });
        return result;
    };
    const stop = (why) => { reason ??= why; abort.abort(); };
    const signal = () => stop('signal');
    let outputBroken = false;
    const outputError = () => { outputBroken = true; reason = 'fatal'; abort.abort(); };
    process.stdout.on('error', outputError);
    const exitCode = () => reason === 'signal' ? 0 : reason === 'fatal' ? 1 : 4;
    try {
        let worktree = command.worktree ?? deps.cwd();
        try {
            worktree = realpathSync(worktree);
        }
        catch { /* resolve refuses missing bindings */ }
        worktree = deps.findProjectRoot(worktree);
        const ctx = await resolveRepresentativeContext(worktree, deps);
        // Only this server step maps transport failures to SERVER_UNREACHABLE; typed
        // rejections keep their binding codes and storage keeps STORAGE_REFUSED.
        await verifyLiveBinding(ctx).catch((error) => {
            throw isTransportFailure(error) && !(error instanceof BorgServerUnreachableError)
                ? new BorgServerUnreachableError('Borg server unreachable during startup verification', { cause: error }) : error;
        });
        const binding = ctx.binding;
        active = (await deps.hydrateSeat(worktree));
        const ownerDeps = listenerOwnerDeps(binding);
        lease = await acquireStreamLease(binding.cubeId, binding.representativeDroneId, STREAM_OWNER_STALE_MS, ownerDeps);
        if (!lease) {
            const owner = await readOwnershipSnapshot(binding.cubeId, binding.representativeDroneId, ownerDeps);
            await emit({ event: 'refused', code: 'REPRESENTATIVE_LISTENER_OWNED', exit_code: 3,
                owner_pid: owner.pid ?? null, owner_started_at: owner.startedAt ?? null });
            return 3;
        }
        const guard = async () => {
            if (abort.signal.aborted)
                throw new Error('listener stopped');
            const current = await deps.store.getBinding(worktree);
            if (!current || JSON.stringify([current.origin, current.trustIdentity, current.cubeId, current.representativeDroneId, current.coordinatorDroneId, current.boundAt]) !==
                JSON.stringify([binding.origin, binding.trustIdentity, binding.cubeId, binding.representativeDroneId, binding.coordinatorDroneId, binding.boundAt])) {
                stop('rebound');
                throw new RepresentativeError('BINDING_MISMATCH', 'Representative binding changed');
            }
            const saved = await deps.hydrateSeat(worktree);
            if (!saved) {
                stop('revoked');
                throw new RepresentativeError('SEAT_UNAVAILABLE', 'Representative seat unavailable');
            }
            if (saved.serverTrustIdentity !== binding.trustIdentity) {
                stop('trust-changed');
                throw new BorgServerTrustError('Representative trust changed');
            }
            if (saved.cubeId !== binding.cubeId || saved.droneId !== binding.representativeDroneId || saved.apiUrl !== binding.origin) {
                stop('rebound');
                throw new RepresentativeError('BINDING_MISMATCH', 'Representative seat changed');
            }
            // Recheck authority trust while the stream stays open, not only on reconnect.
            // Controlled transports may omit trust loading; production never does.
            if (!options.streamDeps?.fetchImpl || options.streamDeps.loadTrust) {
                try {
                    // Read fresh: the loader's local-authority cache never observes a change.
                    const identity = options.streamDeps?.loadTrust
                        ? (await options.streamDeps.loadTrust(binding.origin)).identity
                        : await readBorgServerTrustIdentity(binding.origin);
                    if (identity !== binding.trustIdentity)
                        throw new BorgServerTrustError('Representative authority trust changed');
                }
                catch (error) {
                    stop('trust-changed');
                    throw error;
                }
            }
            const observed = await readOwnershipSnapshot(binding.cubeId, binding.representativeDroneId, ownerDeps);
            if (observed.processNonce !== lease.record.processNonce) {
                stop('lease-lost');
                throw new Error('Listener ownership lost');
            }
        };
        const inbox = createListenerInbox(binding, guard);
        await inbox.snapshot(); // refuse unsafe persisted paths before emitting listening
        process.once('SIGTERM', signal);
        process.once('SIGINT', signal);
        timer = setInterval(() => {
            void serial(async () => { await guard(); if (!await lease.refresh())
                stop('lease-lost'); }).catch(error => { if (!reason)
                stop(terminalReason(error) ?? 'lease-lost'); });
        }, options.heartbeatIntervalMs ?? 20_000);
        let attempt = 0;
        let consumerFailure;
        let pendingGap;
        // Failures of the listener's own guard, storage and output are fatal; every
        // other non-terminal stream failure is transport and reconnects, as in the
        // ordinary stream loop (pinned HTTPS surfaces raw errno/string codes).
        const local = (fn) => async (...args) => {
            try {
                return await fn(...args);
            }
            catch (error) {
                consumerFailure ??= error;
                throw error;
            }
        };
        while (!reason) {
            const resumed = await inbox.cursor();
            try {
                consumerFailure = undefined;
                await local(() => serial(guard))();
                await streamOnce(active, resumed?.id ?? null, () => { }, {
                    ...options.streamDeps, getCursor: local(async () => inbox.cursor()), abortSignal: abort.signal,
                    consumer: {
                        catchupCursor: await local(() => inbox.dedupeCursor())(),
                        beforeEvent: local(() => serial(guard)),
                        clearCursor: local(() => serial(async () => {
                            const previous = await inbox.snapshot();
                            await inbox.clearCursor();
                            if (started)
                                await emit({ event: 'gap', after: previous.watermark, reason: 'cursor-expired' });
                            else
                                pendingGap = previous.watermark;
                        })),
                        connected: local(() => serial(async () => {
                            await guard();
                            if (!started) {
                                await emit({ event: 'listening', cube_id: binding.cubeId, drone_id: binding.representativeDroneId, ...await inbox.snapshot() });
                                started = true;
                                if (pendingGap !== undefined)
                                    await emit({ event: 'gap', after: pendingGap, reason: 'cursor-expired' });
                                if (command.replayAfter) {
                                    const replay = await inbox.replay(command.replayAfter);
                                    if (replay.missing)
                                        await emit({ event: 'gap', after: command.replayAfter, reason: 'replay-checkpoint-missing' });
                                    for (const hint of replay.hints) {
                                        await guard();
                                        await emit(hint);
                                    }
                                }
                            }
                            else
                                await emit({ event: 'connected', resumed_from: resumed?.id ?? null });
                        })),
                        log: local((event, catchupCursor) => serial(async () => {
                            await guard();
                            const hint = await inbox.append({ ...event.data, id: event.id }, catchupCursor);
                            if (hint) {
                                await guard();
                                await emit(hint);
                            }
                        })),
                    },
                });
                attempt = 0;
            }
            catch (error) {
                if (reason) {
                    if (!started)
                        throw error;
                    break;
                }
                if (consumerFailure)
                    throw consumerFailure;
                const terminal = terminalReason(error);
                if (terminal) {
                    if (!started)
                        throw error;
                    stop(terminal);
                    break;
                }
                deps.stderr(`Representative listener: ${error instanceof Error ? error.message : 'stream disconnected'}\n`);
            }
            if (reason)
                break;
            const delay = Math.round((options.reconnectDelay ?? streamReconnectDelay)(attempt++));
            if (started)
                await emit({ event: 'reconnecting', attempt, delay_ms: delay });
            await new Promise(resolve => {
                const done = () => { clearTimeout(timeout); abort.signal.removeEventListener('abort', done); resolve(); };
                const timeout = setTimeout(done, delay);
                abort.signal.addEventListener('abort', done, { once: true });
                if (abort.signal.aborted)
                    done();
            });
        }
        return exitCode();
    }
    catch (error) {
        deps.stderr(`Representative listener refused: ${error instanceof Error ? error.message : String(error)}\n`);
        if (!started && (error instanceof RepresentativeError || terminalReason(error))) {
            await emit({ event: 'refused', code: typeof error?.code === 'string' ? error.code : 'BACKEND_ERROR', exit_code: 2 });
            return 2;
        }
        if (started)
            reason = 'fatal';
        else if (!outputBroken)
            await emit({ event: 'refused', code: error instanceof BorgServerUnreachableError
                    ? 'REPRESENTATIVE_LISTENER_SERVER_UNREACHABLE' : 'REPRESENTATIVE_LISTENER_STORAGE_REFUSED', exit_code: 1 });
        return 1;
    }
    finally {
        if (timer)
            clearInterval(timer);
        process.removeListener('SIGTERM', signal);
        process.removeListener('SIGINT', signal);
        await pending;
        let releaseFailed = false;
        try {
            await lease?.release();
        }
        catch (error) {
            releaseFailed = true;
            reason = 'fatal';
            deps.stderr(`Listener lease release failed: ${String(error)}\n`);
        }
        if (started && reason && !outputBroken) {
            try {
                await emit({ event: 'stopped', reason, exit_code: exitCode() });
            }
            catch { /* stdout failure is fatal to the host */ }
        }
        process.stdout.removeListener('error', outputError);
        if (releaseFailed || outputBroken)
            return 1;
    }
}
//# sourceMappingURL=representative-listener.js.map