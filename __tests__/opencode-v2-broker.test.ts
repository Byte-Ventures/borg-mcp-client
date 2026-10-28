import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, readdirSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startOpenCodeV2Broker, readOpenCodeV2Descriptor, readOpenCodeV2PluginDescriptor, claimOpenCodeV2Session, callOpenCodeV2Broker } from '../src/opencode-v2-broker.js';
import { decodeOpenCodeV2Message } from '../src/opencode-v2-transport.js';
import { parseOpenCodeV2SessionArgs, openCodeV2LaunchOverlay } from '../src/opencode-v2-launch.js';

let root: string;
let broker: Awaited<ReturnType<typeof startOpenCodeV2Broker>> | undefined;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-v2-broker-'))); });
afterEach(async () => { await broker?.close(); broker = undefined; rmSync(root, { recursive: true, force: true }); });

async function fixture(prepareSession?: (id: string) => Promise<void>) {
  const seat = { worktree: root, cubeId: 'cube', droneId: 'drone' };
  const sessions = new Map<string, any>([['ses_root', { id: 'ses_root', location: { directory: root } }]]);
  const messages = new Map<string, any>();
  const inbox: any[] = [];
  let sequence = 0;
  const prompt = vi.fn(async (input: any) => { inbox.push({ id: input.id }); return { id: input.id }; });
  const transport: any = { nextMessageID: () => `msg_${++sequence}`,
    message: async (_session: string, id: string) => messages.get(id) ?? null,
    client: { session: { get: vi.fn(async ({ sessionID }) => {
      if (!sessions.has(sessionID)) throw new Error('Missing'); return sessions.get(sessionID);
    }), prompt, inbox: { list: vi.fn(async () => inbox) } } } };
  broker = await startOpenCodeV2Broker({ root, seat, transport, sessionID: 'ses_root', prepareSession, server: { pid: 123, version: '2.1.2' }, orientation: async () => 'Borg orientation' });
  await broker.call('/ready'); await broker.call('/catalog', { tools: ['borg_borg_log'] });
  return { seat, sessions, messages, inbox, prompt, transport, broker };
}

describe('OpenCode 2 session broker', () => {
  it('gives MCP only a private session capability and revokes it at shutdown', async () => {
    const { broker, seat } = await fixture();
    const descriptor = readOpenCodeV2Descriptor(broker.descriptorPath);
    const plugin = readOpenCodeV2PluginDescriptor(broker.descriptorPath + '.plugin', broker.pluginVerificationKey);
    expect(plugin.sessionID).toEqual(descriptor.sessionID);
    expect(plugin.capability).not.toBe(descriptor.capability);
    expect(descriptor.server).toEqual({ pid: 123, version: '2.1.2' });
    expect(await broker.call('/bind', { seat })).toMatchObject({ sessionID: 'ses_root', generation: 2 });
    await expect(broker.call('/bind', { seat: { ...seat, droneId: 'other' } })).rejects.toThrow();
    expect((await fetch(`${descriptor.url}/status`, { method: 'POST', body: '{}' })).status).toBe(403);
    await expect(broker.call('/api/session', {})).rejects.toThrow();
    await expect(callOpenCodeV2Broker(descriptor, '/human', { sessionID: 'ses_root', messageID: 'msg_forged' })).rejects.toThrow();
    await expect(callOpenCodeV2Broker(descriptor, '/audit', { sessionID: 'ses_root', id: 'forged', tool: 'shell', status: 'completed' })).rejects.toThrow();
    await broker.close();
    await expect(broker.call('/status')).rejects.toThrow();
    expect(readdirSync(root).some(name => name.endsWith('.json') && !name.includes('journal') && !name.includes('owner'))).toBe(false);
  });

  it('refuses a substituted plugin descriptor, a different launch key, and missing signature', async () => {
    const { broker } = await fixture();
    const filename = broker.descriptorPath + '.plugin';
    const original = readFileSync(filename, 'utf8');
    expect(() => readOpenCodeV2PluginDescriptor(filename, '')).toThrow('owning launch');
    const otherKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    expect(() => readOpenCodeV2PluginDescriptor(filename, otherKey)).toThrow('owning launch');
    const data = JSON.parse(original); data.url = 'http://127.0.0.1:12345';
    writeFileSync(filename, JSON.stringify(data));
    expect(() => readOpenCodeV2PluginDescriptor(filename, broker.pluginVerificationKey)).toThrow('owning launch');
    delete data.signature; writeFileSync(filename, JSON.stringify(data));
    expect(() => readOpenCodeV2PluginDescriptor(filename, broker.pluginVerificationKey)).toThrow('owning launch');
    writeFileSync(filename, original);
    await broker.selectSession('ses_root');
    expect(readOpenCodeV2PluginDescriptor(filename, broker.pluginVerificationKey).sessionID).toBe('ses_root');
  });

  it.skipIf(process.platform !== 'win32')('rechecks Windows file ACLs before activating plugin callbacks', async () => {
    const { broker } = await fixture();
    const filename = broker.descriptorPath + '.plugin';
    const original = readFileSync(filename, 'utf8');
    execFileSync('icacls.exe', [filename, '/grant', '*S-1-1-0:(R)'], { stdio: 'ignore' });
    await expect(broker.call('/mcp-options')).rejects.toThrow();
    rmSync(filename); writeFileSync(filename, original, { mode: 0o600 });
    await expect(broker.call('/mcp-options')).resolves.toEqual({});
  });

  it('persists native message intent before admission and reuses it after an ambiguous response', async () => {
    const { broker, prompt, messages, inbox } = await fixture();
    prompt.mockImplementationOnce(async (input) => {
      const journal = readFileSync(join(root, readdirSync(root).find(name => name.endsWith('.journal.json'))!), 'utf8');
      expect(journal).toContain(input.id); expect(journal).toContain('wake text');
      throw new Error('Lost response');
    });
    expect(await broker.call('/wake', { key: 'entry', text: 'wake text', allowSubmit: true })).toMatchObject({ accepted: false, id: 'msg_1' });
    expect(await broker.call('/wake', { key: 'entry', text: 'wake text', allowSubmit: true })).toMatchObject({ accepted: true, id: 'msg_1', delivered: false });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls.map(([input]) => input.id)).toEqual(['msg_1', 'msg_1']);
    expect(prompt.mock.calls[1][0]).toMatchObject({ delivery: 'steer', metadata: { borgOpenCodeWakeIdentity: 'msg_1' } });
    inbox.length = 0;
    messages.set('msg_1', { role: 'user', metadata: { borgOpenCodeWakeIdentity: 'msg_1' } });
    expect(await broker.call('/wake', { key: 'entry', text: 'wake text', allowSubmit: false })).toMatchObject({ delivered: true });
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('reconciles accepted inbox entries without submitting again across MCP reconnects', async () => {
    const { broker, prompt, seat } = await fixture();
    await broker.call('/wake', { key: 'entry', text: 'wake text', source: 'source' });
    await broker.call('/bind', { seat });
    await broker.call('/wake', { key: 'entry', text: 'wake text', allowSubmit: false });
    expect(prompt).toHaveBeenCalledTimes(1);
    await broker.call('/settle', { source: 'source' });
    expect(await broker.call('/status')).toMatchObject({ pending: 0 });
    await broker.call('/wake', { key: 'entry', text: 'wake text' });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('deduplicates changing reping nonces by durable source, including timeout, handoff and settlement', async () => {
    const { broker, prompt, sessions, messages, seat } = await fixture();
    prompt.mockImplementationOnce(async () => { throw new Error('Ambiguous admission'); });
    const first = await broker.call('/wake', { key: 'nonce1', source: 'log1', text: 'same text' });
    expect(first.accepted).toBe(false);
    const [second, third] = await Promise.all(['nonce2', 'nonce3'].map(key => broker.call('/wake', { key, source: 'log1', text: 'same text' })));
    expect(second.id).toBe(first.id); expect(third.id).toBe(first.id);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls.every(([input]) => input.id === first.id && input.sessionID === 'ses_root')).toBe(true);
    await broker.call('/bind', { seat });
    sessions.set('ses_new', { id: 'ses_new', location: { directory: root } });
    messages.set('msg_human', { role: 'user', metadata: {} });
    await broker.call('/human', { sessionID: 'ses_new', messageID: 'msg_human' });
    const repeat = await broker.call('/wake', { key: 'nonce4', source: 'log1', text: 'same text' });
    expect(repeat.id).toBe(first.id); expect(prompt).toHaveBeenCalledTimes(2);
    await broker.call('/settle', { source: 'log1' });
    expect(await broker.call('/wake', { key: 'nonce5', source: 'log1', text: 'same text' })).toMatchObject({ id: first.id, settled: true });
    await expect(broker.call('/wake', { key: 'nonce6', source: 'log1', text: 'changed' })).rejects.toThrow();
    await expect(broker.call('/wake', { key: 'nonce1', source: 'other', text: 'same text' })).rejects.toThrow();
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('prepares policy only after durable human proof and refuses a failed handoff', async () => {
    let release!: () => void;
    const prepare = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const { broker, sessions, messages } = await fixture(prepare);
    sessions.set('ses_new', { id: 'ses_new', location: { directory: root } });
    await broker.call('/human', { sessionID: 'ses_new', messageID: 'msg_human' });
    await broker.call('/status'); expect(prepare).not.toHaveBeenCalled();
    messages.set('msg_human', { role: 'user', metadata: {} });
    const context = broker.call('/context', { sessionID: 'ses_new' });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledWith('ses_new'));
    release(); expect((await context).text).toContain('Borg orientation');
    expect((await broker.call('/status')).sessionID).toBe('ses_new');
    sessions.set('ses_failed', { id: 'ses_failed', location: { directory: root } });
    messages.set('msg_failed', { role: 'user', metadata: {} });
    prepare.mockRejectedValueOnce(new Error('Policy refused'));
    await broker.call('/human', { sessionID: 'ses_failed', messageID: 'msg_failed' });
    await expect(broker.call('/wake', { key: 'failed', text: 'do not admit' })).rejects.toThrow();
  });

  it('counts actual completed nested operations once and resets only on a persisted log notification', async () => {
    const { broker } = await fixture();
    for (const [id, tool, status] of [['outer', 'execute', 'completed'], ['read', 'read', 'completed'], ['failed', 'shell', 'error'], ['1', 'shell', 'completed'], ['2', 'edit', 'completed'], ['3', 'write', 'completed'], ['3', 'write', 'completed']]) {
      await broker.call('/audit', { sessionID: 'ses_root', messageID: 'msg_a', id, tool, status });
    }
    expect((await broker.call('/context', { sessionID: 'ses_root' })).text).toContain('3+ state-changing');
    await broker.call('/audit', { sessionID: 'ses_root', messageID: 'msg_b', id: 'log', tool: 'borg_borg_log', status: 'completed' });
    expect((await broker.call('/context', { sessionID: 'ses_root' })).text).toContain('3+');
    await broker.call('/logged', { sessionID: 'ses_root' });
    expect((await broker.call('/context', { sessionID: 'ses_root' })).text).not.toContain('state-changing');
  });

  it('requires a durable human message for handoff and excludes native children and other worktrees', async () => {
    const { broker, sessions, messages } = await fixture();
    sessions.set('ses_new', { id: 'ses_new', location: { directory: root } });
    await broker.call('/human', { sessionID: 'ses_new', messageID: 'msg_human' });
    expect((await broker.call('/status')).sessionID).toBe('ses_root');
    messages.set('msg_human', { role: 'user', metadata: {} });
    expect((await broker.call('/status')).sessionID).toBe('ses_new');
    sessions.set('ses_child', { id: 'ses_child', parentID: 'ses_new', location: { directory: root } });
    await expect(broker.call('/human', { sessionID: 'ses_child', messageID: 'msg_child' })).rejects.toThrow();
    claimOpenCodeV2Session('ses_other', { worktree: root, cubeId: 'cube', droneId: 'other' }, root);
    sessions.set('ses_other', { id: 'ses_other', location: { directory: root } });
    await expect(broker.call('/human', { sessionID: 'ses_other', messageID: 'msg_other' })).rejects.toThrow();
  });

  it('counts shared-ID native Code Mode rows and does not recount work before a log inside the script', async () => {
    const { broker } = await fixture();
    const execution = { sessionID: 'ses_root', messageID: 'msg_code', id: 'outer-call' };
    await broker.call('/audit-begin', execution);
    for (let i = 0; i < 3; i++) await broker.call('/audit', { ...execution, tool: 'shell', status: 'completed' });
    await broker.call('/logged', { sessionID: 'ses_root' });
    await broker.call('/audit', { ...execution, tool: 'edit', status: 'completed' });
    const completed = { ...execution, tool: 'execute', status: 'completed', operations: [
      { tool: 'shell', status: 'completed' }, { tool: 'shell', status: 'completed' },
      { tool: 'shell', status: 'completed' }, { tool: 'edit', status: 'completed' },
    ] };
    await broker.call('/audit', completed); await broker.call('/audit', completed);
    expect((await broker.call('/context', { sessionID: 'ses_root' })).text).not.toContain('Heads up:');
    for (let i = 0; i < 2; i++) await broker.call('/audit', { sessionID: 'ses_root', messageID: 'msg_after', id: String(i), tool: 'write', status: 'completed' });
    expect((await broker.call('/context', { sessionID: 'ses_root' })).text).toContain('3+ state-changing');
  });

  it('refuses a bound session moved outside the drone worktree', async () => {
    const { broker, sessions } = await fixture();
    sessions.set('ses_root', { id: 'ses_root', location: { directory: realpathSync(tmpdir()) } });
    await expect(broker.call('/wake', { key: 'moved', text: 'wrong worktree' })).rejects.toThrow();
    await expect(broker.call('/status')).rejects.toThrow();
  });

  it.skipIf(process.platform !== 'win32')('accepts native Windows path spelling only for the same physical directory', async () => {
    const { broker, sessions, seat } = await fixture();
    sessions.set('ses_root', { id: 'ses_root', location: { directory: root.toLowerCase() } });
    expect(await broker.call('/bind', { seat })).toMatchObject({ sessionID: 'ses_root' });
  });

  it('refuses a non-private descriptor or a symlink', async () => {
    const { broker } = await fixture();
    const link = join(root, 'link.json'); symlinkSync(broker.descriptorPath, link);
    expect(() => readOpenCodeV2Descriptor(link)).toThrow();
    if (process.platform !== 'win32') {
      chmodSync(broker.descriptorPath, 0o644);
      expect(() => readOpenCodeV2Descriptor(broker.descriptorPath)).toThrow();
    }
  });
});

it('keeps host wire decoders separate and uses assistant content tool names', () => {
  expect(decodeOpenCodeV2Message({ info: { id: 'v1', role: 'user' }, parts: [] })).toBeNull();
  expect(decodeOpenCodeV2Message({ id: 'msg_a', type: 'assistant', content: [{ type: 'tool', id: 'call', name: 'shell', state: { status: 'completed' } }] })).toMatchObject({ tools: [{ name: 'shell', id: 'call', status: 'completed' }] });
});

it('consumes native continuation options before building a Borg-owned TUI launch', () => {
  expect(parseOpenCodeV2SessionArgs(['--session=ses_one', '--auto'])).toEqual({ sessionID: 'ses_one', continue: false, rest: ['--auto'] });
  expect(parseOpenCodeV2SessionArgs(['-c'])).toMatchObject({ continue: true });
  for (const args of [['--server=http://elsewhere'], ['--prompt', 'hello'], ['-s'], ['-c', '-s', 'ses_a']]) expect(() => parseOpenCodeV2SessionArgs(args)).toThrow();
});

it('preserves unrelated inline JSONC and an explicit direct-tool preference', () => {
  const overlay = openCodeV2LaunchOverlay({ OPENCODE_CONFIG_CONTENT: '{// comment\n"model":"local/test","mcp":{"servers":{"other":{"type":"local","command":["other"]},"borg":{"codemode":false}}},"plugins":["user-plugin"],"permissions":[{"action":"execute","resource":"*","effect":"deny"}]}' }, '/private/tmp/descriptor', '/private/tmp/plugin');
  const config = JSON.parse(overlay.OPENCODE_CONFIG_CONTENT!);
  expect(overlay.OPENCODE_DB).toBe(join('/private/tmp', 'opencode-v2.db'));
  expect(config.mcp.servers.borg.codemode).toBe(false);
  expect(config.mcp.servers.other.command).toEqual(['other']);
  expect(config.permissions).toEqual([{ action: 'execute', resource: '*', effect: 'deny' }]);
  expect(config.plugins).toEqual(['user-plugin', '/private/tmp/plugin']);
  expect(config.model).toBe('local/test');
  expect(config.mcp.servers.borg.environment).not.toHaveProperty('OPENCODE_SERVER_PASSWORD');
});
