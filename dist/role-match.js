const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
export function assertRoleMatches(requested, returned) {
    const req = requested.trim();
    const matches = UUID_RE.test(req)
        ? returned.id === req
        : (returned.name ?? '').trim().toLowerCase() === req.toLowerCase();
    if (!matches) {
        throw new Error(`server does not support named-role lookup yet (returned "${returned.name ?? '?'}" for "${requested}") — worker upgrade pending`);
    }
}
//# sourceMappingURL=role-match.js.map