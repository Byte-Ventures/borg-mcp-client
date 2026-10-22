import { spawn } from 'node:child_process';
import { type OpenCodeInstallation } from './opencode-installation.js';
export interface OpenCodeV2Server {
    readonly url: string;
    readonly pid: number | undefined;
    readonly version: string;
    /** In-memory only. Never put these headers in a binding or diagnostic. */
    headers(): Record<string, string>;
    /** Resolves when the child closes, including unexpected server failure. */
    readonly closed: Promise<void>;
    /** Idempotent; closes the ownership pipe, then terminates a stuck child. */
    close(): Promise<void>;
}
export interface StartOpenCodeV2ServerOptions {
    installation: OpenCodeInstallation;
    directory: string;
    env: NodeJS.ProcessEnv;
    readyTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    spawnProcess?: typeof spawn;
    fetch?: typeof fetch;
}
/** Validate readiness before sending a credential to any reported endpoint. */
export declare function validateOpenCodeV2Endpoint(input: unknown): string;
/**
 * Uses the installed V2 executable, not Service.ensure(): Borg must never
 * replace or stop the user's shared OpenCode service. The stdin pipe is the
 * server lease and also closes automatically if this parent process dies.
 */
export declare function startOpenCodeV2Server(options: StartOpenCodeV2ServerOptions): Promise<OpenCodeV2Server>;
//# sourceMappingURL=opencode-v2-server.d.ts.map