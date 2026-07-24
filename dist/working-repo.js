/**
 * Resolve the repository identity for the directory hosting this MCP child.
 *
 * The report carries only a canonical repository identity (`host/org/repo`)
 * and its derived name. Local filesystem paths and raw remote URLs are never
 * included in lifecycle metadata.
 */
import { spawnSync } from 'node:child_process';
import { canonicalizeRepositoryIdentity } from 'borgmcp-shared/runtime-metadata';
function defaultRunGit(cwd, args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
    return { status: result.status, stdout: result.stdout };
}
function trimmed(value) {
    const normalized = value?.trim();
    return normalized ? normalized : null;
}
/**
 * Convert a Git remote to the shared canonical public repository identity.
 * Hostile or credential-bearing inputs are rejected rather than sanitized.
 */
export function canonicalizeWorkingRepoIdentity(origin) {
    try {
        const canonical = canonicalizeRepositoryIdentity(origin.trim());
        return {
            name: canonical.working_repo_name,
            origin: canonical.working_repo_origin,
            state: 'known',
        };
    }
    catch {
        return null;
    }
}
/**
 * Return a reportable identity for the caller's current directory.
 *
 * `git rev-parse --show-toplevel` supports both ordinary clones and linked
 * worktrees. Any git failure reports no repository identity instead of
 * disclosing the caller's local filesystem layout.
 */
export function resolveWorkingRepo(cwd = process.cwd(), deps = {}) {
    const runGit = deps.runGit ?? defaultRunGit;
    let rootResult;
    try {
        rootResult = runGit(cwd, ['rev-parse', '--show-toplevel']);
    }
    catch {
        return { name: null, origin: null, state: 'unavailable' };
    }
    const root = rootResult.status === 0 ? trimmed(rootResult.stdout) : null;
    if (!root) {
        return { name: null, origin: null, state: 'unknown' };
    }
    let originResult;
    try {
        originResult = runGit(cwd, ['config', '--get', 'remote.origin.url']);
    }
    catch {
        return { name: null, origin: null, state: 'unavailable' };
    }
    const originRaw = originResult.status === 0 ? trimmed(originResult.stdout) : null;
    if (!originRaw)
        return { name: null, origin: null, state: 'unknown' };
    return canonicalizeWorkingRepoIdentity(originRaw) ?? {
        name: null,
        origin: null,
        state: 'rejected',
    };
}
//# sourceMappingURL=working-repo.js.map