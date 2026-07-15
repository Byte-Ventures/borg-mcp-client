/**
 * gh#794 (CR 9f302b15): the `borg setup` auth-step decision, extracted as a
 * PURE, side-effect-free mapping so the SR#3 contract is unit-pinned WITHOUT
 * importing setup.ts (which runs `main()` at module load) or mocking the
 * monolithic runSetup. `tsc` proves setup.ts's switch COMPILES; the unit test
 * over this helper proves it MAPS correctly — a future mis-edit (e.g. a
 * 'transient' wrongly skipping → an SR#3 break) fails the mapping test instead
 * of silently passing every probeSession test.
 *
 *   - 'valid'     → 'skip'   (short-circuit OAuth; session is usable)
 *   - 'dead'      → 'reauth' (full re-auth — NEVER short-circuit past a dead
 *                             token, the exact failure #794 fixes)
 *   - 'transient' → 'retry'  (network blip — don't re-auth, don't destroy)
 *
 * Type-only import of SessionState → zero runtime coupling to remote-client.
 */
import type { SessionState } from './remote-client.js';
export type SetupAuthAction = 'skip' | 'reauth' | 'retry';
export declare function setupActionForSession(state: SessionState): SetupAuthAction;
//# sourceMappingURL=setup-action.d.ts.map