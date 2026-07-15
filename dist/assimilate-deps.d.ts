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
export declare function buildDefaultAssimilateDeps(): AssimilateDeps;
//# sourceMappingURL=assimilate-deps.d.ts.map