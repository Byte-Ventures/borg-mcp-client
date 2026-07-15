import { isBorgSession } from './launch-gate.js';

export const CLEAR_REWAKE_REMINDER =
  'Post-/clear recovery: full regen, drain the unread log; handle actionable cube entries, otherwise resume the work from before this wake.';

export interface ClearRewakeResult {
  exitCode: 0 | 2;
  stderr: string;
}

/**
 * Resolve the Claude `/clear` async-rewake response without consulting cube
 * state. The reminder is deliberately static: hook input can contain local
 * paths and session metadata, none of which may cross into stderr.
 */
export function evaluateClearRewake(
  raw: string,
  env: NodeJS.ProcessEnv = process.env
): ClearRewakeResult {
  if (!isBorgSession(env)) return { exitCode: 0, stderr: '' };

  let input: any;
  try {
    input = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return { exitCode: 0, stderr: '' };
  }

  if (input?.hook_event_name !== 'SessionStart' || input?.source !== 'clear') {
    return { exitCode: 0, stderr: '' };
  }

  return { exitCode: 2, stderr: `${CLEAR_REWAKE_REMINDER}\n` };
}
