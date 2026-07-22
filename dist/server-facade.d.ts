import { type SpawnOptions } from 'node:child_process';
export declare const SERVER_LIFECYCLE_COMMANDS: readonly ["setup", "start", "stop", "status", "update", "invite"];
export type ServerLifecycleCommand = typeof SERVER_LIFECYCLE_COMMANDS[number];
export type ParsedServerFacadeArgs = {
    kind: 'help';
} | {
    kind: 'command';
    command: ServerLifecycleCommand;
    args: string[];
} | {
    kind: 'error';
    reason: 'unknown-command';
    command: string;
};
export declare function parseServerFacadeArgs(args: readonly string[]): ParsedServerFacadeArgs;
interface ServerFacadeChild {
    once(event: 'error', listener: (error: Error) => void): this;
    once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    kill(signal: NodeJS.Signals): boolean;
}
export interface ServerFacadeProcessDeps {
    spawn(command: string, args: readonly string[], options: Pick<SpawnOptions, 'shell' | 'stdio'>): ServerFacadeChild;
    addSignalListener(signal: NodeJS.Signals, listener: () => void): void;
    removeSignalListener(signal: NodeJS.Signals, listener: () => void): void;
}
export interface ServerFacadeOutputDeps {
    writeStdout(text: string): void;
    writeStderr(text: string): void;
}
export type ServerFacadeProcessResult = {
    kind: 'exited';
    code: number;
} | {
    kind: 'signaled';
    signal: NodeJS.Signals;
} | {
    kind: 'spawn-error';
    error: Error;
};
export declare function unknownServerCommandText(command: string): string;
export declare function missingServerExecutableText(command: ServerLifecycleCommand): string;
export declare function serverCommandStartupFailureText(command: ServerLifecycleCommand): string;
export declare function runServerFacadeProcess(input: {
    command: ServerLifecycleCommand;
    args: readonly string[];
}, deps?: ServerFacadeProcessDeps): Promise<ServerFacadeProcessResult>;
/** Routes every facade outcome before client initialization or network work. */
export declare function runEarlyServerFacade(argv: readonly string[], deps?: ServerFacadeProcessDeps, output?: ServerFacadeOutputDeps): Promise<number | null>;
export {};
//# sourceMappingURL=server-facade.d.ts.map