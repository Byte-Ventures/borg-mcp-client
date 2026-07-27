import type { ActiveCube } from './cubes.js';
export type DisplayIdentity = {
    cubeName: string;
    droneLabel: string;
    roleName: string | null;
};
export type ServerDisplayIdentity = Partial<DisplayIdentity>;
/** Seed the invocation-local display source from the exact seat selected by #63. */
export declare function seedDisplayIdentity(active: ActiveCube): void;
/** Apply server-authoritative fields and clear uncertainty only for those fields. */
export declare function confirmDisplayIdentity(active: ActiveCube, identity: ServerDisplayIdentity): DisplayIdentity;
/** Mark the current seat identity as last-confirmed after an identity read fails. */
export declare function markDisplayIdentityReadFailed(active: ActiveCube): void;
export declare function renderDisplayIdentity(active: ActiveCube): DisplayIdentity;
/** Synchronous view for console-prefix after initConsolePrefix seeds the seat. */
export declare function currentDisplayIdentity(): DisplayIdentity | null;
export declare function identityFromRegen(result: {
    cube?: {
        name?: string | null;
    };
    drone?: {
        label?: string | null;
    };
    role?: {
        name?: string | null;
    };
}): ServerDisplayIdentity;
export declare function withRenderedRegenIdentity<T extends {
    cube?: Record<string, unknown>;
    drone?: Record<string, unknown>;
    role?: Record<string, unknown>;
}>(result: T, identity: DisplayIdentity): T;
export declare function _resetDisplayIdentityForTests(): void;
//# sourceMappingURL=display-identity.d.ts.map