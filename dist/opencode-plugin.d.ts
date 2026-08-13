export declare const OPENCODE_COMPATIBILITY: {
    readonly opencode: "1.18.15";
    readonly sdk: "1.17.18";
};
export declare const OPENCODE_INJECTED_ENTRY_METADATA_KEY = "borgOpenCodeInjectedEntry";
export declare const OPENCODE_WAKE_IDENTITY_METADATA_KEY = "borgOpenCodeWakeIdentity";
export declare const OPENCODE_RECOVERY_METADATA_KEY = "borgOpenCodeSessionOrientation";
export declare const OPENCODE_LAUNCH_CORRELATION_METADATA_KEY = "borgOpenCodeLaunchCorrelation";
export interface OpenCodePluginCoreDeps {
    defer(task: () => Promise<void>): void;
    wait(milliseconds: number): Promise<void>;
    listMessages(sessionID: string): Promise<any[]>;
    renderOrientation(source: 'clear' | 'compact'): Promise<string>;
    submitPrompt(sessionID: string, text: string, recoveryVersion: string, shouldSubmit: () => boolean): Promise<boolean>;
    audit(messages: readonly any[]): string | null;
}
export interface OpenCodePluginCoreOptions {
    enabled: boolean;
    pluginVersion: string;
    recoveryMetadataKey: string;
    injectedEntryMetadataKey: string;
    kickoffPollAttempts: number;
    confirmationPollAttempts: number;
    pollDelayMs: number;
    compactFallback: string;
    launchCorrelationMetadataKey: string;
    launchCorrelationIdentity: string;
}
/** Pure, dependency-injected behavior core. Its emitted JavaScript function
 * body is also embedded in the installed self-contained plugin. */
export declare function createOpenCodePluginCore(deps: OpenCodePluginCoreDeps, options: OpenCodePluginCoreOptions): {
    event: ({ event }: any) => Promise<void>;
    'experimental.session.compacting': (_input: {
        sessionID: string;
    }, output: {
        context: string[];
    }) => Promise<void>;
    'chat.message': (input: {
        sessionID: string;
    }, output: {
        message: unknown;
        parts: any[];
    }) => Promise<void>;
};
export declare function buildBorgPluginSource(version: string): string;
export declare const BORG_PLUGIN_SOURCE: string;
export declare function openCodePluginPath(homeDir?: string): string;
export declare function installBorgPlugin(options?: {
    homeDir?: string;
    version?: string;
}): void;
//# sourceMappingURL=opencode-plugin.d.ts.map