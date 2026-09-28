/**
 * `borg representative listen --protocol 2`: the push engine's process.
 *
 * One per representative drone and server authority (the listener lease).
 * stdout carries JSON lines for the host:
 *   listening {protocol: 2, binding_fingerprint, undelivered}
 *   wake {wake_id, reason: new-reply|rewake|startup, count}   (body-free)
 *   refused {code, exit_code}
 *   stopped {reason, exit_code}
 * stdin carries the host's acks, one JSON line of at most 1 KiB each:
 *   {"wake_id": "<uuid>", "accepted": true|false}
 * EOF on stdin exits 0: the host that owns the pipe is gone. The listener
 * refuses to start without such a host (stdin a TTY or /dev/null).
 *
 * The server stream is only a trigger: every connect, every log event and a
 * 5-minute timer start discovery, which reads the log itself (see
 * representative-push.ts). Exit codes: 0 stopped by signal or EOF, 1 fatal,
 * 2 refused at startup, 3 another listener holds the lease, 4 evicted,
 * rebound, revoked, trust changed or lease lost.
 */
import { createHash } from 'node:crypto';
import { fstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { borgConfigRoot, borgHomeRoot } from './private-root.js';
import { acquireStreamLease, readOwnershipSnapshot, STREAM_OWNER_STALE_MS, type StreamLease } from './stream-owner.js';
import { streamOnce, streamReconnectDelay, type StreamDeps } from './log-stream.js';
import { resolveRepresentativeContext, type RepresentativeCmdDeps } from './representative-cmd.js';
import { DroneEvictedError, CubeDeletedError } from './drone-lifecycle.js';
import { BorgServerTrustError, BorgServerUnreachableError } from './server-errors.js';
import { isTransportFailure } from './seat-probe.js';
import { readBorgServerTrustIdentity } from './server-trust.js';
import { ensureRepresentativeState, RepresentativeError, verifyLiveBinding } from './representative-core.js';
import { bindingFingerprint, RepresentativeGenerationError, type RepresentativeBinding, type RepresentativeStore } from './representative-store.js';
import { EngineStoppedError, PushEngine, readWakeSummary, WAKE_ACK_LINE_MAX_BYTES, type PushEngineDeps } from './representative-push.js';
import type { ActiveCube } from './cubes.js';

export const LISTENER_PROTOCOL = 2;
const RECONCILE_MS = 5 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

type StopReason = 'signal' | 'eof' | 'evicted' | 'rebound' | 'revoked' | 'trust-changed' | 'lease-lost' | 'fatal';
export interface ListenerOptions {
  /** Controlled transport/timing seams; the CLI supplies no overrides. */
  streamDeps?: StreamDeps;
  heartbeatIntervalMs?: number;
  reconnectDelay?: (attempt: number) => number;
  reconcileMs?: number;
  now?: () => Date;
  /** The host pipe. Default process.stdin, which must be a pipe or socket. */
  stdin?: Readable;
  hooks?: PushEngineDeps['hooks'];
}

function listenerOwnerDeps(binding: RepresentativeBinding) {
  const authority = createHash('sha256').update(JSON.stringify([binding.origin, binding.trustIdentity])).digest('hex');
  return {
    locksDir: join(borgConfigRoot(), 'representative-listener-locks', authority),
    privateRoot: { root: borgConfigRoot(), boundary: borgHomeRoot() },
    worktree: binding.worktree, droneLabel: binding.representativeLabel, cubeName: binding.cubeName,
  };
}

/** Listener lease holder and wake state for `status`. Read-only. */
export async function representativeListenerStatus(binding: RepresentativeBinding, store: RepresentativeStore) {
  const ownership = await readOwnershipSnapshot(binding.cubeId, binding.representativeDroneId, listenerOwnerDeps(binding));
  let alive = false;
  if (ownership.pid) {
    try { process.kill(ownership.pid, 0); alive = true; }
    catch (error) { alive = (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }
  return { ...ownership, protocol: LISTENER_PROTOCOL, running: alive && (ownership.ageMs ?? Infinity) <= STREAM_OWNER_STALE_MS,
    wakes: await readWakeSummary(store, binding) };
}

function codeOf(error: unknown): string {
  if (error instanceof DroneEvictedError) return 'DRONE_EVICTED';
  if (error instanceof CubeDeletedError) return 'CUBE_DELETED';
  if (error instanceof BorgServerTrustError) return 'TRUST_CHANGED';
  return typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'LISTENER_ERROR';
}
function terminalReason(error: unknown): StopReason | undefined {
  if (error instanceof RepresentativeGenerationError) return 'rebound';
  const code = codeOf(error);
  if (code === 'DRONE_EVICTED' || code === 'CUBE_DELETED' || code === 'SEAT_UNAVAILABLE') return 'evicted';
  if (code === 'BINDING_MISMATCH' || code === 'COORDINATOR_UNAVAILABLE') return 'rebound';
  if (code.includes('TRUST')) return 'trust-changed';
  if (['SESSION_REVOKED', 'SESSION_REJECTED', 'CREDENTIAL_REJECTED'].includes(code)) return 'revoked';
  return undefined;
}

/** The host must own a pipe on stdin: a TTY or /dev/null (both character devices) has no host behind it. */
function stdinHasHost(): boolean {
  try {
    const stat = fstatSync(0);
    return stat.isFIFO() || stat.isSocket();
  } catch {
    return false;
  }
}

export async function runListener(
  command: { worktree?: string; protocol?: number }, deps: RepresentativeCmdDeps, options: ListenerOptions = {},
): Promise<number> {
  let outputBroken = false;
  const emit = async (event: unknown) => {
    deps.stdout(JSON.stringify(event) + '\n');
    // The command exits after its final event; wait for the pipe to flush.
    await new Promise<void>((resolve, reject) => process.stdout.write('', error => error ? reject(error) : resolve()));
  };
  if (command.protocol !== LISTENER_PROTOCOL) {
    deps.stderr('Representative listener refused: run it with --protocol 2 (the only protocol this version speaks).\n');
    await emit({ event: 'refused', code: 'REPRESENTATIVE_LISTENER_PROTOCOL_REQUIRED', exit_code: 2 });
    return 2;
  }
  if (!options.stdin && !stdinHasHost()) {
    deps.stderr('Representative listener refused: stdin must be a pipe owned by the host that handles its wakes (not a terminal or /dev/null).\n');
    await emit({ event: 'refused', code: 'REPRESENTATIVE_LISTENER_HOST_REQUIRED', exit_code: 2 });
    return 2;
  }
  const stdin = options.stdin ?? process.stdin;
  const now = options.now ?? (() => new Date());
  let lease: StreamLease | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let reconcile: ReturnType<typeof setInterval> | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let started = false, reason: StopReason | undefined, active: ActiveCube;
  const abort = new AbortController();
  let engine: PushEngine | undefined;
  /** One cancellation for the whole listener: stream, engine (discovery, scheduler, network) and timers. */
  const stop = (why: StopReason) => { reason ??= why; abort.abort(); engine?.stop(); };
  const signal = () => stop('signal');
  const outputError = () => { outputBroken = true; stop('fatal'); };
  process.stdout.on('error', outputError);
  const exitCode = () => reason === 'signal' || reason === 'eof' ? 0 : reason === 'fatal' ? 1 : 4;
  let failure: unknown;
  /** Every engine failure ends the run: a rebound or terminal state with its reason, anything else as fatal. */
  const fail = (error: unknown) => {
    if (reason || error instanceof EngineStoppedError) return;
    failure ??= error;
    const terminal = terminalReason(error);
    if (!terminal) deps.stderr(`Representative listener: ${error instanceof Error ? error.message : String(error)}\n`);
    stop(terminal ?? 'fatal');
  };
  const onLine = (line: string) => { if (engine && !reason) void track(engine.ack(line).then(() => reschedule(), fail)); };
  let reschedule = () => {};
  let buffered = '';
  let overflow = false;
  const onData = (chunk: Buffer | string) => {
    buffered += chunk.toString();
    for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (overflow) { overflow = false; continue; } // the rest of an oversized line
      if (line.trim()) onLine(line);
    }
    // An unterminated line past the limit is discarded up to its newline.
    if (Buffer.byteLength(buffered) > WAKE_ACK_LINE_MAX_BYTES) { buffered = ''; overflow = true; }
  };
  const onEnd = () => stop('eof');
  /** Work started by timers and triggers; all of it settles before the lease is released. */
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work)).catch(() => {});
    return work;
  };
  try {
    // Every handler is live before the first startup step: a signal or EOF at
    // any point cancels whatever runs (server checks, the head walk, discovery).
    process.once('SIGTERM', signal); process.once('SIGINT', signal);
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('close', onEnd);
    let worktree = command.worktree ?? deps.cwd();
    try { worktree = realpathSync(worktree); } catch { /* resolve refuses missing bindings */ }
    worktree = deps.findProjectRoot(worktree);
    const ctx = await resolveRepresentativeContext(worktree, deps, { initialize: true });
    if (reason) return exitCode();
    // Only this server step maps transport failures to SERVER_UNREACHABLE; typed
    // rejections keep their binding codes and storage keeps STORAGE_REFUSED.
    await verifyLiveBinding(ctx, abort.signal).catch((error: unknown) => {
      if (reason) throw error;
      throw isTransportFailure(error) && !(error instanceof BorgServerUnreachableError)
        ? new BorgServerUnreachableError('Borg server unreachable during startup verification', { cause: error }) : error;
    });
    if (reason) return exitCode();
    const binding = ctx.binding;
    active = (await deps.hydrateSeat(worktree))!;
    const ownerDeps = listenerOwnerDeps(binding);
    lease = await acquireStreamLease(binding.cubeId, binding.representativeDroneId, STREAM_OWNER_STALE_MS, ownerDeps);
    if (!lease) {
      const owner = await readOwnershipSnapshot(binding.cubeId, binding.representativeDroneId, ownerDeps);
      await emit({ event: 'refused', code: 'REPRESENTATIVE_LISTENER_OWNED', exit_code: 3,
        owner_pid: owner.pid ?? null, owner_started_at: owner.startedAt ?? null });
      return 3;
    }
    const guard = async () => {
      if (abort.signal.aborted) throw new Error('listener stopped');
      const current = await deps.store.getBinding(worktree);
      if (!current || bindingFingerprint(current) !== bindingFingerprint(binding)) {
        stop('rebound'); throw new RepresentativeError('BINDING_MISMATCH', 'Representative binding changed');
      }
      const saved = await deps.hydrateSeat(worktree);
      if (!saved) { stop('revoked'); throw new RepresentativeError('SEAT_UNAVAILABLE', 'Representative seat unavailable'); }
      if (saved.serverTrustIdentity !== binding.trustIdentity) { stop('trust-changed'); throw new BorgServerTrustError('Representative trust changed'); }
      if (saved.cubeId !== binding.cubeId || saved.droneId !== binding.representativeDroneId || saved.apiUrl !== binding.origin) {
        stop('rebound'); throw new RepresentativeError('BINDING_MISMATCH', 'Representative seat changed');
      }
      // Recheck authority trust while the stream stays open, not only on reconnect.
      // Controlled transports may omit trust loading; production never does.
      if (!options.streamDeps?.fetchImpl || options.streamDeps.loadTrust) {
        try {
          // Read fresh: the loader's local-authority cache never observes a change.
          const identity = options.streamDeps?.loadTrust
            ? (await options.streamDeps.loadTrust(binding.origin)).identity
            : await readBorgServerTrustIdentity(binding.origin);
          if (identity !== binding.trustIdentity) throw new BorgServerTrustError('Representative authority trust changed');
        } catch (error) { stop('trust-changed'); throw error; }
      }
      const observed = await readOwnershipSnapshot(binding.cubeId, binding.representativeDroneId, ownerDeps);
      if (observed.processNonce !== lease!.record.processNonce) { stop('lease-lost'); throw new Error('Listener ownership lost'); }
    };

    const push = new PushEngine({
      binding, store: deps.store, backend: ctx.backend, now,
      emit: async (wake) => { if (!reason) await emit({ event: 'wake', ...wake }); },
      log: (line) => { deps.stderr(`${line}\n`); },
      ...(options.hooks ? { hooks: options.hooks } : {}),
    });
    engine = push;
    if (reason) return exitCode();
    let beating: Promise<unknown> | null = null;
    heartbeat = setInterval(() => {
      // One heartbeat at a time: overlapping refreshes of one lease would race each other.
      if (reason || beating) return;
      beating = track((async () => { await guard(); if (!await lease!.refresh()) stop('lease-lost'); })()
        .catch(error => { if (!reason) stop(terminalReason(error) ?? 'lease-lost'); })
        .finally(() => { beating = null; }));
    }, options.heartbeatIntervalMs ?? 20_000);
    const summary = await push.summary();
    await emit({ event: 'listening', protocol: LISTENER_PROTOCOL, binding_fingerprint: bindingFingerprint(binding),
      undelivered: summary.undelivered });
    started = true;
    if (reason) return exitCode();

    // The scheduler sleeps until the next eligible instant only.
    reschedule = () => {
      if (reason) return;
      void push.nextDueAt().then((at) => {
        if (reason) return;
        if (scheduled) clearTimeout(scheduled);
        scheduled = undefined;
        if (at === null) return;
        scheduled = setTimeout(() => {
          scheduled = undefined;
          if (!reason) void track(push.tick().then(() => reschedule(), fail));
        }, Math.min(Math.max(at - now().getTime(), 0), MAX_TIMER_MS));
      }, fail);
    };
    // Discovery waits for the startup cohort capture (one bounded request, after `listening`).
    let captured = false;
    const discover = () => { if (!reason && captured) void track(push.discover().then(() => reschedule(), fail)); };
    reconcile = setInterval(discover, options.reconcileMs ?? RECONCILE_MS);
    // Startup work after `listening`: the first use of an imported 5.x binding
    // walks to the server head, then the cohort capture. Both honor the stop signal.
    void track((async () => {
      await ensureRepresentativeState(ctx, abort.signal);
      await push.captureCohort();
    })().then(() => { captured = true; reschedule(); discover(); }, fail));

    let attempt = 0;
    let consumerFailure: unknown;
    // Failures of the listener's own guard are terminal; every other
    // non-terminal stream failure is transport and reconnects.
    const local = <A extends unknown[], T>(fn: (...args: A) => Promise<T>) => async (...args: A): Promise<T> => {
      try { return await fn(...args); } catch (error) { consumerFailure ??= error; throw error; }
    };
    while (!reason) {
      try {
        consumerFailure = undefined;
        await local(guard)();
        await streamOnce(active, null, () => {}, {
          ...options.streamDeps, getCursor: async () => null, abortSignal: abort.signal,
          consumer: {
            catchupCursor: null,
            beforeEvent: local(guard),
            clearCursor: async () => {},
            connected: async () => { attempt = 0; discover(); },
            log: async () => { discover(); },
          },
        });
      } catch (error) {
        if (reason) break;
        if (consumerFailure) { fail(consumerFailure); break; }
        const terminal = terminalReason(error);
        if (terminal) { stop(terminal); break; }
        deps.stderr(`Representative listener: ${error instanceof Error ? error.message : 'stream disconnected'}\n`);
      }
      if (reason) break;
      const delay = Math.round((options.reconnectDelay ?? streamReconnectDelay)(attempt++));
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timeout); abort.signal.removeEventListener('abort', done); resolve(); };
        const timeout = setTimeout(done, delay); abort.signal.addEventListener('abort', done, { once: true });
        if (abort.signal.aborted) done();
      });
    }
    return exitCode();
  } catch (error) {
    // Stopped (EOF or a signal) during a startup step: not a refusal.
    if (reason && !started) return exitCode();
    deps.stderr(`Representative listener refused: ${error instanceof Error ? error.message : String(error)}\n`);
    if (!started && (error instanceof RepresentativeError || terminalReason(error))) {
      await emit({ event: 'refused', code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'BACKEND_ERROR', exit_code: 2 });
      return 2;
    }
    if (started) reason = 'fatal';
    else if (!outputBroken) await emit({ event: 'refused', code: error instanceof BorgServerUnreachableError
      ? 'REPRESENTATIVE_LISTENER_SERVER_UNREACHABLE' : 'REPRESENTATIVE_LISTENER_STORAGE_REFUSED', exit_code: 1 });
    return 1;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (reconcile) clearInterval(reconcile);
    if (scheduled) clearTimeout(scheduled);
    stdin.removeListener('data', onData);
    stdin.removeListener('end', onEnd);
    stdin.removeListener('close', onEnd);
    if (!options.stdin) stdin.pause();
    process.removeListener('SIGTERM', signal); process.removeListener('SIGINT', signal);
    // A heartbeat refresh or a transition still running must not outlive the lease.
    // Stopping abandons network waits at once; the bound covers a stuck local step.
    engine?.stop();
    const settleBy = Date.now() + 5_000;
    while (inFlight.size > 0 && Date.now() < settleBy) {
      await Promise.race([Promise.allSettled([...inFlight]), new Promise((resolve) => setTimeout(resolve, Math.max(settleBy - Date.now(), 0)))]);
    }
    if (inFlight.size > 0) deps.stderr(`Representative listener: ${inFlight.size} step(s) still running at shutdown; releasing the lease\n`);
    let releaseFailed = false;
    try { await lease?.release(); } catch (error) { releaseFailed = true; reason = 'fatal'; deps.stderr(`Listener lease release failed: ${String(error)}\n`); }
    if (started && reason && !outputBroken) {
      // After EOF the host is gone; the event is best effort.
      try { await emit({ event: 'stopped', reason, exit_code: exitCode() }); } catch { /* stdout failure is fatal to the host */ }
    }
    process.stdout.removeListener('error', outputError);
    if (failure !== undefined && reason === 'fatal') deps.stderr(`Representative listener stopped: ${String(failure)}\n`);
    if (releaseFailed || outputBroken) return 1;
  }
}
