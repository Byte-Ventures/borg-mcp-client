import type { OpenCodeGeneration, OpenCodeInstallation } from './opencode-installation.js';
export interface OpenCodeAdapter {
    readonly generation: OpenCodeGeneration;
    readonly pluginEntrypoint: 'function' | 'setup';
    readonly serverOwnership: 'tui' | 'private-lease';
    readonly installation: OpenCodeInstallation;
    buildTuiArgs(options: {
        directory: string;
        port: number;
        prompt: string;
        sessionId?: string;
        passthroughArgs?: string[];
    }): string[];
}
/** Host contracts stay separate; V1 does not acquire V2 imports or semantics. */
export declare function selectOpenCodeAdapter(installation: OpenCodeInstallation): OpenCodeAdapter;
//# sourceMappingURL=opencode-adapter.d.ts.map