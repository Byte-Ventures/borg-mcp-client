import type { ChildProcess } from 'node:child_process';
export type ChildCompletion = {
    kind: 'error';
    error: Error;
} | {
    kind: 'exit';
    code: number | null;
    signal: NodeJS.Signals | null;
};
/** Capture termination before launch-time async work can hide an early exit.
 * Resolve errors as data so callers may safely attach after admission settles. */
export declare function captureChildCompletion(child: ChildProcess): Promise<ChildCompletion>;
//# sourceMappingURL=child-completion.d.ts.map