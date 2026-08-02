import { type InvitationArtifact } from 'borgmcp-shared/protocol';
export declare const COMPATIBILITY_INVITATION_ERROR = "This server did not present the certificate chain required for cross-machine enrollment. Update the Borg server on that machine and restart it, then run this command again. No invitation or credential was sent and no local trust or credential state was changed.";
export declare const TRUST_INVITATION_ERROR = "Borg could not verify the server identity named by this invitation. No invitation or credential was sent and no local trust or credential state was changed. Ask the server operator for a current invitation, then retry.";
export declare const FORMAT_INVITATION_ERROR = "This enrollment invitation is invalid or incomplete. No invitation or credential was sent and no local trust or credential state was changed. Ask the server operator for a new invitation, then retry.";
export declare const TRANSPORT_INVITATION_ERROR = "Borg could not reach the server named by this invitation. No invitation or credential was sent and no local trust or credential state was changed. Check that the server is running and that this machine can reach the invitation endpoint, then retry.";
export declare const STORAGE_INVITATION_ERROR = "Borg could not prepare local trust state for this invitation. No invitation or credential was sent and no local trust or credential state was changed. Check that Borg can write its private local state, then retry.";
export declare class InvitationArtifactCompatibilityError extends Error {
    constructor(message?: string);
}
export declare class InvitationArtifactLegacyError extends Error {
    constructor();
}
export declare class InvitationArtifactFormatError extends Error {
    constructor(message?: string);
}
export declare class InvitationArtifactEndpointMismatchError extends Error {
    constructor(selectedEndpoint: string, invitationEndpoint: string);
}
export declare class InvitationArtifactStorageError extends Error {
    constructor(message?: string);
}
export declare class InvitationArtifactTransportError extends Error {
    constructor(message?: string);
}
export declare class InvitationArtifactTrustError extends Error {
    constructor(message?: string);
}
export declare function decodeAndVerifyInvitationArtifact(value: unknown): InvitationArtifact;
//# sourceMappingURL=invitation-artifact.d.ts.map