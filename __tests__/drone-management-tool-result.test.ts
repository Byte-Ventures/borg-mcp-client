import { describe, expect, it } from 'vitest';
import {
  formatEvictionSuccess,
  formatReassignmentSuccess,
} from '../src/drone-management-tool-result.js';

const DRONE_ID = '33333333-3333-4333-8333-333333333333';

describe('drone management MCP success results', () => {
  it('accepts the hosted reassignment response containing only a drone', () => {
    expect(formatReassignmentSuccess({
      drone: { id: DRONE_ID, label: 'builder-1', role_id: 'role-2' },
    })).toBe(`Reassigned drone builder-1 (${DRONE_ID}) to role role-2.`);
  });

  it('uses enriched names when the response provides confirmed context', () => {
    expect(formatReassignmentSuccess({
      drone: { id: DRONE_ID, label: 'builder-1', role_id: 'role-2' },
      role: { id: 'role-2', name: 'Reviewer' },
      cube: { id: 'cube-1', name: 'alpha' },
    })).toBe(
      `Reassigned builder-1 in cube alpha to role Reviewer.\n` +
      `Drone id: ${DRONE_ID}\nRole id: role-2`,
    );
  });

  it('uses the confirmed target cube for label eviction', () => {
    const result = formatEvictionSuccess('builder-1', DRONE_ID, 'target-cube');

    expect(result).toContain('Removed builder-1 from cube target-cube.');
    expect(result).not.toContain('active-cube');
  });

  it('uses cube-neutral copy for UUID-only eviction', () => {
    const result = formatEvictionSuccess(DRONE_ID, DRONE_ID);

    expect(result).toContain(`Removed ${DRONE_ID} from its cube.`);
    expect(result).not.toContain('from cube');
  });
});
