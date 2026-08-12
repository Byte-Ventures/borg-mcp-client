import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPostpublish } from './verify-registry-release.mjs';

const OWNER = 'Byte-Ventures';
const REPOSITORY = 'borg-mcp-client';
const PACKAGE_NAME = 'borgmcp';
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function ghJson(path) {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
}

function defaultReleaseAbsent(path) {
  const result = spawnSync('gh', ['api', path], { encoding: 'utf8' });
  if (result.status === 0) throw new Error('GitHub Release already exists for this immutable tag.');
  if (!/HTTP 404|Not Found/u.test(result.stderr)) {
    throw new Error(`GitHub Release lookup failed: ${result.stderr.trim()}`);
  }
}

function defaultCreateRelease(path, body) {
  execFileSync('gh', ['api', path, '--method', 'POST', '--input', '-'], {
    input: JSON.stringify(body),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

export function assertReleasePullRequest(pullRequests, { version, commit, mergeSubject }) {
  if (!Array.isArray(pullRequests) || pullRequests.length !== 1) {
    throw new Error('Release commit must resolve to exactly one pull request.');
  }
  const pullRequest = pullRequests[0];
  if (pullRequest.state !== 'closed' || typeof pullRequest.merged_at !== 'string') {
    throw new Error('Release pull request must be closed and merged.');
  }
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1 ||
      typeof pullRequest.html_url !== 'string' || typeof pullRequest.body !== 'string') {
    throw new Error('Release pull request identity and body must be complete.');
  }
  if (pullRequest.base?.ref !== 'main') {
    throw new Error('Release pull request base must be main.');
  }
  const expectedHead = `release/${version}`;
  if (pullRequest.head?.ref !== expectedHead) {
    throw new Error(`Release pull request head must be release/${version}.`);
  }
  if (pullRequest.merge_commit_sha !== commit) {
    throw new Error('Release pull request merge commit must equal the tagged commit.');
  }
  const subjectMatch = /^Merge pull request #(\d+) from (.+)$/u.exec(mergeSubject);
  if (!subjectMatch || Number(subjectMatch[1]) !== pullRequest.number ||
      !subjectMatch[2].endsWith(`/${expectedHead}`)) {
    throw new Error('Tagged commit subject must identify the same release pull request.');
  }
  return pullRequest;
}

export function assembleReleaseBody({ version, integrity, tag, commit, pullRequest }) {
  const repositoryUrl = `https://github.com/${OWNER}/${REPOSITORY}`;
  return [
    '## Package',
    '',
    `- npm: [${PACKAGE_NAME}@${version}](https://www.npmjs.com/package/${PACKAGE_NAME}/v/${version})`,
    `- Integrity: \`${integrity}\``,
    '- Published with npm Trusted Publishing.',
    '',
    '## Source',
    '',
    `- Tag: [${tag}](${repositoryUrl}/releases/tag/${tag})`,
    `- Commit: [\`${commit}\`](${repositoryUrl}/commit/${commit})`,
    `- Release PR: [#${pullRequest.number}](${pullRequest.html_url})`,
    '',
    '## Release PR body (as merged)',
    '',
    pullRequest.body ?? '',
  ].join('\n');
}

export async function createGithubRelease(version, deps = {}) {
  if (!VERSION_RE.test(version ?? '')) throw new Error('Version must be an exact stable semantic version.');
  if (!process.env.GITHUB_TOKEN && !deps.allowMissingToken) {
    throw new Error('GITHUB_TOKEN is required; use the documented gh auth token invocation.');
  }
  const tag = `v${version}`;
  const runGit = deps.git ?? git;
  const api = deps.ghJson ?? ghJson;
  const releaseAbsent = deps.releaseAbsent ?? defaultReleaseAbsent;
  const createRelease = deps.createRelease ?? defaultCreateRelease;
  const verifyLive = deps.verifyPostpublish ?? verifyPostpublish;
  const downloadArtifact = deps.downloadArtifact ?? ((runId, directory) => {
    execFileSync('gh', [
      'run', 'download', String(runId), '--repo', `${OWNER}/${REPOSITORY}`,
      '--name', `npm-release-${version}`, '--dir', directory,
    ], { stdio: 'inherit' });
  });

  if (runGit(['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') {
    throw new Error(`${tag} must be an annotated tag.`);
  }
  const commit = runGit(['rev-parse', `${tag}^{commit}`]);
  const tagMessage = runGit(['for-each-ref', `refs/tags/${tag}`, '--format=%(contents:subject)']);
  if (!tagMessage) throw new Error('Annotated release tag must have a message.');
  const mergeSubject = runGit(['show', '-s', '--format=%s', commit]);
  const pullRequests = api(`repos/${OWNER}/${REPOSITORY}/commits/${commit}/pulls`);
  const pullRequest = assertReleasePullRequest(pullRequests, { version, commit, mergeSubject });

  const runs = api(
    `repos/${OWNER}/${REPOSITORY}/actions/workflows/publish.yml/runs?event=push&branch=${encodeURIComponent(tag)}&per_page=100`,
  ).workflow_runs ?? [];
  const matchingRuns = runs.filter((run) =>
    run.run_attempt === 1 && run.status === 'completed' && run.conclusion === 'success' &&
    run.head_sha === commit && run.head_branch === tag && run.event === 'push');
  if (matchingRuns.length !== 1) {
    throw new Error('Tagged commit must have exactly one successful attempt-1 publish workflow run.');
  }

  const temporary = await mkdtemp(join(tmpdir(), 'borgmcp-github-release-'));
  try {
    await downloadArtifact(matchingRuns[0].id, temporary);
    const report = JSON.parse(await readFile(join(temporary, 'artifact-report.json'), 'utf8'));
    const live = await verifyLive(report, { expectedVersion: version });
    releaseAbsent(`repos/${OWNER}/${REPOSITORY}/releases/tags/${tag}`);
    const body = assembleReleaseBody({
      version,
      integrity: live.integrity,
      tag,
      commit,
      pullRequest,
    });
    createRelease(`repos/${OWNER}/${REPOSITORY}/releases`, {
      tag_name: tag,
      name: tagMessage,
      make_latest: 'true',
      body,
    });
    return { tag, commit, pullRequest: pullRequest.number, integrity: live.integrity };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [version, ...extra] = process.argv.slice(2);
  if (!version || extra.length > 0) {
    throw new Error('Usage: node scripts/create-github-release.mjs <version>');
  }
  console.log(JSON.stringify(await createGithubRelease(version), null, 2));
}
