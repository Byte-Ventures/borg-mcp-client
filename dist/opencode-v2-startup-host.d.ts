import { startOpenCodeV2Server, type OpenCodeV2Server, type StartOpenCodeV2ServerOptions } from './opencode-v2-server.js';
type ServerOptions = Omit<StartOpenCodeV2ServerOptions, 'spawnProcess' | 'fetch' | 'signal'>;
export interface OpenCodeV2StartupHost {
    startServer(options: ServerOptions): Promise<OpenCodeV2Server>;
}
/** The supervisor owns both the mutex and the native process. Losing Borg's
 * IPC connection closes the native host BEFORE releasing startup exclusion.
 * After successful bootstrap, only the native process lease stays alive.
 * Credentials travel exclusively over the private parent/child IPC channel.
 */
export declare function withOpenCodeV2StartupHost<T>(operation: (host: OpenCodeV2StartupHost) => Promise<T>, options?: {
    root?: string;
    waitMs?: number;
    onQueued?: () => void;
    /** Dependency seam for the supervisor process lifecycle fixture. */
    worker?: URL;
}): Promise<T>;
/** Exported for a process fixture which supplies a controlled native server. */
export declare function runOpenCodeV2StartupHost(startServer?: typeof startOpenCodeV2Server): Promise<void>;
export {};
//# sourceMappingURL=opencode-v2-startup-host.d.ts.map