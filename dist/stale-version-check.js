/**
 * Sprint 7 (b) — stale-binary defensive hardening (gh#148 close-out).
 *
 * drone-3's v0.8.0 case (cube log 2026-05-18T10:35Z) ran for months
 * without warning that v0.8.10 had shipped the gh#71 carve-out for
 * own-drone heartbeat-pings. The silent-stale-binary failure mode
 * costs cube collective time to diagnose because the gap between
 * "installed version" and "latest published" is invisible to the
 * operator.
 *
 * This module surfaces that gap at borg launch time via a stderr
 * warning. Network check against npmjs.org registry is async +
 * timeout-gated so a slow registry doesn't block the operator. Fails
 * silently on any error (network failure, registry change,
 * prerelease version, etc.) — defense-in-depth, never a blocker.
 */
const NPM_REGISTRY_LATEST_URL = 'https://registry.npmjs.org/borgmcp/latest';
const FETCH_TIMEOUT_MS = 2000;
const MINOR_VERSIONS_BEHIND_THRESHOLD = 1;
/**
 * Pure compare: given an installed version string and a latest version
 * string, decide whether to warn. Both strings are expected in semver
 * `MAJOR.MINOR.PATCH` form (no prerelease, no build metadata).
 *
 * Returns `{stale: true, message}` when installed is at least
 * MINOR_VERSIONS_BEHIND_THRESHOLD minor versions behind latest on the
 * same major. Defaults conservatively — unparseable input, prerelease
 * tags, or anything weird returns `stale: false` so we never
 * false-positive on edge cases.
 */
export function compareVersionsForStaleness(installed, latest) {
    const installedParts = parseSemver(installed);
    const latestParts = parseSemver(latest);
    if (!installedParts || !latestParts) {
        return { stale: false, message: null };
    }
    // Don't warn across major-version transitions — those are
    // explicit migrations the operator is aware of (or should be); the
    // warning shape isn't the right surface for them.
    if (installedParts.major !== latestParts.major) {
        return { stale: false, message: null };
    }
    const minorDelta = latestParts.minor - installedParts.minor;
    if (minorDelta < MINOR_VERSIONS_BEHIND_THRESHOLD) {
        return { stale: false, message: null };
    }
    // Lead-with-warning shape per drone-7 UX-FOLLOWUP 2026-05-18T13:49:54Z:
    // both versions explicit (no "N versions behind" count ambiguity that
    // flattens severity perception), single actionable command, no
    // backticks (terminal renders them as literal characters). Fits the
    // Coordinator-discipline 80-char preview rule. drone-1 ratified the
    // (X) network-check approach + this copy shape at 13:49:59Z.
    // minorDelta is informational; intentionally not surfaced.
    void minorDelta;
    const message = `⚠ borgmcp ${installed} is behind latest ${latest} — npm install -g borgmcp@latest`;
    return { stale: true, message };
}
function parseSemver(s) {
    // Strict MAJOR.MINOR.PATCH; rejects prerelease tags, build metadata,
    // empty / 'unknown' / malformed strings. Conservative on purpose:
    // ambiguous version strings should not trigger a warning.
    if (typeof s !== 'string' || s.length === 0)
        return null;
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
    if (!match)
        return null;
    return {
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: parseInt(match[3], 10),
    };
}
/**
 * Fetch the latest published borgmcp version from the npm registry.
 * Returns the version string on success, `null` on any failure
 * (timeout, network error, registry change, malformed response).
 * Never throws — caller treats null as "skip the warning."
 */
export async function fetchLatestBorgmcpVersion() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(NPM_REGISTRY_LATEST_URL, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
        });
        if (!response.ok)
            return null;
        const body = (await response.json());
        if (typeof body.version !== 'string' || body.version.length === 0)
            return null;
        return body.version;
    }
    catch {
        // AbortError, network error, parse error — all treated as "skip silently."
        return null;
    }
    finally {
        clearTimeout(timeout);
    }
}
//# sourceMappingURL=stale-version-check.js.map