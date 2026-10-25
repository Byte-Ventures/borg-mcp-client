import { type OpenCodeV2Seat } from './opencode-v2-broker.js';
import type { OpenCodeConnectionState } from './opencode-drone.js';
export declare function connectOpenCodeV2Runtime(seat: OpenCodeV2Seat, env?: NodeJS.ProcessEnv): Promise<boolean>;
export declare function injectOpenCodeV2Entry(text: string, entryId?: string, allowSubmit?: boolean, sourceEntryId?: string, isSourcePending?: () => Promise<boolean>): Promise<boolean>;
export declare function settleOpenCodeV2Entry(source: string): void;
export declare function notifyOpenCodeV2LogPersisted(observedSessionID: unknown): Promise<void>;
export declare function resolveOpenCodeV2SessionID(): Promise<string | null>;
export declare function getOpenCodeV2ConnectionState(): OpenCodeConnectionState | null;
//# sourceMappingURL=opencode-v2-runtime.d.ts.map