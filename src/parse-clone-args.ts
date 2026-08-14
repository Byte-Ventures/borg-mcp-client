import { redactCloneSecrets } from './clone-security.js';
import { parseQuickstartArgs, type QuickstartArgs } from './parse-quickstart-args.js';

export interface CloneArgs extends QuickstartArgs {
  repositoryUrl: string;
  destination?: string;
  checkoutOnly: boolean;
}

export type ParseCloneResult =
  | { ok: true; args: CloneArgs }
  | { ok: false; error: string };

export function parseCloneArgs(rawArgs: readonly string[]): ParseCloneResult {
  let repositoryUrl: string | undefined;
  let destination: string | undefined;
  let checkoutOnly = false;
  const quickstartArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === '--checkout-only' || arg === '--no-launch') {
      if (checkoutOnly) return { ok: false, error: 'checkout-only mode was provided more than once' };
      checkoutOnly = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      quickstartArgs.push(arg);
      continue;
    }
    if (arg === '--template' || arg === '--role') {
      quickstartArgs.push(arg);
      const value = rawArgs[++i];
      if (value !== undefined) quickstartArgs.push(value);
      continue;
    }
    if (arg.startsWith('-')) {
      return {
        ok: false,
        error: `unknown option ${redactCloneSecrets(arg)}; supported: --template, --role, --yes/-y, --checkout-only, --no-launch`,
      };
    }
    if (repositoryUrl === undefined) repositoryUrl = arg;
    else if (destination === undefined) destination = arg;
    else return { ok: false, error: 'unexpected extra argument' };
  }
  if (!repositoryUrl) return { ok: false, error: 'a repository URL is required' };
  if (checkoutOnly && quickstartArgs.length > 0) {
    return { ok: false, error: '--checkout-only/--no-launch cannot be combined with --template, --role, or --yes/-y' };
  }
  const parsedQuickstart = parseQuickstartArgs(quickstartArgs);
  if (!parsedQuickstart.ok) return parsedQuickstart;
  return {
    ok: true,
    args: {
      repositoryUrl,
      ...(destination === undefined ? {} : { destination }),
      checkoutOnly,
      ...parsedQuickstart.args,
    },
  };
}

export function safeCloneParseError(result: Extract<ParseCloneResult, { ok: false }>): string {
  return redactCloneSecrets(result.error);
}
