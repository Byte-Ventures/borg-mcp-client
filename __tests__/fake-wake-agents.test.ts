import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { CodexAppServerClient } from '../src/codex-app-server';
import { pickFreshThread } from '../src/codex-wake-resolve';
import { fakeCodex, fakeOpenCode } from '../test/support/fake-agents.mjs';

it('fake Codex speaks the real adapter protocol and records the selected thread', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'borg-fake-'));
  const socket = join(directory, 'codex.sock');
  const fake = await fakeCodex(socket, '/repo');
  const client = new CodexAppServerClient(socket);
  try {
    await client.connect();
    const threads = await Promise.all((await client.loadedThreadIds()).map((id) => client.readThread(id)));
    expect(threads).toHaveLength(3);
    expect(threads[1]).toMatchObject({ ephemeral: true, threadSource: 'system' });
    const selected = pickFreshThread(threads.filter((thread) => thread !== null), { cwd: '/repo' });
    expect(selected).toBe('user');
    await client.startTurn(selected!, 'wake '.repeat(100));
    expect(fake.turns).toEqual([{ threadId: 'user', input: [{ type: 'text', text: 'wake '.repeat(100), text_elements: [] }] }]);
  } finally {
    client.close(); await fake.close(); await rm(directory, { recursive: true, force: true });
  }
});

it('fake OpenCode requires auth and persists injection metadata for confirmation', async () => {
  const password = randomBytes(32).toString('base64url');
  const fake = await fakeOpenCode('/repo', password, 'launch-id');
  const url = `http://127.0.0.1:${fake.port}/session/ses_e2e`;
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
  try {
    expect((await fetch(`${url}?directory=/repo`)).status).toBe(403);
    const parts = [{ type: 'text', text: 'wake', metadata: { borgOpenCodeInjectedEntry: true, borgOpenCodeWakeIdentity: 'entry-id' } }];
    expect((await fetch(`${url}/prompt_async?directory=/repo`, { method: 'POST', headers, body: JSON.stringify({ parts }) })).status).toBe(204);
    const messages = await (await fetch(`${url}/message?directory=/repo`, { headers })).json();
    expect(messages[1]).toMatchObject({ info: { role: 'user' }, parts });
    expect(fake.injections).toHaveLength(1);
  } finally { await fake.close(); }
});
