import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { prepareRelease, verifyReleaseIdentity } from '../scripts/release-identity.mjs';

const root = resolve(import.meta.dirname, '..');
const oldVersion = '2.2.0';
const newVersion = '2.3.0';
const integrity = `sha512-${'A'.repeat(86)}==`;
const allowlistPath = 'scripts/release-identity-allowlist.json';
const stablePath = 'scripts/local-dashboard-occurrences.json';
const releaseTestPath = 'test/release-lane.test.mjs';

test('release branches run the classifier in protected CI', async () => {
  const workflow = await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const releasing = await readFile(join(root, 'docs', 'RELEASING.md'), 'utf8');
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/heads\/release\/'\)/);
  assert.match(workflow, /startsWith\(github\.head_ref, 'release\/'\)/);
  assert.match(workflow, /verify:release-identity -- --base origin\/main/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.equal(manifest.scripts['release:prepare'], 'node scripts/release-identity.mjs prepare');
  assert.equal(manifest.scripts['verify:release-identity'], 'node scripts/release-identity.mjs verify');
  assert.match(releasing, /Candidate tree is the deterministic release transform|exact tree\s+equality/);
});

test('the client release allowlist is explicit, sorted, and live', async () => {
  const allowlist = JSON.parse(await readFile(join(root, allowlistPath), 'utf8'));
  assert.deepEqual(allowlist.versionPins, [...allowlist.versionPins].sort());
  assert.deepEqual(allowlist.stablePaths, [...allowlist.stablePaths].sort());
  assert.deepEqual(allowlist.versionPins, [releaseTestPath]);
  assert.deepEqual(allowlist.stablePaths, [stablePath]);
  assert.match(await readFile(join(root, releaseTestPath), 'utf8'), /const CLIENT_VERSION = '2\.2\.0';/);
});

test('prepare generates exactly the client identity surfaces and verifies their Git tree', async (t) => {
  const fixture = await createFixture(t);
  const prepared = await prepareRelease(fixture.root, newVersion, fixture.evidence, fixture.authorities);
  assert.deepEqual(prepared.paths, [
    'docs/EXTRACTION_PROVENANCE.md',
    'docs/RELEASING.md',
    'package-lock.json',
    'package.json',
    releaseTestPath,
  ]);
  commitAll(fixture.root, 'prepare release');
  const verified = verifyReleaseIdentity(fixture.root, fixture.base, fixture.authorities);
  assert.equal(verified.oldVersion, oldVersion);
  assert.equal(verified.newVersion, newVersion);
  assert.equal(verified.tree, git(fixture.root, ['rev-parse', 'HEAD^{tree}']));
});

for (const [name, mutate] of [
  ['wrong run id', (record) => { record.workflow_run_id = 999; }],
  ['wrong run attempt', (record) => { record.workflow_run_attempt = 2; }],
  ['wrong artifact SRI', (record) => { record.artifact_integrity = `sha512-${'B'.repeat(86)}==`; }],
  ['wrong annotated tag object', (record) => { record.tag_object = 'f'.repeat(40); }],
  ['wrong peeled commit', (record) => { record.commit = 'e'.repeat(40); }],
]) {
  test(`release identity rejects false provenance: ${name}`, async (t) => {
    const fixture = await preparedFixture(t);
    const path = join(fixture.root, 'docs', 'RELEASING.md');
    const record = { ...fixture.record };
    mutate(record);
    await writeFile(path, (await readFile(path, 'utf8')).replace(
      releaseParagraph(fixture.record),
      releaseParagraph(record),
    ));
    commitAll(fixture.root, `mutate ${name}`);
    assert.throws(() => verifyReleaseIdentity(fixture.root, fixture.base, fixture.authorities));
  });
}

for (const [name, mutate] of [
  ['a third lockfile change', async (fixture) => {
    const path = join(fixture.root, 'package-lock.json');
    const lock = JSON.parse(await readFile(path, 'utf8'));
    lock.packages[''].dependencies.unexpected = '1.0.0';
    await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
  }],
  ['a stale CLIENT_VERSION constant', async (fixture) => {
    const path = join(fixture.root, releaseTestPath);
    await writeFile(path, (await readFile(path, 'utf8')).replace(
      `const CLIENT_VERSION = '${newVersion}';`,
      `const CLIENT_VERSION = '${oldVersion}';`,
    ));
  }],
  ['a deleted release evidence assertion', async (fixture) => {
    const path = join(fixture.root, releaseTestPath);
    await writeFile(path, (await readFile(path, 'utf8')).replace(`    '${fixture.record.commit}',\n`, ''));
  }],
  ['a changed release allowlist', async (fixture) => {
    const path = join(fixture.root, allowlistPath);
    await writeFile(path, `${await readFile(path, 'utf8')}\n`);
  }],
  ['no-cloud allowlist churn', async (fixture) => {
    await writeFile(join(fixture.root, stablePath), '[{"renumbered":true}]\n');
  }],
  ['a hand edit outside the transform', async (fixture) => {
    await writeFile(join(fixture.root, 'manual-edit.txt'), 'not release identity\n');
  }],
  ['a mode change hidden in a transformed path', async (fixture) => {
    await chmod(join(fixture.root, 'package.json'), 0o755);
  }],
]) {
  test(`release identity rejects ${name}`, async (t) => {
    const fixture = await preparedFixture(t);
    await mutate(fixture);
    commitAll(fixture.root, `mutate ${name}`);
    assert.throws(() => verifyReleaseIdentity(fixture.root, fixture.base, fixture.authorities));
  });
}

async function preparedFixture(t) {
  const fixture = await createFixture(t);
  const prepared = await prepareRelease(fixture.root, newVersion, fixture.evidence, fixture.authorities);
  commitAll(fixture.root, 'prepare release');
  assert.doesNotThrow(() => verifyReleaseIdentity(fixture.root, fixture.base, fixture.authorities));
  return { ...fixture, record: prepared.record };
}

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'borg-client-release-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFixture(directory, allowlistPath, `${JSON.stringify({
    stablePaths: [stablePath],
    versionPins: [releaseTestPath],
  }, null, 2)}\n`);
  await writeFixture(directory, stablePath, '[]\n');
  await writeFixture(directory, 'package.json', `${JSON.stringify({
    name: 'borgmcp',
    version: oldVersion,
    private: false,
  }, null, 2)}\n`);
  await writeFixture(directory, 'package-lock.json', `${JSON.stringify({
    name: 'borgmcp',
    version: oldVersion,
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'borgmcp',
        version: oldVersion,
        dependencies: { stable: '1.0.0' },
      },
    },
  }, null, 2)}\n`);
  await writeFixture(directory, 'docs/EXTRACTION_PROVENANCE.md',
    `Published successors were published, so the next candidate identity is \`${oldVersion}\`.\n` +
    `Client \`borgmcp@2.1.1\` is published. Publication remains gated by reviewed \`v${oldVersion}\` source.\n`);
  await writeFixture(directory, 'docs/RELEASING.md',
    `# Releasing\n\nThe next candidate\n` +
    `uses the unused \`v${oldVersion}\` identity from a fresh reviewed protected-main commit\n` +
    `and requires the complete release gate again.\n`);
  await writeFixture(directory, releaseTestPath,
    `const CLIENT_VERSION = '${oldVersion}';\n` +
    `for (const evidence of [\n    'v${oldVersion}',\n  ]) assert.ok(evidence);\n`);
  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.name', 'Release Test']);
  git(directory, ['config', 'user.email', 'release-test@example.invalid']);
  commitAll(directory, 'base');
  git(directory, ['tag', '-a', `v${oldVersion}`, '-m', `release ${oldVersion}`]);
  const base = git(directory, ['rev-parse', 'HEAD']);
  const evidence = { workflowRunId: 123, workflowRunAttempt: 1, artifactIntegrity: integrity };
  const authorities = {
    githubRun: () => ({
      id: 123,
      run_attempt: 1,
      head_sha: base,
      head_branch: `v${oldVersion}`,
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      path: '.github/workflows/publish.yml',
    }),
    artifactIntegrity: () => integrity,
  };
  return { root: directory, base, evidence, authorities };
}

function releaseParagraph(record) {
  return (
    `The annotated \`${record.tag}\` tag object\n` +
    `\`${record.tag_object}\` peels to protected-main commit\n` +
    `\`${record.commit}\`. Workflow run \`${record.workflow_run_id}\`, attempt ${record.workflow_run_attempt},\n` +
    `successfully published that exact source as \`borgmcp@${record.version}\`; the same-run artifact report records integrity\n` +
    `\`${record.artifact_integrity}\`.\n` +
    'Never move, replace, reuse, or rerun that tag or workflow.'
  );
}

async function writeFixture(directory, path, value) {
  await mkdir(dirname(join(directory, path)), { recursive: true });
  await writeFile(join(directory, path), value);
}

function commitAll(directory, message) {
  git(directory, ['add', '.']);
  git(directory, ['commit', '-q', '-m', message]);
}

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}
