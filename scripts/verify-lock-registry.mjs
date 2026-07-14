import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockRegistryEntries } from './verify-release-readiness.mjs';

export function verifyRegistryMetadata(entry, metadata) {
  if (metadata?.name !== entry.name || metadata?.version !== entry.version) {
    throw new Error(`Registry identity mismatch for ${entry.name}@${entry.version}.`);
  }
  if (metadata.dist?.tarball !== entry.tarball) {
    throw new Error(`Registry tarball mismatch for ${entry.name}@${entry.version}.`);
  }
  if (metadata.dist?.integrity !== entry.integrity) {
    throw new Error(`Registry integrity mismatch for ${entry.name}@${entry.version}.`);
  }
}

export async function verifyLockRegistry(lockPath = 'package-lock.json', options = {}) {
  const lock = JSON.parse(await readFile(resolve(lockPath), 'utf8'));
  const entries = lockRegistryEntries(lock);
  const unique = new Map();
  for (const entry of entries) unique.set(`${entry.name}@${entry.version}`, entry);
  if (entries.length > 2048) throw new Error('Lockfile registry verification exceeds the dependency limit.');
  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = 8;
  let cursor = 0;
  const metadata = new Map();
  const uniqueEntries = [...unique.values()];
  const workers = Array.from({ length: Math.min(concurrency, uniqueEntries.length) }, async () => {
    while (cursor < uniqueEntries.length) {
      const entry = uniqueEntries[cursor++];
      const endpoint = `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`;
      const response = await fetchImpl(endpoint, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Registry metadata returned HTTP ${response.status} for ${entry.name}@${entry.version}.`);
      metadata.set(`${entry.name}@${entry.version}`, await response.json());
    }
  });
  await Promise.all(workers);
  for (const entry of entries) verifyRegistryMetadata(entry, metadata.get(`${entry.name}@${entry.version}`));
  return { packages: entries.length };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyLockRegistry(process.argv[2]), null, 2));
}
