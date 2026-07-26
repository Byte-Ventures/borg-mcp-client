import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'borgmcp';
const REPOSITORY = 'Byte-Ventures/borg-mcp-client';
const WORKFLOW_PATH = '.github/workflows/publish.yml';
const ALLOWLIST_PATH = 'scripts/release-identity-allowlist.json';
const PACKAGE_PATH = 'package.json';
const LOCK_PATH = 'package-lock.json';
const EXTRACTION_PATH = 'docs/EXTRACTION_PROVENANCE.md';
const RELEASING_PATH = 'docs/RELEASING.md';
const RELEASE_TEST_PATH = 'test/release-lane.test.mjs';
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const sriPattern = /^sha512-[A-Za-z0-9+/]{86}==$/u;

function fail(message) {
  throw new Error(message);
}

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    input: options.input,
    maxBuffer: 10 * 1024 * 1024,
    stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function git(root, args, options = {}) {
  return command('git', args, { cwd: root, ...options });
}

function gitRaw(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJson(raw, description) {
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${description} is not valid JSON.`);
  }
}

function requireStableVersion(value, description) {
  if (!stableVersionPattern.test(value) ||
      value.split('.').some((part) => !Number.isSafeInteger(Number(part)))) {
    fail(`${description} must be a stable x.y.z version with safe integer components.`);
  }
  return value;
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function countLiteral(raw, literal) {
  return raw.split(literal).length - 1;
}

function decodeAllowlist(raw) {
  const parsed = parseJson(raw, ALLOWLIST_PATH);
  const decodePaths = (value, key) => {
    if (!Array.isArray(value) || value.length === 0 ||
        value.some((path) => typeof path !== 'string' || path.length === 0 ||
          path.startsWith('-') || path.startsWith('/') || path.includes('\\') ||
          !/^[A-Za-z0-9._@/-]+$/u.test(path) ||
          path.split('/').some((part) => part === '' || part === '.' || part === '..')) ||
        new Set(value).size !== value.length ||
        JSON.stringify([...value].sort()) !== JSON.stringify(value)) {
      fail(`${ALLOWLIST_PATH} must contain a unique, sorted, non-empty ${key} array.`);
    }
    return value;
  };
  const stablePaths = decodePaths(parsed?.stablePaths, 'stablePaths');
  const versionPins = decodePaths(parsed?.versionPins, 'versionPins');
  if (versionPins.length !== 1 || versionPins[0] !== RELEASE_TEST_PATH) {
    fail(`${ALLOWLIST_PATH} must name the release-lane version assertions exactly.`);
  }
  return { stablePaths, versionPins };
}

function decodeRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    fail('Release record is not an object.');
  }
  const decoded = {
    version: record.version,
    tag: record.tag,
    tag_object: record.tag_object,
    commit: record.commit,
    workflow_run_id: record.workflow_run_id,
    workflow_run_attempt: record.workflow_run_attempt,
    artifact_integrity: record.artifact_integrity,
  };
  if (typeof decoded.version !== 'string' ||
      !stableVersionPattern.test(decoded.version) ||
      decoded.version.split('.').some((part) => !Number.isSafeInteger(Number(part))) ||
      decoded.tag !== `v${decoded.version}` ||
      !shaPattern.test(decoded.tag_object) ||
      !shaPattern.test(decoded.commit) ||
      !Number.isSafeInteger(decoded.workflow_run_id) || decoded.workflow_run_id <= 0 ||
      !Number.isSafeInteger(decoded.workflow_run_attempt) || decoded.workflow_run_attempt <= 0 ||
      !sriPattern.test(decoded.artifact_integrity) ||
      JSON.stringify(Object.keys(record)) !== JSON.stringify(Object.keys(decoded))) {
    fail('Release record has an invalid or non-canonical shape.');
  }
  return Object.freeze(decoded);
}

export function deriveGitProvenance(root, version) {
  const tag = `v${requireStableVersion(version, 'Released version')}`;
  const ref = `refs/tags/${tag}`;
  let type;
  try {
    type = git(root, ['cat-file', '-t', ref]);
  } catch {
    fail(`Annotated release tag is missing: ${tag}`);
  }
  if (type !== 'tag') fail(`Release tag is not annotated: ${tag}`);
  return Object.freeze({
    version,
    tag,
    tag_object: git(root, ['rev-parse', `${ref}^{tag}`]),
    commit: git(root, ['rev-parse', `${ref}^{commit}`]),
  });
}

export const systemAuthorities = Object.freeze({
  githubRun(root, runId, attempt) {
    const response = command('gh', [
      'api',
      `repos/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`,
    ], { cwd: root });
    return parseJson(response, 'GitHub Actions run');
  },
  artifactIntegrity(root, version) {
    const response = command('npm', [
      'view',
      `${PACKAGE_NAME}@${version}`,
      'dist.integrity',
      '--json',
      '--registry=https://registry.npmjs.org',
    ], { cwd: root });
    return parseJson(response, 'npm artifact integrity');
  },
});

export function verifyReleaseProvenance(root, recordInput, authorities = systemAuthorities) {
  const record = decodeRecord(recordInput);
  const provenance = deriveGitProvenance(root, record.version);
  for (const field of ['tag', 'tag_object', 'commit']) {
    if (record[field] !== provenance[field]) {
      fail(`Release record ${field} does not match the annotated tag authority.`);
    }
  }
  const run = authorities.githubRun(root, record.workflow_run_id, record.workflow_run_attempt);
  if (run.id !== record.workflow_run_id ||
      run.run_attempt !== record.workflow_run_attempt ||
      run.head_sha !== record.commit ||
      run.head_branch !== record.tag ||
      run.event !== 'push' ||
      run.status !== 'completed' ||
      run.conclusion !== 'success' ||
      run.path !== WORKFLOW_PATH) {
    fail('Release record does not match the successful tag workflow authority.');
  }
  if (authorities.artifactIntegrity(root, record.version) !== record.artifact_integrity) {
    fail('Release record integrity does not match the npm artifact authority.');
  }
  return record;
}

export function createReleaseRecord(root, input, authorities = systemAuthorities) {
  const provenance = deriveGitProvenance(root, input.version);
  return verifyReleaseProvenance(root, {
    ...provenance,
    workflow_run_id: input.workflowRunId,
    workflow_run_attempt: input.workflowRunAttempt,
    artifact_integrity: input.artifactIntegrity,
  }, authorities);
}

function transformPackage(raw, oldVersion, newVersion) {
  const manifest = parseJson(raw, PACKAGE_PATH);
  if (manifest.name !== PACKAGE_NAME || manifest.version !== oldVersion) {
    fail(`${PACKAGE_PATH} does not have the expected package identity.`);
  }
  manifest.version = newVersion;
  return canonicalJson(manifest);
}

function transformLock(raw, oldVersion, newVersion) {
  const lock = parseJson(raw, LOCK_PATH);
  if (lock.name !== PACKAGE_NAME || lock.version !== oldVersion ||
      lock.packages?.['']?.name !== PACKAGE_NAME ||
      lock.packages?.['']?.version !== oldVersion) {
    fail(`${LOCK_PATH} does not have the expected root identity.`);
  }
  lock.version = newVersion;
  lock.packages[''].version = newVersion;
  return canonicalJson(lock);
}

function transformExtraction(raw, oldVersion, newVersion) {
  const candidate = `so the next candidate identity is \`${oldVersion}\``;
  const published = `and \`${oldVersion}\` was subsequently published, so the next candidate identity is \`${newVersion}\``;
  const currentPublished = /Client `borgmcp@\d+\.\d+\.\d+` is published\./gu;
  const currentGate = `reviewed \`v${oldVersion}\` source`;
  if (countLiteral(raw, candidate) !== 1 ||
      [...raw.matchAll(currentPublished)].length !== 1 ||
      countLiteral(raw, currentGate) !== 1) {
    fail(`${EXTRACTION_PATH} does not contain the expected current release ledger.`);
  }
  return raw
    .replace(candidate, published)
    .replace(currentPublished, `Client \`borgmcp@${oldVersion}\` is published.`)
    .replace(currentGate, `reviewed \`v${newVersion}\` source`);
}

function releaseParagraph(record) {
  return (
    `The annotated \`${record.tag}\` tag object\n` +
    `\`${record.tag_object}\` peels to protected-main commit\n` +
    `\`${record.commit}\`. Workflow run \`${record.workflow_run_id}\`, attempt ${record.workflow_run_attempt},\n` +
    `successfully published that exact source as \`${PACKAGE_NAME}@${record.version}\`; the same-run artifact report records integrity\n` +
    `\`${record.artifact_integrity}\`.\n` +
    `Never move, replace, reuse, or rerun that tag or workflow.`
  );
}

function transformReleasing(raw, oldVersion, newVersion, record) {
  const marker = (
    `The next candidate\n` +
    `uses the unused \`v${oldVersion}\` identity from a fresh reviewed protected-main commit\n` +
    `and requires the complete release gate again.`
  );
  if (countLiteral(raw, marker) !== 1 || raw.includes(`The annotated \`v${oldVersion}\` tag object`)) {
    fail(`${RELEASING_PATH} does not contain exactly one unused current candidate.`);
  }
  return raw.replace(
    marker,
    `${releaseParagraph(record)} The next candidate\n` +
      `uses the unused \`v${newVersion}\` identity from a fresh reviewed protected-main commit\n` +
      `and requires the complete release gate again.`,
  );
}

function transformReleaseTest(raw, oldVersion, newVersion, record) {
  const constant = `const CLIENT_VERSION = '${oldVersion}';`;
  const evidenceTail = `    'v${oldVersion}',\n  ])`;
  if (countLiteral(raw, constant) !== 1 || countLiteral(raw, evidenceTail) !== 1) {
    fail(`${RELEASE_TEST_PATH} does not contain the expected current version/evidence assertions.`);
  }
  return raw
    .replace(constant, `const CLIENT_VERSION = '${newVersion}';`)
    .replace(
      evidenceTail,
      `    'v${oldVersion}',\n` +
        `    '${record.tag_object}',\n` +
        `    '${record.commit}',\n` +
        `    '${record.workflow_run_id}',\n` +
        `    '${record.artifact_integrity}',\n` +
        `    'v${newVersion}',\n  ])`,
    );
}

function requireFile(files, path) {
  const raw = files.get(path);
  if (raw === undefined) fail(`Missing release identity file: ${path}`);
  return raw;
}

export function buildReleaseTransform(baseFiles, oldVersion, newVersion, recordInput) {
  requireStableVersion(oldVersion, 'Base version');
  requireStableVersion(newVersion, 'Target version');
  if (compareVersions(newVersion, oldVersion) <= 0) {
    fail(`Target version ${newVersion} must be newer than ${oldVersion}.`);
  }
  const record = decodeRecord(recordInput);
  if (record.version !== oldVersion) fail('Release record does not describe the base version.');
  return new Map([
    [PACKAGE_PATH, transformPackage(requireFile(baseFiles, PACKAGE_PATH), oldVersion, newVersion)],
    [LOCK_PATH, transformLock(requireFile(baseFiles, LOCK_PATH), oldVersion, newVersion)],
    [EXTRACTION_PATH, transformExtraction(requireFile(baseFiles, EXTRACTION_PATH), oldVersion, newVersion)],
    [RELEASING_PATH, transformReleasing(requireFile(baseFiles, RELEASING_PATH), oldVersion, newVersion, record)],
    [RELEASE_TEST_PATH, transformReleaseTest(requireFile(baseFiles, RELEASE_TEST_PATH), oldVersion, newVersion, record)],
  ]);
}

function transformPaths() {
  return [PACKAGE_PATH, LOCK_PATH, EXTRACTION_PATH, RELEASING_PATH, RELEASE_TEST_PATH].sort();
}

function allPaths(allowlistRaw) {
  const allowlist = decodeAllowlist(allowlistRaw);
  return [...new Set([ALLOWLIST_PATH, ...transformPaths(), ...allowlist.stablePaths])].sort();
}

async function readWorkingFiles(root) {
  const allowlistRaw = await readFile(join(root, ALLOWLIST_PATH), 'utf8');
  const files = new Map([[ALLOWLIST_PATH, allowlistRaw]]);
  await Promise.all(allPaths(allowlistRaw).map(async (path) => {
    files.set(path, await readFile(join(root, path), 'utf8'));
  }));
  return files;
}

function readRefFiles(root, ref) {
  const allowlistRaw = gitRaw(root, ['show', `${ref}:${ALLOWLIST_PATH}`]);
  const files = new Map([[ALLOWLIST_PATH, allowlistRaw]]);
  for (const path of allPaths(allowlistRaw)) files.set(path, gitRaw(root, ['show', `${ref}:${path}`]));
  return files;
}

function readVersion(files) {
  const manifest = parseJson(requireFile(files, PACKAGE_PATH), PACKAGE_PATH);
  if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== 'string') {
    fail(`${PACKAGE_PATH} has an invalid package identity.`);
  }
  return requireStableVersion(manifest.version, 'Package version');
}

function extractReleaseRecord(raw, version) {
  const escaped = version.replaceAll('.', '\\.');
  const tick = '`';
  const pattern = new RegExp(
    `The annotated ${tick}v${escaped}${tick} tag object\\n` +
      `${tick}([0-9a-f]{40})${tick} peels to protected-main commit\\n` +
      `${tick}([0-9a-f]{40})${tick}\\. Workflow run ${tick}([0-9]+)${tick}, attempt ([0-9]+),\\n` +
      `successfully published that exact source as ${tick}${PACKAGE_NAME}@${escaped}${tick}; the same-run artifact report records integrity\\n` +
      `${tick}(sha512-[A-Za-z0-9+/]{86}==)${tick}\\.`,
    'u',
  );
  const matches = [...raw.matchAll(new RegExp(pattern.source, 'gu'))];
  if (matches.length !== 1) fail(`${RELEASING_PATH} must contain one canonical record for ${version}.`);
  const [, tagObject, commit, runId, attempt, integrity] = matches[0];
  return decodeRecord({
    version,
    tag: `v${version}`,
    tag_object: tagObject,
    commit,
    workflow_run_id: Number(runId),
    workflow_run_attempt: Number(attempt),
    artifact_integrity: integrity,
  });
}

function verifyIndependentShapes(baseFiles, candidateFiles, oldVersion, newVersion, record) {
  const transformed = buildReleaseTransform(baseFiles, oldVersion, newVersion, record);
  for (const [path, expected] of transformed) {
    if (requireFile(candidateFiles, path) !== expected) {
      fail(`Release identity shape mismatch: ${path}`);
    }
  }
  const baseAllowlist = requireFile(baseFiles, ALLOWLIST_PATH);
  if (requireFile(candidateFiles, ALLOWLIST_PATH) !== baseAllowlist) {
    fail('Release identity allowlist changed.');
  }
  for (const path of decodeAllowlist(baseAllowlist).stablePaths) {
    if (requireFile(candidateFiles, path) !== requireFile(baseFiles, path)) {
      fail(`Release identity requires a byte-stable generated file: ${path}`);
    }
  }
}

export async function prepareRelease(root, targetVersion, evidence, authorities = systemAuthorities) {
  if (git(root, ['status', '--porcelain']) !== '') fail('release:prepare requires a clean working tree.');
  const baseFiles = await readWorkingFiles(root);
  const oldVersion = readVersion(baseFiles);
  const record = createReleaseRecord(root, {
    version: oldVersion,
    workflowRunId: evidence.workflowRunId,
    workflowRunAttempt: evidence.workflowRunAttempt,
    artifactIntegrity: evidence.artifactIntegrity,
  }, authorities);
  try {
    git(root, ['merge-base', '--is-ancestor', record.commit, 'HEAD']);
  } catch {
    fail('Released commit is not an ancestor of the preparation base.');
  }
  const transformed = buildReleaseTransform(baseFiles, oldVersion, targetVersion, record);
  await Promise.all([...transformed].map(([path, raw]) => writeFile(join(root, path), raw)));
  return Object.freeze({
    oldVersion,
    newVersion: targetVersion,
    record,
    paths: Object.freeze([...transformed.keys()].sort()),
  });
}

function expectedTree(root, base, transformed) {
  const directory = mkdtempSync(join(tmpdir(), 'borg-client-release-index-'));
  const indexPath = join(directory, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    git(root, ['read-tree', `${base}^{tree}`], { env });
    for (const [path, raw] of transformed) {
      const blob = git(root, ['hash-object', '-w', '--stdin'], { input: raw });
      const line = git(root, ['ls-tree', base, '--', path]);
      if (line === '') fail(`Release transform path is absent from its base: ${path}`);
      const mode = line.slice(0, line.indexOf(' '));
      git(root, ['update-index', '--cacheinfo', mode, blob, path], { env });
    }
    return git(root, ['write-tree'], { env });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function verifyReleaseIdentity(root, baseInput, authorities = systemAuthorities) {
  const base = git(root, ['rev-parse', '--verify', '--end-of-options', `${baseInput}^{commit}`]);
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (git(root, ['status', '--porcelain']) !== '') fail('verify:release-identity requires a clean working tree.');
  try {
    git(root, ['merge-base', '--is-ancestor', base, head]);
  } catch {
    fail('Release identity base must be an ancestor of HEAD.');
  }
  const baseFiles = readRefFiles(root, base);
  const candidateFiles = readRefFiles(root, head);
  const oldVersion = readVersion(baseFiles);
  const newVersion = readVersion(candidateFiles);
  const record = verifyReleaseProvenance(
    root,
    extractReleaseRecord(requireFile(candidateFiles, RELEASING_PATH), oldVersion),
    authorities,
  );
  try {
    git(root, ['merge-base', '--is-ancestor', record.commit, base]);
  } catch {
    fail('Recorded release commit is not an ancestor of the release identity base.');
  }
  verifyIndependentShapes(baseFiles, candidateFiles, oldVersion, newVersion, record);
  const transformed = buildReleaseTransform(baseFiles, oldVersion, newVersion, record);
  const changed = git(root, ['diff', '--name-only', base, head]).split('\n').filter(Boolean).sort();
  const expectedPaths = [...transformed.keys()].sort();
  if (JSON.stringify(changed) !== JSON.stringify(expectedPaths)) {
    fail('Release identity changed files outside the generated transform.');
  }
  const generatedTree = expectedTree(root, base, transformed);
  const candidateTree = git(root, ['rev-parse', `${head}^{tree}`]);
  if (candidateTree !== generatedTree) fail('Candidate tree is not the deterministic release transform.');
  return Object.freeze({
    base,
    head,
    tree: candidateTree,
    oldVersion,
    newVersion,
    paths: Object.freeze(expectedPaths),
  });
}

function parsePrepareArguments(args, environment) {
  const [version, ...flags] = args;
  if (version === undefined) {
    fail('Usage: release:prepare <version> --workflow-run-id <id> --workflow-run-attempt <n> --artifact-integrity <sha512-SRI>');
  }
  const values = new Map();
  const accepted = new Set(['--workflow-run-id', '--workflow-run-attempt', '--artifact-integrity']);
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (!accepted.has(flag) || value === undefined || values.has(flag)) {
      fail(`Invalid release:prepare flag: ${flag}`);
    }
    values.set(flag, value);
  }
  const workflowRunId = Number(values.get('--workflow-run-id') ?? environment.RELEASE_WORKFLOW_RUN_ID);
  const workflowRunAttempt = Number(
    values.get('--workflow-run-attempt') ?? environment.RELEASE_WORKFLOW_RUN_ATTEMPT,
  );
  const artifactIntegrity = values.get('--artifact-integrity') ?? environment.RELEASE_ARTIFACT_INTEGRITY;
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0 ||
      !Number.isSafeInteger(workflowRunAttempt) || workflowRunAttempt <= 0 ||
      typeof artifactIntegrity !== 'string' || !sriPattern.test(artifactIntegrity)) {
    fail('release:prepare requires a positive run id/attempt and canonical SHA-512 SRI.');
  }
  return { version, evidence: { workflowRunId, workflowRunAttempt, artifactIntegrity } };
}

function parseVerifyArguments(args) {
  if (args.length !== 2 || args[0] !== '--base' || args[1] === undefined) {
    fail('Usage: verify:release-identity --base <sha>');
  }
  return args[1];
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  const root = process.cwd();
  if (operation === 'prepare') {
    const parsed = parsePrepareArguments(args, process.env);
    console.log(JSON.stringify(await prepareRelease(root, parsed.version, parsed.evidence), null, 2));
    return;
  }
  if (operation === 'verify') {
    console.log(JSON.stringify(verifyReleaseIdentity(root, parseVerifyArguments(args)), null, 2));
    return;
  }
  fail('Usage: release-identity.mjs <prepare|verify> ...');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
