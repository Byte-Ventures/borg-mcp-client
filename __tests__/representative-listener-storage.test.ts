import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindingFor } from './fixtures/representative-mock-backend.js';
let root: string | undefined;
afterEach(async () => {
  vi.doUnmock('node:fs/promises'); vi.unstubAllEnvs(); vi.resetModules();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
it.each(['symlink', 'file'])('refuses a hostile exclusive temp %s without overwriting it or its outside target', async kind => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'listener-leaf-')));
  vi.stubEnv('BORG_STATE_ROOT', root); vi.resetModules();
  const target = join(root, 'outside'); await fs.writeFile(target, 'SENTINEL');
  let attacked = false;
  vi.doMock('node:fs/promises', () => ({ ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const path = String(args[0]);
    if (!attacked && path.endsWith('.tmp')) { attacked = true; if (kind === 'symlink') await fs.symlink(target, path); else await fs.writeFile(path, 'FOREIGN', { mode: 0o600 }); }
    return fs.open(...args);
  } }));
  const modulePath = '../src/representative-listener-store.js';
  const { createListenerInbox } = await import(modulePath);
  const inbox = createListenerInbox(bindingFor(join(root, 'work')));
  await expect(inbox.append({ id: '55555555-5555-4555-8555-555555555555', created_at: '2026-01-01T00:00:00.000Z',
    message: 'test', visibility: 'direct', drone_label: 'sender', role_name: 'role', documents: [] })).rejects.toThrow();
  expect(attacked).toBe(true); expect(await fs.readFile(target, 'utf8')).toBe('SENTINEL');
});

it.each([1, 2, 3])('recovers after publication boundary %i without a duplicate append', async boundary => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'listener-crash-')));
  vi.stubEnv('BORG_STATE_ROOT', root); vi.resetModules();
  let publications = 0;
  vi.doMock('node:fs/promises', () => ({ ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    await fs.rename(...args);
    if (++publications === boundary) throw new Error('simulated process death after atomic publication');
  } }));
  const modulePath = '../src/representative-listener-store.js';
  const { createListenerInbox } = await import(modulePath);
  const binding = bindingFor(join(root, 'work'));
  const value = { id: '55555555-5555-4555-8555-555555555555', created_at: '2026-01-01T00:00:00.000Z', message: 'SENTINEL', visibility: 'direct', drone_label: 'sender', role_name: 'role' };
  await expect(createListenerInbox(binding).append(value)).rejects.toThrow('simulated process death');
  const recovered = createListenerInbox(binding);
  const hint = await recovered.append(value);
  expect(hint === null).toBe(boundary >= 2);
  expect((await fs.readFile(recovered.paths.inbox, 'utf8')).trim().split('\n')).toHaveLength(1);
  expect((await recovered.cursor()).id).toBe(value.id);
  const replay = await recovered.replay('00000000-0000-4000-8000-000000000000');
  expect(replay.hints).toHaveLength(1); expect(JSON.stringify(replay)).not.toContain('SENTINEL');
});
it('replays surviving lines with nullable metadata after state loss', async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'listener-metadata-')));
  vi.stubEnv('BORG_STATE_ROOT', root); vi.resetModules();
  const modulePath = '../src/representative-listener-store.js';
  const { createListenerInbox } = await import(modulePath);
  const inbox = createListenerInbox(bindingFor(join(root, 'work')));
  await inbox.append({ id: '55555555-5555-4555-8555-555555555555', created_at: '2026-01-01T00:00:00.000Z', message: 'SENTINEL', visibility: 'direct', drone_label: 'sender', role_name: 'role' });
  await fs.rm(inbox.paths.state);
  const replay = await inbox.replay('00000000-0000-4000-8000-000000000000');
  expect(replay.hints[0]).toMatchObject({ visibility: null, documents: null, replay: true });
  expect(JSON.stringify(replay)).not.toContain('SENTINEL');
});
