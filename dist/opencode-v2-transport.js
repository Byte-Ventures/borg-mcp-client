export function decodeOpenCodeV2Message(value) {
    if (!value || typeof value !== 'object')
        return null;
    const message = value;
    if (typeof message.id !== 'string' || typeof message.type !== 'string')
        return null;
    const content = Array.isArray(message.content) ? message.content : [];
    return {
        id: message.id,
        role: message.type === 'user' || message.type === 'assistant' ? message.type : 'other',
        text: typeof message.text === 'string' ? message.text : '',
        metadata: message.metadata && typeof message.metadata === 'object' ? message.metadata : {},
        tools: content.flatMap((part) => part?.type === 'tool' && typeof part.id === 'string' && typeof part.name === 'string'
            ? [{ id: part.id, name: part.name, status: part.state?.status ?? '' }] : []),
    };
}
export async function createOpenCodeV2Transport(server) {
    // Neither SDK nor schema is loaded on a V1 launch. Never import Service:
    // its ensure/restart lifecycle owns a different, shared OpenCode server.
    const [{ OpenCode }, { SessionMessage }] = await Promise.all([
        import('@opencode/client'), import('@opencode/schema/session-message'),
    ]);
    const client = OpenCode.make({ baseUrl: server.url, headers: server.headers(),
        fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(10_000) }),
    });
    return {
        client,
        nextMessageID: () => SessionMessage.ID.create(),
        async message(sessionID, messageID) {
            try {
                return decodeOpenCodeV2Message(await client.session.message.get({ sessionID, messageID }));
            }
            catch {
                return null;
            }
        },
    };
}
//# sourceMappingURL=opencode-v2-transport.js.map