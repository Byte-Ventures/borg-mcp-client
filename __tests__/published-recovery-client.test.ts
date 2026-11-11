import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPublishedRecoveryClient, publishedRecoveryClient, verifyRecoveryClientTarball } from '../test/support/published-recovery-client.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('refuses a source checkout even when it has the same package name and version as the installed client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'published-recovery-selection-'));
  roots.push(root);
  const installed = join(root, 'consumer/node_modules/borgmcp');
  const source = join(root, 'source');
  for (const directory of [installed, source]) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'borgmcp', version: '8.0.0', dependencies: { 'borgmcp-shared': '3.0.0' } }));
  }
  await writeFile(join(root, 'consumer/package-lock.json'), JSON.stringify({ packages: {
    'node_modules/borgmcp': { integrity: publishedRecoveryClient.integrity },
  } }));
  expect(await assertPublishedRecoveryClient(installed, join(root, 'consumer'))).toMatchObject({ source: 'installed-public', version: '8.0.0' });
  await expect(assertPublishedRecoveryClient(source, join(root, 'consumer'))).rejects.toThrow('not the source checkout');
});

it('refuses substituted artifact bytes and an installed lock with different artifact integrity', async () => {
  expect(() => verifyRecoveryClientTarball(Buffer.from('substituted release'))).toThrow('verified public release artifact');
  const root = await mkdtemp(join(tmpdir(), 'published-recovery-integrity-'));
  roots.push(root);
  const installed = join(root, 'node_modules/borgmcp');
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'borgmcp', version: '8.0.0', dependencies: { 'borgmcp-shared': '3.0.0' } }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/borgmcp': { integrity: 'sha512-substituted' } } }));
  await expect(assertPublishedRecoveryClient(installed, root)).rejects.toThrow('verified tarball integrity');
});
