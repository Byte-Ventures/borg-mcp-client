/**
 * End-to-end stdio JSON-RPC tests for the restricted human-representative MCP
 * facade. Frames travel through the real MCP SDK stdio transport over in-process
 * streams. The Borg backend is a controlled MOCK (see the fixture); nothing here
 * is evidence of acceptance by a real Borg server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  BUILDER_ID,
  COORD_ID,
  MockCube,
  OTHER_CUBE_ID,
  REP_ID,
  bindingFor,
} from './fixtures/representative-mock-backend.js';
import { RepresentativeError, type RepresentativeContext } from '../src/representative-core.js';
import { createRepresentativeStore } from '../src/representative-store.js';
import { REPRESENTATIVE_TOOL_NAMES, serveRepresentativeMcp } from '../src/representative-mcp.js';

const originalHome = process.env.HOME;
const originalStateRoot = process.env.BORG_STATE_ROOT;
const WORKTREE = '/work/hermes-representative';
const REQUEST_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
let root: string;
let cube: MockCube;
let storePath: string;

class StdioClient {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  private buffer = '';
  private nextId = 1;
  private waiting = new Map<number, (message: any) => void>();
  rawLines: string[] = [];

  constructor() {
    this.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        this.rawLines.push(line);
        const message = JSON.parse(line);
        this.waiting.get(message.id)?.(message);
        this.waiting.delete(message.id);
      }
    });
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    const response = new Promise<any>((resolve) => this.waiting.set(id, resolve));
    this.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return response;
  }

  notify(method: string): void {
    this.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async initialize(): Promise<any> {
    const response = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'generic-mcp-host', version: '0.0.0' },
    });
    this.notify('notifications/initialized');
    return response;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: any }> {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error) return { isError: true, body: response.error };
    const text = response.result.content[0].text as string;
    return { isError: response.result.isError === true, body: JSON.parse(text) };
  }
}

async function connect(context?: () => Promise<RepresentativeContext>) {
  const client = new StdioClient();
  const provider = context ?? (async () => ({
    binding: bindingFor(WORKTREE),
    backend: cube.backend(),
    store: createRepresentativeStore(storePath),
  }));
  const server = await serveRepresentativeMcp({
    context: provider,
    stdin: client.stdin,
    stdout: client.stdout,
    version: '0.0.0-test',
  });
  return { client, server };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-representative-mcp-')));
  process.env.HOME = root;
  process.env.BORG_STATE_ROOT = root;
  storePath = join(root, '.config', 'borgmcp', 'representative.json');
  cube = new MockCube();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT;
  else process.env.BORG_STATE_ROOT = originalStateRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('representative stdio MCP (mock backend)', () => {
  it('initializes and lists only the restricted representative tools', async () => {
    const { client, server } = await connect();
    const init = await client.initialize();
    expect(init.result.serverInfo.name).toBe('borg-human-representative');
    expect(init.result.instructions).toContain('human representative');
    expect(init.result.instructions).toContain('not the Coordinator');

    const listed = await client.request('tools/list');
    const names = listed.result.tools.map((tool: any) => tool.name).sort();
    expect(names).toEqual([...REPRESENTATIVE_TOOL_NAMES].sort());
    expect(names).toEqual([
      'borg_representative-ack',
      'borg_representative-deliver',
      'borg_representative-read',
      'borg_representative-send',
      'borg_representative-status',
    ]);
    for (const tool of listed.result.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('to');
    }
    const surface = JSON.stringify(listed.result.tools);
    for (const forbidden of ['borg_log', 'borg_tool', 'evict', 'reassign', 'grant', 'release', 'create-role', 'regen']) {
      expect(names.join(' ')).not.toContain(forbidden);
    }
    expect(surface).not.toMatch(/bearer|session[_ ]?token/i);
    await server.close();
  });

  it('round-trips a human request and the Coordinator reply, then acknowledges it', async () => {
    const { client, server } = await connect();
    await client.initialize();

    const status = await client.call('borg_representative-status');
    expect(status.isError).toBe(false);
    expect(status.body.coordinator.drone_id).toBe(COORD_ID);
    expect(status.body.representative.drone_id).toBe(REP_ID);
    expect(status.body.delivery).toContain('deliver');
    expect(status.body.binding_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const sent = await client.call('borg_representative-send', {
      request_id: REQUEST_ID,
      kind: 'question',
      authorization: 'user_authorized',
      message: 'Should the release wait for the fix?',
    });
    expect(sent.isError).toBe(false);
    expect(sent.body.outcome).toBe('sent');
    expect(cube.appendCalls[0].to).toEqual([COORD_ID]);

    cube.post(BUILDER_ID, 'unrelated worker traffic', [REP_ID]);
    const reply = cube.post(COORD_ID, `request_id ${REQUEST_ID}: yes, wait.`, [REP_ID]);

    const read = await client.call('borg_representative-read');
    expect(read.body.replies).toEqual([
      expect.objectContaining({ entry_id: reply.id, in_reply_to: REQUEST_ID, addressed: 'direct' }),
    ]);
    expect(JSON.stringify(read.body)).not.toContain('unrelated worker traffic');

    const acked = await client.call('borg_representative-ack', { entry_id: reply.id });
    expect(acked.isError).toBe(false);
    expect(cube.acks).toEqual([reply.id]);
    await server.close();
  });

  it('refuses wrong-recipient, broadcast, and non-representative tool calls', async () => {
    const { client, server } = await connect();
    await client.initialize();
    const base = { kind: 'request', authorization: 'user_authorized', message: 'Build it.' };
    for (const extra of [{ to: [BUILDER_ID] }, { to: 'broadcast' }]) {
      const refused = await client.call('borg_representative-send', { ...base, ...extra });
      expect(refused.isError).toBe(true);
      expect(refused.body.error.code).toBe('INVALID_INPUT');
    }
    for (const name of ['borg_log', 'borg_tool', 'borg_evict-drone']) {
      const refused = await client.call(name, { message: 'x', to: 'broadcast' });
      expect(refused.isError).toBe(true);
    }
    expect(cube.appendCalls).toHaveLength(0);
    await server.close();
  });

  it('fails closed on a cross-cube seat without sending', async () => {
    cube.whoamiCubeId = OTHER_CUBE_ID;
    const { client, server } = await connect();
    await client.initialize();
    const refused = await client.call('borg_representative-send', {
      kind: 'request', authorization: 'user_authorized', message: 'Build it.',
    });
    expect(refused.isError).toBe(true);
    expect(refused.body.error.code).toBe('BINDING_MISMATCH');
    expect(cube.appendCalls).toHaveLength(0);
    await server.close();
  });

  it('fails every tool closed when the connection context cannot be established', async () => {
    const { client, server } = await connect(async () => {
      throw new RepresentativeError('NOT_PREPARED', 'No representative connection is prepared for this worktree.');
    });
    await client.initialize();
    for (const name of REPRESENTATIVE_TOOL_NAMES) {
      const refused = await client.call(name, name.endsWith('-ack') ? { entry_id: REQUEST_ID } : {});
      expect(refused.isError).toBe(true);
    }
    await server.close();
  });

  it('surfaces an ambiguous send, survives reconnect, and resolves by same-id retry without duplication', async () => {
    cube.appendPlan = ['lost-response'];
    const first = await connect();
    await first.client.initialize();
    const input = { request_id: REQUEST_ID, kind: 'request', authorization: 'user_authorized', message: 'Do X.' };
    const ambiguous = await first.client.call('borg_representative-send', input);
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.body.outcome).toBe('ambiguous');
    expect(ambiguous.body.request_id).toBe(REQUEST_ID);
    expect(cube.appendCalls).toHaveLength(1);
    await first.server.close();

    const second = await connect();
    await second.client.initialize();
    const status = await second.client.call('borg_representative-status');
    expect(status.body.unresolved_requests.map((r: any) => r.request_id)).toEqual([REQUEST_ID]);

    const fresh = await second.client.call('borg_representative-send', { ...input, request_id: undefined });
    expect(fresh.isError).toBe(true);
    expect(fresh.body.error.code).toBe('AMBIGUOUS_SEND_UNRESOLVED');

    const retried = await second.client.call('borg_representative-send', input);
    expect(retried.isError).toBe(false);
    expect(retried.body.deduplicated).toBe(true);
    expect(cube.entries.filter((entry) => entry.drone_id === REP_ID)).toHaveLength(1);
    await second.server.close();
  });

  it('stores one message when a host fires two overlapping no-id sends of the same content', async () => {
    cube.verifyDelayMs = 60;
    const { client, server } = await connect();
    await client.initialize();
    const args = { kind: 'request', authorization: 'user_authorized', message: 'Do X.' };
    const [one, two] = await Promise.all([
      client.call('borg_representative-send', args),
      client.call('borg_representative-send', args),
    ]);
    const ok = [one, two].filter((r) => !r.isError);
    const refused = [one, two].filter((r) => r.isError);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].body.error.code).toBe('AMBIGUOUS_SEND_UNRESOLVED');
    expect(refused[0].body.error.message).toContain(ok[0].body.request_id);
    expect(cube.entries.filter((entry) => entry.drone_id === REP_ID)).toHaveLength(1);
    await server.close();
  });

  it('reports a typed refusal with its cause and recovery through the tool result', async () => {
    const { BorgServerError } = await import('../src/server-errors.js');
    cube.appendPlan = [{ error: new BorgServerError('SESSION_REVOKED', 'the selected Borg server revoked this worktree session'), stored: false }];
    const { client, server } = await connect();
    await client.initialize();
    const refused = await client.call('borg_representative-send', { kind: 'request', authorization: 'user_authorized', message: 'Do X.' });
    expect(refused.isError).toBe(true);
    expect(refused.body.error.code).toBe('SEND_REJECTED');
    expect(refused.body.error.details).toMatchObject({ cause_code: 'SESSION_REVOKED' });
    expect(refused.body.error.details.recovery).toContain('borg representative prepare');
    await server.close();
  });

  it('replays an undelivered reply until deliver, with no by-id read path', async () => {
    const entry = cube.post(COORD_ID, 'A reply to relay now', [REP_ID]);
    const { client, server } = await connect();
    const init = await client.initialize();
    const read = await client.call('borg_representative-read', {});
    expect(read.body.replies[0].entry_id).toBe(entry.id);
    expect((await client.call('borg_representative-read', { entry_id: entry.id })).body.error.code).toBe('INVALID_INPUT');
    expect((await client.call('borg_representative-read', {})).body.replies.map((r: any) => r.entry_id)).toEqual([entry.id]);
    const delivered = await client.call('borg_representative-deliver', { through: entry.id });
    expect(delivered.body).toMatchObject({ advanced: true, binding_fingerprint: read.body.binding_fingerprint });
    expect((await client.call('borg_representative-read', {})).body.replies).toEqual([]);
    expect(init.result.instructions).not.toMatch(/fetched\s+again only by its entry_id/);
    expect(read.body.delivery).not.toMatch(/fetched\s+again only by its entry_id/);
    await server.close();
  });

  it('writes nothing but JSON-RPC frames to stdout', async () => {
    const { client, server } = await connect();
    await client.initialize();
    await client.call('borg_representative-status');
    for (const line of client.rawLines) expect(JSON.parse(line).jsonrpc).toBe('2.0');
    await server.close();
  });
});
