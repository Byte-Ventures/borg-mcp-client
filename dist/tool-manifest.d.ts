/**
 * gh#docs-site — SOURCE-OF-TRUTH tool manifest.
 *
 * The single canonical list of borg_* MCP tool definitions. The runtime and
 * documentation consumers use the same pure-data list.
 *
 * PURE DATA — no imports, no side effects — so documentation builds do not pull
 * in the client's MCP/keyring runtime dependencies.
 */
export interface ToolManifestEntry {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: Record<string, any>;
        required?: string[];
        oneOf?: Array<{
            required: string[];
        }>;
    };
}
export declare const TOOL_MANIFEST: ToolManifestEntry[];
//# sourceMappingURL=tool-manifest.d.ts.map