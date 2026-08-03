import { describe, expect, it, vi } from 'vitest';
import { parseRecoverEnrollmentArgs, runRecoverEnrollment } from '../src/recover-enrollment-cmd.js';
import * as config from '../src/config.js';
import * as trust from '../src/server-trust.js';

vi.mock('../src/config.js', () => ({
  findEnrollmentRecoveryTransaction: vi.fn(async () => ({ kind: 'pending', pending: {
      origin: 'https://server.example.com:7091',
      trustIdentity: 'spki-sha256:server-a',
      invitation: 'opaque-invitation',
      retryKey: '11111111-1111-4111-8111-111111111111',
      credential: 'c'.repeat(43),
    } })),
  clearEnrollmentTransaction: vi.fn(async () => true),
}));
vi.mock('../src/server-trust.js', () => ({
  clearStagedBorgServerTrust: vi.fn(async () => {}),
  restoreBorgServerEnrollment: vi.fn(async () => true),
}));

describe('recover-enrollment', () => {
  it('parses its explicit host and non-interactive confirmation', () => {
    expect(parseRecoverEnrollmentArgs(['--host', 'server.example.com:7091', '--yes']))
      .toEqual({ ok: true, flags: { host: 'server.example.com:7091', yes: true } });
  });

  it('requires restore-or-clear confirmation and reports transaction-only scope on success', async () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const prompt: string[] = [];
    await expect(runRecoverEnrollment({ yes: false }, {
      prompt: async (message) => { prompt.push(message); return 'y'; },
      stderr: (line) => stderr.push(line),
      stdout: (line) => stdout.push(line),
    })).resolves.toBe(0);
    expect(stderr).toEqual([]);
    expect(prompt.join('')).toMatch(/Restore or clear only the failed enrollment/);
    expect(stdout.join('')).toMatch(/failed enrollment transaction/);
    expect(stdout.join('')).toMatch(/other server enrollments and accounts were left unchanged/);
  });

  it('restores a validated accepted journal instead of clearing unrelated state', async () => {
    vi.clearAllMocks();
    vi.mocked(config.findEnrollmentRecoveryTransaction).mockResolvedValueOnce({
      kind: 'accepted',
      marker: {
        version: 1,
        state: 'accepted',
        origin: 'https://server.example.com:7091',
        trustIdentity: 'spki-sha256:server-a',
        generationId: 'a'.repeat(64),
        previousPointer: null,
        activeDigest: 'd'.repeat(64),
        rollbackAccount: `borg-server-enrollment-rollback:${'b'.repeat(64)}`,
        rollbackDigest: 'c'.repeat(64),
      },
    });
    const stdout: string[] = [];
    await expect(runRecoverEnrollment({ yes: true }, {
      prompt: vi.fn(),
      stderr: vi.fn(),
      stdout: (line) => stdout.push(line),
    })).resolves.toBe(0);
    expect(trust.restoreBorgServerEnrollment).toHaveBeenCalledWith('https://server.example.com:7091');
    expect(config.clearEnrollmentTransaction).not.toHaveBeenCalled();
    expect(stdout.join('')).toMatch(/Restored the prior enrollment state/);
    expect(stdout.join('')).toMatch(/other server enrollments and accounts were left unchanged/);
  });

  it('does not report success when the pending transaction was already absent', async () => {
    vi.clearAllMocks();
    vi.mocked(config.clearEnrollmentTransaction).mockResolvedValueOnce(false);
    await expect(runRecoverEnrollment({ yes: true }, {
      prompt: vi.fn(),
      stderr: vi.fn(),
      stdout: vi.fn(),
    })).rejects.toThrow(/complete or undo the enrollment change/i);
  });

  it('does not report success when accepted recovery changed nothing', async () => {
    vi.clearAllMocks();
    vi.mocked(config.findEnrollmentRecoveryTransaction).mockResolvedValueOnce({
      kind: 'accepted',
      marker: {
        version: 1,
        state: 'accepted',
        origin: 'https://server.example.com:7091',
        trustIdentity: 'spki-sha256:server-a',
        generationId: 'a'.repeat(64),
        previousPointer: null,
        activeDigest: 'd'.repeat(64),
        rollbackAccount: `borg-server-enrollment-rollback:${'b'.repeat(64)}`,
        rollbackDigest: 'c'.repeat(64),
      },
    });
    vi.mocked(trust.restoreBorgServerEnrollment).mockResolvedValueOnce(false);
    await expect(runRecoverEnrollment({ yes: true }, {
      prompt: vi.fn(),
      stderr: vi.fn(),
      stdout: vi.fn(),
    })).rejects.toThrow(/complete or undo the enrollment change/i);
  });
});
