/**
 * Seat operation-dimension namespacing in the collapsed single store (seats.ts).
 *
 * The client bearer digest is the sole server correlator, so distinct seats must
 * mint distinct bearers. A deliberate sibling attach therefore namespaces its
 * pending bearer apart from the durable in-place seat of the same
 * (origin, trust, cube, role) via the operation dimension — a distinct seat ref.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveGitRepositoryContext } from '../src/repository-identity.js';

const originalHome = process.env.HOME;
const fixtures: string[] = [];
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
  vi.resetModules();
});

async function load() {
  const dir = mkdtempSync(join(tmpdir(), 'borg-seat-op-'));
  fixtures.push(dir);
  process.env.HOME = dir;
  vi.resetModules();
  return { dir, seats: await import('../src/seats.js') };
}

const origin = 'https://127.0.0.1:7091';
const trustIdentity = 'spki-sha256:test-server';
const cubeId = '11111111-1111-4111-8111-111111111111';
const roleId = '22222222-2222-4222-8222-222222222222';
const binding = { origin, trustIdentity, cubeId };
const seatOperation = { projectRoot: '/work/repo', kind: 'seat' as const, operationKey: 'current-worktree' };
const siblingOperation = { projectRoot: '/work/repo', kind: 'sibling' as const, operationKey: 'named-sibling:review-1' };
const digestOf = (s: string) => createHash('sha256').update(s).digest('hex');
type Seats = typeof import('../src/seats.js');

function activate(
  seats: Seats,
  op: typeof seatOperation | typeof siblingOperation,
  bearer: string,
  drone: string,
  worktree: string,
  commonDir?: string,
  repositoryOrigin?: string,
  targetCubeId = cubeId,
) {
  return seats.activateAndBindSeat({
    origin, trustIdentity, cubeId: targetCubeId, roleId, operation: op,
    droneId: drone, sessionId: '44444444-4444-4444-8444-444444444444',
    expiresAt: '2026-07-15T20:30:00.000Z',
    expectedPendingDigest: digestOf(bearer), worktree, commonDir, repositoryOrigin, name: 'cube', droneLabel: 'd',
  });
}

describe('seat operation-dimension namespacing', () => {
  it('mints distinct bearers and refs for a seat vs a sibling of the same role', async () => {
    const { seats } = await load();
    const seat = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: seatOperation, credential: 'seat-bearer-'.padEnd(43, 'a') });
    const sibling = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: siblingOperation, credential: 'sib-bearer-'.padEnd(43, 'b') });
    expect(seat.credential).not.toBe(sibling.credential);

    const seatRefV = seats.seatRef({ origin, trustIdentity, cubeId, roleId, operation: seatOperation });
    const siblingRefV = seats.seatRef({ origin, trustIdentity, cubeId, roleId, operation: siblingOperation });
    // Distinct accounts: the sibling never collides onto the seat's bearer.
    expect(seatRefV).not.toBe(siblingRefV);

    expect(await activate(seats, seatOperation, seat.credential, '33333333-3333-4333-8333-333333333333', '/work/repo')).toBe('activated');
    expect(await activate(seats, siblingOperation, sibling.credential, '55555555-5555-4555-8555-555555555555', '/work/repo-sibling')).toBe('activated');

    // Each opaque reference resolves ONLY its own bearer.
    await expect(seats.getActiveSeatCredential(seatRefV, binding)).resolves.toBe(seat.credential);
    await expect(seats.getActiveSeatCredential(siblingRefV, binding)).resolves.toBe(sibling.credential);
  });

  it('C1: ignores a different repository in the same cube even when its common directory differs', async () => {
    const { seats } = await load();
    const seat = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: seatOperation, credential: 'seat-bearer-'.padEnd(43, 'a') });
    const sibling = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: siblingOperation, credential: 'sib-bearer-'.padEnd(43, 'b') });

    await activate(seats, seatOperation, seat.credential, '33333333-3333-4333-8333-333333333333', '/clone/repo-a', '/clone/repo-a/.git', 'https://github.com/org/repo-a');
    await activate(seats, siblingOperation, sibling.credential, '55555555-5555-4555-8555-555555555555', '/clone/repo-b', '/clone/repo-b/.git', 'https://github.com/org/repo-b');

    await expect(seats.hasActiveSeatInDifferentCloneFamily(
      cubeId,
      'https://github.com/org/repo-b',
      '/clone/repo-b/.git',
    )).resolves.toBe(false);
  });

  it('C2: detects the same repository in the same cube from a different clone family', async () => {
    const { seats } = await load();
    const repositoryOrigin = 'https://github.com/org/repo';
    const seat = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: seatOperation, credential: 'seat-bearer-'.padEnd(43, 'a') });
    const sibling = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: siblingOperation, credential: 'sib-bearer-'.padEnd(43, 'b') });

    await activate(seats, seatOperation, seat.credential, '33333333-3333-4333-8333-333333333333', '/clone-a/repo', '/clone-a/repo/.git', repositoryOrigin);
    await activate(seats, siblingOperation, sibling.credential, '55555555-5555-4555-8555-555555555555', '/clone-b/repo', '/clone-b/repo/.git', repositoryOrigin);

    await expect(seats.hasActiveSeatInDifferentCloneFamily(
      cubeId,
      repositoryOrigin,
      '/clone-b/repo/.git',
    )).resolves.toBe(true);
  });

  it('C3: canonicalizes SSH and HTTPS remotes to one persisted repository identity that detects the second clone', async () => {
    const { dir, seats } = await load();
    const contextFor = (root: string, commonDir: string, remote: string) => resolveGitRepositoryContext(root, {
      canonicalPath: async (value) => value,
      runGit: (_cwd, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') return { status: 0, stdout: `${root}\n` };
        if (command === 'rev-parse --is-bare-repository') return { status: 0, stdout: 'false\n' };
        if (command === 'rev-parse --path-format=absolute --git-common-dir') return { status: 0, stdout: `${commonDir}\n` };
        return { status: 0, stdout: `${remote}\n` };
      },
    });
    const ssh = await contextFor('/clone-ssh/repo', '/clone-ssh/repo/.git', 'git@github.com:Org/Repo.git');
    const https = await contextFor('/clone-https/repo', '/clone-https/repo/.git', 'https://github.com/Org/Repo.git');
    expect(ssh?.publicRepository).toEqual(https?.publicRepository);
    const repositoryOrigin = ssh?.publicRepository?.value;
    expect(repositoryOrigin).toBe('https://github.com/Org/Repo');

    const seat = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: seatOperation, credential: 'seat-bearer-'.padEnd(43, 'a') });
    const sibling = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: siblingOperation, credential: 'sib-bearer-'.padEnd(43, 'b') });
    await activate(seats, seatOperation, seat.credential, '33333333-3333-4333-8333-333333333333', ssh!.root, ssh!.commonDir, repositoryOrigin);
    await activate(seats, siblingOperation, sibling.credential, '55555555-5555-4555-8555-555555555555', https!.root, https!.commonDir, repositoryOrigin);

    const store = JSON.parse(readFileSync(join(dir, '.config', 'borgmcp', 'seats.json'), 'utf8')) as {
      seats: Record<string, { repositoryOrigin?: string }>;
    };
    expect(Object.values(store.seats).map((record) => record.repositoryOrigin)).toEqual([
      repositoryOrigin,
      repositoryOrigin,
    ]);
    await expect(seats.hasActiveSeatInDifferentCloneFamily(
      cubeId,
      repositoryOrigin!,
      https!.commonDir,
    )).resolves.toBe(true);
  });

  it('C4: ignores another worktree in the same clone family', async () => {
    const { seats } = await load();
    const repositoryOrigin = 'https://github.com/org/repo';
    const seat = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: seatOperation, credential: 'seat-bearer-'.padEnd(43, 'a') });
    const sibling = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: siblingOperation, credential: 'sib-bearer-'.padEnd(43, 'b') });

    await activate(seats, seatOperation, seat.credential, '33333333-3333-4333-8333-333333333333', '/clone/repo', '/clone/repo/.git', repositoryOrigin);
    await activate(seats, siblingOperation, sibling.credential, '55555555-5555-4555-8555-555555555555', '/clone/repo-sibling', '/clone/repo/.git', repositoryOrigin);

    await expect(seats.hasActiveSeatInDifferentCloneFamily(
      cubeId,
      repositoryOrigin,
      '/clone/repo/.git',
    )).resolves.toBe(false);
  });

  it('ignores a different clone family belonging to another cube', async () => {
    const { seats } = await load();
    const otherCubeId = '66666666-6666-4666-8666-666666666666';
    const repositoryOrigin = 'https://github.com/org/repo';
    const seat = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: seatOperation, credential: 'seat-bearer-'.padEnd(43, 'a') });
    const otherCubeSeat = await seats.mintPendingSeat({ origin, trustIdentity, cubeId: otherCubeId, roleId, operation: seatOperation, credential: 'other-bearer-'.padEnd(43, 'c') });

    await activate(seats, seatOperation, seat.credential, '33333333-3333-4333-8333-333333333333', '/clone/repo', '/clone/repo/.git', repositoryOrigin);
    await activate(seats, seatOperation, otherCubeSeat.credential, '77777777-7777-4777-8777-777777777777', '/other-clone/repo', '/other-clone/repo/.git', repositoryOrigin, otherCubeId);

    await expect(seats.hasActiveSeatInDifferentCloneFamily(cubeId, repositoryOrigin, '/clone/repo/.git')).resolves.toBe(false);
  });

  it('re-returns the exact same pending bearer for the same seat operation (retry-safe)', async () => {
    const { seats } = await load();
    const first = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: seatOperation, credential: 'k'.repeat(43) });
    const again = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: seatOperation, credential: 'DIFFERENT'.padEnd(43, 'z') });
    // A lost attach response re-sends the identical bearer the server already
    // digest-bound — no new seat, no rotation (the fresh credential is ignored).
    expect(again.credential).toBe(first.credential);
    expect(again.operation).toEqual(seatOperation);
  });

  it('clearing one seat operation does not disturb a sibling of the same role', async () => {
    const { seats } = await load();
    const seat = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: seatOperation, credential: 'seat-'.padEnd(43, 'a') });
    const sibling = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: siblingOperation, credential: 'sib-'.padEnd(43, 'b') });

    await seats.clearSeat(seats.seatRef({ origin, trustIdentity, cubeId, roleId, operation: seatOperation }));

    // The seat is force-freshened (new bearer); the sibling is untouched.
    const reseat = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: seatOperation, credential: 'reseat-'.padEnd(43, 'c') });
    const resibling = await seats.mintPendingSeat({ origin, trustIdentity, cubeId, roleId, operation: siblingOperation, credential: 'ignored-'.padEnd(43, 'x') });
    expect(reseat.credential).not.toBe(seat.credential);
    expect(resibling.credential).toBe(sibling.credential);
  });
});
