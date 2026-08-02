import { describe, expect, it, vi } from 'vitest';
import { parseRecoverEnrollmentArgs, runRecoverEnrollment } from '../src/recover-enrollment-cmd.js';

vi.mock('../src/config.js', () => ({
  findPendingServerEnrollment: vi.fn(async () => ({
    origin: 'https://server.example.com:7091',
    trustIdentity: 'spki-sha256:server-a',
    invitation: 'opaque-invitation',
    retryKey: '11111111-1111-4111-8111-111111111111',
    credential: 'c'.repeat(43),
  })),
  clearEnrollmentTransaction: vi.fn(async () => {}),
}));
vi.mock('../src/server-trust.js', () => ({
  clearBorgServerTrust: vi.fn(async () => {}),
}));

describe('recover-enrollment', () => {
  it('parses its explicit host and non-interactive confirmation', () => {
    expect(parseRecoverEnrollmentArgs(['--host', 'server.example.com:7091', '--yes']))
      .toEqual({ ok: true, flags: { host: 'server.example.com:7091', yes: true } });
  });

  it('requires clear-only confirmation and reports transaction-only scope on success', async () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const prompt: string[] = [];
    await expect(runRecoverEnrollment({ yes: false }, {
      prompt: async (message) => { prompt.push(message); return 'y'; },
      stderr: (line) => stderr.push(line),
      stdout: (line) => stdout.push(line),
    })).resolves.toBe(0);
    expect(stderr).toEqual([]);
    expect(prompt.join('')).toMatch(/Clear only the failed enrollment/);
    expect(prompt.join('')).not.toMatch(/Recover and clear/);
    expect(stdout.join('')).toMatch(/failed enrollment transaction/);
    expect(stdout.join('')).toMatch(/other server enrollments and accounts were left unchanged/);
  });
});
