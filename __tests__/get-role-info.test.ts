import { describe, expect, it } from 'vitest';

// assertRoleMatches is a pure function — no fetch/config/auth mocks needed.
describe('assertRoleMatches (rollout-compat guard)', () => {
  it('accepts a response whose role name matches the request (case-insensitive)', async () => {
    const { assertRoleMatches } = await import('../src/role-match.js');
    expect(() => assertRoleMatches('builder', { id: 'r1', name: 'Builder' })).not.toThrow();
  });

  it('throws when the returned role does not match (old-worker fallback)', async () => {
    const { assertRoleMatches } = await import('../src/role-match.js');
    expect(() => assertRoleMatches('Builder', { id: 'r9', name: 'Coordinator' }))
      .toThrow(/does not support named-role lookup/i);
  });

  it('matches by id when the request was a uuid', async () => {
    const { assertRoleMatches } = await import('../src/role-match.js');
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(() => assertRoleMatches(uuid, { id: uuid, name: 'Whatever' })).not.toThrow();
  });
});
