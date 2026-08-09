
// Borg MCP context-preservation plugin — installed by borg assimilate
export default function () {
  return {
    'experimental.session.compacting': async (_input, output) => {
      output.context.push(
        '## Borg Cube\nYou are in a Borg MCP multi-agent coordination cube. ' +
        'Use MCP tool borg_regen to get full context and recent activity.'
      );
    },
  };
}
