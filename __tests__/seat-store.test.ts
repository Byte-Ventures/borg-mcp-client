/**
 * Real-fs tests for the 0600 flocked atomic store primitive (Queen rescope).
 * Verifies SR-seven's file-store checklist items 1–4 against the real filesystem.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWrite0600,
  readStoreFile,
  withStore,
  withStoreLock,
} from '../src/seat-store.js';

const fixtures: string[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
});
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'borg-seat-store-'));
  fixtures.push(dir);
  return dir;
}
const mode = (p: string) => statSync(p).mode & 0o777;

describe('seat-store atomic 0600 write (checklist #1, #2, #3)', () => {
  it('#1: the store file is mode 0600 (never a world/group-readable window)', async () => {
    const dir = fixture();
    const store = join(dir, 'nested', 'seats.json');
    await atomicWrite0600(store, JSON.stringify({ secret: 'bearer-material' }));
    expect(mode(store)).toBe(0o600);
  });

  it('#3: the parent directory is created 0700', async () => {
    const dir = fixture();
    const store = join(dir, 'sub', 'seats.json');
    await atomicWrite0600(store, '{}');
    expect(mode(join(dir, 'sub'))).toBe(0o700);
  });

  it('#2: leaves NO leftover temp file after a successful write', async () => {
    const dir = fixture();
    const store = join(dir, 'seats.json');
    await atomicWrite0600(store, '{"a":1}');
    await atomicWrite0600(store, '{"a":2}');
    const stray = readdirSync(dir).filter((n) => n.includes('.tmp'));
    expect(stray).toEqual([]);
    expect(await readFile(store, 'utf8')).toContain('"a":2');
  });

  it('#2: a concurrent reader only ever sees a COMPLETE file (atomic rename, never torn)', async () => {
    const dir = fixture();
    const store = join(dir, 'seats.json');
    // Seed, then hammer writes while reading — every observed read must parse.
    await atomicWrite0600(store, JSON.stringify({ n: 0 }));
    const writes = (async () => {
      for (let i = 1; i <= 40; i++) await atomicWrite0600(store, JSON.stringify({ n: i, pad: 'x'.repeat(2000) }));
    })();
    const reads = (async () => {
      for (let i = 0; i < 40; i++) {
        const raw = await readStoreFile(store);
        if (raw !== null) expect(() => JSON.parse(raw)).not.toThrow();
      }
    })();
    await Promise.all([writes, reads]);
  });

  it('CR3c: a pre-existing loose (0755) parent dir is REFUSED (fail closed)', async () => {
    const dir = fixture();
    const loose = join(dir, 'loose');
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    await expect(atomicWrite0600(join(loose, 'seats.json'), '{}')).rejects.toThrow(
      /insecure permissions|0700/i,
    );
  });

  it('CR3c: a 0700 parent is accepted and the secret lands 0600', async () => {
    const dir = fixture();
    const tight = join(dir, 'tight');
    mkdirSync(tight);
    chmodSync(tight, 0o700);
    await atomicWrite0600(join(tight, 'seats.json'), '{"ok":1}');
    expect(mode(join(tight, 'seats.json'))).toBe(0o600);
  });

  it('a failed write (parent is a file) cleans up the temp and throws', async () => {
    const dir = fixture();
    // Make the intended parent path a FILE so mkdir/open fails.
    writeFileSync(join(dir, 'blocker'), 'x');
    await expect(atomicWrite0600(join(dir, 'blocker', 'seats.json'), '{}')).rejects.toBeTruthy();
    // No stray temp under dir.
    expect(readdirSync(dir).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});

describe('seat-store single-lock RCW (checklist #4)', () => {
  const empty = () => ({ n: 0 });
  const parse = (raw: string) => JSON.parse(raw) as { n: number };

  it('read-compare-write is serialized: two concurrent increments both land (no lost update)', async () => {
    const dir = fixture();
    const store = join(dir, 'counter.json');
    const bump = () => withStore(store, empty, parse, async (txn) => {
      const before = txn.data.n;
      // A yield inside the critical section would expose a lost update if the
      // lock did not serialize the whole read→write.
      await new Promise((r) => setTimeout(r, 5));
      txn.data.n = before + 1;
      await txn.commit();
    });
    await Promise.all([bump(), bump(), bump(), bump(), bump()]);
    const final = await withStore(store, empty, parse, async (txn) => txn.data.n);
    expect(final).toBe(5);
  });

  it('the lock is released on a THROW (a later acquire is not wedged)', async () => {
    const dir = fixture();
    const lock = join(dir, 'x.lock');
    await expect(withStoreLock(lock, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // The lock must be gone → a fresh acquire succeeds immediately.
    let ran = false;
    await withStoreLock(lock, async () => { ran = true; });
    expect(ran).toBe(true);
    expect(readdirSync(dir).filter((n) => n.endsWith('.lock'))).toEqual([]);
  });

  it('CR4: a present-but-malformed store FAILS CLOSED and is never overwritten (byte-preservation)', async () => {
    const dir = fixture();
    const store = join(dir, 'seats.json');
    const corrupt = '{ this is not valid json';
    writeFileSync(store, corrupt);
    // A malformed file must throw WITHOUT committing — never mapped to empty.
    await expect(
      withStore(store, empty, parse, async (txn) => { txn.data.n = 99; await txn.commit(); }),
    ).rejects.toThrow(/malformed|unsupported version/i);
    // The corrupt bytes are preserved exactly (no overwrite).
    expect(await readFile(store, 'utf8')).toBe(corrupt);
  });

  it('CR4: a schema-invalid (parse→null) store FAILS CLOSED and is preserved', async () => {
    const dir = fixture();
    const store = join(dir, 'seats.json');
    // Valid JSON, but the caller's parse rejects the shape (returns null).
    const parseStrict = (raw: string): { n: number } | null => {
      const p = JSON.parse(raw) as { n?: unknown };
      return typeof p.n === 'number' ? { n: p.n } : null;
    };
    const wrongShape = JSON.stringify({ notN: true });
    writeFileSync(store, wrongShape);
    await expect(
      withStore(store, empty, parseStrict, async (txn) => { txn.data.n = 5; await txn.commit(); }),
    ).rejects.toThrow(/malformed|unsupported version/i);
    expect(await readFile(store, 'utf8')).toBe(wrongShape);
  });

  it('CR3a: a LIVE cross-process holder past the stale threshold is NOT stolen; a DEAD one is reclaimed', async () => {
    const dir = fixture();
    const lock = join(dir, 'seats.json.lock');
    // A real, separate OS process holds the lock (cross-process liveness).
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise<void>((r) => child.on('spawn', () => r()));
    writeFileSync(lock, JSON.stringify({ pid: child.pid, token: 'held-by-live' }));
    // Backdate mtime well past the age threshold — the OLD unconditional reclaim
    // would have stolen it; liveness-gated reclaim must not.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, old, old);
    await expect(
      withStoreLock(lock, async () => { /* unreachable */ }, { attempts: 4, waitMs: 5 }),
    ).rejects.toThrow(/busy/i);
    // The live holder's lock is untouched.
    expect(existsSync(lock)).toBe(true);
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('held-by-live');
    // Kill the holder → its PID is now dead → the SAME lock is reclaimable.
    child.kill('SIGKILL');
    await new Promise<void>((r) => child.on('exit', () => r()));
    let ran = false;
    await withStoreLock(lock, async () => { ran = true; }, { attempts: 50, waitMs: 5 });
    expect(ran).toBe(true);
  });

  it('CR3a: release is identity-checked — a stalled holder never removes the successor lock (successor-safe)', async () => {
    const dir = fixture();
    const lock = join(dir, 'seats.json.lock');
    await withStoreLock(lock, async () => {
      // Simulate a reclaimer that judged us dead + a successor that acquired the lock
      // while we were stalled: the on-disk token is now the successor's, not ours.
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'successor-token' }));
    }, { attempts: 5, waitMs: 5 });
    // Our release must NOT have removed the successor's lock.
    expect(existsSync(lock)).toBe(true);
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('successor-token');
  });

  it('CR3a: a stale lock left by a DEAD pid is reclaimed (no permanent wedge)', async () => {
    const dir = fixture();
    const lock = join(dir, 'seats.json.lock');
    // A PID that is essentially certain to be dead.
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 30, token: 'ghost' }));
    let ran = false;
    await withStoreLock(lock, async () => { ran = true; }, { attempts: 50, waitMs: 5 });
    expect(ran).toBe(true);
  });

  it('withStore returns null-state as empty and commits atomically at 0600', async () => {
    const dir = fixture();
    const store = join(dir, 'seats.json');
    await withStore(store, empty, parse, async (txn) => {
      expect(txn.data).toEqual({ n: 0 });
      txn.data.n = 7;
      await txn.commit();
    });
    expect(mode(store)).toBe(0o600);
    expect(JSON.parse(await readFile(store, 'utf8'))).toEqual({ n: 7 });
  });
});
