export type ToolPolicyHost = 'claude' | 'codex' | 'opencode';
export declare class ToolNameMigrationError extends Error {
    constructor(host: ToolPolicyHost, detail: string);
}
/** Claude's simple matchers are exact-name lists; other non-wildcard matchers
 * are unanchored regexes. Separate hooks cannot prove equivalent effects. */
export declare function assertClaudeHookPoliciesMigrated(config: unknown): void;
/** Permission selectors need both spellings while hidden aliases are callable. */
export declare function toolPolicySpellings(host: ToolPolicyHost, name: string): string[];
/** Inspect without rewriting. OpenCode's ordered rules need adjacent pairs;
 * Codex tables and Claude sets have no ordering semantics. */
export declare function assertToolNamePoliciesMigrated(host: ToolPolicyHost, config: unknown): void;
//# sourceMappingURL=tool-name-migration.d.ts.map