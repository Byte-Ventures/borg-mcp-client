import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  __setServerCredentialBackendForTest,
  activatePendingServerEnrollment,
  getAcceptedEnrollmentMarker,
  getOrCreatePendingServerEnrollment,
  getPendingServerEnrollment,
} from '../src/config.js';
import { __clearEnrollmentOriginLocksForTest } from '../src/enrollment-lock.js';
import { runRecoverEnrollment } from '../src/recover-enrollment-cmd.js';
import type { TokenBackend } from '../src/token-store.js';

const testState = vi.hoisted(() => ({
  cleanupStarted: undefined as (() => void) | undefined,
  cleanupRelease: undefined as (() => void) | undefined,
}));

vi.mock('../src/server-trust.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server-trust.js')>();
  return {
    ...actual,
    clearStagedBorgServerTrust: vi.fn(async (_origin: string, generationId?: string) => {
      if (!generationId) return;
      testState.cleanupStarted?.();
      await new Promise<void>((resolve) => { testState.cleanupRelease = resolve; });
    }),
  };
});

function memoryBackend(): { backend: TokenBackend; values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    backend: {
      name: 'file',
      entries: async () => Object.fromEntries(values),
      replaceAccounts: async (accounts) => {
        values.clear();
        for (const [account, value] of Object.entries(accounts)) values.set(account, value);
      },
      get: async (account) => values.get(account) ?? null,
      set: async (account, value) => { values.set(account, value); },
      delete: async (account) => { values.delete(account); },
    },
  };
}

function artifactBinding(origin: string, trustIdentity: string, invitation: string) {
  return {
    artifactFormatVersion: 2,
    artifactDigest: createHash('sha256').update(invitation).digest('hex'),
    endpoint: origin,
    caSpkiSha256: 'c'.repeat(64),
    trustIdentity,
    expectedAuthority: 'owner' as const,
    stagedGenerationId: 'a'.repeat(64),
  };
}

function recoveryDeps(prompt: (message: string) => Promise<string>) {
  return { prompt, stderr: vi.fn(), stdout: vi.fn() };
}

afterEach(() => {
  __setServerCredentialBackendForTest(null);
  __clearEnrollmentOriginLocksForTest();
  testState.cleanupStarted = undefined;
  testState.cleanupRelease?.();
  testState.cleanupRelease = undefined;
});

describe('recover-enrollment confirmation races', () => {
  it('leaves a same-origin pending replacement untouched after a stale confirmation', async () => {
    const { backend, values } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    const origin = `https://pending-race-${Date.now()}.invalid:7091`;
    const trustIdentity = `spki-sha256:${'d'.repeat(64)}`;
    const pendingA = await getOrCreatePendingServerEnrollment({
      origin,
      trustIdentity,
      invitation: 'a'.repeat(43),
    });
    let pendingB: Awaited<ReturnType<typeof getOrCreatePendingServerEnrollment>> | undefined;
    const stdout: string[] = [];

    await expect(runRecoverEnrollment({ yes: false }, {
      ...recoveryDeps(async () => {
        const account = [...values.keys()].find((key) => key.startsWith('borg-server-enrollment-pending:'))!;
        values.delete(account);
        pendingB = await getOrCreatePendingServerEnrollment({
          origin,
          trustIdentity,
          invitation: 'b'.repeat(43),
        });
        return 'y';
      }),
      stdout: (line: string) => stdout.push(line),
    })).rejects.toMatchObject({
      name: 'InvitationArtifactRecoveryError',
      message: expect.stringContaining('transaction you reviewed is no longer present'),
    });

    expect(pendingA.retryKey).not.toBe(pendingB?.retryKey);
    expect(stdout).toEqual([]);
    await expect(getPendingServerEnrollment(origin, trustIdentity)).resolves.toEqual(pendingB);
  });

  it('leaves a same-origin accepted replacement untouched after a stale confirmation', async () => {
    const { backend, values } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    const origin = `https://accepted-race-${Date.now()}.invalid:7091`;
    const trustIdentity = `spki-sha256:${'e'.repeat(64)}`;
    const pending = await getOrCreatePendingServerEnrollment({
      origin,
      trustIdentity,
      invitation: 'a'.repeat(43),
    });
    await activatePendingServerEnrollment({
      origin,
      trustIdentity,
      retryKey: pending.retryKey,
      credential: pending.credential,
      clientId: '11111111-1111-4111-8111-111111111111',
      serverCapabilities: ['create_cube'],
      generationId: 'a'.repeat(64),
      previousPointer: null,
    });
    const markerA = await getAcceptedEnrollmentMarker(origin);
    expect(markerA).not.toBeNull();
    const acceptedAccount = [...values.keys()].find((key) => key.startsWith('borg-server-enrollment-accepted:'))!;
    const markerB = {
      ...markerA!,
      generationId: 'b'.repeat(64),
      activeDigest: 'f'.repeat(64),
      rollbackDigest: 'e'.repeat(64),
    };
    const stdout: string[] = [];

    await expect(runRecoverEnrollment({ yes: false }, {
      ...recoveryDeps(async () => {
        values.set(acceptedAccount, JSON.stringify(markerB));
        return 'y';
      }),
      stdout: (line: string) => stdout.push(line),
    })).rejects.toMatchObject({
      name: 'InvitationArtifactRecoveryError',
      message: expect.stringContaining('transaction you reviewed is no longer present'),
    });

    expect(stdout).toEqual([]);
    await expect(getAcceptedEnrollmentMarker(origin)).resolves.toEqual(markerB);
  });

  it('holds the origin lock through staged-generation cleanup', async () => {
    const { backend } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    const origin = `https://cleanup-lock-${Date.now()}.invalid:7091`;
    const trustIdentity = `spki-sha256:${'f'.repeat(64)}`;
    await getOrCreatePendingServerEnrollment({
      origin,
      trustIdentity,
      invitation: 'a'.repeat(43),
      artifactBinding: artifactBinding(origin, trustIdentity, 'a'.repeat(43)),
    });
    let cleanupReached!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { cleanupReached = resolve; });
    testState.cleanupStarted = cleanupReached;
    const recovery = runRecoverEnrollment({ yes: true }, recoveryDeps(async () => 'y'));
    await cleanupStarted;

    let replacementSettled = false;
    const replacement = getOrCreatePendingServerEnrollment({
      origin,
      trustIdentity,
      invitation: 'b'.repeat(43),
    }).finally(() => { replacementSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(replacementSettled).toBe(false);

    // Release the mocked cleanup promise, then allow the queued replacement.
    const release = testState.cleanupRelease;
    testState.cleanupRelease = undefined;
    release?.();
    await expect(recovery).resolves.toBe(0);
    await replacement;
    expect(replacementSettled).toBe(true);
  });
});
