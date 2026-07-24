export interface RoleSectionConflictOperation {
    roleId: string;
    action: 'replace' | 'insert' | 'delete';
    heading: string;
    after?: string | null;
}
export declare class RoleSectionConflictError extends Error {
    readonly operation: RoleSectionConflictOperation;
    constructor(operation: RoleSectionConflictOperation);
}
export declare function formatLocalManageToolResult(error: unknown): {
    content: {
        type: "text";
        text: string;
    }[];
    isError: true;
} | null;
//# sourceMappingURL=local-manage-tool-result.d.ts.map