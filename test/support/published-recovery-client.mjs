import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installConsumerPackages } from './real-server.mjs';

export const publishedRecoveryClient = {
  version: '8.0.0',
  tarball: 'https://registry.npmjs.org/borgmcp/-/borgmcp-8.0.0.tgz',
  integrity: 'sha512-9C20JLFmeTa2cH6ZvJy6MQWZdkLHrtAuSDsaW54v7t9dyLBEkVpUCm7RpkayxD4k2Cd2U20XFfQS4bu/KbnkTg==',
};

export function verifyRecoveryClientTarball(bytes) {
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    publishedRecoveryClient.integrity, 'Recovery client must be the verified public release artifact');
}

export async function assertPublishedRecoveryClient(clientRoot, consumer) {
  const installed = await realpath(join(consumer, 'node_modules/borgmcp'));
  assert.equal(await realpath(clientRoot), installed, 'Recovery must execute the installed public client, not the source checkout');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'borgmcp');
  assert.equal(manifest.version, publishedRecoveryClient.version);
  assert.equal(manifest.dependencies['borgmcp-shared'], '3.0.0');
  const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/borgmcp'].integrity, publishedRecoveryClient.integrity,
    'Installed recovery client must retain the verified tarball integrity');
  return { source: 'installed-public', root: installed, version: manifest.version, integrity: publishedRecoveryClient.integrity };
}

export async function installPublishedRecoveryClient(consumer) {
  await mkdir(consumer, { recursive: true });
  await writeFile(join(consumer, 'package.json'), '{"name":"borg-recovery-e2e","private":true}\n');
  const response = await fetch(publishedRecoveryClient.tarball, { redirect: 'error' });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyRecoveryClientTarball(bytes);
  const tarball = join(consumer, 'borgmcp-8.0.0.tgz');
  await writeFile(tarball, bytes);
  installConsumerPackages(consumer, [tarball]);
  const clientRoot = join(consumer, 'node_modules/borgmcp');
  await assertPublishedRecoveryClient(clientRoot, consumer);
  return clientRoot;
}
