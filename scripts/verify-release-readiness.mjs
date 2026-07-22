import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_FILES = [
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'package-lock.json',
  'package.json',
];
const REQUIRED_SCRIPTS = ['build', 'check', 'test', 'verify:artifact'];
const FORBIDDEN_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'dependencies',
  'postpack',
];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
];
const SHARED_VERSION = '0.5.0';
const SHARED_TARBALL = 'https://registry.npmjs.org/borgmcp-shared/-/borgmcp-shared-0.5.0.tgz';
const SHARED_INTEGRITY = 'sha512-kOAfMTMPTHRvctB0wpPo/+nNPjiBsk0FddnLgGQged8K8PwQqYWv7zQizPU2mgyExpurjCKKPbi9M+QcfmXNKA==';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function validSemver(version) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

export function registryCompatible(spec) {
  if (typeof spec !== 'string' || spec.length === 0 || spec !== spec.trim()) return false;
  if (!/[0-9*xX]/.test(spec)) return false;
  return /^[0-9v<>=~^*xX|+.\-\s]+$/.test(spec);
}

export function verifyManifest(manifest) {
  assert(manifest?.name === 'borgmcp', 'package.json name must be borgmcp.');
  assert(validSemver(manifest.version), 'package.json version must be an explicit semantic version.');
  assert(manifest.license === 'Apache-2.0', 'package.json license must be Apache-2.0.');
  assert(
    manifest.repository?.url === 'git+https://github.com/Byte-Ventures/borg-mcp-client.git',
    'package.json repository must match the provenance repository exactly.',
  );
  assert(
    manifest.publishConfig?.access === 'public' && Object.keys(manifest.publishConfig).length === 1,
    'publishConfig must contain only access=public; registry redirects are forbidden.',
  );
  assert(manifest.engines?.node === '>=20', 'package.json must require Node.js >=20.');
  assert(manifest.bin?.borg === './dist/claude.js', 'package.json borg bin must be ./dist/claude.js.');
  assert(manifest.bin?.['borg-mcp'] === './dist/index.js', 'package.json borg-mcp bin must be ./dist/index.js.');
  assert(manifest.main === './dist/index.js', 'package.json main must be ./dist/index.js.');
  assert(manifest.types === './dist/index.d.ts', 'package.json types must be ./dist/index.d.ts.');
  const rootExport = manifest.exports?.['.'];
  assert(rootExport?.import === './dist/index.js', 'Root import export must be ./dist/index.js.');
  assert(rootExport?.types === './dist/index.d.ts', 'Root types export must be ./dist/index.d.ts.');
  assert(manifest.exports?.['./package.json'] === './package.json', 'package.json export must be explicit.');
  for (const script of REQUIRED_SCRIPTS) {
    assert(typeof manifest.scripts?.[script] === 'string', `package.json is missing required script: ${script}`);
  }
  for (const hook of FORBIDDEN_HOOKS) {
    assert(!manifest.scripts?.[hook], `Consumer lifecycle hook is forbidden: ${hook}`);
  }
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      assert(registryCompatible(spec), `Non-registry dependency is forbidden: ${field}.${name}=${spec}`);
    }
  }
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    assert(
      manifest[field] === undefined || (Array.isArray(manifest[field]) && manifest[field].length === 0),
      `${field} must remain absent or an empty array.`,
    );
  }
  assert(
    manifest.dependencies?.['borgmcp-shared'] === SHARED_VERSION,
    `Runtime dependency borgmcp-shared must be pinned exactly to ${SHARED_VERSION}.`,
  );
}

function verifySharedLock(lock) {
  const root = lock?.packages?.[''];
  assert(
    root?.dependencies?.['borgmcp-shared'] === SHARED_VERSION,
    `Lockfile root must pin borgmcp-shared exactly to ${SHARED_VERSION}.`,
  );
  const shared = lock?.packages?.['node_modules/borgmcp-shared'];
  assert(shared, 'Lockfile must contain exactly one registry-resolved borgmcp-shared package.');
  assert(shared.version === SHARED_VERSION, `Resolved borgmcp-shared must be ${SHARED_VERSION}.`);
  assert(
    shared.resolved === SHARED_TARBALL,
    'borgmcp-shared must resolve to the audited canonical npm tarball.',
  );
  assert(
    shared.integrity === SHARED_INTEGRITY,
    `borgmcp-shared lock entry must match the audited ${SHARED_VERSION} SHA-512 integrity.`,
  );
  const duplicates = Object.keys(lock.packages ?? {}).filter((key) => key.endsWith('/node_modules/borgmcp-shared'));
  assert(duplicates.length === 0, 'Lockfile must not contain duplicate borgmcp-shared versions.');
}

function packageNameFromLockPath(path) {
  if (path.startsWith('/') || path.includes('\\')) return null;
  const segments = path.split('/');
  const validPart = (part) => typeof part === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(part);
  let name = null;
  for (let index = 0; index < segments.length;) {
    if (segments[index] !== 'node_modules') return null;
    const first = segments[index + 1];
    if (first?.startsWith('@')) {
      const leaf = segments[index + 2];
      if (!validPart(first.slice(1)) || !validPart(leaf)) return null;
      name = `${first}/${leaf}`;
      index += 3;
    } else {
      if (!validPart(first)) return null;
      name = first;
      index += 2;
    }
  }
  return name;
}

function canonicalTarballUrl(name, version) {
  const leaf = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${leaf}-${version}.tgz`;
}

function validSha512Integrity(integrity) {
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) return false;
  try {
    return Buffer.from(integrity.slice('sha512-'.length), 'base64').byteLength === 64;
  } catch {
    return false;
  }
}

export function lockRegistryEntries(lock) {
  const entries = [];
  for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
    if (path === '') continue;
    const name = packageNameFromLockPath(path);
    assert(name, `Lockfile contains a non-registry package path: ${path}`);
    assert(entry?.link !== true, `Lockfile contains a linked package: ${path}`);
    assert(
      typeof entry?.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.version),
      `Lockfile package has an invalid version: ${path}`,
    );
    if (entry.name !== undefined) assert(entry.name === name, `Lockfile package name does not match its path: ${path}`);
    const tarball = canonicalTarballUrl(name, entry.version);
    assert(entry.resolved === tarball, `Lockfile package tarball does not match ${name}@${entry.version}: ${path}`);
    assert(validSha512Integrity(entry.integrity), `Lockfile package needs a full SHA-512 integrity: ${path}`);
    entries.push({ path, name, version: entry.version, tarball, integrity: entry.integrity });
  }
  return entries;
}

function verifyRegistryLock(lock, manifest) {
  const root = lock?.packages?.[''];
  assert(root, 'Lockfile is missing the root package entry.');
  for (const field of DEPENDENCY_FIELDS) {
    const expected = manifest[field] ?? {};
    const actual = root[field] ?? {};
    assert(sameValue(actual, expected), `Lockfile root ${field} must match package.json exactly.`);
  }
  assert(
    sameValue(root.peerDependenciesMeta ?? {}, manifest.peerDependenciesMeta ?? {}),
    'Lockfile root peerDependenciesMeta must match package.json exactly.',
  );
  lockRegistryEntries(lock);
}

export async function verifyReleaseReadiness(rootPath = '.') {
  const root = resolve(rootPath);
  for (const file of REQUIRED_FILES) {
    assert(await exists(join(root, file)), `Release source is incomplete: missing ${file}.`);
  }
  assert(!(await exists(join(root, '.npmrc'))), 'Repository-local .npmrc is forbidden.');
  assert(await exists(join(root, 'src')), 'Readable TypeScript source must be present before release.');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  verifyManifest(manifest);
  assert(lock.name === manifest.name && lock.version === manifest.version, 'Lockfile identity must match package.json.');
  verifyRegistryLock(lock, manifest);
  verifySharedLock(lock);
  return {
    name: manifest.name,
    version: manifest.version,
    shared: lock.packages['node_modules/borgmcp-shared'].version,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const report = await verifyReleaseReadiness(process.argv[2] ?? '.');
  console.log(JSON.stringify(report, null, 2));
}
