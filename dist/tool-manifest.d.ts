/**
 * gh#492: JSON Schema contract for a tool's `structuredContent`. Success
 * results conform to it; errors stay text-first. `additionalProperties` is
 * left open everywhere so additive server fields never invalidate a
 * conforming result.
 */
export interface OutputSchema {
    type: 'object';
    description?: string;
    properties: Record<string, any>;
    required?: string[];
}
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
    outputSchema?: OutputSchema;
}
export declare const TOOL_OUTPUT_SCHEMAS: Record<string, OutputSchema>;
export declare const TOOL_MANIFEST: ToolManifestEntry[];
//# sourceMappingURL=tool-manifest.d.ts.map