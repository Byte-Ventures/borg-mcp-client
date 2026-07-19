import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve('.');
const excluded = new Set(['.git', '.claude', '.opencode', 'coverage', 'node_modules', 'release']);
const findings = [];
const oauthValuesByPath = new Map();

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!entry.isFile() || (await lstat(path)).size > 4 * 1024 * 1024) continue;
    const name = relative(root, path).split('\\').join('/');
    const content = await readFile(path, 'utf8');
    const checks = [
      [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
      [/\b(?:npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/, 'package or GitHub token'],
      [/\bpostgres(?:ql)?:\/\//i, 'database URL'],
      [/\b[a-z0-9-]+\.workers\.dev\b/i, 'private Worker endpoint'],
      [/\btest-api\.borgmcp\.ai\b/i, 'private test endpoint'],
      [/(?:\/Users\/theodorstorm|\/home\/theodorstorm|[A-Za-z]:\\Users\\theodorstorm)/i, 'developer-local absolute path'],
      [/from\s+['"]\.\.\/\.\.\/(?:workers|landing-page)\//, 'monorepo-only import'],
    ];
    for (const [pattern, description] of checks) {
      if (pattern.test(content)) findings.push(`${name}: ${description}`);
    }
    const oauthMatches = [
      ...(content.match(/GOCSPX-[A-Za-z0-9_-]+/g) ?? []),
      ...(content.match(/\b[A-Za-z0-9_-]+\.apps\.googleusercontent\.com\b/g) ?? []),
    ];
    if (oauthMatches.length > 0) {
      oauthValuesByPath.set(name, [...new Set(oauthMatches)]);
    }
  }
}

await walk(root);
// Local-only client (server-client-localhost-lan-only-no-cloud): Google OAuth
// was fully removed. There is no longer an allowlisted OAuth-bearing file — ANY
// Google OAuth client material anywhere in the public source is forbidden.
for (const path of oauthValuesByPath.keys()) {
  findings.push(`${path}: Google OAuth client material is forbidden in the local-only client`);
}
if (findings.length > 0) throw new Error(`Public-source sensitivity scan failed:\n${findings.join('\n')}`);
console.log(JSON.stringify({ files: 'scanned', googleOAuthClientMaterial: 'none' }));
