import { mkdirSync, chmodSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CodexAppServerClient } from './codex-app-server.js';
import { codexBorgSessionConfigArgs, BORG_SESSION_ENV } from './launch-gate.js';
import { codexAppServerSocketConfigArgs } from './codex-wake-resolve.js';
import {
  BORG_AGENT_KIND_ENV,
  BORG_CODEX_REMOTE_WAKE_ENV,
  codexAgentKindConfigArgs,
  codexRemoteWakeConfigArgs,
} from './agent-runtime.js';

/**
 * gh#528 — npm-managed Codex remote-wake.
 *
 * borg owns a per-launch DIRECT Codex app-server (`codex app-server --listen
 * unix://<socket>`) as the primary wake path, instead of the standalone
 * `codex app-server daemon start` (which only exists for standalone-installer
 * Codex — npm-managed Codex has no daemon, so those sessions had no push-wake
 * and relied on periodic log-drain catch-up). Per-launch direct
 * app-server works for both install kinds and starts fresh each launch (so it
 * always loads the current borgmcp MCP — no daemon-restart version refresh
 * needed). The TUI is then launched with `codex --remote unix://<socket>` and
 * Borg delivers wakes by connecting to that socket (see codex-app-wake.ts).
 */

export interface CodexAppServerHandle {
  pid: number | undefined;
  socketPath: string;
  /** Kill the owned app-server + remove its socket/pidfile. Wire to TUI exit. */
  cleanup: () => void;
}

export interface CodexRemoteLaunch {
  args: string[];
  env: Record<string, string>;
  warning?: string;
  /** Present when borg owns a per-launch app-server that must be cleaned up on TUI exit. */
  server?: CodexAppServerHandle;
}

export interface CodexChild {
  pid: number | undefined;
  kill: () => void;
  /** Snapshot app-server exit state + bounded stderr captured by the production spawn. */
  diagnostics?: () => CodexChildDiagnostics;
}

export interface CodexChildDiagnostics {
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  error?: string | null;
  stderr: string;
}

export interface PrepareCodexRemoteDeps {
  /** Spawn the long-lived `codex app-server --listen unix://<socketPath>` child. */
  spawnAppServer: (socketPath: string) => CodexChild;
  /** Readiness probe: a real CodexAppServerClient connect + thread/loaded/list round-trip. */
  probeReady: (socketPath: string) => Promise<boolean>;
  /** Delay between readiness polls (injected so tests don't actually wait). */
  sleep: (ms: number) => Promise<void>;
  /** 0700 runtime dir (default ~/.config/borgmcp/codex-remote). */
  runtimeDir?: string;
  /** Unique socket id generator (default 32-hex). Injected for deterministic tests. */
  socketId?: () => string;
  /** Readiness timeout (default 30000ms) + poll interval (default 250ms). */
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Whether a pid is alive (default process.kill(pid, 0)). Injected for tests. */
  isAlive?: (pid: number) => boolean;
}

export const DEFAULT_CODEX_REMOTE_DIR = join(homedir(), '.config', 'borgmcp', 'codex-remote');
const DEFAULT_CODEX_REMOTE_READY_TIMEOUT_MS = 30_000;
const MAX_CODEX_APP_SERVER_STDERR_CHARS = 16_384;

/**
 * Keep app-server failure details useful without copying credentials or local
 * filesystem locations into the parent process warning.
 */
function sanitizeCodexDiagnostic(input: string): string {
  let sanitized = String(input).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  sanitized = sanitized.replace(
    /\b((?:authorization\s*:\s*)?bearer)\s+[^\s,;]+/gi,
    '$1 <REDACTED>'
  );
  sanitized = sanitized.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
    '$1<REDACTED>@'
  );
  sanitized = sanitized.replace(
    /([?&](?:access_token|auth_token|id_token|refresh_token|session_token|token|api_key|apikey|secret|password)=)[^&#\s]*/gi,
    '$1<REDACTED>'
  );
  sanitized = sanitized.replace(
    /\b((?:[a-z0-9_-]*(?:token|secret|password)|api[_-]?key)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    '$1<REDACTED>'
  );
  sanitized = sanitized.replace(
    /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    '<REDACTED>'
  );
  sanitized = sanitized.replace(
    /(^|[\s("'=])(?:file:\/\/)?\/(?:Users|home|private|tmp|var|etc|opt|Volumes)\/[^\s"'`<>)}\]]+/gm,
    '$1<REDACTED_PATH>'
  );
  sanitized = sanitized.replace(
    /\b[A-Za-z]:\\(?:Users|Documents and Settings|ProgramData|Temp)\\[^\s"'`<>)}\]]+/g,
    '<REDACTED_PATH>'
  );
  return sanitized.slice(-MAX_CODEX_APP_SERVER_STDERR_CHARS);
}

export function withCodexCwdArg(args: string[], cwd: string): string[] {
  if (hasCodexCwdArg(args)) return args;
  return ['--cd', cwd, ...args];
}

function hasCodexCwdArg(args: string[]): boolean {
  return args.some((arg) => arg === '--cd' || arg.startsWith('--cd=') || arg === '-C');
}

export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM ⇒ the process exists but we can't signal it (still alive).
    return err?.code === 'EPERM';
  }
}

/**
 * gh#633: process-liveness probe for the borg-owned codex app-server — the
 * transport-agnostic analogue of the claude tail-F Monitor's pgrep check
 * (checkInboxMonitorHealthy / stream-status.ts:48). Codex drones wake via this
 * app-server bridge, NOT a tail-F Monitor, so wake_path_client_monitor_armed is
 * false-by-design for them; the HOP-2 wake-path-deaf classifier mis-read that
 * as deaf (gh#633). This gives HOP-2 the codex wake path's ACTUAL health.
 *
 * Uses the app-server PIDFILE (written at spawn, beside the socket) +
 * process.kill(pid, 0) — NOT pgrep. The codex TUI is also launched
 * `codex --remote unix://<socketPath>`, so a `pgrep -f <socketPath>` would ALSO
 * match the live TUI and FALSE-ARM when the app-server has crashed but the TUI
 * still runs (the deaf-but-alive case). The pidfile holds the EXACT app-server
 * pid, so kill(0) reflects the app-server's liveness specifically — and it's
 * cheaper than pgrep (no subprocess). Mirrors pruneStaleSockets' pid check.
 *
 * Tri-state (mirrors checkInboxMonitorHealthy's boolean|null contract):
 *   - true:  pidfile resolves to a LIVE pid → app-server (bridge) is up → armed.
 *   - false: pidfile resolves to a DEAD pid → an unclean exit (crash/kill -9)
 *            left a stale pidfile (cleanup never ran) → bridge down → HOP-2
 *            correctly flags a genuinely-deaf codex drone (no SLI-lie).
 *   - null:  pidfile missing / unreadable / unparseable → cannot determine →
 *            caller maps null→armed (false-deaf-avoidance, same as the claude
 *            monitor branch). A CLEAN app-server exit removes the pidfile, but
 *            then the drone is shutting down → the silent-stall watchdog
 *            backstops it via a separate layer.
 *
 * Residual (negligible, gh#633 / Coordinator 6f28fe3f): PID reuse — if the
 * crashed app-server's pid is recycled by an unrelated process before the next
 * launch's pruneStaleSockets removes the stale pidfile, kill(0) reports alive →
 * a brief false-arm. The window is tiny (exact-pid reuse during the crash gap)
 * and self-heals on the next launch's prune; far smaller than existsSync's
 * always-on stale-file masking.
 */
export function checkCodexBridgeHealthy(
  socketPath: string | null,
  deps: {
    isAlive?: (pid: number) => boolean;
    readPidFile?: (pidPath: string) => string;
  } = {}
): boolean | null {
  if (!socketPath) return null;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const readPidFile =
    deps.readPidFile ?? ((pidPath: string) => readFileSync(pidPath, 'utf-8'));
  const pidPath = socketPath.replace(/\.sock$/, '.pid');
  try {
    const pid = Number.parseInt(readPidFile(pidPath).trim(), 10);
    if (Number.isNaN(pid)) return null;
    return isAlive(pid);
  } catch {
    return null;
  }
}

function safeRm(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    // best-effort
  }
}

/**
 * Remove sockets in the owned dir whose owning app-server pid is no longer
 * alive (crashed prior launches), leaving live concurrent sessions' sockets
 * untouched. Operates ONLY inside the borg-owned runtime dir.
 */
function pruneStaleSockets(runtimeDir: string, isAlive: (pid: number) => boolean): void {
  let entries: string[];
  try {
    entries = readdirSync(runtimeDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.pid')) continue;
    const pidPath = join(runtimeDir, name);
    const sockPath = join(runtimeDir, name.replace(/\.pid$/, '.sock'));
    let pid: number;
    try {
      pid = Number.parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    } catch {
      safeRm(pidPath);
      continue;
    }
    if (Number.isNaN(pid) || !isAlive(pid)) {
      safeRm(sockPath);
      safeRm(pidPath);
    }
  }
}

function failLoud(reason: string): CodexRemoteLaunch {
  return { args: [], env: {}, warning: reason };
}

function formatExitReason(diagnostics: CodexChildDiagnostics): string {
  if (diagnostics.error) return `process error: ${sanitizeCodexDiagnostic(diagnostics.error)}`;
  if (diagnostics.exitCode != null) return `exit code ${diagnostics.exitCode}`;
  if (diagnostics.signal) return `signal ${diagnostics.signal}`;
  return 'unknown exit status';
}

function formatStderr(stderr: string): string {
  const trimmed = sanitizeCodexDiagnostic(stderr).trim();
  return trimmed ? ` Stderr: ${trimmed}` : '';
}

/**
 * Start a borg-owned per-launch Codex app-server, probe it for readiness, and
 * return the `--remote` launch args + an owned handle (or a fail-loud warning).
 * Async + lifecycle-owning: the caller MUST call `result.server?.cleanup()` on
 * TUI exit.
 */
export async function prepareCodexRemoteLaunch(
  deps: PrepareCodexRemoteDeps
): Promise<CodexRemoteLaunch> {
  const runtimeDir = deps.runtimeDir ?? DEFAULT_CODEX_REMOTE_DIR;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_CODEX_REMOTE_READY_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? 250;

  // 1. 0700 owned dir + prune crashed prior sockets (concurrent-safe via pid liveness).
  try {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    chmodSync(runtimeDir, 0o700); // enforce 0700 even if it pre-existed with looser perms
    pruneStaleSockets(runtimeDir, isAlive);
  } catch (err: any) {
    return failLoud(
      `Codex remote-wake disabled: could not prepare ${runtimeDir} (${err?.message ?? err}); run borg_regen manually.`
    );
  }

  // 2. unique, non-predictable socket path inside the owned dir.
  const id = (deps.socketId ?? (() => randomBytes(16).toString('hex')))();
  const socketPath = join(runtimeDir, `${id}.sock`);
  const pidPath = join(runtimeDir, `${id}.pid`);

  // 3. spawn the long-lived app-server.
  let child: CodexChild;
  try {
    child = deps.spawnAppServer(socketPath);
  } catch (err: any) {
    safeRm(socketPath);
    return failLoud(
      `Codex remote-wake disabled: could not start \`codex app-server\` (${sanitizeCodexDiagnostic(String(err?.message ?? err))}) — ` +
        `confirm the Codex executable is installed and available on PATH. ` +
        `Remote wake is unavailable for this session; run borg_regen manually to catch up.`
    );
  }
  if (child.pid != null) {
    try {
      writeFileSync(pidPath, String(child.pid));
    } catch {
      // pidfile is only for stale-prune; launch still proceeds.
    }
  }

  const cleanup = () => {
    try {
      child.kill();
    } catch {
      // best-effort
    }
    safeRm(socketPath);
    safeRm(pidPath);
  };

  // 4. readiness via a real protocol round-trip — bounded attempts (no clock dep).
  const attempts = Math.max(1, Math.ceil(readyTimeoutMs / pollIntervalMs));
  let ready = false;
  let exitDiagnostics: CodexChildDiagnostics | undefined;
  for (let i = 0; i < attempts && !ready; i++) {
    try {
      ready = await deps.probeReady(socketPath);
    } catch {
      ready = false;
    }
    if (!ready) {
      const diagnostics = child.diagnostics?.();
      if (diagnostics?.exited) {
        exitDiagnostics = diagnostics;
        break;
      }
    }
    if (!ready && i < attempts - 1) await deps.sleep(pollIntervalMs);
  }

  if (!ready) {
    const diagnostics = exitDiagnostics ?? child.diagnostics?.();
    cleanup();
    if (diagnostics?.exited) {
      return failLoud(
        `Codex remote-wake disabled: \`codex app-server\` exited before becoming ready ` +
          `(${formatExitReason(diagnostics)}).${formatStderr(diagnostics.stderr)} ` +
          `Run borg_regen manually to catch up.`
      );
    }
    return failLoud(
      `Codex remote-wake disabled: \`codex app-server\` remained running but did not become ready ` +
        `at ${sanitizeCodexDiagnostic(socketPath)} within ${readyTimeoutMs}ms.${formatStderr(diagnostics?.stderr ?? '')} ` +
        `Run borg_regen manually to catch up.`
    );
  }

  // 5. ready → owned remote launch.
  return {
    args: ['--remote', `unix://${socketPath}`],
    env: { [BORG_CODEX_REMOTE_WAKE_ENV]: '1' },
    server: { pid: child.pid, socketPath, cleanup },
  };
}

/**
 * Production deps for prepareCodexRemoteLaunch — spawn the real `codex
 * app-server` child + probe it with the real CodexAppServerClient. Shared by
 * claude.ts and assimilate-deps.ts so there's ONE wiring.
 *
 * The readiness probe uses Codex app-server RPCs ONLY (connect + thread/loaded/
 * list) — it never calls a borg /api/drone/* endpoint — so it can never advance
 * last_seen/last_regen_at and mask a deaf Codex (the gh#46/gh#406 signal-truth
 * invariant; the app-server socket is the wake-DELIVERY wire, not a liveness
 * signal).
 */
export function defaultCodexRemoteDeps(): Pick<
  PrepareCodexRemoteDeps,
  'spawnAppServer' | 'probeReady' | 'sleep'
> {
  return {
    spawnAppServer: (socketPath) => {
      // gh#851: this app-server — NOT the `codex --remote` TUI — spawns the
      // borg-mcp MCP child, so the BORG_SESSION activation marker (gh#673) must
      // ride HERE too, or the child gates dormant. Load-bearing = the `-c
      // mcp_servers.borg.env.BORG_SESSION="1"` override (codex MCP children read
      // only the pinned env, injected via the app-server's -c — same V2b
      // mechanism the TUI launch uses, applied at the app-server boundary). The
      // env BORG_SESSION=1 is a defensive belt (inherited env never reaches the
      // codex MCP child by itself). Still activation-only per the launch-gate
      // SR-BINDING — never a security/access signal.
      //
      // gh#855: pin THIS app-server's live socket into the same child env via the
      // same `-c` channel, so the waking borg-mcp child is authoritative about
      // its OWN socket and re-resolves the loaded thread FRESH each wake — a
      // missed/stale launch probe can no longer cause permanent deafness. The
      // socketPath is borg-generated (randomBytes), never user input, TOML-quoted
      // exactly like the BORG_SESSION override — zero injection surface.
      const child = spawn(
        'codex',
        [
          'app-server',
          ...codexBorgSessionConfigArgs(),
          ...codexAgentKindConfigArgs(),
          ...codexRemoteWakeConfigArgs(),
          ...codexAppServerSocketConfigArgs(socketPath),
          '--listen',
          `unix://${socketPath}`,
        ],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          shell: false,
          env: {
            ...process.env,
            [BORG_SESSION_ENV]: '1',
            [BORG_AGENT_KIND_ENV]: 'codex',
            [BORG_CODEX_REMOTE_WAKE_ENV]: '1',
          },
        }
      );
      let stderr = '';
      let exited = false;
      let exitCode: number | null = null;
      let signal: string | null = null;
      let error: string | null = null;
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string | Buffer) => {
        stderr = `${stderr}${String(chunk)}`.slice(-MAX_CODEX_APP_SERVER_STDERR_CHARS);
      });
      // `close` follows stdio drain; using it instead of `exit` keeps the final
      // stderr chunk available when readiness reports the child failure.
      child.once('close', (code, exitSignal) => {
        exited = true;
        exitCode = code;
        signal = exitSignal;
      });
      child.once('error', (childError) => {
        exited = true;
        error = sanitizeCodexDiagnostic(childError.message);
      });
      return {
        pid: child.pid,
        kill: () => {
          try {
            child.kill();
          } catch {
            // best-effort
          }
        },
        diagnostics: () => ({
          exited,
          exitCode,
          signal,
          error: error == null ? null : sanitizeCodexDiagnostic(error),
          stderr: sanitizeCodexDiagnostic(stderr),
        }),
      };
    },
    probeReady: async (socketPath) => {
      const probe = new CodexAppServerClient(socketPath);
      try {
        await probe.connect();
        await probe.loadedThreadIds();
        return true;
      } catch {
        return false;
      } finally {
        try {
          probe.close();
        } catch {
          // best-effort
        }
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
