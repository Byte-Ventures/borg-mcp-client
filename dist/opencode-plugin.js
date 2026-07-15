import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/**
 * Plugin source that preserves borg cube context across session compaction.
 * The initial kickoff and ongoing entry injection are handled by the launcher
 * and MCP client via the SDK, not by the plugin.
 */
export const BORG_PLUGIN_SOURCE = `
// Borg MCP context-preservation plugin — installed by borg assimilate
export default function () {
  return {
    'experimental.session.compacting': async (_input, output) => {
      output.context.push(
        '## Borg Cube\\nYou are in a borgmcp.ai multi-agent coordination cube. ' +
        'Use MCP tool borg_regen to get full context and recent activity.'
      );
    },
  };
}
`;
const PLUGIN_REL_PATH = path.join('.config', 'opencode', 'plugins', 'borg-orient.js');
export function installBorgPlugin() {
    const pluginPath = path.join(os.homedir(), PLUGIN_REL_PATH);
    try {
        if (fs.existsSync(pluginPath)) {
            const existing = fs.readFileSync(pluginPath, 'utf-8');
            if (existing === BORG_PLUGIN_SOURCE)
                return;
        }
        fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
        fs.writeFileSync(pluginPath, BORG_PLUGIN_SOURCE, 'utf-8');
    }
    catch {
        // Best-effort — plugin is an optimization, not a requirement.
    }
}
//# sourceMappingURL=opencode-plugin.js.map