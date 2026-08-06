import type { BorgCli } from './cubes.js';
export interface SetupAgentChoice {
    title: string;
    value: BorgCli;
    selected: true;
}
export type SetupAgentSelection = {
    kind: 'selected';
    agents: BorgCli[];
} | {
    kind: 'empty';
} | {
    kind: 'cancelled';
};
/** Build the first-run choices from the CLIs that are actually installed. */
export declare function setupAgentChoices(detected: readonly BorgCli[]): SetupAgentChoice[];
/**
 * Keep only detected agents and return them in detection order. The selected
 * set is invocation-local; it is deliberately never persisted.
 */
export declare function normalizeSetupAgentSelection(detected: readonly BorgCli[], selected: readonly unknown[] | undefined): BorgCli[];
/** Turn the prompt result into the terminal outcome used by the wizard. */
export declare function resolveSetupAgentSelection(detected: readonly BorgCli[], selected: readonly unknown[] | undefined, cancelled?: boolean): SetupAgentSelection;
//# sourceMappingURL=setup-selection.d.ts.map