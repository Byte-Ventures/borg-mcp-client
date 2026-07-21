import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { verifyPackedArtifact } from '../scripts/verify-packed-artifact.mjs';
import { verifyLockRegistry, verifyRegistryMetadata } from '../scripts/verify-lock-registry.mjs';
import {
  verifyArtifactReport,
  verifyPostpublish,
  verifyPrepublish,
} from '../scripts/verify-registry-release.mjs';
import { verifyReleaseTrigger } from '../scripts/verify-release-trigger.mjs';
import {
  lockRegistryEntries,
  registryCompatible,
  verifyManifest,
  verifyReleaseReadiness,
} from '../scripts/verify-release-readiness.mjs';
import { smokePackedClient } from '../scripts/smoke-packed-client.mjs';

const root = resolve(import.meta.dirname, '..');
const CLIENT_VERSION = '2.0.2';
const SHARED_VERSION = '0.4.3';
const SHARED_TARBALL = 'https://registry.npmjs.org/borgmcp-shared/-/borgmcp-shared-0.4.3.tgz';
const SHARED_INTEGRITY = 'sha512-VuQ+nOVhNY5xTzQENK4CnwI4QR5G8bucwoXvWNW0R+IfXx3utCN/CLy5D2WJF9RRVkbbbvApyquok7PV4FX1Uw==';

async function validPackage(directory) {
  const packageRoot = join(directory, 'package');
  await mkdir(join(packageRoot, 'src'), { recursive: true });
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(join(packageRoot, 'docs'), { recursive: true });
  const manifest = {
    name: 'borgmcp',
    version: CLIENT_VERSION,
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
    dependencies: { 'borgmcp-shared': SHARED_VERSION },
  };
  const lock = {
    name: 'borgmcp',
    version: CLIENT_VERSION,
    lockfileVersion: 3,
    packages: {
      '': { name: 'borgmcp', version: CLIENT_VERSION, dependencies: { 'borgmcp-shared': SHARED_VERSION } },
      'node_modules/borgmcp-shared': {
        version: SHARED_VERSION,
        resolved: SHARED_TARBALL,
        integrity: SHARED_INTEGRITY,
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
  const tarball = join(directory, `borgmcp-${CLIENT_VERSION}.tgz`);
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

test('release workflow uses one package authority, one protected publish, and one read-only registry readback', async () => {
  const workflow = await readFile(join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
  const [verification = '', afterVerify = ''] = workflow.split('\n  publish:\n');
  const [publication = '', registryVerification = ''] = afterVerify.split('\n  registry-verification:\n');

  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(verification, /environment:/);
  assert.doesNotMatch(verification, /id-token: write/);
  assert.match(publication, /needs: verify/);
  assert.match(publication, /environment:\n\s+name: npm-publish/);
  assert.match(publication, /id-token: write/);
  assert.match(registryVerification, /needs: \[verify, publish\]/);
  assert.doesNotMatch(registryVerification, /environment:/);
  assert.doesNotMatch(registryVerification, /id-token: write/);
  assert.equal((workflow.match(/id-token: write/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /secrets\.NPM_TOKEN|NPM_TOKEN_PRESENT/);
  assert.equal((workflow.match(/npm publish "\.\/release\//g) ?? []).length, 1);
  assert.equal((workflow.match(/--provenance/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /SHA512SUMS|sha512sum|DSSE|in-toto|SLSA/);
  assert.equal((workflow.match(/verify-release-trigger\.mjs/g) ?? []).length, 1);
  assert.equal((workflow.match(/test "\$\{GITHUB_RUN_ATTEMPT\}" = "1"/g) ?? []).length, 1);
  assert.equal((workflow.match(/npm install --global --prefix "\$\{consumer\}"/g) ?? []).length, 1);
  const checkouts = [...workflow.matchAll(/uses: actions\/checkout@/g)].map((match) => match.index);
  const attemptGuards = [...workflow.matchAll(/run: test "\$\{GITHUB_RUN_ATTEMPT\}" = "1"/g)]
    .map((match) => match.index);
  const configGuards = [...workflow.matchAll(/run: test ! -e \.npmrc/g)].map((match) => match.index);
  const setupNodes = [...workflow.matchAll(/uses: actions\/setup-node@/g)].map((match) => match.index);
  const bootstraps = [...workflow.matchAll(/npm install --prefix "\$\{npm_prefix\}"/g)].map((match) => match.index);
  assert.equal(checkouts.length, 3);
  assert.equal(attemptGuards.length, 1);
  assert.equal(configGuards.length, 1);
  assert.equal(setupNodes.length, 3);
  assert.equal(bootstraps.length, 2);
  assert.ok(checkouts[0] < attemptGuards[0]);
  assert.ok(attemptGuards[0] < configGuards[0]);
  assert.ok(configGuards[0] < setupNodes[0]);
  assert.ok(setupNodes[0] < bootstraps[0]);
  assert.doesNotMatch(workflow, /registry-url:/);
  assert.equal((workflow.match(/--registry=https:\/\/registry\.npmjs\.org npm@11\.18\.0/g) ?? []).length, 2);
  assert.equal((workflow.match(/npm ci --ignore-scripts/g) ?? []).length, 1);
  assert.equal((workflow.match(/npm audit --audit-level=high/g) ?? []).length, 1);
  assert.equal((workflow.match(/npm run check/g) ?? []).length, 1);
  assert.equal((workflow.match(/npm test/g) ?? []).length, 1);
  assert.equal((workflow.match(/npm run build/g) ?? []).length, 1);
  assert.equal((workflow.match(/npm pack --ignore-scripts/g) ?? []).length, 1);
  assert.equal((workflow.match(/verify-packed-artifact\.mjs/g) ?? []).length, 1);
  assert.equal((workflow.match(/smoke-packed-client\.mjs/g) ?? []).length, 1);
  const publicSource = workflow.indexOf('verify-public-source.mjs');
  const readiness = workflow.indexOf('verify-release-readiness.mjs');
  const install = workflow.indexOf('npm ci --ignore-scripts');
  assert.ok(publicSource > 0 && publicSource < readiness && readiness < install);
  assert.match(workflow, /name: npm-release-\$\{\{ steps\.release\.outputs\.version \}\}/);
  assert.match(workflow, /name: npm-release-\$\{\{ needs\.verify\.outputs\.version \}\}/);
  assert.match(publication, /verify-registry-release\.mjs prepublish release\/artifact-report\.json/);
  assert.match(publication, /NPM_EXPECTED_OWNER: \$\{\{ vars\.NPM_EXPECTED_OWNER \}\}/);
  assert.match(publication, /test -n "\$\{ACTIONS_ID_TOKEN_REQUEST_URL:-\}"/);
  assert.match(publication, /test -n "\$\{ACTIONS_ID_TOKEN_REQUEST_TOKEN:-\}"/);
  assert.match(publication, /test -z "\$\{NODE_AUTH_TOKEN:-\}"/);
  assert.match(registryVerification, /verify-registry-release\.mjs postpublish release\/artifact-report\.json/);
  assert.match(registryVerification, /"borgmcp@\$\{\{ needs\.verify\.outputs\.version \}\}"/);
  assert.match(registryVerification, /npm audit signatures --prefix registry-verification/);
  assert.doesNotMatch(registryVerification, /npm publish|--provenance/);
  assert.doesNotMatch(workflow, /CLIENT_NPM_PUBLICATION|Confirm publication remains deferred/);

  const ci = await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  for (const line of `${workflow}\n${ci}`.split('\n').filter((value) => value.trim().startsWith('uses:'))) {
    assert.match(line, /@[0-9a-f]{40}(?:\s+#.*)?$/, `Action is not pinned by full SHA: ${line.trim()}`);
  }
});

test('release documentation describes the activated minimal publication lane', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const security = await readFile(join(root, 'SECURITY.md'), 'utf8');
  const releasing = await readFile(join(root, 'docs', 'RELEASING.md'), 'utf8');
  const extraction = await readFile(join(root, 'docs', 'EXTRACTION_PROVENANCE.md'), 'utf8');

  assert.match(readme, /After verified publication/);
  assert.match(readme, /npm install -g borgmcp@2\.0\.2/);
  assert.doesNotMatch(readme, /npm install -g borgmcp(?:\s|$)/);
  assert.match(security, /protected npm environment and Trusted Publishing/);
  for (const boundary of [
    'same-run artifact',
    'NPM_EXPECTED_OWNER',
    'id-token: write',
    'NODE_AUTH_TOKEN',
    'npm audit signatures',
    'fixed attempt and delay',
  ]) assert.ok(releasing.includes(boundary), `Missing release boundary: ${boundary}`);
  for (const evidence of [
    'v2.0.0',
    '90a078264f4d61c0140ad0a30357a4df42c34ab0',
    '29693915689',
    'v2.0.1',
    'def12ee40af665fc6c3af4873a7d566b3f844fc1',
    'b30fc54a4d73bda98db4630864cca796c8923dd9',
    '29748931957',
    'sha512-Ah8IY2izZ774gYLKthRL9lfrV+JBk2o9HSlrWUplyZgoGqwVjVboHNon0hWWF5i/fObiCGikFOMY6qZ+vaeyCw==',
    'v2.0.2',
  ]) assert.ok(releasing.includes(evidence), `Missing immutable release evidence: ${evidence}`);
  assert.match(releasing, /failed before package\s+creation or npm publication/);
  assert.match(releasing, /Never delete, move, replace, reuse, or\s+rerun/);
  assert.match(extraction, /borgmcp-server@0\.1\.7/);
  assert.match(extraction, /reviewed `v2\.0\.2` source/);
  assert.doesNotMatch(`${readme}\n${security}\n${releasing}`, /publication is deferred|not yet published/);
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

test('release trigger rejects non-tag events, malformed tags, and version mismatch', () => {
  const valid = { eventName: 'push', refType: 'tag', refName: `v${CLIENT_VERSION}`, version: CLIENT_VERSION };
  assert.deepEqual(verifyReleaseTrigger(valid), { tag: `v${CLIENT_VERSION}`, version: CLIENT_VERSION });
  assert.throws(() => verifyReleaseTrigger({ ...valid, eventName: 'workflow_dispatch' }), /tag push event/);
  assert.throws(() => verifyReleaseTrigger({ ...valid, refType: 'branch' }), /tag ref/);
  assert.throws(() => verifyReleaseTrigger({ ...valid, refName: 'latest' }), /v<major>/);
  assert.throws(() => verifyReleaseTrigger({ ...valid, refName: 'v2.0.0' }), /exactly match/);
});

test('release readiness accepts the extracted standalone client', async () => {
  const report = await verifyReleaseReadiness(root);
  assert.deepEqual(report, { name: 'borgmcp', version: CLIENT_VERSION, shared: SHARED_VERSION });
});

test('public-source scan ignores a linked-worktree .git file', async (t) => {
  const worktree = await mkdtemp(join(tmpdir(), 'borgmcp-client-linked-worktree-'));
  t.after(() => rm(worktree, { recursive: true, force: true }));
  await mkdir(join(worktree, 'src'));
  await writeFile(join(worktree, 'src', 'index.ts'), 'export const ok = true;\n');
  // A linked worktree stores .git as a FILE (gitdir pointer), not a directory;
  // the walk must skip it (it is in the excluded set) rather than scan its path.
  await writeFile(join(worktree, '.git'), 'gitdir: /Users/private/repository/.git/worktrees/client\n');

  // A clean local-only tree scans without throwing.
  assert.doesNotThrow(() => execFileSync(
    process.execPath,
    [join(root, 'scripts', 'verify-public-source.mjs')],
    { cwd: worktree, stdio: 'pipe' },
  ));

  // Any Google OAuth client material is forbidden in the local-only client.
  // Build the client-id at runtime so THIS test source carries no literal,
  // contiguous OAuth token for the repo-wide scan to flag (mirrors the token
  // construction below).
  const clientId = ['leaked-client', 'apps', 'googleusercontent', 'com'].join('.');
  await writeFile(
    join(worktree, 'src', 'leak.ts'),
    `export const id = ${JSON.stringify(clientId)};\n`,
  );
  assert.throws(() => execFileSync(
    process.execPath,
    [join(root, 'scripts', 'verify-public-source.mjs')],
    { cwd: worktree, stdio: 'pipe' },
  ));
});

test('public-source scan forbids Google OAuth client material anywhere (local-only)', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'borgmcp-client-oauth-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'scripts'));
  await cp(
    join(root, 'scripts', 'verify-public-source.mjs'),
    join(fixture, 'scripts', 'verify-public-source.mjs'),
  );
  const token = ['GOCSPX-', 'a'.repeat(32)].join('');
  await writeFile(join(fixture, 'oauth-material.txt'), `${token}\n`);

  assert.throws(
    () => execFileSync(
      process.execPath,
      [join(fixture, 'scripts', 'verify-public-source.mjs')],
      { cwd: fixture, encoding: 'utf8', stdio: 'pipe' },
    ),
    (error) => {
      const diagnostic = `${error.stderr ?? ''}`;
      assert.match(diagnostic, /oauth-material\.txt: Google OAuth client material is forbidden/);
      return true;
    },
  );
});

test('release readiness accepts one canonical registry-resolved shared dependency', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await validPackage(directory);
  const report = await verifyReleaseReadiness(join(directory, 'package'));
  assert.deepEqual(report, { name: 'borgmcp', version: CLIENT_VERSION, shared: SHARED_VERSION });
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
  await mkdir(join(packageRoot, 'scripts'));
  await cp(
    join(root, 'scripts', 'verify-release-readiness.mjs'),
    join(packageRoot, 'scripts', 'verify-release-readiness.mjs'),
  );
  const workflowSteps = `set -euo pipefail
test "\${GITHUB_RUN_ATTEMPT}" = "1"
test ! -e .npmrc
printf '%s\\n' 'registry=https://registry.npmjs.org/' > "\${NPM_CONFIG_USERCONFIG}"
node scripts/verify-release-readiness.mjs
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
  manifest.version = `${CLIENT_VERSION}-beta.1`;
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
      { resolved: 'https://registry.npmjs.org/other/-/other-0.3.0.tgz' },
      { resolved: 'https://registry.npmjs.org/borgmcp-shared/-/borgmcp-shared-0.3.1.tgz' },
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
    version: SHARED_VERSION,
    tarball: SHARED_TARBALL,
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
    version: SHARED_VERSION,
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
        version: SHARED_VERSION,
        dist: {
          tarball: SHARED_TARBALL,
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
  assert.equal(report.version, CLIENT_VERSION);
  assert.equal(report.sourceMapCount, 2);
  assert.match(report.integrity, /^sha512-/);
});

test('exact tarball installs cleanly and completes MCP initialize plus tool discovery', async (t) => {
  const { directory, tarball } = await packedFixture(async ({ packageRoot }) => {
    await removeFixtureRuntimeDependencies(packageRoot);
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { consumer, packageRoot, binPath } = await installFixtureConsumer(directory, tarball);
  execFileSync('npm', ['ls', '--global', '--prefix', consumer, '--omit=dev', '--all', '--package-lock=false'], { encoding: 'utf8' });
  const report = await smokePackedClient(packageRoot, { binPath });
  assert.deepEqual(report, { name: 'borgmcp', version: CLIENT_VERSION, toolCount: 1 });
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

test('registry release helpers reject wrong package, version, owner, and existing versions', async () => {
  const report = {
    name: 'borgmcp',
    version: CLIENT_VERSION,
    integrity: `sha512-${Buffer.from('a'.repeat(128), 'hex').toString('base64')}`,
  };
  assert.throws(() => verifyArtifactReport({ ...report, name: 'other' }, report.version), /must be borgmcp/);
  assert.throws(() => verifyArtifactReport(report, '2.0.0'), /exactly 2\.0\.0/);

  const existing = async () => new Response('{}', { status: 200 });
  await assert.rejects(
    () => verifyPrepublish(report, { expectedOwner: 'byteventures', request: existing }),
    /already exists and is immutable/,
  );

  const wrongOwnerResponses = [
    new Response('', { status: 404 }),
    new Response(JSON.stringify({ maintainers: [{ name: 'other' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ];
  await assert.rejects(
    () => verifyPrepublish(report, {
      expectedOwner: 'byteventures',
      request: async () => wrongOwnerResponses.shift(),
    }),
    /ownership differs/,
  );
});

test('postpublish helper bounds registry propagation and requires exact integrity', async () => {
  const report = {
    name: 'borgmcp',
    version: CLIENT_VERSION,
    integrity: `sha512-${Buffer.from('a'.repeat(128), 'hex').toString('base64')}`,
  };
  let requests = 0;
  const waits = [];
  const result = await verifyPostpublish(report, {
    attempts: 3,
    intervalMs: 7,
    request: async () => {
      requests += 1;
      return requests < 3
        ? new Response('', { status: 404 })
        : new Response(JSON.stringify({ dist: { integrity: report.integrity } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    },
    wait: async (ms) => waits.push(ms),
  });
  assert.equal(requests, 3);
  assert.deepEqual(waits, [7, 7]);
  assert.equal(result.integrity, report.integrity);

  await assert.rejects(
    () => verifyPostpublish(report, {
      attempts: 2,
      intervalMs: 0,
      request: async () => new Response('', { status: 404 }),
      wait: async () => {},
    }),
    /returned HTTP 404/,
  );
  await assert.rejects(
    () => verifyPostpublish(report, {
      request: async () => new Response(JSON.stringify({ dist: { integrity: 'sha512-wrong' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    /Registry integrity mismatch/,
  );
});
