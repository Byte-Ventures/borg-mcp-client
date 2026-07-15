import { describe, expect, it } from 'vitest';
import { shortDroneId, formatDroneAddressToken } from 'borgmcp-shared/drone-address';
import { formatLogEntryMarkdown } from '../src/regen-format';

describe('shortDroneId (gh#371)', () => {
  it('is the first 8 hex of the drone_id (a valid startsWith prefix of the full id)', () => {
    const id = '3336cde1-a76e-4e89-8bc2-77c149bb6a74';
    expect(shortDroneId(id)).toBe('3336cde1');
    // must be a prefix the worker resolver can startsWith-match against the full id
    expect(id.toLowerCase().startsWith(shortDroneId(id))).toBe(true);
  });

  it('lowercases so it matches the resolver regex /^[0-9a-f]{8,}$/i', () => {
    expect(shortDroneId('3336CDE1-AAAA-...')).toBe('3336cde1');
    expect(shortDroneId('3336cde1-a76e-4e89-8bc2-77c149bb6a74')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('formatDroneAddressToken (gh#371 finding-2)', () => {
  const id = '3336cde1-a76e-4e89-8bc2-77c149bb6a74';

  it('renders a clearly-labeled address token containing the short-uuid', () => {
    const token = formatDroneAddressToken(id);
    expect(token).toContain('id:');
    expect(token).toContain('3336cde1');
  });

  it('is visually distinct from the [entry_id: …] bracket (no bracket-mimicking)', () => {
    const token = formatDroneAddressToken(id);
    expect(token).not.toContain('entry_id');
    expect(token).not.toContain('[');
  });
});

describe('cross-surface uniformity (gh#371 decision-3)', () => {
  it('roster and read-log render the IDENTICAL address token for a drone', () => {
    const id = '3336cde1-a76e-4e89-8bc2-77c149bb6a74';
    const token = formatDroneAddressToken(id);

    // read-log surface
    const drones = new Map([[id, { id, label: 'eighteen-of-thirty-builder', role_id: 'role-1' }]]);
    const roles = new Map([['role-1', { id: 'role-1', name: 'Builder' }]]);
    const logLine = formatLogEntryMarkdown(
      { id: 'entry-1', drone_id: id, created_at: '2026-06-21T00:00:00.000Z', message: 'hi' },
      drones,
      roles
    );
    expect(logLine).toContain(token);
    // the addressable token is NOT the entry_id (a weak model must not confuse them)
    expect(logLine).toContain('[entry_id: entry-1]');
    expect(token).not.toContain('entry-1');
  });
});
