import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  buildReleaseTransform,
  classifyReleasePullRequest,
  prepareRelease,
  verifyReleaseIdentity,
} from '../scripts/release-identity.mjs';

const root = resolve(import.meta.dirname, '..');
const oldVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const newVersion = `${Number(oldVersion.split('.')[0]) + 1}.0.0`;
const integrity = `sha512-${'A'.repeat(86)}==`;
const allowlistPath = 'scripts/release-identity-allowlist.json';
const stablePath = 'scripts/local-dashboard-occurrences.json';
const releaseTestPath = 'test/release-lane.test.mjs';
const failedRunId = 30766475027;
const failedVerifyJobId = 91545993819;
const failedPublishJobId = 91546125556;

test('the classifier loads protected-base bytes and never executes candidate code', async () => {
  const workflow = await readFile(join(root, '.github', 'workflows', 'release-identity.yml'), 'utf8');
  const ordinaryCi = await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const releasing = await readFile(join(root, 'docs', 'RELEASING.md'), 'utf8');
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /fetch-tags: true/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /git fetch --no-tags origin "\$CANDIDATE_SHA"/);
  assert.match(workflow, /node scripts\/release-identity\.mjs classify/);
  assert.match(workflow, /--base "\$BASE_SHA"/);
  assert.match(workflow, /--candidate "\$CANDIDATE_SHA"/);
  assert.doesNotMatch(workflow, /\bnpm (?:ci|install|run)\b/u);
  assert.equal(workflow.match(/uses: actions\/checkout/gu)?.length, 1);
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.doesNotMatch(ordinaryCi, /verify:release-identity/);
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
  assert.ok((await readFile(join(root, releaseTestPath), 'utf8')).includes(
    `const CLIENT_VERSION = '${oldVersion}';`,
  ));
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
  const candidate = commitAll(fixture.root, 'prepare release');
  const verified = verifyReleaseIdentity(fixture.root, fixture.base, candidate, fixture.authorities);
  assert.equal(verified.oldVersion, oldVersion);
  assert.equal(verified.newVersion, newVersion);
  assert.equal(verified.candidate, candidate);
  assert.equal(verified.tree, git(fixture.root, ['rev-parse', 'HEAD^{tree}']));
  const extraction = await readFile(join(fixture.root, 'docs', 'EXTRACTION_PROVENANCE.md'), 'utf8');
  assert.match(extraction, new RegExp(
    'current release identity is `' + newVersion.replaceAll('.', '\\.') + '`',
  ));
  assert.match(extraction, new RegExp(
    'Client `borgmcp@' + oldVersion.replaceAll('.', '\\.') + '` is published\\.',
  ));
  assert.doesNotMatch(extraction, /next candidate identity/);
});

test('failed-superseded prep verifies the burned attempt and falls back to the last published anchor', async (t) => {
  const fixture = await createFixture(t, { failedSuperseded: true });
  const prepared = await prepareRelease(fixture.root, newVersion, fixture.evidence, fixture.authorities);
  assert.equal(prepared.record.outcome, 'failed-superseded');
  assert.equal(prepared.record.workflow_conclusion, 'failure');
  assert.equal(prepared.record.verify_job_id, failedVerifyJobId);
  assert.equal(prepared.record.publish_job_id, failedPublishJobId);
  assert.equal(prepared.record.artifact_integrity, null);
  assert.equal(prepared.provenanceAnchor.outcome, 'published');
  assert.equal(prepared.provenanceAnchor.version, fixture.anchorRecord.version);
  assert.deepEqual(new Set(fixture.artifactRequests), new Set([fixture.anchorRecord.version]));

  const releasing = await readFile(join(fixture.root, 'docs', 'RELEASING.md'), 'utf8');
  const extraction = await readFile(join(fixture.root, 'docs', 'EXTRACTION_PROVENANCE.md'), 'utf8');
  assert.match(releasing, /concluded `failure`/);
  assert.match(releasing, /FAILED-SUPERSEDED release record/);
  assert.match(releasing, /artifact build, verification, exercise, and upload steps as skipped/);
  assert.match(releasing, /no published npm artifact or SRI/);
  assert.match(extraction, new RegExp(
    'Client `borgmcp@' + fixture.anchorRecord.version.replaceAll('.', '\\.') + '` is published\\.',
  ));
  assert.doesNotMatch(extraction, new RegExp(
    'Client `borgmcp@' + oldVersion.replaceAll('.', '\\.') + '` is published\\.',
  ));
  assert.match(extraction, new RegExp(
    'current release identity is `' + newVersion.replaceAll('.', '\\.') + '`',
  ));

  const candidate = commitAll(fixture.root, 'prepare recovery release');
  const verified = verifyReleaseIdentity(fixture.root, fixture.base, candidate, fixture.authorities);
  assert.equal(verified.oldVersion, oldVersion);
  assert.equal(verified.newVersion, newVersion);
  assert.deepEqual(new Set(fixture.artifactRequests), new Set([fixture.anchorRecord.version]));
});

test('failed-superseded records reject reached artifact or publish phases', async (t) => {
  for (const [name, mutate] of [
    ['upload', (jobs) => {
      jobs.jobs[0].steps.find((step) => step.name === 'Upload same-run release artifact').conclusion = 'success';
    }],
    ['publish', (jobs) => {
      jobs.jobs[1].conclusion = 'success';
      jobs.jobs[1].steps = [{ name: 'Publish package', status: 'completed', conclusion: 'success' }];
    }],
  ]) {
    const fixture = await createFixture(t, { failedSuperseded: true });
    const jobs = fixture.authorities.githubRunJobs(fixture.root, failedRunId, 1);
    mutate(jobs);
    const authorities = { ...fixture.authorities, githubRunJobs: () => jobs };
    await assert.rejects(
      prepareRelease(fixture.root, newVersion, fixture.evidence, authorities),
      /pre-publication job evidence|step was not skipped/,
      `${name} phase must remain unreachable`,
    );
  }
});

test('failed-superseded records reject a version present in the npm registry', async (t) => {
  const fixture = await createFixture(t, { failedSuperseded: true });
  await assert.rejects(
    prepareRelease(fixture.root, newVersion, fixture.evidence, {
      ...fixture.authorities,
      publishedVersions: () => [fixture.anchorRecord.version, oldVersion],
    }),
    /version exists in the npm registry/,
  );
});

for (const [name, field] of [
  ['verify', 'verify_job_id'],
  ['publish', 'publish_job_id'],
]) {
  test(`failed-superseded records reject a false ${name} job identity`, async (t) => {
    const fixture = await createFixture(t, { failedSuperseded: true });
    const prepared = await prepareRelease(
      fixture.root,
      newVersion,
      fixture.evidence,
      fixture.authorities,
    );
    const path = join(fixture.root, 'docs', 'RELEASING.md');
    const falseRecord = { ...prepared.record, [field]: 999 };
    await writeFile(path, (await readFile(path, 'utf8')).replace(
      releaseParagraph(prepared.record),
      releaseParagraph(falseRecord),
    ));
    const candidate = commitAll(fixture.root, `mutate ${name} job id`);
    assert.throws(() => verifyReleaseIdentity(
      fixture.root,
      fixture.base,
      candidate,
      fixture.authorities,
    ), /pre-publication job evidence/);
  });
}

test('failed-superseded records reject an SRI and published records require one', async (t) => {
  const failed = await createFixture(t, { failedSuperseded: true });
  await assert.rejects(
    prepareRelease(failed.root, newVersion, {
      ...failed.evidence,
      artifactIntegrity: integrity,
    }, failed.authorities),
    /invalid or non-canonical shape/,
  );

  const published = await createFixture(t);
  await assert.rejects(
    prepareRelease(published.root, newVersion, {
      ...published.evidence,
      artifactIntegrity: undefined,
    }, published.authorities),
    /invalid or non-canonical shape/,
  );
});

test('failed-superseded records require an exact failed workflow authority', async (t) => {
  const fixture = await createFixture(t, { failedSuperseded: true });
  const githubRun = fixture.authorities.githubRun;
  const authorities = {
    ...fixture.authorities,
    githubRun: (fixtureRoot, runId, attempt) => ({
      ...githubRun(fixtureRoot, runId, attempt),
      conclusion: 'success',
    }),
  };
  await assert.rejects(
    prepareRelease(fixture.root, newVersion, fixture.evidence, authorities),
    /does not match the tag workflow authority/,
  );
});

test('release preparation rejects old false next-candidate ledger conventions', async (t) => {
  for (const [name, mutate] of [
    ['next candidate identity', (raw) => raw.replace(
      `current release identity is \`${oldVersion}\``,
      `so the next candidate identity is \`${oldVersion}\``,
    )],
    ['next candidate publication gate', (raw) => raw.replace(
      `current release identity and publication gate remain governed by the reviewed \`v${oldVersion}\` source`,
      `Publication of the next candidate remains gated by reviewed \`v${oldVersion}\` source`,
    )],
  ]) {
    const fixture = await createFixture(t);
    const baseFiles = await readTransformFiles(fixture.root);
    const prepared = await prepareRelease(fixture.root, newVersion, fixture.evidence, fixture.authorities);
    baseFiles.set('docs/EXTRACTION_PROVENANCE.md', mutate(
      baseFiles.get('docs/EXTRACTION_PROVENANCE.md'),
    ));

    assert.throws(
      () => buildReleaseTransform(baseFiles, oldVersion, newVersion, prepared.record),
      /expected current release ledger/,
      name,
    );
  }
});

test('published release preparation rejects an earlier published-version marker', async (t) => {
  const fixture = await createFixture(t);
  const baseFiles = await readTransformFiles(fixture.root);
  const prepared = await prepareRelease(fixture.root, newVersion, fixture.evidence, fixture.authorities);
  baseFiles.set('docs/EXTRACTION_PROVENANCE.md', baseFiles.get('docs/EXTRACTION_PROVENANCE.md').replace(
    `Client \`borgmcp@${oldVersion}\` is published.`,
    `Client \`borgmcp@${fixture.anchorRecord.version}\` is published.`,
  ));

  assert.throws(
    () => buildReleaseTransform(baseFiles, oldVersion, newVersion, prepared.record),
    /published release base must identify .* as current/,
  );
});

test('failed-superseded preparation rejects a non-earlier published anchor', async (t) => {
  const fixture = await createFixture(t, { failedSuperseded: true });
  const baseFiles = await readTransformFiles(fixture.root);
  const prepared = await prepareRelease(fixture.root, newVersion, fixture.evidence, fixture.authorities);
  baseFiles.set('docs/EXTRACTION_PROVENANCE.md', baseFiles.get('docs/EXTRACTION_PROVENANCE.md').replace(
    `Client \`borgmcp@${fixture.anchorRecord.version}\` is published.`,
    `Client \`borgmcp@${oldVersion}\` is published.`,
  ));

  assert.throws(
    () => buildReleaseTransform(baseFiles, oldVersion, newVersion, prepared.record),
    /earlier published provenance anchor/,
  );
});

test('trusted-base classification is green on the transform and red on a self-bypassing candidate', async (t) => {
  const fixture = await preparedFixture(t);
  git(fixture.root, ['checkout', '--detach', '-q', fixture.base]);
  assert.doesNotThrow(() => classifyReleasePullRequest(
    fixture.root,
    classificationInput(fixture, fixture.candidate),
    fixture.authorities,
  ));

  git(fixture.root, ['checkout', '--detach', '-q', fixture.candidate]);
  const manifestPath = join(fixture.root, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.scripts['verify:release-identity'] = 'node -e "process.exit(0)" --';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFixture(
    fixture.root,
    '.github/workflows/release-identity.yml',
    "name: bypass\njobs: { classify: { steps: [{ run: 'true' }] } }\n",
  );
  await writeFixture(fixture.root, 'scripts/release-identity.mjs', 'process.exit(0);\n');
  await writeFixture(fixture.root, 'src/unreviewed-payload.ts', 'export const unreviewed = true;\n');
  const attack = commitAll(fixture.root, 'replace classifier and add payload');

  git(fixture.root, ['checkout', '--detach', '-q', fixture.base]);
  assert.equal(git(fixture.root, ['status', '--porcelain']), '');
  assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), fixture.base);
  assert.throws(() => classifyReleasePullRequest(
    fixture.root,
    classificationInput(fixture, attack),
    fixture.authorities,
  ), /Release identity shape mismatch: package\.json/);
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
    const candidate = commitAll(fixture.root, `mutate ${name}`);
    assert.throws(() => verifyReleaseIdentity(
      fixture.root,
      fixture.base,
      candidate,
      fixture.authorities,
    ));
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
    const candidate = commitAll(fixture.root, `mutate ${name}`);
    assert.throws(() => verifyReleaseIdentity(
      fixture.root,
      fixture.base,
      candidate,
      fixture.authorities,
    ));
  });
}

async function preparedFixture(t) {
  const fixture = await createFixture(t);
  const prepared = await prepareRelease(fixture.root, newVersion, fixture.evidence, fixture.authorities);
  const candidate = commitAll(fixture.root, 'prepare release');
  assert.doesNotThrow(() => verifyReleaseIdentity(
    fixture.root,
    fixture.base,
    candidate,
    fixture.authorities,
  ));
  return { ...fixture, candidate, record: prepared.record };
}

async function createFixture(t, { failedSuperseded = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'borg-client-release-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.name', 'Release Test']);
  git(directory, ['config', 'user.email', 'release-test@example.invalid']);
  await writeFixture(directory, 'published-anchor.txt', 'published anchor\n');
  const anchorCommit = commitAll(directory, 'published anchor');
  const anchorVersion = '1.0.0';
  git(directory, ['tag', '-a', `v${anchorVersion}`, '-m', `release ${anchorVersion}`]);
  const anchorRecord = {
    outcome: 'published',
    version: anchorVersion,
    tag: `v${anchorVersion}`,
    tag_object: git(directory, ['rev-parse', `v${anchorVersion}^{tag}`]),
    commit: anchorCommit,
    workflow_run_id: 122,
    workflow_run_attempt: 1,
    workflow_conclusion: 'success',
    verify_job_id: null,
    publish_job_id: null,
    artifact_integrity: integrity,
  };
  await writeFixture(directory, allowlistPath, `${JSON.stringify({
    stablePaths: [stablePath],
    versionPins: [releaseTestPath],
  }, null, 2)}\n`);
  await writeFixture(directory, stablePath, '[]\n');
  await writeFixture(directory, 'package.json', `${JSON.stringify({
    name: 'borgmcp',
    version: oldVersion,
    private: false,
    scripts: { 'verify:release-identity': 'node scripts/release-identity.mjs verify' },
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
    `The current release identity is \`${oldVersion}\`.\n` +
    `Client \`borgmcp@${failedSuperseded ? anchorVersion : oldVersion}\` is published. The current release identity and publication gate remain governed by the reviewed \`v${oldVersion}\` source.\n`);
  await writeFixture(directory, 'docs/RELEASING.md',
    `# Releasing\n\n${releaseParagraph(anchorRecord)} The next candidate\n` +
    `uses the unused \`v${oldVersion}\` identity from a fresh reviewed protected-main commit\n` +
    `and requires the complete release gate again.\n`);
  await writeFixture(directory, releaseTestPath,
    `const CLIENT_VERSION = '${oldVersion}';\n` +
    `for (const evidence of [\n    'v${oldVersion}',\n  ]) assert.ok(evidence);\n`);
  await writeFixture(directory, '.github/workflows/release-identity.yml', '# trusted fixture workflow\n');
  await writeFixture(directory, 'scripts/release-identity.mjs', '// trusted fixture verifier\n');
  commitAll(directory, 'base');
  git(directory, ['tag', '-a', `v${oldVersion}`, '-m', `release ${oldVersion}`]);
  const base = git(directory, ['rev-parse', 'HEAD']);
  const evidence = failedSuperseded
    ? { workflowRunId: failedRunId, workflowRunAttempt: 1, workflowConclusion: 'failure' }
    : {
        workflowRunId: 123,
        workflowRunAttempt: 1,
        workflowConclusion: 'success',
        artifactIntegrity: integrity,
      };
  const artifactRequests = [];
  const authorities = {
    githubRun: (_root, runId) => ({
      id: runId,
      run_attempt: 1,
      head_sha: runId === 122 ? anchorCommit : base,
      head_branch: runId === 122 ? `v${anchorVersion}` : `v${oldVersion}`,
      event: 'push',
      status: 'completed',
      conclusion: runId === 122 || !failedSuperseded ? 'success' : 'failure',
      path: '.github/workflows/publish.yml',
    }),
    githubRunJobs: () => failedRunJobs(base),
    artifactIntegrity: (_root, version) => {
      artifactRequests.push(version);
      return integrity;
    },
    publishedVersions: () => [anchorVersion],
  };
  return {
    root: directory,
    base,
    evidence,
    authorities,
    anchorRecord,
    artifactRequests,
  };
}

function classificationInput(fixture, candidate) {
  return {
    base: fixture.base,
    candidate,
    repository: 'Byte-Ventures/borg-mcp-client',
    headRepository: 'Byte-Ventures/borg-mcp-client',
    headRef: `release/${newVersion}`,
  };
}

function releaseParagraph(record) {
  if (record.outcome === 'failed-superseded') {
    return (
      `FAILED-SUPERSEDED release record: The annotated \`${record.tag}\` tag object\n` +
      `\`${record.tag_object}\` peels to protected-main commit\n` +
      `\`${record.commit}\`. Workflow run \`${record.workflow_run_id}\`, attempt ${record.workflow_run_attempt}, concluded \`failure\`\n` +
      `during verification before artifact creation or publication. Verify job \`${record.verify_job_id}\` records the release\n` +
      `artifact build, verification, exercise, and upload steps as skipped; publish job \`${record.publish_job_id}\` was skipped.\n` +
      `Registry verification found no published \`borgmcp@${record.version}\` package, so no published npm artifact or SRI\n` +
      `exists for that version as of this check.\n` +
      'Never delete, move, replace, reuse, or rerun that tag, version, or workflow.'
    );
  }
  return (
    `The annotated \`${record.tag}\` tag object\n` +
    `\`${record.tag_object}\` peels to protected-main commit\n` +
    `\`${record.commit}\`. Workflow run \`${record.workflow_run_id}\`, attempt ${record.workflow_run_attempt},\n` +
    `successfully published that exact source as \`borgmcp@${record.version}\`; the same-run artifact report records integrity\n` +
    `\`${record.artifact_integrity}\`.\n` +
    'Never move, replace, reuse, or rerun that tag or workflow.'
  );
}

function failedRunJobs(commit) {
  return {
    total_count: 2,
    jobs: [
      {
        id: failedVerifyJobId,
        run_id: failedRunId,
        run_attempt: 1,
        head_sha: commit,
        name: 'verify',
        status: 'completed',
        conclusion: 'failure',
        steps: [
          { number: 14, name: 'Run tests', status: 'completed', conclusion: 'failure' },
          { number: 17, name: 'Build exact release tarball', status: 'completed', conclusion: 'skipped' },
          { number: 18, name: 'Verify exact release tarball', status: 'completed', conclusion: 'skipped' },
          { number: 19, name: 'Install and exercise the exact packed client', status: 'completed', conclusion: 'skipped' },
          { number: 20, name: 'Upload same-run release artifact', status: 'completed', conclusion: 'skipped' },
        ],
      },
      {
        id: failedPublishJobId,
        run_id: failedRunId,
        run_attempt: 1,
        head_sha: commit,
        name: 'publish',
        status: 'completed',
        conclusion: 'skipped',
        steps: [],
      },
    ],
  };
}

async function writeFixture(directory, path, value) {
  await mkdir(dirname(join(directory, path)), { recursive: true });
  await writeFile(join(directory, path), value);
}

async function readTransformFiles(directory) {
  const paths = [
    'package.json',
    'package-lock.json',
    'docs/EXTRACTION_PROVENANCE.md',
    'docs/RELEASING.md',
    releaseTestPath,
  ];
  return new Map(await Promise.all(paths.map(async (path) => [
    path,
    await readFile(join(directory, path), 'utf8'),
  ])));
}

function commitAll(directory, message) {
  git(directory, ['add', '.']);
  git(directory, ['commit', '-q', '-m', message]);
  return git(directory, ['rev-parse', 'HEAD']);
}

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}
