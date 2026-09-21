/**
 * Restricted stdio MCP facade for the human representative ("Hermes").
 *
 * A Borg server speaks pinned-TLS HTTPS, not MCP, so a generic MCP host reaches
 * it through this local stdio process. The surface is four tools: status, send
 * (to the ONE bound Coordinator), read (that Coordinator's replies) and ack.
 * There is deliberately no log/broadcast/dispatch, roster-management, grant,
 * evict, release, regen or server-lifecycle tool, and no dispatcher escape hatch.
 *
 * The connection context is resolved per call and injected, so the same facade
 * runs over the real seat-scoped backend or a controlled test backend.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { REPRESENTATIVE_DELIVERY_NOTE, REPRESENTATIVE_MESSAGE_LIMIT_BYTES, RepresentativeError, ackRepresentativeReply, readRepresentativeReplies, representativeStatus, sendRepresentativeMessage, } from './representative-core.js';
import { RepresentativeStoreError } from './representative-store.js';
export const REPRESENTATIVE_TOOL_NAMES = [
    'borg_representative-status',
    'borg_representative-send',
    'borg_representative-read',
    'borg_representative-ack',
];
export const REPRESENTATIVE_INSTRUCTIONS = 'You are connected as the human representative ("Hermes") of one Borg cube: an automated delegate that relays the ' +
    'human\'s requests, questions and decisions to ONE bound Coordinator drone and reads its replies. You are not the ' +
    'Coordinator and not the human: never plan or dispatch work for other drones — the Coordinator does that. ' +
    'Mark content user_authorized ONLY when the human explicitly said it; everything you originate is model_advice. ' +
    'A relayed decision authorizes only its own text, never broader approval. ' +
    REPRESENTATIVE_DELIVERY_NOTE;
const TOOLS = [
    {
        name: 'borg_representative-status',
        description: 'Show which cube, representative drone and Coordinator this connection is bound to, whether the live cube still matches, ' +
            'any unresolved (ambiguous) sends, and the delivery limits.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'borg_representative-send',
        description: 'Relay ONE human request, question or decision to the bound Coordinator. The recipient is fixed; workers and broadcast ' +
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
                    description: 'user_authorized: the human explicitly said/approved this exact content. model_advice: your own suggestion. ' +
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
        description: 'Read unread replies from the bound Coordinator addressed to this representative. Replies arrive only when this tool ' +
            'is called; there is no background wake. Each call DRAINS the whole fetched unread page for this drone — returned ' +
            'replies and ignored entries alike (other drones\' entries are counted, never returned) — so they will not appear ' +
            'unread again: relay every returned reply to the human immediately. If the host stops before relaying, the reply ' +
            'is no longer in the unread view.',
        inputSchema: {
            type: 'object',
            properties: {
                include_broadcast: { type: 'boolean', description: 'Also return the Coordinator\'s cube-wide broadcasts (marked as such).' },
                limit: {
                    type: 'integer', minimum: 1, maximum: 200,
                    description: 'Page-size hint, not a hard cap: a large unread backlog may return (and drain) more entries.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'borg_representative-ack',
        description: 'Signal to the Coordinator that one of its direct replies (entry_id from borg_representative-read) was received. ' +
            'It is only that signal: it does not make delivery reliable, does not move or restore the unread cursor, and is ' +
            'not needed for reading.',
        inputSchema: {
            type: 'object',
            properties: { entry_id: { type: 'string' } },
            required: ['entry_id'],
            additionalProperties: false,
        },
    },
];
function errorBody(error) {
    if (error instanceof RepresentativeError || error instanceof RepresentativeStoreError) {
        const details = error instanceof RepresentativeError ? error.details : undefined;
        return { error: { code: error.code, message: error.message, ...(details ? { details } : {}) } };
    }
    const code = error?.code;
    return {
        error: {
            code: typeof code === 'string' ? code : 'BACKEND_ERROR',
            message: error instanceof Error ? error.message : 'Unknown error',
        },
    };
}
const toolResult = (body, isError = false) => ({
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    ...(isError ? { isError: true } : {}),
});
export async function serveRepresentativeMcp(options) {
    const server = new Server({ name: 'borg-human-representative', version: options.version }, { capabilities: { tools: {} }, instructions: REPRESENTATIVE_INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((tool) => ({ ...tool })) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = request.params.arguments ?? {};
        try {
            if (!REPRESENTATIVE_TOOL_NAMES.includes(name)) {
                throw new RepresentativeError('INVALID_INPUT', `Unknown tool ${JSON.stringify(name)}; this connection exposes only the representative tools.`);
            }
            const ctx = await options.context();
            switch (name) {
                case 'borg_representative-status':
                    return toolResult(await representativeStatus(ctx));
                case 'borg_representative-send': {
                    const sent = await sendRepresentativeMessage(ctx, args);
                    return toolResult(sent, sent.outcome === 'ambiguous');
                }
                case 'borg_representative-read':
                    return toolResult(await readRepresentativeReplies(ctx, args));
                default:
                    return toolResult(await ackRepresentativeReply(ctx, args));
            }
        }
        catch (error) {
            return toolResult(errorBody(error), true);
        }
    });
    const transport = new StdioServerTransport(options.stdin, options.stdout);
    const closed = new Promise((resolve) => { server.onclose = () => resolve(); });
    await server.connect(transport);
    return { close: () => server.close(), closed };
}
//# sourceMappingURL=representative-mcp.js.map