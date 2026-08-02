import { normalizeServerEndpoint } from './server-endpoint.js';
import { clearEnrollmentTransaction, findPendingServerEnrollment } from './config.js';
import { clearBorgServerTrust } from './server-trust.js';

export interface RecoverEnrollmentFlags {
  host?: string;
  yes: boolean;
}

export function parseRecoverEnrollmentArgs(argv: string[]):
  { ok: true; flags: RecoverEnrollmentFlags } | { ok: false; error: string } {
  let host: string | undefined;
  let yes = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--yes' || arg === '-y') { yes = true; continue; }
    if (arg === '--host' || arg === '-h') {
      const value = argv[++index];
      if (!value) return { ok: false, error: 'missing value for --host' };
      host = value;
      continue;
    }
    if (arg?.startsWith('--host=')) { host = arg.slice('--host='.length); continue; }
    if (arg === '--help') return { ok: false, error: 'help' };
    return { ok: false, error: `unexpected argument: ${arg}` };
  }
  return { ok: true, flags: { ...(host === undefined ? {} : { host }), yes } };
}

export async function runRecoverEnrollment(
  flags: RecoverEnrollmentFlags,
  deps: { prompt: (message: string) => Promise<string>; stderr: (line: string) => void; stdout: (line: string) => void },
): Promise<number> {
  const pending = await findPendingServerEnrollment();
  if (!pending) {
    deps.stderr('No recoverable Borg enrollment transaction was found. No state was changed.\n');
    return 1;
  }
  let origin = pending.origin;
  if (flags.host !== undefined) {
    try { origin = normalizeServerEndpoint(flags.host); } catch (error) {
      deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    if (origin !== pending.origin) {
      deps.stderr('The recovery host does not match the failed enrollment transaction. No state was changed.\n');
      return 1;
    }
  }
  if (!flags.yes) {
    const answer = await deps.prompt(
      `Recover and clear only the failed enrollment for ${origin}? Other server enrollments and accounts will not be touched. [y/N]: `,
    );
    if (!/^y(?:es)?$/i.test(answer.trim())) {
      deps.stderr('Enrollment recovery was not confirmed. No state was changed.\n');
      return 1;
    }
  }
  await clearEnrollmentTransaction(origin, pending.trustIdentity);
  await clearBorgServerTrust(origin);
  deps.stdout(`Cleared the failed enrollment transaction for ${origin}; other server enrollments and accounts were left unchanged.\n`);
  return 0;
}
