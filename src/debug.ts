/**
 * Opt-in debug logging for the borg CLI (Queen observability ask — surface
 * exactly what failed on errors like the cross-account assimilate 404).
 *
 * Enabled by `--debug` on the command line OR a truthy `BORG_DEBUG` env var,
 * wired at the CLI entry points (top-level `borg` dispatcher + `borg setup`
 * + `borg assimilate`). When on, `authedFetch` (remote-client.ts) emits one
 * line per HTTP request + the server error body on failure.
 *
 * Output goes to STDERR with a `[borg:debug]` prefix so it never contaminates
 * STDOUT (the MCP / tool output stream a drone session proxies).
 *
 * HARD INVARIANT: debug output must NEVER contain token material — no
 * Authorization header, id_token, or refresh_token. Call sites log only
 * method / path / status / server-error-body; the Bearer token is omitted.
 */

let debugEnabled = false;

/** Enable or disable debug logging for the lifetime of the process. */
export function setDebug(on: boolean): void {
  debugEnabled = on;
}

/** Whether debug logging is currently enabled. */
export function isDebug(): boolean {
  return debugEnabled;
}

/**
 * Emit a debug line to STDERR with the `[borg:debug]` prefix. No-op when
 * debug is disabled, so call sites need not guard. STDOUT is left clean for
 * MCP / tool output.
 */
export function debugLog(...args: unknown[]): void {
  if (!debugEnabled) return;
  if (args.length > 0 && typeof args[0] === 'string') {
    console.error(`[borg:debug] ${args[0]}`, ...args.slice(1));
  } else {
    console.error('[borg:debug]', ...args);
  }
}

/**
 * Resolve debug state from a process argv array + `BORG_DEBUG` at a CLI entry
 * point. Enables debug when `--debug` is present OR `BORG_DEBUG` is truthy,
 * then STRIPS every `--debug` token from the array IN PLACE so downstream
 * subcommand parsers (which reject unknown flags) never see it. Idempotent —
 * safe to call from more than one entry point in the same process.
 */
export function initDebugFromArgv(argv: string[]): void {
  const hasFlag = argv.includes('--debug');
  if (hasFlag || isTruthyEnv(process.env.BORG_DEBUG)) {
    setDebug(true);
  }
  if (hasFlag) {
    for (let i = argv.length - 1; i >= 0; i -= 1) {
      if (argv[i] === '--debug') argv.splice(i, 1);
    }
  }
}

/** A non-empty env value other than the common falsy spellings is truthy. */
function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

/** Test hook: reset module-level debug state between tests. */
export function _resetDebugForTests(): void {
  debugEnabled = false;
}
