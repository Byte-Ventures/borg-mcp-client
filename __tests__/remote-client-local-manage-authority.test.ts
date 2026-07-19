import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const LOG_ID = '44444444-4444-4444-8444-444444444444';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);
const PARENT = 'p'.repeat(43);

function envelope(payload: unknown, requestId = 'local-response-1') {
  return { protocol_version: '2', request_id: requestId, payload };
}

function errorEnvelope(code: string, message = 'server detail must not be surfaced') {
  return {
    protocol_version: '2',
    request_id: 'local-error-1',
    error: { code, message },
  };
}

describe('local manage-request authority', () => {
  const getServerCredential = vi.fn(async () => PARENT as string | null);
  let localFetch: ReturnType<typeof vi.fn>;
  let hostedFetch: ReturnType<typeof vi.fn>;
  let failure: { status: number; code: string } | null;

  beforeEach(() => {
    vi.resetModules();
    getServerCredential.mockClear();
    getServerCredential.mockResolvedValue(PARENT);
    failure = null;
    hostedFetch = vi.fn();
    vi.stubGlobal('fetch', hostedFetch);

    localFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      if (failure) {
        return new Response(JSON.stringify(errorEnvelope(failure.code)), {
          status: failure.status,
        });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/acks` && method === 'POST') {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/decisions` && method === 'POST') {
        return new Response(JSON.stringify(envelope({ decision: { topic: 'topology' } })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/taxonomy-patch` && method === 'POST') {
        return new Response(JSON.stringify(envelope({ cube: { id: CUBE_ID, name: 'local-cube' } })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'PATCH') {
        return new Response(JSON.stringify(envelope({ cube: { id: CUBE_ID, name: 'local-cube' } })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles` && method === 'POST') {
        return new Response(JSON.stringify(envelope({ role: { id: ROLE_ID, name: 'Builder' } })), { status: 201 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles/${ROLE_ID}` && method === 'PATCH') {
        return new Response(JSON.stringify(envelope({ role: { id: ROLE_ID, name: 'Builder' } })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles/${ROLE_ID}/section-patch` && method === 'POST') {
        return new Response(JSON.stringify(envelope({ role: { id: ROLE_ID, name: 'Builder' } })), { status: 200 });
      }
      throw new Error(`unexpected local request ${method} ${url.pathname}`);
    });

    vi.doMock('../src/config.js', () => ({ getServerCredential }));
    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({
        identity: TRUST_IDENTITY,
        fetchImpl: localFetch,
      })),
    }));
    vi.doMock('../src/cubes.js', () => ({
      getActiveCube: vi.fn(async () => ({
        cubeId: CUBE_ID,
        droneId: DRONE_ID,
        name: 'local-cube',
        droneLabel: 'coordinator-1',
        roleName: 'Coordinator',
        isHumanSeat: true,
        sessionToken: SESSION,
        apiUrl: ORIGIN,
        serverTrustIdentity: TRUST_IDENTITY,
      })),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses only the authority-bound parent credential for every mapped manage operation', async () => {
    const remote = await import('../src/remote-client.js');

    await remote.recordDecision(SESSION, ORIGIN, { topic: 'topology', decision: 'public repos' }, TRUST_IDENTITY);
    await remote.updateCube(CUBE_ID, { cube_directive: 'local only' });
    await remote.patchTaxonomyClass(CUBE_ID, {
      action: 'add',
      class_def: { class: 'qa', prefixes: ['QA:'], routing: 'broadcast' },
    });
    await remote.createRole(CUBE_ID, {
      name: 'Builder',
      short_description: 'builds',
      detailed_description: 'Build.',
    });
    await remote.updateRole(ROLE_ID, { short_description: 'builds carefully' });
    await remote.patchRoleSection(ROLE_ID, { action: 'replace', heading: 'Workflow', body: 'Build.' });
    expect(localFetch).toHaveBeenCalledTimes(6);
    for (const [, init] of localFetch.mock.calls) {
      const authorization = new Headers(init?.headers).get('Authorization');
      expect(authorization).toBe(`Bearer ${PARENT}`);
      expect(authorization).not.toContain(SESSION);
    }
    expect(getServerCredential).toHaveBeenCalledTimes(6);
    expect(getServerCredential).toHaveBeenCalledWith(ORIGIN, TRUST_IDENTITY);
    expect(hostedFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['decision', `record a decision in cube "local-cube"`, () => import('../src/remote-client.js').then((remote) =>
      remote.recordDecision(SESSION, ORIGIN, { topic: 'topology', decision: 'public repos' }, TRUST_IDENTITY)), 'Nothing was recorded.'],
    ['config', `update cube settings in cube "local-cube"`, () => import('../src/remote-client.js').then((remote) =>
      remote.updateCube(CUBE_ID, { cube_directive: 'local only' })), 'No cube settings were changed.'],
    ['taxonomy add', `add message class "qa" to cube "local-cube"`, () => import('../src/remote-client.js').then((remote) =>
      remote.patchTaxonomyClass(CUBE_ID, { action: 'add', class_def: { class: 'qa', prefixes: ['QA:'], routing: 'broadcast' } })), 'No message class was added.'],
    ['taxonomy replace', `replace message class "qa" in cube "local-cube"`, () => import('../src/remote-client.js').then((remote) =>
      remote.patchTaxonomyClass(CUBE_ID, { action: 'replace', class_def: { class: 'qa', prefixes: ['QA:'], routing: 'broadcast' } })), 'No message class was replaced.'],
    ['taxonomy remove', `remove message class "qa" from cube "local-cube"`, () => import('../src/remote-client.js').then((remote) =>
      remote.patchTaxonomyClass(CUBE_ID, { action: 'remove', class: 'qa' })), 'No message class was removed.'],
    ['role create', `create role "Builder" in cube "local-cube"`, () => import('../src/remote-client.js').then((remote) =>
      remote.createRole(CUBE_ID, { name: 'Builder', short_description: 'builds', detailed_description: 'Build.' })), 'No role was created.'],
    ['role update', `update role "${ROLE_ID}" in cube "local-cube"`, () => import('../src/remote-client.js').then((remote) =>
      remote.updateRole(ROLE_ID, { short_description: 'builds carefully' })), 'No role was updated.'],
    ['section insert', `insert section "Workflow" in role "${ROLE_ID}" in cube "local-cube"`, () => import('../src/remote-client.js').then((remote) =>
      remote.patchRoleSection(ROLE_ID, { action: 'insert', heading: 'Workflow', body: 'Build.' })), 'No role section was inserted.'],
    ['section replace', `replace section "Workflow" in role "${ROLE_ID}" in cube "local-cube"`, () => import('../src/remote-client.js').then((remote) =>
      remote.patchRoleSection(ROLE_ID, { action: 'replace', heading: 'Workflow', body: 'Build.' })), 'No role section was replaced.'],
    ['section delete', `delete section "Workflow" from role "${ROLE_ID}" in cube "local-cube"`, () => import('../src/remote-client.js').then((remote) =>
      remote.patchRoleSection(ROLE_ID, { action: 'delete', heading: 'Workflow' })), 'No role section was deleted.'],
  ])('maps exact ACCESS_DENIED 403 for a %s operation to actionable no-mutation copy', async (_kind, opening, call, noMutation) => {
    failure = { status: 403, code: 'ACCESS_DENIED' };

    const error = await call().then(() => null, (caught) => caught);
    expect(error).toMatchObject({
      name: 'LocalManageRequiredError',
      message: expect.stringContaining(`[LOCAL-MANAGE-REQUIRED] This session cannot ${opening} because`),
    });
    expect(error.message).toContain(noMutation);
    expect(error.message).toContain('Do not retry this request from this session.');
    expect(error.message).not.toContain(PARENT);
    expect(error.message).not.toContain('server detail must not be surfaced');
    expect(localFetch).toHaveBeenCalledTimes(1);
    expect(hostedFetch).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'NOT_FOUND'],
    [403, 'INVALID_INPUT'],
  ])('preserves unrelated HTTP %s %s failures', async (status, code) => {
    failure = { status, code };
    const { recordDecision } = await import('../src/remote-client.js');

    await expect(recordDecision(
      SESSION,
      ORIGIN,
      { topic: 'topology', decision: 'public repos' },
      TRUST_IDENTITY,
    )).rejects.toMatchObject({
      name: 'BorgServerHttpError',
      status,
      code,
    });
  });

  it('fails closed before network when the authority-bound parent credential is absent', async () => {
    getServerCredential.mockResolvedValue(null);
    const { recordDecision } = await import('../src/remote-client.js');

    await expect(recordDecision(
      SESSION,
      ORIGIN,
      { topic: 'topology', decision: 'public repos' },
      TRUST_IDENTITY,
    )).rejects.toMatchObject({
      name: 'LocalManageCredentialUnavailableError',
      message: expect.not.stringContaining('[LOCAL-MANAGE-REQUIRED]'),
    });
    expect(localFetch).not.toHaveBeenCalled();
    expect(hostedFetch).not.toHaveBeenCalled();
  });

  it('fails closed before network when the parent credential store is unreadable', async () => {
    getServerCredential.mockRejectedValue(new Error('credential store is unreadable'));
    const { recordDecision } = await import('../src/remote-client.js');

    await expect(recordDecision(
      SESSION,
      ORIGIN,
      { topic: 'topology', decision: 'public repos' },
      TRUST_IDENTITY,
    )).rejects.toMatchObject({
      name: 'LocalManageCredentialUnavailableError',
      message: expect.not.stringContaining('[LOCAL-MANAGE-REQUIRED]'),
    });
    expect(localFetch).not.toHaveBeenCalled();
    expect(hostedFetch).not.toHaveBeenCalled();
  });

  it('keeps ordinary drone coordination on the session credential', async () => {
    const { ackLogEntry } = await import('../src/remote-client.js');
    await ackLogEntry(SESSION, ORIGIN, LOG_ID, 'ack', TRUST_IDENTITY);

    expect(localFetch).toHaveBeenCalledTimes(1);
    const [, init] = localFetch.mock.calls[0];
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${SESSION}`);
    expect(getServerCredential).not.toHaveBeenCalled();
  });

  it('does not elevate local admin tools whose routes are not server-declared', async () => {
    const remote = await import('../src/remote-client.js');
    const unsupported = [
      () => remote.deleteCube(CUBE_ID),
      () => remote.deleteRole(ROLE_ID),
      () => remote.applyTemplate(CUBE_ID, 'software-dev'),
      () => remote.syncRoles(CUBE_ID, 'software-dev'),
      () => remote.removeDecision(SESSION, ORIGIN, { topic: 'topology' }, TRUST_IDENTITY),
      () => remote.reassignDrone(DRONE_ID, ROLE_ID),
      () => remote.evictDrone(DRONE_ID),
    ];

    for (const call of unsupported) {
      await expect(call()).rejects.toThrow(/Local Borg server does not support/);
    }
    expect(getServerCredential).not.toHaveBeenCalled();
    expect(localFetch).not.toHaveBeenCalled();
    expect(hostedFetch).not.toHaveBeenCalled();
  });
});
