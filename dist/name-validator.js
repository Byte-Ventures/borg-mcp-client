/**
 * Validates an identifier used in worktree paths and other safety-critical
 * positions (must survive shell-arg parsing without escaping).
 *
 * Allowed: lowercase ASCII letters, digits, hyphens, underscores.
 * Length 1–48. Anchored. No leading hyphen (would parse as a flag).
 */
const NAME_RE = /^[a-z0-9_][a-z0-9_-]{0,47}$/;
export function validateName(name) {
    if (name.length === 0) {
        return { ok: false, error: `name must not be empty` };
    }
    if (!NAME_RE.test(name)) {
        return {
            ok: false,
            error: `invalid name "${name}". Use lowercase letters, digits, hyphens, or ` +
                `underscores; max 48 chars; must not start with a hyphen.`,
        };
    }
    return { ok: true };
}
//# sourceMappingURL=name-validator.js.map