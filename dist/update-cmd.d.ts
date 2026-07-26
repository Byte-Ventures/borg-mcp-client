declare const CLIENT_PACKAGE = "borgmcp";
declare const SERVER_PACKAGE = "borgmcp-server";
export interface PublishedPackage {
    name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE;
    version: string;
    integrity: string;
    sharedVersion: string;
}
export interface InstalledPackage {
    name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE;
    version: string;
    sharedVersion: string;
    packageRoot: string;
    binPath: string;
}
export interface UpdateTarget {
    clientVersion: string;
    serverVersion: string;
    serverPresent?: boolean;
}
export interface UpdateOptions {
    yes: boolean;
    help?: boolean;
    target?: UpdateTarget;
}
export type ParsedUpdateArgs = ({
    ok: true;
} & UpdateOptions) | {
    ok: false;
    error: string;
};
export interface UpdateDeps {
    currentClient(): Promise<InstalledPackage>;
    currentServer(): Promise<InstalledPackage | null>;
    publishedPackage(name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE, version: string): Promise<PublishedPackage>;
    installGlobal(name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE, version: string): Promise<void>;
    reenter(binPath: string, args: readonly string[]): Promise<number>;
    serverJson(binPath: string, command: 'update' | 'status'): Promise<unknown>;
    verifyRunningProtocol(origin: string): Promise<void>;
    confirm(message: string): Promise<'yes' | 'no' | 'eof' | 'interrupted'>;
    isTTY(): boolean;
    stdout(text: string): void;
    stderr(text: string): void;
    calls?: string[];
}
export declare function parseUpdateArgs(args: readonly string[], reentryAuthorized?: boolean): ParsedUpdateArgs;
export declare function runUpdate(options: UpdateOptions, deps: UpdateDeps): Promise<number>;
export declare function inspectNpmPackageAt(input: {
    name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE;
    binName: 'borg' | 'borg-mcp-server';
    npmRoot: string;
    commandPath: string;
    invokedPath?: string;
}): Promise<InstalledPackage>;
export declare function buildDefaultUpdateDeps(): UpdateDeps;
export declare function runEarlyUpdate(argv: readonly string[], deps?: UpdateDeps): Promise<number | null>;
export {};
//# sourceMappingURL=update-cmd.d.ts.map