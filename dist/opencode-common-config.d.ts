export declare function readManagedOpenCodeMcpCommands(configPath: string): unknown[];
/** Update owned commands in either shape without enabling or converting them. */
export declare function refreshManagedOpenCodeMcpCommands(configPath: string, stale: (command: unknown) => boolean, command: string): void;
/** Setup writes the intersection of V1/V2 config, never V2-only global fields. */
export declare function registerCommonOpenCodeMcp(homeDir?: string, env?: NodeJS.ProcessEnv): void;
//# sourceMappingURL=opencode-common-config.d.ts.map