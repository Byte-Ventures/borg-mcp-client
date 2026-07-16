// Pedagogical hint rendered to stdout immediately after assimilation
// completes, before Claude Code launches. The cube-agnostic shape points
// the user at borg_whoami / borg_roster rather than embedding role-specific
// text — so
// cubes using non-default templates (writers-room, ops, etc.) render identically
// to software-dev cubes. The concrete drone, role seat, and cube names come from
// the completed server attach response.
//
// Color: ANSI green on the ✓ glyph only; gated on the caller's useColor
// boolean (computed from process.stdout.isTTY && !NO_COLOR && !CI in the
// assimilate-cmd call site). Body text carries no ANSI by design — color
// is hierarchy-cueing, not decoration.

const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

export function renderAssimilationWelcome(
  droneLabel: string,
  roleName: string,
  cubeName: string,
  useColor: boolean,
  localApiUrl?: string,
): string {
  const check = useColor ? `${GREEN}✓${RESET}` : '✓';
  const teammateLines = localApiUrl === undefined
    ? [`Add a teammate: run \`borg assimilate <role>\` in another terminal.`]
    : [
        `Add a teammate from the intended worktree:`,
        `run \`borg assimilate --host ${localApiUrl} <role>\` in another terminal.`,
      ];
  return [
    `${check} Attached \`${droneLabel}\` to \`${roleName}\` in cube \`${cubeName}\`.`,
    ``,
    `In the launched agent, run \`borg_whoami\` and \`borg_roster\` to verify the seat`,
    `and begin coordinating.`,
    ...teammateLines,
    ``,
  ].join('\n');
}
