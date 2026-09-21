import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'store-turnover-')));
  vi.resetModules();
});
afterEach(async () => {
  vi.doUnmock('node:fs/promises');
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it.each([
  [1, 'acquire'], [2, 'acquire'], [1, 'busy'], [2, 'busy'],
] as const)('retries turnover during lock inspection %i then %s', async (inspection, outcome) => {
  const lock = join(root, 'store.lock');
  const firstEntered = deferred(), releaseFirst = deferred();
  const secondEntered = deferred(), releaseSecond = deferred();
  let first!: Promise<unknown>, second: Promise<unknown> | undefined;
  let reads = 0, turnovers = 0;
  let withStoreLock!: typeof import('../src/seat-store.js').withStoreLock;
  vi.doMock('node:fs/promises', () => ({
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === lock && ++reads === inspection) {
        // Keep the first inode alive to rule out immediate inode-number reuse.
        const old = await fs.open(lock, 'r');
        try {
          releaseFirst.resolve();
          await first;
          second = withStoreLock(lock, async () => {
            secondEntered.resolve();
            await releaseSecond.promise;
          }, { secureRoot: root });
          await secondEntered.promise;
          const handle = await fs.open(...args);
          turnovers++;
          if (outcome === 'acquire') { releaseSecond.resolve(); await second; }
          return handle;
        } finally { await old.close(); }
      }
      return fs.open(...args);
    },
  }));
  ({ withStoreLock } = await import('../src/seat-store.js'));
  first = withStoreLock(lock, async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
  }, { secureRoot: root });
  await firstEntered.promise;
  // Exercise the second (stale-holder revalidation) read without an OS PID race.
  if (inspection === 2) vi.spyOn(process, 'kill').mockImplementationOnce(() => {
    throw Object.assign(new Error('simulated dead holder'), { code: 'ESRCH' });
  });
  let acquired = 0;
  try {
    const contender = withStoreLock(lock, async () => { acquired++; return 'acquired'; },
      { secureRoot: root, attempts: 3, waitMs: 0 });
    if (outcome === 'acquire') await expect(contender).resolves.toBe('acquired');
    else {
      await expect(contender).rejects.toThrow('Borg private store is busy');
      expect(JSON.parse(await fs.readFile(lock, 'utf8')).pid).toBe(process.pid);
    }
    expect(turnovers).toBe(1);
    expect(acquired).toBe(outcome === 'acquire' ? 1 : 0);
  } finally {
    releaseFirst.resolve(); releaseSecond.resolve();
    await Promise.all([first, second]);
  }
  expect(await fs.readdir(root)).toEqual([]);
});

it('keeps data-file identity drift under the lock a hard error', async () => {
  const data = join(root, 'store.json');
  await fs.writeFile(data, '{"value":1}', { mode: 0o600 });
  let replaced = false;
  vi.doMock('node:fs/promises', () => ({
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === data && !replaced) {
        replaced = true;
        const next = join(root, 'replacement');
        await fs.writeFile(next, '{"value":2}', { mode: 0o600 });
        await fs.rename(next, data);
      }
      return fs.open(...args);
    },
  }));
  const { withStore } = await import('../src/seat-store.js');
  const operation = vi.fn();
  await expect(withStore(data, () => ({}), JSON.parse, operation, { secureRoot: root }))
    .rejects.toMatchObject({
      code: 'STORE_FILE_IDENTITY_CHANGED',
      message: 'Borg credential store file changed while it was being opened',
    });
  expect(operation).not.toHaveBeenCalled();
  expect(await fs.readFile(data, 'utf8')).toBe('{"value":2}');
  expect(await fs.readdir(root)).toEqual(['store.json']);
});

it.each(['dead', 'corrupt'])('never removes an unchanged %s holder', async kind => {
  const lock = join(root, 'store.lock');
  const content = kind === 'dead' ? JSON.stringify({ pid: process.pid, startTime: 'test' }) : 'invalid';
  await fs.writeFile(lock, content, { mode: 0o600 });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('simulated dead holder'), { code: 'ESRCH' });
  });
  const { withStoreLock } = await import('../src/seat-store.js');
  const operation = vi.fn();
  await expect(withStoreLock(lock, operation, { secureRoot: root, attempts: 3, waitMs: 0 }))
    .rejects.toThrow('is stale');
  expect(operation).not.toHaveBeenCalled();
  expect(await fs.readFile(lock, 'utf8')).toBe(content);
  expect(await fs.readdir(root)).toEqual(['store.lock']);
});

it.each(['symlink', 'owner', 'mode', 'noncanonical'] as const)(
  'refuses an unsafe %s lock immediately', async kind => {
    const lock = join(root, 'store.lock');
    const target = join(root, 'sentinel');
    const payload = JSON.stringify({ pid: process.pid, startTime: 'test' });
    await fs.writeFile(target, payload, { mode: 0o600 });
    if (kind === 'symlink') await fs.symlink(target, lock);
    else await fs.writeFile(lock, payload, { mode: 0o600 });
    if (kind === 'mode') await fs.chmod(lock, 0o644);
    const link = vi.fn(fs.link);
    vi.doMock('node:fs/promises', () => ({
      ...fs,
      link,
      lstat: async (...args: Parameters<typeof fs.lstat>) => {
        const result = await fs.lstat(...args);
        if (kind === 'owner' && args[0] === lock) {
          Object.defineProperty(result, 'uid', { value: (process.getuid?.() ?? 0) + 1 });
        }
        return result;
      },
    }));
    const { withStoreLock } = await import('../src/seat-store.js');
    const operation = vi.fn();
    const path = kind === 'noncanonical' ? `${root}/./store.lock` : lock;
    const message = { symlink: /symlink|canonical/, owner: /owned/, mode: /permissions/, noncanonical: /canonical/ }[kind];
    await expect(withStoreLock(path, operation, { secureRoot: root, attempts: 3, waitMs: 0 }))
      .rejects.toThrow(message);
    expect(operation).not.toHaveBeenCalled();
    expect(link.mock.calls.length).toBeLessThanOrEqual(1);
    expect(await fs.readFile(target, 'utf8')).toBe(payload);
    expect(await fs.readFile(lock, 'utf8')).toBe(payload);
    if (kind === 'mode') expect((await fs.stat(lock)).mode & 0o777).toBe(0o644);
    if (kind === 'symlink') expect((await fs.lstat(lock)).isSymbolicLink()).toBe(true);
    expect((await fs.readdir(root)).sort()).toEqual(['sentinel', 'store.lock']);
  },
);
