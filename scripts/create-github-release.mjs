import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArtifactReport } from './verify-registry-release.mjs';

const OWNER = 'Byte-Ventures';
const REPOSITORY = 'borg-mcp-client';
const PACKAGE_NAME = 'borgmcp';
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function defaultLivePackage(version) {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/${version}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Published version verification returned HTTP ${response.status}.`);
  const published = await response.json();
  return verifyArtifactReport({
    name: published.name,
    version: published.version,
    integrity: published.dist?.integrity,
  }, version);
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

export function assembleReleaseBody({ version, integrity, tag, commit, releaseNotes }) {
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
    '## News and fixes',
    '',
    releaseNotes,
  ].join('\n');
}

export async function createGithubRelease(version, deps = {}) {
  if (!VERSION_RE.test(version ?? '')) throw new Error('Version must be an exact stable semantic version.');
  if (!process.env.GITHUB_TOKEN && !deps.allowMissingToken) {
    throw new Error('GITHUB_TOKEN is required; use the documented gh auth token invocation.');
  }
  const tag = `v${version}`;
  const runGit = deps.git ?? git;
  const releaseAbsent = deps.releaseAbsent ?? defaultReleaseAbsent;
  const createRelease = deps.createRelease ?? defaultCreateRelease;
  const livePackage = deps.livePackage ?? defaultLivePackage;

  if (runGit(['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') {
    throw new Error(`${tag} must be an annotated tag.`);
  }
  const commit = runGit(['rev-parse', `${tag}^{commit}`]);
  const tagMessage = runGit(['for-each-ref', `refs/tags/${tag}`, '--format=%(contents:subject)']);
  if (!tagMessage) throw new Error('Annotated release tag must have a message.');
  let releaseNotes;
  try {
    releaseNotes = runGit(['show', `${commit}:docs/releases/${version}.md`]);
  } catch {
    throw new Error(`Tagged commit must contain docs/releases/${version}.md.`);
  }
  if (!releaseNotes.trim()) throw new Error('Tagged release notes must not be blank.');
  const live = verifyArtifactReport(await livePackage(version), version);
  releaseAbsent(`repos/${OWNER}/${REPOSITORY}/releases/tags/${tag}`);
  const body = assembleReleaseBody({ version, integrity: live.integrity, tag, commit, releaseNotes });
  createRelease(`repos/${OWNER}/${REPOSITORY}/releases`, {
    tag_name: tag,
    name: tagMessage,
    make_latest: 'true',
    body,
  });
  return { tag, commit, integrity: live.integrity };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [version, ...extra] = process.argv.slice(2);
  if (!version || extra.length > 0) {
    throw new Error('Usage: node scripts/create-github-release.mjs <version>');
  }
  console.log(JSON.stringify(await createGithubRelease(version), null, 2));
}
