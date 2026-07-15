/**
 * Runtime version reader.
 *
 * Single source of truth for the borgmcp client version — read at runtime
 * from `package.json` relative to `import.meta.url`, NOT hardcoded.
 *
 * Consumers:
 *   - `index.ts` — passed into the MCP `Server({ name, version })`
 *     constructor so Claude Code's `/mcp` view shows the real version
 *     instead of the long-standing hardcoded "0.1.0".
 *   - `claude.ts` / `setup.ts` / `regen.ts` / `log-audit.ts` — each
 *     binary supports a `--version` flag that prints `borgmcp X.Y.Z`
 *     and exits 0 before any side-effecting work begins.
 *
 * Implementation notes:
 *   - Uses `readFileSync` on the resolved path relative to this module's
 *     `import.meta.url`. The compiled `dist/version.js` sits one level
 *     above `package.json` at the package root, so `../package.json` is
 *     the relative resolution. This works under both `node dist/...`
 *     and `npm run start`; the path resolution is independent of CWD.
 *   - Result is cached at module-eval time. The package.json is part of
 *     the published tarball and immutable for any given install.
 *   - Falls back to `'unknown'` if the read fails (corrupted install,
 *     someone deleted package.json, etc.) — never throws, so a fresh
 *     `--version` invocation can't kill a CLI launch.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function readPackageVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = join(dirname(here), '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

const VERSION = readPackageVersion();

/**
 * Return the installed borgmcp version (the same string as
 * `client/package.json`'s `version` field). Cached at module load.
 */
export function getPackageVersion(): string {
  return VERSION;
}

/**
 * Standard `--version` handler — call near the top of any CLI entry
 * point. If `process.argv` contains `--version` or `-v`, prints
 * `borgmcp X.Y.Z` to stdout and exits 0. Otherwise returns silently
 * so the caller can continue with normal CLI work.
 *
 * Examples:
 *   - `borg --version`    → "borgmcp 0.6.0"
 *   - `borg-mcp -v`       → "borgmcp 0.6.0"
 *   - `borg assimilate`   → continues to assimilation flow
 *   - `borg-setup`        → continues to interactive OAuth wizard
 */
/**
 * gh#285: read the on-disk package.json version fresh (not cached).
 * Used by the regen handler to detect post-upgrade version mismatch.
 */
export function getOnDiskVersion(): string {
  return readPackageVersion();
}

export function handleVersionFlag(): void {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`borgmcp ${VERSION}\n`);
    process.exit(0);
  }
}
