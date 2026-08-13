export declare const OPENCODE_SERVER_USERNAME = "opencode";
export declare const OPENCODE_SERVER_USERNAME_ENV = "OPENCODE_SERVER_USERNAME";
export declare const OPENCODE_SERVER_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";
export declare const BORG_OPENCODE_LAUNCH_CORRELATION_ENV = "BORG_OPENCODE_LAUNCH_CORRELATION";
export declare const OPENCODE_SERVER_PASSWORD_REFERENCE = "{env:OPENCODE_SERVER_PASSWORD}";
export interface OpenCodeLaunchTrust {
    apiPassword: string;
    correlationIdentity: string;
}
export declare function createOpenCodeLaunchTrust(overrides?: Partial<OpenCodeLaunchTrust>): OpenCodeLaunchTrust;
export declare function isOpenCode256BitIdentity(value: unknown): value is string;
export declare function openCodeApiPasswordFromEnv(env: NodeJS.ProcessEnv): string | null;
//# sourceMappingURL=opencode-launch-trust.d.ts.map