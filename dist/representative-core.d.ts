/**
 * Human representative core ("Hermes"): a SEPARATE, non-human-seat drone that
 * relays the human's requests, questions and decisions to ONE explicitly bound
 * Coordinator drone and reads that Coordinator's replies.
 *
 * It is not the Coordinator and carries none of its playbook: it cannot address
 * workers, broadcast, or manage the cube. Every message is attributed as an
 * automated relay and states whether the content is user-authorized or the
 * model's own advice. Borg does not verify that claim — it is delegate
 * messaging, not server-enforced per-message human authority.
 *
 * The backend is injected so the same logic runs against the real seat-scoped
 * client (`createSeatBackend`) or a controlled test double.
 */
import { ErrorCode, type Role, type RosterDrone as ProtocolDrone, type EnrichedStreamEntry, type DocumentCitation } from 'borgmcp-shared/protocol';
import type { ActiveCube } from './cubes.js';
import { type RepresentativeBinding, type RepresentativeStore } from './representative-store.js';
export declare const REPRESENTATIVE_MESSAGE_LIMIT_BYTES = 3000;
export declare const REPRESENTATIVE_DELIVERY_NOTE: string;
export type RepresentativeErrorCode = typeof ErrorCode.INVALID_INPUT | 'DECISION_REQUIRES_USER_AUTHORIZATION' | 'REQUEST_ID_CONFLICT' | 'AMBIGUOUS_SEND_UNRESOLVED' | 'SEND_REJECTED' | 'REPRESENTATIVE_OWNERSHIP_REQUIRED' | 'NOT_PREPARED' | 'SEAT_UNAVAILABLE' | 'BINDING_MISMATCH' | 'BINDING_CONFLICT' | 'COORDINATOR_NOT_FOUND' | 'COORDINATOR_AMBIGUOUS' | 'COORDINATOR_NOT_HUMAN_SEAT' | 'COORDINATOR_IS_SELF' | 'COORDINATOR_UNAVAILABLE' | 'REPRESENTATIVE_ROLE_NOT_PERMITTED' | 'REPRESENTATIVE_ROLE_MISMATCH' | 'NOT_A_COORDINATOR_REPLY';
export interface RepresentativeErrorDetails {
    owner?: import('./stream-owner.js').StreamOwnershipSnapshot;
    request_id?: string;
    cause_code?: string;
    cause_message?: string;
    recovery?: string;
}
export declare class RepresentativeError extends Error {
    readonly code: RepresentativeErrorCode;
    readonly details?: RepresentativeErrorDetails | undefined;
    constructor(code: RepresentativeErrorCode, message: string, details?: RepresentativeErrorDetails | undefined);
}
type RosterRole = Pick<Role, 'id' | 'name' | 'is_human_seat' | 'role_class'>;
type RosterDrone = Pick<ProtocolDrone, 'id' | 'label' | 'role_id' | 'is_queen_class'>;
type LogEntry = Pick<EnrichedStreamEntry, 'id' | 'drone_id' | 'message' | 'visibility' | 'created_at' | 'recipient_drone_ids' | 'documents'>;
/** The only Borg operations the representative may perform, all seat-scoped. */
export interface RepresentativeBackend {
    whoami(): Promise<{
        cube_id: string;
        cube_name: string;
        drone_id: string;
        drone_label: string;
        role_id: string;
        role_name: string;
    }>;
    roster(): Promise<{
        drones: RosterDrone[];
        roles: RosterRole[];
    }>;
    /**
     * MUST make a single transport attempt and surface the client's typed errors
     * unchanged: a typed 4xx/401/410 refusal is reported as "not stored" only
     * because no hidden retry can sit between a committed write and that answer.
     */
    append(input: {
        postId: string;
        message: string;
        to: string[];
    }): Promise<{
        entry: LogEntry;
        deduplicated: boolean;
        unreachableRecipients?: Array<{
            id: string;
            label: string;
        }>;
    }>;
    /**
     * Drains THIS seat's own unread cursor only (no other drone's cursor exists
     * here) — the WHOLE returned page, including entries the caller then filters
     * out. `limit` is a page-size hint: the client's digest mode may return more.
     */
    readUnread(limit?: number, continuationGuard?: () => Promise<void>): Promise<{
        entries: LogEntry[];
        has_more?: boolean;
    }>;
    readEntry(entryId: string): Promise<{
        entry: LogEntry;
    }>;
    ack(entryId: string): Promise<void>;
}
export interface RepresentativeContext {
    binding: RepresentativeBinding;
    backend: RepresentativeBackend;
    store: RepresentativeStore;
    now?: () => Date;
}
/** Real backend: the existing seat-scoped client calls for one hydrated seat. */
export declare function createSeatBackend(active: ActiveCube): Promise<RepresentativeBackend>;
export declare function assertRepresentativeRole(role: {
    name: string;
    is_human_seat?: boolean;
    role_class?: string;
}, drone?: {
    is_queen_class?: boolean;
}): void;
/**
 * Resolve the ONE Coordinator drone the operator named. Exact label match only;
 * a missing, duplicated, non-human-seat or self target fails — no fallback.
 */
export declare function resolveCoordinator(roster: {
    drones: RosterDrone[];
    roles: RosterRole[];
}, selector: {
    label: string;
    selfDroneId: string;
}): {
    drone: RosterDrone;
    role: RosterRole;
};
export type RepresentativeKind = 'request' | 'question' | 'decision';
export type RepresentativeAuthorization = 'user_authorized' | 'model_advice';
export interface RepresentativeSendInput {
    request_id?: string;
    kind: RepresentativeKind;
    authorization: RepresentativeAuthorization;
    message: string;
}
export interface RepresentativeSendResult {
    outcome: 'sent' | 'ambiguous';
    request_id: string;
    entry_id?: string;
    /** True when the server recognised the post id and stored nothing new. */
    deduplicated?: boolean;
    /** True when the local ledger already held this exact sent request; no network call was made. */
    duplicate?: boolean;
    coordinator: {
        drone_id: string;
        label: string;
    };
    warning?: string;
    /** Ambiguous only: the sanitized underlying failure. */
    cause?: SendFailureCause;
    guidance?: string;
}
export declare function formatRepresentativeMessage(binding: RepresentativeBinding, requestId: string, input: RepresentativeSendInput): string;
export interface SendFailureCause {
    /** Stable, bounded cause code — a typed server/protocol code where one exists. */
    code: string;
    /** Sanitized, bounded underlying message. Never a credential: client errors carry none. */
    message: string;
}
export declare function sendRepresentativeMessage(ctx: RepresentativeContext, raw: unknown): Promise<RepresentativeSendResult>;
export interface RepresentativeReply {
    documents?: DocumentCitation[];
    document_delivery?: string;
    entry_id: string;
    created_at: string;
    from_drone_id: string;
    from_label: string;
    addressed: 'direct' | 'broadcast';
    /** A ledger request id quoted in the reply text. Textual correlation only. */
    in_reply_to: string | null;
    message: string;
}
export declare function readRepresentativeReplies(ctx: RepresentativeContext, raw: unknown): Promise<{
    replies: RepresentativeReply[];
    ignored_entries: number;
    has_more: boolean;
    delivery: string;
}>;
export declare function ackRepresentativeReply(ctx: RepresentativeContext, raw: unknown): Promise<{
    acknowledged: string;
}>;
export declare function representativeStatus(ctx: RepresentativeContext): Promise<{
    role: string;
    connected: boolean;
    problem?: {
        code: string;
        message: string;
    };
    cube: {
        id: string;
        name: string;
    };
    repository_origin: string | null;
    worktree: string;
    representative: {
        drone_id: string;
        label: string;
        role: string;
    };
    coordinator: {
        drone_id: string;
        label: string;
        role: string;
    };
    unresolved_requests: Array<{
        request_id: string;
        state: string;
        kind: string;
        updated_at: string;
    }>;
    delivery: string;
    authority: string;
}>;
export {};
//# sourceMappingURL=representative-core.d.ts.map