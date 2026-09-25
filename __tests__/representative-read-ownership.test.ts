// Production decoder/pagination/transport path with controlled HTTP and cursor persistence.
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from 'borgmcp-shared/protocol';
import { bindingFor, MockCube, CUBE_ID, REP_ID, COORD_ID } from './fixtures/representative-mock-backend.js';

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

let root: string;
const originalState = process.env.BORG_STATE_ROOT;
beforeEach(() => {
 root = realpathSync(mkdtempSync(join(tmpdir(), 'read-owner-')));
 process.env.BORG_STATE_ROOT = root;
 vi.resetModules();
});
afterEach(() => {
 if (originalState === undefined) delete process.env.BORG_STATE_ROOT; else process.env.BORG_STATE_ROOT = originalState;
 vi.doUnmock('../src/server-trust.js'); vi.doUnmock('../src/cubes.js'); vi.doUnmock('../src/local-server-cursor.js');
 rmSync(root, { recursive: true, force: true });
});

async function fixture(failure: 'page' | 'reset' | '429' = 'page', hold = true) {
 const binding = bindingFor(join(root, 'work'));
 const cube = new MockCube();
 const active = { cubeId:CUBE_ID, droneId:REP_ID, sessionToken:'s'.repeat(43), apiUrl:binding.origin, serverTrustIdentity:binding.trustIdentity };
 let entered!: () => void, release!: () => void;
 const reached = new Promise<void>(r => { entered=r; }), barrier = new Promise<void>(r => { release=r; });
 let cursor: any = null, pages=0;
 const advances: any[] = [];
 const entries = [1,2].map(i => ({ id:`aaaaaaaa-${i === 1 ? '1111' : '2222'}-4111-8111-111111111111`, cube_id:CUBE_ID, drone_id:COORD_ID,
   drone_label:'coordinator-1', role_name:'Coordinator', message:'reply', visibility:'direct', recipient_drone_ids:[REP_ID],
   created_at:`2026-09-01T00:0${i}:00.000Z` }));
 const envelope = (payload: any) => new Response(JSON.stringify({protocol_version:PROTOCOL_VERSION,request_id:'guard-response',payload}),{status:200});
 const fetchImpl = vi.fn(async (input: any, init: any) => {
  const path = new URL(String(input)).pathname;
  if(path.endsWith('/logs')) {
   pages++;
   if(pages===1 && hold) { entered(); await barrier; }
   if(pages===1 && failure==='reset') throw Object.assign(new Error('reset'), {code:'ECONNRESET'});
   if(pages===1 && failure==='429') return new Response('',{status:429,headers:{'retry-after':'0'}});
   const supplied = JSON.parse(init.body).payload.cursor;
   const index = supplied ? entries.findIndex(e => e.id===supplied.id)+1 : 0;
   const entry = entries[index];
   return envelope({entries:entry?[entry]:[],cursor:entry?{id:entry.id,created_at:entry.created_at}:supplied,behind_by:index===0?60:0,has_more:index===0});
  }
  if(path.endsWith('/roles'))return envelope({roles:cube.roles});
  if(path.endsWith('/drones'))return envelope({drones:cube.drones.map(d=>({...d,runtime_metadata_reported:false,agent_kind:null,reported_model:null,working_repo_name:null,working_repo_origin:null}))});
  return envelope({cube:{id:CUBE_ID,name:'mock-cube'}});
 });
 vi.doMock('../src/server-trust.js',()=>({loadBorgServerTrust:async()=>({identity:binding.trustIdentity,fetchImpl})}));
 vi.doMock('../src/cubes.js',()=>({getActiveCube:async()=>active}));
 vi.doMock('../src/local-server-cursor.js',()=>({getLocalServerCursor:async()=>cursor,advanceLocalServerCursor:async (_:any,next:any)=>{advances.push(next);cursor=next;}}));
 const { readLog } = await import('../src/remote-client.js');
 const { createSeatBackend } = await import('../src/representative-core.js');
 const { serveRepresentativeMcp } = await import('../src/representative-mcp.js');
 const { representativeOwnerDeps } = await import('../src/representative-owner.js');
 const { streamLockPath } = await import('../src/stream-owner.js');
 const { createRepresentativeStore } = await import('../src/representative-store.js');
 const store = createRepresentativeStore(join(root,'representative.json'));
 await store.saveBinding(binding,{rebind:false});
 const backend = await createSeatBackend(active as any);
 const connect = async () => {
  const client = new StdioClient();
  const server = await serveRepresentativeMcp({version:'test',stdin:client.stdin,stdout:client.stdout,context:async()=>({binding,backend,store})});
  await client.initialize(); return {client,server};
 };
 return { active, readLog, connect, reached, release, advances, entries, fetchImpl,
  pages:()=>pages,
  expire:()=>{const path=streamLockPath(CUBE_ID,REP_ID,representativeOwnerDeps(binding).locksDir)+'/owner.json';
   const record=JSON.parse(readFileSync(path,'utf8'));record.heartbeatAt='2000-01-01T00:00:00.000Z';writeFileSync(path,JSON.stringify(record));},
 };
}

it.each(['page','reset','429'] as const)('stops production read %s continuation after takeover and never advances the unread cursor', async failure => {
 const f = await fixture(failure);
 const old = await f.connect(), next = await f.connect();
 try {
  const pending = old.client.call('borg_representative-read');
  await f.reached;
  f.expire();
  // Invalid ack still acquires the successor lease, without changing the cursor.
  await next.client.call('borg_representative-ack',{entry_id:'invalid'});
  const requests = f.fetchImpl.mock.calls.length;
  f.release();
  expect((await pending).body.error.code).toBe('REPRESENTATIVE_OWNERSHIP_REQUIRED');
  expect(f.pages()).toBe(1);
  expect(f.fetchImpl).toHaveBeenCalledTimes(requests);
  expect(f.advances).toEqual([]);
  const result = await next.client.call('borg_representative-read');
  expect(result.isError).toBe(false);
  expect(result.body.replies.map((r:any)=>r.entry_id)).toEqual(f.entries.map(e=>e.id));
  // Slice 2: read is replayable; neither read touched the client unread cursor.
  expect(f.advances).toEqual([]);
  expect((await next.client.call('borg_representative-read')).body.replies.map((r:any)=>r.entry_id)).toEqual(f.entries.map(e=>e.id));
 } finally {f.release();await old.server.close();await next.server.close();}
});

it.each(['page','reset','429'] as const)('preserves unguarded ordinary unread %s pagination and cursor updates', async failure => {
 const f = await fixture(failure,false);
 const result = await f.readLog(f.active.sessionToken,f.active.apiUrl,{unreadOnly:true,serverTrustIdentity:f.active.serverTrustIdentity});
 expect(result.entries.map(e=>e.id)).toEqual(f.entries.map(e=>e.id));
 expect(result.digest).toBe(true);
 expect(f.pages()).toBe(failure==='page'?2:3);
 expect(f.advances).toHaveLength(2);
});

it('refuses a queued production cursor advance when ownership is lost before the lock is released', async () => {
 vi.doUnmock('../src/local-server-cursor.js');
 const { advanceLocalServerCursor } = await import('../src/local-server-cursor.js');
 const { unlink } = await import('node:fs/promises');
 const binding = { origin:'https://127.0.0.1:65530', trustIdentity:'sha256:mock-server', cubeId:CUBE_ID, droneId:REP_ID };
 const first = { id:'aaaaaaaa-1111-4111-8111-111111111111', created_at:'2026-09-01T00:01:00.000Z' };
 await advanceLocalServerCursor(binding, first);
 const file = join(root,'.config','borgmcp','local-server-cursors.json');
 const before = readFileSync(file,'utf8');
 writeFileSync(file+'.lock','held by control',{mode:0o600});
 let owned = true;
 const guard = async () => { if (!owned) throw new Error('ownership lost'); };
 const pending = advanceLocalServerCursor(binding, { ...first, id:'aaaaaaaa-2222-4222-8222-222222222222', created_at:'2026-09-01T00:02:00.000Z' }, guard);
 const result = pending.then(() => 'advanced', (error: Error) => error.message);
 owned = false;
 await unlink(file+'.lock');
 expect(await result).toBe('ownership lost');
 expect(readFileSync(file,'utf8')).toBe(before);
});
