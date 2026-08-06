import type { BorgCli } from './cubes.js';

export interface SetupAgentChoice {
  title: string;
  value: BorgCli;
  selected: boolean;
  disabled?: boolean;
}

export type SetupAgentSelection =
  | { kind: 'selected'; agents: BorgCli[] }
  | { kind: 'empty' }
  | { kind: 'cancelled' };

const CLI_TITLES: Record<BorgCli, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** Build the first-run choices from the CLIs that are actually installed. */
export function setupAgentChoices(
  detected: readonly BorgCli[],
  alreadyConfigured: ReadonlySet<BorgCli> = new Set(),
): SetupAgentChoice[] {
  return [...new Set(detected)].map((cli) => ({
    title: alreadyConfigured.has(cli)
      ? `${CLI_TITLES[cli]} (already configured)`
      : CLI_TITLES[cli],
    value: cli,
    selected: !alreadyConfigured.has(cli),
    ...(alreadyConfigured.has(cli) ? { disabled: true } : {}),
  }));
}

/**
 * Keep only detected agents and return them in detection order. The selected
 * set is invocation-local; it is deliberately never persisted.
 */
export function normalizeSetupAgentSelection(
  detected: readonly BorgCli[],
  selected: readonly unknown[] | undefined,
): BorgCli[] {
  if (!Array.isArray(selected)) return [];
  const selectedSet = new Set(selected);
  return [...new Set(detected)].filter((cli) => selectedSet.has(cli));
}

/** Turn the prompt result into the terminal outcome used by the wizard. */
export function resolveSetupAgentSelection(
  detected: readonly BorgCli[],
  selected: readonly unknown[] | undefined,
  cancelled = false,
): SetupAgentSelection {
  if (cancelled) return { kind: 'cancelled' };
  const agents = normalizeSetupAgentSelection(detected, selected);
  return agents.length === 0 ? { kind: 'empty' } : { kind: 'selected', agents };
}
