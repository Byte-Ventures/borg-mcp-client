import type { OpenCodeClient } from '@opencode/client';
import type { OpenCodeV2Server } from './opencode-v2-server.js';
/** Borg records deliberately do not expose either host's wire message shape. */
export interface BorgOpenCodeMessage {
    id: string;
    role: 'user' | 'assistant' | 'other';
    text: string;
    metadata: Record<string, unknown>;
    tools: {
        id: string;
        name: string;
        status: string;
    }[];
}
export declare function decodeOpenCodeV2Message(value: unknown): BorgOpenCodeMessage | null;
export interface OpenCodeV2Transport {
    client: OpenCodeClient;
    nextMessageID(): string;
    message(sessionID: string, messageID: string): Promise<BorgOpenCodeMessage | null>;
}
export declare function createOpenCodeV2Transport(server: OpenCodeV2Server): Promise<OpenCodeV2Transport>;
//# sourceMappingURL=opencode-v2-transport.d.ts.map