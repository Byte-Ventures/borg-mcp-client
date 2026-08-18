import type { EvictDroneResult, ReassignDroneResult } from 'borgmcp-shared/protocol';
import {
  activeCubeWithFreshRegenIdentity,
  getActiveCube,
  refreshActiveCubeMetadata,
  type ActiveCube,
} from './cubes.js';
import {
  assertUuidShape,
  formatEvictDroneSuccess,
  formatReassignDroneSuccess,
  resolveDroneIdByLabel,
} from './evict-drone.js';
import {
  evictDrone,
  getCubeForManagement,
  reassignDrone,
  type LocalManageOperation,
} from './remote-client.js';
import { confirmDisplayIdentity } from './display-identity.js';

interface ManagedCube {
  id: string;
  name: string;
  roles: any[];
  drones: any[];
}

export interface DroneManagementDeps {
  getActiveCube: () => Promise<ActiveCube | null>;
  getCubeForManagement: (
    cubeId: string,
    operation: LocalManageOperation,
    active: ActiveCube,
  ) => Promise<ManagedCube>;
  reassignDrone: (droneId: string, roleId: string, active: ActiveCube) => Promise<ReassignDroneResult>;
  evictDrone: (
    droneId: string,
    options: { cubeId: string; cubeName: string; targetReference: string; active: ActiveCube },
  ) => Promise<EvictDroneResult>;
  refreshActiveCubeMetadata: (active: ActiveCube) => Promise<boolean>;
}

const defaultDeps: DroneManagementDeps = {
  getActiveCube,
  getCubeForManagement,
  reassignDrone,
  evictDrone,
  refreshActiveCubeMetadata,
};

export const STALE_ROLE_DISPLAY_WARNING =
  'Local display warning: The server committed this change, but Borg could not refresh this worktree\'s saved connection metadata. Local role details may be stale. Do not retry the reassignment.\n\n' +
  'Run `borg_regen` to refresh the server-authoritative role. If this session still shows the previous role, restart this agent session once. Do not re-assimilate or repeat the management request.';

function opaqueNotFound(): never {
  throw new Error('Borg server request failed (HTTP 404)');
}

async function requireActiveCube(deps: DroneManagementDeps): Promise<ActiveCube> {
  const active = await deps.getActiveCube();
  if (!active) throw new Error('Not assimilated to a cube. Use borg_assimilate <cube-name> first.');
  return active;
}

// gh#492: tool helpers return the mutation receipt data alongside the rendered
// text so the MCP handler can emit structuredContent from the same source.
export interface ReassignDroneToolResult {
  text: string;
  drone: { id: string; cube_id: string; role_id: string; label: string };
  roleName: string;
  cubeName: string;
}

export interface EvictDroneToolResult {
  text: string;
  droneId: string;
  label: string;
  cubeName: string;
}

export async function runReassignDroneTool(
  input: { droneId: unknown; roleId: unknown },
  deps: DroneManagementDeps = defaultDeps,
): Promise<ReassignDroneToolResult> {
  if (typeof input.droneId !== 'string' || input.droneId.length === 0) {
    throw new Error('drone_id is required');
  }
  if (typeof input.roleId !== 'string' || input.roleId.length === 0) {
    throw new Error('role_id is required');
  }
  assertUuidShape(input.droneId, 'drone_id');
  assertUuidShape(input.roleId, 'role_id');

  const active = await requireActiveCube(deps);
  const operation = {
    operation: `reassign drone ${JSON.stringify(input.droneId)} to role ${JSON.stringify(input.roleId)} in cube ${JSON.stringify(active.name)}`,
    cubeName: active.name,
    noMutation: 'No drone was reassigned.',
  };
  const cube = await deps.getCubeForManagement(active.cubeId, operation, active);
  const priorDrone = cube.drones.find((candidate) => candidate.id === input.droneId);
  const role = cube.roles.find((candidate) => candidate.id === input.roleId);
  if (!priorDrone || !role) opaqueNotFound();

  const { drone } = await deps.reassignDrone(input.droneId, input.roleId, active);
  if (drone.id !== input.droneId || drone.cube_id !== cube.id || drone.role_id !== input.roleId) {
    throw new Error(
      '[LOCAL-MANAGE-COMMIT-UNCONFIRMED] The server returned a successful reassignment response for unexpected identifiers. The reassignment may already be committed. Do not retry blindly; inspect the cube roster first.',
    );
  }

  let warning = '';
  if (drone.id === active.droneId) {
    confirmDisplayIdentity(active, {
      cubeName: cube.name,
      droneLabel: drone.label,
      roleName: role.name,
    });
    try {
      const refreshed = await deps.refreshActiveCubeMetadata(activeCubeWithFreshRegenIdentity(active, {
        cube,
        drone,
        role,
      }));
      if (!refreshed) warning = `\n\n${STALE_ROLE_DISPLAY_WARNING}`;
    } catch {
      warning = `\n\n${STALE_ROLE_DISPLAY_WARNING}`;
    }
  }

  return {
    text: formatReassignDroneSuccess({
      droneLabel: drone.label,
      cubeName: cube.name,
      roleName: role.name,
      droneId: drone.id,
      roleId: drone.role_id,
    }) + warning,
    drone: { id: drone.id, cube_id: drone.cube_id, role_id: drone.role_id, label: drone.label },
    roleName: role.name,
    cubeName: cube.name,
  };
}

export async function runEvictDroneTool(
  args: Record<string, unknown> | undefined,
  deps: DroneManagementDeps = defaultDeps,
): Promise<EvictDroneToolResult> {
  const droneIdInput = typeof args?.drone_id === 'string' ? args.drone_id : undefined;
  const labelInput = typeof args?.label === 'string' ? args.label.trim() : undefined;
  const cubeIdInput = typeof args?.cube_id === 'string' ? args.cube_id : undefined;
  if (droneIdInput !== undefined && (labelInput !== undefined || cubeIdInput !== undefined)) {
    throw new Error('Provide drone_id OR label with cube_id, not both.');
  }
  if (droneIdInput === undefined && (!labelInput || !cubeIdInput)) {
    throw new Error('Provide drone_id OR both label and cube_id.');
  }
  if (droneIdInput !== undefined) assertUuidShape(droneIdInput, 'drone_id');
  if (cubeIdInput !== undefined) assertUuidShape(cubeIdInput, 'cube_id');

  const active = await requireActiveCube(deps);
  const cubeId = droneIdInput === undefined ? cubeIdInput! : active.cubeId;
  const targetReference = labelInput ?? droneIdInput!;
  const fallbackCubeName = cubeId === active.cubeId ? active.name : cubeId;
  const operation = {
    operation: `remove ${JSON.stringify(targetReference)} from cube ${JSON.stringify(fallbackCubeName)}`,
    cubeName: fallbackCubeName,
    noMutation: 'No drone was removed.',
  };
  const cube = await deps.getCubeForManagement(cubeId, operation, active);
  const priorDrone = labelInput === undefined
    ? cube.drones.find((candidate) => candidate.id === droneIdInput)
    : resolveDroneIdByLabel(cube.drones, labelInput);
  if (!priorDrone) opaqueNotFound();

  const result = await deps.evictDrone(priorDrone.id, {
    cubeId,
    cubeName: cube.name,
    targetReference,
    active,
  });
  if (result.drone_id !== priorDrone.id || result.evicted !== true) {
    throw new Error(
      '[LOCAL-MANAGE-COMMIT-UNCONFIRMED] The server returned a successful eviction response for an unexpected drone. The eviction may already be committed. Do not retry blindly; inspect the cube roster first.',
    );
  }
  return {
    text: formatEvictDroneSuccess(priorDrone.label, cube.name),
    droneId: priorDrone.id,
    label: priorDrone.label,
    cubeName: cube.name,
  };
}
