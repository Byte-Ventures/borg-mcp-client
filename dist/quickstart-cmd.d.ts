import type { AssimilateDeps } from './assimilate-cmd.js';
import { runAssimilate } from './assimilate-cmd.js';
import type { ActiveCube } from './cubes.js';
import { type LaunchAllDeps } from './launch-all-deps.js';
import { runLaunchAll } from './launch-all-cmd.js';
import type { QuickstartArgs } from './parse-quickstart-args.js';
export interface QuickstartDeps {
    buildAssimilateDeps: () => AssimilateDeps;
    buildLaunchAllDeps: () => LaunchAllDeps;
    readAllProjectIdentities: () => Promise<Array<{
        projectPath: string;
        cube: ActiveCube;
    }>>;
    isTTY: () => boolean;
    prompt: (message: string) => Promise<string>;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    runAssimilate?: typeof runAssimilate;
    runLaunchAll?: typeof runLaunchAll;
}
export type QuickstartCancellation = 'declined' | 'interrupted';
export interface QuickstartRunOptions {
    onCancelled?: (kind: QuickstartCancellation) => void;
}
export declare function buildDefaultQuickstartDeps(): QuickstartDeps;
export declare function runQuickstart(args: QuickstartArgs, deps: QuickstartDeps, options?: QuickstartRunOptions): Promise<number>;
//# sourceMappingURL=quickstart-cmd.d.ts.map