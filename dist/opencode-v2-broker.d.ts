import type { OpenCodeV2Transport } from './opencode-v2-transport.js';
export declare const OPENCODE_V2_DESCRIPTOR_ENV = "BORG_OPENCODE_V2_DESCRIPTOR";
export interface OpenCodeV2Seat {
    worktree: string;
    droneId: string;
    cubeId: string;
}
export interface OpenCodeV2Descriptor {
    generation: 2;
    launch: string;
    url: string;
    capability: string;
    seat: OpenCodeV2Seat;
    sessionID: string;
    server: {
        pid: number;
        version: string;
    };
}
/** Use an opened fd for validation and reading; refuse path substitution/symlinks. */
export declare function readOpenCodeV2Descriptor(filename: string): OpenCodeV2Descriptor;
/** Claims outlive launches so --continue cannot take another drone's session. */
export declare function claimOpenCodeV2Session(sessionID: string, seat: OpenCodeV2Seat, root?: string): void;
export declare function startOpenCodeV2Broker(options: {
    transport: OpenCodeV2Transport;
    seat: OpenCodeV2Seat;
    sessionID: string;
    server: {
        pid: number;
        version: string;
    };
    root?: string;
    launch?: string;
    mcpOptions?: Record<string, unknown>;
    orientation: () => Promise<string>;
}): Promise<{
    descriptorPath: string;
    descriptor: OpenCodeV2Descriptor;
    selectSession: (id: string) => Promise<void>;
    call: (operation: string, body?: Record<string, unknown>) => Promise<any>;
    close(): Promise<void>;
}>;
export declare function callOpenCodeV2Broker(descriptor: OpenCodeV2Descriptor, operation: string, body?: Record<string, unknown>): Promise<any>;
//# sourceMappingURL=opencode-v2-broker.d.ts.map