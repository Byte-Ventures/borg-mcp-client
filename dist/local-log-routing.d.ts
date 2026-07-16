export interface LocalRoutingDrone {
    id: string;
    label?: string | null;
    role_id?: string | null;
}
export interface LocalRoutingRole {
    id: string;
    name: string;
    is_human_seat?: boolean;
}
/**
 * Resolve the public `borg_log to:` addressing forms against the local
 * server's authoritative cube roster. This intentionally mirrors the hosted
 * route resolver: exact drone id/label first, then displayed short UUID, then
 * role name/slug expansion. Every failure is closed before the log POST so a
 * miss can never degrade into a broadcast.
 */
export declare function resolveLocalLogRecipients(recipients: readonly string[], drones: readonly LocalRoutingDrone[], roles: readonly LocalRoutingRole[]): string[];
//# sourceMappingURL=local-log-routing.d.ts.map