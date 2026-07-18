/**
 * Real-fs tests for the 0600 flocked atomic store primitive (Queen rescope).
 * Verifies SR-seven's file-store checklist items 1–4 against the real filesystem.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
