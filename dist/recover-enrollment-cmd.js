import { normalizeServerEndpoint } from './server-endpoint.js';
import { clearEnrollmentTransaction, findEnrollmentRecoveryTransaction } from './config.js';
import { InvitationArtifactRecoveryError } from './invitation-artifact.js';
import { clearStagedBorgServerTrust, restoreBorgServerEnrollment } from './server-trust.js';
export function parseRecoverEnrollmentArgs(argv) {
    let host;
    let yes = false;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--yes' || arg === '-y') {
            yes = true;
            continue;
        }
        if (arg === '--host' || arg === '-h') {
            const value = argv[++index];
            if (!value)
                return { ok: false, error: 'missing value for --host' };
            host = value;
            continue;
        }
        if (arg?.startsWith('--host=')) {
            host = arg.slice('--host='.length);
            continue;
        }
        if (arg === '--help')
            return { ok: false, error: 'help' };
        return { ok: false, error: `unexpected argument: ${arg}` };
    }
    return { ok: true, flags: { ...(host === undefined ? {} : { host }), yes } };
}
export async function runRecoverEnrollment(flags, deps) {
    let selectedOrigin;
    if (flags.host !== undefined) {
        try {
            selectedOrigin = normalizeServerEndpoint(flags.host);
        }
        catch (error) {
            deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
    }
    const transaction = await findEnrollmentRecoveryTransaction(selectedOrigin);
    if (!transaction) {
        if (selectedOrigin !== undefined && await findEnrollmentRecoveryTransaction()) {
            deps.stderr('The recovery host does not match the failed enrollment transaction. No state was changed.\n');
            return 1;
        }
        deps.stderr('No recoverable Borg enrollment transaction was found. No state was changed.\n');
        return 1;
    }
    const enrollment = transaction.kind === 'accepted' ? transaction.marker : transaction.pending;
    const origin = enrollment.origin;
    if (!flags.yes) {
        const answer = await deps.prompt(`Restore or clear only the failed enrollment for ${origin}? Other server enrollments and accounts will not be touched. [y/N]: `);
        if (!/^y(?:es)?$/i.test(answer.trim())) {
            deps.stderr('Enrollment recovery was not confirmed. No state was changed.\n');
            return 1;
        }
    }
    if (transaction.kind === 'accepted') {
        if (!await restoreBorgServerEnrollment(origin)) {
            throw new InvitationArtifactRecoveryError();
        }
        deps.stdout(`Restored the prior enrollment state for ${origin}; other server enrollments and accounts were left unchanged.\n`);
    }
    else {
        if (!await clearEnrollmentTransaction(origin, transaction.pending.trustIdentity)) {
            throw new InvitationArtifactRecoveryError();
        }
        await clearStagedBorgServerTrust(origin, transaction.pending.artifactBinding?.stagedGenerationId);
        deps.stdout(`Cleared the failed enrollment transaction for ${origin}; other server enrollments and accounts were left unchanged.\n`);
    }
    return 0;
}
//# sourceMappingURL=recover-enrollment-cmd.js.map