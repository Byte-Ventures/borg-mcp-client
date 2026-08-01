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
  assertArtifactIdentity,
  assertJourneyTranscript,
  assertServerProcessArgv,
  parseReleaseExerciseArgs,
  ptyCommand,
  resolvePackageEntry,
} from '../scripts/release-exercise.mjs';
import {
  lockRegistryEntries,
  registryCompatible,
  verifyManifest,
  verifyReleaseReadiness,
} from '../scripts/verify-release-readiness.mjs';

const root = resolve(import.meta.dirname, '..');
const CLIENT_VERSION = '2.9.0';
const SHARED_VERSION = '0.7.1';
const SHARED_TARBALL = 'https://registry.npmjs.org/borgmcp-shared/-/borgmcp-shared-0.7.1.tgz';
const SHARED_INTEGRITY = 'sha512-d4GE7ezGyoFN0uwA62gvRPUMfMdJ1kxhTunqU8dW3Qhy1n2SlNXZWr1Nthm6Goo0bAgvax8KEywyReodA6FyQA==';

test('release-lane current version matches the package manifest', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(CLIENT_VERSION, manifest.version);
});

test('release exercise requires an explicit server artifact identity', () => {
  assert.throws(() => parseReleaseExerciseArgs([]), /--server/);
  assert.deepEqual(
    parseReleaseExerciseArgs([
      '--server', './server.tgz',
      '--server-integrity', 'sha512-Y2FuZGlkYXRl',
      '--client-tarball', './client.tgz',
    ]),
    {
      server: './server.tgz',
      serverIntegrity: 'sha512-Y2FuZGlkYXRl',
      clientTarball: './client.tgz',
    },
  );
  assert.throws(
    () => parseReleaseExerciseArgs(['--server', './server.tgz', '--server-integrity', 'wrong']),
    /SHA-512 SRI/,
  );
  assert.throws(
    () => parseReleaseExerciseArgs([
      '--server', './server.tgz', '--server-integrity', 'sha512-Y2FuZGlkYXRl', '--unknown',
    ]),
    /Unknown argument/,
  );
});

test('release exercise constructs a real PTY bridge on supported platforms', () => {
  const darwin = ptyCommand('darwin', ['/node path', '--eval', 'source']);
  assert.equal(darwin.command, 'python3');
  assert.deepEqual(darwin.args.slice(-3), ['/node path', '--eval', 'source']);
  const linux = ptyCommand('linux', ['/node path', '--eval', "it's source"]);
  assert.equal(linux.command, 'python3');
  assert.deepEqual(linux.args.slice(-3), ['/node path', '--eval', "it's source"]);
  assert.throws(() => ptyCommand('win32', ['node']), /unsupported platform/);
});

test('release exercise rejects substituted server processes', () => {
  assert.doesNotThrow(() => assertServerProcessArgv(
    ['/node/exact', '/isolated/node_modules/borgmcp-server/dist/main.js', 'start'],
    '/node/exact',
    '/isolated/node_modules/borgmcp-server/dist/main.js',
  ));
  assert.throws(() => assertServerProcessArgv(
    ['/usr/bin/node', '/global/node_modules/borgmcp-server/dist/main.js', 'start'],
    '/node/exact',
    '/isolated/node_modules/borgmcp-server/dist/main.js',
  ), /declared Node path/);
  assert.throws(() => assertServerProcessArgv(
    ['/node/exact-wrapper', '/isolated/node_modules/borgmcp-server/dist/main.js', 'start'],
    '/node/exact',
    '/isolated/node_modules/borgmcp-server/dist/main.js',
  ), /declared Node path/);
  assert.throws(() => assertServerProcessArgv(
    ['/node/exact', '/isolated/node_modules/borgmcp-server/dist/main.js.evil', 'start'],
    '/node/exact',
    '/isolated/node_modules/borgmcp-server/dist/main.js',
  ), /declared server entry/);
  const expected = { path: '/isolated/server/dist/main.js', integrity: 'sha512-candidate' };
  assert.doesNotThrow(() => assertArtifactIdentity(expected, expected));
  assert.throws(
    () => assertArtifactIdentity(
      { path: '/global/server/dist/main.js', integrity: 'sha512-published' },
      expected,
    ),
    /resolved artifact path/,
  );
  assert.throws(
    () => assertArtifactIdentity(
      { path: expected.path, integrity: 'sha512-published' },
      expected,
    ),
    /resolved artifact integrity/,
  );
});

test('release exercise rejects a package bin that escapes its SRI-covered root', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-escaping-bin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source');
  const consumer = join(directory, 'consumer');
  const published = join(directory, 'published');
  await mkdir(join(source, 'dist'), { recursive: true });
  await mkdir(consumer);
  await mkdir(published);
  await writeFile(join(source, 'package.json'), `${JSON.stringify({
    name: 'borgmcp-server',
    version: '9.9.9',
    bin: { 'borg-mcp-server': '../../../published/main.js' },
  }, null, 2)}\n`);
  await writeFile(join(source, 'dist', 'main.js'), 'export const packaged = true;\n');
  await writeFile(join(published, 'main.js'), 'export const escaped = true;\n');
  const [packed] = JSON.parse(execFileSync('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', directory,
  ], { cwd: source, encoding: 'utf8' }));
  await writeFile(join(consumer, 'package.json'), '{"name":"escaping-bin-consumer","private":true}\n');
  execFileSync('npm', [
    'install', '--ignore-scripts', '--package-lock=true', '--save-exact',
    join(directory, packed.filename),
  ], { cwd: consumer, stdio: 'pipe' });

  const serverRoot = await realpath(join(consumer, 'node_modules', 'borgmcp-server'));
  const manifest = JSON.parse(await readFile(join(serverRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'));
  assert.match(lock.packages['node_modules/borgmcp-server'].integrity, /^sha512-/);
  await assert.rejects(
    resolvePackageEntry(serverRoot, manifest.bin['borg-mcp-server'], 'server'),
    /outside its installed package root/,
  );
});

test('release exercise requires observable frame, exit, and terminal restoration outcomes', () => {
  const good = `\u001b[?1049hFRAME ^C close viewer\u001b[?25h\u001b[?1049l`;
  const report = { stdinTTY: true, stdoutTTY: true, code: 0, signal: null };
  assert.doesNotThrow(() => assertJourneyTranscript(good, '^C close viewer', report));
  assert.throws(
    () => assertJourneyTranscript('\u001b[?1049hFRAME ^C close viewer', '^C close viewer', report),
    /restore the cursor/,
  );
  assert.throws(
    () => assertJourneyTranscript(good, '^C close viewer', { ...report, code: 130 }),
    /code 130/,
  );
  assert.throws(
    () => assertJourneyTranscript(good, '^C stop server', report),
    /did not match/,
  );
});

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
      : `#!/usr/bin/env node
import { spawn } from 'node:child_process';
if (process.argv.slice(2).join('\\0') === 'update\\0--help') {
  process.stdout.write('borg update\\nmatching exact borgmcp-shared pins\\n');
  process.exit(0);
}
const [command, ...args] = process.argv.slice(3);
const child = spawn('borg-mcp-server', [command, ...args], { shell: false, stdio: 'inherit' });
child.on('error', (error) => {
  if (error.code === 'ENOENT') {
    process.stderr.write('Local server command is unavailable: borg-mcp-server was not found.\\n');
    process.stderr.write('Next: install a verified borgmcp-server release, then rerun borg server ' + command + '.\\n');
    process.stderr.write('No checkout fallback is attempted.\\n');
    process.exit(127);
  }
  process.stderr.write('Local server command could not be started.\\n');
  process.stderr.write('Next: check local permissions and system resources, then rerun borg server ' + command + '.\\n');
  process.stderr.write('No server command was started.\\n');
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 1)));
`;
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

test('release workflow uses one package authority and one protected publish with no post-publish readback', async () => {
  const workflow = await readFile(join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
  const [verification = '', afterVerify = ''] = workflow.split('\n  publish:\n');
  const publication = afterVerify;

  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(verification, /environment:/);
  assert.doesNotMatch(verification, /id-token: write/);
  assert.match(publication, /needs: verify/);
  assert.match(publication, /environment:\n\s+name: npm-publish/);
  assert.match(publication, /id-token: write/);
  assert.doesNotMatch(workflow, /\n  registry-verification:\n/);
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
  assert.equal(checkouts.length, 2);
  assert.equal(attemptGuards.length, 1);
  assert.equal(configGuards.length, 1);
  assert.equal(setupNodes.length, 2);
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
  assert.doesNotMatch(workflow, /verify-registry-release\.mjs postpublish/);
  assert.doesNotMatch(workflow, /npm audit signatures/);
  assert.doesNotMatch(workflow, /CLIENT_NPM_PUBLICATION|Confirm publication remains deferred/);

  const ci = await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  for (const line of `${workflow}\n${ci}`.split('\n').filter((value) => value.trim().startsWith('uses:'))) {
    assert.match(line, /@[0-9a-f]{40}(?:\s+#.*)?$/, `Action is not pinned by full SHA: ${line.trim()}`);
  }
});

test('release documentation describes the activated minimal publication lane', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const security = await readFile(join(root, 'SECURITY.md'), 'utf8');
  const releasing = await readFile(join(root, 'docs', 'RELEASING.md'), 'utf8');
  const extraction = await readFile(join(root, 'docs', 'EXTRACTION_PROVENANCE.md'), 'utf8');

  assert.equal(manifest.scripts['release:exercise'], 'npm run build && node scripts/release-exercise.mjs');

  assert.match(readme, /Install the client from npm:/);
  assert.doesNotMatch(readme, /After verified publication/);
  assert.equal(readme.match(/^npm install -g borgmcp$/gm)?.length, 1);
  assert.doesNotMatch(readme, /^npm install -g borgmcp@/gm);
  assert.match(readme, /asks before linking that cube to the repository/);
  assert.match(readme, /never links an existing\s+cube by name during a non-interactive run/);
  assert.match(security, /protected npm environment and Trusted Publishing/);
  for (const boundary of [
    'same-run artifact',
    'NPM_EXPECTED_OWNER',
    'id-token: write',
    'NODE_AUTH_TOKEN',
    'no post-publication registry readback',
    'Pre-tag composed exercise',
    '--server-integrity',
    'inside the installed package root',
    'not a containment sandbox',
  ]) assert.ok(releasing.includes(boundary), `Missing release boundary: ${boundary}`);
  assert.match(releasing, /PATH ordering\s+alone is never accepted as identity evidence/);
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
    'a1fc1f8f05c3f1b4d7ccbef86e244955642165b5',
    'aced84956fdf41315904c8901e50a345f628152c',
    '29840120451',
    'sha512-w0O0t/2wzeJpXEqb4jQGuqZeavEkfFKdz6poRT8q1TxDKHTlOlwo3auctE+X1kWU2s5JkSDcUiUdQdyLwu84IA==',
    'v2.0.3',
    '47701127cbdba6499595ef0529de264b00a61840',
    '3e44e9c439c036850c6a9226d02876f4883501d9',
    '29851751102',
    'sha512-3Iy4BSB+yq8F75w/gWiEU7D+mKCYYa5mIsn/iC/byy5CK/QsAWg10KgsBI3GlDBZul1CD3Qq+zpmVeK2qpIE1A==',
    'v2.0.4',
    'f86c5b81b77afa7ebd080b508831f1dc39c403e2',
    '57a26139a11b47bc5f1d7234bc69e2a2a75954b3',
    '29925624599',
    'sha512-xuGxMQ9FZTQN4KP/wGlJqI4LgxP2aKpeykbakjfXHPeUzmNHvkN0YtcenzlSvHsObnpQgMfsy7TNy+YrPkk65g==',
    'v2.0.5',
    '242ed67fec00701f4eb332302e60dff84c0368f7',
    'a18a169ec96c5e3194b3bd3edc9e84002c4bc7a3',
    '29955861508',
    'sha512-pMqovKzUu0Mdru2YJULj3XkHSeiT/PuCAjwCQ2Sg/mmF299tZE80qvca6GCNCLjhYEWWIuXmssuxK7wePKqxdw==',
    'v2.0.6',
    'b41d312efc9f8d1ed63021812d8165b00011e8d8',
    '5fd9048e4c22e4478160e3a25654837b5a33d8bb',
    '29982288768',
    'sha512-WDX4tmk46I6Tvb/Gz1XlD/9PbIgOe72rRDCjV+/lw6KnAxWW0S25LT1DgifotI9LQv7LLAok8WkjucDDTTQ+pw==',
    'v2.0.7',
    'bf41d5a70d7df11930a3124feda72835ae903522',
    '85f7c45cffdd449a6de4a52608453b6680492221',
    '30009042758',
    '@esbuild/openbsd-arm64@0.28.1',
    'v2.0.8',
    '7b5a4929534abfa97a65e278df230adfdb842d8f',
    '8bc796d8fc4e307dca593138fb080984662c7d62',
    '30012098601',
    'sha512-az1IKG4VNwAF/8PKEVK88gdRoFFBqgtl6ObXX+CcJadavNqkwJ9UFeP8LOJ2js911mIiXEm8c4xDf6MnO0GOng==',
    'v2.0.9',
    '3a88bb4f46143789803a4e57f52b94d762f1ca9b',
    '18084fc486a041f3438f584a97d218c01a5e0399',
    '30047299013',
    'sha512-lf0TZ8ZcpHv/Nt3LkY/IGxkUFkg3weavF+rLv6xLImDDhLIaZly1y8jUdo3UuheQVhrLnLcxoz37Myr4mPx9lg==',
    'v2.0.10',
    '31ae3c19ac4e04fac33269459a460d5316cce730',
    '3f7003b65eadc74cd949857e831e1181a1aad2ff',
    '30063538271',
    'sha512-BkFrq75mF7ih0/7Z7RsXsJYo43qNs4ng7tSnvcFCl3k6r+ex1FvTkah0+KQNinDSrv6a+HLWahUe8875so8zew==',
    'v2.0.11',
    'fb95f4278137d1d7871d945c467eb33984abe1c4',
    '0676d93d3e8a64ba583e95f164d122b39687b53a',
    '30073844074',
    'sha512-429njJ7HVmWhpm8E71RoLzG57Qehy3RSxEzs6fQofVoOIiZXnK4QQDwbQe9MPfhKifbvVN5lGcDKtKAjuC76ww==',
    'v2.1.0',
    'e0b189bb0dd1f1b12369ab81870113925e1afc41',
    '10f18e4010c9c518c0ea2184d42ed5388642a53f',
    '30166498938',
    'sha512-Gm9n69y3C0feNDYRPEOnShLCscQJ/BoylcRMH+sDDQJmdcbjY8+U6dDTcFv3w+uH5P/IVwJydB8TGRHPXL0FQA==',
    'v2.1.1',
    'aa8d772c4791b2da16d702d5d78e5b3c365796c4',
    'db0a6a76744928e0067eb03b8a236076c56ae758',
    '30174878044',
    'sha512-nZJ3i6LBIj/4743mqVRJTUH3YGmC8HfC/NuQb7eOv+/K/dyBogDnwZ3opiZiZSe4LE5CXuG72Sip7cPRoCoZrA==',
    'v2.2.0',
    'edf12fcd4c56eb0ad59917269aaeee223b36bd53',
    'db4f374e88c24dadee47d5400537890cad1e5f40',
    '30195666955',
    'sha512-Pi3rpQH6f+V67OPoRIwyKjOFrCJ5y/39knCayExBmnMC5Urb8m+m9UQVNV7cWMuhd3S3WMM6JOkgcIYOVhWnxg==',
    'v2.3.0',
    '24b1f8622a0a0b542dbac26c70662f5b499d3426',
    '9e708b7233486abdcd7fbc893a2d5bc818241d87',
    '30218208664',
    'sha512-xyiyC/HXvWnSiii621WdA4qBKehmBzZSaLGN6PZvf82FQUqVONrRyhl1SmOLzPlPXX9boNKSA1EuaVJrtUv6zA==',
    'v2.4.0',
    '55458a1c38a670d3e15f8b19909afea195a146ce',
    '3882c22d7e8eca34a2213a4e2e4b1bf10dce8fe3',
    '30246632666',
    'sha512-dQ4jXxmubhtXhIxObTegYYMrgPVk2mZXNHFfV4MRwRWKr1TpQ4xXdmp3Qb89vOOOORvZlux6GNNS5kjy3wDvZw==',
    'v2.4.1',
    '1e42aac25fc5368f16334a1eb48ffd0524a3fe7f',
    '6b3b5d3c2c008888e55dd88485dafcb623ef9e17',
    '30282532108',
    'sha512-/tMVjZYqXQrZNPoZHjhpaS02e4Qju752sV+BLf9ML7yFmIf6DhzfItj9hDj/3+ORm6GK3aS4Fz4JmiWDxworZg==',
    'v2.5.0',
    '23132a4d71d42f59fd08bab66f0fe3da0114a15a',
    '771dd6e78e26744180b2470374790d0e91aad7d7',
    '30349154152',
    'sha512-BQ5vxtmxqD9V+dmPuGQaog8Ip+K+hbnCxmjZt0zX2v354x7gUZtIt5zmP3HTNe4A5rmO9sp4qvv7XA4gcAGNrg==',
    'v2.6.0',
    'c8598e1a1852a3690f53f7089a8342b53e2191da',
    'ef90006de0005e2fe2b35d36907a4656352e4abf',
    '30421261350',
    'sha512-KvJ5kuyMXH6Vd9tImV0zvXWhSj2Y68r09mAO3TqhsGAQM2XERcBPeEmrdp6VI1Z3KYMPjdg0bRvRW7CGonFl9w==',
    'v2.6.1',
    'e65b9d43c4a5a7c12a4fafc6e3f1024f6d99c023',
    '902847186f5c4fc00f3610ee027e8f929b977670',
    '30427148267',
    'sha512-N0NIsD2D39d98vvjMkcFwMSn/UXHuHMdMTcuk3awfo6t5FHyd7BYhBsQXhpDuvdJK/02S8g0OdvfHUb827siYQ==',
    'v2.7.0',
    'a9a7f75114548b6c383168164f0f59bb05c02b85',
    'a8d3c572dee3b90cf2a898768c45a1f46270fe11',
    '30440435955',
    'sha512-qn7ljuq/UwYzQJ5pWliLqD7Q5mlwk287ObOXbSV5FOcs+JdoXjFlb9NVC6bFoQzjHaWixCX600EAEtRZ0UeNPw==',
    'v2.7.1',
    'fc308b52393edf0ed8299490980207840a69c157',
    '41091978bfe02831863de26e75fdf3bb48d4b038',
    '30463299198',
    'sha512-hgxKTCAocbTsBV/YHIegn/jlG9a9YwdbOHD3s5mL+CsN61/5m180rvGJ8+RlNRd5Sdk408phc+QW2Li46tmTMg==',
    'v2.7.2',
    '0b16c38da15090a49b285e687fae45381f0f6812',
    '52b8a54565f548560dd674d689e0b841e2d8590d',
    '30491774435',
    'sha512-j/OKr5FzhnDbnLn4pNadbi6XQwR6hcmlfSQHuDsy696KYroL1UagIzelpLJXR+uR/T6FKbD2Zdphr/s81l1Rfw==',
    'v2.7.3',
    'b084eb3d2177fc93aa87ca58efde402542b90b8f',
    '83fadd1b308f2b770ce0d8da6a3b61183ec94f8d',
    '30618377765',
    'sha512-Jb+Kg/+H3cPU34JX7eFV3gEO/PzdfJEruNU1mJwYlQZKG7TMfrLJzwghDzxmlMupHJHL3rzAVZ224wioM/pclg==',
    'v2.8.0',
    '576e2401a83537662ef0d5f7b0d03d6101b15c54',
    'ad40e93ee9b1ff2801119c1c763ad526974ae2a6',
    '30639790368',
    'sha512-hKNyWwVg/8WJ/qcqaNjZVylMw2UzgFEhE7sAJmWy/BjNU4lEa6ox8N7SdbEt8hhKsySMxt+YTFbNFitRtf9u3g==',
    'v2.9.0',
  ]) assert.ok(releasing.includes(evidence), `Missing immutable release evidence: ${evidence}`);
  assert.match(releasing, /failed before package\s+creation or npm publication/);
  assert.match(releasing, /Never delete, move, replace, reuse, or\s+rerun/);
  assert.match(extraction, /borgmcp-server@0\.8\.0/);
  assert.match(extraction, /sha512-OSnBBcdZOM88Dokr7WICcTmF19c\+Nr0TOl7NXy8DSUeCpBttiKKx\+KuFvGbaXAWikFkm0UUBUca5cLZAOWw4Xw==/);
  assert.ok(extraction.includes(`reviewed \`v${manifest.version}\` source`));
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

test('lock metadata verification retries only bounded transient HTTP failures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-client-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { lock } = await validPackage(directory);
  const lockPath = join(directory, 'retry-lock.json');
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const canonical = lock.packages['node_modules/borgmcp-shared'];
  const metadata = {
    name: 'borgmcp-shared',
    version: SHARED_VERSION,
    dist: { tarball: canonical.resolved, integrity: canonical.integrity },
  };
  const response = (status) => ({
    ok: status === 200,
    status,
    json: async () => metadata,
  });

  const transientStatuses = [504, 429, 200];
  const transientSleeps = [];
  let transientCalls = 0;
  await verifyLockRegistry(lockPath, {
    fetchImpl: async () => response(transientStatuses[transientCalls++]),
    retryDelaysMs: [1, 2],
    sleep: async (delayMs) => transientSleeps.push(delayMs),
  });
  assert.equal(transientCalls, 3);
  assert.deepEqual(transientSleeps, [1, 2]);

  let terminalCalls = 0;
  await assert.rejects(() => verifyLockRegistry(lockPath, {
    fetchImpl: async () => {
      terminalCalls += 1;
      return response(404);
    },
    retryDelaysMs: [1, 2],
    sleep: async () => assert.fail('terminal HTTP status must not sleep'),
  }), /HTTP 404/);
  assert.equal(terminalCalls, 1);

  const exhaustedSleeps = [];
  let exhaustedCalls = 0;
  await assert.rejects(() => verifyLockRegistry(lockPath, {
    fetchImpl: async () => {
      exhaustedCalls += 1;
      return response(503);
    },
    retryDelaysMs: [1, 2],
    sleep: async (delayMs) => exhaustedSleeps.push(delayMs),
  }), /HTTP 503/);
  assert.equal(exhaustedCalls, 3);
  assert.deepEqual(exhaustedSleeps, [1, 2]);
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

test('packed smoke derives cube-init help from the built contract without a local copy', async () => {
  const source = await readFile(join(root, 'scripts', 'smoke-packed-client.mjs'), 'utf8');
  assert.match(
    source,
    /await import\(new URL\('\.\.\/dist\/cli-help\.js', import\.meta\.url\)\)/,
  );
  assert.doesNotMatch(source, /CUBE_INIT_HELP_TEXT|function cubeInitHelpText|borg server cube init \(borgmcp/);
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

test('packed artifact verifier rejects a hosted dashboard subdomain', async (t) => {
  const { directory, tarball } = await packedFixture(async ({ packageRoot }) => {
    await writeFile(join(packageRoot, 'src', 'review-control.ts'), '// review-control: https://dashboard.borgmcp.ai\n');
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    () => verifyPackedArtifact(tarball, { repositoryRoot: directory }),
    /unapproved dashboard occurrence/,
  );
});

test('packed artifact verifier rejects npm-registry egress outside the explicit update command', async (t) => {
  const { directory, tarball } = await packedFixture(async ({ packageRoot }) => {
    await writeFile(
      join(packageRoot, 'src', 'background-update.ts'),
      'export const registry = "https://registry.npmjs.org/";\n',
    );
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    () => verifyPackedArtifact(tarball, { repositoryRoot: directory }),
    /unapproved npm-registry egress/,
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
