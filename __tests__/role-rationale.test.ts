import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatRationalePointer,
  parseRationalePointer,
} from '../src/regen-format';

vi.mock('../src/config.js', () => ({
  getIdToken: vi.fn(async () => 'id-token'),
  getRefreshToken: vi.fn(async () => null),
  clearTokens: vi.fn(async () => {}),
}));

vi.mock('../src/auth.js', () => ({
  refreshIdToken: vi.fn(async () => {}),
  RefreshTokenInvalidError: class RefreshTokenInvalidError extends Error {},
  RefreshTransientError: class RefreshTransientError extends Error {},
}));

describe('role rationale pointer wiring (gh#496-B)', () => {
  it('round-trips the pointer stub into executable borg_role-rationale tool keys', () => {
    const stub = formatRationalePointer('Builder', 'Workflow rationale');

    expect(stub).toBe('rationale → borg_role-rationale "Builder" "Workflow rationale"');
    expect(parseRationalePointer(stub)).toEqual({
      role: 'Builder',
      section: 'Workflow rationale',
    });
  });

  it('round-trips multi-word role names without truncating the executable key', () => {
    const codeReviewer = formatRationalePointer('Code Reviewer', 'Workflow rationale');
    const securityAuditor = formatRationalePointer('Security Auditor', 'SR checklist');

    expect(parseRationalePointer(codeReviewer)).toEqual({
      role: 'Code Reviewer',
      section: 'Workflow rationale',
    });
    expect(parseRationalePointer(securityAuditor)).toEqual({
      role: 'Security Auditor',
      section: 'SR checklist',
    });
  });

  it('escapes quoted role and section text in the pointer stub', () => {
    const stub = formatRationalePointer('Code "Review"', 'Why "strict" matters');

    expect(parseRationalePointer(stub)).toEqual({
      role: 'Code "Review"',
      section: 'Why "strict" matters',
    });
  });

  it('rejects text that does not name the executable tool path', () => {
    expect(parseRationalePointer('rationale lives somewhere in docs')).toBeNull();
  });
});

describe('roleRationale remote wrapper', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the worker role-rationale endpoint with encoded role and section keys', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          role: 'Security Auditor',
          section: 'SR checklist',
          body: 'why this rule exists',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const { roleRationale } = await import('../src/remote-client.js');

    const result = await roleRationale(
      'session-token',
      'https://api.example.test',
      'Security Auditor',
      'SR checklist'
    );

    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.example.test/api/drone/role-rationale?role=Security+Auditor&section=SR+checklist'
    );
    expect(fetchSpy.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer id-token',
      'X-Drone-Session': 'session-token',
    });
    expect(result.body).toBe('why this rule exists');
  });
});

describe('getRoleInfoByName remote wrapper', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests /api/drone/role with the url-encoded role param', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ role: { name: 'Code Reviewer', detailed_description: 'body' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const { getRoleInfoByName } = await import('../src/remote-client.js');

    const result = await getRoleInfoByName(
      'session-token',
      'https://api.example.test',
      'Code Reviewer'
    );

    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.example.test/api/drone/role?role=Code+Reviewer'
    );
    expect(result.role.name).toBe('Code Reviewer');
  });

  it('fetches fresh from network on each call (no-cache invariant)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ role: { name: 'Builder', detailed_description: 'body' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    const { getRoleInfoByName } = await import('../src/remote-client.js');

    // Call twice to verify no caching
    await getRoleInfoByName(
      'session-token',
      'https://api.example.test',
      'Builder'
    );
    await getRoleInfoByName(
      'session-token',
      'https://api.example.test',
      'Builder'
    );

    // Assert exactly 2 network calls (proves no cache)
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.example.test/api/drone/role?role=Builder'
    );
    expect(fetchSpy.mock.calls[1][0]).toBe(
      'https://api.example.test/api/drone/role?role=Builder'
    );
  });
});
