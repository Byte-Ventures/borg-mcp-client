export type AgentSessionIdentity = {
    kind: 'known';
    id: string;
    source: string;
    observedAt: string;
} | {
    kind: 'unknown';
    reason: string;
};
/** Identity only: no credential, authorization, liveness, or expiry semantics. */
export declare function recordClaudeSessionStart(payload: string, env?: NodeJS.ProcessEnv, worktree?: string): Promise<void>;
export declare function resolveAgentSessionIdentity(env?: NodeJS.ProcessEnv, worktree?: string): Promise<AgentSessionIdentity>;
//# sourceMappingURL=agent-session-identity.d.ts.map