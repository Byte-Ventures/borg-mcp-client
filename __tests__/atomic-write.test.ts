import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from '../src/cubes.js';

// gh#894: prefs writers must be crash-safe — write to a same-dir temp + rename()
// (atomic on POSIX) so a crash mid-write can never leave a truncated/empty
// prefs file. On failure the original must be untouched and no temp left behind.

describe('atomicWriteFile (gh#894)', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'borg-aw-'));
    file = join(dir, 'prefs.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the content to a new file', async () => {
    await atomicWriteFile(file, '{"a":1}\n');
    expect(await readFile(file, 'utf8')).toBe('{"a":1}\n');
  });

  it('leaves NO temp file behind after a successful write (rename, not copy)', async () => {
    await atomicWriteFile(file, 'hello');
    const entries = await readdir(dir);
    expect(entries).toEqual(['prefs.json']);
    expect(entries.some((e) => e.includes('.tmp'))).toBe(false);
  });

  it('fully replaces an existing file (no partial/append)', async () => {
    await writeFile(file, 'OLD-LONGER-CONTENT', 'utf8');
    await atomicWriteFile(file, 'new');
    expect(await readFile(file, 'utf8')).toBe('new');
  });

  it('no-corruption on write failure: original untouched, no temp left', async () => {
    await writeFile(file, 'ORIGINAL', 'utf8');
    const io = {
      writeFile: vi.fn(async () => {
        throw new Error('disk full');
      }),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    await expect(atomicWriteFile(file, 'NEW', { io })).rejects.toThrow('disk full');
    // original intact (we never truncated it — the failing write hit the temp)
    expect(await readFile(file, 'utf8')).toBe('ORIGINAL');
    expect(io.rename).not.toHaveBeenCalled();
    // temp cleanup attempted
    expect(io.unlink).toHaveBeenCalledTimes(1);
  });

  it('no-corruption on rename failure: original untouched, temp cleaned', async () => {
    await writeFile(file, 'ORIGINAL', 'utf8');
    const io = {
      writeFile: vi.fn(async () => {}),
      rename: vi.fn(async () => {
        throw new Error('rename failed');
      }),
      unlink: vi.fn(async () => {}),
    };
    await expect(atomicWriteFile(file, 'NEW', { io })).rejects.toThrow('rename failed');
    expect(await readFile(file, 'utf8')).toBe('ORIGINAL');
    expect(io.unlink).toHaveBeenCalledTimes(1); // temp cleanup attempted
  });

  it('writes to a temp in the SAME directory (atomic rename requires same fs)', async () => {
    const io = {
      writeFile: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    await atomicWriteFile(file, 'x', { io });
    const tmpPath = io.writeFile.mock.calls[0][0] as string;
    expect(tmpPath.startsWith(dir)).toBe(true);
    expect(tmpPath).not.toBe(file);
    expect(tmpPath).toContain('.tmp');
    // rename moves temp → target
    expect(io.rename).toHaveBeenCalledWith(tmpPath, file);
  });
});
