import { basename } from 'node:path';

const MAX_URL_LEN = 2048;
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

/**
 * Trim + reject control chars + cap length. Returns null on rejection
 * so callers fall through to no-remote derivation.
 */
export function sanitizeRemoteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LEN) return null;
  if (CONTROL_CHAR_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Extract the repo name from a git remote URL. Handles SSH/HTTPS/git/file
 * forms and embedded credentials. Returns null when nothing parseable
 * is present.
 *
 * Strategy: strip protocol + credentials, then take the last path segment
 * after the final `/` or `:`, stripping a trailing `.git`.
 */
export function parseGitRemote(url: string): string | null {
  if (!url) return null;

  let s = url.replace(/^[a-z]+:\/\//, '');
  s = s.replace(/^[^@\/]*@/, '');

  const lastSep = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'));
  if (lastSep === -1) return null;

  let name = s.slice(lastSep + 1);
  name = name.replace(/\.git$/, '');
  return name.length > 0 ? name : null;
}

/**
 * Normalize an arbitrary string into a valid cube name:
 * lowercase, underscores+spaces → hyphens, strip [^a-z0-9-], truncate 64.
 */
export function normalizeCubeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 64);
}

/**
 * Compose the full derivation: sanitize + parse + normalize, with
 * project-root basename as fallback. Returns null when no valid name
 * can be derived.
 */
export function deriveCubeName(projectRoot: string, gitRemoteUrl: string | null): string | null {
  if (gitRemoteUrl) {
    const sanitized = sanitizeRemoteUrl(gitRemoteUrl);
    if (sanitized) {
      const repo = parseGitRemote(sanitized);
      if (repo) {
        const normalized = normalizeCubeName(repo);
        if (normalized.length > 0) return normalized;
      }
    }
  }
  const fallback = normalizeCubeName(basename(projectRoot));
  return fallback.length > 0 ? fallback : null;
}
