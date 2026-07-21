import { type ActiveCube } from './cubes.js';
import { prepareSeatReplacement, promoteSeatReplacement, refreshActiveSeatSession, scrubSeatReplacement, type SeatRecord } from './seats.js';
export declare const SESSION_RENEWAL_LEAD_MS: number;
interface AttachOutcome {
    result: 'created' | 'reused';
    droneId: string;
    sessionId: string;
    expiresAt: string;
}
interface SessionContinuityDeps {
    now(): number;
    randomCredential(): string;
    getSeat(ref: string, binding: {
        origin: string;
        trustIdentity: string;
        cubeId: string;
    }): Promise<SeatRecord | null>;
    getActive(): Promise<ActiveCube | null>;
    getParentCredential(origin: string, trustIdentity: string): Promise<string | null>;
    sendAttach(record: SeatRecord, bearer: string, parentCredential: string): Promise<AttachOutcome>;
    prepareReplacement: typeof prepareSeatReplacement;
    refreshSession: typeof refreshActiveSeatSession;
    promoteReplacement: typeof promoteSeatReplacement;
    scrubReplacement: typeof scrubSeatReplacement;
}
export declare function ensureLocalSessionFresh(active: ActiveCube): Promise<ActiveCube>;
export declare function recoverExpiredLocalSession(active: ActiveCube): Promise<ActiveCube>;
/** @internal */
export declare function __renewLocalSessionForTest(active: ActiveCube, mode: 'proactive' | 'expired', deps: SessionContinuityDeps): Promise<ActiveCube>;
/** @internal */
export declare function __resetSessionContinuityForTest(): void;
export {};
//# sourceMappingURL=session-continuity.d.ts.map