import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { assertPublishedRecoveryClient } from '../support/published-recovery-client.mjs';

if (process.env.BORG_E2E !== '1' || process.env.CI !== 'true' || process.platform !== 'linux') {
  throw new Error('Attachment fault/recovery execution is restricted to opt-in Linux CI');
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
const client = await assertPublishedRecoveryClient(input.clientRoot, input.clientConsumer);
const load = name => import(pathToFileURL(join(client.root, 'dist', name)).href);
const [seats, handshake, config, { loadBorgServerTrust }, { resolveGitRepositoryContext }, { finalizeAssimilationSeat }] = await Promise.all([
  load('seats.js'), load('server-handshake.js'), load('config.js'), load('server-trust.js'),
  load('repository-identity.js'), load('assimilate-cmd.js'),
]);
const trust = await loadBorgServerTrust(input.origin);
const parent = await config.getServerCredentialRecord(input.origin, trust.identity);
assert.ok(parent?.clientId);
const bin = join(process.env.BORG_STATE_ROOT, 'journey-bin');
await mkdir(bin, { recursive: true });
try { await symlink(join(client.root, 'dist/claude.js'), join(bin, 'borg')); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
assert.equal(await realpath(join(bin, 'borg')), await realpath(join(client.root, 'dist/claude.js')),
  'Printed recovery commands must execute the installed public entrypoint');
const agentAttempt = join(process.env.BORG_STATE_ROOT, 'unexpected-recovery-agent-invocation');
for (const name of ['claude', 'codex', 'opencode']) {
  await writeFile(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$RECOVERY_AGENT_ATTEMPT_FILE"\nexit 99\n', { mode: 0o755 });
}
const run = async (binary, args, cwd) => {
  const child = spawn(binary, args, { cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
    RECOVERY_AGENT_ATTEMPT_FILE: agentAttempt }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
};
const inspect = entry => handshake.reconcileBorgServerAttachment(input.origin, parent.credential, {
  receipt: entry.receipt, cube_id: entry.cubeId, role_id: entry.roleId, action: 'inspect',
}, trust.fetchImpl);
if (input.mode === 'crash-lock') {
  const { withStoreLock } = await load('seat-store.js');
  await withStoreLock(`${seats.SEATS_FILE}.lock`, async () => { process.exit(23); });
  throw new Error('Crash control did not terminate while holding the client lock');
}
if (input.mode === 'crash-refusal' || input.mode === 'crash-retry') {
  const before = await readFile(seats.SEATS_FILE, 'utf8');
  const lock = `${seats.SEATS_FILE}.lock`;
  const lockBefore = input.mode === 'crash-refusal' ? await readFile(lock, 'utf8') : null;
  const result = await run('/bin/sh', ['-c', input.command], input.source);
  if (input.mode === 'crash-refusal') {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /stale/);
    assert.match(result.stderr, /will NOT remove it automatically/);
    assert.ok(result.stderr.includes(lock), 'Product names the exact disposable lock for manual remediation');
    assert.equal(await readFile(seats.SEATS_FILE, 'utf8'), before);
    assert.equal(await readFile(lock, 'utf8'), lockBefore);
    console.log(JSON.stringify({ crashRefused: true, lockPath: lock, client }));
  } else {
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /original drone and session were reused/);
    const entry = await seats.readAttachmentAttempt({ attempt: input.attempt, origin: input.origin,
      trustIdentity: trust.identity, clientId: parent.clientId, worktree: input.source });
    assert.deepEqual(await inspect(entry), { disposition: 'finalized', drone_id: input.droneId, session_id: input.sessionId });
    console.log(JSON.stringify({ crashRecovered: true, droneId: input.droneId, sessionId: input.sessionId, client }));
  }
  await assert.rejects(access(agentAttempt), 'Recovery must not invoke an installed agent CLI');
  process.exit(0);
}
const observations = [];
for (const scenario of input.mode === 'crash-prepare' ? ['crash'] : ['reuse', 'unreserved-sibling', 'after-rename', 'ack-loss', 'missing', 'replaced', 'reserved-target-absent']) {
  const source = join(input.worktree, scenario);
  await mkdir(source, { recursive: true });
  assert.equal((await run('git', ['init', '-q', source], source)).code, 0);
  if (scenario === 'unreserved-sibling') {
    assert.equal((await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--allow-empty', '-qm', 'recovery fixture'], source)).code, 0);
  }
  const repository = await resolveGitRepositoryContext(source);
  assert.ok(repository);
  // Fresh --here currently retains an implicit-sibling operation namespace;
  // the explicit intended target, not that namespace, owns in-place recovery.
  const operation = { projectRoot: source, kind: 'sibling',
    operationKey: scenario === 'reserved-target-absent' ? `named-sibling:${scenario}` : `implicit-sibling:${randomUUID()}` };
  const target = scenario === 'reserved-target-absent' ? join(source, 'never-created') : scenario === 'unreserved-sibling' ? undefined : source;
  const seed = { origin: input.origin, trustIdentity: trust.identity, cubeId: input.cubeId, roleId: input.roleId,
    operation, credential: randomBytes(32).toString('base64url') };
  const pending = await seats.prepareSeat({ expected: { kind: 'absent' }, seed,
    attachment: { clientId: parent.clientId, ...(target === undefined ? {} : { targetWorktree: target }) } });
  assert.equal(pending.ok, true);
  const attempt = pending.record.attachmentAttempt;
  const prepared = await handshake.sendBorgServerAttach(input.origin, trust.identity, parent.credential, {
    cubeId: input.cubeId, roleId: input.roleId, operation,
  }, pending.record.credential, { fetchImpl: trust.fetchImpl,
    ...(scenario === 'ack-loss' ? { acknowledge: async entry => {
      await handshake.acknowledgeBorgServerAttachment(entry, parent.credential, trust.fetchImpl);
      throw new Error('Injected lost ACK response after server commit');
    } } : {}),
    ...(['reuse', 'unreserved-sibling', 'reserved-target-absent', 'crash'].includes(scenario)
      ? { activateAndBind: async () => { throw new Error('Injected local finalization failure before commit'); } } : {}),
  });
  const journal = await seats.readAttachmentAttempt({ attempt, origin: input.origin, trustIdentity: trust.identity,
    clientId: parent.clientId, worktree: source });
  assert.equal((await inspect(journal)).disposition, 'accepted');
  if (scenario === 'after-rename' || scenario === 'ack-loss') {
    if (prepared.initialLogCursor) {
      const { advanceLocalServerCursor } = await load('local-server-cursor.js');
      const binding = { origin: input.origin, trustIdentity: trust.identity, cubeId: input.cubeId, droneId: prepared.drone.id };
      await advanceLocalServerCursor(binding, prepared.initialLogCursor);
      await advanceLocalServerCursor({ ...binding, purpose: 'stream' }, prepared.initialLogCursor);
    }
  }
  if (scenario === 'missing' || scenario === 'replaced') {
    assert.equal(await prepared.bindPending({ worktree: source, commonDir: repository.commonDir,
      name: prepared.cube.name, droneLabel: prepared.drone.label }), 'bound');
    const observation = await seats.observeSeat(prepared.credentialRef,
      { origin: input.origin, trustIdentity: trust.identity, cubeId: input.cubeId });
    assert.equal((await seats.resetSeatForWorktree({ worktree: source, ref: prepared.credentialRef,
      droneId: prepared.drone.id, observation })).outcome, 'reset');
  }
  if (scenario === 'replaced') await seats.mintPendingSeat({ ...seed, credential: randomBytes(32).toString('base64url') });
  let printed = '';
  let removed = false;
  let bindOutcome;
  let renameFaults = 0;
  const originalRename = fsPromises.rename;
  if (scenario === 'after-rename') {
    fsPromises.rename = async (from, to) => {
      await originalRename(from, to);
      if (to === seats.SEATS_FILE && renameFaults++ < 2) {
        throw new Error('Injected post-rename durability ambiguity');
      }
    };
    syncBuiltinESMExports();
  }
  let outcome;
  try {
  outcome = await finalizeAssimilationSeat({
    activeCube: { cubeId: input.cubeId, droneId: prepared.drone.id, name: prepared.cube.name, droneLabel: prepared.drone.label,
      apiUrl: input.origin, localSessionCredentialRef: prepared.credentialRef },
    apiUrl: input.origin, repositoryContext: repository, sessionExpected: { kind: 'absent' },
    result: { cube_id: input.cubeId, drone_id: prepared.drone.id, drone_label: prepared.drone.label, role_id: input.roleId,
      local_session: { credential_ref: prepared.credentialRef, attachment_attempt: attempt }, finalize: prepared },
    rollbackWorktree: () => { removed = true; },
  }, { cwd: () => source, findProjectRoot: () => source, stderr: text => { printed += text; },
    finalizeServerSeat: async ({ activate }) => {
      try {
        bindOutcome = await activate({ worktree: target ?? source, commonDir: repository.commonDir,
          name: prepared.cube.name, droneLabel: prepared.drone.label });
      } catch { bindOutcome = 'injected-before-commit'; }
      return bindOutcome === 'activated' ? { committed: true } : { committed: false, reason: 'activation-failed' };
    } });
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(outcome.kind, 'stop');
  assert.equal(bindOutcome, scenario === 'missing' ? 'missing' : scenario === 'replaced' ? 'replaced' :
    scenario === 'after-rename' ? 'indeterminate' : scenario === 'ack-loss' ? 'ack-pending' : 'injected-before-commit');
  if (scenario === 'after-rename') assert.equal(renameFaults, 2);
  assert.equal(removed, false);
  const command = printed.match(/Run: (borg recover-attachment[^\n]+)/)?.[1];
  assert.ok(command, 'Execute the real finalizer-printed command, never a reconstructed command');
  if (scenario === 'crash') {
    console.log(JSON.stringify({ command, source, attempt, droneId: prepared.drone.id, sessionId: prepared.session.sessionId, client }));
    process.exit(0);
  }
  const before = await readFile(seats.SEATS_FILE, 'utf8');
  const first = await run('/bin/sh', ['-c', command], source);
  if (['reuse', 'unreserved-sibling', 'after-rename', 'ack-loss'].includes(scenario)) {
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, scenario === 'after-rename' || scenario === 'ack-loss' ? /already active/ : /original drone and session were reused/);
    const finalized = await inspect(journal);
    assert.deepEqual(finalized, { disposition: 'finalized', drone_id: prepared.drone.id, session_id: prepared.session.sessionId });
    const after = await seats.readAttachmentAttempt({ attempt, origin: input.origin, trustIdentity: trust.identity,
      clientId: parent.clientId, worktree: source });
    assert.ok(after.targetWorktree);
    if (scenario !== 'unreserved-sibling') assert.equal(after.targetWorktree, source, 'In-place intent must not create a sibling');
    else assert.notEqual(after.targetWorktree, source, 'Sibling intent must not overwrite its source binding');
    assert.equal((await resolveGitRepositoryContext(after.targetWorktree)).commonDir, repository.commonDir);
    assert.equal((await seats.getActiveSeatForWorktree(after.targetWorktree)).droneId, prepared.drone.id);
    const replay = await handshake.sendBorgServerAttach(input.origin, trust.identity, parent.credential,
      { cubeId: input.cubeId, roleId: input.roleId, operation }, pending.record.credential, { fetchImpl: trust.fetchImpl });
    assert.equal(replay.session.sessionId, prepared.session.sessionId);
    assert.deepEqual(replay.initialLogCursor, prepared.initialLogCursor);
    if (prepared.initialLogCursor) {
      const { getLocalServerCursor } = await load('local-server-cursor.js');
      const binding = { origin: input.origin, trustIdentity: trust.identity, cubeId: input.cubeId, droneId: prepared.drone.id };
      assert.deepEqual(await getLocalServerCursor(binding), prepared.initialLogCursor);
      assert.deepEqual(await getLocalServerCursor({ ...binding, purpose: 'stream' }), prepared.initialLogCursor);
    }
    const repeated = await run('/bin/sh', ['-c', command], source);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /already active/);
  } else {
    assert.equal(first.code, 1);
    assert.match(first.stderr, /--retire/);
    assert.equal(await readFile(seats.SEATS_FILE, 'utf8'), before, 'Default recovery cannot scrub pending state or overwrite replacement');
    const cleanup = first.stderr.match(/run: (borg recover-attachment[^\n]+)/i)?.[1];
    assert.ok(cleanup);
    const retired = await run('/bin/sh', ['-c', `${cleanup} --yes`], source);
    assert.equal(retired.code, 0, retired.stderr);
    assert.match(retired.stdout, /failed attachment is retired/);
    assert.equal((await inspect(journal)).disposition, 'retired');
    const late = await trust.fetchImpl(new URL('/api/client/attach', input.origin), {
      method: 'POST', headers: { Authorization: `Bearer ${parent.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify((await import('borgmcp-shared')).createProtocolEnvelope(randomUUID(), {
        cube_id: input.cubeId, role_id: input.roleId, session_credential: pending.record.credential,
      })),
    });
    assert.equal(late.status, 409, 'Retirement fences the original late attach');
    assert.equal((await late.json()).error.code, 'ATTACHMENT_RETIRED');
    await assert.rejects(handshake.reconcileBorgServerAttachment(input.origin, parent.credential, {
      receipt: journal.receipt, cube_id: input.cubeId, role_id: input.roleId, action: 'finalize',
    }, trust.fetchImpl), error => error.code === 'ATTACHMENT_RETIRED');
    if (scenario === 'replaced') {
      assert.deepEqual(JSON.parse(await readFile(seats.SEATS_FILE, 'utf8')).seats, JSON.parse(before).seats);
    }
    if (scenario === 'reserved-target-absent') await assert.rejects(access(target));
  }
  observations.push({ scenario, bindOutcome, droneId: prepared.drone.id, recovered: true });
}
await assert.rejects(access(agentAttempt), 'Recovery must not invoke an installed agent CLI');
console.log(JSON.stringify({ attachmentRecovery: observations, client }));
