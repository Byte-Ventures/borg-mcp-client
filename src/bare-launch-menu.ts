/**
 * gh#853 — bare `borg` (no-args) interactive launch menu.
 *
 * When `borg` is run with NO arguments in a TTY, offer a small launch selector
 * instead of launching immediately:
 *   1. Launch (default)             — the configured agent (Enter selects).
 *   2. Launch with <other> instead  — the OTHER installed agent, ONE-SHOT
 *                                      (does NOT persist the preference).
 *   3. Launch all                   — runLaunchAll for the active cube.
 *
 * The option-set, the selection→action mapping, and the show/collapse decision
 * are pure functions so they're unit-testable without a real TTY. claude.ts
 * main() is thin glue: it computes the inputs (default cli, other-installed cli,
 * launch-all targets), gates on shouldShowLaunchMenu, runs the orchestrator with
 * the real readline prompt, then dispatches the returned action.
 *
 * Load-bearing safety: TTY-only + bare-args-only (shouldShowLaunchMenu) so every
 * scripted/programmatic `borg` and every explicit subcommand/flag is untouched.
 */
import type { BorgCli } from './cubes.js';

export type LaunchMenuAction =
  | { kind: 'launch'; cli: BorgCli }
  | { kind: 'launch-all' };

export interface LaunchMenuOption {
  /** The keystroke that selects this option (sequential: '1', '2', …). */
  key: string;
  label: string;
  action: LaunchMenuAction;
}

export interface LaunchMenuInputs {
  /** The configured/resolved current agent (option 1). */
  defaultCli: BorgCli;
  /** All installed agents that are NOT the default, in display order. */
  otherInstalledClis: BorgCli[];
  /** True iff there's an active cube with >=1 discoverable drone (option 3). */
  hasLaunchAllTargets: boolean;
}

const PRETTY: Record<BorgCli, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

/**
 * Gate: the menu fires ONLY for bare `borg` (no args) in a TTY. Any explicit
 * subcommand/flag, or a non-TTY (piped/scripted/CI) invocation, falls straight
 * through to the existing default launch — no menu, no behavior change.
 */
export function shouldShowLaunchMenu(args: {
  extraArgs: string[];
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}): boolean {
  return args.extraArgs.length === 0 && args.stdinIsTTY && args.stdoutIsTTY;
}

export function explicitCliLaunchHint(args: {
  explicitCli: BorgCli | undefined;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  hasActiveCube: boolean;
  hasLaunchAllTargets: boolean;
}): string | null {
  if (!args.explicitCli || !args.stdinIsTTY || !args.stdoutIsTTY) return null;
  if (!args.hasActiveCube || !args.hasLaunchAllTargets) return null;
  return `borg --cli ${args.explicitCli} launches ${PRETTY[args.explicitCli]} directly; use bare borg for the launch menu or borg launch-all --cli ${args.explicitCli} for all drone worktrees.\n`;
}

export function shouldResolveExplicitCliLaunchHintTargets(args: {
  explicitCli: BorgCli | undefined;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  hasActiveCube: boolean;
}): boolean {
  return Boolean(args.explicitCli && args.stdinIsTTY && args.stdoutIsTTY && args.hasActiveCube);
}

/**
 * The context-filtered option set. Option 1 is always present; options 2/3 are
 * included only when applicable. Keys are sequential with no gaps, so a hidden
 * middle option never produces a "1) … 3) …" gap menu.
 */
export function buildLaunchMenuOptions(inputs: LaunchMenuInputs): LaunchMenuOption[] {
  const options: LaunchMenuOption[] = [
    {
      key: '1',
      label: `Launch (default · ${PRETTY[inputs.defaultCli]})`,
      action: { kind: 'launch', cli: inputs.defaultCli },
    },
  ];
  for (const cli of inputs.otherInstalledClis) {
    options.push({
      key: String(options.length + 1),
      label: `Launch with ${PRETTY[cli]} (one-shot)`,
      action: { kind: 'launch', cli },
    });
  }
  if (inputs.hasLaunchAllTargets) {
    options.push({
      key: String(options.length + 1),
      label: "Launch all (this cube's drone worktrees)",
      action: { kind: 'launch-all' },
    });
  }
  return options;
}

/** Map a raw prompt answer to an action. Empty/Enter → option 1 (default). */
export function resolveLaunchMenuChoice(
  options: LaunchMenuOption[],
  rawInput: string
): { ok: true; action: LaunchMenuAction } | { ok: false } {
  const trimmed = rawInput.trim();
  if (trimmed === '') return { ok: true, action: options[0].action };
  const match = options.find((o) => o.key === trimmed);
  return match ? { ok: true, action: match.action } : { ok: false };
}

/** The rendered menu text (prompt suffix `[1]:` defaults to option 1 on Enter). */
export function renderLaunchMenu(options: LaunchMenuOption[]): string {
  const lines = options.map((o) => `  ${o.key}) ${o.label}`);
  return `borg — how do you want to launch?\n${lines.join('\n')}\n[1]: `;
}

/**
 * Orchestrate the menu with an injected readline-style prompt. Collapses to a
 * direct default launch (no render, no prompt) when only option 1 applies.
 * Re-prompts on invalid input up to `maxAttempts`, then falls back to the safe
 * default (option 1) so a fat-fingered session still launches.
 */
export async function runBareLaunchMenu(
  inputs: LaunchMenuInputs,
  prompt: (message: string) => Promise<string>,
  opts: { maxAttempts?: number; warn?: (message: string) => void } = {}
): Promise<LaunchMenuAction> {
  const options = buildLaunchMenuOptions(inputs);
  if (options.length === 1) return options[0].action; // collapse — never a 1-item menu

  const maxAttempts = opts.maxAttempts ?? 3;
  const menu = renderLaunchMenu(options);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const raw = await prompt(attempt === 0 ? menu : `Invalid choice.\n${menu}`);
    const res = resolveLaunchMenuChoice(options, raw);
    if (res.ok) return res.action;
    opts.warn?.(`invalid launch-menu selection: ${JSON.stringify(raw.trim())}`);
  }
  return options[0].action; // exhausted → safe default
}
