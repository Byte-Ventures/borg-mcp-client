/** Pure argument parsing for `borg clone <repo-url>`. */

import { redactCloneSecrets } from './clone-security.js';

export interface CloneFlags {
  destination?: string;
  name?: string;
  branch?: string;
  noLaunch: boolean;
}

export interface CloneArgs {
  repositoryUrl: string;
  flags: CloneFlags;
}

export type ParseCloneResult =
  | { ok: true; args: CloneArgs }
  | { ok: false; error: string };

function valueFor(
  rawArgs: readonly string[],
  index: number,
  flag: string,
): { value: string } | { error: string } {
  const value = rawArgs[index + 1];
  if (value === undefined || value.startsWith('--')) {
    return { error: `${flag} requires a value` };
  }
  if (value.length === 0) return { error: `${flag} requires a non-empty value` };
  return { value };
}

/** Parse clone args without touching the filesystem or spawning Git. */
export function parseCloneArgs(rawArgs: readonly string[]): ParseCloneResult {
  const flags: CloneFlags = { noLaunch: false };
  let repositoryUrl: string | undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--no-launch') {
      if (flags.noLaunch) return { ok: false, error: '--no-launch was provided more than once' };
      flags.noLaunch = true;
      continue;
    }

    const valueFlag = arg === '--destination' || arg === '--name' || arg === '--branch';
    if (valueFlag) {
      const result = valueFor(rawArgs, i, arg);
      if ('error' in result) return { ok: false, error: result.error };
      i++;
      const key = arg.slice(2) as 'destination' | 'name' | 'branch';
      if (flags[key] !== undefined) return { ok: false, error: `${arg} was provided more than once` };
      flags[key] = result.value;
      continue;
    }

    if (arg.startsWith('-')) {
      return {
        ok: false,
        error: `unknown option ${redactCloneSecrets(arg)}; supported options are --destination, --name, --branch, and --no-launch`,
      };
    }
    if (repositoryUrl !== undefined) {
      return { ok: false, error: `unexpected extra argument: ${redactCloneSecrets(arg)}` };
    }
    repositoryUrl = arg;
  }

  if (repositoryUrl === undefined) {
    return { ok: false, error: 'a repository URL is required' };
  }
  return { ok: true, args: { repositoryUrl, flags } };
}
