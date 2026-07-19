import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, lstat, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyManifest } from './verify-release-readiness.mjs';

const MAX_PACKED_BYTES = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 30 * 1024 * 1024;
const MAX_FILES = 2048;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const REQUIRED_FILES = ['CONTRIBUTING.md', 'LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'package.json'];
const ALLOWED_ROOTS = new Set([
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'dist',
  'docs',
  'package.json',
  'src',
]);
const FORBIDDEN_CONTENT = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, description: 'private key material' },
  { pattern: /\b(?:npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/, description: 'credential-shaped token' },
  { pattern: /\bpostgres(?:ql)?:\/\//i, description: 'database connection URL' },
  { pattern: /\b[a-z0-9-]+\.workers\.dev\b/i, description: 'Worker service URL' },
  { pattern: /(?:^|[^A-Za-z])(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/m, description: 'local absolute path' },
  // Local-only client (server-client-localhost-lan-only-no-cloud): no hosted
  // Borg API/product URL may appear in ANY shipped file (dist, src, docs, README).
  { pattern: /\/\/api\.borgmcp\.ai/i, description: 'hosted Borg API URL' },
  { pattern: /borgmcp\.ai\/(?:dashboard|get-started|pricing|account|upgrade|subscribe)/i, description: 'hosted Borg product URL' },
];
// Operator-facing DOCS copy migrated OFF the OS keychain / `cubes.json` seat
// model onto the local 0600-permission seat store. No shipped `.md` doc may
// reintroduce the retired keychain/cubes.json recovery vocabulary. Checked ONLY
// for `.md` files — internal `src`/`dist` comments legitimately name the retired
// machinery (locks, refs, the historical project file) to describe the code.
const DOCS_FORBIDDEN_CONTENT = [
  { pattern: /\bkeychain\b/i, description: 'retired OS-keychain seat guidance' },
  { pattern: /\bcubes\.json\b/i, description: 'retired cubes.json seat reference' },
];
// Item 7 (release-integrity): shipped `.md` docs must describe the PUBLISHED
// borgmcp-shared@<pin> v2 release — never a stale numbered-server (`server #N`)
// attribution, WIP release framing, or the RETIRED re-attach retry-tuple ROTATION
// claim (the client bearer is the sole correlator, REUSED not rotated). Precise: the
// accurate publish-timing "preview-only" statement and the accurate enrollment/
// cube-creation `retry_key` / retry-tuple line are NOT flagged (they never say
// "rotate", never numberer a server release, never sit "retry tuple" beside
// "reattach"). The shared-version mismatch check is enforced against the PIN below.
const DOCS_STALE_RELEASE_FRAMING = [
  { pattern: /server #\d+/i, description: 'stale numbered-server release attribution' },
  { pattern: /\bWIP\b/, description: 'stale WIP release framing' },
  { pattern: /\brotat\w*\b[^.\n]{0,40}\bretry\b/i, description: 'retired re-attach retry-tuple rotation claim' },
  { pattern: /reattach\w*[^.\n]{0,60}retry tuple/i, description: 'retired re-attach retry-tuple rotation claim' },
];
// Reachable-cloud runtime identifiers (OAuth / billing / dashboard / reports).
// Checked ONLY in shipped code (dist `.js`/`.d.ts`, src `.ts`) — NOT in `.md`
// docs, which legitimately DESCRIBE the removal of these surfaces.
const CLOUD_RUNTIME_SYMBOLS = [
  'authenticateWithGoogle',
  'refreshIdToken',
  'getValidToken',
  'createSubscription',
  'checkSubscriptionStatus',
  'createBillingPortalSession',
  'submitReport',
  'fetchReports',
  'startHealthBeatTick',
  'borg_subscribe',
  'borg_upgrade-subscription',
  'borg_subscription_status',
  'borg_open_dashboard',
  'borg_report-friction',
  'borg_reports',
  'dashboard',
  'registry.npmjs.org',
  'fetchLatestBorgmcpVersion',
];
const LEGACY_AUTHORITY_ROUTE = /\/api\/(?:drone(?:\/|[?'"`])|drones\/|roles\/|templates(?:\/|[?'"`])|assimilate(?:[?'"`]))/;
const LEGACY_AUTHORIZATION_COPY = /\bowner-scoped\b|\bcube ownership\b|\bRLS\b|\bcubes? owned by\b|USER\/OWNER|NON-OWNER|OWNER's|caller owns|owner level/i;
const AUTHORIZATION_COPY_PATHS = new Set([
  'src/tool-manifest.ts',
  'src/tool-scope.ts',
  'src/remote-client.ts',
  'dist/tool-manifest.js',
  'dist/tool-manifest.d.ts',
  'dist/tool-scope.js',
  'dist/tool-scope.d.ts',
  'dist/remote-client.js',
  'dist/remote-client.d.ts',
]);
// Deleted cloud-only modules — no source or built mirror may ship.
const DELETED_MODULE_BASENAMES = [
  'auth',
  'auth-recovery',
  'authority',
  'device-auth',
  'health-beat',
  'setup-authority',
  'setup-action',
  'subscription-retry',
  'token-crypto',
  'stale-version-check',
  'get-started',
];

async function walk(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`Packed artifact contains symlink: ${relative(root, absolute)}`);
    if (entry.isDirectory()) files.push(...await walk(root, absolute));
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`Packed artifact contains unsupported entry: ${relative(root, absolute)}`);
  }
  return files;
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function normalizedPath(root, file) {
  return relative(root, file).split(sep).join('/');
}

function validateSourceMap(sourceMap, path, mapPath, root, relativeFiles) {
  if (sourceMap?.version !== 3) throw new Error(`Source map is not version 3: ${path}`);
  if (sourceMap.sections !== undefined) throw new Error(`Indexed source maps are forbidden: ${path}`);
  if (!Array.isArray(sourceMap.sources) || sourceMap.sources.length > 512 ||
      sourceMap.sources.some((source) => typeof source !== 'string' || source.length === 0 || source.length > 1024)) {
    throw new Error(`Source map has invalid sources: ${path}`);
  }
  if (sourceMap.sourcesContent !== undefined) throw new Error(`Source map embeds sourcesContent: ${path}`);
  if (sourceMap.sourceRoot !== undefined && typeof sourceMap.sourceRoot !== 'string') {
    throw new Error(`Source map has an invalid sourceRoot: ${path}`);
  }
  for (const source of sourceMap.sources) {
    if (isAbsolute(source) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)) {
      throw new Error(`Source map contains an absolute or URL source: ${path} -> ${source}`);
    }
    const target = resolve(dirname(mapPath), sourceMap.sourceRoot ?? '', source);
    const targetPath = normalizedPath(root, target);
    if (!isInside(root, target) || !relativeFiles.has(targetPath)) {
      throw new Error(`Source map target is not shipped: ${path} -> ${source}`);
    }
  }
}

export async function verifyPackedArtifact(tarballPath, options = {}) {
  if (!tarballPath) throw new Error('Usage: node scripts/verify-packed-artifact.mjs <package.tgz>');
  const repositoryRoot = resolve(options.repositoryRoot ?? '.');
  try {
    await access(join(repositoryRoot, '.npmrc'));
    throw new Error('Repository-local .npmrc is forbidden for release builds.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const tarball = resolve(tarballPath);
  const tarballMetadata = await stat(tarball);
  if (tarballMetadata.size > MAX_PACKED_BYTES) {
    throw new Error(`Packed artifact is ${tarballMetadata.size} bytes; maximum is ${MAX_PACKED_BYTES}.`);
  }
  const packed = await readFile(tarball);
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
    .trim()
    .split('\n')
    .filter(Boolean);
  if (entries.length > MAX_FILES + 64 || new Set(entries).size !== entries.length) {
    throw new Error('Tar entry count exceeds policy or contains duplicate paths.');
  }
  for (const entry of entries) {
    if (!entry.startsWith('package/') || entry.includes('/../') || entry.startsWith('/')) {
      throw new Error(`Unsafe tar entry: ${entry}`);
    }
  }
  const entryMetadata = execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  if (entryMetadata.length !== entries.length || entryMetadata.some((line) => !['-', 'd'].includes(line[0]))) {
    throw new Error('Packed artifact contains a link or special archive entry.');
  }
  try {
    const contents = execFileSync('tar', ['-xOzf', tarball], {
      maxBuffer: MAX_UNPACKED_BYTES + 1,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (contents.byteLength > MAX_UNPACKED_BYTES) throw new Error('limit');
  } catch {
    throw new Error(`Packed artifact exceeds the ${MAX_UNPACKED_BYTES}-byte unpacked size limit.`);
  }

  const temporary = await mkdtemp(join(tmpdir(), 'borgmcp-client-pack-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', temporary], { stdio: 'pipe' });
    const root = join(temporary, 'package');
    const files = await walk(root);
    if (files.length > MAX_FILES) throw new Error(`Packed artifact contains too many files: ${files.length}.`);

    // Item 7: read the shared PIN from the packed manifest so the shipped-doc
    // version-reference check auto-tracks the pin (a doc naming any other version fails).
    let pinnedShared;
    try {
      pinnedShared = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies?.['borgmcp-shared'];
    } catch {
      pinnedShared = undefined;
    }
    if (typeof pinnedShared !== 'string' || !/^\d+\.\d+\.\d+$/.test(pinnedShared)) {
      throw new Error('Packed package.json is missing a valid borgmcp-shared pin.');
    }

    let unpackedBytes = 0;
    const relativeFiles = new Set();
    for (const file of files) {
      const path = normalizedPath(root, file);
      const rootEntry = path.split('/')[0];
      if (!ALLOWED_ROOTS.has(rootEntry)) throw new Error(`Unexpected packed path: ${path}`);
      if (rootEntry === 'dist' && !/\.(?:js|d\.ts)(?:\.map)?$/.test(path)) {
        throw new Error(`Unexpected dist artifact: ${path}`);
      }
      if (rootEntry === 'src' && !path.endsWith('.ts')) throw new Error(`Unexpected source artifact: ${path}`);
      if (rootEntry === 'docs' && !path.endsWith('.md')) throw new Error(`Unexpected documentation artifact: ${path}`);
      if (/(^|\/)(\.env(?:\.|$)|\.npmrc$|node_modules|[^/]+\.(?:pem|key|p12|pfx))/.test(path)) {
        throw new Error(`Forbidden packed path: ${path}`);
      }
      const metadata = await stat(file);
      if (metadata.size > MAX_FILE_BYTES) throw new Error(`Packed file is too large: ${path}`);
      const content = await readFile(file, 'utf8');
      for (const forbidden of FORBIDDEN_CONTENT) {
        if (forbidden.pattern.test(content)) {
          throw new Error(`Packed artifact contains ${forbidden.description}: ${path}`);
        }
      }
      // Retired-seat-vocabulary guard, scoped to operator-facing `.md` docs only.
      if (path.endsWith('.md')) {
        for (const forbidden of DOCS_FORBIDDEN_CONTENT) {
          if (forbidden.pattern.test(content)) {
            throw new Error(`Packed artifact contains ${forbidden.description}: ${path}`);
          }
        }
        // Item 7 release-integrity: no stale release framing, and every shipped
        // `borgmcp-shared@X.Y.Z` reference must equal the pin.
        for (const forbidden of DOCS_STALE_RELEASE_FRAMING) {
          if (forbidden.pattern.test(content)) {
            throw new Error(`Packed artifact contains ${forbidden.description}: ${path}`);
          }
        }
        for (const match of content.matchAll(/borgmcp-shared@(\d+\.\d+\.\d+)/g)) {
          if (match[1] !== pinnedShared) {
            throw new Error(`Packed doc references borgmcp-shared@${match[1]} != pinned ${pinnedShared}: ${path}`);
          }
        }
      }
      // Reachable-cloud runtime symbols may only be absent from SHIPPED CODE.
      // (.md docs describe the removal and are intentionally exempt here.)
      if (/\.(?:js|ts)$/.test(path) || path.endsWith('.d.ts')) {
        for (const symbol of CLOUD_RUNTIME_SYMBOLS) {
          if (content.includes(symbol)) {
            throw new Error(`Packed artifact ships a reachable-cloud runtime symbol '${symbol}': ${path}`);
          }
        }
        if (LEGACY_AUTHORITY_ROUTE.test(content)) {
          throw new Error(`Packed artifact ships a legacy authority route: ${path}`);
        }
        if (AUTHORIZATION_COPY_PATHS.has(path) && LEGACY_AUTHORIZATION_COPY.test(content)) {
          throw new Error(`Packed artifact ships obsolete ownership-based authorization copy: ${path}`);
        }
      }
      unpackedBytes += metadata.size;
      relativeFiles.add(path);
    }
    if (unpackedBytes > MAX_UNPACKED_BYTES) throw new Error(`Unpacked artifact exceeds ${MAX_UNPACKED_BYTES} bytes.`);
    for (const required of REQUIRED_FILES) {
      if (!relativeFiles.has(required)) throw new Error(`Packed artifact is missing ${required}.`);
    }
    // No deleted cloud-only module may ship as source or built mirror.
    for (const base of DELETED_MODULE_BASENAMES) {
      for (const candidate of [
        `src/${base}.ts`,
        `dist/${base}.js`,
        `dist/${base}.d.ts`,
        `dist/${base}.js.map`,
        `dist/${base}.d.ts.map`,
      ]) {
        if (relativeFiles.has(candidate)) {
          throw new Error(`Packed artifact ships a deleted cloud-only module: ${candidate}`);
        }
      }
    }

    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    verifyManifest(manifest);
    for (const [name, target] of Object.entries(manifest.bin)) {
      const normalized = String(target).replace(/^\.\//, '');
      if (!relativeFiles.has(normalized)) throw new Error(`Bin target is not shipped: ${name} -> ${target}`);
      const binPath = join(root, ...normalized.split('/'));
      const content = await readFile(binPath, 'utf8');
      if (!content.startsWith('#!/usr/bin/env node\n')) throw new Error(`Bin target lacks the Node shebang: ${target}`);
      if (((await stat(binPath)).mode & 0o111) === 0) throw new Error(`Bin target is not executable: ${target}`);
    }
    for (const target of [manifest.main, manifest.types, manifest.exports['.'].import, manifest.exports['.'].types]) {
      const normalized = String(target).replace(/^\.\//, '');
      if (!relativeFiles.has(normalized)) throw new Error(`Package export target is not shipped: ${target}`);
    }

    const license = await readFile(join(root, 'LICENSE'));
    const licenseSha1 = createHash('sha1').update(license).digest('hex');
    if (licenseSha1 !== '7df059597099bb7dcf25d2a9aedfaf4465f72d8d') {
      throw new Error(`LICENSE is not canonical Apache-2.0 text: ${licenseSha1}`);
    }
    const notice = await readFile(join(root, 'NOTICE'), 'utf8');
    if (notice !== 'Borg MCP Client\nCopyright 2026 Byte Ventures IO AB\n') {
      throw new Error('NOTICE does not match the approved product and legal entity.');
    }

    const sourceFiles = [...relativeFiles].filter((path) => path.startsWith('src/') && path.endsWith('.ts'));
    if (sourceFiles.length === 0) throw new Error('Packed artifact must include readable TypeScript source.');
    let sourceMapCount = 0;
    for (const path of relativeFiles) {
      if (!path.endsWith('.map')) continue;
      sourceMapCount += 1;
      const mapPath = join(root, ...path.split('/'));
      const sourceMap = JSON.parse(await readFile(mapPath, 'utf8'));
      validateSourceMap(sourceMap, path, mapPath, root, relativeFiles);
    }
    if (sourceMapCount === 0) throw new Error('Packed artifact must include source maps.');

    return {
      name: manifest.name,
      version: manifest.version,
      fileCount: files.length,
      packedBytes: packed.byteLength,
      unpackedBytes,
      sourceMapCount,
      integrity: `sha512-${createHash('sha512').update(packed).digest('base64')}`,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const report = await verifyPackedArtifact(process.argv[2]);
  console.log(JSON.stringify(report, null, 2));
}
