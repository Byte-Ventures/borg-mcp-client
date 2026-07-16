import { describe, expect, it } from 'vitest';
import { resolveLocalLogRecipients } from '../src/local-log-routing.js';

const roles = [
  { id: 'role-build', name: 'Builder' },
  { id: 'role-coordinate', name: 'Release Coordinator', is_human_seat: true },
  { id: 'role-empty', name: 'Release Quality' },
];
const drones = [
  { id: 'deadbeef-0000-4000-8000-000000000001', label: 'builder-1', role_id: 'role-build' },
  { id: 'deadbeef-0000-4000-8000-000000000002', label: 'builder-2', role_id: 'role-build' },
  { id: 'cafebabe-0000-4000-8000-000000000003', label: 'coordinator-1', role_id: 'role-coordinate' },
];

describe('local directed log recipient resolution', () => {
  it('expands roles and deduplicates mixed addressing forms', () => {
    expect(resolveLocalLogRecipients(
      ['Builder', 'builder-1', 'release_coordinator'],
      drones,
      roles,
    )).toEqual([
      'deadbeef-0000-4000-8000-000000000001',
      'deadbeef-0000-4000-8000-000000000002',
      'cafebabe-0000-4000-8000-000000000003',
    ]);
  });

  it('expands the hosted-compatible @human-seat token', () => {
    expect(resolveLocalLogRecipients(['@human-seat'], drones, roles)).toEqual([
      'cafebabe-0000-4000-8000-000000000003',
    ]);
  });

  it('rejects an ambiguous short UUID with full candidate identities', () => {
    expect(() => resolveLocalLogRecipients(['id:deadbeef'], drones, roles))
      .toThrow(/Ambiguous short-uuid recipient.*deadbeef-0000-4000-8000-000000000001.*builder-1.*deadbeef-0000-4000-8000-000000000002.*builder-2/);
  });

  it('rejects an unknown recipient instead of degrading to broadcast', () => {
    expect(() => resolveLocalLogRecipients(['missing'], drones, roles))
      .toThrow(/Unknown direct-message recipient: missing/);
  });

  it('rejects an empty role instead of degrading to broadcast', () => {
    expect(() => resolveLocalLogRecipients(['release-quality'], drones, roles))
      .toThrow(/role recipient has no active drones: release-quality/);
  });
});
