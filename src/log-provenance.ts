import { spawnSync } from 'node:child_process';

export interface GitResult {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
}

export type RunGit = (cwd: string, args: string[]) => GitResult;

export interface ResolvedRef {
  ref: string;
  sha: string;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/u;
const MESSAGE_SHA_RE = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/gu;

function defaultRunGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

function gitFailure(result: GitResult, fallback: string): string {
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') return 'not a git repository';
    return result.error.message.replace(/[\x00-\x1F\x7F]/gu, ' ').trim() || fallback;
  }
  return result.stderr?.replace(/[\x00-\x1F\x7F]/gu, ' ').trim() || fallback;
}

function resolveCommit(ref: string, cwd: string, runGit: RunGit): GitResult & { sha?: string } {
  let result: GitResult;
  try {
    result = runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  } catch (error) {
    return { status: null, error: error instanceof Error ? error : new Error(String(error)) };
  }
  const sha = result.status === 0 ? result.stdout?.trim() : undefined;
  return FULL_SHA_RE.test(sha ?? '') ? { ...result, sha } : result;
}

export function validateRefs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new Error('refs must be an array of 1-8 unique Git refs');
  }
  const refs: string[] = [];
  for (const valueRef of value) {
    if (typeof valueRef !== 'string' || valueRef.length === 0) {
      throw new Error('each refs entry must be a non-empty string');
    }
    if (Buffer.byteLength(valueRef, 'utf8') > 200) {
      throw new Error(`Git ref exceeds 200 UTF-8 bytes: ${valueRef.slice(0, 40)}`);
    }
    if (valueRef.startsWith('-')) throw new Error(`Git ref must not start with "-": ${valueRef}`);
    if (/[\s\x00-\x1F\x7F]/u.test(valueRef)) {
      throw new Error(`Git ref must not contain whitespace or control characters: ${JSON.stringify(valueRef)}`);
    }
    if (refs.includes(valueRef)) throw new Error(`Git ref is duplicated: ${valueRef}`);
    refs.push(valueRef);
  }
  return refs;
}

export function resolveRefs(
  refs: string[],
  cwd: string,
  runGit: RunGit = defaultRunGit,
): ResolvedRef[] {
  return refs.map((ref) => {
    const result = resolveCommit(ref, cwd, runGit);
    if (!result.sha) {
      throw new Error(`Could not resolve Git ref "${ref}": ${gitFailure(result, 'ref did not resolve to a commit')}`);
    }
    return { ref, sha: result.sha };
  });
}

export function auditMessageShas(
  message: string,
  cwd: string,
  runGit: RunGit = defaultRunGit,
): { refusal?: string; unverified: string[] } {
  const shas = [...new Set(message.match(MESSAGE_SHA_RE) ?? [])];
  const unverified: string[] = [];
  for (const sha of shas) {
    if (resolveCommit(sha, cwd, runGit).sha) continue;
    const prefixResult = resolveCommit(sha.slice(0, 7), cwd, runGit);
    if (prefixResult.sha && prefixResult.sha !== sha) {
      return {
        refusal: `Message SHA ${sha} does not exist, but its 7-character prefix resolves to ${prefixResult.sha}. Pass Git refs through the refs parameter instead of typing a full SHA.`,
        unverified,
      };
    }
    if (!prefixResult.sha) unverified.push(sha);
  }
  return { unverified };
}

export function renderProvenance(resolved: ResolvedRef[]): string {
  return resolved.length === 0
    ? ''
    : `\n\n${resolved.map(({ ref, sha }) => `${ref} = ${sha}`).join('\n')}`;
}

export function requiresRefs(message: string): boolean {
  return /^REVIEW-READY(?:\b|$)/u.test(message);
}
