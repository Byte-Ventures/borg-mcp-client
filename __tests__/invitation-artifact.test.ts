import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encodeInvitationArtifact,
  getInvitationArtifactIntegrityInput,
} from 'borgmcp-shared/protocol';
import {
  COMPATIBILITY_INVITATION_ERROR,
  FORMAT_INVITATION_ERROR,
  RECOVERY_INVITATION_ERROR,
  TRANSPORT_INVITATION_ERROR,
  TRUST_INVITATION_ERROR,
  InvitationArtifactCompatibilityError,
  InvitationArtifactLegacyError,
  InvitationArtifactFormatError,
  InvitationArtifactRecoveryError,
  InvitationArtifactTransportError,
  decodeAndVerifyInvitationArtifact,
} from '../src/invitation-artifact';

const base = {
  version: 2 as const,
  endpoint: 'https://server.example:7091',
  ca_spki_sha256: 'a'.repeat(64),
  authority: 'client' as const,
  secret: 's'.repeat(43),
  integrity: 'p'.repeat(43),
};

function artifact(): string {
  return encodeInvitationArtifact({
    ...base,
    integrity: createHmac('sha256', base.secret)
      .update(getInvitationArtifactIntegrityInput(base))
      .digest('base64url'),
  });
}

describe('invitation artifact trust bootstrap input', () => {
  it('decodes and verifies the server HMAC contract', () => {
    expect(decodeAndVerifyInvitationArtifact(artifact())).toMatchObject({
      ...base,
      integrity: expect.any(String),
    });
  });

  it('rejects a tampered artifact before any transport can use it', () => {
    const token = artifact();
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(() => decodeAndVerifyInvitationArtifact(tampered)).toThrow(InvitationArtifactFormatError);
    expect(() => decodeAndVerifyInvitationArtifact(tampered)).toThrow(FORMAT_INVITATION_ERROR);
  });

  it('gives old-format invitations their own reissue remedy', () => {
    expect(() => decodeAndVerifyInvitationArtifact('s'.repeat(43))).toThrow(InvitationArtifactLegacyError);
  });

  it('keeps the chain-compatibility and identity failure strings distinct', () => {
    expect(new InvitationArtifactCompatibilityError().message).toBe(COMPATIBILITY_INVITATION_ERROR);
    expect(new InvitationArtifactFormatError().message).toBe(FORMAT_INVITATION_ERROR);
    expect(new InvitationArtifactTransportError().message).toBe(TRANSPORT_INVITATION_ERROR);
    expect(TRUST_INVITATION_ERROR).toContain('could not verify');
  });

  it('routes split-path recovery to the real command and a fresh invitation', () => {
    expect(new InvitationArtifactRecoveryError().message).toBe(RECOVERY_INVITATION_ERROR);
    expect(RECOVERY_INVITATION_ERROR).toContain('`borg recover-enrollment`');
    expect(RECOVERY_INVITATION_ERROR).toContain('restore or clear');
    expect(RECOVERY_INVITATION_ERROR).toContain('only this server enrollment transaction');
    expect(RECOVERY_INVITATION_ERROR).toContain('does not change unrelated server enrollments or accounts');
    expect(RECOVERY_INVITATION_ERROR).toContain('invitation used for this attempt has been consumed');
    expect(RECOVERY_INVITATION_ERROR).toContain('fresh invitation');
  });
});
