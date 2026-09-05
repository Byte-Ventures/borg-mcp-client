import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

// Invoked only by the opt-in CI suite, in a separate process per state root.
if (process.env.BORG_E2E !== '1' || process.env.CI !== 'true' || process.platform !== 'linux') {
  throw new Error('Real-server provisioning is restricted to opt-in Linux CI');
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
const load = (name) => import(pathToFileURL(join(input.clientRoot, 'dist', name)).href);
const handshake = await load('server-handshake.js');
if (input.mode === 'enroll') {
  const enrolled = await handshake.enrollLocalBorgServer(input.origin, input.invitation, { clientName: input.name });
  console.log(JSON.stringify({ clientId: enrolled.clientId }));
} else {
  const [{ getServerCredentialRecord }, seats, { loadBorgServerTrust }, cubes] = await Promise.all([
    load('config.js'), load('seats.js'), load('server-trust.js'), load('cubes.js'),
  ]);
  const parent = await getServerCredentialRecord(input.origin);
  assert.ok(parent);
  const trust = await loadBorgServerTrust(input.origin);
  const operation = { projectRoot: input.worktree, kind: 'seat', operationKey: input.name };
  const credential = randomBytes(32).toString('base64url');
  await seats.mintPendingSeat({ origin: input.origin, trustIdentity: trust.identity,
    cubeId: input.cubeId, roleId: input.roleId, operation, credential });
  const attached = await handshake.sendBorgServerAttach(input.origin, trust.identity, parent.credential,
    { cubeId: input.cubeId, roleId: input.roleId, operation }, credential, { fetchImpl: trust.fetchImpl });
  assert.equal(await attached.activate({ worktree: input.worktree, name: attached.cube.name,
    droneLabel: attached.drone.label, roleName: attached.role.name, roleClass: attached.role.role_class,
    isHumanSeat: attached.role.is_human_seat }), 'activated');
  if (process.env.BORG_AGENT_KIND === 'opencode') {
    const openCode = await load('opencode-drone.js');
    await openCode.connectOpenCodeDrone({ serverUrl: `http://127.0.0.1:${process.env.BORG_OPENCODE_PORT}`,
      apiPassword: process.env.OPENCODE_SERVER_PASSWORD, directory: input.worktree,
      droneLabel: attached.drone.label, cubeName: attached.cube.name,
      launchIdentity: process.env.BORG_OPENCODE_LAUNCH_CORRELATION });
    assert.equal(await openCode.injectInitialKickoff({ prompt: 'kickoff', correlationIdentity: process.env.BORG_OPENCODE_LAUNCH_CORRELATION }), true);
  }
  console.log(JSON.stringify({ droneId: attached.drone.id, label: attached.drone.label,
    credentialHash: createHash('sha256').update(credential).digest('hex'),
    inboxPath: cubes.inboxPathForDrone(input.cubeId, attached.drone.id) }));
}
