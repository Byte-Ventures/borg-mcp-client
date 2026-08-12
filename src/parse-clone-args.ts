import { redactCloneSecrets } from './clone-security.js';

export interface CloneArgs {
  repositoryUrl: string;
  destination?: string;
  noLaunch: boolean;
}

export type ParseCloneResult =
  | { ok: true; args: CloneArgs }
  | { ok: false; error: string };

export function parseCloneArgs(rawArgs: readonly string[]): ParseCloneResult {
  let repositoryUrl: string | undefined;
  let destination: string | undefined;
  let noLaunch = false;
  for (const arg of rawArgs) {
    if (arg === '--no-launch') {
      if (noLaunch) return { ok: false, error: '--no-launch was provided more than once' };
      noLaunch = true;
      continue;
    }
    if (arg.startsWith('-')) {
      const option = arg.startsWith('--') ? arg.split('=', 1)[0] : arg.slice(0, 2);
      return { ok: false, error: `unknown option ${option}; the only option is --no-launch` };
    }
    if (repositoryUrl === undefined) repositoryUrl = arg;
    else if (destination === undefined) destination = arg;
    else return { ok: false, error: 'unexpected extra argument' };
  }
  if (!repositoryUrl) return { ok: false, error: 'a repository URL is required' };
  return {
    ok: true,
    args: {
      repositoryUrl,
      ...(destination === undefined ? {} : { destination }),
      noLaunch,
    },
  };
}

export function safeCloneParseError(result: Extract<ParseCloneResult, { ok: false }>): string {
  return redactCloneSecrets(result.error);
}
