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
export interface VersionCheckResult {
    stale: boolean;
    message: string | null;
}
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
export declare function compareVersionsForStaleness(installed: string, latest: string): VersionCheckResult;
/**
 * Fetch the latest published borgmcp version from the npm registry.
 * Returns the version string on success, `null` on any failure
 * (timeout, network error, registry change, malformed response).
 * Never throws — caller treats null as "skip the warning."
 */
export declare function fetchLatestBorgmcpVersion(): Promise<string | null>;
//# sourceMappingURL=stale-version-check.d.ts.map