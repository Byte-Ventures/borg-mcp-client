export interface GitResult {
    status: number | null;
    stdout?: string | null;
    stderr?: string | null;
    error?: Error;
}
export type RunGit = (cwd: string, args: string[]) => GitResult;
export interface ResolvedRef {
    ref: string;
    sha: string;
}
export declare function validateRefs(value: unknown): string[];
export declare function resolveRefs(refs: string[], cwd: string, runGit?: RunGit): ResolvedRef[];
export declare function auditMessageShas(message: string, cwd: string, runGit?: RunGit): {
    refusal?: string;
    unverified: string[];
};
export declare function renderProvenance(resolved: ResolvedRef[]): string;
export declare function requiresRefs(message: string): boolean;
//# sourceMappingURL=log-provenance.d.ts.map