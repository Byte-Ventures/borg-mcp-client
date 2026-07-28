import { type InstalledPackage, type PublishedPackage } from './update-cmd.js';
export type FirstRunServerInstallResult = {
    kind: 'present';
    server: InstalledPackage;
} | {
    kind: 'installed';
    server: InstalledPackage;
} | {
    kind: 'declined' | 'non-interactive' | 'failed';
};
export interface FirstRunServerInstallDeps {
    currentServer(): Promise<InstalledPackage | null>;
    publishedPackage(name: 'borgmcp' | 'borgmcp-server', version: string): Promise<PublishedPackage>;
    publishedVersions(name: 'borgmcp' | 'borgmcp-server'): Promise<string[]>;
    installGlobal(name: 'borgmcp' | 'borgmcp-server', version: string, options?: {
        ignoreScripts?: boolean;
    }): Promise<void>;
    confirm(message: string): Promise<'yes' | 'no' | 'eof' | 'interrupted'>;
    isTTY(): boolean;
    stdout(text: string): void;
    stderr(text: string): void;
    clientSharedVersion(): string;
}
export declare function buildDefaultFirstRunServerInstallDeps(): FirstRunServerInstallDeps;
/**
 * Offer the exact compatible server before first-run setup mutates state.
 * Returning anything except `present`/`installed` means no caller-owned setup
 * or assimilation work should continue.
 */
export declare function offerFirstRunServerInstall(deps?: FirstRunServerInstallDeps): Promise<FirstRunServerInstallResult>;
//# sourceMappingURL=first-run-server.d.ts.map