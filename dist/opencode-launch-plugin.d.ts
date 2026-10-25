export declare const OPENCODE_CODE_MODE_GUIDANCE: string;
/** V2-only entrypoint. Imports only Borg code and Node builtins, no host SDK. */
export declare function buildBorgV2PluginSource(): string;
/** Delete a legacy autoload file only when its entire bytes match our generator. */
export declare function migrateLegacyOpenCodePlugin(homeDir?: string): void;
export declare function installLaunchOpenCodePlugin(generation: 1 | 2, launch: string, root?: string): {
    directory: string;
    entrypoint: string;
};
export declare function hasLaunchScopedOpenCodePlugins(homeDir?: string): boolean;
//# sourceMappingURL=opencode-launch-plugin.d.ts.map