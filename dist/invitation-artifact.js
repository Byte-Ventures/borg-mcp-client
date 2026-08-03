import { createHmac, timingSafeEqual } from 'node:crypto';
import { decodeInvitationArtifact, encodeInvitationArtifact, getInvitationArtifactIntegrityInput, } from 'borgmcp-shared/protocol';
export const COMPATIBILITY_INVITATION_ERROR = 'This server did not present the certificate chain required for cross-machine enrollment. Update the Borg server on that machine and restart it, then run this command again. No invitation or credential was sent and no local trust or credential state was changed.';
export const TRUST_INVITATION_ERROR = 'Borg could not verify the server identity named by this invitation. No invitation or credential was sent and no local trust or credential state was changed. Ask the server operator for a current invitation, then retry.';
export const FORMAT_INVITATION_ERROR = 'This enrollment invitation is invalid or incomplete. No invitation or credential was sent and no local trust or credential state was changed. Ask the server operator for a new invitation, then retry.';
export const TRANSPORT_INVITATION_ERROR = 'Borg could not reach the server named by this invitation. No invitation or credential was sent and no local trust or credential state was changed. Check that the server is running and that this machine can reach the invitation endpoint, then retry.';
export const STORAGE_INVITATION_ERROR = 'Borg could not prepare local trust state for this invitation. No invitation or credential was sent and no local trust or credential state was changed. Check that Borg can write its private local state, then retry.';
export const RECOVERY_INVITATION_ERROR = 'Borg could not complete or undo the enrollment change. Prior local access may be unavailable. Run `borg recover-enrollment` to restore or clear only this server enrollment transaction; it does not change unrelated server enrollments or accounts. The invitation used for this attempt has been consumed; after recovery, ask the server operator for a fresh invitation and retry.';
export const MISKEYED_RECOVERY_ERROR = 'Borg found a failed enrollment record where it does not belong. No state was changed. This release has no supported way to recover that record; keep it intact.';
export class InvitationArtifactCompatibilityError extends Error {
    constructor(message = COMPATIBILITY_INVITATION_ERROR) {
        super(message);
        this.name = 'InvitationArtifactCompatibilityError';
    }
}
export class InvitationArtifactLegacyError extends Error {
    constructor() {
        super('This invitation uses an older format. Update the Borg server on that machine and restart it, then ask the server operator for a new invitation and retry. No invitation or credential was sent and no local trust or credential state was changed.');
        this.name = 'InvitationArtifactLegacyError';
    }
}
export class InvitationArtifactFormatError extends Error {
    constructor(message = FORMAT_INVITATION_ERROR) {
        super(message);
        this.name = 'InvitationArtifactFormatError';
    }
}
export class InvitationArtifactEndpointMismatchError extends Error {
    constructor(selectedEndpoint, invitationEndpoint) {
        super(`The enrollment invitation endpoint (${invitationEndpoint}) does not match the selected \`--host\` (${selectedEndpoint}). No invitation or credential was sent and no local trust or credential state was changed. Omit \`--host\` or select the exact invitation endpoint, then retry.`);
        this.name = 'InvitationArtifactEndpointMismatchError';
    }
}
export class InvitationArtifactStorageError extends Error {
    constructor(message = STORAGE_INVITATION_ERROR) {
        super(message);
        this.name = 'InvitationArtifactStorageError';
    }
}
export class InvitationArtifactRecoveryError extends Error {
    constructor(message = RECOVERY_INVITATION_ERROR) {
        super(message);
        this.name = 'InvitationArtifactRecoveryError';
    }
}
export class InvitationArtifactTransportError extends Error {
    constructor(message = TRANSPORT_INVITATION_ERROR) {
        super(message);
        this.name = 'InvitationArtifactTransportError';
    }
}
export class InvitationArtifactTrustError extends Error {
    constructor(message = TRUST_INVITATION_ERROR) {
        super(message);
        this.name = 'InvitationArtifactTrustError';
    }
}
function invitationIntegrity(artifact) {
    return createHmac('sha256', artifact.secret)
        .update(getInvitationArtifactIntegrityInput({
        ...artifact,
        integrity: 'p'.repeat(43),
    }))
        .digest('base64url');
}
export function decodeAndVerifyInvitationArtifact(value) {
    let artifact;
    try {
        artifact = decodeInvitationArtifact(typeof value === 'string' ? value : encodeInvitationArtifact(value));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (typeof value === 'string' && value.length === 43)
            throw new InvitationArtifactLegacyError();
        if (/legacy|unsupported/i.test(message))
            throw new InvitationArtifactLegacyError();
        if (/certificate chain/i.test(message))
            throw new InvitationArtifactCompatibilityError();
        throw new InvitationArtifactFormatError();
    }
    const expected = Buffer.from(invitationIntegrity(artifact), 'utf8');
    const actual = Buffer.from(artifact.integrity, 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        if (typeof value === 'string' && value.length === 43)
            throw new InvitationArtifactLegacyError();
        throw new InvitationArtifactFormatError();
    }
    return artifact;
}
//# sourceMappingURL=invitation-artifact.js.map