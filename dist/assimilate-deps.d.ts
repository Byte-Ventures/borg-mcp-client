/**
 * Real-IO factory for the `borg assimilate` orchestrator. Produces a
 * fully-wired `AssimilateDeps` whose seams call into the existing
 * client modules (remote-client HTTP, cubes.ts persistence, auth.ts
 * setup wizard, terminal-title helper).
 *
 * Test code never calls this — tests construct stub deps directly
 * (see `client/__tests__/assimilate-cmd.test.ts:makeStubDeps`).
 */
import type { AssimilateDeps } from './assimilate-cmd.js';
/**
 * Wraps the readline question operation with the production interruption
 * mapping. Tests inject the question operation; production uses readline.
 */
export type PromptQuestion = (message: string) => Promise<string>;
export declare function createPromptAdapter(question?: PromptQuestion): (message: string) => Promise<string>;
export declare function buildDefaultAssimilateDeps(question?: PromptQuestion): AssimilateDeps;
//# sourceMappingURL=assimilate-deps.d.ts.map