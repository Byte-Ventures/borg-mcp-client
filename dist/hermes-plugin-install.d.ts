export declare const HERMES_PLUGIN_NAME = "borg-representative-push";
/** Exactly the shipped files; nothing else in the source directory is copied. */
export declare const HERMES_PLUGIN_FILES: readonly ["plugin.yaml", "__init__.py"];
export interface HermesPluginInstallDeps {
    env: NodeJS.ProcessEnv;
    homedir(): string;
    /** Directory holding the packaged plugin files. */
    sourceDir: string;
    stdout(text: string): void;
    stderr(text: string): void;
}
export declare function packagedHermesPluginDir(): string;
export declare function defaultHermesPluginInstallDeps(): HermesPluginInstallDeps;
export declare function hermesPluginConfigSnippet(): string;
export declare function runHermesPluginInstall(command: {
    hermesHome?: string;
    force: boolean;
}, deps: HermesPluginInstallDeps): Promise<number>;
//# sourceMappingURL=hermes-plugin-install.d.ts.map