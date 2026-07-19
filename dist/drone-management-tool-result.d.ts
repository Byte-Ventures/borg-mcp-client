interface ReassignmentResult {
    drone: {
        id: string;
        label: string;
        role_id: string;
    };
    role?: {
        id: string;
        name: string;
    };
    cube?: {
        id: string;
        name: string;
    };
}
export declare function formatReassignmentSuccess({ drone, role, cube }: ReassignmentResult): string;
export declare function formatEvictionSuccess(targetLabel: string, targetId: string, targetCubeName?: string): string;
export {};
//# sourceMappingURL=drone-management-tool-result.d.ts.map