import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createProtocolEnvelope } from 'borgmcp-shared/protocol';
import { installTestServer, openRealServer } from '../../test/support/real-server.mjs';
import { fakeCodex, fakeOpenCode } from '../../test/support/fake-agents.mjs';

const enabled = process.env.BORG_E2E === '1';
const root = resolve(import.meta.dirname, '../..');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => Promise<unknown> | unknown, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

it.skipIf(!enabled)('delivers and drains a real ten-seat fleet through MCP, SSE and agent wake endpoints', async () => {
  // An explicit guard prevents accidental server execution on an operator machine.
  expect(process.env.CI).toBe('true');
  expect(process.platform).toBe('linux');
  const temporary = await mkdtemp(join(tmpdir(), 'borg-e2e-'));
  const cleanups: Array<() => Promise<unknown>> = [];
  const children: ReturnType<typeof spawn>[] = [];
  const fleet: any[] = [];
  const stop = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  const run = async (args: string[], env: NodeJS.ProcessEnv, input?: unknown) => {
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = ''; let stderr = '';
    child.stdout!.on('data', (data) => { stdout += data; });
    child.stderr!.on('data', (data) => { stderr += data; });
    child.stdin!.end(input === undefined ? undefined : JSON.stringify(input));
    const [code] = await once(child, 'exit');
    if (code !== 0) throw new Error(`Fixture subprocess exited ${code}: ${stderr}`);
    return stdout;
  };
  const tool = async (seat: any, name: string, args = {}) => {
    const result = await seat.mcp.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
    return result.structuredContent as any;
  };
  const drain = async (seat: any, limit = 5) => {
    const ids: string[] = []; let pages = 0;
    for (;;) {
      const page = await tool(seat, 'borg_read-log', { unread_only: true, limit });
      ids.push(...page.entries.map((entry: any) => entry.id)); pages++;
      if (!page.has_more) return { ids, pages };
      expect(pages).toBeLessThan(100);
    }
  };
  const wakeCount = (seat: any, marker: string) => {
    const prompts = seat.kind === 'claude' ? seat.monitorOutput.split('\n')
      : seat.kind === 'codex' ? seat.agent.turns.map((turn: any) => turn.input.map((part: any) => part.text).join(''))
      : seat.agent.injections.map((input: any) => input.parts.map((part: any) => part.text).join(''));
    return prompts.filter((text: string) => text.includes(marker)).length;
  };
  try {
    const serverRoot = await installTestServer(join(temporary, 'consumer'));
    const data = join(temporary, 'server');
    let owner: any;
    const setup = await openRealServer(serverRoot, data, async (record: any) => { owner = record; });
    const listener = createServer();
    listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = (listener.address() as any).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const origin = `https://127.0.0.1:${port}`;
    const replayConnections = new Set<ReturnType<typeof createConnection>>();
    const replayProxy = createServer((downstream) => {
      const upstream = createConnection({ host: '127.0.0.1', port });
      for (const socket of [downstream, upstream]) {
        replayConnections.add(socket);
        socket.on('error', () => { downstream.destroy(); upstream.destroy(); });
        socket.on('close', () => { replayConnections.delete(socket); downstream.destroy(); upstream.destroy(); });
      }
      downstream.pipe(upstream); upstream.pipe(downstream);
    });
    replayProxy.listen(0, '127.0.0.1'); await once(replayProxy, 'listening');
    const replayOrigin = `https://127.0.0.1:${(replayProxy.address() as any).port}`;
    cleanups.push(async () => {
      for (const socket of replayConnections) socket.destroy();
      await new Promise<void>((resolve) => replayProxy.close(() => resolve()));
    });
    const invitations: string[] = [];
    for (let index = 0; index < 10; index++) {
      invitations.push(setup.authority.createInvitationArtifactForOwnerCredential(owner.credential, 900_000, index === 3 ? replayOrigin : origin,
        setup.bootstrap.caFingerprint, `fleet-${index}`));
    }
    setup.close();
    const serverEnv = { ...process.env, BORG_SERVER_DATA_DIR: data, HOME: temporary, BORG_STATE_ROOT: temporary };
    const serverEntry = join(serverRoot, 'dist/main.js');
    const server = spawn(process.execPath, [serverEntry, 'start', '--host', '127.0.0.1', '--port', String(port)], { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(server);
    let serverOutput = '';
    server.stdout!.on('data', (chunk) => { serverOutput += chunk; });
    server.stderr!.on('data', (chunk) => { serverOutput += chunk; });
    const ca = await readFile(join(data, 'ca.crt'));
    const api = (path: string, payload?: unknown) => new Promise<any>((resolve, reject) => {
      const request = httpsRequest(`${origin}${path}`, { ca, method: payload ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${owner.credential}`, 'Content-Type': 'application/json' } }, (response) => {
        let text = ''; response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => {
          if (response.statusCode! >= 400) reject(new Error(`${path}: ${response.statusCode} ${text}`));
          else resolve(text ? JSON.parse(text).payload : null);
        });
      });
      request.on('error', reject);
      request.end(payload ? JSON.stringify(createProtocolEnvelope(randomUUID(), payload)) : undefined);
    });
    await until(async () => {
      if (server.exitCode !== null) throw new Error(serverOutput);
      try { await api('/healthz'); return true; } catch { return false; }
    }, 'real server health');
    const cube = await api('/api/cubes', { retry_key: randomUUID(), name: 'wake-e2e', working_repo_name: 'wake-e2e',
      repository: { kind: 'local', value: randomUUID() }, template: 'starter' });

    for (let index = 0; index < 10; index++) {
      const kind = index < 4 ? 'claude' : index < 8 ? 'codex' : 'opencode';
      const home = join(temporary, `seat-${index}`);
      const worktree = join(home, 'worktree');
      await mkdir(join(worktree, '.git'), { recursive: true });
      await mkdir(join(home, 'tmp'));
      const env = { ...process.env, HOME: home, BORG_STATE_ROOT: home, BORG_SERVER_DATA_DIR: data,
        TMPDIR: join(home, 'tmp'), XDG_CONFIG_HOME: join(home, '.config'), CODEX_HOME: join(home, '.codex'),
        BORG_SESSION: '1', BORG_AGENT_KIND: kind } as NodeJS.ProcessEnv;
      delete env.BORG_LAUNCH_EXPECTED_SEAT;
      const seat: any = { kind, home, worktree, env, monitorOutput: '' };
      fleet.push(seat);
      if (kind === 'codex') {
        const socket = join(home, 'codex.sock');
        seat.agent = await fakeCodex(socket, worktree);
        await writeFile(join(home, 'codex.pid'), String(process.pid));
        cleanups.push(() => seat.agent.close());
        env.BORG_CODEX_REMOTE_WAKE = '1'; env.BORG_CODEX_APP_SERVER_SOCKET = socket;
      } else if (kind === 'opencode') {
        const password = randomBytes(32).toString('base64url');
        const identity = randomBytes(32).toString('base64url');
        seat.agent = await fakeOpenCode(worktree, password, identity);
        cleanups.push(() => seat.agent.close());
        Object.assign(env, { BORG_OPENCODE_PORT: String(seat.agent.port), OPENCODE_SERVER_USERNAME: 'opencode',
          OPENCODE_SERVER_PASSWORD: password, BORG_OPENCODE_LAUNCH_CORRELATION: identity });
      }
      const fixture = join(root, 'test/support/provision-wake-seat.mjs');
      const args = { clientRoot: root, origin: index === 3 ? replayOrigin : origin, name: `fleet-${index}`, worktree, cubeId: cube.cube_id, roleId: cube.default_worker_role_id };
      const enrolled = JSON.parse(await run([fixture], env, { ...args, mode: 'enroll', invitation: invitations[index] }));
      seat.clientId = enrolled.clientId;
      await run([serverEntry, 'client-grant', enrolled.clientId, cube.cube_id, 'write'], serverEnv);
      Object.assign(seat, JSON.parse(await run([fixture], env, { ...args, mode: 'attach' })));
      const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist/index.js')], cwd: worktree,
        env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: 'pipe' });
      seat.mcp = new Client({ name: 'wake-e2e', version: '1' }, { capabilities: { roots: {} } });
      seat.mcp.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(worktree).href }] }));
      cleanups.push(() => seat.mcp.close());
      await seat.mcp.connect(transport);
      await until(async () => (await tool(seat, 'borg_stream-status')).status.connected, `${kind} SSE connection`);
      if (kind === 'claude') {
        const status = await tool(seat, 'borg_stream-status');
        seat.monitor = spawn(process.execPath, [join(root, 'dist/inbox-monitor.js'), '--state-root', status.monitor_state_root, seat.inboxPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(seat.monitor);
        seat.monitor.stdout.on('data', (chunk: Buffer) => { seat.monitorOutput += chunk; });
        await until(async () => (await tool(seat, 'borg_stream-status')).inbox_monitor_healthy === true, 'Claude monitor');
      }
      await drain(seat);
    }
    expect(new Set(fleet.map((seat) => seat.clientId)).size).toBe(10);
    expect(new Set(fleet.map((seat) => seat.credentialHash)).size).toBe(10);
    for (const seat of fleet) await drain(seat);
    await pause(1000); // tail -F must be armed before the first test entry.
    const author = fleet[0];
    const broadcast = await tool(author, 'borg_log', { message: 'E2E-broadcast', to: 'broadcast' });
    await until(() => fleet.slice(1).every((seat) => wakeCount(seat, 'E2E-broadcast') === 1), 'broadcast on nine agent endpoints');
    await until(async () => (await tool(author, 'borg_stream-status')).status.lastPersistedEventId === broadcast.entry.id, 'author observes its silent broadcast');
    expect(wakeCount(author, 'E2E-broadcast')).toBe(0);
    for (const seat of fleet) {
      expect((await drain(seat)).ids.filter((id) => id === broadcast.entry.id)).toHaveLength(1);
      expect((await drain(seat)).ids).toEqual([]);
    }
    const recipients = [fleet[1], fleet[4], fleet[8]];
    const direct = await tool(author, 'borg_log', { message: 'E2E-direct', to: recipients.map((seat) => seat.droneId) });
    await until(() => recipients.every((seat) => wakeCount(seat, 'E2E-direct') === 1), 'direct recipients');
    await until(async () => (await Promise.all(fleet.map((seat) => tool(seat, 'borg_stream-status'))))
      .every((status) => status.status.lastPersistedEventId === direct.entry.id), 'all seats observe the direct frame');
    await pause(1000);
    for (const seat of fleet) {
      if (!recipients.includes(seat)) expect(wakeCount(seat, 'E2E-direct')).toBe(0);
      expect((await drain(seat)).ids.filter((id) => id === direct.entry.id)).toHaveLength(1);
      expect((await drain(seat)).ids).toEqual([]);
    }
    const ackBefore = await Promise.all(fleet.map(async (seat) => (await readFile(seat.inboxPath, 'utf8').catch(() => '')).length));
    const observed = (seat: any) => seat.kind === 'claude' ? seat.monitorOutput.length
      : seat.kind === 'codex' ? seat.agent.turns.length : seat.agent.injections.length;
    const ackWakeBefore = fleet.map(observed);
    const authorMonitorBefore = author.monitorOutput.length;
    await tool(fleet[1], 'borg_ack', { entry_id: direct.entry.id });
    await until(async () => (await readFile(author.inboxPath, 'utf8').catch(() => '')).length > ackBefore[0], 'ack at author');
    await until(() => author.monitorOutput.length > authorMonitorBefore, 'ack wakes author monitor');
    await pause(1000);
    for (let index = 1; index < fleet.length; index++) {
      expect((await readFile(fleet[index].inboxPath, 'utf8')).length).toBe(ackBefore[index]);
      expect(observed(fleet[index])).toBe(ackWakeBefore[index]);
    }
    const backlog: string[] = [];
    for (let index = 0; index < 12; index++) {
      const entry = await tool(author, 'borg_log', { message: `E2E-backlog-${index}`, to: [fleet[2].droneId] });
      backlog.push(entry.entry.id);
    }
    const paged = await drain(fleet[2], 3);
    expect(paged.pages).toBeGreaterThan(1);
    expect(paged.ids).toEqual(backlog);
    expect((await drain(fleet[2])).ids).toEqual([]);

    // Drop the seat's real TLS/SSE connection mid-burst without restarting MCP.
    const replaySeat = fleet[3];
    const replayIds: string[] = [];
    for (let index = 0; index < 8; index++) {
      if (index === 3) {
        expect(replayConnections.size).toBeGreaterThan(0);
        for (const socket of replayConnections) socket.destroy();
      }
      const entry = await tool(author, 'borg_log', { message: `E2E-replay-${index}`, to: [replaySeat.droneId] });
      replayIds.push(entry.entry.id);
    }
    await until(async () => {
      const inbox = await readFile(replaySeat.inboxPath, 'utf8');
      return replayIds.every((id) => inbox.includes(id));
    }, 'replayed inbox');
    const replayInbox = await readFile(replaySeat.inboxPath, 'utf8');
    for (const id of replayIds) expect(replayInbox.split(id).length - 1).toBe(1);
    const replayDrain = await drain(replaySeat);
    for (const id of replayIds) expect(replayDrain.ids.filter((value) => value === id)).toHaveLength(1);
    expect((await drain(replaySeat)).ids).toEqual([]);
    expect((await tool(fleet[1], 'borg_stream-status')).wake_path.healthy).toBe(true);
    await stop(fleet[1].monitor);
    await until(async () => (await tool(fleet[1], 'borg_stream-status')).wake_path.healthy === false, 'stopped monitor degradation');
    expect((await tool(fleet[4], 'borg_stream-status')).wake_path.healthy).toBe(true);
    await fleet[4].agent.close();
    await until(async () => (await tool(fleet[4], 'borg_stream-status')).wake_path.healthy === false, 'missing Codex bridge');
    for (const seat of fleet.filter((seat) => seat.kind === 'codex')) {
      expect(seat.agent.turns.length).toBeGreaterThan(0);
      expect(seat.agent.turns.every((turn: any) => turn.threadId === 'user')).toBe(true);
    }
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    for (const child of children.reverse()) await stop(child);
    await rm(temporary, { recursive: true, force: true });
  }
}, 120_000);
