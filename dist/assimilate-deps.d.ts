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
 * Creates a prompt adapter that wraps the real readline interface but
 * exposes a controllable error-injection seam for integration tests.
 * When `onQuestion` is provided, it is called with the question message
 * before the readline interface is created. The test can then inject
 * an error by returning a non-null value or rejecting the returned
 * promise, which is thrown instead of reading from readline. This
 * proves the real adapter's error mapping (SIGINT → PromptInterruptedError)
 * without needing to send actual signals to the test process.
 */
export declare function createTestablePromptAdapter(onQuestion?: (message: string) => unknown | Promise<unknown>): (message: string) => Promise<string>;
export declare function buildDefaultAssimilateDeps(): AssimilateDeps;
//# sourceMappingURL=assimilate-deps.d.ts.map