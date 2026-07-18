/**
 * Cross-process store-lock contender (RULED option b). Acquires the SINGLE store
 * flock via withStoreLock, then does a read-modify-write of a shared counter file
 * inside the critical section with a widened window. If the flock did not provide
 * mutual exclusion across processes, concurrent contenders would lose an update and
 * the final count would be < N. Correctness comes from the atomic O_EXCL acquire +
 * live-holder wait alone (no reclaim, no stealing).
 */
import { atomicWrite0600, readStoreFile, withStoreLock } from '../../src/seat-store.js';

const lockPath = process.argv[2];
const counterPath = process.argv[3];
if (!lockPath || !counterPath) {
  throw new Error('seat-store-lock-child requires <lockPath> <counterPath>');
}

await withStoreLock(
  lockPath,
  async () => {
    const raw = await readStoreFile(counterPath);
    const current = raw ? (JSON.parse(raw).n as number) : 0;
    // Widen the critical-section window so a lost update would surface if two
    // processes were ever inside the lock simultaneously.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await atomicWrite0600(counterPath, JSON.stringify({ n: current + 1 }));
  },
  { attempts: 500, waitMs: 5 },
);

process.stdout.write('ok');
process.exit(0);
