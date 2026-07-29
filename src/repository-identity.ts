import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, isAbsolute, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { CUBE_TEMPLATES, type CreateCubeRepository, type CubeTemplate } from 'borgmcp-shared/protocol';
import { canonicalizeWorkingRepoIdentity } from './working-repo.js';
import { normalizeCubeName } from './cube-name.js';
import { borgConfigRoot, ensurePrivateBorgConfigRoot } from './private-root.js';
import { atomicWrite0600, readStoreFile, withStoreLock } from './seat-store.js';

const STORE_VERSION = 1;
const SECRET_FILE = 'repository-identity.key';
const STATE_FILE = 'repository-identities.json';
const LOCK_FILE = 'repository-identities.lock';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISPLAY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export interface GitRepositoryContext {
  root: string;
  commonDir: string;
  derivedName: string;
  publicRepository: Extract<CreateCubeRepository, { kind: 'origin' }> | null;
  publicRepositoryName: string | null;
}

export interface RepositoryAssociation {
  cubeId: string;
  name: string;
  workingRepoName: string;
  template: CubeTemplate;
}

interface RepositoryIdentityState {
  version: 1;
  localIdentities: Record<string, string>;
  associations: Record<string, RepositoryAssociation>;
}

export interface RepositoryIdentityDeps {
  runGit?: (cwd: string, args: string[]) => { status: number | null; stdout?: string | null };
  canonicalPath?: (path: string) => Promise<string>;
  root?: string;
}

function defaultRunGit(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout };
}

function output(result: { status: number | null; stdout?: string | null }): string | null {
  const value = result.status === 0 ? result.stdout?.trim() : null;
  return value || null;
}

export async function resolveGitRepositoryContext(
  cwd: string,
  deps: RepositoryIdentityDeps = {},
): Promise<GitRepositoryContext | null> {
  const runGit = deps.runGit ?? defaultRunGit;
  const canonicalPath = deps.canonicalPath ?? realpath;
  const rootRaw = output(runGit(cwd, ['rev-parse', '--show-toplevel']));
  if (!rootRaw || !isAbsolute(rootRaw)) return null;
  const bare = output(runGit(cwd, ['rev-parse', '--is-bare-repository']));
  if (bare === 'true') throw new Error('BARE_REPOSITORY');
  const commonRaw = output(runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (!commonRaw || !isAbsolute(commonRaw)) return null;
  const root = await canonicalPath(rootRaw);
  const commonDir = await canonicalPath(commonRaw);
  const derivedName = normalizeCubeName(basename(root));
  if (!derivedName) return null;

  const originRaw = output(runGit(root, ['config', '--get', 'remote.origin.url']));
  const canonical = originRaw ? canonicalizeWorkingRepoIdentity(originRaw) : null;
  return {
    root,
    commonDir,
    derivedName,
    publicRepository: canonical?.origin
      ? { kind: 'origin', value: canonical.origin }
      : null,
    publicRepositoryName: canonical?.name ?? null,
  };
}

function parseSecret(raw: string | null): Buffer | null {
  if (raw === null) return null;
  if (!/^[a-f0-9]{64}$/.test(raw.trim())) {
    throw new Error('Borg repository identity secret is malformed');
  }
  return Buffer.from(raw.trim(), 'hex');
}

function emptyState(): RepositoryIdentityState {
  return { version: STORE_VERSION, localIdentities: {}, associations: {} };
}

function parseState(raw: string | null): RepositoryIdentityState {
  if (raw === null) return emptyState();
  const parsed = JSON.parse(raw) as Partial<RepositoryIdentityState>;
  if (
    parsed.version !== STORE_VERSION ||
    !parsed.localIdentities || typeof parsed.localIdentities !== 'object' || Array.isArray(parsed.localIdentities) ||
    !parsed.associations || typeof parsed.associations !== 'object' || Array.isArray(parsed.associations)
  ) {
    throw new Error('Borg repository identity store is malformed or unsupported');
  }
  for (const [key, value] of Object.entries(parsed.localIdentities)) {
    if (!/^[a-f0-9]{64}$/.test(key) || typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new Error('Borg repository identity store is malformed or unsupported');
    }
  }
  for (const [key, value] of Object.entries(parsed.associations)) {
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.cubeId !== 'string' || !UUID_RE.test(value.cubeId) ||
      typeof value.name !== 'string' || Buffer.byteLength(value.name, 'utf8') > 120 ||
      !DISPLAY_NAME_RE.test(value.name) ||
      typeof value.workingRepoName !== 'string' || Buffer.byteLength(value.workingRepoName, 'utf8') > 120 ||
      !DISPLAY_NAME_RE.test(value.workingRepoName) ||
      !CUBE_TEMPLATES.some((template) => template === value.template)
    ) {
      throw new Error('Borg repository identity store is malformed or unsupported');
    }
  }
  return parsed as RepositoryIdentityState;
}

function digest(secret: Buffer, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(purpose).update('\0').update(value).digest('hex');
}

async function withIdentityState<T>(
  operation: (secret: Buffer, state: RepositoryIdentityState) => Promise<{ result: T; changed?: boolean }>,
  deps: RepositoryIdentityDeps = {},
): Promise<T> {
  const root = deps.root ?? borgConfigRoot();
  await ensurePrivateBorgConfigRoot(root);
  const options = { secureRoot: root, rootMode: 'private' as const };
  return withStoreLock(join(root, LOCK_FILE), async () => {
    const secretPath = join(root, SECRET_FILE);
    let secret = parseSecret(await readStoreFile(secretPath, options));
    if (!secret) {
      secret = randomBytes(32);
      await atomicWrite0600(secretPath, `${secret.toString('hex')}\n`, options);
    }
    const statePath = join(root, STATE_FILE);
    const state = parseState(await readStoreFile(statePath, options));
    const outcome = await operation(secret, state);
    if (outcome.changed) {
      await atomicWrite0600(statePath, `${JSON.stringify(state, null, 2)}\n`, options);
    }
    return outcome.result;
  }, options);
}

export async function getOrCreateRepositoryIdentity(
  context: GitRepositoryContext,
  deps: RepositoryIdentityDeps = {},
): Promise<CreateCubeRepository> {
  if (context.publicRepository) return context.publicRepository;
  return withIdentityState(async (secret, state) => {
    const key = digest(secret, 'git-common-dir', context.commonDir);
    let value = state.localIdentities[key];
    let changed = false;
    if (!value) {
      value = randomUUID();
      state.localIdentities[key] = value;
      changed = true;
    }
    return { result: { kind: 'local' as const, value }, changed };
  }, deps);
}

function associationBinding(secret: Buffer, trustIdentity: string, repository: CreateCubeRepository): string {
  return digest(secret, 'association', `${trustIdentity}\0${repository.kind}\0${repository.value}`);
}

export async function getRepositoryAssociation(
  trustIdentity: string,
  repository: CreateCubeRepository,
  deps: RepositoryIdentityDeps = {},
): Promise<RepositoryAssociation | null> {
  return withIdentityState(async (secret, state) => ({
    result: state.associations[associationBinding(secret, trustIdentity, repository)] ?? null,
  }), deps);
}

export async function saveRepositoryAssociation(
  trustIdentity: string,
  repository: CreateCubeRepository,
  association: RepositoryAssociation,
  deps: RepositoryIdentityDeps = {},
): Promise<void> {
  await withIdentityState(async (secret, state) => {
    state.associations[associationBinding(secret, trustIdentity, repository)] = association;
    return { result: undefined, changed: true };
  }, deps);
}
