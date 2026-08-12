export interface QuickstartRoleRequest {
    slug: string;
    count: number;
}
export interface QuickstartArgs {
    template?: string;
    roles: QuickstartRoleRequest[];
    yes: boolean;
}
export type ParseQuickstartResult = {
    ok: true;
    args: QuickstartArgs;
} | {
    ok: false;
    error: string;
};
export declare function parseQuickstartArgs(rawArgs: readonly string[]): ParseQuickstartResult;
//# sourceMappingURL=parse-quickstart-args.d.ts.map