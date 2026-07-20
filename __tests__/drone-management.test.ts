import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runEvictDroneTool,
  runReassignDroneTool,
  STALE_ROLE_DISPLAY_WARNING,
  type DroneManagementDeps,
} from '../src/drone-management.js';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '22222222-2222-4222-8222-222222222222';
const ROLE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_DRONE_ID = '44444444-4444-4444-8444-444444444444';

function fixture(overrides: Partial<DroneManagementDeps> = {}) {
  const calls: string[] = [];
  const active = {
    cubeId: CUBE_ID,
    droneId: DRONE_ID,
    name: 'borg-mcp',
    sessionToken: 's'.repeat(43),
    droneLabel: 'builder-1',
    apiUrl: 'https://localhost:7091',
    serverTrustIdentity: 'spki-sha256:test',
    localSessionCredentialRef: `borg-server-session:${'a'.repeat(64)}`,
    roleName: 'Builder',
    roleClass: 'worker' as const,
    isHumanSeat: false,
  };
  const cube = {
    id: CUBE_ID,
    name: 'borg-mcp',
    roles: [{ id: ROLE_ID, name: 'Code Reviewer', role_class: 'worker', is_human_seat: false }],
    drones: [
      { id: DRONE_ID, cube_id: CUBE_ID, role_id: '55555555-5555-4555-8555-555555555555', label: 'builder-1' },
      { id: OTHER_DRONE_ID, cube_id: CUBE_ID, role_id: ROLE_ID, label: 'builder-2' },
    ],
  };
  const deps: DroneManagementDeps = {
    getActiveCube: vi.fn(async () => {
      calls.push('active');
      return active;
    }),
    getCubeForManagement: vi.fn(async () => {
      calls.push('lookup');
      return cube;
    }),
    reassignDrone: vi.fn(async (droneId, roleId) => {
      calls.push('reassign');
      return { drone: { id: droneId, cube_id: CUBE_ID, role_id: roleId, label: 'builder-1' } };
    }),
    evictDrone: vi.fn(async (droneId) => {
      calls.push('evict');
      return { drone_id: droneId, evicted: true };
    }),
    refreshActiveCubeMetadata: vi.fn(async () => {
      calls.push('refresh');
      return true;
    }),
    ...overrides,
  };
  return { calls, deps };
}

describe('local drone management orchestration', () => {
  it('binds the stale-display warning to the merged Product Design artifact', () => {
    const mockup = readFileSync(fileURLToPath(new URL(
      '../docs/design/mockups/local-drone-management.html',
      import.meta.url,
    )), 'utf8').replace(
      '<span class="warning">Local display warning:</span>',
      'Local display warning:',
    );
    expect(mockup).toContain(STALE_ROLE_DISPLAY_WARNING);
  });

  it('rejects malformed reassignment before active-seat hydration', async () => {
    const { deps } = fixture();
    await expect(runReassignDroneTool({ droneId: '../cube', roleId: ROLE_ID }, deps))
      .rejects.toThrow(/not a UUID/);
    await expect(runReassignDroneTool({ droneId: DRONE_ID, roleId: '../role' }, deps))
      .rejects.toThrow(/not a UUID/);
    expect(deps.getActiveCube).not.toHaveBeenCalled();
    expect(deps.getCubeForManagement).not.toHaveBeenCalled();
    expect(deps.reassignDrone).not.toHaveBeenCalled();
  });

  it('rejects malformed eviction forms before active-seat hydration', async () => {
    const { deps } = fixture();
    await expect(runEvictDroneTool({ drone_id: DRONE_ID, label: 'builder-1', cube_id: CUBE_ID }, deps))
      .rejects.toThrow(/not both/);
    await expect(runEvictDroneTool({ label: 'builder-1', cube_id: '../cube' }, deps))
      .rejects.toThrow(/not a UUID/);
    expect(deps.getActiveCube).not.toHaveBeenCalled();
    expect(deps.getCubeForManagement).not.toHaveBeenCalled();
    expect(deps.evictDrone).not.toHaveBeenCalled();
  });

  it('looks up names before reassignment and performs no post-commit network read', async () => {
    const { calls, deps } = fixture();
    const text = await runReassignDroneTool({ droneId: DRONE_ID, roleId: ROLE_ID }, deps);
    expect(calls).toEqual(['active', 'lookup', 'reassign', 'refresh']);
    expect(text).toContain('Reassigned builder-1 in cube borg-mcp to role Code Reviewer.');
    expect(deps.getCubeForManagement).toHaveBeenCalledTimes(1);
    expect(deps.reassignDrone).toHaveBeenCalledTimes(1);
  });

  it('returns confirmed reassignment success plus a non-retry warning when metadata refresh fails', async () => {
    const { deps } = fixture({
      refreshActiveCubeMetadata: vi.fn(async () => {
        throw new Error('local store unavailable');
      }),
    });
    const text = await runReassignDroneTool({ droneId: DRONE_ID, roleId: ROLE_ID }, deps);
    expect(text).toContain('Reassigned builder-1 in cube borg-mcp to role Code Reviewer.');
    expect(text).toContain(STALE_ROLE_DISPLAY_WARNING);
    expect(text).toContain('Do not retry the reassignment.');
    expect(text).toContain('restart this agent session once');
    expect(text).toContain('Do not re-assimilate or repeat the management request.');
    expect(deps.reassignDrone).toHaveBeenCalledTimes(1);
    expect(deps.getCubeForManagement).toHaveBeenCalledTimes(1);
  });

  it('keeps confirmed success when an exact-seat CAS reports a concurrent replacement', async () => {
    const { deps } = fixture({
      refreshActiveCubeMetadata: vi.fn(async () => false),
    });
    const text = await runReassignDroneTool({ droneId: DRONE_ID, roleId: ROLE_ID }, deps);
    expect(text).toContain('Reassigned builder-1 in cube borg-mcp to role Code Reviewer.');
    expect(text).toContain(STALE_ROLE_DISPLAY_WARNING);
    expect(deps.reassignDrone).toHaveBeenCalledTimes(1);
  });

  it('looks up a label before eviction and performs no post-commit network read', async () => {
    const { calls, deps } = fixture();
    const text = await runEvictDroneTool({ label: 'builder-2', cube_id: CUBE_ID }, deps);
    expect(calls).toEqual(['active', 'lookup', 'evict']);
    expect(text).toContain('Removed builder-2 from cube borg-mcp.');
    expect(deps.getCubeForManagement).toHaveBeenCalledTimes(1);
    expect(deps.evictDrone).toHaveBeenCalledWith(OTHER_DRONE_ID, {
      cubeId: CUBE_ID,
      cubeName: 'borg-mcp',
      targetReference: 'builder-2',
      active: expect.objectContaining({ cubeId: CUBE_ID, droneId: DRONE_ID }),
    });
  });

  it('keeps an unknown label opaque and does not mutate', async () => {
    const { deps } = fixture();
    await expect(runEvictDroneTool({ label: 'unknown', cube_id: CUBE_ID }, deps))
      .rejects.toThrow('Borg server request failed (HTTP 404)');
    expect(deps.evictDrone).not.toHaveBeenCalled();
  });
});
