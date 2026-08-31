import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, X509Certificate } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import {
  encodeInvitationArtifact,
  getInvitationArtifactIntegrityInput,
} from 'borgmcp-shared/protocol';
import {
  __setServerCredentialBackendForTest,
  activatePendingServerEnrollment,
  createPendingServerEnrollmentWithReplacementConsent,
  getAcceptedEnrollmentMarker,
  getOrCreatePendingServerEnrollment,
  getPendingServerEnrollment,
  getServerCredential,
} from '../src/config.js';
import { resumeLocalBorgServerEnrollment } from '../src/server-handshake.js';
import {
  __clearServerTrustCacheForTest,
  __setEnrollmentTrustFaultForTest,
  loadBorgServerTrust,
  stageBorgServerTrust,
} from '../src/server-trust.js';
import type { TokenBackend } from '../src/token-store.js';
import { InvitationArtifactRecoveryError } from '../src/invitation-artifact.js';

const cleanup: string[] = [];

function memoryBackend(): TokenBackend {
  const values = new Map<string, string>();
  return {
    name: 'file',
    entries: async () => Object.fromEntries(values),
    replaceAccounts: async (accounts) => {
      values.clear();
      for (const [account, value] of Object.entries(accounts)) values.set(account, value);
    },
    get: async (account) => values.get(account) ?? null,
    set: async (account, value) => { values.set(account, value); },
    delete: async (account) => { values.delete(account); },
  };
}

function testCa(): { certificate: string; fingerprint: string } {
  for (const certificate of rootCertificates) {
    const parsed = new X509Certificate(certificate);
    if (!parsed.ca) continue;
    return {
      certificate,
      fingerprint: createHash('sha256')
        .update(parsed.publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex'),
    };
  }
  throw new Error('Node did not expose a CA root for the enrollment storage test');
}

function testCas(count: number): Array<{ certificate: string; fingerprint: string }> {
  const result: Array<{ certificate: string; fingerprint: string }> = [];
  for (const certificate of rootCertificates) {
    const parsed = new X509Certificate(certificate);
    if (!parsed.ca) continue;
    result.push({
      certificate,
      fingerprint: createHash('sha256')
        .update(parsed.publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex'),
    });
    if (result.length === count) return result;
  }
  throw new Error(`Node did not expose ${count} CA roots for the enrollment storage test`);
}

async function commitFreshEnrollment(
  origin: string,
  ca: { certificate: string; fingerprint: string },
): Promise<{ identity: string; credential: string }> {
  const identity = `spki-sha256:${ca.fingerprint}`;
  const staged = await stageBorgServerTrust(origin, ca.certificate, identity);
  const invitation = 'z'.repeat(43);
  const pending = await getOrCreatePendingServerEnrollment({
    origin,
    trustIdentity: identity,
    invitation,
    artifactBinding: {
      artifactFormatVersion: 2,
      artifactDigest: createHash('sha256').update(invitation).digest('hex'),
      endpoint: origin,
      caSpkiSha256: ca.fingerprint,
      trustIdentity: identity,
      expectedAuthority: 'owner',
      stagedGenerationId: staged.generationId,
    },
  });
  await staged.commitTrust((context) => activatePendingServerEnrollment({
    origin,
    trustIdentity: identity,
    retryKey: pending.retryKey,
    credential: pending.credential,
    clientId: '22222222-2222-4222-8222-222222222222',
    serverCapabilities: ['create_cube'],
    ...context,
  }));
  return { identity, credential: pending.credential };
}

afterEach(async () => {
  __setServerCredentialBackendForTest(null);
  __clearServerTrustCacheForTest();
  __setEnrollmentTrustFaultForTest(null);
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('durable enrollment storage state machine', () => {
  it('resumes the exact opaque artifact from a staged generation with no re-prompt, then loads the committed pair', async () => {
    const ca = testCa();
    const origin = `https://resume-${Date.now()}.invalid:7091`;
    cleanup.push(join(
      homedir(), '.borg', 'server-trust', createHash('sha256').update(origin).digest('hex'),
    ));
    __setServerCredentialBackendForTest(memoryBackend());
    const base = {
      version: 2 as const,
      endpoint: origin,
      ca_spki_sha256: ca.fingerprint,
      authority: 'owner' as const,
      secret: 's'.repeat(43),
      integrity: 'p'.repeat(43),
    };
    const invitation = encodeInvitationArtifact({
      ...base,
      integrity: createHmac('sha256', base.secret)
        .update(getInvitationArtifactIntegrityInput(base))
        .digest('base64url'),
    });
    const identity = `spki-sha256:${ca.fingerprint}`;
    const staged = await stageBorgServerTrust(origin, ca.certificate, identity);
    const artifactBinding = {
      artifactFormatVersion: 2,
      artifactDigest: createHash('sha256').update(invitation).digest('hex'),
      endpoint: origin,
      caSpkiSha256: ca.fingerprint,
      trustIdentity: identity,
      expectedAuthority: 'owner' as const,
      stagedGenerationId: staged.generationId,
    };
    const pending = await getOrCreatePendingServerEnrollment({
      origin, trustIdentity: identity, invitation, artifactBinding,
    });
    const requests: Array<{ payload: { invitation: string; retry_key: string; client_credential: string } }> = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== 'POST') {
        return new Response(JSON.stringify({ protocol_version: '14' }), { status: 200 });
      }
      requests.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({
        protocol_version: '14',
        request_id: 'resume-storage-state',
        payload: {
          purpose: 'owner',
          client_id: '11111111-1111-4111-8111-111111111111',
          server_capabilities: ['create_cube'],
        },
      }), { status: 201 });
    });
    const onPending = vi.fn();

    const resumed = await resumeLocalBorgServerEnrollment(origin, {
      onPending,
      loadStagedTrust: async () => ({ ...staged, fetchImpl: fetchImpl as typeof fetch }),
    });

    expect(onPending).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.payload).toMatchObject({
      invitation,
      retry_key: pending.retryKey,
      client_credential: pending.credential,
    });
    expect(resumed?.token).toBe(pending.credential);
    await expect(getServerCredential(origin, identity)).resolves.toBe(pending.credential);
    await expect(loadBorgServerTrust(origin)).resolves.toMatchObject({ identity });
  });

  it('rolls pointer back before restoring accounts when marker cleanup fails', async () => {
    const [oldCa, newCa] = testCas(2);
    const origin = `https://rollback-${Date.now()}.invalid:7091`;
    cleanup.push(join(
      homedir(), '.borg', 'server-trust', createHash('sha256').update(origin).digest('hex'),
    ));
    const values = new Map<string, string>();
    let replaceCount = 0;
    let failCleanup = false;
    const backend: TokenBackend = {
      name: 'file',
      entries: async () => Object.fromEntries(values),
      replaceAccounts: async (accounts) => {
        replaceCount += 1;
        if (failCleanup && replaceCount === 2) throw new Error('injected marker cleanup failure');
        values.clear();
        for (const [account, value] of Object.entries(accounts)) values.set(account, value);
      },
      get: async (account) => values.get(account) ?? null,
      set: async (account, value) => { values.set(account, value); },
      delete: async (account) => { values.delete(account); },
    };
    __setServerCredentialBackendForTest(backend);
    const { identity: oldIdentity, credential: oldCredential } =
      await commitFreshEnrollment(origin, oldCa!);
    replaceCount = 0;
    failCleanup = true;

    const newIdentity = `spki-sha256:${newCa!.fingerprint}`;
    const staged = await stageBorgServerTrust(origin, newCa!.certificate, newIdentity);
    const binding = {
      artifactFormatVersion: 2,
      artifactDigest: createHash('sha256').update('i'.repeat(43)).digest('hex'),
      endpoint: origin,
      caSpkiSha256: newCa!.fingerprint,
      trustIdentity: newIdentity,
      expectedAuthority: 'owner' as const,
      stagedGenerationId: staged.generationId,
    };
    const pending = await createPendingServerEnrollmentWithReplacementConsent({
      origin, trustIdentity: newIdentity, invitation: 'i'.repeat(43), artifactBinding: binding,
    });
    await expect(staged.commitTrust((context) => activatePendingServerEnrollment({
      origin,
      trustIdentity: newIdentity,
      retryKey: pending.retryKey,
      credential: pending.credential,
      clientId: '11111111-1111-4111-8111-111111111111',
      serverCapabilities: ['create_cube'],
      replacementCapabilityToken: pending.replacementCapability!.token,
      ...context,
    }))).rejects.toBeInstanceOf(InvitationArtifactRecoveryError);

    await expect(loadBorgServerTrust(origin)).resolves.toMatchObject({ identity: oldIdentity });
    await expect(getServerCredential(origin, oldIdentity)).resolves.toBe(oldCredential);
    await expect(getServerCredential(origin, newIdentity)).resolves.toBeNull();
    await expect(getPendingServerEnrollment(origin, newIdentity)).resolves.toEqual(pending);
  });

  it.each([
    'after-account-activation',
    'after-pointer-publish',
    'before-marker-finalize',
  ] as const)('restores the old pointer and accounts across the %s crash boundary', async (fault) => {
    const [oldCa, newCa] = testCas(2);
    const origin = `https://boundary-${fault}-${Date.now()}.invalid:7091`;
    cleanup.push(join(
      homedir(), '.borg', 'server-trust', createHash('sha256').update(origin).digest('hex'),
    ));
    __setServerCredentialBackendForTest(memoryBackend());
    const { identity: oldIdentity, credential: oldCredential } =
      await commitFreshEnrollment(origin, oldCa!);

    const newIdentity = `spki-sha256:${newCa!.fingerprint}`;
    const staged = await stageBorgServerTrust(origin, newCa!.certificate, newIdentity);
    const artifactBinding = {
      artifactFormatVersion: 2,
      artifactDigest: createHash('sha256').update('i'.repeat(43)).digest('hex'),
      endpoint: origin,
      caSpkiSha256: newCa!.fingerprint,
      trustIdentity: newIdentity,
      expectedAuthority: 'owner' as const,
      stagedGenerationId: staged.generationId,
    };
    const pending = await createPendingServerEnrollmentWithReplacementConsent({
      origin, trustIdentity: newIdentity, invitation: 'i'.repeat(43), artifactBinding,
    });
    __setEnrollmentTrustFaultForTest(fault);
    await expect(staged.commitTrust((context) => activatePendingServerEnrollment({
      origin,
      trustIdentity: newIdentity,
      retryKey: pending.retryKey,
      credential: pending.credential,
      clientId: '11111111-1111-4111-8111-111111111111',
      serverCapabilities: ['create_cube'],
      replacementCapabilityToken: pending.replacementCapability!.token,
      ...context,
    }))).rejects.toBeInstanceOf(InvitationArtifactRecoveryError);
    __setEnrollmentTrustFaultForTest(null);

    await expect(loadBorgServerTrust(origin)).resolves.toMatchObject({ identity: oldIdentity });
    await expect(getServerCredential(origin, oldIdentity)).resolves.toBe(oldCredential);
    await expect(getServerCredential(origin, newIdentity)).resolves.toBeNull();
    await expect(getPendingServerEnrollment(origin, newIdentity)).resolves.toEqual(pending);
    await expect(getAcceptedEnrollmentMarker(origin)).resolves.toBeNull();
  });

  it('keeps the marker gate when pointer rollback itself fails', async () => {
    const [oldCa, newCa] = testCas(2);
    const origin = `https://rollback-failure-${Date.now()}.invalid:7091`;
    cleanup.push(join(
      homedir(), '.borg', 'server-trust', createHash('sha256').update(origin).digest('hex'),
    ));
    __setServerCredentialBackendForTest(memoryBackend());
    const { identity: oldIdentity } = await commitFreshEnrollment(origin, oldCa!);
    const newIdentity = `spki-sha256:${newCa!.fingerprint}`;
    const staged = await stageBorgServerTrust(origin, newCa!.certificate, newIdentity);
    const artifactBinding = {
      artifactFormatVersion: 2,
      artifactDigest: createHash('sha256').update('i'.repeat(43)).digest('hex'),
      endpoint: origin,
      caSpkiSha256: newCa!.fingerprint,
      trustIdentity: newIdentity,
      expectedAuthority: 'owner' as const,
      stagedGenerationId: staged.generationId,
    };
    const pending = await createPendingServerEnrollmentWithReplacementConsent({
      origin, trustIdentity: newIdentity, invitation: 'i'.repeat(43), artifactBinding,
    });
    __setEnrollmentTrustFaultForTest(['after-pointer-publish', 'during-pointer-rollback']);
    await expect(staged.commitTrust((context) => activatePendingServerEnrollment({
      origin,
      trustIdentity: newIdentity,
      retryKey: pending.retryKey,
      credential: pending.credential,
      clientId: '11111111-1111-4111-8111-111111111111',
      serverCapabilities: ['create_cube'],
      replacementCapabilityToken: pending.replacementCapability!.token,
      ...context,
    }))).rejects.toBeInstanceOf(InvitationArtifactRecoveryError);

    await expect(getAcceptedEnrollmentMarker(origin)).resolves.not.toBeNull();
    await expect(getServerCredential(origin, newIdentity))
      .rejects.toBeInstanceOf(InvitationArtifactRecoveryError);
  });

  it('detects a durable account activation whose backend reports a late failure and rolls it back', async () => {
    const ca = testCa();
    const origin = `https://late-activation-${Date.now()}.invalid:7091`;
    cleanup.push(join(
      homedir(), '.borg', 'server-trust', createHash('sha256').update(origin).digest('hex'),
    ));
    const values = new Map<string, string>();
    let replaceCount = 0;
    const backend: TokenBackend = {
      name: 'file',
      entries: async () => Object.fromEntries(values),
      replaceAccounts: async (accounts) => {
        replaceCount += 1;
        values.clear();
        for (const [account, value] of Object.entries(accounts)) values.set(account, value);
        if (replaceCount === 1) throw new Error('injected post-rename account fsync failure');
      },
      get: async (account) => values.get(account) ?? null,
      set: async (account, value) => { values.set(account, value); },
      delete: async (account) => { values.delete(account); },
    };
    __setServerCredentialBackendForTest(backend);
    const identity = `spki-sha256:${ca.fingerprint}`;
    const staged = await stageBorgServerTrust(origin, ca.certificate, identity);
    const artifactBinding = {
      artifactFormatVersion: 2,
      artifactDigest: createHash('sha256').update('i'.repeat(43)).digest('hex'),
      endpoint: origin,
      caSpkiSha256: ca.fingerprint,
      trustIdentity: identity,
      expectedAuthority: 'owner' as const,
      stagedGenerationId: staged.generationId,
    };
    const pending = await getOrCreatePendingServerEnrollment({
      origin, trustIdentity: identity, invitation: 'i'.repeat(43), artifactBinding,
    });
    await expect(staged.commitTrust((context) => activatePendingServerEnrollment({
      origin,
      trustIdentity: identity,
      retryKey: pending.retryKey,
      credential: pending.credential,
      clientId: '11111111-1111-4111-8111-111111111111',
      serverCapabilities: ['create_cube'],
      ...context,
    }))).rejects.toBeInstanceOf(InvitationArtifactRecoveryError);

    await expect(getAcceptedEnrollmentMarker(origin)).resolves.toBeNull();
    await expect(getServerCredential(origin, identity)).resolves.toBeNull();
    await expect(getPendingServerEnrollment(origin, identity)).resolves.toEqual(pending);
  });

  it('fails before pending callbacks or network when the staged generation binding is missing', async () => {
    const ca = testCa();
    const origin = `https://missing-generation-${Date.now()}.invalid:7091`;
    __setServerCredentialBackendForTest(memoryBackend());
    const identity = `spki-sha256:${ca.fingerprint}`;
    await getOrCreatePendingServerEnrollment({
      origin,
      trustIdentity: identity,
      invitation: 'i'.repeat(43),
      artifactBinding: {
        artifactFormatVersion: 2,
        artifactDigest: createHash('sha256').update('i'.repeat(43)).digest('hex'),
        endpoint: origin,
        caSpkiSha256: ca.fingerprint,
        trustIdentity: identity,
        expectedAuthority: 'owner',
        stagedGenerationId: 'f'.repeat(64),
      },
    });
    const onPending = vi.fn();
    await expect(resumeLocalBorgServerEnrollment(origin, { onPending }))
      .rejects.toBeInstanceOf(InvitationArtifactRecoveryError);
    expect(onPending).not.toHaveBeenCalled();
  });
});
