import { describe, it, expect } from 'vitest';
import { renderRoleList } from '../src/list-roles-render';

describe('renderRoleList (Sprint 6 / gh#153)', () => {
  it('renders Queen-class role with "Queen" tag + role ID', () => {
    const out = renderRoleList([
      { id: 'r1', name: 'Coordinator', role_class: 'queen', is_human_seat: true, is_default: false, short_description: 'human seat' },
    ], 'cube-1');
    expect(out).toContain('**Coordinator**');
    expect(out).toContain('(Queen, human-seat)');
    expect(out).toContain('`r1`');
    expect(out).toContain('human seat');
  });

  it('renders default-role with "default" tag + suppresses Queen tag', () => {
    const out = renderRoleList([
      { id: 'r2', name: 'Builder', role_class: 'worker', is_human_seat: false, is_default: true, short_description: 'builds' },
    ], 'cube-1');
    expect(out).toContain('(default)');
    expect(out).not.toContain('Queen');
  });

  it('falls back to "no description" placeholder when short_description missing', () => {
    const out = renderRoleList([
      { id: 'r3', name: 'NoDesc', is_default: false, is_human_seat: false },
    ], 'cube-1');
    expect(out).toContain('_(no description)_');
  });

  it('returns empty-roles placeholder when array is empty', () => {
    const out = renderRoleList([], 'cube-empty');
    expect(out).toBe('No roles in this cube yet.');
  });

  it('preserves tag-join order: Queen, human-seat, default, mandatory', () => {
    // A role with all four flags (Queen-class human-seat default mandatory — unusual
    // but valid combination) renders tags in the documented order.
    const out = renderRoleList([
      { id: 'r4', name: 'MultiTag', role_class: 'queen', is_human_seat: true, is_default: true, is_mandatory: true, short_description: 'd' },
    ], 'cube-1');
    expect(out).toContain('(Queen, human-seat, default, mandatory)');
  });

  it('renders strict-broadcast and direct-observer capability tags', () => {
    const out = renderRoleList([
      {
        id: 'r-cap',
        name: 'Security Auditor',
        can_broadcast: true,
        receives_all_direct: true,
        short_description: 'security gate',
      },
    ], 'cube-1');
    expect(out).toContain('(can-broadcast, receives-all-direct)');
  });

  it('renders no tag suffix when role has no flags set', () => {
    const out = renderRoleList([
      { id: 'r5', name: 'Plain', role_class: 'worker', is_human_seat: false, is_default: false, short_description: 'plain role' },
    ], 'cube-1');
    // No `(...)` tag block immediately after the bolded name.
    expect(out).toMatch(/\*\*Plain\*\* `r5` — plain role/);
  });

  it('multi-role list contains all role IDs + the borg_reassign-drone hint', () => {
    const out = renderRoleList([
      { id: 'r1', name: 'Coordinator', role_class: 'queen', is_human_seat: true, is_default: false },
      { id: 'r2', name: 'Builder', is_default: true, is_human_seat: false },
      { id: 'r3', name: 'Reviewer', is_default: false, is_human_seat: false },
    ], 'cube-multi');
    expect(out).toContain('`r1`');
    expect(out).toContain('`r2`');
    expect(out).toContain('`r3`');
    expect(out).toContain('Roles in cube cube-multi (3):');
    expect(out).toContain('borg_reassign-drone');
  });
});
