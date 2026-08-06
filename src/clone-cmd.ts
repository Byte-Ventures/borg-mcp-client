/**
 * `borg clone <repo-url>` — clone a repository, create a safe sibling
 * worktree, and optionally launch Borg there.
 *
 * This command deliberately stops at a ready worktree. It does not
 * assimilate, create a seat, contact a cube, or persist Borg metadata. Git's
 * own repository metadata is the only durable state it creates.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCloneCredentials, redactCloneSecrets } from './clone-security.js';
import { shellEscape } from './shell-escape.js';
import { validateName } from './name-validator.js';
import type { CloneArgs } from './parse-clone-args.js';

export { redactCloneSecrets } from './clone-security.js';

export interface GitRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CloneDeps {
  runSync?: (cmd: string, args: string[], cwd?: string) => GitRunResult;
  cwd?: () => string;
  pathExists?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
  readDirectory?: (path: string) => string[];
  removeTree?: (path: string) => void;
  mkdirp?: (path: string) => void;
  launch?: (cwd: string) => Promise<number>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const URL_SCHEMES = new Set(['file:', 'git:', 'git+ssh:', 'http:', 'https:', 'ssh:']);
const SCP_REMOTE_RE = /^[^@\s/:]+@[^:\s]+:[^\s]+$/;

function defaultRunSync(cmd: string, args: string[], cwd?: string): GitRunResult {
  try {
    const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (error) {
    return {
      status: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function defaultLaunch(cwd: string): Promise<number> {
  // When installed, argv[1] is the package's claude.js bin. Re-entering it
  // without a subcommand gives the user the normal configured-agent launch
  // flow. The override is useful for package managers that hide argv[1].
  const command = process.env.BORG_BIN ?? process.argv[1] ?? fileURLToPath(import.meta.url);
  return new Promise((resolveExit) => {
    let child;
    try {
      child = spawn(command, [], { cwd, stdio: 'inherit', env: process.env });
    } catch {
      resolveExit(1);
      return;
    }
    child.once('error', () => resolveExit(1));
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

const defaultDeps: Required<CloneDeps> = {
  runSync: defaultRunSync,
  cwd: () => process.cwd(),
  pathExists: existsSync,
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  readDirectory: (path) => readdirSync(path),
  removeTree: (path) => rmSync(path, { recursive: true, force: true }),
  mkdirp: (path) => mkdirSync(path, { recursive: true }),
  launch: defaultLaunch,
  stdout: (line) => process.stdout.write(line),
  stderr: (line) => process.stderr.write(line),
};

function withDefaults(deps: CloneDeps): Required<CloneDeps> {
  const base = { ...defaultDeps, ...deps };
  return {
    ...base,
    runSync: (cmd, args, cwd) => base.runSync(cmd, args.map(redactCloneSecrets), cwd),
    stdout: (line) => base.stdout(redactCloneSecrets(line)),
    stderr: (line) => base.stderr(redactCloneSecrets(line)),
  };
}

function hasUrlCredentials(value: string): boolean {
  if (hasCloneCredentials(value)) return true;
  try {
    const parsed = new URL(value);
    // An SSH login name (`ssh://git@host/...`) is transport identity, not a
    // password/token. HTTPS and the other URL transports treat userinfo as a
    // credential-bearing URL and fail closed.
    if (parsed.protocol === 'ssh:' || parsed.protocol === 'git+ssh:') {
      return parsed.password.length > 0;
    }
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return hasCloneCredentials(value);
  }
}

function isRemoteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('file:');
}

/** Validate a clone source before it reaches Git's argv or any output. */
export function validateCloneRepositoryUrl(value: string): { ok: true } | { ok: false; error: string } {
  if (value.length === 0) return { ok: false, error: 'repository URL must not be empty' };
  if (value.trim() !== value || CONTROL_RE.test(value)) {
    return { ok: false, error: 'repository URL contains whitespace or control characters' };
  }
  if (value.startsWith('-')) return { ok: false, error: 'repository URL must not start with a hyphen' };
  if (hasUrlCredentials(value)) {
    return {
      ok: false,
      error: 'credential-bearing repository URLs are not accepted; use a credential helper or SSH configuration instead',
    };
  }
  if (isRemoteUrl(value)) {
    try {
      const parsed = new URL(value);
      if (!URL_SCHEMES.has(parsed.protocol)) {
        return { ok: false, error: `unsupported repository URL scheme ${parsed.protocol}` };
      }
      if (parsed.protocol !== 'file:' && parsed.hostname.length === 0) {
        return { ok: false, error: 'repository URL must include a host' };
      }
      if (parsed.pathname.length === 0 || parsed.pathname === '/') {
        return { ok: false, error: 'repository URL must include a repository path' };
      }
      if (parsed.search.length > 0 || parsed.hash.length > 0) {
        return { ok: false, error: 'repository URLs must not contain query or fragment data' };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'repository URL is not valid' };
    }
  }
  if (SCP_REMOTE_RE.test(value)) return { ok: true };
  // Local paths are accepted so offline repositories and the executable
  // fixture path can use the same command. They cannot carry URL userinfo.
  return { ok: true };
}

function remoteHasCredentials(value: string): boolean {
  if (hasUrlCredentials(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.search.length > 0 || parsed.hash.length > 0;
  } catch {
    return hasCloneCredentials(value);
  }
}

function trimGitSuffix(value: string): string {
  return value.replace(/\/+$/, '').replace(/\.git$/i, '');
}

function remoteKey(value: string, baseDir: string): string {
  if (SCP_REMOTE_RE.test(value)) {
    const separator = value.indexOf(':');
    const login = value.slice(0, separator);
    const host = login.slice(login.lastIndexOf('@') + 1).toLowerCase();
    const user = login.includes('@') ? login.slice(0, login.lastIndexOf('@')) : '';
    const path = trimGitSuffix(value.slice(separator + 1)).replace(/^\/+/, '');
    return `ssh://${user ? `${user}@` : ''}${host}/${path}`;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'file:') return `file:${resolve(fileURLToPath(parsed))}`;
    const user = parsed.username.length > 0 ? `${parsed.username}@` : '';
    const port = parsed.port.length > 0 ? `:${parsed.port}` : '';
    const path = trimGitSuffix(parsed.pathname);
    return `${parsed.protocol}//${user}${parsed.hostname.toLowerCase()}${port}${path}`;
  } catch {
    const path = resolve(baseDir, value);
    try {
      return `file:${realpathSync(path)}`;
    } catch {
      return `file:${path}`;
    }
  }
}

function sourceDisplayName(value: string): string {
  let leaf = value;
  try {
    leaf = new URL(value).pathname;
  } catch {
    if (SCP_REMOTE_RE.test(value)) leaf = value.slice(value.indexOf(':') + 1);
  }
  leaf = basename(leaf.replace(/\/+$/, '')).replace(/\.git$/i, '');
  const safe = leaf.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'repository';
}

function defaultWorktreeName(repoName: string): string {
  const base = `${repoName}-worktree`;
  return base.length <= 48 ? base : base.slice(0, 48);
}

function nameWithCollision(base: string, n: number): string {
  if (n === 1) return base;
  const suffix = `-${n}`;
  return `${base.slice(0, Math.max(1, 48 - suffix.length))}${suffix}`;
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function isEmptyDirectory(deps: Required<CloneDeps>, path: string): boolean {
  return deps.isDirectory(path) && deps.readDirectory(path).length === 0;
}

function readOrigin(deps: Required<CloneDeps>, repository: string): string | null {
  const result = deps.runSync('git', ['remote', 'get-url', 'origin'], repository);
  return result.status === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null;
}

interface RegisteredWorktree {
  path: string;
  branch: string | null;
}

function readRegisteredWorktrees(deps: Required<CloneDeps>, repository: string): RegisteredWorktree[] {
  const result = deps.runSync('git', ['worktree', 'list', '--porcelain'], repository);
  if (result.status !== 0) return [];
  const rows: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) rows.push(current);
      current = { path: line.slice('worktree '.length), branch: null };
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line.trim() === '' && current) {
      rows.push(current);
      current = null;
    }
  }
  if (current) rows.push(current);
  return rows;
}

function branchExists(deps: Required<CloneDeps>, repository: string, branch: string): boolean {
  return deps.runSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repository).status === 0;
}

function checkBranchName(deps: Required<CloneDeps>, branch: string, cwd: string): string | null {
  if (branch.length === 0 || branch.startsWith('-') || CONTROL_RE.test(branch)) {
    return `invalid branch name "${branch}"`;
  }
  const result = deps.runSync('git', ['check-ref-format', '--branch', branch], cwd);
  return result.status === 0 ? null : `invalid branch name "${branch}"`;
}

interface RollbackResult {
  removed: string[];
  remaining: string[];
}

function removeCreatedParents(deps: Required<CloneDeps>, createdParents: readonly string[]): RollbackResult {
  const removed: string[] = [];
  const remaining: string[] = [];
  for (const parent of createdParents) {
    if (!deps.pathExists(parent)) continue;
    if (!deps.isDirectory(parent) || deps.readDirectory(parent).length !== 0) {
      remaining.push(`created parent ${parent}`);
      continue;
    }
    deps.removeTree(parent);
    if (deps.pathExists(parent)) remaining.push(`created parent ${parent}`);
    else removed.push(`created parent ${parent}`);
  }
  return { removed, remaining };
}

function rollbackDestination(
  deps: Required<CloneDeps>,
  destination: string,
  existed: boolean,
  before: readonly string[],
  createdParents: readonly string[],
): RollbackResult {
  const removed: string[] = [];
  const remaining: string[] = [];
  if (!existed) {
    if (deps.pathExists(destination)) {
      deps.removeTree(destination);
      if (deps.pathExists(destination)) remaining.push(`partial checkout ${destination}`);
      else removed.push(`partial checkout ${destination}`);
    }
    const parents = removeCreatedParents(deps, createdParents);
    removed.push(...parents.removed);
    remaining.push(...parents.remaining);
    return { removed, remaining };
  }
  const beforeSet = new Set(before);
  for (const entry of deps.readDirectory(destination)) {
    if (!beforeSet.has(entry)) {
      const entryPath = join(destination, entry);
      deps.removeTree(entryPath);
      if (deps.pathExists(entryPath)) remaining.push(`new checkout files in ${destination}`);
      else removed.push(`new checkout files in ${destination}`);
    }
  }
  const parents = removeCreatedParents(deps, createdParents);
  removed.push(...parents.removed);
  remaining.push(...parents.remaining);
  return { removed, remaining };
}

function rollbackWorktree(
  deps: Required<CloneDeps>,
  repository: string,
  worktree: string,
  branch: string,
  branchExisted: boolean,
): RollbackResult {
  const removed: string[] = [];
  const remaining: string[] = [];
  const listed = readRegisteredWorktrees(deps, repository).some((row) => samePath(row.path, worktree));
  if (listed) {
    const result = deps.runSync('git', ['worktree', 'remove', '--force', worktree], repository);
    if (result.status === 0) removed.push(`worktree ${worktree}`);
    else remaining.push(`registered worktree ${worktree}`);
  }
  if (deps.pathExists(worktree)) {
    deps.removeTree(worktree);
    if (!removed.some((item) => item.includes(worktree))) removed.push(`worktree files ${worktree}`);
    if (deps.pathExists(worktree)) remaining.push(`worktree files ${worktree}`);
  }
  if (!branchExisted && branchExists(deps, repository, branch)) {
    const result = deps.runSync('git', ['branch', '-D', branch], repository);
    if (result.status === 0) removed.push(`branch ${branch}`);
    else remaining.push(`branch ${branch}`);
  }
  return { removed, remaining };
}

interface Candidate {
  name: string;
  path: string;
  branch: string;
  existing: RegisteredWorktree | null;
}

function chooseCandidate(
  deps: Required<CloneDeps>,
  repository: string,
  destination: string,
  requestedName: string,
  requestedBranch: string | undefined,
): { candidate: Candidate } | { error: string } {
  const registered = readRegisteredWorktrees(deps, repository);
  const existingBranches = new Set(registered.map((row) => row.branch).filter((v): v is string => v !== null));
  const explicitBranch = requestedBranch !== undefined;

  for (let n = 1; n < 10_000; n++) {
    const name = nameWithCollision(requestedName, n);
    const path = join(dirname(destination), name);
    const existing = registered.find((row) => samePath(row.path, path)) ?? null;
    const branch = requestedBranch ?? `wt-${name}`;

    if (samePath(path, destination)) continue;
    if (existing) {
      if (deps.pathExists(path) && existing.branch === branch) {
        return { candidate: { name, path, branch: existing.branch ?? branch, existing } };
      }
      continue;
    }
    if (deps.pathExists(path)) continue;
    if (existingBranches.has(branch)) {
      if (explicitBranch) {
        return {
          error:
            `branch "${branch}" is already checked out in this repository. ` +
            `Choose another --branch or inspect the existing worktree before retrying.`,
        };
      }
      continue;
    }
    return { candidate: { name, path, branch, existing: null } };
  }
  return { error: `could not find a free sibling worktree name for "${requestedName}"` };
}

function destinationState(deps: Required<CloneDeps>, destination: string): {
  existed: boolean;
  before: string[];
  repository: boolean;
} {
  const existed = deps.pathExists(destination);
  const before = existed && deps.isDirectory(destination) ? deps.readDirectory(destination) : [];
  const probe = existed && deps.isDirectory(destination)
    ? deps.runSync('git', ['rev-parse', '--show-toplevel'], destination)
    : { status: 1, stdout: '', stderr: '' };
  return { existed, before, repository: probe.status === 0 };
}

function resolveDestination(
  deps: Required<CloneDeps>,
  invocationCwd: string,
  repositoryUrl: string,
  explicit: string | undefined,
): string {
  if (explicit !== undefined) return resolve(invocationCwd, explicit);
  const cwdState = destinationState(deps, invocationCwd);
  if (cwdState.repository || isEmptyDirectory(deps, invocationCwd)) return resolve(invocationCwd);
  return resolve(invocationCwd, sourceDisplayName(repositoryUrl));
}

function missingParentDirectories(deps: Required<CloneDeps>, parent: string): string[] {
  const missing: string[] = [];
  let current = resolve(parent);
  while (!deps.pathExists(current)) {
    missing.push(current);
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  return missing;
}

function emitRollbackFailure(
  deps: Required<CloneDeps>,
  error: string,
  rollback: RollbackResult,
  kept: string,
): void {
  deps.stderr(`borg clone: ${error}\n`);
  deps.stderr(
    `Rollback: ${rollback.removed.length > 0 ? `removed ${rollback.removed.join(', ')}` : 'nothing was removed'}; ` +
    `${rollback.remaining.length > 0 ? `remaining ${rollback.remaining.join(', ')}` : kept}.\n` +
    `Recovery: fix the reported problem and rerun borg clone, or inspect the preserved path before retrying.\n`,
  );
}

/** Run the clone flow. No Borg authority or seat is consulted. */
export async function runClone(args: CloneArgs, providedDeps: CloneDeps = {}): Promise<number> {
  const deps = withDefaults(providedDeps);
  const invocationCwd = resolve(deps.cwd());
  const validSource = validateCloneRepositoryUrl(args.repositoryUrl);
  if (!validSource.ok) {
    deps.stderr(`borg clone: ${validSource.error}\n`);
    return 1;
  }

  const requestedName = args.flags.name ?? defaultWorktreeName(sourceDisplayName(args.repositoryUrl));
  if (args.flags.name !== undefined) {
    const validName = validateName(args.flags.name);
    if (!validName.ok) {
      deps.stderr(`borg clone: ${validName.error}\n`);
      return 1;
    }
  }

  if (args.flags.branch !== undefined) {
    const branchError = checkBranchName(deps, args.flags.branch, invocationCwd);
    if (branchError !== null) {
      deps.stderr(`borg clone: ${branchError}\n`);
      return 1;
    }
  }

  const destination = resolveDestination(deps, invocationCwd, args.repositoryUrl, args.flags.destination);
  const state = destinationState(deps, destination);
  const destinationWasCwdRepository = args.flags.destination === undefined &&
    samePath(destination, invocationCwd) && state.repository;
  let action: 'cloned' | 'reused' = 'reused';
  const before = state.before;
  const destinationExisted = state.existed;
  const createdParents = state.existed ? [] : missingParentDirectories(deps, dirname(destination));

  if (state.repository) {
    const actualOrigin = readOrigin(deps, destination);
    if (actualOrigin === null) {
      deps.stderr(
        `borg clone: existing checkout at ${destination} has no origin remote. ` +
        `Choose another --destination or repair that checkout before retrying.\n`,
      );
      return 1;
    }
    if (remoteHasCredentials(actualOrigin)) {
      deps.stderr(
        `borg clone: existing checkout at ${destination} has a credential-bearing origin remote. ` +
        `Remove the embedded credential or replace the remote with a credential helper before retrying.\n`,
      );
      return 1;
    }
    if (remoteKey(actualOrigin, destination) !== remoteKey(args.repositoryUrl, invocationCwd)) {
      const recovery = destinationWasCwdRepository
        ? `Recovery: borg clone used the existing repository in your current directory as its destination. ` +
          `Re-run with --destination <path> or from an empty directory; your existing checkout was left untouched.`
        : `Recovery: choose another --destination, or inspect and repair the existing checkout before retrying.`;
      deps.stderr(
        `borg clone: remote mismatch at ${destination}.\n` +
        `  requested: ${args.repositoryUrl}\n` +
        `  existing:  ${actualOrigin}\n` +
        `${recovery}\n`,
      );
      return 1;
    }
    deps.stdout(`Reusing existing checkout at ${destination} (remote matches).\n`);
  } else {
    if (state.existed && (!deps.isDirectory(destination) || before.length > 0)) {
      deps.stderr(
        `borg clone: destination ${destination} already exists and is not an empty Git checkout. ` +
        `Choose another --destination.\n`,
      );
      return 1;
    }
    deps.mkdirp(dirname(destination));
    const cloneArgs = ['clone', args.repositoryUrl, destination];
    const cloned = deps.runSync('git', cloneArgs, invocationCwd);
    if (cloned.status !== 0) {
      const rollback = rollbackDestination(deps, destination, destinationExisted, before, createdParents);
      emitRollbackFailure(
        deps,
        `clone failed: ${cloned.stderr.trim() || cloned.stdout.trim() || 'Git exited unsuccessfully'}`,
        rollback,
        destinationExisted
          ? `pre-existing contents in ${destination} were preserved`
          : `destination ${destination} was not created`,
      );
      return 1;
    }
    action = 'cloned';
    deps.stdout(`Cloned ${args.repositoryUrl} into ${destination}.\n`);
  }

  const candidateResult = chooseCandidate(
    deps,
    destination,
    destination,
    requestedName,
    args.flags.branch,
  );
  if ('error' in candidateResult) {
    if (action === 'cloned') {
      const rollback = rollbackDestination(deps, destination, destinationExisted, before, createdParents);
      emitRollbackFailure(
        deps,
        candidateResult.error,
        rollback,
        destinationExisted
          ? `pre-existing contents in ${destination} were preserved`
          : `destination ${destination} was removed if Git created it`,
      );
    } else {
      deps.stderr(`borg clone: ${candidateResult.error}\n`);
      deps.stderr(`Recovery: the existing checkout was left untouched; choose another --name or --branch.\n`);
    }
    return 1;
  }
  const candidate = candidateResult.candidate;
  const nameChanged = candidate.name !== requestedName;
  if (nameChanged) {
    deps.stdout(
      `Requested worktree name "${requestedName}" was already in use; using "${candidate.name}" instead.\n`,
    );
  }

  if (candidate.existing === null) {
    const branchAlreadyExists = branchExists(deps, destination, candidate.branch);
    const addArgs = branchAlreadyExists
      ? ['worktree', 'add', candidate.path, candidate.branch]
      : ['worktree', 'add', '-b', candidate.branch, candidate.path, 'HEAD'];
    const added = deps.runSync('git', addArgs, destination);
    if (added.status !== 0) {
      const worktreeRollback = rollbackWorktree(
        deps,
        destination,
        candidate.path,
        candidate.branch,
        branchAlreadyExists,
      );
      const destinationRollback = action === 'cloned'
        ? rollbackDestination(deps, destination, destinationExisted, before, createdParents)
        : { removed: [], remaining: [] };
      emitRollbackFailure(
        deps,
        `could not create sibling worktree ${candidate.path}: ${added.stderr.trim() || 'Git exited unsuccessfully'}`,
        {
          removed: [...worktreeRollback.removed, ...destinationRollback.removed],
          remaining: [...worktreeRollback.remaining, ...destinationRollback.remaining],
        },
        action === 'cloned'
          ? destinationExisted
            ? `pre-existing contents in ${destination} were preserved`
            : `destination ${destination} was removed if Git created it`
          : `the existing checkout at ${destination} was preserved`,
      );
      return 1;
    }
  }

  const branchDisplay = candidate.existing?.branch ?? candidate.branch;
  deps.stdout(
    `${candidate.existing === null ? 'Created' : 'Reusing'} sibling worktree at ${candidate.path} on branch ${branchDisplay}.\n`,
  );

  if (args.flags.noLaunch) {
    deps.stdout(
      `No agent launched. Next: cd ${shellEscape(candidate.path)} && borg\n`,
    );
    return 0;
  }

  deps.stdout(`Launching the configured agent in ${candidate.path}.\n`);
  const exitCode = await deps.launch(candidate.path);
  if (exitCode !== 0) {
    deps.stderr(
      `borg clone: agent launch exited with status ${exitCode}; the ready worktree remains at ${candidate.path}. ` +
      `Recovery: cd ${shellEscape(candidate.path)} && borg\n`,
    );
    return exitCode;
  }
  return 0;
}
