import { type RepresentativeBinding, type RepresentativeStore } from './representative-store.js';
import { type RepresentativeBackend } from './representative-core.js';
import type { LocalServerCursor } from './local-server-cursor.js';
export declare const WAKE_ACK_DEADLINE_MS = 60000;
export declare const WAKE_DEBOUNCE_MS = 2000;
export declare const DISCOVERY_PAGE = 200;
export declare const WAKE_ACK_LINE_MAX_BYTES = 1024;
export type WakeReason = 'startup' | 'new-reply' | 'rewake';
export interface WakeDocument {
    version: 1;
    frontier: LocalServerCursor | null;
    outstanding: {
        batch: string;
        replies: string[];
        deadline: string;
        reason: WakeReason;
    } | null;
    refusals: {
        count: number;
        retry_at: string | null;
    };
    /** Entries still to scan before the startup batch; null until the first capture. */
    cohort: {
        remaining: number;
        open: boolean;
    } | null;
    /** The cohort closed and its one startup batch has not been emitted yet. */
    startup_pending: boolean;
    debounce_at: string | null;
}
export declare const rewakeBackoffMs: (attempts: number) => number;
export declare const refusalBackoffMs: (count: number) => number;
export interface WakeEmission {
    wake_id: string;
    reason: WakeReason;
    count: number;
}
export type AckOutcome = 'accepted' | 'refused' | 'ignored';
export interface PushEngineDeps {
    binding: RepresentativeBinding;
    store: RepresentativeStore;
    backend: RepresentativeBackend;
    now(): Date;
    /** Writes one wake event to the host. Called only after the wake is persisted. */
    emit(wake: WakeEmission): Promise<void>;
    /** Test seams (crash and pause controls). */
    /** One diagnostic line (stderr in the listener); the text is already escaped. */
    log?(line: string): void;
    hooks?: {
        /** After an EMIT transaction committed, before its event is written. */
        afterWakePersisted?(wake: WakeEmission): void | Promise<void>;
        /** After a discovery page was merged, before the next page is read. */
        betweenPages?(page: number): void | Promise<void>;
    };
}
export interface WakeSummary {
    undelivered: number;
    outstanding: {
        wake_id: string;
        count: number;
        deadline: string;
    } | null;
    refusals: {
        count: number;
        retry_at: string | null;
    };
    cohort_open: boolean;
    frontier: LocalServerCursor | null;
}
export declare class EngineStoppedError extends Error {
    constructor();
}
export declare class PushEngine {
    private readonly deps;
    private chain;
    private scanning;
    private rescan;
    private readonly halt;
    private readonly halted;
    constructor(deps: PushEngineDeps);
    get stopped(): boolean;
    /** One cancellation for everything: no later transition, merge or request, and a request in flight is abandoned. */
    stop(): void;
    /**
     * A network read that stop() abandons at once. The request is started only
     * while the engine runs and carries the engine's signal, so the transport
     * aborts it and starts no retry or backoff.
     */
    private network;
    /** Transitions and their emits run one at a time, in order; none starts after stop(). */
    private serial;
    /**
     * One engine transaction. Invalid wake state is discarded first, in the same
     * transaction, so no transition ever reads it; the line is logged after commit.
     */
    private transact;
    /** Clamp instants a clock jump left more than 24 h ahead. */
    private clamp;
    /**
     * Start of a run: capture the startup cohort with one bounded request (the
     * number of entries beyond the scan position). An open cohort from an
     * interrupted run keeps its remaining count, so the target never moves
     * forward. Must run before the first discovery.
     */
    captureCohort(): Promise<WakeSummary>;
    summary(): Promise<WakeSummary>;
    /**
     * Discovery: single-flight. A trigger while a scan runs makes that scan run
     * once more when it ends. Resolves when no scan is pending.
     */
    discover(): Promise<void>;
    private scanOnce;
    private merge;
    /**
     * One scheduler step: expire an outstanding batch whose deadline passed,
     * then EMIT if a wake is eligible. The wake is committed before it is
     * written to the host.
     */
    tick(): Promise<WakeEmission | null>;
    /** The next instant (ms) at which tick() can change something; null when only discovery can. */
    nextDueAt(): Promise<number | null>;
    /**
     * One stdin line from the host. Only a well-formed ack for the outstanding
     * batch changes anything, and only wake fields: never delivery, returned
     * entries, the request ledger or the frontier.
     */
    ack(line: string): Promise<AckOutcome>;
}
/** A stdin ack: at most 1 KiB, exactly {wake_id: uuid, accepted: boolean}. Anything else is null (ignored). */
export declare function parseAck(line: string): {
    wake_id: string;
    accepted: boolean;
} | null;
/** Read-only wake summary for status; null when the state or the generation has none. Never creates anything. */
export declare function readWakeSummary(store: RepresentativeStore, binding: RepresentativeBinding): Promise<WakeSummary | null>;
//# sourceMappingURL=representative-push.d.ts.map