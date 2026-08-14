import type { CloneArgs } from './parse-clone-args.js';
import type { QuickstartArgs } from './parse-quickstart-args.js';
import { type QuickstartRunOptions } from './quickstart-cmd.js';
export interface GitRunResult {
    status: number | null;
    stdout: string;
    stderr: string;
}
export interface CloneDeps {
    cwd: () => string;
    chdir: (path: string) => void;
    runSync: (cmd: string, args: string[], cwd?: string) => GitRunResult;
    pathExists: (path: string) => boolean;
    isDirectory: (path: string) => boolean;
    readDirectory: (path: string) => string[];
    createDirectory: (path: string) => boolean;
    removeTree: (path: string) => void;
    isTTY: () => boolean;
    quickstart: (cwd: string, args: QuickstartArgs, options: QuickstartRunOptions) => Promise<number>;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
}
export declare function buildDefaultCloneDeps(): CloneDeps;
export declare function validateCloneRepositoryUrl(value: string): {
    ok: true;
} | {
    ok: false;
    error: string;
};
export declare function runClone(args: CloneArgs, rawDeps: CloneDeps): Promise<number>;
//# sourceMappingURL=clone-cmd.d.ts.map