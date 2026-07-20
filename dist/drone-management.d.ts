import type { EvictDroneResult, ReassignDroneResult } from 'borgmcp-shared/protocol';
import { type ActiveCube } from './cubes.js';
import { type LocalManageOperation } from './remote-client.js';
interface ManagedCube {
    id: string;
    name: string;
    roles: any[];
    drones: any[];
}
export interface DroneManagementDeps {
    getActiveCube: () => Promise<ActiveCube | null>;
    getCubeForManagement: (cubeId: string, operation: LocalManageOperation, active: ActiveCube) => Promise<ManagedCube>;
    reassignDrone: (droneId: string, roleId: string, active: ActiveCube) => Promise<ReassignDroneResult>;
    evictDrone: (droneId: string, options: {
        cubeId: string;
        cubeName: string;
        targetReference: string;
        active: ActiveCube;
    }) => Promise<EvictDroneResult>;
    refreshActiveCubeMetadata: (active: ActiveCube) => Promise<boolean>;
}
export declare const STALE_ROLE_DISPLAY_WARNING: string;
export declare function runReassignDroneTool(input: {
    droneId: unknown;
    roleId: unknown;
}, deps?: DroneManagementDeps): Promise<string>;
export declare function runEvictDroneTool(args: Record<string, unknown> | undefined, deps?: DroneManagementDeps): Promise<string>;
export {};
//# sourceMappingURL=drone-management.d.ts.map