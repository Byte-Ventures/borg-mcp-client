export declare const OPENCODE_COMPATIBILITY: {
    readonly opencode: "1.18.15";
    readonly sdk: "1.17.18";
};
export interface OpenCodePluginCoreDeps {
    defer(task: () => Promise<void>): void;
    wait(milliseconds: number): Promise<void>;
    listMessages(sessionID: string): Promise<any[]>;
    renderOrientation(source: 'clear' | 'compact'): Promise<string>;
    submitPrompt(sessionID: string, text: string): Promise<void>;
    audit(messages: readonly any[]): string | null;
}
export interface OpenCodePluginCoreOptions {
    enabled: boolean;
    pluginVersion: string;
    kickoffMarker: string;
    recoveryMarker: string;
    kickoffPollAttempts: number;
    confirmationPollAttempts: number;
    pollDelayMs: number;
    compactFallback: string;
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