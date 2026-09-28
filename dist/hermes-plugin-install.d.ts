export declare const HERMES_PLUGIN_NAME = "borg-representative-push";
/** Exactly the shipped files; nothing else in the source directory is copied. */
export declare const HERMES_PLUGIN_FILES: readonly ["plugin.yaml", "__init__.py"];
export declare const HERMES_MCP_SERVER_NAME = "borg-representative";
export declare const SESSION_KEY_PATTERN: RegExp;
export declare const BACKUPS_KEPT = 5;
/** 5.x plugin settings that v2 no longer reads. */
export declare const LEGACY_SETTING_KEYS: string[];
export interface HermesCliResult {
    code: number;
    stdout: string;
    stderr: string;
}
/** Runs one `hermes <argv>` for one Hermes home. */
export type HermesCli = (argv: readonly string[]) => Promise<HermesCliResult>;
export interface HermesPluginDeps {
    env: NodeJS.ProcessEnv;
    homedir(): string;
    /** Directory holding the packaged plugin files. */
    sourceDir: string;
    /** The Hermes CLI for one home; every call carries HERMES_HOME=<home>. */
    hermes(home: string): HermesCli;
    /** Absolute path of the borg executable written into the MCP entry and the plugin. */
    borgCommand(): string;
    /**
     * Worktrees of the saved representative bindings. `initialize` imports 5.x
     * state first when no state exists; without it an uninitialized state is null.
     */
    bindings(options: {
        initialize: boolean;
    }): Promise<string[] | null>;
    isTTY(): boolean;
    /** Reads one answer line from the terminal; null on EOF. */
    prompt(question: string): Promise<string | null>;
    now(): Date;
    /** Pending-activation records (Borg's own state, never Hermes config). */
    activation: ActivationStore;
    stdout(text: string): void;
    stderr(text: string): void;
}
export interface HermesPluginInstallCommand {
    hermesHome?: string;
    worktree?: string;
    sessionKey?: string;
    dryRun: boolean;
    noRestart: boolean;
}
export interface HermesPluginUninstallCommand {
    hermesHome?: string;
    dryRun: boolean;
    noRestart: boolean;
}
export declare function packagedHermesPluginDir(): string;
/**
 * execFile, never a shell. The allow-all switches are removed from the child
 * environment so `config get` reports Hermes's own `.env`, not this shell.
 */
export declare function execFileHermesCli(command: string, home: string, env: NodeJS.ProcessEnv, options?: {
    timeoutMs?: number;
}): HermesCli;
export declare function defaultBorgCommand(): string;
export declare function defaultHermesPluginDeps(): HermesPluginDeps;
export declare class HermesPluginError extends Error {
}
/** Control, C1 and bidirectional-override characters are removed before anything untrusted is printed. */
export declare function printableUntrusted(text: string, max?: number): string;
export declare function resolveHermesHome(explicit: string | undefined, deps: Pick<HermesPluginDeps, 'env' | 'homedir'>): string;
/** The value text for `hermes config set`: containers and booleans as JSON, strings raw. */
export declare function configSetText(value: unknown): string;
/**
 * `<borg config>/hermes-plugin/<sha256(home)>.json` exists while an activation
 * step is pending:
 * - gateway_pending: config was written (or --no-restart was used) and the
 *   gateway has not been seen to load it. gateway_pid is the gateway PID at
 *   write time, so a later run can tell that a hand-started gateway was
 *   restarted since.
 * - desktop_reload: the Borg MCP entry changed, and a running Hermes Desktop
 *   keeps the previous one until /reload-mcp or a restart. Borg cannot confirm
 *   that step; the next run that finds the entry unchanged clears it.
 */
export interface ActivationRecord {
    version: 1;
    hermes_home: string;
    gateway_pending: boolean;
    gateway_pid: string | null;
    desktop_reload: boolean;
}
export interface ActivationStore {
    read(home: string): Promise<ActivationRecord | null>;
    write(record: ActivationRecord): Promise<void>;
    clear(home: string): Promise<void>;
}
export declare function fileActivationStore(dir: string): ActivationStore;
export declare function hermesPluginDir(home: string): string;
export interface SessionCandidate {
    sessionKey: string;
    label: string;
}
export declare function discoverSessionKeys(home: string): Promise<SessionCandidate[] | 'unavailable'>;
export declare function platformOf(sessionKey: string): string;
export type GatewaySupervision = {
    kind: 'service';
    pid: string | null;
} | {
    kind: 'manual';
    pid: string | null;
} | {
    kind: 'multiplexed';
} | {
    kind: 'stopped';
} | {
    kind: 'unknown';
};
/**
 * The gateway's supervision state from the documented `hermes gateway status`
 * ("Show service status"). Its text is not a machine contract, so only the
 * positive service-managed lines count as supervised; anything unrecognised is
 * `unknown`, and Borg never restarts an unknown gateway.
 */
export declare function parseGatewayStatus(stdout: string): GatewaySupervision;
export declare function runHermesPluginInstall(command: HermesPluginInstallCommand, deps: HermesPluginDeps): Promise<number>;
/**
 * `borg update`: activate the installed plugin (Borg's plugin.yaml is the
 * marker). Without it this does nothing and runs no hermes command. The caller
 * reports a non-zero result as an incomplete activation, never as a failed update.
 */
export declare function activateHermesPlugin(deps: HermesPluginDeps): Promise<number>;
export interface HermesPluginStatus {
    installed: boolean;
    hermes_home: string;
    /** Configured, but the gateway has not been seen to load it yet. */
    activation_pending?: boolean;
    /**
     * The Borg MCP entry changed; a running Hermes Desktop keeps the previous one
     * until /reload-mcp or a Desktop restart. Borg cannot confirm this step.
     */
    desktop_reload_pending?: boolean;
    session_key?: string | null;
    /** Allow-all switches that open the gateway to anyone; empty when none. */
    open_gateway?: string[];
    error?: string;
}
/**
 * For `borg representative status`: whether the plugin is installed and, when
 * it is, its activation state and the open-gateway report read through
 * `hermes config get`. Without an install no hermes command runs.
 */
export declare function hermesPluginStatus(deps: Pick<HermesPluginDeps, 'env' | 'homedir' | 'hermes' | 'activation'>): Promise<HermesPluginStatus>;
export declare function runHermesPluginUninstall(command: HermesPluginUninstallCommand, deps: HermesPluginDeps): Promise<number>;
//# sourceMappingURL=hermes-plugin-install.d.ts.map