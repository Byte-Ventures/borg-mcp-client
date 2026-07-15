// Pedagogical hint rendered to stdout immediately after assimilation
// completes, before Claude Code launches. The cube-agnostic shape points
// the user at borg_role / borg_cube / borg_roster / borg_regen /
// borg_read-log rather than embedding role-specific text — so cubes
// using non-default templates (writers-room, ops, etc.) render
// identically to software-dev cubes.
//
// Color: ANSI green on the ✓ glyph only; gated on the caller's useColor
// boolean (computed from process.stdout.isTTY && !NO_COLOR && !CI in the
// assimilate-cmd call site). Body text carries no ANSI by design — color
// is hierarchy-cueing, not decoration.

const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

export function renderAssimilationWelcome(
  roleName: string,
  cubeName: string,
  useColor: boolean
): string {
  const check = useColor ? `${GREEN}✓${RESET}` : '✓';
  return [
    `${check} Joined as \`${roleName}\` in cube \`${cubeName}\`.`,
    ``,
    `Next: ask your agent to run the \`borg_regen\` tool to see your cube.`,
    `Add a teammate: run \`borg assimilate <role>\` in another terminal.`,
    `You're set up — your team can now see you in the cube.`,
    ``,
  ].join('\n');
}
