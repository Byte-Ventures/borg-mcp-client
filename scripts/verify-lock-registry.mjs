import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockRegistryEntries } from './verify-release-readiness.mjs';

const DEFAULT_RETRY_DELAYS_MS = [250, 1_000, 3_000];

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

async function fetchRegistryMetadata(entry, fetchImpl, retryDelaysMs, sleep) {
  const endpoint = `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(endpoint, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
    });
    if (response.ok) return response.json();
    const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
    if (!retryable || attempt >= retryDelaysMs.length) {
      throw new Error(`Registry metadata returned HTTP ${response.status} for ${entry.name}@${entry.version}.`);
    }
    await sleep(retryDelaysMs[attempt]);
  }
}

export async function verifyLockRegistry(lockPath = 'package-lock.json', options = {}) {
  const lock = JSON.parse(await readFile(resolve(lockPath), 'utf8'));
  const entries = lockRegistryEntries(lock);
  const unique = new Map();
  for (const entry of entries) unique.set(`${entry.name}@${entry.version}`, entry);
  if (entries.length > 2048) throw new Error('Lockfile registry verification exceeds the dependency limit.');
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)));
  const concurrency = 8;
  let cursor = 0;
  const metadata = new Map();
  const uniqueEntries = [...unique.values()];
  const workers = Array.from({ length: Math.min(concurrency, uniqueEntries.length) }, async () => {
    while (cursor < uniqueEntries.length) {
      const entry = uniqueEntries[cursor++];
      metadata.set(
        `${entry.name}@${entry.version}`,
        await fetchRegistryMetadata(entry, fetchImpl, retryDelaysMs, sleep),
      );
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
