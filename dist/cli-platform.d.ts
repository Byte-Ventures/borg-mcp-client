import type { BorgCli } from './cubes.js';
export interface CliAvailability {
    claude: string | null;
    codex: string | null;
    opencode: string | null;
}
export interface CliChoiceDeps {
    detectCli: () => CliAvailability;
    getPreference: () => Promise<BorgCli | null>;
    setPreference: (cli: BorgCli) => Promise<void>;
    prompt: (message: string) => Promise<string>;
    isTTY: () => boolean;
}
export declare function detectCliAvailability(): CliAvailability;
export declare function installedCliNames(availability: CliAvailability): BorgCli[];
export declare function resolveCliChoice(explicit: BorgCli | undefined, deps: CliChoiceDeps): Promise<BorgCli>;
export declare function defaultCliChoiceDeps(prompt: (message: string) => Promise<string>, isTTY: () => boolean): CliChoiceDeps;
export declare function parseCliFlag(args: string[]): {
    cli?: BorgCli;
    rest: string[];
    error?: string;
};
//# sourceMappingURL=cli-platform.d.ts.map