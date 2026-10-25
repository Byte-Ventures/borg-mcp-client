import type { ChildProcess } from 'node:child_process';

export type ChildCompletion =
  | { kind: 'error'; error: Error }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null };

/** Capture termination before launch-time async work can hide an early exit.
 * Resolve errors as data so callers may safely attach after admission settles. */
export function captureChildCompletion(child: ChildProcess): Promise<ChildCompletion> {
  return new Promise(resolve => {
    const onError = (error: Error) => { child.off('exit', onExit); resolve({ kind: 'error', error }); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      child.off('error', onError); resolve({ kind: 'exit', code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}
