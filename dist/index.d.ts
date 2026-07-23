#!/usr/bin/env node
/**
 * Borg MCP Client - Main Entry Point
 *
 * stdio MCP server that:
 * 1. Connects to Claude Code via stdio transport
 * 2. Proxies MCP tools to a verified local (self-hosted) Borg server
 * 3. Provides the borg: cube tool surface (assimilate / cube / role /
 *    roster / read-log) so Claude can act as a Drone in a hive of
 *    collaborating sessions.
 */
import { updateCube, getCubeForManagement, applyTemplate, type LocalManageAuthority } from './remote-client.js';
import { type Template } from 'borgmcp-shared/templates';
export declare function runApplyTemplateTool(cubeId: string, template: Template, authority: LocalManageAuthority, deps?: {
    applyTemplate?: typeof applyTemplate;
    getCubeForManagement?: typeof getCubeForManagement;
    updateCube?: typeof updateCube;
}): Promise<{
    summary: {
        created: number;
        updated: number;
    };
    cubeDirectiveNote: string;
}>;
/**
 * Main entry point - MCP stdio server
 */
export declare function main(): Promise<void>;
//# sourceMappingURL=index.d.ts.map