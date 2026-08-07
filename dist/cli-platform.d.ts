import type { BorgCli } from './cubes.js';
export interface CliAvailability {
    claude: string | null;
    codex: string | null;
    opencode: string | null;
}
export type CliConfiguration = Record<BorgCli, boolean>;
export interface CliChoiceDeps {
    detectCli: () => CliAvailability;
    detectConfigured: () => CliConfiguration;
    getPreference: () => Promise<BorgCli | null>;
    setPreference: (cli: BorgCli) => Promise<void>;
    prompt: (message: string) => Promise<string>;
    isTTY: () => boolean;
}
export declare function detectCliAvailability(): CliAvailability;
export declare function installedCliNames(availability: CliAvailability): BorgCli[];
export declare function detectCliConfiguration(): CliConfiguration;
export declare function configuredCliNames(availability: CliAvailability, configuration: CliConfiguration): BorgCli[];
export declare function resolveCliChoice(explicit: BorgCli | undefined, deps: CliChoiceDeps): Promise<BorgCli>;
export declare function defaultCliChoiceDeps(prompt: (message: string) => Promise<string>, isTTY: () => boolean): CliChoiceDeps;
export declare function parseCliFlag(args: string[]): {
    cli?: BorgCli;
    force?: boolean;
    noBorgApprovalOverride?: boolean;
    rest: string[];
    error?: string;
};
//# sourceMappingURL=cli-platform.d.ts.map