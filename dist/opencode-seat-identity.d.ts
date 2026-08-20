import type { ActiveCube } from './cubes.js';
export type OpenCodeSeatIdentityErrorCode = 'IDENTITY_HANDSHAKE_TIMEOUT' | 'ROOTS_UNAVAILABLE' | 'ROOTS_INVALID' | 'SEAT_NOT_FOUND' | 'SEAT_WORKTREE_MISMATCH';
export declare class OpenCodeSeatIdentityError extends Error {
    readonly code: OpenCodeSeatIdentityErrorCode;
    readonly sessionDirectory?: string | undefined;
    readonly seat?: Pick<ActiveCube, "droneLabel" | "worktree"> | undefined;
    constructor(code: OpenCodeSeatIdentityErrorCode, message: string, sessionDirectory?: string | undefined, seat?: Pick<ActiveCube, "droneLabel" | "worktree"> | undefined);
}
export interface OpenCodeSeatIdentityDeps {
    listRoots: () => Promise<{
        roots?: Array<{
            uri?: string;
        }>;
    }>;
    findProjectRoot: (directory: string) => string;
    getActiveCubeForWorktree: (worktree: string) => Promise<ActiveCube | null>;
    pinSeatIdentity: (active: ActiveCube) => void;
    childCwd: string;
}
export declare function resolveOpenCodeSeatIdentity(deps: OpenCodeSeatIdentityDeps): Promise<ActiveCube>;
export declare function formatOpenCodeSeatIdentityError(error: OpenCodeSeatIdentityError, childCwd: string): string;
//# sourceMappingURL=opencode-seat-identity.d.ts.map