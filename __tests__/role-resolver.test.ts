import { describe, it, expect } from 'vitest';
import {
  roleSlug,
  matchRoleByName,
  occupiedRoleIdsForAutoRole,
  pickDefaultRole,
  type Role,
} from '../src/role-resolver';

const ROLES: Role[] = [
  { id: 'r1', name: 'Coordinator', is_default: false, is_human_seat: true },
  { id: 'r2', name: 'Builder', is_default: true, is_human_seat: false },
  { id: 'r3', name: 'Code Reviewer', is_default: false, is_human_seat: false },
  { id: 'r4', name: 'QA Tester', is_default: false, is_human_seat: false },
];

describe('roleSlug', () => {
  it('lowercases, replaces spaces and underscores with hyphens', () => {
    expect(roleSlug('Code Reviewer')).toBe('code-reviewer');
    expect(roleSlug('code_reviewer')).toBe('code-reviewer');
    expect(roleSlug('CODE-REVIEWER')).toBe('code-reviewer');
    expect(roleSlug('builder')).toBe('builder');
  });

  // CR-F1 (drone-2 review, cube log 2026-05-18T03:55:19Z):
  // The no-arg path picks a role directly from the DB, and role names
  // have no charset constraint at CreateRoleSchema. roleSlug feeds
  // directly into worktree path construction, so anything that would
  // escape the sibling-dir pattern must be stripped here.
  it('strips path-unsafe chars (used in worktree path construction)', () => {
    expect(roleSlug('foo/etc')).toBe('fooetc');
    expect(roleSlug('foo..bar')).toBe('foobar');
    expect(roleSlug('foo;rm')).toBe('foorm');
    expect(roleSlug('foo<bar>')).toBe('foobar');
    expect(roleSlug('foo|bar')).toBe('foobar');
  });
});

describe('matchRoleByName', () => {
  it('case-insensitive match', () => {
    expect(matchRoleByName(ROLES, 'coordinator')?.id).toBe('r1');
    expect(matchRoleByName(ROLES, 'COORDINATOR')?.id).toBe('r1');
  });

  it('hyphen vs space match', () => {
    expect(matchRoleByName(ROLES, 'code-reviewer')?.id).toBe('r3');
    expect(matchRoleByName(ROLES, 'code reviewer')?.id).toBe('r3');
    expect(matchRoleByName(ROLES, 'Code Reviewer')?.id).toBe('r3');
  });

  it('underscore variant', () => {
    expect(matchRoleByName(ROLES, 'code_reviewer')?.id).toBe('r3');
  });

  it('returns undefined when no match', () => {
    expect(matchRoleByName(ROLES, 'nonexistent')).toBeUndefined();
  });
});

describe('pickDefaultRole', () => {
  // ROLES order: r1 Coordinator (human-seat), r2 Builder (default),
  // r3 Code Reviewer, r4 QA Tester. Eligible worker roles in order: r2, r3, r4.

  it('returns the human-seat role when isFirstDrone=true and one exists', () => {
    expect(pickDefaultRole(ROLES, { isFirstDrone: true })?.id).toBe('r1');
  });

  it('keeps the first-drone human-seat rule with a mandatory Coordinator', () => {
    const roles = ROLES.map((role) =>
      role.id === 'r1' ? { ...role, is_mandatory: true } : role
    );
    expect(pickDefaultRole(roles, { isFirstDrone: true })?.id).toBe('r1');
  });

  it('prioritizes an unoccupied mandatory human-seat role after the first drone', () => {
    const roles = ROLES.map((role) =>
      role.id === 'r1' ? { ...role, is_mandatory: true } : role
    );
    expect(pickDefaultRole(roles, { isFirstDrone: false })?.id).toBe('r1');
  });

  it('fills unoccupied mandatory roles in definition order', () => {
    const roles = ROLES.map((role) =>
      role.id === 'r3' || role.id === 'r4' ? { ...role, is_mandatory: true } : role
    );
    expect(pickDefaultRole(roles, { isFirstDrone: false })?.id).toBe('r3');
    expect(
      pickDefaultRole(roles, {
        isFirstDrone: false,
        occupiedRoleIds: new Set(['r3']),
      })?.id
    ).toBe('r4');
  });

  it('falls through to the ordinary worker order after the mandatory human seat is occupied', () => {
    const roles = ROLES.map((role) =>
      role.id === 'r1' ? { ...role, is_mandatory: true } : role
    );
    expect(
      pickDefaultRole(roles, {
        isFirstDrone: false,
        occupiedRoleIds: new Set(['r1']),
      })?.id
    ).toBe('r2');
  });

  it('non-first drone, nothing occupied → first eligible worker role (default is first here)', () => {
    expect(pickDefaultRole(ROLES, { isFirstDrone: false })?.id).toBe('r2');
  });

  it('skips an occupied role and picks the next eligible worker role', () => {
    const occupied = new Set(['r2']);
    expect(pickDefaultRole(ROLES, { isFirstDrone: false, occupiedRoleIds: occupied })?.id).toBe('r3');
  });

  it('never auto-picks a human-seat or queen role as a worker', () => {
    const roles: Role[] = [
      { id: 'h', name: 'Human', is_default: false, is_human_seat: true },
      { id: 'q', name: 'Queen', is_default: false, is_human_seat: false, role_class: 'queen' },
      { id: 'w', name: 'Worker', is_default: true, is_human_seat: false, role_class: 'worker' },
    ];
    // Non-first drone so the human-seat first-drone rule does not apply.
    expect(pickDefaultRole(roles, { isFirstDrone: false })?.id).toBe('w');
  });

  it('falls back to the default role when every eligible worker role is occupied', () => {
    const roles = ROLES.map((role) =>
      role.id === 'r1' ? { ...role, is_mandatory: true } : role
    );
    const occupied = new Set(['r1', 'r2', 'r3', 'r4']);
    expect(pickDefaultRole(roles, { isFirstDrone: false, occupiedRoleIds: occupied })?.id).toBe('r2');
  });

  it('falls back to default when first-drone and no human-seat role', () => {
    const noHumanSeat = ROLES.filter((r) => !r.is_human_seat); // r2,r3,r4
    const occupied = new Set(['r2', 'r3', 'r4']);
    expect(pickDefaultRole(noHumanSeat, { isFirstDrone: true, occupiedRoleIds: occupied })?.id).toBe('r2');
  });

  it('picks a lone unoccupied worker role even when it is not the default', () => {
    // Behavior change vs the old is_default-only contract: an unoccupied
    // eligible worker role is now a valid auto-pick target.
    const roles: Role[] = [
      { id: 'rx', name: 'Stray', is_default: false, is_human_seat: false },
    ];
    expect(pickDefaultRole(roles, { isFirstDrone: false })?.id).toBe('rx');
  });

  it('returns undefined when no eligible worker role and no default exist', () => {
    const onlyQueen: Role[] = [
      { id: 'q', name: 'Queen', is_default: false, is_human_seat: false, role_class: 'queen' },
    ];
    expect(pickDefaultRole(onlyQueen, { isFirstDrone: false })).toBeUndefined();
    expect(pickDefaultRole(onlyQueen, { isFirstDrone: true })).toBeUndefined();
  });

  it('omitting occupiedRoleIds degrades to first eligible worker / default', () => {
    expect(pickDefaultRole(ROLES, { isFirstDrone: false })?.id).toBe('r2');
  });
});

describe('occupiedRoleIdsForAutoRole', () => {
  it('excludes presumed-abandoned seats while retaining live and legacy rows', () => {
    expect(occupiedRoleIdsForAutoRole([
      { role_id: 'dead', presumed_abandoned: true },
      { role_id: 'live', presumed_abandoned: false },
      { role_id: 'legacy' },
    ])).toEqual(new Set(['live', 'legacy']));
  });
});
