import type { OpenCodeClient } from '@opencode/client';
import type { OpenCodeV2Server } from './opencode-v2-server.js';

/** Borg records deliberately do not expose either host's wire message shape. */
export interface BorgOpenCodeMessage {
  id: string;
  role: 'user' | 'assistant' | 'other';
  text: string;
  metadata: Record<string, unknown>;
  tools: { id: string; name: string; status: string }[];
}

export function decodeOpenCodeV2Message(value: unknown): BorgOpenCodeMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (typeof message.id !== 'string' || typeof message.type !== 'string') return null;
  const content = Array.isArray(message.content) ? message.content : [];
  return {
    id: message.id,
    role: message.type === 'user' || message.type === 'assistant' ? message.type : 'other',
    text: typeof message.text === 'string' ? message.text : '',
    metadata: message.metadata && typeof message.metadata === 'object' ? message.metadata as Record<string, unknown> : {},
    tools: content.flatMap((part) => part?.type === 'tool' && typeof part.id === 'string' && typeof part.name === 'string'
      ? [{ id: part.id, name: part.name, status: part.state?.status ?? '' }] : []),
  };
}

export interface OpenCodeV2Transport {
  client: OpenCodeClient;
  nextMessageID(): string;
  message(sessionID: string, messageID: string): Promise<BorgOpenCodeMessage | null>;
}
export async function createOpenCodeV2Transport(server: OpenCodeV2Server): Promise<OpenCodeV2Transport> {
  // Neither SDK nor schema is loaded on a V1 launch. Never import Service:
  // its ensure/restart lifecycle owns a different, shared OpenCode server.
  const [{ OpenCode }, { SessionMessage }] = await Promise.all([
    import('@opencode/client'), import('@opencode/schema/session-message'),
  ]);
  const client: OpenCodeClient = OpenCode.make({ baseUrl: server.url, headers: server.headers(),
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(10_000) }),
  });
  return {
    client,
    nextMessageID: () => SessionMessage.ID.create() as string,
    async message(sessionID: string, messageID: string): Promise<BorgOpenCodeMessage | null> {
      try { return decodeOpenCodeV2Message(await client.session.message.get({ sessionID, messageID })); }
      catch { return null; }
    },
  };
}
