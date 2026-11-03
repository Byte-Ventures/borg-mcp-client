export type ToolPolicyHost = 'claude' | 'codex' | 'opencode';
export declare class ToolNameMigrationError extends Error {
    constructor(host: ToolPolicyHost, detail: string);
}
/** Permission selectors need both spellings while hidden aliases are callable. */
export declare function toolPolicySpellings(host: ToolPolicyHost, name: string): string[];
/** Inspect without rewriting. Exact pairs must be adjacent with identical
 * scope/effect; arbitrary globs must already match both names. This keeps
 * ordered policy semantics and cannot broaden a glob by guessing its rewrite. */
export declare function assertToolNamePoliciesMigrated(host: ToolPolicyHost, config: unknown): void;
//# sourceMappingURL=tool-name-migration.d.ts.map