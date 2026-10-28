import { type ChildCompletion } from './child-completion.js';
import { spawn } from 'node:child_process';
import { type OpenCodeInstallation } from './opencode-installation.js';
import { type OpenCodeV2Seat } from './opencode-v2-broker.js';
import type { ConfigEntry } from '@opencode/client';
export declare function preserveOpenCodeV2McpOptions(sources: readonly ConfigEntry[], ownedDescriptor?: string, originalInline?: string): Record<string, unknown>;
export interface OpenCodeV2SessionArgs {
    sessionID?: string;
    continue: boolean;
    rest: string[];
}
export declare function parseOpenCodeV2SessionArgs(args: readonly string[]): OpenCodeV2SessionArgs;
/** Native V2 config stays launch-local. JSONC files are read, never rewritten. */
export declare function openCodeV2LaunchOverlay(env: NodeJS.ProcessEnv, descriptorPath: string, pluginDirectory: string, mcpCommand?: string[]): NodeJS.ProcessEnv;
export declare function launchOpenCodeV2Process(options: {
    installation: OpenCodeInstallation;
    cwd: string;
    env: NodeJS.ProcessEnv;
    prompt: string;
    passthroughArgs?: string[];
    skipApprovalOverride?: boolean;
    seat?: OpenCodeV2Seat;
    spawnProcess?: typeof spawn;
    /** Dependency seam for the opt-in native compatibility harness. */
    mcpCommand?: string[];
}): Promise<{
    process: ReturnType<typeof spawn>;
    cleanup: () => Promise<void>;
    completion: Promise<ChildCompletion>;
}>;
//# sourceMappingURL=opencode-v2-launch.d.ts.map