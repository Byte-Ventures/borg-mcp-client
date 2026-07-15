/**
 * Tests for gh#557 token storage backends + selector.
 *
 * Three storage axes:
 *   - KeychainBackend     — OS keychain (default; real at-rest encryption)
 *   - EncryptedFileBackend — ~/.borg/credentials, AES-256-GCM, 0600
 *                            (keychain-less fallback; obfuscation-grade)
 *   - caller-managed       — BORG_TOKEN / BORG_TOKEN_FILE (read-only, no store)
 *
 * fs, the keyring entry factory, and machine key are injected so every
 * backend is unit-tested without touching the real keychain or disk.
 */
import { describe, it, expect } from 'vitest';
import {
  makeKeychainBackend,
  makeEncryptedFileBackend,
  selectTokenBackend,
  readCallerManagedIdToken,
  type KeyringEntry,
  type FileStoreFs,
} from '../src/token-store.js';
import { deriveMachineKey } from '../src/token-crypto.js';

const KEY = deriveMachineKey({ hostname: 'h', username: 'u', platform: 'linux' });
const CRED_PATH = '/home/u/.borg/credentials';

/**
 * In-memory fs capturing file contents, write modes, dirs, and the new
 * gh#570 ops (rename / O_EXCL lock create / remove / age) with call tracking.
 */
function memFs() {
  const files = new Map<string, string>();
  const fileModes = new Map<string, number>();
  const dirs = new Map<string, number>();
  const ageOverrides = new Map<string, number>(); // path → age ms (stale-lock tests)
  const calls = {
    rename: [] as Array<[string, string]>,
    createExclusive: [] as string[],
    removeFile: [] as string[],
  };
  const fs: FileStoreFs = {
    readFile: async (p: string) => {
      if (!files.has(p)) {
        const err: any = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p)!;
    },
    writeFile: async (p: string, data: string, mode: number) => {
      files.set(p, data);
      fileModes.set(p, mode);
    },
    mkdir: async (d: string, mode: number) => {
      dirs.set(d, mode);
    },
    rename: async (from: string, to: string) => {
      calls.rename.push([from, to]);
      if (!files.has(from)) {
        const err: any = new Error(`ENOENT: ${from}`);
        err.code = 'ENOENT';
        throw err;
      }
      files.set(to, files.get(from)!);
      if (fileModes.has(from)) fileModes.set(to, fileModes.get(from)!);
      files.delete(from);
      fileModes.delete(from);
    },
    createExclusive: async (p: string, content: string) => {
      calls.createExclusive.push(p);
      if (files.has(p)) return false; // already held
      files.set(p, content);
      fileModes.set(p, 0o600);
      return true;
    },
    removeFile: async (p: string) => {
      calls.removeFile.push(p);
      files.delete(p);
      fileModes.delete(p);
      ageOverrides.delete(p);
    },
    fileAgeMs: async (p: string) => {
      if (ageOverrides.has(p)) return ageOverrides.get(p)!;
      return files.has(p) ? 0 : null;
    },
  };
  return { files, fileModes, dirs, ageOverrides, calls, fs };
}

/**
 * memFs variant that models DIRECTORY EXISTENCE: createExclusive / writeFile
 * throw ENOENT until the parent dir has been mkdir'd. This reproduces the
 * gh#820 fresh-~/.borg first-run dead-end (real O_EXCL open ENOENTs on a
 * missing dir) that the flat memFs above cannot.
 */
function dirAwareMemFs() {
  const inner = memFs();
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
  const requireDir = (p: string) => {
    if (!inner.dirs.has(dirOf(p))) {
      const err: any = new Error(`ENOENT: no such directory for ${p}`);
      err.code = 'ENOENT';
      throw err;
    }
  };
  const fs: FileStoreFs = {
    ...inner.fs,
    createExclusive: async (p, content) => {
      requireDir(p);
      return inner.fs.createExclusive(p, content);
    },
    writeFile: async (p, data, mode) => {
      requireDir(p);
      return inner.fs.writeFile(p, data, mode);
    },
  };
  return { ...inner, fs };
}

/** In-memory keyring entry factory (one Map shared across accounts). */
function fakeKeyring() {
  const store = new Map<string, string>();
  const factory = (account: string): KeyringEntry => ({
    setPassword: async (v: string) => {
      store.set(account, v);
    },
    getPassword: async () => (store.has(account) ? store.get(account)! : null),
    deletePassword: async () => {
      if (!store.has(account)) throw new Error('No matching entry found in secure storage');
      store.delete(account);
    },
  });
  return { store, factory };
}

describe('makeEncryptedFileBackend (gh#557)', () => {
  it('round-trips an account value through the encrypted file', async () => {
    const { fs } = memFs();
    const backend = makeEncryptedFileBackend({ filePath: CRED_PATH, key: KEY, fs });
    await backend.set('google-id-token', 'ID-VALUE');
    expect(await backend.get('google-id-token')).toBe('ID-VALUE');
  });

  it('stores ciphertext on disk — never the plaintext token', async () => {
    const { files, fs } = memFs();
    const backend = makeEncryptedFileBackend({ filePath: CRED_PATH, key: KEY, fs });
    await backend.set('google-refresh-token', 'PLAINTEXT-REFRESH');
    const onDisk = files.get(CRED_PATH)!;
    expect(onDisk).not.toContain('PLAINTEXT-REFRESH');
    expect(onDisk.startsWith('v1.')).toBe(true);
  });

  it('writes the credentials file 0600 and creates its dir 0700', async () => {
    const { fileModes, dirs, fs } = memFs();
    const backend = makeEncryptedFileBackend({ filePath: CRED_PATH, key: KEY, fs });
    await backend.set('google-id-token', 'X');
    expect(fileModes.get(CRED_PATH)).toBe(0o600);
    expect(dirs.get('/home/u/.borg')).toBe(0o700);
  });

  it('returns null for a missing account and for a missing file', async () => {
    const { fs } = memFs();
    const backend = makeEncryptedFileBackend({ filePath: CRED_PATH, key: KEY, fs });
    expect(await backend.get('google-id-token')).toBeNull();
    await backend.set('google-id-token', 'X');
    expect(await backend.get('token-expiry')).toBeNull();
  });

  it('creates the credential dir BEFORE the lock — set() succeeds on a fresh ~/.borg (gh#820)', async () => {
    // The lock file lives in dirname(filePath); withFileLock must mkdir that
    // dir before its first createExclusive, or a fresh-dir first run (headless
    // `borg setup --no-browser`) dead-ends with ENOENT. Pre-fix this throws.
    const { fs, dirs } = dirAwareMemFs();
    expect(dirs.has('/home/u/.borg')).toBe(false); // truly fresh: dir absent
    const backend = makeEncryptedFileBackend({ filePath: CRED_PATH, key: KEY, fs });
    await expect(backend.set('google-refresh-token', 'R-VALUE')).resolves.toBeUndefined();
    expect(await backend.get('google-refresh-token')).toBe('R-VALUE'); // round-trips
    expect(dirs.get('/home/u/.borg')).toBe(0o700); // dir created with correct posture
  });

  it('keeps multiple accounts independently and deletes one without dropping the rest', async () => {
    const { fs } = memFs();
    const backend = makeEncryptedFileBackend({ filePath: CRED_PATH, key: KEY, fs });
    await backend.set('google-id-token', 'ID');
    await backend.set('google-refresh-token', 'REFRESH');
    await backend.delete('google-id-token');
    expect(await backend.get('google-id-token')).toBeNull();
    expect(await backend.get('google-refresh-token')).toBe('REFRESH');
  });

  it('persists across a fresh backend instance (same fs + key)', async () => {
    const { fs } = memFs();
    const writer = makeEncryptedFileBackend({ filePath: CRED_PATH, key: KEY, fs });
    await writer.set('google-id-token', 'PERSISTED');
    const reader = makeEncryptedFileBackend({ filePath: CRED_PATH, key: KEY, fs });
    expect(await reader.get('google-id-token')).toBe('PERSISTED');
  });

  it('treats a corrupt/undecryptable file as empty (graceful re-auth, not a crash)', async () => {
    const { files, fs } = memFs();
    files.set(CRED_PATH, 'v1.not.valid.ciphertext');
    const backend = makeEncryptedFileBackend({ filePath: CRED_PATH, key: KEY, fs });
    expect(await backend.get('google-id-token')).toBeNull();
  });
});

describe('makeKeychainBackend (gh#557)', () => {
  it('round-trips set/get/delete through the keyring entry', async () => {
    const { factory } = fakeKeyring();
    const backend = makeKeychainBackend(factory);
    await backend.set('google-id-token', 'ID');
    expect(await backend.get('google-id-token')).toBe('ID');
    await backend.delete('google-id-token');
    expect(await backend.get('google-id-token')).toBeNull();
  });

  it('delete on a missing account is silent (idempotent)', async () => {
    const { factory } = fakeKeyring();
    const backend = makeKeychainBackend(factory);
    await expect(backend.delete('never-stored')).resolves.toBeUndefined();
  });
});

describe('selectTokenBackend (gh#557)', () => {
  const keychain = makeKeychainBackend(fakeKeyring().factory);
  const file = makeEncryptedFileBackend({ filePath: CRED_PATH, key: KEY, fs: memFs().fs });

  it('picks keychain when the keyring probe succeeds', async () => {
    const backend = await selectTokenBackend({
      keyringAvailable: async () => true,
      makeKeychain: () => keychain,
      makeFile: () => file,
    });
    expect(backend.name).toBe('keychain');
  });

  it('falls back to the encrypted file when the keyring is unavailable', async () => {
    const backend = await selectTokenBackend({
      keyringAvailable: async () => false,
      makeKeychain: () => keychain,
      makeFile: () => file,
    });
    expect(backend.name).toBe('encrypted-file');
  });

  it('honors a forced backend (BORG_TOKEN_STORE) without probing', async () => {
    let probed = false;
    const backend = await selectTokenBackend({
      keyringAvailable: async () => {
        probed = true;
        return true;
      },
      makeKeychain: () => keychain,
      makeFile: () => file,
      forced: 'file',
    });
    expect(backend.name).toBe('encrypted-file');
    expect(probed).toBe(false);
  });
});

describe('readCallerManagedIdToken (gh#557)', () => {
  it('returns the BORG_TOKEN value verbatim when set', async () => {
    const token = await readCallerManagedIdToken({
      env: { BORG_TOKEN: '  caller-token  ' },
      readFile: async () => {
        throw new Error('should not read a file');
      },
    });
    expect(token).toBe('caller-token');
  });

  it('reads BORG_TOKEN_FILE when BORG_TOKEN is unset', async () => {
    const token = await readCallerManagedIdToken({
      env: { BORG_TOKEN_FILE: '/run/secrets/borg-token' },
      readFile: async (p: string) => {
        expect(p).toBe('/run/secrets/borg-token');
        return 'file-token\n';
      },
    });
    expect(token).toBe('file-token');
  });

  it('returns null when neither is set', async () => {
    const token = await readCallerManagedIdToken({
      env: {},
      readFile: async () => '',
    });
    expect(token).toBeNull();
  });
});

describe('makeEncryptedFileBackend concurrency + atomicity (gh#570)', () => {
  const immediateSleep = () => Promise.resolve(); // yields the loop without real delay
  const zeroNow = () => 0; // constant clock → acquire never times out, waits for release
  function counterSuffix() {
    let n = 0;
    return () => String(n++);
  }

  function fileBackend(fs: FileStoreFs, overrides: Record<string, unknown> = {}) {
    return makeEncryptedFileBackend({
      filePath: CRED_PATH,
      key: KEY,
      fs,
      sleep: immediateSleep,
      now: zeroNow,
      uniqueSuffix: counterSuffix(),
      ...overrides,
    } as any);
  }

  it('serializes concurrent set() so neither update is lost (closes the lost-update race)', async () => {
    // Without the lock these two read-modify-write cycles interleave (both read
    // the empty map, last write wins) and one token is silently dropped.
    const { fs } = memFs();
    const backend = fileBackend(fs);
    await Promise.all([
      backend.set('google-id-token', 'ID'),
      backend.set('google-refresh-token', 'REFRESH'),
    ]);
    expect(await backend.get('google-id-token')).toBe('ID');
    expect(await backend.get('google-refresh-token')).toBe('REFRESH');
  });

  it('writes atomically via a temp file + rename (anti-corruption)', async () => {
    const { fs, calls, files } = memFs();
    const backend = fileBackend(fs);
    await backend.set('google-id-token', 'ID');
    expect(calls.rename.length).toBeGreaterThanOrEqual(1);
    const [from, to] = calls.rename[calls.rename.length - 1];
    expect(from).toContain('.tmp');
    expect(to).toBe(CRED_PATH);
    // no leftover temp file, and the credentials file is decryptable
    expect([...files.keys()].some((k) => k.includes('.tmp'))).toBe(false);
    expect(await backend.get('google-id-token')).toBe('ID');
  });

  it('acquires + releases the lock around set() (lock file gone afterward)', async () => {
    const { fs, files, calls } = memFs();
    const backend = fileBackend(fs);
    await backend.set('google-id-token', 'ID');
    expect(calls.createExclusive.some((p) => p.endsWith('.lock'))).toBe(true);
    expect([...files.keys()].some((k) => k.endsWith('.lock'))).toBe(false);
  });

  it('does NOT take the lock for get() — reads are lock-free', async () => {
    const { fs, calls } = memFs();
    const backend = fileBackend(fs);
    await backend.set('google-id-token', 'ID');
    const lockAttemptsAfterSet = calls.createExclusive.length;
    await backend.get('google-id-token');
    expect(calls.createExclusive.length).toBe(lockAttemptsAfterSet);
  });

  it('steals a stale lock (older than the staleness threshold) and proceeds', async () => {
    const { fs, files, ageOverrides, calls } = memFs();
    const lockPath = `${CRED_PATH}.lock`;
    files.set(lockPath, 'stale-holder'); // pre-existing lock from a crashed process
    ageOverrides.set(lockPath, 60_000); // 60s old → well past the staleness threshold
    const backend = fileBackend(fs);
    await backend.set('google-id-token', 'ID');
    expect(calls.removeFile).toContain(lockPath); // stale lock stolen
    expect(await backend.get('google-id-token')).toBe('ID');
  });

  it('releases the lock even when the write fails (no deadlock on error)', async () => {
    const { fs, files } = memFs();
    const throwingFs: FileStoreFs = {
      ...fs,
      rename: async () => {
        throw new Error('disk full');
      },
    };
    const backend = fileBackend(throwingFs);
    await expect(backend.set('google-id-token', 'ID')).rejects.toThrow(/disk full/);
    expect([...files.keys()].some((k) => k.endsWith('.lock'))).toBe(false);
  });

  it('removes the orphaned temp file when rename fails — and still rethrows (gh#570 CR-NIT)', async () => {
    const { fs, files, calls } = memFs();
    const throwingFs: FileStoreFs = {
      ...fs,
      rename: async () => {
        throw new Error('disk full');
      },
    };
    const backend = fileBackend(throwingFs);
    // The original error still propagates (set stays fail-loud)…
    await expect(backend.set('google-id-token', 'ID')).rejects.toThrow(/disk full/);
    // …and the temp file written before the failed rename is cleaned up, so
    // repeated rename failures don't accumulate orphaned .tmp files.
    expect(calls.removeFile.some((p) => p.includes('.tmp'))).toBe(true);
    expect([...files.keys()].some((k) => k.includes('.tmp'))).toBe(false);
  });
});
