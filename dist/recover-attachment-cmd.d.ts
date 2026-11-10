import { type AttachmentAttempt, type SeatRecord } from './seats.js';
import { type ReconcileAttachmentAction, type ReconcileAttachmentResponse } from 'borgmcp-shared';
export interface RecoverAttachmentFlags {
    host: string;
    attempt: string;
    retire?: boolean;
    yes?: boolean;
}
export declare function parseRecoverAttachmentArgs(args: string[]): {
    ok: true;
    flags: RecoverAttachmentFlags;
} | {
    ok: false;
    error: string;
};
export interface RecoveryContext {
    origin: string;
    trustIdentity: string;
    clientId: string;
    worktree: string;
    targetAbsent?: (target: string) => Promise<boolean>;
    reconcile: (entry: AttachmentAttempt, action: ReconcileAttachmentAction) => Promise<ReconcileAttachmentResponse>;
    resume: (entry: AttachmentAttempt, record: SeatRecord) => Promise<boolean>;
}
export interface RecoverAttachmentDeps {
    context: (host: string) => Promise<RecoveryContext>;
    prompt: (message: string) => Promise<string>;
    isTTY: () => boolean;
    stdout: (message: string) => void;
    stderr: (message: string) => void;
}
export declare function runRecoverAttachment(flags: RecoverAttachmentFlags, deps: RecoverAttachmentDeps): Promise<number>;
export declare function buildDefaultRecoverAttachmentDeps(): RecoverAttachmentDeps;
//# sourceMappingURL=recover-attachment-cmd.d.ts.map