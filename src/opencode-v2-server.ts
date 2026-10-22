import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import {
  type OpenCodeInstallation,
  verifyOpenCodeServerVersion,
} from './opencode-installation.js';

const MAX_READY_BYTES = 16_384;

export interface OpenCodeV2Server {
  readonly url: string;
  readonly pid: number | undefined;
  readonly version: string;
  /** In-memory only. Never put these headers in a binding or diagnostic. */
  headers(): Record<string, string>;
  /** Resolves when the child closes, including unexpected server failure. */
  readonly closed: Promise<void>;
  /** Idempotent; closes the ownership pipe, then terminates a stuck child. */
  close(): Promise<void>;
}

export interface StartOpenCodeV2ServerOptions {
  installation: OpenCodeInstallation;
  directory: string;
  env: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  spawnProcess?: typeof spawn;
  fetch?: typeof fetch;
}

/** Validate readiness before sending a credential to any reported endpoint. */
export function validateOpenCodeV2Endpoint(input: unknown): string {
  if (typeof input !== 'string') throw new Error('OpenCode 2 returned invalid server readiness.');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('OpenCode 2 returned invalid server readiness.'); }
  if (
    url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/'
  ) throw new Error('OpenCode 2 did not report a private loopback endpoint.');
  return url.origin;
}

/**
 * Uses the installed V2 executable, not Service.ensure(): Borg must never
 * replace or stop the user's shared OpenCode service. The stdin pipe is the
 * server lease and also closes automatically if this parent process dies.
 */
export async function startOpenCodeV2Server(options: StartOpenCodeV2ServerOptions): Promise<OpenCodeV2Server> {
  if (options.installation.major !== 2) throw new Error('The private server adapter requires OpenCode 2.');
  const password = randomBytes(32).toString('base64url');
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const controller = new AbortController();
  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 3_000;
  let child: ChildProcess;
  try {
    child = (options.spawnProcess ?? spawn)(options.installation.executable,
      ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {
        cwd: options.directory,
        env: { ...options.env, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
  } catch {
    throw new Error('OpenCode 2 private server could not start. No prompt was submitted.');
  }
  let done = false;
  let finishClosed: () => void;
  const closed = new Promise<void>((resolve) => { finishClosed = resolve; });
  child.once('close', () => { done = true; controller.abort(); finishClosed(); });
  // Keep an error listener after readiness too (for example, a failed kill).
  // Startup has its own listener that rejects the readiness promise.
  child.on('error', () => {});
  // Always drain both streams. Neither child output nor error messages are
  // safe diagnostics: they may contain a generated password or user config.
  child.stderr?.resume();
  child.stdin?.on('error', () => {});
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    controller.abort();
    if (done) return;
    child.stdin?.end();
    const terminate = setTimeout(() => { if (!done) child.kill('SIGTERM'); }, shutdownTimeoutMs);
    const force = setTimeout(() => { if (!done) child.kill('SIGKILL'); }, shutdownTimeoutMs * 2);
    try { await closed; } finally { clearTimeout(terminate); clearTimeout(force); }
  })();
  const timeout = setTimeout(() => controller.abort(), readyTimeoutMs);
  try {
    const url = await readReadiness(child, controller.signal);
    const response = await (options.fetch ?? fetch)(`${url}/api/info`, {
      headers: { Authorization: authorization }, signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error('OpenCode 2 private server authentication or readiness failed.');
    const info: unknown = await response.json();
    if (!info || typeof info !== 'object') throw new Error('OpenCode 2 returned invalid server identity.');
    const identity = info as { version?: unknown; pid?: unknown; capabilities?: unknown };
    verifyOpenCodeServerVersion(options.installation, identity.version);
    if (identity.pid !== child.pid || typeof child.pid !== 'number') {
      throw new Error('OpenCode 2 server identity does not match the launched process.');
    }
    if (done || controller.signal.aborted) throw new Error('OpenCode 2 exited before launch readiness.');
    return { url, pid: child.pid, version: options.installation.version, headers: () => ({ Authorization: authorization }), closed, close };
  } catch (error) {
    await close();
    if (error instanceof Error && 'code' in error && error.code === 'OPENCODE_EXECUTABLE_CHANGED') throw error;
    // Do not propagate fetch/spawn details (which can include credentials).
    throw new Error('OpenCode 2 private server could not start or verify its identity. No prompt was submitted.');
  } finally {
    clearTimeout(timeout);
  }
}

function readReadiness(child: ChildProcess, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout as Readable | null;
    const stdin = child.stdin as Writable | null;
    if (!stdout || !stdin) { reject(new Error('OpenCode 2 ownership pipes are missing.')); return; }
    let buffer = '';
    let bytes = 0;
    const cleanup = () => {
      child.off('error', failed);
      child.off('close', failed);
      stdout.off('data', data);
      // Drain subsequent output without retaining it.
      stdout.resume();
      signal.removeEventListener('abort', failed);
    };
    const failed = () => { cleanup(); reject(new Error('OpenCode 2 did not become ready.')); };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_READY_BYTES) { failed(); return; }
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const ready = JSON.parse(buffer.slice(0, newline)) as { url?: unknown };
        const url = validateOpenCodeV2Endpoint(ready?.url);
        cleanup();
        resolve(url);
      } catch { failed(); }
    };
    child.once('error', failed);
    child.once('close', failed);
    stdout.on('data', data);
    signal.addEventListener('abort', failed, { once: true });
    if (signal.aborted) failed();
  });
}
