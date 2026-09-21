/**
 * `borg representative <prepare|status|mcp>` — operator entry for the human
 * representative ("Hermes") connection.
 *
 * prepare  binds ONE dedicated non-human-seat drone in this repository's cube
 *          to ONE explicitly named Coordinator drone. It creates/resumes the
 *          seat through the launch-free assimilate seam: no agent CLI starts
 *          and no existing drone's identity is touched.
 * status   shows the saved binding and re-checks it against the live cube.
 * mcp      serves the restricted stdio MCP facade for a generic MCP host.
 *
 * No command accepts a credential: the seat bearer stays in the private seat
 * store and is hydrated in-process only.
 */
import type { Readable, Writable } from 'node:stream';
import type { ActiveCube } from './cubes.js';
import { type RepresentativeBackend, type RepresentativeContext } from './representative-core.js';
import { type RepresentativeStore } from './representative-store.js';
export declare const DEFAULT_REPRESENTATIVE_ROLE = "hermes-representative";
export type RepresentativeCommand = {
    action: 'prepare';
    coordinator: string;
    role: string;
    rebind: boolean;
    worktreeName?: string;
    host?: string;
} | {
    action: 'status';
    worktree?: string;
} | {
    action: 'mcp';
    worktree?: string;
};
export type ParsedRepresentativeArgs = {
    ok: true;
    command: RepresentativeCommand;
} | {
    ok: false;
    error: string;
};
export interface RepresentativeCmdDeps {
    cwd(): string;
    findProjectRoot(dir: string): string;
    /** Hydrates the saved seat bound to exactly this worktree, or null. */
    hydrateSeat(worktree: string): Promise<ActiveCube | null>;
    /** Launch-free seat creation/resume; never starts an agent CLI. */
    prepareSeat(input: {
        role: string;
        worktreeName?: string;
        host?: string;
    }): Promise<{
        code: number;
        worktree?: string;
    }>;
    backendFor(active: ActiveCube): RepresentativeBackend | Promise<RepresentativeBackend>;
    store: RepresentativeStore;
    stdout(text: string): void;
    stderr(text: string): void;
}
export declare function parseRepresentativeArgs(args: readonly string[]): ParsedRepresentativeArgs;
/** Load the saved binding and prove the worktree's hydrated seat is still that exact seat. Fails closed. */
export declare function resolveRepresentativeContext(worktree: string, deps: Pick<RepresentativeCmdDeps, 'hydrateSeat' | 'backendFor' | 'store'>): Promise<RepresentativeContext>;
export declare function hermesConfigSnippet(worktree: string): string;
export declare function runRepresentativePrepare(command: Extract<RepresentativeCommand, {
    action: 'prepare';
}>, deps: RepresentativeCmdDeps): Promise<number>;
export declare function runRepresentativeStatus(command: Extract<RepresentativeCommand, {
    action: 'status';
}>, deps: RepresentativeCmdDeps): Promise<number>;
/**
 * Serve the stdio facade. The binding selection is captured at startup; a later
 * operator rebind is NOT picked up by a running process — calls fail closed
 * until the host restarts it.
 */
export declare function runRepresentativeMcp(command: Extract<RepresentativeCommand, {
    action: 'mcp';
}>, deps: RepresentativeCmdDeps, io: {
    version: string;
    pinSeat?: (active: ActiveCube) => void;
    stdin?: Readable;
    stdout?: Writable;
}): Promise<number>;
export declare function buildDefaultRepresentativeDeps(): Promise<RepresentativeCmdDeps>;
//# sourceMappingURL=representative-cmd.d.ts.map