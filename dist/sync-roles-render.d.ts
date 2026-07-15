/**
 * gh#473 PR2 — non-clobbering sync output rendering.
 *
 * The dry-run output is UX-LOAD-BEARING: it must CLEARLY communicate each
 * conflict (which role/section or taxonomy class, cube-current vs
 * template-new, and how to accept) so the operator SEES what would be
 * clobbered. Pure string logic (mirrors `roster-render.ts` /
 * `list-roles-render.ts`) so it is unit-testable without the MCP runtime.
 *
 * The shape mirrors the worker's `NonClobberSyncResult`.
 */
export type FragmentKind = 'add' | 'unchanged' | 'conflict';
export interface FragmentView {
    key: string;
    kind: FragmentKind;
    label: string;
    cubeValue: string | null;
    templateValue: string;
}
export interface NonClobberSyncResult {
    dryRun: boolean;
    roles: Array<{
        name: string;
        status: 'new' | 'existing' | 'custom-skipped';
        fragments: FragmentView[];
    }>;
    taxonomy: FragmentView[];
    applied: {
        added: string[];
        acceptedConflicts: string[];
    };
    rejectedConflicts: string[];
    unmatchedDecisions?: string[];
}
/**
 * Render a `NonClobberSyncResult` as an operator-facing markdown report.
 *
 * Conflicts are the headline: each is surfaced with both sides + its
 * stable accept key, and the report states explicitly that conflicts are
 * KEPT (the cube's version) unless accepted. ADDs are reported as safe
 * auto-applies. Custom roles are reported untouched.
 */
export declare function renderSyncRolesResult(result: NonClobberSyncResult, templateName: string): string;
//# sourceMappingURL=sync-roles-render.d.ts.map