export interface CodexThreadSummary {
    id: string;
    cwd: string;
    preview: string;
    status: {
        type: string;
    };
    updatedAt: number;
}
export declare class CodexAppServerClient {
    private readonly socketPath;
    private socket;
    private buffer;
    private handshaken;
    private nextId;
    private pending;
    constructor(socketPath: string);
    connect(): Promise<void>;
    close(): void;
    loadedThreadIds(): Promise<string[]>;
    readThread(threadId: string): Promise<CodexThreadSummary | null>;
    startTurn(threadId: string, text: string): Promise<void>;
    private waitForHandshake;
    private request;
    private notify;
    private writeJson;
    private parseIncoming;
}
export declare function findLoadedCodexThread(options: {
    socketPath: string;
    cwd: string;
    previewIncludes: string;
    updatedAfter: number;
}): Promise<string | null>;
//# sourceMappingURL=codex-app-server.d.ts.map