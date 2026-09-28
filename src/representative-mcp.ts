/**
 * Restricted stdio MCP facade for the human representative.
 *
 * A Borg server speaks pinned-TLS HTTPS, not MCP, so a generic MCP host reaches
 * it through this local stdio process. The surface is five tools: status, send
 * (to the ONE bound Coordinator), read (that Coordinator's replies), deliver
 * (the host's durable delivery checkpoint) and ack.
 * There is deliberately no log/broadcast/dispatch, roster-management, grant,
 * evict, release, regen or server-lifecycle tool, and no dispatcher escape hatch.
 *
 * The connection context is resolved per call and injected, so the same facade
 * runs over the real seat-scoped backend or a controlled test backend.
 */

import { ErrorCode } from 'borgmcp-shared/protocol';
import type { Readable, Writable } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  REPRESENTATIVE_DELIVERY_NOTE,
  REPRESENTATIVE_MESSAGE_LIMIT_BYTES,
  RepresentativeError,
  ackRepresentativeReply,
  deliverRepresentativeReplies,
  readRepresentativeReplies,
  serializeRepresentativeResult,
  representativeStatus,
  sendRepresentativeMessage,
  type RepresentativeContext,
} from './representative-core.js';
import { RepresentativeStoreError, bindingFingerprint } from './representative-store.js';
import { RepresentativeStateError } from './representative-db.js';

export const REPRESENTATIVE_TOOL_NAMES = [
  'borg_representative-status',
  'borg_representative-send',
  'borg_representative-read',
  'borg_representative-deliver',
  'borg_representative-ack',
] as const;

export const REPRESENTATIVE_INSTRUCTIONS =
  'You are connected as the human representative of one Borg cube: an automated delegate that relays the ' +
  'human\'s requests, questions and decisions to ONE bound Coordinator drone and reads its replies. You are not the ' +
  'Coordinator and not the human: never plan or dispatch work for other drones — the Coordinator does that. ' +
  'Mark content user_authorized ONLY when the human explicitly said it; everything you originate is model_advice. ' +
  'A relayed decision authorizes only its own text, never broader approval. ' +
  REPRESENTATIVE_DELIVERY_NOTE;

const TOOLS = [
  {
    name: 'borg_representative-status',
    description:
      'Show which cube, representative drone and Coordinator this connection is bound to, whether the live cube still matches, ' +
      'any unresolved (ambiguous) sends and the delivery limits. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'borg_representative-send',
    description:
      'Relay ONE human request, question or decision to the bound Coordinator. The recipient is fixed; workers and broadcast ' +
      'are not addressable. Returns a request_id. If the outcome is "ambiguous" (the result names the cause), retry only ' +
      'with the SAME request_id and identical content (server-deduplicated); never re-send under a new id. A ' +
      'SEND_REJECTED error names the refusal and its recovery. Do not issue overlapping sends of the same content.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['request', 'question', 'decision'] },
        authorization: {
          type: 'string',
          enum: ['user_authorized', 'model_advice'],
          description:
            'user_authorized: the human explicitly said/approved this exact content. model_advice: your own suggestion. ' +
            'A decision must be user_authorized.',
        },
        message: { type: 'string', description: `Plain text, at most ${REPRESENTATIVE_MESSAGE_LIMIT_BYTES} bytes.` },
        request_id: {
          type: 'string',
          description: 'Omit for a new request. To retry, pass the request_id returned earlier with identical content.',
        },
      },
      required: ['kind', 'authorization', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'borg_representative-read',
    description:
      'Read the bound Coordinator\'s replies addressed to this representative that come after your delivered checkpoint, ' +
      'oldest first. Reading changes nothing: the same replies return on every call until you call ' +
      'borg_representative-deliver. Persist each reply durably, route it by in_reply_to or hold it for the human, then ' +
      'deliver through the last one you persisted. At most `limit` replies and `max_bytes` of serialized result; a reply ' +
      'larger than max_bytes is returned whole and alone with oversize:true, and the result never exceeds ' +
      'max(max_bytes, 16384) bytes (oversize citations reduced to ids, documents_reduced:true). has_more means more ' +
      'replies follow the window; an empty page never has has_more. ' +
      'Stop routing if binding_fingerprint differs from the value you persisted at binding time.',
    inputSchema: {
      type: 'object',
      properties: {
        include_broadcast: { type: 'boolean', description: 'Also return the Coordinator\'s cube-wide broadcasts (marked as such).' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Hard cap on returned replies. Default 10.' },
        max_bytes: {
          type: 'integer', minimum: 4096, maximum: 60000,
          description: 'Hard cap on the serialized result size in bytes. Default 32768.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'borg_representative-deliver',
    description:
      'Record that every reply up to and including `through` is durably persisted by the host. Only this call moves the ' +
      'read window. `through` must be a reply borg_representative-read returned; the same or an older id is a no-op ' +
      '(advanced:false). Call it only after durable persistence: a delivered reply is not returned again. It does not ' +
      'notify the Coordinator; that is borg_representative-ack.',
    inputSchema: {
      type: 'object',
      properties: { through: { type: 'string', description: 'entry_id of the last reply you persisted.' } },
      required: ['through'],
      additionalProperties: false,
    },
  },
  {
    name: 'borg_representative-ack',
    description:
      'Signal to the Coordinator that one of its direct replies (entry_id from borg_representative-read) was received. ' +
      'It is only that signal: it is not delivery, does not move the read window (that is borg_representative-deliver), ' +
      'and is not needed for reading.',
    inputSchema: {
      type: 'object',
      properties: { entry_id: { type: 'string' } },
      required: ['entry_id'],
      additionalProperties: false,
    },
  },
] as const;

function errorBody(error: unknown): { error: { code: string; message: string; details?: unknown } } {
  if (error instanceof RepresentativeError || error instanceof RepresentativeStoreError || error instanceof RepresentativeStateError) {
    const details = error instanceof RepresentativeError || error instanceof RepresentativeStateError ? error.details : undefined;
    return { error: { code: error.code, message: error.message, ...(details ? { details } : {}) } };
  }
  const code = (error as { code?: unknown } | null)?.code;
  return {
    error: {
      code: typeof code === 'string' ? code : 'BACKEND_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    },
  };
}

const toolResult = (body: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: serializeRepresentativeResult(body) }],
  ...(isError ? { isError: true } : {}),
});

export interface ServeRepresentativeOptions {
  /** Resolved on every call; a throw fails that call closed. */
  context: () => Promise<RepresentativeContext>;
  /**
   * The binding generation this process started with. Every call except status
   * refuses with BINDING_MISMATCH, before any ledger, delivery or network
   * activity, once the saved binding's fingerprint differs.
   */
  pinnedFingerprint?: string;
  version: string;
  stdin?: Readable;
  stdout?: Writable;
  /** Called once on shutdown (closes the state database handle). */
  onClose?: () => void;
  /** Status body when the context cannot be resolved because the state database is unusable. */
  stateProblemStatus?: (error: RepresentativeStateError) => unknown;
}

export async function serveRepresentativeMcp(
  options: ServeRepresentativeOptions,
): Promise<{ close: () => Promise<void>; closed: Promise<void> }> {
  const server = new Server(
    { name: 'borg-human-representative', version: options.version },
    { capabilities: { tools: {} }, instructions: REPRESENTATIVE_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((tool) => ({ ...tool })) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      if (!(REPRESENTATIVE_TOOL_NAMES as readonly string[]).includes(name)) {
        throw new RepresentativeError(ErrorCode.INVALID_INPUT, `Unknown tool ${JSON.stringify(name)}; this connection exposes only the representative tools.`);
      }
      if (name === 'borg_representative-status' && options.stateProblemStatus) {
        // Status needs no binding to report an unusable state database.
        const resolved = await options.context().then((ctx) => ({ ctx }), (error: unknown) => {
          if (error instanceof RepresentativeStateError) return { problem: error };
          throw error;
        });
        if ('problem' in resolved) return toolResult(options.stateProblemStatus(resolved.problem));
      }
      const ctx = await options.context();
      const pinned = options.pinnedFingerprint ? { pinned_binding_fingerprint: options.pinnedFingerprint } : {};
      if (name === 'borg_representative-status') {
        return toolResult({ ...await representativeStatus(ctx), ...pinned });
      }
      if (options.pinnedFingerprint && bindingFingerprint(ctx.binding) !== options.pinnedFingerprint) {
        throw new RepresentativeError(
          'BINDING_MISMATCH',
          'The operator rebound this connection (a new binding generation) while it was running. Restart the MCP server to use the new binding.',
        );
      }
      // Every effect runs as per-operation state transactions, so any number of
      // host processes may use these tools at once. A damaged or unsafe state
      // database refuses every effect; status stays available.
      switch (name) {
        case 'borg_representative-send': {
          const sent = await sendRepresentativeMessage(ctx, args);
          return toolResult(sent, sent.outcome === 'ambiguous');
        }
        case 'borg_representative-read':
          return toolResult(await readRepresentativeReplies(ctx, args));
        case 'borg_representative-deliver':
          return toolResult(await deliverRepresentativeReplies(ctx, args));
        default:
          return toolResult(await ackRepresentativeReply(ctx, args));
      }
    } catch (error) {
      return toolResult(errorBody(error), true);
    }
  });

  const transport = new StdioServerTransport(options.stdin, options.stdout);
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  const shutdown = async () => {
    process.removeListener('SIGTERM', signalClose);
    process.removeListener('SIGINT', signalClose);
    try { options.onClose?.(); } finally { finish(); }
  };
  const signalClose = () => { void server.close(); };
  server.onclose = () => { void shutdown().catch(() => {}); };
  process.once('SIGTERM', signalClose);
  process.once('SIGINT', signalClose);
  try { await server.connect(transport); } catch (error) { await shutdown(); throw error; }
  return { close: async () => { await server.close(); await closed; }, closed };
}
