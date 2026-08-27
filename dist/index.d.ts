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
import { connectOpenCodeDrone } from './opencode-drone.js';
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
export declare function appendServerAdvisory(text: string, advisory: unknown): string;
export declare function formatUpdatedCubeResult(cube: {
    name: string;
    id: string;
}, advisory?: unknown): string;
export declare function formatUpdatedRoleResult(role: {
    name: string;
    id: string;
    role_class?: string;
    is_human_seat?: boolean;
    is_default?: boolean;
    is_mandatory?: boolean;
}, advisory?: unknown): string;
export declare function resolveAckKind(raw: unknown): 'ack' | 'claim';
export declare function buildReadLogStructuredContent(input: {
    entries: unknown[];
    behind_by: unknown;
    has_more: unknown;
    omitted?: unknown;
}): {
    entries: unknown[];
    behind_by: number | null;
    has_more: boolean;
    omitted?: number;
};
export declare function formatPatchedRoleSectionResult(action: 'replace' | 'insert' | 'delete', heading: string, role: {
    name: string;
    id: string;
}, advisory?: unknown): string;
export declare function connectOpenCodeRuntime(active: {
    worktree?: string;
    droneLabel: string;
    name: string;
}, env?: NodeJS.ProcessEnv, deps?: {
    connect?: typeof connectOpenCodeDrone;
}): Promise<boolean>;
/**
 * Main entry point - MCP stdio server
 */
export declare function main(): Promise<void>;
//# sourceMappingURL=index.d.ts.map