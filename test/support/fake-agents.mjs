import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export async function fakeCodex(socketPath, cwd) {
  const turns = [];
  const sockets = new Set();
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        let length = buffer[1] & 127;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2); offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2)); offset = 10;
        }
        const masked = (buffer[1] & 128) !== 0;
        const payloadStart = offset + (masked ? 4 : 0);
        if (buffer.length < payloadStart + length) return;
        const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));
        if (masked) for (let i = 0; i < length; i++) payload[i] ^= buffer[offset + i % 4];
        buffer = buffer.subarray(payloadStart + length);
        const message = JSON.parse(payload.toString());
        if (message.id === undefined) continue;
        let result;
        if (message.method === 'initialize') result = {};
        else if (message.method === 'thread/loaded/list') result = { data: ['user', 'system', 'subagent'] };
        else if (message.method === 'thread/read') {
          const id = message.params.threadId;
          const now = Math.floor(Date.now() / 1000);
          result = { thread: {
            id, cwd, status: { type: 'idle' }, preview: id === 'user' ? 'Borg task' : '',
            createdAt: id === 'user' ? 1 : now, updatedAt: id === 'user' ? 2 : now,
            ephemeral: id === 'system', threadSource: id === 'system' ? 'system' : 'user',
            source: id === 'subagent' ? { subagent: { other: 'guardian' } } : id === 'system' ? 'vscode' : 'cli',
          } };
        } else if (message.method === 'turn/start') {
          turns.push(message.params); result = {};
        } else throw new Error(`Unexpected Codex RPC: ${message.method}`);
        const reply = Buffer.from(JSON.stringify({ id: message.id, result }));
        const header = Buffer.alloc(reply.length < 126 ? 2 : 4);
        header[0] = 0x81;
        header[1] = reply.length < 126 ? reply.length : 126;
        if (header.length === 4) header.writeUInt16BE(reply.length, 2);
        socket.write(Buffer.concat([header, reply]));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  return { turns, async close() {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  } };
}

export async function fakeOpenCode(directory, password, launchIdentity) {
  const session = { id: 'ses_e2e', directory, time: { created: 1 } };
  const injections = [];
  const messages = [{ info: { role: 'user', id: 'launch' }, parts: [{
    type: 'text', text: 'kickoff', metadata: { borgOpenCodeLaunchCorrelation: launchIdentity },
  }] }];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.headers.authorization !== `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` || url.searchParams.get('directory') !== directory) {
      response.writeHead(403).end(); return;
    }
    let result;
    if (request.method === 'GET' && url.pathname === '/session') result = [session];
    else if (request.method === 'GET' && url.pathname === `/session/${session.id}`) result = session;
    else if (request.method === 'GET' && url.pathname === `/session/${session.id}/message`) result = messages;
    else if (request.method === 'POST' && url.pathname === `/session/${session.id}/prompt_async`) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      injections.push(input);
      messages.push({ info: { role: 'user', id: `message-${messages.length}` }, parts: input.parts });
      response.writeHead(204).end(); return;
    } else { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { injections, session, port: server.address().port, async close() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  } };
}
