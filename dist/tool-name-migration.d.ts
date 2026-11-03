export type ToolPolicyHost = 'claude' | 'codex' | 'opencode';
export declare class ToolNameMigrationError extends Error {
    constructor(host: ToolPolicyHost, detail: string);
}
/** A rename must never silently unmatch a host-side restriction. Inspect raw
 * sources too: an effective merge can hide a managed rule or an agent policy.
 * Do not translate arbitrary globs, reorder rules, or edit operator settings. */
export declare function assertToolNamePoliciesMigrated(host: ToolPolicyHost, config: unknown): void;
//# sourceMappingURL=tool-name-migration.d.ts.map