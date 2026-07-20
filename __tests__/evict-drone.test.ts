/**
 * Tests for the `borg_evict-drone` label→id resolver (gh#718).
 *
 * The local eviction route takes a drone UUID, but Coordinators see drone
 * LABELS everywhere (roster,
 * regen, cube log) and rarely the UUIDs. `resolveDroneIdByLabel` lets the tool
 * accept a label and resolve it to a drone id client-side against the
 * cube-grant-scoped detail (getCube), mirroring how borg_list-drones surfaces
 * id+label pairs. Pure-function tests; no MCP server, no live worker.
 */

import { describe, it, expect } from 'vitest';
import {
  formatEvictDroneSuccess,
  formatReassignDroneSuccess,
  resolveDroneIdByLabel,
  isUuidShape,
  type EvictableDrone,
} from '../src/evict-drone';

const drones: EvictableDrone[] = [
  { id: '11111111-1111-1111-1111-111111111111', label: 'one-of-three-coordinator' },
  { id: '22222222-2222-2222-2222-222222222222', label: 'two-of-seventeen-builder' },
  { id: '33333333-3333-3333-3333-333333333333', label: 'one-of-four-code-reviewer' },
];

describe('resolveDroneIdByLabel', () => {
  it('resolves an exact label to its drone id + label', () => {
    expect(resolveDroneIdByLabel(drones, 'two-of-seventeen-builder')).toEqual({
      id: '22222222-2222-2222-2222-222222222222',
      label: 'two-of-seventeen-builder',
    });
  });

  it('returns null when no drone carries the label', () => {
    expect(resolveDroneIdByLabel(drones, 'nine-of-nine-builder')).toBeNull();
  });

  it('trims surrounding whitespace before matching', () => {
    expect(resolveDroneIdByLabel(drones, '  two-of-seventeen-builder  ')).toEqual({
      id: '22222222-2222-2222-2222-222222222222',
      label: 'two-of-seventeen-builder',
    });
  });

  it('does NOT match against the id field (label-only resolution)', () => {
    // Passing a UUID as a "label" must not accidentally resolve — the handler
    // routes UUIDs through drone_id, never through this label resolver.
    expect(
      resolveDroneIdByLabel(drones, '22222222-2222-2222-2222-222222222222')
    ).toBeNull();
  });

  it('returns null on an empty roster', () => {
    expect(resolveDroneIdByLabel([], 'two-of-seventeen-builder')).toBeNull();
  });

  it('is exact, not substring — a prefix does not match a longer label', () => {
    expect(resolveDroneIdByLabel(drones, 'two-of-seventeen')).toBeNull();
  });
});

describe('isUuidShape (gh#782 — drone_id input validation)', () => {
  // The handler rejects non-UUID drone_id values BEFORE building the DELETE
  // URL. Two failure classes this closes: (1) a label passed as drone_id
  // would otherwise 404 with a confusing "not found" instead of a clear
  // "use label + cube_id" hint; (2) a path-shaped value like
  // "../cubes/<uuid>" would otherwise be interpolated into the request path
  // (the worker's route regex already rejects it, but the client should
  // never emit such a URL in the first place).
  it('accepts a canonical lowercase UUID', () => {
    expect(isUuidShape('22222222-2222-4222-8222-222222222222')).toBe(true);
  });

  it('accepts an uppercase UUID (case-insensitive)', () => {
    expect(isUuidShape('ABCDEF01-2345-6789-ABCD-EF0123456789')).toBe(true);
  });

  it('rejects a drone label', () => {
    expect(isUuidShape('two-of-seventeen-builder')).toBe(false);
  });

  it('rejects a path-traversal-shaped value embedding a UUID', () => {
    expect(isUuidShape('../cubes/22222222-2222-4222-8222-222222222222')).toBe(false);
  });

  it('rejects a UUID with surrounding garbage', () => {
    expect(isUuidShape('22222222-2222-4222-8222-222222222222/extra')).toBe(false);
  });

  it('rejects empty and whitespace-only strings', () => {
    expect(isUuidShape('')).toBe(false);
    expect(isUuidShape('   ')).toBe(false);
  });
});

describe('local drone management success copy', () => {
  it('renders server-derived reassignment readback with names before stable ids', () => {
    expect(formatReassignDroneSuccess({
      droneLabel: 'builder-7a12',
      cubeName: 'borg-mcp',
      roleName: 'Code Reviewer',
      droneId: '7a120000-1234-4abc-8def-1234567890ab',
      roleId: 'd22109c3-1234-4abc-8def-1234567890ab',
    })).toBe(
      'Reassigned builder-7a12 in cube borg-mcp to role Code Reviewer.\n' +
      'Drone id: 7a120000-1234-4abc-8def-1234567890ab\n' +
      'Role id: d22109c3-1234-4abc-8def-1234567890ab',
    );
  });

  it('renders eviction without claiming file deletion or anonymized attribution', () => {
    const text = formatEvictDroneSuccess('builder-7a12', 'borg-mcp');
    expect(text).toBe(
      'Removed builder-7a12 from cube borg-mcp.\n' +
      'The seat credential is revoked. The session will stop after its next Borg request.\n' +
      'The worktree and project files were not deleted. Activity history remains attributed to the removed seat.\n' +
      'After its work is merged, run `borg cleanup` to review whether the worktree can be pruned.',
    );
  });
});
