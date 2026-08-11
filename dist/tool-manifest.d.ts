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