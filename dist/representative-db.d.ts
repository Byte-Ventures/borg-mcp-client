import type { DatabaseSync } from 'node:sqlite';
export declare const REPRESENTATIVE_STATE_SCHEMA = "borg-representative/1";
export declare const REPRESENTATIVE_STATE_USER_VERSION = 1;
export type RepresentativeStateErrorCode = 'REPRESENTATIVE_STATE_INVALID' | 'REPRESENTATIVE_STATE_CORRUPT' | 'REPRESENTATIVE_STATE_VERSION' | 'REPRESENTATIVE_STATE_BUSY';
export declare class RepresentativeStateError extends Error {
    readonly code: RepresentativeStateErrorCode;
    readonly details: {
        path?: string;
        reason?: string;
        found?: string;
        expected?: string;
    };
    constructor(code: RepresentativeStateErrorCode, message: string, details?: {
        path?: string;
        reason?: string;
        found?: string;
        expected?: string;
    });
}
/** Proven corruption only; BUSY, I/O, FULL, READONLY and permission errors are not. */
export declare function isSqliteCorruption(error: unknown): boolean;
/**
 * Hide only SQLite's ExperimentalWarning. Node prints warnings through its own
 * 'warning' listeners; they are replaced by one that forwards every other
 * warning to them unchanged. Must run before node:sqlite is loaded.
 */
export declare function installSqliteWarningFilter(proc?: NodeJS.Process): void;
export type SqliteModule = typeof import('node:sqlite');
/** The only way node:sqlite is loaded: after the warning filter, by dynamic import (static imports are hoisted). */
export declare function loadSqlite(): Promise<SqliteModule>;
/** A value for terminal output: C0/C1 control characters and DEL escaped as \\uXXXX. */
export declare function printable(value: string): string;
export declare function representativeStateRoot(): string;
/** CURRENT's generation, or null when unpublished. Never follows a link. */
export declare function readCurrent(root: string): string | null;
export interface RepresentativeStateOptions {
    root?: string;
    now?: () => Date;
    /** How long a transaction waits for another writer (default 10 s). */
    busyTimeoutMs?: number;
    /**
     * Rows for the FIRST generation only (clean slate): gathered before the
     * publish mutex (it may read files), then written inside the creating
     * transaction. Never used again once any generation exists, including after
     * a reset.
     */
    seed?: () => Promise<(db: DatabaseSync) => void>;
    /**
     * Receives the generation-named entries the first creation's retention left
     * in place (not removable as a plain generation). Default: one line on stderr.
     */
    onKept?: (root: string, kept: string[]) => void;
    /** Test seams: run between the named steps (kill/pause controls). */
    hooks?: Partial<Record<'beforeOpen' | 'beforeBegin' | 'afterBegin' | 'publish:dir' | 'publish:schema' | 'publish:rows' | 'publish:fsync' | 'publish:tmp' | 'publish:rename' | 'publish:done', () => void>>;
}
export type Transaction = DatabaseSync;
export interface RepresentativeState {
    readonly root: string;
    /**
     * Run `body` in one BEGIN IMMEDIATE transaction on the current generation,
     * creating and publishing the first generation when none exists. `body` is
     * synchronous by construction: no network I/O runs inside a transaction.
     */
    transact<T>(body: (db: Transaction) => T): Promise<T>;
    /** Read-only view for status; null when no generation is published. Never creates anything. */
    readOnly<T>(body: (db: Transaction) => T): Promise<T | null>;
    close(): void;
}
export declare function createRepresentativeState(options?: RepresentativeStateOptions): RepresentativeState;
/**
 * Serialize creation and reset on the data-free publish mutex: an empty
 * rollback-journal database held with BEGIN EXCLUSIVE and never written. Its
 * journal lives in memory (journal_mode=MEMORY), so holding the lock creates no
 * sidecar file; OFF is not used because defensive SQLite builds refuse it.
 */
export declare function withPublishMutex<T>(root: string, body: (sqlite: SqliteModule, root: string) => T, options: {
    create: boolean;
    ensureTree?: (create: boolean) => Promise<boolean>;
}): Promise<T>;
/**
 * Build a complete generation, then publish it with one rename of CURRENT.
 * Nothing is visible until the rename; durability is claimed only after the
 * final directory fsync. Runs inside the publish mutex. Returns the new
 * generation and the generation-named entries retention left in place.
 */
export declare function publishGeneration(sqlite: SqliteModule, root: string, fill: (db: DatabaseSync) => void, now?: () => Date, hook?: (name: 'publish:dir' | 'publish:schema' | 'publish:rows' | 'publish:fsync' | 'publish:tmp' | 'publish:rename' | 'publish:done') => void): {
    generation: string;
    kept: string[];
};
/**
 * Remove orphan and old non-current generations, keeping the newest
 * RETAINED_GENERATIONS. Never recursive: only the three exact database names
 * are unlinked (after lstat), then rmdir; anything else stays and is reported.
 * Stray CURRENT tmp files (exact pattern, regular) are removed. Runs inside
 * the publish mutex.
 */
export declare function cleanupGenerations(root: string, current: string): string[];
export interface ResetReport {
    outcome: 'reset' | 'healthy' | 'not-initialized';
    previous?: string;
    current?: string;
    salvaged: string[];
    dropped: Array<{
        worktree: string | null;
        reason: string;
    }>;
    retainedAside: string[];
}
export interface ResetOptions {
    root?: string;
    now?: () => Date;
    /** Re-validates one untrusted salvaged binding exactly as `prepare` does; null drops it. */
    validateBinding(value: unknown, worktree: string): {
        worktree: string;
        boundAt: string;
    } | null;
    generationOf(binding: {
        worktree: string;
        boundAt: string;
    }): string;
    seatOf(binding: {
        worktree: string;
        boundAt: string;
    }): string;
    hooks?: RepresentativeStateOptions['hooks'];
}
/**
 * Disaster recovery for a CORRUPT state database (never a healthy one): build a
 * new generation holding the salvageable bindings, each starting at its binding
 * start (replay; duplicates, never loss), and publish it over CURRENT. The old
 * generation is left in place (0700) and retained with the newest others.
 * Lost: every delivery checkpoint, the request ledger (pending and ambiguous
 * send guards) and wake state.
 */
export declare function resetRepresentativeState(options: ResetOptions): Promise<ResetReport>;
//# sourceMappingURL=representative-db.d.ts.map