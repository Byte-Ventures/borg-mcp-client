import { type EnrichedEntry } from './log-stream.js';
import type { LocalServerCursor } from './local-server-cursor.js';
import type { RepresentativeBinding } from './representative-store.js';
export interface ListenerHint {
    event: 'entry';
    entry_id: string;
    created_at: string;
    from_label: string;
    from_role: string;
    visibility: 'direct' | 'broadcast' | null;
    request_id: string | null;
    documents: number | null;
    replay: boolean;
}
export declare function listenerPaths(binding: RepresentativeBinding): {
    directory: string;
    inbox: string;
    state: string;
};
export declare function createListenerInbox(binding: RepresentativeBinding, guard?: () => Promise<void>): {
    paths: {
        directory: string;
        inbox: string;
        state: string;
    };
    snapshot: () => Promise<{
        watermark: string | null;
        inbox: string;
    }>;
    dedupeCursor: () => Promise<LocalServerCursor | null>;
    cursor: () => Promise<LocalServerCursor | null>;
    clearCursor: () => Promise<void>;
    replay: (after: string) => Promise<{
        missing: boolean;
        hints: ListenerHint[];
    }>;
    append: (entry: EnrichedEntry & {
        id: string;
        created_at: string;
        visibility: "direct" | "broadcast";
    }, catchupCursor?: LocalServerCursor | null) => Promise<ListenerHint | null>;
};
//# sourceMappingURL=representative-listener-store.d.ts.map