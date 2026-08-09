export declare const LOG_AUDIT_NUDGE: (count: number) => string;
/**
 * Pure transcript scan shared by the Claude hook and the OpenCode plugin.
 * Accepts both Claude JSONL entries and OpenCode SDK message records.
 */
export declare function evaluateLogAudit(entries: readonly any[], renderNudge?: (count: number) => string): string | null;
//# sourceMappingURL=log-audit-core.d.ts.map