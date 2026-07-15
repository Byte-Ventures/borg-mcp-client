/**
 * Resolve the repository identity for the directory hosting this MCP child.
 *
 * The report carries only a canonical repository identity (`host/org/repo`)
 * and its derived name. Local filesystem paths and raw remote URLs are never
 * included in lifecycle metadata.
 */

import { spawnSync } from 'node:child_process';
export interface WorkingRepo {
  name: string | null;
  /** Canonical host/path identity, never a raw Git remote URL. */
  origin: string | null;
}

export interface WorkingRepoDeps {
  runGit?: (
    cwd: string,
    args: string[]
  ) => { status: number | null; stdout?: string | null };
}

function defaultRunGit(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout };
}

function trimmed(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function nameFromIdentity(identity: string): string | null {
  const lastPathSegment = identity.replace(/\/$/, '').split('/').pop();
  const name = lastPathSegment?.replace(/\.git$/i, '').trim();
  return name || null;
}

/**
 * Convert a Git remote to a non-secret `host/org/repo` identity.
 *
 * URL userinfo, query strings, fragments, scheme, and SCP-style user prefixes
 * are deliberately discarded. Inputs that cannot identify a host and path are
 * treated as unreportable rather than forwarded verbatim.
 */
export function canonicalizeWorkingRepoIdentity(origin: string): string | null {
  const raw = origin.trim();
  if (!raw) return null;
  // Remote clients send this canonical form on subsequent lifecycle calls.
  const canonical = raw.match(/^([A-Za-z0-9.-]+)\/([^?#\s]+)$/);
  if (canonical) {
    const host = canonical[1].toLowerCase();
    const path = canonical[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return host && path ? `${host}/${path}` : null;
  }
  try {
    const url = new URL(origin);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return url.hostname && path ? `${url.hostname.toLowerCase()}/${path}` : null;
  } catch {
    // SCP-style SSH remote: discard its optional user prefix and URL-like
    // query/fragment suffix before accepting only host + repository path.
    const match = raw.match(/^(?:[^@\s/:]+@)?([A-Za-z0-9.-]+):\/?([^?#\s]+)(?:[?#].*)?$/);
    if (match) {
      const host = match[1].toLowerCase();
      const path = match[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
      return host && path ? `${host}/${path}` : null;
    }
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
export function resolveWorkingRepo(
  cwd: string = process.cwd(),
  deps: WorkingRepoDeps = {}
): WorkingRepo {
  const runGit = deps.runGit ?? defaultRunGit;
  const rootResult = runGit(cwd, ['rev-parse', '--show-toplevel']);
  const root = rootResult.status === 0 ? trimmed(rootResult.stdout) : null;
  if (!root) {
    return { name: null, origin: null };
  }

  const originResult = runGit(cwd, ['config', '--get', 'remote.origin.url']);
  const originRaw = originResult.status === 0 ? trimmed(originResult.stdout) : null;
  const origin = originRaw ? canonicalizeWorkingRepoIdentity(originRaw) : null;
  return {
    name: origin ? nameFromIdentity(origin) : null,
    origin,
  };
}
