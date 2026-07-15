/**
 * Rollout-compat guard. An old worker ignores the `?role=` param and
 * returns the CALLER's own role, so a new client on a not-yet-deployed
 * worker would silently show the wrong playbook. Verify the returned
 * role actually matches the request: by id when the input was a uuid,
 * otherwise by case-insensitive trimmed name.
 *
 * Benign residual: if the requested name/id equals the caller's OWN role,
 * an old worker's echo passes the check — but that echo IS the correct role
 * (names are unique per cube, ids globally unique), so no wrong playbook is
 * ever shown. The guard only needs to catch a request for a DIFFERENT role.
 */
export declare function assertRoleMatches(requested: string, returned: {
    id?: string | null;
    name?: string | null;
}): void;
//# sourceMappingURL=role-match.d.ts.map