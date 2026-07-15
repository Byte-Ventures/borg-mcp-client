/**
 * Plugin source that preserves borg cube context across session compaction.
 * The initial kickoff and ongoing entry injection are handled by the launcher
 * and MCP client via the SDK, not by the plugin.
 */
export declare const BORG_PLUGIN_SOURCE = "\n// Borg MCP context-preservation plugin \u2014 installed by borg assimilate\nexport default function () {\n  return {\n    'experimental.session.compacting': async (_input, output) => {\n      output.context.push(\n        '## Borg Cube\\nYou are in a borgmcp.ai multi-agent coordination cube. ' +\n        'Use MCP tool borg_regen to get full context and recent activity.'\n      );\n    },\n  };\n}\n";
export declare function installBorgPlugin(): void;
//# sourceMappingURL=opencode-plugin.d.ts.map