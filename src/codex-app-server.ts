import net from 'node:net';
import crypto from 'node:crypto';

export interface CodexThreadSummary {
  id: string;
  cwd: string;
  preview: string;
  status: { type: string };
  updatedAt: number;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export class CodexAppServerClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private handshaken = false;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor(private readonly socketPath: string) {}

  async connect(): Promise<void> {
    if (this.socket) return;
    this.socket = net.createConnection(this.socketPath);
    this.socket.on('data', (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.parseIncoming();
    });
    this.socket.on('error', (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.socket!.once('error', onError);
      this.socket!.once('connect', () => {
        this.socket!.off('error', onError);
        const key = crypto.randomBytes(16).toString('base64');
        this.socket!.write(
          [
            'GET / HTTP/1.1',
            'Host: localhost',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n')
        );
        resolve();
      });
    });

    await this.waitForHandshake();
    await this.request('initialize', {
      clientInfo: { name: 'borgmcp', version: '0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized', {});
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }

  async loadedThreadIds(): Promise<string[]> {
    const result = await this.request('thread/loaded/list', {});
    return Array.isArray(result?.data) ? result.data.filter((id: any) => typeof id === 'string') : [];
  }

  async readThread(threadId: string): Promise<CodexThreadSummary | null> {
    const result = await this.request('thread/read', { threadId, includeTurns: false });
    const thread = result?.thread;
    if (!thread || typeof thread.id !== 'string') return null;
    return {
      id: thread.id,
      cwd: thread.cwd,
      preview: thread.preview,
      status: thread.status,
      updatedAt: thread.updatedAt,
    };
  }

  async startTurn(threadId: string, text: string): Promise<void> {
    await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
  }

  private waitForHandshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (this.handshaken) return resolve();
        if (Date.now() - started > 5_000) return reject(new Error('Timed out waiting for Codex app-server websocket handshake'));
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  private request(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    this.writeJson({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Timed out waiting for Codex app-server response to ${method}`));
      }, 5_000);
    });
  }

  private notify(method: string, params: any): void {
    this.writeJson({ method, params });
  }

  private writeJson(value: any): void {
    if (!this.socket) throw new Error('Codex app-server socket is not connected');
    this.socket.write(encodeWebSocketTextFrame(JSON.stringify(value)));
  }

  private parseIncoming(): void {
    if (!this.handshaken) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      this.buffer = this.buffer.slice(end + 4);
      this.handshaken = true;
    }

    while (this.buffer.length >= 2) {
      const parsed = decodeWebSocketTextFrame(this.buffer);
      if (!parsed) return;
      this.buffer = this.buffer.slice(parsed.consumed);
      let message: any;
      try {
        message = JSON.parse(parsed.text);
      } catch {
        continue;
      }
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message ?? 'Codex app-server request failed'));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }
}

export async function findLoadedCodexThread(options: {
  socketPath: string;
  cwd: string;
  previewIncludes: string;
  updatedAfter: number;
}): Promise<string | null> {
  const client = new CodexAppServerClient(options.socketPath);
  await client.connect();
  try {
    const ids = await client.loadedThreadIds();
    let best: CodexThreadSummary | null = null;
    for (const id of ids) {
      const thread = await client.readThread(id);
      if (!thread) continue;
      if (thread.cwd !== options.cwd) continue;
      if (!thread.preview.includes(options.previewIncludes)) continue;
      if (thread.updatedAt < options.updatedAfter) continue;
      if (!best || thread.updatedAt > best.updatedAt) best = thread;
    }
    return best?.id ?? null;
  } finally {
    client.close();
  }
}

function encodeWebSocketTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x81;
  const mask = crypto.randomBytes(4);
  const framed = Buffer.alloc(header.length + mask.length + payload.length);
  header.copy(framed, 0);
  mask.copy(framed, header.length);
  for (let i = 0; i < payload.length; i += 1) {
    framed[header.length + mask.length + i] = payload[i] ^ mask[i % mask.length];
  }
  return framed;
}

function decodeWebSocketTextFrame(buffer: Buffer): { text: string; consumed: number } | null {
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const masked = (buffer[1] & 0x80) !== 0;
  let mask: Buffer | null = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + payloadLength) return null;
  let payload = buffer.slice(offset, offset + payloadLength);
  if (mask) {
    payload = Buffer.from(payload.map((byte, index) => byte ^ mask![index % 4]));
  }
  return { text: payload.toString('utf8'), consumed: offset + payloadLength };
}
