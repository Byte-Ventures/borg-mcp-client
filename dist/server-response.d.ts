/** Read one server response without trusting Content-Length or stream EOF. */
export declare function readBoundedResponseBody(response: Response, maxBytes: number, limitMessage: string, signal?: AbortSignal): Promise<string>;
//# sourceMappingURL=server-response.d.ts.map