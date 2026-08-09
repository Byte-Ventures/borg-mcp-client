import { type ActiveCube, type BorgCli, type LaunchSeatExpectation } from './cubes.js';
import { type SeatRecord } from './seats.js';
export type LocalSeatState = 'active' | 'pending';
export interface LocalSeatRow {
    droneLabel: string;
    droneId: string;
    cubeName: string;
    cubeId: string;
    worktree: string;
    canonicalWorktree: string | null;
    credentialRef: string;
    cli: BorgCli | null;
    state: LocalSeatState;
}
export interface SeatCommandDeps {
    readAllProjectIdentities: () => Promise<Array<{
        projectPath: string;
        cube: ActiveCube;
    }>>;
    readAllBoundSeats: () => Promise<Array<{
        worktree: string;
        record: SeatRecord;
    }>>;
    getActiveSeatForWorktree: (worktree: string) => Promise<SeatRecord | null>;
    getProjectCliPreference: (worktree: string) => Promise<BorgCli | null>;
    pathExists: (path: string) => boolean;
    realpath: (path: string) => string;
    /** Run this same borg executable with no args from the selected worktree,
     * carrying only the expected durable identity for child-side verification. */
    launchBareBorg: (worktree: string, expectation: LaunchSeatExpectation) => Promise<number>;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
}
export type ParsedSeatsArgs = {
    ok: true;
} | {
    ok: false;
    error: string;
};
export declare function parseSeatsArgs(args: readonly string[]): ParsedSeatsArgs;
export type ParsedLaunchSeatArgs = {
    ok: true;
    target: string;
    cube?: string;
} | {
    ok: false;
    error: string;
};
export declare function parseLaunchSeatArgs(args: readonly string[]): ParsedLaunchSeatArgs;
export declare function readLocalSeatRows(deps: SeatCommandDeps): Promise<LocalSeatRow[]>;
export declare function formatLocalSeatRows(rows: readonly LocalSeatRow[]): string;
export declare function runSeats(deps: SeatCommandDeps): Promise<number>;
export declare function runLaunchSeat(args: {
    target: string;
    cube?: string;
}, deps: SeatCommandDeps): Promise<number>;
export declare function buildDefaultSeatCommandDeps(): SeatCommandDeps;
//# sourceMappingURL=seat-commands.d.ts.map