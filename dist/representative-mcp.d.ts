/**
 * Restricted stdio MCP facade for the human representative.
 *
 * A Borg server speaks pinned-TLS HTTPS, not MCP, so a generic MCP host reaches
 * it through this local stdio process. The surface is four tools: status, send
 * (to the ONE bound Coordinator), read (that Coordinator's replies) and ack.
 * There is deliberately no log/broadcast/dispatch, roster-management, grant,
 * evict, release, regen or server-lifecycle tool, and no dispatcher escape hatch.
 *
 * The connection context is resolved per call and injected, so the same facade
 * runs over the real seat-scoped backend or a controlled test backend.
 */
import type { Readable, Writable } from 'node:stream';
import { type RepresentativeContext } from './representative-core.js';
export declare const REPRESENTATIVE_TOOL_NAMES: readonly ["borg_representative-status", "borg_representative-send", "borg_representative-read", "borg_representative-ack"];
export declare const REPRESENTATIVE_INSTRUCTIONS: string;
export interface ServeRepresentativeOptions {
    /** Resolved on every call; a throw fails that call closed. */
    context: () => Promise<RepresentativeContext>;
    version: string;
    stdin?: Readable;
    stdout?: Writable;
}
export declare function serveRepresentativeMcp(options: ServeRepresentativeOptions): Promise<{
    close: () => Promise<void>;
    closed: Promise<void>;
}>;
//# sourceMappingURL=representative-mcp.d.ts.map