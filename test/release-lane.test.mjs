import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { verifyPackedArtifact } from '../scripts/verify-packed-artifact.mjs';
import { verifyLockRegistry, verifyRegistryMetadata } from '../scripts/verify-lock-registry.mjs';
import { verifyProvenanceStatement } from '../scripts/verify-registry-release.mjs';
import {
  lockRegistryEntries,
  registryCompatible,
  verifyManifest,
  verifyReleaseReadiness,
} from '../scripts/verify-release-readiness.mjs';
import { smokePackedClient } from '../scripts/smoke-packed-client.mjs';

const root = resolve(import.meta.dirname, '..');

async function validPackage(directory) {
  const packageRoot = join(directory, 'package');
  await mkdir(join(packageRoot, 'src'), { recursive: true });
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(join(packageRoot, 'docs'), { recursive: true });
  const manifest = {
    name: 'borgmcp',
    version: '2.0.0',
    license: 'Apache-2.0',
    repository: {
      type: 'git',
      url: 'git+https://github.com/Byte-Ventures/borg-mcp-client.git',
    },
    publishConfig: { access: 'public' },
    engines: { node: '>=20' },
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './package.json': './package.json',
    },
    bin: { borg: './dist/claude.js', 'borg-mcp': './dist/index.js' },
    scripts: {
      build: 'tsc',
      check: 'tsc --noEmit',
      test: 'node --test',
      'verify:artifact': 'node scripts/verify-packed-artifact.mjs',
    },
    dependencies: { 'borgmcp-shared': '^0.2.0' },
  };
  const lock = {
    name: 'borgmcp',
    version: '2.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'borgmcp', version: '2.0.0', dependencies: { 'borgmcp-shared': '^0.2.0' } },
      'node_modules/borgmcp-shared': {
        version: '0.2.1',
        resolved: 'https://registry.npmjs.org/borgmcp-shared/-/borgmcp-shared-0.2.1.tgz',
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      },
    },
  };
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(packageRoot, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  for (const file of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md']) {
    await writeFile(join(packageRoot, file), `# ${file}\n`);
  }
  await cp(join(root, 'LICENSE'), join(packageRoot, 'LICENSE'));
  await cp(join(root, 'NOTICE'), join(packageRoot, 'NOTICE'));
  await writeFile(join(packageRoot, 'docs', 'usage.md'), '# Usage\n');
  await writeFile(join(packageRoot, 'src', 'claude.ts'), 'export const cli = true;\n');
  await writeFile(join(packageRoot, 'src', 'index.ts'), 'export const mcp = true;\n');
  for (const name of ['claude', 'index']) {
    const content = name === 'index'
      ? `#!/usr/bin/env node
import readline from 'node:readline';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const fixture = true;
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1.0.0' } } }) + '\\n');
  } else if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'fixture', description: 'fixture', inputSchema: { type: 'object' } }] } }) + '\\n');
  }
});
}
`
      : '#!/usr/bin/env node\nexport {};\n';
    await writeFile(join(packageRoot, 'dist', `${name}.js`), content);
    await chmod(join(packageRoot, 'dist', `${name}.js`), 0o755);
    await writeFile(
      join(packageRoot, 'dist', `${name}.js.map`),
      `${JSON.stringify({ version: 3, file: `${name}.js`, sources: [`../src/${name}.ts`], names: [], mappings: '' })}\n`,
    );
  }
  await writeFile(join(packageRoot, 'dist', 'index.d.ts'), 'export declare const fixture: true;\n');
  return { packageRoot, manifest, lock };
}

async function packedFixture(mutator) {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-release-test-'));
  const fixture = await validPackage(directory);
  await mutator?.(fixture);
  await rm(join(fixture.packageRoot, 'package-lock.json'));
  const tarball = join(directory, 'borgmcp-2.0.0.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', directory, 'package']);
  return { directory, tarball };
}

async function removeFixtureRuntimeDependencies(packageRoot) {
  const manifestPath = join(packageRoot, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dependencies = {};
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function installFixtureConsumer(directory, tarball) {
  const consumer = join(directory, 'global-consumer');
  const canonicalTarball = await realpath(tarball);
  execFileSync('npm', [
    'install',
    '--global',
    '--prefix',
    consumer,
    '--ignore-scripts',
    '--no-save',
    '--package-lock=false',
    canonicalTarball,
  ], { encoding: 'utf8' });
  return {
    consumer,
    packageRoot: join(consumer, 'lib', 'node_modules', 'borgmcp'),
    binPath: join(consumer, 'bin', 'borg-mcp'),
  };
}

test('release workflow separates unprivileged verification from protected OIDC publication', async () => {
  const workflow = await readFile(join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /if: github\.event_name == 'push'/);
  assert.match(workflow, /environment:\n\s+name: npm-publish/);
  assert.equal((workflow.match(/id-token: write/g) ?? []).length, 1);
  assert.equal((workflow.match(/NPM_TOKEN|NODE_AUTH_TOKEN/g) ?? []).length, 0);
  assert.doesNotMatch(workflow, /release_tag="\$\{\{ inputs\.tag \}\}"/);
  assert.match(workflow, /DISPATCH_TAG: \$\{\{ inputs\.tag \}\}/);
  assert.match(workflow, /test "\$\{GITHUB_REF_NAME\}" = "main"/);
  assert.equal((workflow.match(/test "\$\{GITHUB_RUN_ATTEMPT\}" = "1"/g) ?? []).length, 2);
  assert.match(workflow, /if: github\.event_name == 'push' && github\.run_attempt == 1/);
  assert.equal((workflow.match(/npm publish "\$\{PWD\}\/release\//g) ?? []).length, 2);
  assert.equal((workflow.match(/npm install --global --prefix "\$\{consumer\}"/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\./);
  const checkouts = [...workflow.matchAll(/uses: actions\/checkout@/g)].map((match) => match.index);
  const attemptGuards = [...workflow.matchAll(/run: test "\$\{GITHUB_RUN_ATTEMPT\}" = "1"/g)]
    .map((match) => match.index);
  const configGuards = [...workflow.matchAll(/run: test ! -e \.npmrc/g)].map((match) => match.index);
  const setupNodes = [...workflow.matchAll(/uses: actions\/setup-node@/g)].map((match) => match.index);
  const bootstraps = [...workflow.matchAll(/npm install --prefix "\$\{npm_prefix\}"/g)].map((match) => match.index);
  assert.equal(checkouts.length, 2);
  assert.equal(attemptGuards.length, 2);
  assert.equal(configGuards.length, 2);
  assert.equal(setupNodes.length, 2);
  assert.equal(bootstraps.length, 2);
  for (const position of [0, 1]) {
    assert.ok(checkouts[position] < attemptGuards[position]);
    assert.ok(attemptGuards[position] < configGuards[position]);
    assert.ok(configGuards[position] < setupNodes[position]);
    assert.ok(setupNodes[position] < bootstraps[position]);
  }
  assert.doesNotMatch(workflow, /registry-url:/);
  assert.equal((workflow.match(/--registry=https:\/\/registry\.npmjs\.org npm@11\.18\.0/g) ?? []).length, 2);
  assert.equal((workflow.match(/NPM_CONFIG_USERCONFIG=/g) ?? []).length, 8);
  assert.equal((workflow.match(/NPM_CONFIG_CACHE=/g) ?? []).length, 4);
  assert.equal((workflow.match(/config get registry/g) ?? []).length, 2);

  const ci = await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  for (const line of `${workflow}\n${ci}`.split('\n').filter((value) => value.trim().startsWith('uses:'))) {
    assert.match(line, /@[0-9a-f]{40}(?:\s+#.*)?$/, `Action is not pinned by full SHA: ${line.trim()}`);
  }
});

test('release attempt guard rejects reruns of an immutable tag workflow', () => {
  assert.doesNotThrow(() => execFileSync('bash', ['-c', 'test "${GITHUB_RUN_ATTEMPT}" = "1"'], {
    env: { ...process.env, GITHUB_RUN_ATTEMPT: '1' },
  }));
  assert.throws(() => execFileSync('bash', ['-c', 'test "${GITHUB_RUN_ATTEMPT}" = "1"'], {
    env: { ...process.env, GITHUB_RUN_ATTEMPT: '2' },
    stdio: 'pipe',
  }));
});

test('release readiness accepts the extracted standalone client', async () => {
  const report = await verifyReleaseReadiness(root);
  assert.deepEqual(report, { name: 'borgmcp', version: '1.1.15', shared: '0.2.2' });
});

test('release readiness accepts one canonical registry-resolved shared dependency', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await validPackage(directory);
  const report = await verifyReleaseReadiness(join(directory, 'package'));
  assert.deepEqual(report, { name: 'borgmcp', version: '2.0.0', shared: '0.2.1' });
});

test('repository npm config is rejected before any release bootstrap may run', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { packageRoot } = await validPackage(directory);
  await writeFile(join(packageRoot, '.npmrc'), 'registry=https://attacker.invalid/\n');
  await assert.rejects(() => verifyReleaseReadiness(packageRoot), /Repository-local \.npmrc is forbidden/);
});

test('workflow guards reruns and hostile source config before trusted npm bootstrap', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-npmrc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { packageRoot } = await validPackage(directory);
  const runnerConfig = join(directory, 'runner.npmrc');
  const readinessScript = join(root, 'scripts', 'verify-release-readiness.mjs');
  const workflowSteps = `set -euo pipefail
test "\${GITHUB_RUN_ATTEMPT}" = "1"
test ! -e .npmrc
printf '%s\\n' 'registry=https://registry.npmjs.org/' > "\${NPM_CONFIG_USERCONFIG}"
node "${readinessScript}"
`;
  const runWorkflowSteps = (attempt) => execFileSync('bash', ['-c', workflowSteps], {
    cwd: packageRoot,
    env: { ...process.env, GITHUB_RUN_ATTEMPT: attempt, NPM_CONFIG_USERCONFIG: runnerConfig },
    stdio: 'pipe',
  });

  assert.doesNotThrow(() => runWorkflowSteps('1'));
  assert.equal(await readFile(runnerConfig, 'utf8'), 'registry=https://registry.npmjs.org/\n');

  await writeFile(join(packageRoot, '.npmrc'), 'registry=https://attacker.invalid/\n');
  await writeFile(runnerConfig, 'bootstrap-not-reached\n');
  assert.throws(() => runWorkflowSteps('1'));
  assert.equal(await readFile(runnerConfig, 'utf8'), 'bootstrap-not-reached\n');

  await rm(join(packageRoot, '.npmrc'));
  assert.throws(() => runWorkflowSteps('2'));
  assert.equal(await readFile(runnerConfig, 'utf8'), 'bootstrap-not-reached\n');
});

test('release readiness rejects source-coupled shared dependencies', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { packageRoot, manifest } = await validPackage(directory);
  manifest.dependencies['borgmcp-shared'] = 'git+ssh://git@github.com/Byte-Ventures/borg-mcp-shared.git#deadbeef';
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(() => verifyReleaseReadiness(packageRoot), /Non-registry dependency|must be pinned/);
});

test('registry spec policy rejects shorthand, Git, local, archive, alias, tag, and malformed specs', () => {
  const hostile = [
    'attacker/repo',
    'git@github.com:attacker/repo.git',
    '../local-package',
    'package.tgz',
    '',
    'latest',
    'npm:other-package@1.0.0',
    'workspace:^1.0.0',
    'https://example.com/package.tgz',
    ' 1.0.0',
  ];
  for (const spec of hostile) assert.equal(registryCompatible(spec), false, spec);
  for (const spec of ['1.2.3', '^1.2.3', '>=1.2.3 <2.0.0', '1.2.x', '1.2.3 || 2.x', '*']) {
    assert.equal(registryCompatible(spec), true, spec);
  }
});

test('release readiness rejects prerelease versions before default latest publication', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { packageRoot, manifest } = await validPackage(directory);
  manifest.version = '2.0.0-beta.1';
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(() => verifyReleaseReadiness(packageRoot), /explicit semantic version/);
});

test('release readiness binds every lock entry to canonical registry integrity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { packageRoot, lock } = await validPackage(directory);
  lock.packages['node_modules/transitive'] = {
    version: '1.0.0',
    resolved: 'git+ssh://git@github.com/attacker/repo.git#deadbeef',
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
  };
  await writeFile(join(packageRoot, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  await assert.rejects(() => verifyReleaseReadiness(packageRoot), /tarball does not match/);
});

test('lock binding rejects wrong identity, version, host tricks, suffixes, and malformed integrity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-lock-'));
  try {
    const { lock } = await validPackage(directory);
    const canonical = lock.packages['node_modules/borgmcp-shared'].resolved;
    const hostile = [
      { resolved: 'https://registry.npmjs.org/other/-/other-0.2.1.tgz' },
      { resolved: 'https://registry.npmjs.org/borgmcp-shared/-/borgmcp-shared-0.2.2.tgz' },
      { resolved: canonical.replace('registry.npmjs.org', 'registry.npmjs.org.evil.example') },
      { resolved: canonical.replace('https://', 'https://user@') },
      { resolved: `${canonical}?download=1` },
      { resolved: `${canonical}#fragment` },
      { integrity: 'sha512-short' },
      { name: 'other' },
    ];
    for (const patch of hostile) {
      const candidate = structuredClone(lock);
      Object.assign(candidate.packages['node_modules/borgmcp-shared'], patch);
      assert.throws(() => lockRegistryEntries(candidate), undefined, JSON.stringify(patch));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('lock binding accepts only complete canonical nested package paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-lock-path-'));
  try {
    const { lock } = await validPackage(directory);
    const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
    const entry = (name) => ({
      version: '1.0.0',
      resolved: `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-1.0.0.tgz`,
      integrity,
    });
    const valid = [
      ['node_modules/parent/node_modules/child', 'child'],
      ['node_modules/parent/node_modules/@scope/child', '@scope/child'],
      ['node_modules/@scope/parent/node_modules/child', 'child'],
      ['node_modules/@scope/parent/node_modules/@other/child', '@other/child'],
    ];
    const accepted = structuredClone(lock);
    for (const [path, name] of valid) accepted.packages[path] = entry(name);
    const entries = lockRegistryEntries(accepted);
    for (const [path, name] of valid) {
      assert.equal(entries.find((candidate) => candidate.path === path)?.name, name);
    }

    const hostile = [
      '../outside/node_modules/evil',
      'node_modules/parent/../../escape/node_modules/evil',
      '/tmp/escape/node_modules/evil',
      'prefix/node_modules/evil',
      'node_modules\\evil',
      'node_modules//evil',
      'node_modules/./node_modules/evil',
      'node_modules/../node_modules/evil',
      'node_modules/parent//node_modules/evil',
      'node_modules/@scope',
      'node_modules/@/evil',
      'node_modules/@scope/',
      'node_modules/@scope/../node_modules/evil',
      'node_modules/@scope/evil/foreign',
      'node_modules/@scope/evil/node_modules/@/child',
    ];
    for (const path of hostile) {
      const candidate = structuredClone(lock);
      candidate.packages[path] = entry('evil');
      assert.throws(
        () => lockRegistryEntries(candidate),
        /non-registry package path/,
        `accepted hostile lock path: ${path}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('official registry metadata must match the reviewed lock URL and integrity', () => {
  const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  const entry = {
    name: 'borgmcp-shared',
    version: '0.2.1',
    tarball: 'https://registry.npmjs.org/borgmcp-shared/-/borgmcp-shared-0.2.1.tgz',
    integrity,
  };
  assert.doesNotThrow(() => verifyRegistryMetadata(entry, {
    name: entry.name,
    version: entry.version,
    dist: { tarball: entry.tarball, integrity },
  }));
  assert.throws(() => verifyRegistryMetadata(entry, {
    name: entry.name,
    version: entry.version,
    dist: { tarball: entry.tarball.replace('borgmcp-shared', 'other'), integrity },
  }), /tarball mismatch/);
  assert.throws(() => verifyRegistryMetadata(entry, {
    name: entry.name,
    version: entry.version,
    dist: { tarball: entry.tarball, integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
  }), /integrity mismatch/);
});

test('official metadata validation checks every duplicate lock entry regardless of order', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { lock } = await validPackage(directory);
  const canonical = lock.packages['node_modules/borgmcp-shared'];
  lock.packages['node_modules/parent/node_modules/borgmcp-shared'] = {
    ...canonical,
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  };
  const lockPath = join(directory, 'duplicate-lock.json');
  const metadata = {
    name: 'borgmcp-shared',
    version: '0.2.1',
    dist: { tarball: canonical.resolved, integrity: canonical.integrity },
  };
  const fetchImpl = async () => ({ ok: true, json: async () => metadata });
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await assert.rejects(() => verifyLockRegistry(lockPath, { fetchImpl }), /integrity mismatch/);

  const reversed = { ...lock, packages: Object.fromEntries(Object.entries(lock.packages).reverse()) };
  await writeFile(lockPath, `${JSON.stringify(reversed, null, 2)}\n`);
  await assert.rejects(() => verifyLockRegistry(lockPath, { fetchImpl }), /integrity mismatch/);
});

test('official metadata validation includes platform-skipped optional lock entries', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { lock } = await validPackage(directory);
  const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  lock.packages['node_modules/platform-only'] = {
    version: '1.0.0',
    resolved: 'https://registry.npmjs.org/platform-only/-/platform-only-1.0.0.tgz',
    integrity,
    optional: true,
    os: ['linux'],
  };
  const lockPath = join(directory, 'optional-lock.json');
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const fetchImpl = async (url) => {
    if (url.includes('platform-only')) {
      return {
        ok: true,
        json: async () => ({
          name: 'platform-only',
          version: '1.0.0',
          dist: {
            tarball: 'https://registry.npmjs.org/platform-only/-/platform-only-1.0.0.tgz',
            integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        name: 'borgmcp-shared',
        version: '0.2.1',
        dist: {
          tarball: 'https://registry.npmjs.org/borgmcp-shared/-/borgmcp-shared-0.2.1.tgz',
          integrity: lock.packages['node_modules/borgmcp-shared'].integrity,
        },
      }),
    };
  };
  await assert.rejects(() => verifyLockRegistry(lockPath, { fetchImpl }), /integrity mismatch/);
});

test('manifest rejects bundle aliases and root lock dependency-class drift', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { packageRoot, manifest, lock } = await validPackage(directory);
  assert.throws(() => verifyManifest({ ...manifest, bundleDependencies: true }), /bundleDependencies/);
  manifest.optionalDependencies = { optional: '^1.0.0' };
  lock.packages[''].optionalDependencies = { optional: '^2.0.0' };
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(packageRoot, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  await assert.rejects(() => verifyReleaseReadiness(packageRoot), /optionalDependencies must match/);
});

test('packed artifact verifier accepts readable source and executable bins', async (t) => {
  const { directory, tarball } = await packedFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await verifyPackedArtifact(tarball, { repositoryRoot: directory });
  assert.equal(report.name, 'borgmcp');
  assert.equal(report.version, '2.0.0');
  assert.equal(report.sourceMapCount, 2);
  assert.match(report.integrity, /^sha512-/);
});

test('npm treats the audited absolute tarball path as a local publish dry-run', async (t) => {
  const { directory, tarball } = await packedFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = JSON.parse(execFileSync('npm', [
    'publish',
    tarball,
    '--dry-run',
    '--ignore-scripts',
    '--access',
    'public',
    '--json',
  ], { cwd: directory, encoding: 'utf8' }));
  const publication = result.borgmcp ?? (Array.isArray(result) ? result[0] : result);
  assert.equal(publication.name, 'borgmcp');
  assert.equal(publication.version, '2.0.0');
});

test('exact tarball installs cleanly and completes MCP initialize plus tool discovery', async (t) => {
  const { directory, tarball } = await packedFixture(async ({ packageRoot }) => {
    await removeFixtureRuntimeDependencies(packageRoot);
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { consumer, packageRoot, binPath } = await installFixtureConsumer(directory, tarball);
  execFileSync('npm', ['ls', '--global', '--prefix', consumer, '--omit=dev', '--all', '--package-lock=false'], { encoding: 'utf8' });
  const report = await smokePackedClient(packageRoot, { binPath });
  assert.deepEqual(report, { name: 'borgmcp', version: '2.0.0', toolCount: 1 });
});

test('exact tarball smoke rejects a missing packaged MCP entrypoint', async (t) => {
  const { directory, tarball } = await packedFixture(async ({ packageRoot }) => {
    await removeFixtureRuntimeDependencies(packageRoot);
    const manifestPath = join(packageRoot, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.bin['borg-mcp'] = './dist/missing.js';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { packageRoot, binPath } = await installFixtureConsumer(directory, tarball);
  await assert.rejects(
    () => smokePackedClient(packageRoot, { binPath, timeoutMs: 2_000 }),
    /ENOENT|exited before tool discovery/,
  );
});

test('exact tarball smoke rejects a missing runtime dependency', async (t) => {
  const { directory, tarball } = await packedFixture(async ({ packageRoot }) => {
    await removeFixtureRuntimeDependencies(packageRoot);
    const entry = join(packageRoot, 'dist', 'index.js');
    await writeFile(entry, `import 'missing-runtime-package';\n${await readFile(entry, 'utf8')}`);
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { packageRoot, binPath } = await installFixtureConsumer(directory, tarball);
  await assert.rejects(
    () => smokePackedClient(packageRoot, { binPath, timeoutMs: 2_000 }),
    /Packed package import failed/,
  );
});

test('packed artifact verifier rejects credential-shaped content', async (t) => {
  const { directory, tarball } = await packedFixture(async ({ packageRoot }) => {
    await writeFile(join(packageRoot, 'src', 'cli.ts'), `export const leaked = "npm_${'A'.repeat(24)}";\n`);
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    () => verifyPackedArtifact(tarball, { repositoryRoot: directory }),
    /credential-shaped token/,
  );
});

test('packed artifact verifier rejects links before extraction', async (t) => {
  const { directory, tarball } = await packedFixture(async ({ packageRoot }) => {
    await symlink('../README.md', join(packageRoot, 'src', 'linked.ts'));
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    () => verifyPackedArtifact(tarball, { repositoryRoot: directory }),
    /link or special archive entry/,
  );
});

test('packed artifact verifier rejects a compressed expansion before extraction', async (t) => {
  const { directory, tarball } = await packedFixture(async ({ packageRoot }) => {
    await writeFile(join(packageRoot, 'src', 'compressed.ts'), Buffer.alloc(31 * 1024 * 1024, 65));
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    () => verifyPackedArtifact(tarball, { repositoryRoot: directory }),
    /unpacked size limit/,
  );
});

test('packed artifact verifier rejects indexed maps with nested source content', async (t) => {
  const { directory, tarball } = await packedFixture(async ({ packageRoot }) => {
    await writeFile(join(packageRoot, 'dist', 'cli.js.map'), JSON.stringify({
      version: 3,
      sections: [{
        offset: { line: 0, column: 0 },
        map: { version: 3, sources: ['../src/cli.ts'], sourcesContent: ['private source'], names: [], mappings: '' },
      }],
    }));
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(() => verifyPackedArtifact(tarball, { repositoryRoot: directory }), /Indexed source maps are forbidden/);
});

test('packed artifact verifier rejects indexed maps with absolute nested sources', async (t) => {
  const { directory, tarball } = await packedFixture(async ({ packageRoot }) => {
    await writeFile(join(packageRoot, 'dist', 'cli.js.map'), JSON.stringify({
      version: 3,
      sections: [{
        offset: { line: 0, column: 0 },
        map: { version: 3, sources: ['/private/cli.ts'], names: [], mappings: '' },
      }],
    }));
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(() => verifyPackedArtifact(tarball, { repositoryRoot: directory }), /Indexed source maps are forbidden/);
});

test('provenance verifier binds exact client package, digest, workflow, tag, and commit', () => {
  const integrity = `sha512-${Buffer.from('a'.repeat(128), 'hex').toString('base64')}`;
  const commit = '1'.repeat(40);
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: 'pkg:npm/borgmcp@2.0.0', digest: { sha512: 'a'.repeat(128) } }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: 'https://github.com/Byte-Ventures/borg-mcp-client',
            path: '.github/workflows/publish.yml',
            ref: 'refs/tags/v2.0.0',
          },
        },
        internalParameters: { github: { event_name: 'push' } },
        resolvedDependencies: [{
          uri: 'git+https://github.com/Byte-Ventures/borg-mcp-client@refs/tags/v2.0.0',
          digest: { gitCommit: commit },
        }],
      },
      runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' } },
    },
  };
  assert.doesNotThrow(() => verifyProvenanceStatement(
    statement,
    'application/vnd.in-toto+json',
    'borgmcp',
    '2.0.0',
    integrity,
    commit,
  ));
  statement.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/example/fork';
  assert.throws(() => verifyProvenanceStatement(
    statement,
    'application/vnd.in-toto+json',
    'borgmcp',
    '2.0.0',
    integrity,
    commit,
  ), /workflow identity/);
});
