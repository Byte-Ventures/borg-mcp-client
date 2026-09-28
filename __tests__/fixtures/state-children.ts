/**
 * Spawns the state-suite child processes (representative-state-child.ts) and
 * guarantees none outlives its test: every child is tracked, and an afterEach
 * registered here kills and reaps whatever is still running, whether the test
 * passed, failed or was interrupted. Children also carry their own deadline
 * (STATE_CHILD_DEADLINE_MS, default 60 s) for any wait on a go-file.
 */
import { afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

export const CHILD_SCRIPT = resolve('__tests__/fixtures/representative-state-child.ts');
export interface ChildResult { code: number | null; signal: string | null; out: any; stderr: string } // eslint-disable-line @typescript-eslint/no-explicit-any

const running = new Set<ChildProcess>();

afterEach(async () => {
  const alive = [...running];
  running.clear();
  await Promise.all(alive.map((proc) => new Promise<void>((resolveExit) => {
    if (proc.exitCode !== null || proc.signalCode !== null) { resolveExit(); return; }
    proc.once('exit', () => resolveExit());
    proc.kill('SIGKILL');
  })));
});

export function spawnStateChild(args: string[], env: NodeJS.ProcessEnv): { pid: number; done: Promise<ChildResult> } {
  const proc = spawn(process.execPath, ['--import', 'tsx', CHILD_SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(proc);
  let stdout = '', stderr = '';
  proc.stdout!.on('data', (chunk) => { stdout += chunk; });
  proc.stderr!.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise<ChildResult>((resolveDone) => {
    proc.on('exit', (code, signal) => {
      running.delete(proc);
      const line = stdout.trim().split('\n').filter(Boolean).at(-1);
      let out: unknown = null;
      try { out = line ? JSON.parse(line) : null; } catch { out = line; }
      resolveDone({ code, signal, out, stderr });
    });
  });
  return { pid: proc.pid!, done };
}
