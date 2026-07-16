import { describe, it, expect } from 'vitest';
import {
  sanitizeRemoteUrl,
  parseGitRemote,
  normalizeCubeName,
  deriveCubeName,
} from '../src/cube-name';

describe('sanitizeRemoteUrl', () => {
  it('trims surrounding whitespace', () => {
    expect(sanitizeRemoteUrl('  git@github.com:org/repo.git\n')).toBe('git@github.com:org/repo.git');
  });

  it('rejects embedded control chars', () => {
    expect(sanitizeRemoteUrl('git@github.com:org/repo.git\x00malicious')).toBeNull();
    expect(sanitizeRemoteUrl('git@github.com:org/\nrepo.git')).toBeNull();
    expect(sanitizeRemoteUrl('git@github.com:org/repo\t.git')).toBeNull();
  });

  it('rejects URLs longer than 2048 chars', () => {
    expect(sanitizeRemoteUrl('a'.repeat(2049))).toBeNull();
    expect(sanitizeRemoteUrl('a'.repeat(2048))).toBe('a'.repeat(2048));
  });

  it('passes clean URLs through', () => {
    expect(sanitizeRemoteUrl('https://github.com/Org/repo.git')).toBe('https://github.com/Org/repo.git');
  });
});

describe('parseGitRemote', () => {
  it('parses github SSH form', () => {
    expect(parseGitRemote('git@github.com:Org/repo.git')).toBe('repo');
    expect(parseGitRemote('git@github.com:Org/repo')).toBe('repo');
  });

  it('parses github HTTPS form', () => {
    expect(parseGitRemote('https://github.com/Org/repo.git')).toBe('repo');
    expect(parseGitRemote('https://github.com/Org/repo')).toBe('repo');
  });

  it('parses non-github SSH/HTTPS via last path segment', () => {
    expect(parseGitRemote('git@gitlab.com:org/repo.git')).toBe('repo');
    expect(parseGitRemote('https://bitbucket.org/team/proj.git')).toBe('proj');
    expect(parseGitRemote('git@github.enterprise.corp:org/repo.git')).toBe('repo');
  });

  it('parses protocol-prefixed transports', () => {
    expect(parseGitRemote('ssh://git@host:22/path/repo.git')).toBe('repo');
    expect(parseGitRemote('git://host/path/repo.git')).toBe('repo');
    expect(parseGitRemote('file:///abs/path/repo.git')).toBe('repo');
  });

  it('strips credentials from HTTPS', () => {
    expect(parseGitRemote('https://user:token@host/team/repo.git')).toBe('repo');
  });

  it('returns null for unparseable input', () => {
    expect(parseGitRemote('')).toBeNull();
    expect(parseGitRemote('not-a-url')).toBeNull();
  });
});

describe('normalizeCubeName', () => {
  it('lowercases and replaces underscores + spaces with hyphens', () => {
    expect(normalizeCubeName('Borg_MCP Project')).toBe('borg-mcp-project');
  });

  it('strips chars outside [a-z0-9-]', () => {
    expect(normalizeCubeName('repo!@#$%')).toBe('repo');
    expect(normalizeCubeName('Ω')).toBe(''); // Unicode strip-to-empty
  });

  it('truncates to 64 chars', () => {
    expect(normalizeCubeName('a'.repeat(80))).toBe('a'.repeat(64));
  });

  it('returns empty string when nothing survives', () => {
    expect(normalizeCubeName('!!!')).toBe('');
  });

  it('preserves leading-hyphen result when input is "-test-"', () => {
    // Documents that DB CHECK accepts but UX surfaces in stderr later.
    expect(normalizeCubeName('-test-')).toBe('-test-');
  });

  it('handles pure-number repo name', () => {
    expect(normalizeCubeName('123')).toBe('123');
  });
});

describe('deriveCubeName', () => {
  it('uses git remote when provided', () => {
    expect(deriveCubeName('/work/myrepo', 'git@github.com:org/cool-repo.git')).toBe('cool-repo');
  });

  it('falls back to the normalized project-root basename when remote is null', () => {
    expect(deriveCubeName('/work/My_Repo', null)).toBe('my-repo');
  });

  it('falls back to the basename when the remote URL is rejected', () => {
    expect(deriveCubeName('/work/myrepo', 'git@host:org/repo.git\x00bad')).toBe('myrepo');
  });

  it('returns null when remote is unparseable', () => {
    expect(deriveCubeName('/Ω', null)).toBeNull();
  });
});
