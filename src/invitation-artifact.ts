import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  decodeInvitationArtifact,
  getInvitationArtifactIntegrityInput,
  type InvitationArtifact,
} from 'borgmcp-shared/protocol';

export const COMPATIBILITY_INVITATION_ERROR =
  'This server did not present the certificate chain required for cross-machine enrollment. Update the Borg server on that machine and restart it, then run this command again. No invitation or credential was sent and no local trust or credential state was changed.';

export const TRUST_INVITATION_ERROR =
  'Borg could not verify the server identity named by this invitation. No invitation or credential was sent and no local trust or credential state was changed. Ask the server operator for a current invitation, then retry.';

export class InvitationArtifactCompatibilityError extends Error {
  constructor(message = COMPATIBILITY_INVITATION_ERROR) {
    super(message);
    this.name = 'InvitationArtifactCompatibilityError';
  }
}

export class InvitationArtifactLegacyError extends Error {
  constructor() {
    super(
      'This invitation uses an older format. Ask the server operator to run `borg server cert-reissue --host <address>` on an updated Borg server, then request a new invitation and retry.',
    );
    this.name = 'InvitationArtifactLegacyError';
  }
}

export class InvitationArtifactTrustError extends Error {
  constructor(message = TRUST_INVITATION_ERROR) {
    super(message);
    this.name = 'InvitationArtifactTrustError';
  }
}

function invitationIntegrity(artifact: InvitationArtifact): string {
  return createHmac('sha256', artifact.secret)
    .update(getInvitationArtifactIntegrityInput({
      ...artifact,
      integrity: 'p'.repeat(43),
    }))
    .digest('base64url');
}

export function decodeAndVerifyInvitationArtifact(value: unknown): InvitationArtifact {
  let artifact: InvitationArtifact;
  try {
    artifact = decodeInvitationArtifact(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (typeof value === 'string' && value.length === 43) throw new InvitationArtifactLegacyError();
    if (/legacy|unsupported/i.test(message)) throw new InvitationArtifactLegacyError();
    if (/certificate chain/i.test(message)) throw new InvitationArtifactCompatibilityError();
    throw new InvitationArtifactTrustError();
  }
  const expected = Buffer.from(invitationIntegrity(artifact), 'utf8');
  const actual = Buffer.from(artifact.integrity, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    if (typeof value === 'string' && value.length === 43) throw new InvitationArtifactLegacyError();
    throw new InvitationArtifactTrustError();
  }
  return artifact;
}
