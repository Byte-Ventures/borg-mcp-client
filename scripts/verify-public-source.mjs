import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve('.');
const excluded = new Set(['.git', '.claude', '.opencode', 'coverage', 'node_modules', 'release']);
const findings = [];
const maxOAuthMatchesPerFile = 4;
const maxOAuthMatchesGlobal = 8;
const expectedOAuthFingerprints = [
  'fe93485615a89f3db7132351877d7215b69de3ba5bc25bed32a28c08697f7242',
  'ae958146e8947f46544e8e162f9d0b157cac29cd4d4854cf9e295f3f0b6b115f',
  '385408ac72401565fd40515635041d4bd33d9e8bc19488bfc4b237605dcdffef',
  '6915f25f028886263d0d4a649a1d1c4135413ce3c75fb3abd4dbe5916d804031',
].sort();
const sha256StdinScript = fileURLToPath(new URL('./sha256-stdin.mjs', import.meta.url));
const oauthValuesByPath = new Map();
let oauthMatchCount = 0;

function fingerprint(value) {
  return execFileSync(process.execPath, [sha256StdinScript], {
    input: value,
    encoding: 'utf8',
    maxBuffer: 1024,
    timeout: 5_000,
    windowsHide: true,
  }).trim();
}

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
      oauthMatchCount += oauthMatches.length;
      if (oauthMatches.length > maxOAuthMatchesPerFile) {
        findings.push(`${name}: OAuth match cap exceeded (${oauthMatches.length} > ${maxOAuthMatchesPerFile})`);
      }
      oauthValuesByPath.set(name, [...new Set(oauthMatches)]);
    }
  }
}

await walk(root);
if (oauthMatchCount > maxOAuthMatchesGlobal) {
  findings.push(`global OAuth match cap exceeded (${oauthMatchCount} > ${maxOAuthMatchesGlobal})`);
}
// Do not fork the fingerprint helper until the whole tree is known to be
// within both caps and free of other sensitivity findings.
if (findings.length > 0) throw new Error(`Public-source sensitivity scan failed:\n${findings.join('\n')}`);

const oauthFingerprintsByPath = new Map(
  [...oauthValuesByPath].map(([path, values]) => [path, values.map(fingerprint).sort()]),
);
for (const path of ['src/auth.ts', 'dist/auth.js']) {
  const actual = oauthFingerprintsByPath.get(path) ?? [];
  if (JSON.stringify(actual) !== JSON.stringify(expectedOAuthFingerprints)) {
    findings.push(`${path}: installed-application OAuth public-client allowlist mismatch`);
  }
  oauthFingerprintsByPath.delete(path);
}
for (const path of oauthFingerprintsByPath.keys()) {
  findings.push(`${path}: Google OAuth client material outside the two allowed files`);
}
if (findings.length > 0) throw new Error(`Public-source sensitivity scan failed:\n${findings.join('\n')}`);
console.log(JSON.stringify({ files: 'scanned', allowedGoogleOAuthPublicClientValues: 4, copies: 2 }));
