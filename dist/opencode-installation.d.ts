export type OpenCodeGeneration = 1 | 2;
export interface OpenCodeVersion {
    version: string;
    major: OpenCodeGeneration;
    minor: number;
    patch: number;
    prerelease: string | null;
}
export interface OpenCodeInstallation extends OpenCodeVersion {
    /** Resolve once per launch; never rediscover PATH between version and spawn. */
    executable: string;
}
export declare class OpenCodeInstallationError extends Error {
    readonly code = "OPENCODE_INSTALLATION";
}
export declare class OpenCodeExecutableChangedError extends Error {
    readonly code = "OPENCODE_EXECUTABLE_CHANGED";
    constructor();
}
/** Both published formats exist: `1.19.3` and `opencode v2.1.2`. */
export declare function parseOpenCodeVersion(output: string): OpenCodeVersion;
export interface InspectOpenCodeDeps {
    resolveExecutable(env: NodeJS.ProcessEnv): string;
    readVersion(executable: string, env: NodeJS.ProcessEnv): string;
}
/** No global cache: an upgrade or PATH change is observed on the next launch. */
export declare function inspectOpenCodeInstallation(env?: NodeJS.ProcessEnv, deps?: InspectOpenCodeDeps): OpenCodeInstallation;
export declare function verifyOpenCodeServerVersion(installation: OpenCodeInstallation, version: unknown): void;
//# sourceMappingURL=opencode-installation.d.ts.map